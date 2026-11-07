// Единственное место, где фронт делает HTTP-запросы. Только наш /api.
import { API_BASE } from './config.js';

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      ...options,
      headers: { Accept: 'application/json', ...(options.headers || {}) },
    });
  } catch {
    throw new ApiError('network', 'Не удалось связаться с сервером. Проверьте, что он запущен.', 0);
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    // тело не JSON — разберём по статусу ниже
  }

  if (!res.ok) {
    const err = body && body.error;
    throw new ApiError(
      (err && err.code) || 'http_error',
      (err && err.message) || `Ошибка сервера (HTTP ${res.status})`,
      res.status,
    );
  }
  if (body === null) {
    throw new ApiError('bad_response', 'Сервер вернул ответ в неожиданном формате.', res.status);
  }
  return body;
}

const enc = encodeURIComponent;

export const api = {
  listConversations: (group) =>
    request(`/api/conversations?group=${enc(group)}`).then((b) => (Array.isArray(b) ? b : b.items)),
  getConversation: (id) => request(`/api/conversations/${enc(id)}`),
  getChecklist: () => request('/api/checklist'),
  saveChecklist: (checklist) =>
    request('/api/checklist', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(checklist),
    }),
  listAppeals: (conversationId) =>
    request(conversationId ? `/api/appeals?conversation_id=${enc(conversationId)}` : '/api/appeals'),
  createAppeal: (body) =>
    request('/api/appeals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  resolveAppeal: (id, body) =>
    request(`/api/appeals/${enc(id)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  getEvaluation: (id) => request(`/api/evaluations/${enc(id)}`),
  async getAppealChecklist(appeal) {
    try {
      const evaluation = await api.getEvaluation(appeal.conversation_id);
      if (appeal.evaluation_id && evaluation.evaluation_id !== appeal.evaluation_id) return null;

      const version = evaluation.checklist_version;
      if (!Number.isInteger(version) || version < 1) return null;

      const checklist = await request(`/api/checklists/${version}`);
      return checklist.version === version && Array.isArray(checklist.criteria) ? checklist : null;
    } catch {
      return null;
    }
  },
  evaluate: (id) =>
    request('/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: id }),
    }),
};

export function errorText(e) {
  return e instanceof ApiError ? e.message : 'Что-то пошло не так. Попробуйте ещё раз.';
}
