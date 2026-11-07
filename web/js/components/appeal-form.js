// Компонент: форма подачи апелляции под критерием в карточке результата.
// createAppealForm({ criterionName, answer, points, weight, onSubmit(comment), onCancel }) -> { el, focus() }
// onSubmit возвращает Promise; при ошибке форма остаётся открытой и показывает текст ошибки.
import { errorText } from '../api.js';
import { el, fmtNumber } from '../dom.js';
import { answerText } from '../format.js';

export function createAppealForm({ criterionName, answer, points, weight, onSubmit, onCancel }) {
  const comment = el('textarea', {
    class: 'field',
    rows: 3,
    required: true,
    'aria-label': 'Комментарий',
    placeholder: 'Почему вы не согласны с оценкой? (обязательно)',
  });
  const msg = el('div', { class: 'af__msg', role: 'alert' });
  const send = el('button', { type: 'button', class: 'btn btn--small', text: 'Отправить' });
  const cancel = el('button', { type: 'button', class: 'btn btn--ghost btn--small', text: 'Отмена', onclick: onCancel });

  send.addEventListener('click', async () => {
    msg.textContent = '';
    send.disabled = true;
    send.textContent = 'Отправляем…';
    try {
      await onSubmit(comment.value);
    } catch (e) {
      msg.textContent = errorText(e); // текст остаётся в поле
      send.disabled = false;
      send.textContent = 'Отправить';
    }
  });

  const pointsText = typeof points === 'number' ? `${fmtNumber(points)} / ${fmtNumber(weight)}` : `— / ${fmtNumber(weight)}`;
  const root = el(
    'div',
    { class: 'af' },
    el('div', { class: 'af__title', text: `Оспорить критерий: ${criterionName}` }),
    el('div', { class: 'af__info', text: `Текущий ответ: ${answerText(answer)} · Баллы: ${pointsText}` }),
    el('label', { class: 'fld' }, el('span', { text: 'Комментарий' }), comment),
    msg,
    el('div', { class: 'af__actions' }, send, cancel),
  );
  return { el: root, focus: () => comment.focus() };
}
