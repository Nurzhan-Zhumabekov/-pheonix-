// Компонент: левая колонка со списком диалогов.
// createConversationList({ api, onSelect }) -> { el, refresh, markEvaluated, select(id) }
import { clear, channelLabel, el, stateBox, tag } from '../dom.js';
import { errorText } from '../api.js';

export function createConversationList({ api, onSelect }) {
  const state = { group: 'dev', items: [], lang: '', channel: '', query: '', selected: null, token: 0 };

  const groupButtons = ['dev', 'control'].map((g) =>
    el('button', {
      type: 'button',
      text: g,
      'aria-pressed': String(g === state.group),
      onclick: () => {
        if (state.group === g) return;
        state.group = g;
        groupButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === g)));
        refresh();
      },
    }),
  );

  const langSelect = el(
    'select',
    { class: 'field', 'aria-label': 'Язык', onchange: (e) => { state.lang = e.target.value; render(); } },
    el('option', { value: '', text: 'Все языки' }),
    ...['RU', 'KZ', 'EN'].map((l) => el('option', { value: l, text: l })),
  );
  const channelSelect = el(
    'select',
    { class: 'field', 'aria-label': 'Канал', onchange: (e) => { state.channel = e.target.value; render(); } },
    el('option', { value: '', text: 'Все каналы' }),
    el('option', { value: 'agent chat', text: 'Чат' }),
    el('option', { value: 'voice call', text: 'Звонок' }),
  );
  const search = el('input', {
    class: 'field cl__search',
    type: 'search',
    placeholder: 'Поиск по id',
    'aria-label': 'Поиск по id',
    oninput: (e) => { state.query = e.target.value.trim().toLowerCase(); render(); },
  });
  const count = el('div', { class: 'cl__count' });
  const body = el('div', { class: 'pane__body', style: 'padding:0' });

  const root = el(
    'div',
    { class: 'cl', style: 'display:flex;flex-direction:column;min-height:0;flex:1' },
    el(
      'div',
      { class: 'pane__head' },
      el('div', { class: 'seg', role: 'group', 'aria-label': 'Группа диалогов' }, groupButtons),
      el('div', { class: 'cl__filters' }, langSelect, channelSelect),
      search,
      count,
    ),
    body,
  );

  function visibleItems() {
    return state.items.filter(
      (c) =>
        (!state.lang || c.language === state.lang) &&
        (!state.channel || c.channel === state.channel) &&
        (!state.query || String(c.conversation_id).toLowerCase().includes(state.query)),
    );
  }

  function itemNode(c) {
    return el(
      'li',
      {},
      el(
        'button',
        {
          type: 'button',
          class: 'cl__item',
          dataset: { id: c.conversation_id },
          'aria-current': String(c.conversation_id === state.selected),
          onclick: () => select(c.conversation_id),
        },
        el('div', { class: 'cl__id', text: c.conversation_id }),
        el(
          'div',
          { class: 'cl__meta' },
          tag(channelLabel(c.channel)),
          tag(c.language || '—'),
          el('span', { text: `${c.turns_count} реплик` }),
          c.has_evaluation ? tag('оценён', 'tag--ok') : null,
        ),
      ),
    );
  }

  function render() {
    const shown = visibleItems();
    count.textContent = `Показано ${shown.length} из ${state.items.length}`;
    clear(body);
    if (!state.items.length) {
      body.append(stateBox('empty', 'В этой группе нет диалогов.'));
    } else if (!shown.length) {
      body.append(stateBox('empty', 'Ничего не найдено. Измените фильтры.'));
    } else {
      body.append(el('ul', { class: 'cl__list', style: 'list-style:none;margin:0;padding:0' }, shown.map(itemNode)));
    }
  }

  async function refresh() {
    const token = ++state.token;
    state.items = [];
    count.textContent = '';
    clear(body).append(stateBox('loading', 'Загружаем диалоги…'));
    try {
      const items = await api.listConversations(state.group);
      if (token !== state.token) return; // пришёл устаревший ответ
      state.items = Array.isArray(items) ? items : [];
      render();
    } catch (e) {
      if (token !== state.token) return;
      clear(body).append(stateBox('error', `Не удалось загрузить группу «${state.group}». ${errorText(e)}`));
    }
  }

  function select(id) {
    state.selected = id;
    body.querySelectorAll('.cl__item').forEach((b) =>
      b.setAttribute('aria-current', String(b.dataset.id === id)),
    );
    onSelect(id, state.group);
  }

  function markEvaluated(id) {
    const item = state.items.find((c) => c.conversation_id === id);
    if (item && !item.has_evaluation) {
      item.has_evaluation = true;
      render();
    }
  }

  return { el: root, refresh, markEvaluated, select };
}
