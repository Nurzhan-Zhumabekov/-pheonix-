// Компонент: редактор чек-листа.
// createChecklistEditor({ api, onSaved }) -> { el, load(), isDirty() }
// Правки живут в локальном черновике; на сервер уходят целиком через PUT /api/checklist.
import { errorText } from '../api.js';
import { clear, el, fmtNumber, stateBox, tag } from '../dom.js';

const TYPES = [
  ['binary', 'binary (Да/Нет)'],
  ['scale', 'scale (шкала)'],
  ['flag', 'flag (флаг без баллов)'],
];

function toDraft(server) {
  return {
    version: server.version,
    sections: (server.sections || []).map((s) => ({ id: s.id, name: s.name })),
    criteria: (server.criteria || []).map((c) => ({
      id: c.id,
      name: c.name ?? '',
      description: c.description ?? '',
      type: c.type,
      weight: c.weight,
      na_allowed: !!c.na_allowed,
      section: c.section ?? null,
      // текст полей ввода храним как набрано, чтобы не терять промежуточные значения
      _weightText: String(c.weight ?? ''),
      _scaleText: Array.isArray(c.scale) ? c.scale.join(', ') : '',
      _naText: c.na_condition ?? '',
    })),
  };
}

function snapshot(draft) {
  return JSON.stringify({
    s: draft.sections.map((s) => [s.id, s.name]),
    c: draft.criteria.map((c) => [
      c.id, c.name, c.description, c.type, c._weightText,
      c.type === 'scale' ? c._scaleText : null,
      c.na_allowed, c.na_allowed ? c._naText : null, c.section,
    ]),
  });
}

function parseNumber(text) {
  const t = String(text).trim().replace(',', '.');
  return t === '' ? NaN : Number(t);
}

