// Общие функции показа значений.
import { fmtNumber } from './dom.js';

export function answerText(answer) {
  if (answer === 'yes') return 'Да';
  if (answer === 'no') return 'Нет';
  if (answer === 'na') return 'N/A';
  if (typeof answer === 'number') return fmtNumber(answer);
  return '—';
}

export function answerWithPoints(answer, points) {
  return typeof points === 'number' ? `${answerText(answer)} (${fmtNumber(points)} б.)` : answerText(answer);
}

export const totalText = (total) => (typeof total === 'number' ? fmtNumber(total) : 'не рассчитан');

// Время создания и решения апелляции (метки времени реплик этим не форматируются).
export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return iso || '—';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
