// Компонент: шапка над транскриптом (id, канал, язык, кнопка «Оценить»).
// createConversationHeader({ onEvaluate }) -> { el, show(conv, hasEvaluation), hide(), setBusy(bool), setHasEvaluation(bool) }
import { channelLabel, clear, el, tag } from '../dom.js';

export function createConversationHeader({ onEvaluate }) {
  const root = el('div', { class: 'pane__head' });
  let button = null;
  let has = false;

  function label() {
    return has ? 'Оценить заново' : 'Оценить';
  }

  function show(conv, hasEvaluation) {
    has = hasEvaluation;
    button = el('button', {
      type: 'button',
      class: 'btn',
      text: label(),
      onclick: () => onEvaluate(conv.conversation_id),
    });
    clear(root).append(
      el(
        'div',
        { class: 'ch' },
        el('div', { class: 'ch__title', text: conv.conversation_id }),
        el('div', { class: 'ch__meta' }, tag(channelLabel(conv.channel)), tag(conv.language || '—')),
        button,
      ),
    );
  }

  return {
    el: root,
    show,
    hide: () => { clear(root); button = null; },
    setBusy(busy) {
      if (!button) return;
      button.disabled = busy;
      button.textContent = busy ? 'Оцениваем…' : label();
    },
    setHasEvaluation(value) {
      has = value;
      if (button && !button.disabled) button.textContent = label();
    },
  };
}
