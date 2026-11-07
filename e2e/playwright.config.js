// Запуск одной командой из папки e2e:   npm test      (то же самое: npx playwright test)
//
// Сервер поднимает и останавливает support/global-setup.js. Пути по умолчанию заданы в support/env.js,
// их можно переопределить: CQA_BACKEND_EXE, CQA_WEB_DIR, CQA_E2E_RUN_ROOT, CQA_E2E_PORT.
import { defineConfig, devices } from '@playwright/test';

import { BASE_URL } from './support/env.js';

export default defineConfig({
  testDir: './tests',
  // Тесты идут по порядку файлов на одном сервере: апелляции опираются на оценки и чек-лист из предыдущих.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './support/global-setup.js',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    locale: 'ru-RU',
    timezoneId: 'Asia/Almaty',
    trace: 'retain-on-failure',
    // CQA_E2E_SHOTS=1: снимок экрана в конце каждого теста (test-results/…/test-finished-1.png)
    screenshot: process.env.CQA_E2E_SHOTS ? 'on' : 'only-on-failure',
  },
  projects: [{ name: 'chromium' }],
});
