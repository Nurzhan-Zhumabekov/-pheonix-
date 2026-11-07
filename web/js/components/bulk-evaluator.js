// Компонент: массовая оценка («Оценить все»).
// createBulkEvaluator({ api, getTargets() -> { group, items: [{ id, evaluated }] }, onItemDone(id, evaluation) }) -> { el }
// До 3 запросов POST /api/evaluate одновременно; ошибки отдельных диалогов процесс не останавливают.
import { errorText } from '../api.js';
import { clear, el } from '../dom.js';

const CONCURRENCY = 3;

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function createBulkEvaluator({ api, getTargets, onItemDone }) {
  let running = false;
  const button = el('button', { type: 'button', class: 'btn btn--ghost btn--small', text: 'Оценить все', onclick: start });
  const panel = el('div', { class: 'bulk', hidden: true, role: 'status' });
  const root = el('div', { class: 'bulk-wrap' }, button, panel);

  function showMessage(text) {
    panel.hidden = false;
    clear(panel).append(el('div', { class: 'bulk__line', text }));
  }

  function start() {
    if (running) return;
    const { items } = getTargets();
    if (!items.length) {
      showMessage('Нет диалогов для оценки с текущими фильтрами.');
      return;
    }
    const already = items.filter((i) => i.evaluated).length;
    let text = `Оценить ${items.length} ${plural(items.length, 'диалог', 'диалога', 'диалогов')}?`;
    if (already) text += `\n\nИз них уже оценено: ${already}. Они будут оценены заново.`;
    if (!window.confirm(text)) return;
    run(items);
  }

  async function run(items) {
    running = true;
    button.disabled = true;
    button.textContent = 'Идёт оценка…';
    let next = 0;
    let done = 0;
    let stopped = false;
    const failures = [];

    const bar = el('i');
    const line = el('div', { class: 'bulk__line' });
    const stopBtn = el('button', {
      type: 'button', class: 'btn btn--ghost btn--small', text: 'Остановить',
      onclick: () => { stopped = true; stopBtn.disabled = true; stopBtn.textContent = 'Останавливаем…'; },
    });
    panel.hidden = false;
    clear(panel).append(line, el('div', { class: 'bulk__bar' }, bar), stopBtn);

    const paint = () => {
      line.textContent = `Выполнено ${done} из ${items.length}`;
      bar.style.width = `${(done / items.length) * 100}%`;
    };
    paint();

    async function worker() {
      while (!stopped && next < items.length) {
        const item = items[next];
        next += 1;
        try {
          const ev = await api.evaluate(item.id);
          try { onItemDone(item.id, ev); } catch { /* ошибка обновления списка не отменяет оценку */ }
        } catch (e) {
          failures.push({ id: item.id, code: e && e.code, message: errorText(e) });
        }
        done += 1;
        paint();
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));

    running = false;
    button.disabled = false;
    button.textContent = 'Оценить все';
    const ok = done - failures.length;
    const summary = el('div', {
      class: 'bulk__line',
      text: `${stopped ? 'Остановлено' : 'Готово'}: выполнено ${done} из ${items.length}. Успешно: ${ok}, с ошибкой: ${failures.length}.`,
    });
    clear(panel).append(summary);
    if (failures.length) {
      panel.append(
        el(
          'details',
          { open: true, class: 'bulk__errors' },
          el('summary', { text: `Ошибки (${failures.length})` }),
          el('ul', {}, failures.map((f) => el('li', { text: `${f.id}: ${f.message}${f.code ? ` (${f.code})` : ''}` }))),
        ),
      );
    }
    panel.append(el('button', { type: 'button', class: 'linkbtn', text: 'Закрыть', onclick: () => { panel.hidden = true; } }));
  }

  return { el: root };
}
