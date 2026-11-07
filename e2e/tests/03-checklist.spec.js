// Сценарий 3: редактор чек-листа. Меняем вес и шкалу, сохраняем, следующая оценка идёт по новой версии.
//
// Ожидаемые числа (mock, см. 02-evaluate.spec.js) после правки: вес «Завершение» 5 -> 25,
// шкала «Управление диалогом» 0, 4, 7, 10 -> 0, 5, 10 (mock берёт вторую сверху ступень: 5 из 10).
//   веса 10, 15, 20, 20, 15, 15, 25 (сумма 120), баллы 10 + 15 + 20 + 15 + 15 + 7,5 + 25 = 107,5
//   итог 100 * 107,5 / 120 = 89,58; секции: start 100, safety 87,5, flow (15 + 7,5 + 25) / 55 = 86,36.
import { CHAT_1 } from '../support/data.js';
import { getChecklist } from '../support/api.js';
import { expect, test } from '../support/fixtures.js';
import { evaluateButton, evaluateOpenDialog, nav, openApp, selectDialog, shot } from '../support/ui.js';

test.describe.configure({ mode: 'serial' });

test('UI: изменить вес и шкалу критериев и сохранить новую версию', async ({ page, request }, testInfo) => {
  await openApp(page);
  await nav(page, 'Чек-лист').click();

  const editor = page.locator('#view-checklist .ce');
  await expect(editor.locator('.ce__title')).toHaveText('Версия чек-листа: 1');
  await expect(editor.locator('.cc')).toHaveCount(8);
  await expect(editor.locator('.ce__hint')).toContainText('(без flag): 100.');
  await expect(editor.getByText('Есть несохранённые изменения')).toBeHidden();

  const closing = editor.locator('.cc[data-cid="closing"]');
  const dialog = editor.locator('.cc[data-cid="dialog"]');
  await closing.locator('input[aria-label="Вес"]').fill('25');
  await dialog.locator('input[aria-label="Шкала"]').fill('0, 5, 10');
  await expect(editor.getByText('Есть несохранённые изменения')).toBeVisible();
  await expect(editor.locator('.ce__hint')).toContainText('(без flag): 120.');
  await shot(page, testInfo, 'editor-before-save');

  const [put] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/checklist') && r.request().method() === 'PUT'),
    editor.getByRole('button', { name: 'Сохранить', exact: true }).click(),
  ]);

  // Что ушло на сервер: у бинарных критериев шкала пустая (не null), правки на месте.
  const sent = put.request().postDataJSON();
  expect(sent.criteria.find((c) => c.id === 'closing').weight).toBe(25);
  expect(sent.criteria.find((c) => c.id === 'dialog').scale).toEqual([0, 5, 10]);
  for (const c of sent.criteria.filter((c) => c.type !== 'scale')) expect(c.scale, `scale у ${c.id}`).toEqual([]);

  expect(put.status(), 'PUT /api/checklist из интерфейса').toBe(200);
  const saved = await put.json();
  expect(saved.version).toBe(2);
  await expect(editor.locator('.ce__msg')).toHaveText('Сохранено, версия 2');
  await expect(editor.locator('.ce__title')).toHaveText('Версия чек-листа: 2');
  await expect(editor.getByText('Есть несохранённые изменения')).toBeHidden();

  // Версии хранятся отдельно: первая не изменилась, вторая с правками.
  const v1 = await (await request.get('/api/checklists/1')).json();
  const v2 = await (await request.get('/api/checklists/2')).json();
  expect(v1.criteria.find((c) => c.id === 'closing').weight).toBe(5);
  expect(v1.criteria.find((c) => c.id === 'dialog').scale).toEqual([0, 4, 7, 10]);
  expect(v2.criteria.find((c) => c.id === 'closing').weight).toBe(25);
  expect(v2.criteria.find((c) => c.id === 'dialog').scale).toEqual([0, 5, 10]);
  expect((await getChecklist(request)).version).toBe(2);
});

test('следующая оценка идёт по новой версии чек-листа', async ({ page, request }) => {
  const current = (await getChecklist(request)).version;
  expect(current).toBe(2);

  await openApp(page);
  await selectDialog(page, CHAT_1.conversation_id);

  // Старый результат (версия 1) помечен как устаревший.
  await expect(page.locator('#result-pane .total__value')).toContainText('90,5');
  await expect(page.locator('#result-pane .stale')).toHaveText(
    `Результат получен по чек-листу версии 1, текущая версия ${current}, оцените заново`,
  );

  const response = await evaluateOpenDialog(page);
  expect(response.status()).toBe(200);
  expect((await response.json()).checklist_version).toBe(current);

  const card = page.locator('#result-pane .rc');
  await expect(card.locator('.rc__top .tag').nth(1)).toHaveText(`чек-лист v${current}`);
  await expect(card.locator('.stale')).toHaveCount(0);
  await expect(card.locator('.total__value')).toContainText('89,58');
  await expect(card.locator('.sec__row b')).toHaveText(['100', '87,5', '86,36', '—']);
  const closing = card.locator('.crit', { has: page.locator('.crit__name', { hasText: 'Завершение' }) });
  await expect(closing.locator('.crit__points')).toHaveText('25 / 25');
  const dialog = card.locator('.crit', { has: page.locator('.crit__name', { hasText: 'Управление диалогом' }) });
  await expect(dialog.locator('.pill')).toHaveText('5');
  await expect(dialog.locator('.crit__points')).toHaveText('7,5 / 15');
  await expect(evaluateButton(page)).toHaveText('Оценить заново');
});

test('API: PUT /api/checklist принимает scale: null и отклоняет шкальный критерий без шкалы', async ({ request }) => {
  // Редактор шлёт scale: [], но прежние версии интерфейса слали null (комментарий в backend/src/model.rs).
  const before = await getChecklist(request);
  const payload = structuredClone(before);
  const nonScale = payload.criteria.filter((c) => c.type !== 'scale');
  expect(nonScale.length).toBeGreaterThan(0);
  for (const c of nonScale) c.scale = null;

  const ok = await request.put('/api/checklist', { data: payload });
  expect(ok.status(), 'PUT со scale: null').toBe(200);
  const saved = await ok.json();
  expect(saved.version).toBe(before.version + 1);
  for (const c of saved.criteria.filter((c) => c.type !== 'scale')) expect(c.scale, `scale у ${c.id}`).toEqual([]);

  // null у шкального критерия это настоящая ошибка пользователя: 400 с телом ошибки, а не падение.
  const bad = structuredClone(saved);
  bad.criteria.find((c) => c.id === 'dialog').scale = null;
  const rejected = await request.put('/api/checklist', { data: bad });
  expect(rejected.status()).toBe(400);
  expect((await rejected.json()).error.code).toBe('invalid_checklist');
  expect((await getChecklist(request)).version, 'отказ не создаёт версию').toBe(saved.version);
});
