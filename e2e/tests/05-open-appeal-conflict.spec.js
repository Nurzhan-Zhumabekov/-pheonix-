// Сценарий 5: повторная оценка при открытой апелляции даёт 409, интерфейс показывает текст ошибки.
// Проверяем и на экране (текст виден пользователю), и по ответу сервера (статус и код).
import { CALL_3 } from '../support/data.js';
import { getEvaluation, listAppeals } from '../support/api.js';
import { expect, test } from '../support/fixtures.js';
import { crit, evaluateButton, evaluateOpenDialog, nav, openApp, selectDialog, shot } from '../support/ui.js';

const CRITERION = 'Эмпатия и клиентоориентированность';
const SERVER_TEXT = 'по диалогу есть нерассмотренная апелляция: сначала примите решение';

test('повторная оценка при открытой апелляции: 409 и текст ошибки на экране', async ({ page, request }, testInfo) => {
  await openApp(page);
  await selectDialog(page, CALL_3.conversation_id);
  // Оценка звонка осталась от 02-evaluate.spec.js; если файл запускают отдельно, оцениваем здесь.
  await expect(page.locator('#result-pane .rc, #result-pane .state--empty').first()).toBeVisible();
  if (!(await page.locator('#result-pane .rc').isVisible())) await evaluateOpenDialog(page);
  await expect(page.locator('#result-pane .rc')).toBeVisible();
  const evaluationBefore = await getEvaluation(request, CALL_3.conversation_id);
  const resultCard = page.locator('#result-pane .rc');
  const totalBefore = await resultCard.locator('.total__value').innerText();

  await test.step('подаём апелляцию', async () => {
    const block = crit(page, CRITERION);
    await block.getByRole('button', { name: 'Оспорить' }).click();
    await block.getByLabel('Комментарий').fill('Клиент не выражал недовольства, критерий выставлен неверно.');
    await block.getByRole('button', { name: 'Отправить' }).click();
    await expect(block.locator('.dispute--open')).toHaveText('Оспорено, ждёт решения');
  });

  await test.step('«Оценить заново» из карточки результата: 409, ошибка видна на экране', async () => {
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/evaluate') && r.request().method() === 'POST'),
      page.locator('#result-pane .rc__top').getByRole('button', { name: 'Оценить заново' }).click(),
    ]);
    expect(response.status()).toBe(409);
    expect((await response.json()).error).toEqual({ code: 'open_appeal', message: SERVER_TEXT });

    const error = page.locator('#result-pane .state--error');
    await expect(error).toBeVisible();
    await expect(error).toHaveText(`Не удалось оценить диалог. ${SERVER_TEXT}`);
    await expect(resultCard).toBeVisible();
    await expect(resultCard.locator('.total__value')).toHaveText(totalBefore);
    await expect(crit(page, CRITERION).locator('.dispute--open')).toBeVisible();
    await shot(page, testInfo, 'conflict-from-card');
    // Кнопка в шапке снова доступна: интерфейс не завис в состоянии «Оцениваем…».
    await expect(evaluateButton(page)).toBeEnabled();
    await expect(evaluateButton(page)).toHaveText('Оценить заново');
  });

  await test.step('«Оценить заново» из шапки диалога: то же сообщение', async () => {
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/evaluate') && r.request().method() === 'POST'),
      evaluateButton(page).click(),
    ]);
    expect(response.status()).toBe(409);
    await expect(page.locator('#result-pane .state--error')).toHaveText(`Не удалось оценить диалог. ${SERVER_TEXT}`);
    await expect(resultCard.locator('.total__value')).toHaveText(totalBefore);
  });

  await test.step('прежняя оценка на сервере не тронута', async () => {
    const after = await getEvaluation(request, CALL_3.conversation_id);
    expect(after.evaluation_id).toBe(evaluationBefore.evaluation_id);
    expect(after.total).toBe(evaluationBefore.total);
  });

  await test.step('после решения по апелляции оценка снова возможна', async () => {
    const [appeal] = await listAppeals(request, CALL_3.conversation_id);
    expect(appeal.status).toBe('open');
    await nav(page, 'Проверка').click();
    await page.locator(`#appeals-list-pane .cl__item[data-id="${appeal.id}"]`).click();
    const card = page.locator('#appeal-card-pane .ac');
    await card.getByLabel('Подтвердить оценку').check();
    await card.getByLabel('Причина решения').fill('Оценка корректна.');
    await card.getByRole('button', { name: 'Сохранить решение' }).click();
    await expect(card.locator('.wds__big').nth(1)).toHaveText('Подтверждено');
    // подтверждение итог не меняет: до и после одно число
    const before = evaluationBefore.total.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    await expect(card.locator('.wds__total')).toHaveText(`Итог: ${before} → ${before}`);

    await nav(page, 'Диалоги').click();
    const response = await evaluateOpenDialog(page);
    expect(response.status()).toBe(200);
    const fresh = await response.json();
    expect(fresh.evaluation_id).not.toBe(evaluationBefore.evaluation_id);
    await expect(page.locator('#result-pane .rc')).toBeVisible();
    await expect(page.locator('#result-pane .state--error')).toHaveCount(0);
  });
});
