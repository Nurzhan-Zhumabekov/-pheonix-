import { validateChecklist } from './core.mjs';
import { $, amount, announce, api, button, el, labeled, notice, selectOptions } from './ui.mjs';

export function createEditor(onSaved) {
  let draft = null;
  let dirty = false;
  let saving = false;
  const version = $('checklist-version');
  const add = $('add-criterion');
  const save = $('save-checklist');
  const grid = $('criteria-editor');
  const status = $('editor-status');

  function summary() {
    const count = draft?.criteria.length ?? 0;
    const weight = draft?.criteria.reduce((sum, item) => sum + (Number.isFinite(item.weight) ? item.weight : 0), 0) ?? 0;
    $('editor-count').textContent = `Критериев: ${count}`;
    $('editor-summary').textContent = `Сумма весов: ${amount(weight)}${dirty ? ' · Есть несохранённые изменения' : ''}`;
    save.disabled = !draft || !dirty || saving;
    add.disabled = !draft || saving;
  }

  function changed() {
    dirty = true;
    notice(status);
    summary();
  }

  function criterionCard(item, index) {
    const title = el('h2', { text: item.name || `Критерий ${index + 1}` });
    const edit = (value, handler, options = {}) => {
      const field = el('input', { props: { value, ...options } });
      field.addEventListener('input', () => { handler(field.value); changed(); });
      return field;
    };
    const key = edit(item.id, v => { item.id = v.trim(); }, { maxLength: 60, required: true });
    const name = edit(item.name, v => { item.name = v; title.textContent = v || `Критерий ${index + 1}`; }, { maxLength: 150, required: true });
    const description = el('textarea', { props: { value: item.description, rows: 3, required: true } });
    description.addEventListener('input', () => { item.description = description.value; changed(); });
    const type = selectOptions([['binary', 'Да / Нет'], ['scale', 'Шкала'], ['flag', 'Флаг грубой ошибки']], item.type);
    const weight = edit(item.weight ?? '', v => { item.weight = v.trim() ? Number(v) : Number.NaN; }, { type: 'number', min: 0, step: 'any' });
    const section = selectOptions([['', 'Без секции'], ...draft.sections.map(s => [s.id, s.name])], item.section || '');
    section.addEventListener('change', () => { item.section = section.value || null; changed(); });
    const scale = edit(item.scale.join(', '), v => {
      item.scale = v.trim() ? v.split(/[,;\s]+/).filter(Boolean).map(Number) : [];
    }, { placeholder: '0, 4, 7, 10' });
    const scaleField = labeled('Ступени шкалы через запятую', scale, 'wide');
    const na = el('input', { props: { type: 'checkbox', checked: item.na_allowed } });
    const naField = el('label', { className: 'field check-field wide' }, na, el('span', { text: 'Разрешить N/A' }));
    const condition = edit(item.na_condition || '', v => { item.na_condition = v; }, { placeholder: 'Укажите, когда критерий неприменим' });
    const conditionField = labeled('Условие N/A', condition, 'wide');
    function syncType() {
      scaleField.hidden = item.type !== 'scale';
      weight.disabled = item.type === 'flag';
      naField.hidden = item.type === 'flag';
      conditionField.hidden = item.type === 'flag' || !item.na_allowed;
    }
    type.addEventListener('change', () => {
      item.type = type.value;
      if (item.type === 'scale' && !item.scale.length) { item.scale = [0, 5, 10]; scale.value = item.scale.join(', '); }
      if (item.type === 'flag') { item.weight = 0; weight.value = 0; item.na_allowed = false; na.checked = false; }
      syncType();
      changed();
    });
    na.addEventListener('change', () => { item.na_allowed = na.checked; syncType(); changed(); });
    syncType();
    const remove = button('Удалить', () => {
      draft.criteria.splice(index, 1);
      changed();
      render();
      (grid.children[index]?.querySelector('input') || add).focus();
    }, 'danger');
    remove.setAttribute('aria-label', `Удалить критерий ${item.name || index + 1}`);
    return el('article', { className: 'panel editor-card' },
      el('header', {}, title, remove),
      el('div', { className: 'field-grid' }, labeled('Название критерия', name), labeled('ID', key),
        labeled('Формулировка и правила оценки', description, 'wide'),
        labeled('Тип ответа', type), labeled('Вес', weight), labeled('Секция', section, 'wide'), scaleField, naField, conditionField));
  }

  function render() {
    grid.replaceChildren(...(draft?.criteria.map(criterionCard) || []));
    version.textContent = draft ? `Сохранена v${draft.version}` : 'Версия недоступна';
    summary();
  }

  function setChecklist(checklist, force = false) {
    if (dirty && !force) return;
    draft = {
      version: checklist.version,
      sections: checklist.sections || [],
      criteria: checklist.criteria.map(item => ({ ...item, description: item.description || '', scale: [...(item.scale || [])], section: item.section ?? null })),
    };
    dirty = false;
    render();
  }

  add.addEventListener('click', () => {
    let index = draft.criteria.length + 1;
    while (draft.criteria.some(item => item.id === `criterion_${index}`)) index += 1;
    draft.criteria.push({ id: `criterion_${index}`, name: '', description: '', type: 'binary', weight: 5, scale: [], na_allowed: false, na_condition: null, section: null });
    changed();
    render();
    grid.lastElementChild.querySelector('input').focus();
  });

  $('checklist-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!draft || saving || !dirty) return;
    const payload = {
      ...draft,
      criteria: draft.criteria.map(item => ({
        ...item,
        name: item.name.trim(), description: item.description.trim(),
        na_condition: item.na_allowed ? item.na_condition?.trim() || null : null,
        scale: item.type === 'scale' ? [...item.scale].sort((a, b) => a - b) : [],
      })),
    };
    const issue = validateChecklist(payload);
    if (issue) { notice(status, issue, 'error'); return; }
    saving = true;
    summary();
    grid.inert = true;
    try {
      const saved = await api('/checklist', { method: 'PUT', body: payload });
      setChecklist(saved, true);
      onSaved(saved);
      notice(status, `Версия ${saved.version} сохранена. Она будет применена при следующей оценке.`);
      announce(`Чек-лист версии ${saved.version} сохранён.`);
    } catch (error) {
      notice(status, `Не удалось сохранить чек-лист. ${error.message}`, 'error');
    } finally {
      saving = false;
      grid.inert = false;
      summary();
    }
  });

  return { setChecklist, failed: message => { version.textContent = 'Версия недоступна'; notice(status, message, 'error'); } };
}
