// Общий кусок: одна реплика диалога (используется в транскрипте и во фрагменте апелляции).
import { formatMMSS } from '../call-time.js';
import { el } from '../dom.js';

export const ROLES = {
  client: 'Клиент',
  operator: 'Оператор',
  bot: 'Бот',
  system: 'Система',
};

// anchor: true -> id="turn-N" (только в основном транскрипте, чтобы id не повторялись).
// call: null для чата; для звонка { offsetSec: число|null, onSeek: функция|null }:
//   метка времени показывается мелко (как пришла), рядом смещение ММ:СС; с onSeek оно кликабельно.
export function createTurnNode(turn, index, { anchor = false, extraClass = '', call = null } = {}) {
  const role = ROLES[turn.speaker] ? turn.speaker : 'other';
  let offset = null;
  if (call && typeof call.offsetSec === 'number') {
    offset = call.onSeek
      ? el('button', {
          type: 'button',
          class: 'turn__offset',
          text: formatMMSS(call.offsetSec),
          title: 'Перемотать запись на это место',
          onclick: () => call.onSeek(call.offsetSec),
        })
      : el('span', { class: 'turn__offset turn__offset--static', text: formatMMSS(call.offsetSec) });
  }
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
      el('span', { class: `turn__time${call ? ' turn__time--iso' : ''}`, text: turn.timestamp ?? '' }),
      offset,
      el('span', { class: 'turn__idx', text: `#${index + 1}` }),
    ),
    el('div', { class: 'turn__text', text: turn.text ?? '' }),
  );
}
