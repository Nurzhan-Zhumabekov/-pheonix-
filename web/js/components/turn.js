// Общий кусок: одна реплика диалога (используется в транскрипте и во фрагменте апелляции).
import { el } from '../dom.js';

export const ROLES = {
  client: 'Клиент',
  operator: 'Оператор',
  bot: 'Бот',
  system: 'Система',
};

// anchor: true -> id="turn-N" (только в основном транскрипте, чтобы id не повторялись).
export function createTurnNode(turn, index, { anchor = false, extraClass = '' } = {}) {
  const role = ROLES[turn.speaker] ? turn.speaker : 'other';
  return el(
    'div',
    {
      class: `turn turn--${role}${extraClass ? ` ${extraClass}` : ''}`,
      id: anchor ? `turn-${index}` : null,
      dataset: { turn: index },
    },
    el(
      'div',
      { class: 'turn__head' },
      el('span', { class: 'turn__role', text: ROLES[turn.speaker] || turn.speaker || '—' }),
      // метка времени ровно как в данных
      el('span', { class: 'turn__time', text: turn.timestamp ?? '' }),
      el('span', { class: 'turn__idx', text: `#${index}` }),
    ),
    el('div', { class: 'turn__text', text: turn.text ?? '' }),
  );
}
