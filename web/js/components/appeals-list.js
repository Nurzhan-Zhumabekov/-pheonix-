// Компонент: список апелляций (экран проверяющего, левая колонка).
// createAppealsList({ onSelect }) -> { el, setData(appeals, nameOf), setLoading(), setError(text), select(id), pin(id), selectedId() }
// pin(id): только что решённая апелляция остаётся в списке и подсвечена, даже если фильтр «Открытые».
import { clear, el, stateBox, tag } from '../dom.js';
import { fmtDateTime } from '../format.js';

const FILTERS = [['open', 'Открытые'], ['resolved', 'Решённые'], ['all', 'Все']];
const num = (id) => Number(String(id).replace(/\D/g, '')) || 0;

export function createAppealsList({ onSelect }) {
  const state = { filter: 'open', appeals: [], nameOf: (id) => id, selected: null, pinned: null };

  const buttons = FILTERS.map(([value, label]) =>
    el('button', {
      type: 'button',
      text: label,
      dataset: { filter: value },
      'aria-pressed': String(value === state.filter),
      onclick: () => {
        state.filter = value;
        state.pinned = null;
        render();
      },
    }),
  );
  const count = el('div', { class: 'cl__count' });
  const body = el('div', { class: 'pane__body', style: 'padding:0' });
  const root = el(
    'div',
    { style: 'display:flex;flex-direction:column;min-height:0;flex:1' },
    el('div', { class: 'pane__head' }, el('div', { class: 'seg', role: 'group', 'aria-label': 'Фильтр апелляций' }, buttons), count),
    body,
  );

  const matches = (a) => state.filter === 'all' || a.status === state.filter;

  function visible() {
    return state.appeals
      .filter((a) => matches(a) || a.id === state.pinned)
      .sort((x, y) => (x.status === y.status ? num(x.id) - num(y.id) : x.status === 'open' ? -1 : 1));
  }

  function item(a) {
    const isOpen = a.status === 'open';
    return el(
      'li',
      {},
      el(
        'button',
        {
          type: 'button',
          class: `cl__item${a.id === state.pinned ? ' al__item--done' : ''}`,
          dataset: { id: a.id },
          'aria-current': String(a.id === state.selected),
          onclick: () => select(a.id),
        },
        el(
          'div',
          { class: 'al__top' },
          el('span', { class: 'cl__id', text: a.id }),
          isOpen ? tag('открыта', 'tag--mock') : tag('решена', 'tag--ok'),
        ),
        el('div', { class: 'al__line', text: `Диалог: ${a.conversation_id}` }),
        el('div', { class: 'al__line', text: `Критерий: ${state.nameOf(a.criterion_id)}` }),
        el('div', { class: 'cl__meta', text: fmtDateTime(a.created_at) }),
      ),
    );
  }

  function render() {
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter)));
    const openCount = state.appeals.filter((a) => a.status === 'open').length;
    count.textContent = `Открытых: ${openCount} из ${state.appeals.length}`;
    const rows = visible();
    clear(body);
    if (!rows.length) {
      body.append(stateBox('empty', 'Апелляций нет'));
      return;
    }
    body.append(el('ul', { class: 'cl__list', style: 'list-style:none;margin:0;padding:0' }, rows.map(item)));
  }

  function select(id) {
    state.selected = id;
    if (state.pinned && state.pinned !== id) state.pinned = null;
    render();
    onSelect(id);
  }

  return {
    el: root,
    setData(appeals, nameOf) {
      state.appeals = appeals;
      if (nameOf) state.nameOf = nameOf;
      render();
    },
    setLoading: () => clear(body).append(stateBox('loading', 'Загружаем апелляции…')),
    setError: (text) => clear(body).append(stateBox('error', text)),
    select,
    clearPin() {
      if (state.pinned) { state.pinned = null; render(); }
    },
    pin(id) {
      state.pinned = id;
      state.selected = id;
      render();
    },
    selectedId: () => state.selected,
  };
}
