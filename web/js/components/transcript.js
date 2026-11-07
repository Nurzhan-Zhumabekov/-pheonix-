// Компонент: транскрипт диалога.
// createTranscript() -> { el, show(conversation), setLoading(), setError(text), setPlaceholder(text), scrollToTurn(i) }
// У каждой реплики есть якорь data-turn = turn_index (с нуля, как в массиве transcript).
import { clear, el, stateBox } from '../dom.js';
import { createTurnNode } from './turn.js';

export function createTranscript() {
  const root = el('div', { class: 'pane__body' });

  function show(conversation) {
    const turns = Array.isArray(conversation.transcript) ? conversation.transcript : [];
    clear(root);
    if (!turns.length) {
      root.append(stateBox('empty', 'В диалоге нет реплик.'));
      return;
    }
    root.append(el('div', { class: 'tr' }, turns.map((t, i) => createTurnNode(t, i, { anchor: true }))));
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
