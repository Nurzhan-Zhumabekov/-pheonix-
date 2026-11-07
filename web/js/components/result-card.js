// Компонент: карточка результата оценки.
// createResultCard({ onEvidenceClick, onReevaluate, onAppeal(criterionId, comment), audioOffsetFor(evidence) -> сек|null, onSeekEvidence(evidence) }) -> { el, show(evaluation, checklist, appeals), setLoading(), setError(text), setPlaceholder(text) }
// Названия критериев и секций берутся из чек-листа (GET /api/checklist) по id.
import { clear, el, fmtNumber, stateBox, tag } from '../dom.js';
import { answerWithPoints } from '../format.js';
import { createAppealForm } from './appeal-form.js';

const ROLE_LABELS = { supports: 'Подтверждает', expected_location: 'Здесь ожидалось' };
const SPEAKERS = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };

function answerView(answer, def) {
  if (def && def.type === 'flag') {
    if (answer === 'yes') return { label: 'Нарушение', cls: 'pill--no' };
    if (answer === 'no') return { label: 'Нет нарушений', cls: 'pill--yes' };
  }
  if (answer === 'yes') return { label: 'Да', cls: 'pill--yes' };
  if (answer === 'no') return { label: 'Нет', cls: 'pill--no' };
  if (answer === 'na') return { label: 'N/A', cls: 'pill--na' };
  return { label: fmtNumber(Number(answer)), cls: 'pill--num' };
}

