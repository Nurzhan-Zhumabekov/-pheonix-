// Запросы к API напрямую (через request-фикстуру Playwright, baseURL = наш сервер).
import { expect } from '@playwright/test';

export async function getChecklist(request) {
  const res = await request.get('/api/checklist');
  expect(res.status()).toBe(200);
  return res.json();
}

export async function getEvaluation(request, conversationId) {
  const res = await request.get(`/api/evaluations/${conversationId}`);
  expect(res.status()).toBe(200);
  return res.json();
}

export async function listAppeals(request, conversationId) {
  const res = await request.get(`/api/appeals?conversation_id=${conversationId}`);
  expect(res.status()).toBe(200);
  return res.json();
}

/**
 * Приводит чек-лист к состоянию, которое оставляет тест редактора: вес «Завершение» = 25,
 * шкала «Управление диалогом» = 0, 5, 10. Если оно уже такое, версия не растёт.
 * Так апелляционные тесты не зависят от порядка запуска.
 */
export async function ensureEditedChecklist(request) {
  const cl = await getChecklist(request);
  const closing = cl.criteria.find((c) => c.id === 'closing');
  const dialog = cl.criteria.find((c) => c.id === 'dialog');
  const ok = closing.weight === 25 && JSON.stringify(dialog.scale) === '[0,5,10]';
  if (ok) return cl;
  closing.weight = 25;
  dialog.scale = [0, 5, 10];
  const res = await request.put('/api/checklist', { data: cl });
  expect(res.status(), 'PUT /api/checklist при подготовке').toBe(200);
  return res.json();
}
