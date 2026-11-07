// Сценарий 1: список диалогов виден, диалог открывается, показывается транскрипт.
import { CALL_3, CHAT_1, CHAT_2 } from '../support/data.js';
import { expect, test } from '../support/fixtures.js';
import { nav, openApp, selectDialog } from '../support/ui.js';

const ROLE = { client: 'Клиент', operator: 'Оператор' };

test('API: сервер жив, список диалогов берётся из кэша хранилища', async ({ request }) => {
  const health = await request.get('/api/health');
  expect(await health.json()).toEqual({ ok: true });

  const res = await request.get('/api/conversations?group=dev');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.group).toBe('dev');
  expect(body.count).toBe(3);
  expect(body.items.map((i) => i.conversation_id).sort()).toEqual(
    [CHAT_1, CHAT_2, CALL_3].map((c) => c.conversation_id).sort(),
  );
  expect(body.items.find((i) => i.conversation_id === CHAT_1.conversation_id)).toMatchObject({
    channel: 'agent chat',
    language: 'RU',
    turns: 7,
    turns_count: 7,
    evaluated: false,
    has_evaluation: false,
  });
});

test('список диалогов виден, фильтры и поиск работают', async ({ page }) => {
  await openApp(page);
  const items = page.locator('#list-pane .cl__item');
  await expect(items).toHaveCount(3);
  await expect(page.locator('#list-pane .cl__count')).toHaveText('Показано 3 из 3');
  await expect(items.locator('.cl__id')).toHaveText([CHAT_1, CHAT_2, CALL_3].map((c) => c.conversation_id));
  await expect(items.first().locator('.cl__meta')).toContainText('7 реплик');

  await page.getByLabel('Канал').selectOption('voice call');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toHaveAttribute('data-id', CALL_3.conversation_id);
  await expect(page.locator('#list-pane .cl__count')).toHaveText('Показано 1 из 3');

  await page.getByLabel('Канал').selectOption('');
  await page.getByLabel('Язык').selectOption('KZ');
  await expect(page.locator('#list-pane .state--empty')).toHaveText('Ничего не найдено. Измените фильтры.');

  await page.getByLabel('Язык').selectOption('');
  await page.getByRole('searchbox', { name: 'Поиск по id' }).fill('chat-002');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toHaveAttribute('data-id', CHAT_2.conversation_id);
});

test('диалог открывается, показывается транскрипт с нумерацией реплик с 1', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#center-pane .state--empty')).toHaveText('Выберите диалог в списке слева.');

  await selectDialog(page, CHAT_1.conversation_id);
  await expect(page.locator('#list-pane .cl__item[data-id="e2e-ru-chat-001"]')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#center-pane .ch__meta .tag')).toHaveText(['Чат', 'RU']);
  await expect(page.locator('#center-pane .ch button.btn')).toHaveText('Оценить');

  const turns = page.locator('#center-pane .turn');
  await expect(turns).toHaveCount(CHAT_1.transcript.length);
  for (const [i, t] of CHAT_1.transcript.entries()) {
    const turn = turns.nth(i);
    await expect(turn.locator('.turn__idx')).toHaveText(`#${i + 1}`);
    await expect(turn.locator('.turn__role')).toHaveText(ROLE[t.speaker]);
    await expect(turn.locator('.turn__time')).toHaveText(t.timestamp);
    await expect(turn.locator('.turn__text')).toHaveText(t.text);
    await expect(turn).toHaveAttribute('data-turn', String(i)); // якорь с нуля, как turn_index в API
  }
  await expect(page.locator('#result-pane .state--empty')).toHaveText('Диалог ещё не оценён. Нажмите «Оценить».');

  // Через API тот же диалог: реплик столько же, порядок тот же.
  const api = await (await page.request.get(`/api/conversations/${CHAT_1.conversation_id}`)).json();
  expect(api.transcript.map((t) => t.text)).toEqual(CHAT_1.transcript.map((t) => t.text));
});

test('звонок: канал, плеер без записи и смещения реплик', async ({ page }) => {
  await openApp(page);
  await selectDialog(page, CALL_3.conversation_id);
  await expect(page.locator('#center-pane .ch__meta .tag')).toHaveText(['Звонок', 'RU']);
  await expect(page.locator('#center-pane .player__msg')).toHaveText('Запись недоступна');
  await expect(page.locator('#center-pane .turn')).toHaveCount(CALL_3.transcript.length);
  await expect(page.locator('#center-pane .turn__offset')).toHaveText(['00:00', '00:09', '00:20', '00:27', '00:41']);
  await expect(page.locator('#center-pane .turn__idx')).toHaveText(['#1', '#2', '#3', '#4', '#5']);
});

test('группа control без адреса: на экране понятная ошибка, возврат в dev работает', async ({ page }) => {
  await openApp(page);
  await page.locator('#list-pane .seg button', { hasText: 'control' }).click();
  const error = page.locator('#list-pane .state--error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('Не удалось загрузить группу «control».');
  await page.locator('#list-pane .seg button', { hasText: 'dev' }).click();
  await expect(page.locator('#list-pane .cl__item')).toHaveCount(3);
  // навигация остаётся рабочей
  await expect(nav(page, 'Диалоги')).toHaveAttribute('aria-current', 'page');
});