export function createResultCard({ onEvidenceClick, onReevaluate, onAppeal, audioOffsetFor, onSeekEvidence }) {
  const root = el('div', { class: 'pane__body' });

  function evidenceNode(ev) {
    const expected = ev.role === 'expected_location';
    const canSeek = typeof audioOffsetFor === 'function' && audioOffsetFor(ev) !== null;
    return el(
      'li',
      { class: 'ev__item' },
      el(
        'button',
        {
          type: 'button',
          class: `ev__btn${expected ? ' ev__btn--expected' : ''}`,
          title: 'Перейти к реплике в транскрипте',
          onclick: () => onEvidenceClick(ev.turn_index),
        },
        el(
          'div',
          { class: 'ev__head' },
          el('span', { class: 'ev__role', text: ROLE_LABELS[ev.role] || ev.role || '—' }),
          el('span', { text: `реплика #${ev.turn_index}` }),
          el('span', { text: SPEAKERS[ev.speaker] || ev.speaker || '' }),
          el('span', { text: ev.timestamp ?? '' }),
        ),
        el('div', { class: 'ev__quote', text: ev.quote ? `«${ev.quote}»` : '' }),
      ),
      canSeek
        ? el('button', {
            type: 'button',
            class: 'btn btn--ghost btn--small ev__seek',
            text: '▶ к записи',
            title: 'Перемотать запись и показать реплику',
            onclick: () => onSeekEvidence(ev),
          })
        : null,
    );
  }

  // appeals: апелляции именно по этому критерию этого диалога
  function criterionNode(c, def, appeals = []) {
    const view = answerView(c.answer, def);
    const name = (def && def.name) || c.criterion_id;
    const open = appeals.find((a) => a.status === 'open');
    const resolved = appeals.filter((a) => a.status === 'resolved').pop();
    const formSlot = el('div', { class: 'af-slot' });
    const disputeBtn = el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--small',
      text: 'Оспорить',
      disabled: !!open,
      title: open ? 'По этому критерию уже есть открытая апелляция' : 'Подать апелляцию',
      onclick: () => {
        if (formSlot.firstChild) { clear(formSlot); return; }
        const form = createAppealForm({
          criterionName: name, answer: c.answer, points: c.points, weight: c.weight,
          onSubmit: (comment) => onAppeal(c.criterion_id, comment),
          onCancel: () => clear(formSlot),
        });
        formSlot.append(form.el);
        form.focus();
      },
    });
    const range = c.checked_range;
    const hasPoints = typeof c.points === 'number';
    return el(
      'div',
      { class: 'crit' },
      el(
        'div',
        { class: 'crit__head' },
        el('div', { class: 'crit__name', text: name }),
        el('span', { class: `pill ${view.cls}`, text: view.label }),
        el('span', {
          class: 'crit__points',
          text: hasPoints ? `${fmtNumber(c.points)} / ${fmtNumber(c.weight)}` : `— / ${fmtNumber(c.weight)}`,
          title: 'Баллы / вес',
        }),
        disputeBtn,
      ),
      open ? el('div', { class: 'dispute dispute--open', text: 'Оспорено, ждёт решения' }) : null,
      resolved
        ? el('div', {
            class: 'dispute dispute--done',
            text: `Апелляция решена: было ${answerWithPoints(resolved.original.answer, resolved.original.points)}, стало ${answerWithPoints(resolved.final.answer, resolved.final.points)}`,
          })
        : null,
      formSlot,
      c.explanation ? el('p', { class: 'crit__text', text: c.explanation }) : null,
      c.na_reason
        ? el('div', { class: 'crit__note' }, el('b', { text: 'Причина N/A: ' }), c.na_reason)
        : null,
      range
        ? el(
            'div',
            { class: 'crit__note' },
            el('b', { text: 'Проверенный участок: ' }),
            `реплики #${range.from_turn}–#${range.to_turn} `,
            el('button', {
              type: 'button',
              class: 'linkbtn',
              text: 'показать начало',
              onclick: () => onEvidenceClick(range.from_turn),
            }),
          )
        : null,
      Array.isArray(c.evidence) && c.evidence.length
        ? el('ul', { class: 'ev' }, c.evidence.map(evidenceNode))
        : null,
    );
  }

  function totalBlock(ev, sectionNames) {
    const hasTotal = typeof ev.total === 'number';
    return el(
      'div',
      { class: 'total' },
      hasTotal
        ? el('div', { class: 'total__value' }, fmtNumber(ev.total), el('small', { text: 'из 100' }))
        : el('div', { class: 'total__empty', text: 'Итог не рассчитан' }),
      el(
        'div',
        { class: 'sections' },
        (ev.sections || []).map((s) => {
          const has = typeof s.score === 'number';
          return el(
            'div',
            {},
            el(
              'div',
              { class: 'sec__row' },
              el('span', { text: sectionNames.get(s.id) || s.id }),
              el('b', { text: has ? fmtNumber(s.score) : '—' }),
            ),
            has ? el('div', { class: 'sec__bar' }, el('i', { style: `width:${Math.max(0, Math.min(100, s.score))}%` })) : null,
          );
        }),
      ),
    );
  }

  function grossBlock(g) {
    const flagged = !!(g && g.flag);
    return el(
      'div',
      { class: `gross ${flagged ? 'gross--bad' : 'gross--ok'}` },
      el('div', { class: 'gross__title', text: flagged ? 'Выявлены грубые ошибки' : 'Грубых ошибок не выявлено' }),
      g && g.explanation ? el('div', { class: 'gross__text', text: g.explanation }) : null,
      flagged && Array.isArray(g.evidence) && g.evidence.length
        ? el('ul', { class: 'ev' }, g.evidence.map(evidenceNode))
        : null,
    );
  }

  // Оценка получена по более старой версии чек-листа, чем текущая.
  function staleHint(ev, checklist) {
    const current = checklist && checklist.version;
    if (typeof current !== 'number' || typeof ev.checklist_version !== 'number' || ev.checklist_version >= current) {
      return null;
    }
    return el('div', {
      class: 'stale',
      role: 'alert',
      text: `Результат получен по чек-листу версии ${ev.checklist_version}, текущая версия ${current}, оцените заново`,
    });
  }

  function show(ev, checklist, appeals = []) {
    const defs = new Map(((checklist && checklist.criteria) || []).map((c) => [c.id, c]));
    const sectionNames = new Map(((checklist && checklist.sections) || []).map((s) => [s.id, s.name]));
    const model = ev.model || {};
    clear(root).append(
      el(
        'div',
        { class: 'rc' },
        el(
          'div',
          { class: 'rc__top' },
          el('div', { class: 'rc__title', text: 'Результат оценки' }),
          ev.mock ? tag('mock', 'tag--mock') : null,
          ev.checklist_version != null ? tag(`чек-лист v${ev.checklist_version}`) : null,
          model.name ? tag(`модель: ${model.name}`) : null,
          el('button', { type: 'button', class: 'btn btn--ghost btn--small', text: 'Оценить заново', onclick: () => onReevaluate() }),
        ),
        staleHint(ev, checklist),
        totalBlock(ev, sectionNames),
        grossBlock(ev.gross_error),
        (ev.criteria || []).map((c) =>
          criterionNode(c, defs.get(c.criterion_id), appeals.filter((a) => a.criterion_id === c.criterion_id))),
      ),
    );
    root.scrollTop = 0;
  }

  return {
    el: root,
    show,
    setLoading: (text = 'Загружаем оценку…') => clear(root).append(stateBox('loading', text)),
    setError: (text) => clear(root).append(stateBox('error', text)),
    setPlaceholder: (text) => clear(root).append(stateBox('empty', text)),
  };
}
