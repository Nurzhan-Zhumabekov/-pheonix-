// Сценарий 2: оценка диалога. Карточка результата, итог, секции, нумерация реплик с 1.
//
// Ожидаемые числа посчитаны вручную по docs/SCORING.md для заглушки judge (backend/src/judge.rs, mock):
// бинарные критерии = «Да», шкальные = вторая сверху ступень (консультация 15 из 20, диалог 7 из 10),
// чек-лист версии 1 (веса 10, 15, 20, 20, 15, 15, 5, сумма 100):
//   баллы 10 + 15 + 20 + 15 + 15 + 10,5 + 5 = 90,5  ->  итог 90,5
//   секции: start 100; safety (20 + 15) / 40 = 87,5; flow (15 + 10,5 + 5) / 35 = 87,14; gross: нет баллов.
import { CALL_3, CHAT_1, CRITERIA_V1, SECTION_NAMES } from '../support/data.js';
import { expect, test } from '../support/fixtures.js';
import { evaluateButton, evaluateOpenDialog, openApp, selectDialog, shot } from '../support/ui.js';

test('оценка чата: карточка с критериями, итогом, секциями и mock-пометкой', async ({ page, request }, testInfo) => {
  await openApp(page);
  await selectDialog(page, CHAT_1.conversation_id);

  const response = await evaluateOpenDialog(page);
  expect(response.status()).toBe(200);
  const evaluation = await response.json();
  expect(evaluation.mock).toBe(true);
  expect(evaluation.evaluation_id).toMatch(/^ev_/);
  expect(evaluation.checklist_version).toBe(1);

  const card = page.locator('#result-pane .rc');
  await expect(card).toBeVisible();
  await expect(card.locator('.rc__top .tag')).toHaveText(['mock', 'чек-лист v1', 'модель: mock']);

  // Итог и секции.
  await expect(card.locator('.total__value')).toContainText('90,5');
  await expect(card.locator('.total__value small')).toHaveText('из 100');
  await expect(card.locator('.sec__row span')).toHaveText(SECTION_NAMES);
  await expect(card.locator('.sec__row b')).toHaveText(['100', '87,5', '87,14', '—']);

  // Критерии. В чек-листе их 8; семь оцениваются и показываются карточками, восьмой (грубые
  // ошибки, тип flag) judge отдаёт отдельным блоком gross_error: баллов у него нет.
  const checklist = await (await request.get('/api/checklist')).json();
  expect(checklist.criteria).toHaveLength(8);
  expect(checklist.criteria.filter((c) => c.type === 'flag')).toHaveLength(1);
  const crits = card.locator('.crit');
  await expect(crits).toHaveCount(7);
  await expect(crits.locator('.crit__name')).toHaveText(CRITERIA_V1);
  await expect(crits.locator('.pill')).toHaveText(['Да', 'Да', 'Да', '15', 'Да', '7', 'Да']);
  await expect(crits.locator('.crit__points')).toHaveText([
    '10 / 10', '15 / 15', '20 / 20', '15 / 20', '15 / 15', '10,5 / 15', '5 / 5',
  ]);
  await expect(card.locator('.gross')).toHaveClass(/gross--ok/);
  await expect(card.locator('.gross__title')).toHaveText('Грубых ошибок не выявлено');
  expect(evaluation.criteria).toHaveLength(7);
  expect(evaluation.gross_error.flag).toBe(false);

  // Нумерация реплик: в API turn_index с нуля, на экране с 1, и в карточке, и в транскрипте.
  const firstOperator = CHAT_1.transcript.findIndex((t) => t.speaker === 'operator'); // 1
  expect(evaluation.criteria[0].evidence[0].turn_index).toBe(firstOperator);
  const quote = CHAT_1.transcript[firstOperator].text;
  await expect(crits.locator('.ev__head span:nth-child(2)')).toHaveText(Array(7).fill(`реплика #${firstOperator + 1}`));
  await expect(crits.locator('.ev__quote')).toHaveText(Array(7).fill(`«${quote}»`));
  await expect(crits.first().locator('.crit__note')).toContainText(`реплики #1–#${CHAT_1.transcript.length}`);
  const turn = page.locator(`#center-pane [data-turn="${firstOperator}"]`);
  await expect(turn.locator('.turn__idx')).toHaveText(`#${firstOperator + 1}`);
  await expect(turn.locator('.turn__text')).toHaveText(quote);

  // Клик по цитате прокручивает к реплике и подсвечивает её.
  await crits.first().locator('.ev__btn').click();
  await expect(turn).toHaveClass(/turn--flash/);
  await shot(page, testInfo, 'result-card');

  // Диалог отмечен как оценённый, кнопка стала «Оценить заново».
  await expect(page.locator('#list-pane .cl__item[data-id="e2e-ru-chat-001"] .tag--ok')).toHaveText('оценён');
  await expect(evaluateButton(page)).toHaveText('Оценить заново');
});

test('оценка сохранена на сервере: после перезагрузки страницы карточка на месте', async ({ page, request }) => {
  const saved = await (await request.get(`/api/evaluations/${CHAT_1.conversation_id}`)).json();
  expect(saved.mock).toBe(true);
  expect(saved.total).toBe(90.5);
  expect(saved.sections).toEqual([
    { id: 'start', score: 100 },
    { id: 'safety', score: 87.5 },
    { id: 'flow', score: 87.14 },
    { id: 'gross', score: null },
  ]);

  await openApp(page);
  await expect(page.locator('#list-pane .cl__item[data-id="e2e-ru-chat-001"] .tag--ok')).toHaveText('оценён');
  await selectDialog(page, CHAT_1.conversation_id);
  await expect(page.locator('#result-pane .total__value')).toContainText('90,5');
  await expect(evaluateButton(page)).toHaveText('Оценить заново');
});

test('оценка звонка: первая реплика оператора это реплика №1', async ({ page }) => {
  await openApp(page);
  await selectDialog(page, CALL_3.conversation_id);
  const response = await evaluateOpenDialog(page);
  const evaluation = await response.json();
  expect(evaluation.criteria[0].evidence[0].turn_index).toBe(0);

  const card = page.locator('#result-pane .rc');
  await expect(card.locator('.total__value')).toContainText('90,5');
  await expect(card.locator('.crit').first().locator('.ev__head span:nth-child(2)')).toHaveText('реплика #1');
  await expect(card.locator('.crit').first().locator('.crit__note')).toContainText(`реплики #1–#${CALL_3.transcript.length}`);
  await expect(page.locator('#center-pane [data-turn="0"] .turn__idx')).toHaveText('#1');
  // Записи нет, поэтому кнопки «к записи» быть не должно.
  await expect(card.locator('.ev__seek')).toHaveCount(0);
});
