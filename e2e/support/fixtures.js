// Общий `test`: следит за страницей и валит тест, если в браузере появились
//  - необработанные исключения и console.error (кроме «Failed to load resource»: это ожидаемые
//    404/409 от сервера, их показ на экране проверяют сами тесты);
//  - запросы не на наш сервер (например, случайно на чужой порт 8080).
import { expect, test as base } from '@playwright/test';

import { BASE_URL } from './env.js';

export const test = base.extend({
  page: async ({ page }, use) => {
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('Failed to load resource')) {
        problems.push(`console.error: ${m.text()}`);
      }
    });
    page.on('request', (r) => {
      const url = r.url();
      if (!url.startsWith('data:') && !url.startsWith('blob:') && !url.startsWith(BASE_URL)) {
        problems.push(`запрос не на наш сервер: ${url}`);
      }
    });
    await use(page);
    expect(problems, 'ошибки и посторонние запросы в браузере').toEqual([]);
  },
});

export { expect };
