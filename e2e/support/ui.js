// Помощники для работы с интерфейсом (селекторы привязаны к панелям из web/index.html).
import { expect } from './fixtures.js';

export async function openApp(page) {
  await page.goto('/');
  await expect(page.locator('#list-pane .cl__item').first()).toBeVisible();
}

export function nav(page, label) {
  // у ярлыка «Проверка» внутри может быть счётчик, поэтому ищем по началу названия
  return page.locator('#nav button', { hasText: label });
}

export async function selectDialog(page, id) {
  await page.locator(`#list-pane .cl__item[data-id="${id}"]`).click();
  await expect(page.locator('#center-pane .ch__title')).toHaveText(id);
}

/** Кнопка «Оценить» / «Оценить заново» в шапке диалога. */
export const evaluateButton = (page) => page.locator('#center-pane .ch button.btn');

/** Блок критерия в карточке результата по названию. */
export function crit(page, name) {
  return page.locator('#result-pane .crit', { has: page.locator('.crit__name', { hasText: name }) });
}

/** Нажимает «Оценить» и возвращает ответ POST /api/evaluate. */
export async function evaluateOpenDialog(page) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/evaluate') && r.request().method() === 'POST'),
    evaluateButton(page).click(),
  ]);
  return response;
}

/** Снимок экрана: файл в test-results/<тест>/<name>.png и вложение в HTML-отчёт. */
export async function shot(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}
