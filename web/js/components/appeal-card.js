// Компонент: карточка апелляции для проверяющего (правая часть экрана «Проверка»).
// createAppealCard({ onOpenDialog(conversationId, turnIndex|null), onResolve(appeal, body) })
//   -> { el, show(appeal, conversation, checklist), setLoading(), setError(text), setPlaceholder(text) }
import { errorText } from '../api.js';
import { clear, el, fmtNumber, stateBox, tag } from '../dom.js';
import { answerText, answerWithPoints, fmtDateTime, totalText } from '../format.js';
import { computeOffsets } from '../call-time.js';
import { createAudioPlayer } from './audio-player.js';
import { createTurnNode } from './turn.js';

function answerOptions(def) {
  if (!def) return [];
  const opts =
    def.type === 'scale'
      ? (def.scale || []).map((v) => [v, fmtNumber(v)])
      : [['yes', 'Да'], ['no', 'Нет']];
  if (def.na_allowed && def.type !== 'flag') opts.push(['na', 'N/A']);
  return opts;
}

export function createAppealCard({ onOpenDialog, onResolve }) {
  const root = el('div', { class: 'pane__body' });

  // ---------- фрагмент диалога ----------
  function fragmentBlock(appeal, conv) {
    const frag = appeal.fragment;
    const turns = conv && Array.isArray(conv.transcript) ? conv.transcript : [];
    const openWhole = el('button', {
      type: 'button', class: 'linkbtn', text: 'Открыть диалог целиком',
      onclick: () => onOpenDialog(appeal.conversation_id, null),
    });
    if (!frag || !turns.length) {
      return el(
        'div',
        { class: 'ac__block' },
        el('h4', { text: 'Фрагмент диалога' }),
        el('div', { class: 'ac__none' }, frag ? 'Диалог недоступен. ' : 'Фрагмент не определён. ', openWhole),
      );
    }
    const from = Math.max(0, Math.min(frag.from_turn, turns.length - 1));
    const to = Math.max(from, Math.min(frag.to_turn, turns.length - 1));
    // Звонок: смещения реплик и мини-плеер записи.
    const isCall = conv.channel === 'voice call';
    const offsets = isCall ? computeOffsets(turns) : null;
    const mini = isCall ? createAudioPlayer() : null;
    if (mini) mini.show(conv);
    const seek = isCall && conv.audio_url ? (sec) => mini.seek(sec) : null;
    const list = el('div', { class: 'tr' });
    for (let i = Math.max(0, from - 1); i <= Math.min(turns.length - 1, to + 1); i += 1) {
      const disputed = i >= from && i <= to;
      list.append(createTurnNode(turns[i], i, {
        extraClass: disputed ? 'turn--disputed' : 'turn--context',
        call: isCall ? { offsetSec: offsets[i], onSeek: seek } : null,
      }));
    }
    return el(
      'div',
      { class: 'ac__block' },
      el('h4', { text: `Фрагмент диалога: реплики #${from}–#${to}` }),
      el('div', { class: 'ac__hint', text: 'Спорные реплики выделены, по одной реплике контекста до и после.' }),
      mini ? mini.el : null,
      list,
    );
  }

  // ---------- форма решения ----------
  function decisionForm(appeal, def) {
    const opts = answerOptions(def);
    const msg = el('div', { class: 'af__msg', role: 'alert' });
    const reason = el('textarea', {
      class: 'field', rows: 3, 'aria-label': 'Причина решения', placeholder: 'Почему принято такое решение (обязательно)',
    });
    const select = el(
      'select',
      { class: 'field', 'aria-label': 'Новый ответ' },
      el('option', { value: '', text: '— выберите —' }),
      ...opts.map(([, label], i) => el('option', { value: String(i), text: label })),
    );
    const answerField = el('label', { class: 'fld', hidden: true }, el('span', { text: 'Новый ответ' }), select);
    const radio = (value, label, disabled = false) => {
      const input = el('input', { type: 'radio', name: `act-${appeal.id}`, value, disabled });
      input.addEventListener('change', () => { answerField.hidden = value !== 'change'; });
      return el('label', { class: 'ac__radio' }, input, label);
    };
    const save = el('button', { type: 'button', class: 'btn', text: 'Сохранить решение' });
    const root2 = el(
      'div',
      { class: 'ac__block' },
      el('h4', { text: 'Решение проверяющего' }),
      el(
        'div',
        { class: 'ac__radios' },
        radio('confirm', 'Подтвердить оценку'),
        radio('change', 'Изменить оценку', !def),
      ),
      def ? null : el('div', { class: 'ac__hint', text: 'Критерия нет в текущем чек-листе: изменить оценку нельзя. Откройте диалог и оцените его заново.' }),
      answerField,
      el('label', { class: 'fld' }, el('span', { text: 'Причина решения' }), reason),
      msg,
      el('div', { class: 'af__actions' }, save),
    );

    save.addEventListener('click', async () => {
      msg.textContent = '';
      const chosen = root2.querySelector('input[type=radio]:checked');
      if (!chosen) { msg.textContent = 'Выберите действие: подтвердить или изменить оценку.'; return; }
      const body = { action: chosen.value, reason: reason.value };
      if (chosen.value === 'change') {
        if (select.value === '') { msg.textContent = 'Выберите новый ответ.'; return; }
        body.new_answer = opts[Number(select.value)][0];
      }
      save.disabled = true;
      save.textContent = 'Сохраняем…';
      try {
        await onResolve(appeal, body);
      } catch (e) {
        msg.textContent = errorText(e).replace(/\.?$/, '.') + (e && e.code === 'checklist_changed' ? ' Откройте диалог и оцените его заново.' : '');
        save.disabled = false;
        save.textContent = 'Сохранить решение';
      }
    });
    return root2;
  }

  // ---------- Было → Решение → Стало ----------
  function resultBlock(appeal) {
    const d = appeal.decision || {};
    const f = appeal.final || {};
    const box = (title, ...children) => el('div', { class: 'wds__box' }, el('div', { class: 'wds__title', text: title }), ...children);
    return el(
      'div',
      { class: 'ac__block' },
      el('h4', { text: 'Результат апелляции' }),
      el(
        'div',
        { class: 'wds' },
        box('Было', el('div', { class: 'wds__big', text: answerWithPoints(appeal.original.answer, appeal.original.points) })),
        el('div', { class: 'wds__arrow', text: '→' }),
        box(
          'Решение',
          el('div', { class: 'wds__big', text: d.action === 'change' ? 'Изменено' : 'Подтверждено' }),
          el('div', { class: 'wds__reason', text: d.reason || '' }),
          el('div', { class: 'ac__hint', text: fmtDateTime(d.decided_at) }),
        ),
        el('div', { class: 'wds__arrow', text: '→' }),
        box('Стало', el('div', { class: 'wds__big', text: answerWithPoints(f.answer, f.points) })),
      ),
      el('div', { class: 'wds__total' }, el('b', { text: 'Итог: ' }), `${totalText(appeal.total_before)} → ${totalText(appeal.total_after)}`),
    );
  }

  function show(appeal, conv, checklist) {
    const def = ((checklist && checklist.criteria) || []).find((c) => c.id === appeal.criterion_id);
    const isOpen = appeal.status === 'open';
    clear(root).append(
      el(
        'div',
        { class: 'ac' },
        el(
          'div',
          { class: 'rc__top' },
          el('div', { class: 'rc__title', text: `Апелляция ${appeal.id}` }),
          isOpen ? tag('открыта', 'tag--mock') : tag('решена', 'tag--ok'),
          tag(fmtDateTime(appeal.created_at)),
        ),
        el(
          'dl',
          { class: 'ac__facts' },
          el('dt', { text: 'Диалог' }),
          el(
            'dd',
            {},
            appeal.conversation_id, ' ',
            el('button', {
              type: 'button', class: 'btn btn--ghost btn--small', text: 'Открыть диалог',
              onclick: () => onOpenDialog(appeal.conversation_id, appeal.fragment ? appeal.fragment.from_turn : null),
            }),
          ),
          el('dt', { text: 'Критерий' }),
          el('dd', { text: (def && def.name) || appeal.criterion_id }),
          el('dt', { text: 'Исходная оценка' }),
          el('dd', { text: `${answerText(appeal.original.answer)}, баллы: ${typeof appeal.original.points === 'number' ? fmtNumber(appeal.original.points) : '—'}` }),
        ),
        el('div', { class: 'ac__block' }, el('h4', { text: 'Комментарий' }), el('blockquote', { class: 'ac__comment', text: appeal.comment })),
        fragmentBlock(appeal, conv),
        isOpen ? decisionForm(appeal, def) : resultBlock(appeal),
      ),
    );
    root.scrollTop = 0;
  }

  return {
    el: root,
    show,
    setLoading: (text = 'Загружаем апелляцию…') => clear(root).append(stateBox('loading', text)),
    setError: (text) => clear(root).append(stateBox('error', text)),
    setPlaceholder: (text) => clear(root).append(stateBox('empty', text)),
  };
}
