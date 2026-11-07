// Поднимает свой бэкенд в mock-режиме на порту 18800 и останавливает его после прогона.
//
// Что гарантируется до первого теста (иначе прогон прерывается):
//  - порт свободен, то есть чужой сервер (например, на 8080) не подменит наш;
//  - рабочая папка сервера новая, вне репозитория, и ни в ней, ни выше нет `.env`
//    (dotenvy ищет `.env` вверх по родительским папкам);
//  - серверу не передаются LLM_PROVIDER, DEV_API_URL, CONTROL_API_URL и вообще чужие переменные;
//  - в логе сервера есть «файл .env не найден» и «judge: заглушка»;
//  - на порту слушает именно наш процесс (PID из spawn совпадает с PID из netstat).
// В конце останавливается только этот процесс.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { BACKEND_EXE, BASE_URL, PORT, REPO_ROOT, RUN_ROOT, WEB_DIR } from './env.js';
import { CONVERSATIONS } from './data.js';

const isInside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function assertRunDirIsSafe(dir) {
  if (isInside(dir, REPO_ROOT)) {
    throw new Error(`Папка запуска ${dir} внутри репозитория ${REPO_ROOT}: рядом может лежать .env`);
  }
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    // Проверяем только наличие файла, содержимое не читаем.
    if (fs.existsSync(path.join(d, '.env'))) {
      throw new Error(`В ${d} есть .env: сервер мог бы его подхватить. Задайте другой CQA_E2E_RUN_ROOT`);
    }
    if (path.dirname(d) === d) break;
  }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

/** PID процесса, слушающего порт на 127.0.0.1 (Windows: netstat). */
function listenerPid(port) {
  if (process.platform !== 'win32') return null;
  const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'TCP' && parts[1] === `127.0.0.1:${port}` && parts[3] === 'LISTENING') return Number(parts[4]);
  }
  return null;
}

async function waitForHealth(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Бэкенд завершился с кодом ${child.exitCode}`);
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch {
      // ещё не поднялся
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Бэкенд не ответил на /api/health за ${timeoutMs} мс`);
}

function stop(child) {
  if (child.exitCode !== null) return;
  try {
    child.kill();
  } catch {
    // уже завершён
  }
}

export default async function globalSetup() {
  if (!fs.existsSync(BACKEND_EXE)) throw new Error(`Нет бинарника бэкенда: ${BACKEND_EXE} (CQA_BACKEND_EXE)`);
  if (!fs.existsSync(path.join(WEB_DIR, 'index.html'))) throw new Error(`Нет index.html в ${WEB_DIR} (CQA_WEB_DIR)`);
  if (await portInUse(PORT)) {
    throw new Error(`Порт ${PORT} уже занят. Чужой сервер не трогаем: освободите порт или задайте CQA_E2E_PORT`);
  }

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const runDir = path.join(RUN_ROOT, `e2e-run-${stamp}-${process.pid}`);
  assertRunDirIsSafe(runDir);
  const storageDir = path.join(runDir, 'storage');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, 'conversations_dev.json'), JSON.stringify(CONVERSATIONS, null, 2));

  const logPath = path.join(runDir, 'backend.log');
  const logFd = fs.openSync(logPath, 'w');
  // Минимальное окружение: ничего лишнего (ключи, адреса DEV и т.п.) серверу не уходит.
  const env = { PORT: String(PORT), STORAGE_DIR: storageDir, WEB_DIR };
  for (const key of ['SystemRoot', 'windir', 'PATH', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  const child = spawn(BACKEND_EXE, [], { cwd: runDir, env, stdio: ['ignore', logFd, logFd], windowsHide: true });
  process.once('exit', () => stop(child));
  const fail = (message) => {
    stop(child);
    throw new Error(`${message}\nЛог сервера: ${logPath}`);
  };

  try {
    await waitForHealth(child, 20_000);
  } catch (e) {
    fail(e.message);
  }

  const log = fs.readFileSync(logPath, 'utf8');
  if (!log.includes('файл .env не найден')) fail('Сервер нашёл .env: прогон остановлен');
  if (!log.includes('judge: заглушка')) fail('Сервер не в mock-режиме (нет строки «judge: заглушка»): прогон остановлен');
  const pid = listenerPid(PORT);
  if (pid !== null && pid !== child.pid) fail(`На порту ${PORT} слушает PID ${pid}, а не наш ${child.pid}`);

  process.env.CQA_E2E_RUN_DIR = runDir;
  console.log(`[e2e] сервер PID ${child.pid}, порт ${PORT}, папка запуска ${runDir}`);

  return async () => {
    stop(child);
    for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      fs.closeSync(logFd);
    } catch {
      // уже закрыт
    }
    const stillUp = await portInUse(PORT);
    console.log(`[e2e] сервер PID ${child.pid} остановлен, порт ${PORT} ${stillUp ? 'ВСЁ ЕЩЁ ЗАНЯТ' : 'свободен'}; лог: ${logPath}`);
  };
}
