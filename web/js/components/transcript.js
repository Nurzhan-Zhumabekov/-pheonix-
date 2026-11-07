// Компонент: транскрипт диалога.
// createTranscript() -> { el, show(conversation), setLoading(), setError(text), setPlaceholder(text), scrollToTurn(i) }
// У каждой реплики есть якорь data-turn = turn_index (с нуля, как в массиве transcript).
import { clear, el, stateBox } from '../dom.js';

const ROLES = {
  client: 'Клиент',
  operator: 'Оператор',
  bot: 'Бот',
  system: 'Система',
};

export function createTranscript() {
  const root = el('div', { class: 'pane__body' });

  function show(conversation) {
    const turns = Array.isArray(conversation.transcript) ? conversation.transcript : [];
    clear(root);
    if (!turns.length) {
      root.append(stateBox('empty', 'В диалоге нет реплик.'));
      return;
    }
    const list = el('div', { class: 'tr' });
    turns.forEach((t, i) => {
      const role = ROLES[t.speaker] ? t.speaker : 'other';
      list.append(
        el(
          'div',
          { class: `turn turn--${role}`, id: `turn-${i}`, dataset: { turn: i } },
          el(
            'div',
            { class: 'turn__head' },
            el('span', { class: 'turn__role', text: ROLES[t.speaker] || t.speaker || '—' }),
            // метка времени ровно как в данных
            el('span', { class: 'turn__time', text: t.timestamp ?? '' }),
            el('span', { class: 'turn__idx', text: `#${i}` }),
          ),
          el('div', { class: 'turn__text', text: t.text ?? '' }),
        ),
      );
    });
    root.append(list);
    root.scrollTop = 0;
  }

  function scrollToTurn(index) {
    const node = root.querySelector(`[data-turn="${Number(index)}"]`);
    if (!node) return false;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.remove('turn--flash');
    void node.offsetWidth; // перезапуск анимации при повторном клике
    node.classList.add('turn--flash');
    setTimeout(() => node.classList.remove('turn--flash'), 2700);
    return true;
  }

  return {
    el: root,
    show,
    scrollToTurn,
    setLoading: () => clear(root).append(stateBox('loading', 'Загружаем диалог…')),
    setError: (text) => clear(root).append(stateBox('error', text)),
    setPlaceholder: (text) => clear(root).append(stateBox('empty', text)),
  };
}
