export const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat('ru', { maximumFractionDigits: 2 });
export const amount = value => Number.isFinite(value) ? number.format(value) : '—';
const plurals = new Intl.PluralRules('ru');
const pointUnits = { one: 'балл', few: 'балла', many: 'баллов', other: 'балла' };
export const pointsLabel = value => `${amount(value)} ${pointUnits[plurals.select(value)]}`;
const answers = new Map([['yes', 'Да'], ['no', 'Нет'], ['na', 'N/A']]);
const roles = new Map([['operator', 'Оператор'], ['client', 'Клиент'], ['bot', 'Бот'], ['system', 'Система']]);
export const answerLabel = value => answers.get(value) ?? amount(value);
export const roleLabel = role => roles.get(role) ?? (role || 'Участник');
export const isCall = channel => String(channel).toLowerCase().includes('call') || String(channel).toLowerCase() === 'звонок';
export const channelLabel = channel => isCall(channel) ? 'Звонок' : 'Чат';
export const announce = message => { $('live').textContent = message; };

export function el(tag, options = {}, ...children) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.props) Object.assign(node, options.props);
  for (const [name, value] of Object.entries(options.attrs || {})) node.setAttribute(name, value);
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}

export function button(label, handler, variant = 'secondary', props = {}) {
  const node = el('button', { className: `button ${variant}`, text: label, props: { type: 'button', ...props } });
  if (handler) node.addEventListener('click', handler);
  return node;
}

export function badge(text, kind = '') {
  return el('span', { className: `chip ${kind}`.trim(), text });
}

export function empty(title, text, icon = '✓') {
  return el('div', { className: 'empty' },
    el('span', { className: 'empty-icon', text: icon, attrs: { 'aria-hidden': 'true' } }),
    el('h3', { text: title }), el('p', { text }));
}

export function notice(target, text = '', kind = '') {
  target.hidden = !text;
  target.classList.remove('error', 'warn');
  if (kind) target.classList.add(kind);
  target.textContent = text;
}

export function labeled(label, control, className = '') {
  return el('label', { className: `field ${className}`.trim() }, el('span', { text: label }), control);
}

export function selectOptions(items, selected) {
  const node = el('select');
  for (const [value, label] of items) node.add(el('option', { text: label, props: { value } }));
  if (selected !== undefined) node.value = selected;
  return node;
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(`/api${path}`, {
    method, signal, cache: 'no-store',
    headers: { Accept: 'application/json', ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok || payload === null) {
    const detail = payload?.error;
    const message = typeof detail?.message === 'string' ? detail.message.replace(/https?:\/\/[^\s"'<>]+/gi, '[адрес источника]') : '';
    const error = new Error(message || `Сервер вернул ответ ${response.status}.`);
    error.status = response.status;
    error.code = detail?.code;
    throw error;
  }
  return payload;
}

export function openModal(title, fields) {
  const dialog = $('dialog');
  if (dialog.open) dialog.close();
  const close = button('Закрыть', () => dialog.close(), 'subtle');
  $('modal-content').replaceChildren(
    el('header', { className: 'modal-head' }, el('h2', { text: title, attrs: { id: 'modal-title' } }), close),
    fields,
  );
  dialog.showModal();
  fields.querySelector('[data-focus]')?.focus();
  return dialog;
}
