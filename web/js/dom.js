// Мини-помощники для DOM. Весь текст вставляется как текст (textContent / текстовые узлы),
// поэтому данные из API не могут внедрить разметку.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export function stateBox(kind, text) {
  const box = el('div', { class: `state state--${kind}` });
  if (kind === 'loading') box.append(el('span', { class: 'spinner' }));
  box.append(document.createTextNode(text));
  return box;
}

export function tag(text, extraClass = '') {
  return el('span', { class: `tag ${extraClass}`.trim(), text });
}

// Числа для показа (10.5 -> «10,5»). Метки времени этим не форматируются.
export function fmtNumber(n) {
  return typeof n === 'number' ? n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : '—';
}

export const CHANNELS = { 'agent chat': 'Чат', 'voice call': 'Звонок' };
export const channelLabel = (c) => CHANNELS[c] || c || '—';