export function createChecklistEditor({ api, onSaved }) {
  let draft = null;
  let savedSnap = '';
  let saving = false;
  let focusId = null; // id критерия, к которому прокрутить после перерисовки

  const root = el('div', { class: 'ce' });
  const bar = el('div', { class: 'ce__bar' });
  const body = el('div', { class: 'ce__body' });
  root.append(bar, body);

  // элементы панели
  const versionTag = el('span', { class: 'ce__title' });
  const dirtyTag = tag('Есть несохранённые изменения', 'tag--dirty');
  const sumHint = el('div', { class: 'ce__hint' });
  const msg = el('span', { class: 'ce__msg', role: 'status' });
  const addBtn = el('button', { type: 'button', class: 'btn btn--ghost', text: 'Добавить критерий', onclick: addCriterion });
  const saveBtn = el('button', { type: 'button', class: 'btn', text: 'Сохранить', onclick: save });
  bar.append(
    el('div', { class: 'ce__row' }, versionTag, dirtyTag, addBtn, saveBtn),
    el('div', { class: 'ce__row' }, msg),
    sumHint,
  );

  function setMsg(kind, text) {
    msg.className = `ce__msg${kind ? ` ce__msg--${kind}` : ''}`;
    msg.textContent = text || '';
  }

  const isDirty = () => !!draft && snapshot(draft) !== savedSnap;

  function updateMeta() {
    dirtyTag.hidden = !isDirty();
    if (!draft) return;
    versionTag.textContent = `Версия чек-листа: ${draft.version}`;
    const sum = draft.criteria
      .filter((c) => c.type !== 'flag')
      .reduce((acc, c) => {
        const w = parseNumber(c._weightText);
        return Number.isFinite(w) ? acc + w : acc;
      }, 0);
    sumHint.textContent =
      `Сумма весов баллируемых критериев (без flag): ${fmtNumber(sum)}. ` +
      'Это только подсказка: сумма не обязана быть 100, итог нормируется.';
  }

  function touch() {
    setMsg('', '');
    updateMeta();
  }

  // ---------- действия ----------
  function addCriterion() {
    if (!draft) return;
    let n = 1;
    const ids = new Set(draft.criteria.map((c) => c.id));
    while (ids.has(`custom_${n}`)) n += 1;
    const id = `custom_${n}`;
    draft.criteria.push({
      id, name: 'Новый критерий', description: '', type: 'binary', weight: 0,
      na_allowed: false, section: draft.sections.length ? draft.sections[0].id : null,
      _weightText: '0', _scaleText: '', _naText: '',
    });
    focusId = id;
    setMsg('', '');
    render();
  }

  function removeCriterion(c) {
    if (!window.confirm(`Удалить критерий «${c.name || c.id}»?`)) return;
    draft.criteria = draft.criteria.filter((x) => x !== c);
    setMsg('', '');
    render();
  }

  function move(c, dir) {
    const list = draft.criteria;
    const i = list.indexOf(c);
    let j = i + dir;
    while (j >= 0 && j < list.length && list[j].section !== c.section) j += dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setMsg('', '');
    render();
  }

  function buildPayload() {
    const errors = [];
    const criteria = draft.criteria.map((c) => {
      const label = `«${c.name || c.id}»`;
      let weight = c.type === 'flag' ? 0 : parseNumber(c._weightText);
      if (!Number.isFinite(weight)) {
        errors.push(`Критерий ${label}: вес должен быть числом`);
        weight = 0;
      }
      let scale = null;
      if (c.type === 'scale') {
        const parts = c._scaleText.split(/[;,\s]+/).filter(Boolean).map((x) => Number(x.replace(',', '.')));
        if (parts.some((x) => !Number.isFinite(x))) {
          errors.push(`Критерий ${label}: шкала — числа через запятую, например 0, 5, 10`);
        }
        scale = parts;
      }
      return {
        id: c.id, name: c.name, description: c.description, type: c.type, scale, weight,
        na_allowed: c.na_allowed, na_condition: c.na_allowed ? c._naText : null, section: c.section,
      };
    });
    return { errors, payload: { version: draft.version, sections: draft.sections, criteria } };
  }

  async function save() {
    if (!draft || saving) return;
    const { errors, payload } = buildPayload();
    if (errors.length) {
      setMsg('err', errors.join('; '));
      return;
    }
    saving = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Сохраняем…';
    setMsg('', '');
    try {
      const saved = await api.saveChecklist(payload);
      setDraft(saved);
      render();
      setMsg('ok', `Сохранено, версия ${saved.version}`);
      onSaved(saved);
    } catch (e) {
      setMsg('err', errorText(e)); // черновик остаётся как был
    } finally {
      saving = false;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Сохранить';
    }
  }

  // ---------- отрисовка ----------
  function field(label, control, cls = '') {
    return el('label', { class: `fld ${cls}`.trim() }, el('span', { text: label }), control);
  }

  function criterionCard(c, index, siblings) {
    const isFlag = c.type === 'flag';
    const first = index === 0;
    const last = index === siblings.length - 1;

    const weight = el('input', {
      class: 'field', type: 'number', step: 'any', value: isFlag ? '0' : c._weightText, disabled: isFlag,
      'aria-label': 'Вес',
      oninput: (e) => { c._weightText = e.target.value; touch(); },
    });
    const naText = el('input', {
      class: 'field', type: 'text', value: c._naText, disabled: !c.na_allowed, 'aria-label': 'Условие N/A',
      placeholder: c.na_allowed ? 'Когда критерий неприменим' : 'N/A не разрешён',
      oninput: (e) => { c._naText = e.target.value; touch(); },
    });
    const naCheck = el('input', {
      type: 'checkbox', checked: c.na_allowed, disabled: isFlag,
      onchange: (e) => { c.na_allowed = e.target.checked; naText.disabled = !c.na_allowed; touch(); },
    });
    if (c.na_allowed) naCheck.checked = true;

    const sectionSelect = el(
      'select',
      {
        class: 'field', 'aria-label': 'Секция',
        onchange: (e) => { c.section = e.target.value || null; setMsg('', ''); render(); },
      },
      c.section === null ? el('option', { value: '', text: '— без секции —' }) : null,
      ...draft.sections.map((s) => el('option', { value: s.id, text: s.name || s.id })),
    );
    sectionSelect.value = c.section ?? '';

    const typeSelect = el(
      'select',
      {
        class: 'field', 'aria-label': 'Тип',
        onchange: (e) => {
          c.type = e.target.value;
          if (c.type === 'flag') { c.weight = 0; c._weightText = '0'; c.na_allowed = false; }
          setMsg('', '');
          render();
        },
      },
      ...TYPES.map(([v, t]) => el('option', { value: v, text: t })),
    );
    typeSelect.value = c.type;

    return el(
      'div',
      { class: 'cc', dataset: { cid: c.id } },
      el(
        'div',
        { class: 'cc__top' },
        el('span', { class: 'cc__id', text: `id: ${c.id}` }),
        el('button', { type: 'button', class: 'btn btn--ghost btn--small', text: '↑', title: 'Выше', disabled: first, onclick: () => move(c, -1) }),
        el('button', { type: 'button', class: 'btn btn--ghost btn--small', text: '↓', title: 'Ниже', disabled: last, onclick: () => move(c, 1) }),
        el('button', { type: 'button', class: 'btn btn--ghost btn--small btn--danger', text: 'Удалить критерий', onclick: () => removeCriterion(c) }),
      ),
      field('Название', el('input', {
        class: 'field', type: 'text', value: c.name, 'aria-label': 'Название',
        oninput: (e) => { c.name = e.target.value; touch(); },
      })),
      field('Описание', el('textarea', {
        class: 'field', rows: 3, 'aria-label': 'Описание', text: c.description,
        oninput: (e) => { c.description = e.target.value; touch(); },
      })),
      el(
        'div',
        { class: 'cc__row' },
        field('Тип', typeSelect),
        field('Вес', weight, 'fld--w'),
        c.type === 'scale'
          ? field('Шкала (числа через запятую)', el('input', {
              class: 'field', type: 'text', value: c._scaleText, placeholder: '0, 5, 10, 15, 20', 'aria-label': 'Шкала',
              oninput: (e) => { c._scaleText = e.target.value; touch(); },
            }), 'fld--grow')
          : null,
        field('Секция', sectionSelect, 'fld--grow'),
      ),
      el(
        'div',
        { class: 'cc__row' },
        el('label', { class: 'fld--check' }, naCheck, 'N/A разрешён'),
        field('Условие N/A', naText, 'fld--grow'),
      ),
    );
  }

  function sectionBlock(section, criteria) {
    return el(
      'section',
      { class: 'cs' },
      el(
        'div',
        { class: 'cs__head' },
        section
          ? [
              el('label', { for: `sec-${section.id}`, text: 'Секция' }),
              el('input', {
                id: `sec-${section.id}`, class: 'field cs__name', type: 'text', value: section.name,
                oninput: (e) => { section.name = e.target.value; touch(); },
              }),
            ]
          : el('div', { class: 'cs__name', text: 'Без секции' }),
      ),
      criteria.length
        ? el('div', { class: 'cs__list' }, criteria.map((c, i) => criterionCard(c, i, criteria)))
        : el('div', { class: 'cs__empty', text: 'В этой секции пока нет критериев.' }),
    );
  }

  function render() {
    const scroll = body.scrollTop;
    clear(body);
    const known = new Set(draft.sections.map((s) => s.id));
    draft.sections.forEach((s) => {
      body.append(sectionBlock(s, draft.criteria.filter((c) => c.section === s.id)));
    });
    const orphans = draft.criteria.filter((c) => !known.has(c.section));
    if (orphans.length) body.append(sectionBlock(null, orphans));
    body.scrollTop = scroll;
    if (focusId) {
      const card = body.querySelector(`[data-cid="${focusId}"]`);
      if (card) {
        card.scrollIntoView({ block: 'center' });
        const input = card.querySelector('input[aria-label="Название"]');
        if (input) { input.focus(); input.select(); }
      }
      focusId = null;
    }
    updateMeta();
  }

  function setDraft(server) {
    draft = toDraft(server);
    savedSnap = snapshot(draft);
  }

  async function load() {
    if (isDirty()) return; // не затираем несохранённые правки
    clear(body).append(stateBox('loading', 'Загружаем чек-лист…'));
    try {
      setDraft(await api.getChecklist());
      setMsg('', '');
      render();
    } catch (e) {
      draft = null;
      clear(body).append(
        stateBox('error', `Не удалось загрузить чек-лист. ${errorText(e)}`),
        el('button', { type: 'button', class: 'btn btn--ghost', text: 'Повторить', onclick: load }),
      );
    }
  }

  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  dirtyTag.hidden = true;
  return { el: root, load, isDirty };
}
