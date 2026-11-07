import { answerValues, buildLabel, labelCompletion } from './core.mjs';
import {
  $, announce, answerLabel, api, badge, button, channelLabel, el, empty,
  isCall, labeled, notice, roleLabel, selectOptions,
} from './ui.mjs';

const form = $('label-form');
const fields = $('label-fields');
const status = $('label-status');
const labels = new Map();
const checklists = new Map();
const controls = new Map();
let items = [];
let currentChecklist;
let selected = null;
let active = null;
let grossControl;
let loadingQueue = false;
let detailRequest = 0;
let dirty = false;
let saving = false;

function labelState(label) {
  if (!label) return { kind: 'unlabeled', text: 'Не размечен' };
  const checklist = checklists.get(label.checklist_version);
  if (!checklist) return { kind: 'partial', text: 'Метка сохранена' };
  const { filled, total } = labelCompletion(checklist, label);
  return filled === total
    ? { kind: 'complete', text: `Готово · ${filled}/${total}` }
    : { kind: 'partial', text: `Черновик · ${filled}/${total}` };
}

function renderQueue() {
  const search = $('label-search').value.trim().toLowerCase();
  const filter = $('label-filter').value;
  const list = items.filter(item => item.conversation_id.toLowerCase().includes(search) &&
    (filter === 'all' || labelState(labels.get(item.conversation_id)).kind === filter));
  $('label-loaded').textContent = `${items.filter(item => labels.has(item.conversation_id)).length} из ${items.length}`;
  $('label-queue-status').textContent = `Показано ${list.length} из ${items.length}`;
  $('label-queue').replaceChildren(...list.map(item => {
    const id = item.conversation_id;
    const mark = labels.get(id);
    const { kind, text } = labelState(mark);
    const row = button('', () => void openConversation(id), '', { disabled: saving });
    row.className = 'case label-case';
    row.setAttribute('aria-pressed', String(id === selected));
    row.append(el('span', { className: 'case-text' },
      el('strong', { className: 'case-name', text: id }),
      el('span', { className: 'case-meta', text: `${channelLabel(item.channel)} · ${item.language}` }),
      badge(text, kind === 'complete' ? 'pass' : kind === 'partial' ? 'warn' : ''),
      mark && mark.checklist_version !== currentChecklist?.version
        ? el('span', { className: 'case-meta', text: ` · v${mark.checklist_version}` }) : null));
    return el('li', {}, row);
  }));
}

async function getChecklist(version) {
  if (!checklists.has(version)) {
    const checklist = await api(`/checklists/${version}`);
    checklists.set(version, checklist);
  }
  return checklists.get(version);
}

function showTranscript(conversation) {
  $('label-transcript-title').textContent = conversation.conversation_id;
  $('label-transcript-meta').textContent = `${channelLabel(conversation.channel)} · ${conversation.language} · ${conversation.transcript.length} репл.`;
  const turns = el('ol', { className: 'turns' }, ...conversation.transcript.map((turn, index) => {
    const role = ['operator', 'client', 'bot', 'system'].includes(turn.speaker) ? turn.speaker : '';
    return el('li', { className: `turn ${role}` },
      el('header', {},
        el('strong', { text: `${index + 1}. ${roleLabel(turn.speaker)}` }),
        el('time', { text: turn.timestamp })),
      el('p', { text: turn.text }));
  }));
  const children = [conversation.transcript.length ? turns : empty('Транскрипт пуст', 'В этом диалоге нет реплик.')];
  if (isCall(conversation.channel) && conversation.audio_url) {
    const source = URL.canParse(conversation.audio_url, location.href)
      ? new URL(conversation.audio_url, location.href) : null;
    if (source && ['http:', 'https:'].includes(source.protocol)) {
      const player = el('audio', { props: { controls: true, preload: 'none', src: source.href },
        attrs: { 'aria-label': 'Запись звонка' } });
      children.unshift(el('div', { className: 'player' }, player));
    }
  }
  $('label-transcript').replaceChildren(...children);
}

function collectLabel() {
  const selections = new Map([...controls].map(([id, control]) => [id, control.value]));
  return buildLabel(active.checklist, selections, grossControl.value, $('labeler').value, $('label-note').value);
}

function showProgress() {
  const { filled, total } = labelCompletion(active.checklist, collectLabel());
  $('label-progress').textContent = `Заполнено ${filled} из ${total}${dirty ? ' · Есть несохранённые изменения' : ''}`;
}

function showForm(checklist, label) {
  $('label-version').textContent = `Чек-лист v${checklist.version}`;
  $('labeler').value = label?.labeler ?? '';
  $('label-note').value = label?.note ?? '';
  controls.clear();
  const cards = checklist.criteria.filter(criterion => criterion.type !== 'flag').map(criterion => {
    const values = answerValues(criterion).map(value => [String(value), answerLabel(value)]);
    const value = label?.answers?.[criterion.id];
    const input = selectOptions([['', 'Не размечено'], ...values], value === undefined ? '' : String(value));
    controls.set(criterion.id, input);
    return el('article', { className: 'label-criterion' },
      labeled(criterion.name, input),
      el('p', { className: 'muted', text: criterion.description }),
      criterion.na_allowed && criterion.na_condition
        ? el('p', { className: 'muted', text: `N/A — ${criterion.na_condition}` }) : null);
  });
  const flag = checklist.criteria.find(criterion => criterion.type === 'flag');
  grossControl = selectOptions([['', 'Не размечено'], ['true', 'Да'], ['false', 'Нет']],
    typeof label?.gross === 'boolean' ? String(label.gross) : '');
  cards.push(el('article', { className: 'label-criterion' },
    labeled('Грубая ошибка', grossControl),
    flag ? el('p', { className: 'muted', text: flag.description }) : null));
  $('label-criteria').replaceChildren(...cards);
  fields.disabled = false;
  showProgress();
}

