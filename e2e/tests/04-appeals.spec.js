// Сценарий 4: апелляция. Подача на критерий, экран проверки, решение, пересчёт итога.
//
// Чек-лист приводится к состоянию из 03-checklist.spec.js (вес «Завершение» 25, шкала диалога 0, 5, 10),
// поэтому исходный итог mock-оценки 89,58 (расчёт в 03). Апелляция на «Корректная и полная консультация»:
// 15 из 20 -> 20 из 20, баллы 15 -> 20, сумма баллов 107,5 -> 112,5 при сумме весов 120,
// итог 100 * 112,5 / 120 = 93,75. Секция safety: (20 + 20) / 40 = 100.
import { CHAT_2, CONSULTATION } from '../support/data.js';
import { ensureEditedChecklist, getEvaluation, listAppeals } from '../support/api.js';
import { expect, test } from '../support/fixtures.js';
import { crit, evaluateOpenDialog, nav, openApp, selectDialog, shot } from '../support/ui.js';

const COMMENT = 'Оператор назвал размер комиссии в реплике 5, ответ полный.';
const REASON = 'Комиссия названа, вопрос клиента закрыт: ставим максимум.';

test('апелляция: подача, экран проверки, решение «изменить», итог пересчитан', async ({ page, request }, testInfo) => {
  await ensureEditedChecklist(request);
  await openApp(page);
  await selectDialog(page, CHAT_2.conversation_id);

  await test.step('оцениваем диалог', async () => {
    const response = await evaluateOpenDialog(page);
    expect(response.status()).toBe(200);
    await expect(page.locator('#result-pane .total__value')).toContainText('89,58');
  });
  const evaluationBefore = await getEvaluation(request, CHAT_2.conversation_id);
  expect(evaluationBefore.total).toBe(89.58);

  let appealId;
  await test.step('подаём апелляцию на критерий из карточки результата', async () => {
    const block = crit(page, CONSULTATION);
    await block.getByRole('button', { name: 'Оспорить' }).click();
    const form = block.locator('.af');
    await expect(form.locator('.af__title')).toHaveText(`Оспорить критерий: ${CONSULTATION}`);
    await expect(form.locator('.af__info')).toHaveText('Текущий ответ: 15 · Баллы: 15 / 20');
    await form.getByLabel('Комментарий').fill(COMMENT);
    const [post] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/appeals') && r.request().method() === 'POST'),
      form.getByRole('button', { name: 'Отправить' }).click(),
    ]);
    expect(post.status()).toBe(200);
    const appeal = await post.json();
    appealId = appeal.id;
    expect(appeal).toMatchObject({
      conversation_id: CHAT_2.conversation_id,
      criterion_id: 'consultation',
      status: 'open',
      evaluation_id: evaluationBefore.evaluation_id,
      comment: COMMENT,
      original: { answer: 15, points: 15 },
      fragment: { from_turn: 2, to_turn: 2 }, // из evidence: первая реплика оператора, индекс 2
    });

    // Форма закрылась, критерий помечен, кнопка заблокирована, на ярлыке «Проверка» счётчик.
    await expect(block.locator('.af')).toHaveCount(0);
    await expect(block.locator('.dispute--open')).toHaveText('Оспорено, ждёт решения');
    await expect(block.getByRole('button', { name: 'Оспорить' })).toBeDisabled();
    await expect(nav(page, 'Проверка').locator('.nav__badge')).toHaveText('1');
    await expect(nav(page, 'Проверка').locator('.nav__badge')).toBeVisible();
  });

  await test.step('экран проверки: апелляция видна вместе с комментарием и фрагментом', async () => {
    await nav(page, 'Проверка').click();
    const item = page.locator(`#appeals-list-pane .cl__item[data-id="${appealId}"]`);
    await expect(page.locator('#appeals-list-pane .cl__count')).toHaveText('Открытых: 1 из 1');
    await expect(item).toBeVisible();
    await expect(item.locator('.tag')).toHaveText('открыта');
    await expect(item).toContainText(`Диалог: ${CHAT_2.conversation_id}`);
    await expect(item).toContainText(`Критерий: ${CONSULTATION}`);
    await item.click();

    const card = page.locator('#appeal-card-pane .ac');
    await expect(card.locator('.rc__title')).toHaveText(`Апелляция ${appealId}`);
    await expect(card.locator('.ac__comment')).toHaveText(COMMENT);
    await expect(card.locator('.ac__facts')).toContainText('Исходная оценка');
    await expect(card.locator('.ac__facts')).toContainText('15, баллы: 15');
    // Фрагмент: спорная реплика №3 (индекс 2) и по одной реплике контекста с двух сторон.
    await expect(card.getByRole('heading', { name: 'Фрагмент диалога: реплики #3–#3' })).toBeVisible();
    await expect(card.locator('.turn--disputed')).toHaveCount(1);
    await expect(card.locator('.turn--disputed .turn__text')).toHaveText(CHAT_2.transcript[2].text);
    await expect(card.locator('.turn--context .turn__idx')).toHaveText(['#2', '#4']);
    await shot(page, testInfo, 'review-open');
  });

  await test.step('решение проверяющего: изменить оценку на 20', async () => {
    const card = page.locator('#appeal-card-pane .ac');
    await card.getByLabel('Изменить оценку').check();
    await card.getByLabel('Новый ответ').selectOption({ label: '20' });
    await card.getByLabel('Причина решения').fill(REASON);
    const [resolve] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/appeals/${appealId}/resolve`)),
      card.getByRole('button', { name: 'Сохранить решение' }).click(),
    ]);
    expect(resolve.status()).toBe(200);

    // Было -> Решение -> Стало и итог до/после.
    const boxes = card.locator('.wds__box');
    await expect(boxes.nth(0)).toContainText('Было');
    await expect(boxes.nth(0).locator('.wds__big')).toHaveText('15 (15 б.)');
    await expect(boxes.nth(1).locator('.wds__big')).toHaveText('Изменено');
    await expect(boxes.nth(1).locator('.wds__reason')).toHaveText(REASON);
    await expect(boxes.nth(2)).toContainText('Стало');
    await expect(boxes.nth(2).locator('.wds__big')).toHaveText('20 (20 б.)');
    await expect(card.locator('.wds__total')).toHaveText('Итог: 89,58 → 93,75');
    await expect(card.locator('.rc__top .tag').first()).toHaveText('решена');
    await expect(page.locator('#nav .nav__badge')).toBeHidden();
    await expect(page.locator(`#appeals-list-pane .cl__item[data-id="${appealId}"] .tag`)).toHaveText('решена');
    await shot(page, testInfo, 'review-resolved');
  });

  await test.step('в «Диалогах» итог пересчитан, видны исходная и финальная оценки', async () => {
    await nav(page, 'Диалоги').click();
    const card = page.locator('#result-pane .rc');
    await expect(card.locator('.total__value')).toContainText('93,75');
    await expect(card.locator('.sec__row b')).toHaveText(['100', '100', '86,36', '—']);
    const block = crit(page, CONSULTATION);
    await expect(block.locator('.pill')).toHaveText('20');
    await expect(block.locator('.crit__points')).toHaveText('20 / 20');
    await expect(block.locator('.dispute--done')).toHaveText('Апелляция решена: было 15 (15 б.), стало 20 (20 б.)');
  });

  await test.step('через API: апелляция решена, оценка и итоги на сервере обновлены', async () => {
    const [appeal] = await listAppeals(request, CHAT_2.conversation_id);
    expect(appeal).toMatchObject({
      id: appealId,
      status: 'resolved',
      original: { answer: 15, points: 15 },
      final: { answer: 20, points: 20 },
      total_before: 89.58,
      total_after: 93.75,
    });
    expect(appeal.decision).toMatchObject({ action: 'change', new_answer: 20, reason: REASON });
    const after = await getEvaluation(request, CHAT_2.conversation_id);
    expect(after.total).toBe(93.75);
    expect(after.evaluation_id, 'решение меняет ту же оценку, а не создаёт новую').toBe(evaluationBefore.evaluation_id);
    expect(after.criteria.find((c) => c.criterion_id === 'consultation')).toMatchObject({ answer: 20, points: 20 });
  });
});
