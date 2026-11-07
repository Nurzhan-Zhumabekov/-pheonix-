// Настройки e2e. Всё, что зависит от машины, можно переопределить переменными окружения.
//
// Правила безопасности (проверяются в global-setup.js):
//  - свой сервер на порту 18800, порт 8080 не используется никогда;
//  - рабочая папка процесса сервера вне репозитория и без `.env` в родительских папках,
//    LLM_PROVIDER, DEV_API_URL и CONTROL_API_URL серверу не передаются: он работает в mock-режиме;
//  - хранилище (STORAGE_DIR) каждый запуск новое.
import path from 'node:path';

const SCRATCH =
  'C:/Users/admin/AppData/Local/Temp/claude/C--Users-admin-Desktop-Rust/34b6ca6e-f5eb-41da-a9b0-da3d9a9ca551/scratchpad';

export const PORT = Number(process.env.CQA_E2E_PORT ?? 18800);
if (!Number.isInteger(PORT) || PORT === 8080) {
  throw new Error(`CQA_E2E_PORT=${PORT}: порт 8080 занят чужим сервером, e2e его не использует`);
}
export const BASE_URL = `http://127.0.0.1:${PORT}`;

/** Готовый бинарник бэкенда (тесты его не собирают). */
export const BACKEND_EXE =
  process.env.CQA_BACKEND_EXE ?? path.join(SCRATCH, 'target-claude', 'debug', 'backend.exe');

/** Папка с интерфейсом (index.html, js/, styles.css). */
export const WEB_DIR = process.env.CQA_WEB_DIR ?? 'C:/Users/admin/Desktop/cqa-integration/web';

/** Где создавать новые папки запуска (`e2e-run-<время>-<pid>`). */
export const RUN_ROOT = process.env.CQA_E2E_RUN_ROOT ?? SCRATCH;

/** Репозиторий, в котором лежит `.env`: рабочая папка сервера не должна быть внутри него. */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