function discardChanges() {
  return !dirty || window.confirm('Перейти без сохранения изменений?');
}

async function openConversation(id, focus = true) {
  if (saving || (id === selected && active) || !discardChanges()) return;
  const request = ++detailRequest;
  selected = id;
  active = null;
  dirty = false;
  fields.disabled = true;
  $('label-criteria').replaceChildren();
  $('labeler').value = '';
  $('label-note').value = '';
  $('label-version').textContent = 'Загрузка…';
  $('label-progress').textContent = '';
  $('label-transcript-title').textContent = id;
  $('label-transcript-meta').textContent = '';
  $('label-transcript').replaceChildren(empty('Загрузка диалога…', 'Получаем реплики из DEV.'));
  notice(status, 'Загружаем чек-лист и сохранённую метку…');
  renderQueue();

  const encoded = encodeURIComponent(id);
  try {
    const [conversation, label] = await Promise.all([
      api(`/conversations/${encoded}`),
      api(`/labels/${encoded}`).catch(error => {
        if (error.status === 404 && error.code === 'no_label') return null;
        throw error;
      }),
    ]);
    if (request !== detailRequest) return;
    showTranscript(conversation);
    const checklist = await getChecklist(label?.checklist_version ?? currentChecklist.version);
    if (request !== detailRequest) return;
    active = { id, checklist };
    if (label) labels.set(id, label);
    else labels.delete(id);
    showForm(checklist, label);
    renderQueue();
    const url = new URL(location.href);
    url.searchParams.set('id', id);
    history.replaceState(null, '', url);
    const historical = checklist.version !== currentChecklist.version;
    notice(status, historical ? `Метка использует исходный чек-лист v${checklist.version}. Текущая версия — v${currentChecklist.version}.` : '',
      historical ? 'warn' : '');
    if (focus) $('label-transcript-title').focus({ preventScroll: true });
  } catch (error) {
    if (request !== detailRequest) return;
    $('label-version').textContent = 'Разметка недоступна';
    notice(status, `Не удалось открыть метку. ${error.message}`, 'error');
  }
}

async function loadQueue() {
  if (loadingQueue || saving || !discardChanges()) return;
  loadingQueue = true;
  detailRequest++;
  selected = active = null;
  dirty = false;
  fields.disabled = true;
  $('label-criteria').replaceChildren();
  $('labeler').value = $('label-note').value = '';
  $('label-progress').textContent = 'Выберите диалог, чтобы начать';
  $('label-version').textContent = '—';
  $('label-transcript-title').textContent = 'Транскрипт';
  $('label-transcript-meta').textContent = '';
  $('label-transcript').replaceChildren(empty('Выберите диалог', 'Здесь появятся реплики с исходными таймкодами.'));
  $('label-reload').disabled = true;
  $('label-queue').replaceChildren();
  $('label-queue-status').classList.remove('error');
  $('label-queue-status').textContent = 'Загружаем набор DEV…';
  try {
    const [listing, saved, checklist] = await Promise.all([
      api('/conversations?group=dev'), api('/labels'), api('/checklist'),
    ]);
    items = listing.items;
    labels.clear();
    const versions = new Set();
    for (const item of items) {
      if (!Object.hasOwn(saved, item.conversation_id)) continue;
      const label = saved[item.conversation_id];
      labels.set(item.conversation_id, label);
      versions.add(label.checklist_version);
    }
    currentChecklist = checklist;
    checklists.clear();
    checklists.set(checklist.version, checklist);
    await Promise.allSettled([...versions].map(getChecklist));
    renderQueue();
    const requested = new URL(location.href).searchParams.get('id');
    const initial = items.find(item => item.conversation_id === requested) ?? items[0];
    if (initial) await openConversation(initial.conversation_id, false);
    else notice(status, 'В DEV нет диалогов для разметки.');
  } catch (error) {
    items = [];
    labels.clear();
    renderQueue();
    $('label-queue-status').classList.add('error');
    $('label-queue-status').textContent = `Не удалось загрузить DEV. ${error.message}`;
    notice(status, 'Обновите список после подключения DEV и API меток.', 'error');
  } finally {
    loadingQueue = false;
    $('label-reload').disabled = false;
  }
}

form.addEventListener('input', () => {
  if (!active || saving) return;
  dirty = true;
  showProgress();
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!active || saving || loadingQueue) return;
  const { id, checklist } = active;
  const payload = collectLabel();
  saving = true;
  fields.disabled = true;
  $('label-reload').disabled = true;
  renderQueue();
  notice(status, 'Сохраняем метку…');
  try {
    const saved = await api(`/labels/${encodeURIComponent(id)}`, { method: 'PUT', body: payload });
    labels.set(id, saved);
    dirty = false;
    $('labeler').value = saved.labeler;
    showProgress();
    notice(status, `Метка сохранена по чек-листу v${checklist.version}.`);
    announce('Метка сохранена.');
  } catch (error) {
    notice(status, `Метка не сохранена. ${error.message}`, 'error');
  } finally {
    saving = false;
    fields.disabled = false;
    $('label-reload').disabled = false;
    renderQueue();
  }
});

$('label-search').addEventListener('input', renderQueue);
$('label-filter').addEventListener('change', renderQueue);
$('label-reload').addEventListener('click', () => void loadQueue());
window.addEventListener('beforeunload', event => {
  if (dirty || saving) {
    event.preventDefault();
    event.returnValue = '';
  }
});

void loadQueue();
