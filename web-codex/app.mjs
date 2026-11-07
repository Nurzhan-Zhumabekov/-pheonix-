import { audioOffset } from './core.mjs';
import { createEditor } from './editor.mjs';
import { createReview } from './review.mjs';
import { $, amount, announce, answerLabel, api, badge, button, channelLabel, el, empty, isCall, notice, pointsLabel, roleLabel } from './ui.mjs';

const state = {
  view: 'dialogs', group: 'dev', items: [], current: null, selection: null, evaluation: null, appeals: [],
  checklist: null, versions: new Map(), groupLoading: false, groupError: '', judging: null,
};
let groupRequest = 0;
let selectionRequest = 0;
let audio = null;
const versionRequests = new Map();

function displayChecklist(checklist) {
  state.checklist = checklist;
  state.versions.set(checklist.version, checklist);
  $('overview-version').textContent = `v${checklist.version}`;
  renderEvaluation();
}

const editor = createEditor(displayChecklist);
const getVersion = version => state.versions.get(version);
const review = createReview({ loadVersion, openConversation, refreshEvaluation });

async function loadVersion(version) {
  if (!Number.isInteger(version)) return undefined;
  if (state.versions.has(version)) return getVersion(version);
  if (!versionRequests.has(version)) {
    versionRequests.set(version, api(`/checklists/${version}`)
      .then(checklist => { state.versions.set(version, checklist); return checklist; })
      .catch(() => undefined)
      .finally(() => versionRequests.delete(version)));
  }
  return versionRequests.get(version);
}

function loadResultVersion(result) {
  if (!getVersion(result.checklist_version)) {
    void loadVersion(result.checklist_version).then(checklist => {
      if (checklist && state.evaluation === result) renderEvaluation();
    });
  }
}

function setView(view) {
  state.view = view;
  for (const section of ['dialogs', 'checklist', 'appeals']) $(section + '-view').hidden = section !== view;
  document.querySelectorAll('[data-view]').forEach(nav => {
    nav.classList.toggle('active', nav.dataset.view === view);
    if (nav.dataset.view === view) nav.setAttribute('aria-current', 'page');
    else nav.removeAttribute('aria-current');
  });
  $(view + '-title').focus({ preventScroll: true });
  if (view === 'appeals') void review.load();
  if (view === 'checklist' && !state.checklist) void loadChecklist();
}

async function loadChecklist() {
  try {
    const checklist = await api('/checklist');
    displayChecklist(checklist);
    editor.setChecklist(checklist);
  } catch (error) { editor.failed(`Не удалось загрузить чек-лист. ${error.message}`); }
}

async function loadHealth() {
  const health = $('health');
  try {
    await api('/health');
    health.className = 'health ready';
    health.lastElementChild.textContent = 'API подключён';
  } catch {
    health.className = 'health error';
    health.lastElementChild.textContent = 'API недоступен';
  }
}

function renderQueue() {
  const q = $('search').value.trim().toLowerCase();
  const language = $('language').value;
  const channel = $('channel').value;
  const filtered = state.items.filter(item => (!q || item.conversation_id.toLowerCase().includes(q)) &&
    (!language || item.language.toUpperCase() === language) && (!channel || (isCall(item.channel) ? 'call' : 'chat') === channel));
  $('overview-count').textContent = state.groupLoading && !state.items.length ? '—' : amount(state.items.length);
  const status = $('queue-state');
  status.classList.toggle('error', Boolean(state.groupError));
  status.textContent = state.groupLoading ? 'Загрузка набора…' : state.groupError ||
    (filtered.length ? `Показано ${filtered.length} из ${state.items.length}` : state.items.length ? 'По этим фильтрам диалогов нет.' : 'В наборе пока нет диалогов.');
  $('queue-list').replaceChildren(...filtered.map(item => {
    const node = el('button', { className: 'case', props: { type: 'button' }, attrs: { 'aria-pressed': String(item.conversation_id === state.selection) } },
      el('span', { className: 'case-icon', text: isCall(item.channel) ? '◖' : '≡', attrs: { 'aria-hidden': 'true' } }),
      el('span', { className: 'case-text' }, el('span', { className: 'case-name', text: item.conversation_id }),
        el('span', { className: 'case-meta', text: `${channelLabel(item.channel)} · ${item.language} · ${amount(item.turns)} репл.` })),
      item.evaluated ? el('span', { className: 'case-evaluated', text: '✓', attrs: { 'aria-label': 'Оценён' } }) : null);
    node.addEventListener('click', () => void selectConversation(item.conversation_id, item.evaluated));
    return el('li', {}, node);
  }));
}

function resetSelection() {
  selectionRequest += 1;
  state.selection = null;
  state.current = null;
  state.evaluation = null;
  state.appeals = [];
  notice($('transcript-status'));
  renderTranscript();
  renderEvaluation();
}

async function loadGroup(group = state.group, refresh = false) {
  const request = ++groupRequest;
  if (group !== state.group) {
    state.items = [];
    resetSelection();
  }
  state.group = group;
  state.groupLoading = true;
  state.groupError = '';
  document.querySelectorAll('[data-group]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.group === group)));
  $('refresh').disabled = true;
  renderQueue();
  const query = new URLSearchParams({ group });
  if (refresh) query.set('refresh', 'true');
  try {
    const data = await api('/conversations?' + query);
    if (request !== groupRequest) return;
    state.items = data.items;
    if (state.selection && !data.items.some(item => item.conversation_id === state.selection)) resetSelection();
  } catch (error) {
    if (request !== groupRequest) return;
    state.groupError = error.code === 'no_source'
      ? (group === 'control' ? 'Контрольный набор ещё не подключён.' : 'Набор DEV ещё не подключён.')
      : `Не удалось загрузить набор. ${error.message}`;
  } finally {
    if (request === groupRequest) {
      state.groupLoading = false;
      $('refresh').disabled = false;
      renderQueue();
    }
  }
}

async function selectConversation(id, evaluated = true) {
  const request = ++selectionRequest;
  state.selection = id;
  state.current = null;
  state.evaluation = null;
  state.appeals = [];
  renderQueue();
  renderTranscript(true);
  renderEvaluation();
  notice($('transcript-status'));
  try {
    const conversation = await api('/conversations/' + encodeURIComponent(id));
    if (request !== selectionRequest) return;
    state.current = conversation;
    renderTranscript();
    $('transcript-title').focus({ preventScroll: !matchMedia('(max-width: 680px)').matches });
    if (evaluated) await refreshEvaluation(id, request);
  } catch (error) {
    if (request !== selectionRequest) return;
    notice($('transcript-status'), `Не удалось открыть диалог. ${error.message}`, 'error');
    renderTranscript();
  }
}

async function refreshEvaluation(id, request = selectionRequest) {
  if (state.selection !== id) return;
  try {
    const encoded = encodeURIComponent(id);
    const [result, appeals] = await Promise.all([api('/evaluations/' + encoded), api('/appeals?conversation_id=' + encoded)]);
    if (request !== selectionRequest) return;
    state.evaluation = result;
    state.appeals = appeals;
    renderEvaluation();
    loadResultVersion(result);
  } catch (error) {
    if (request === selectionRequest && error.code !== 'no_evaluation') notice($('transcript-status'), `Не удалось обновить оценку. ${error.message}`, 'error');
  }
}

function openConversation(id) {
  setView('dialogs');
  void selectConversation(id);
}

function updateEvaluate() {
  const item = $('evaluate');
  const hasAppeal = state.appeals.some(appeal => appeal.status === 'open');
  item.disabled = !state.current || Boolean(state.judging) || hasAppeal;
  item.textContent = state.judging === state.selection && state.judging ? 'Оцениваем…' : state.evaluation ? 'Переоценить' : 'Оценить';
  item.title = hasAppeal ? 'Сначала рассмотрите открытую апелляцию.' : '';
}

async function evaluate() {
  const id = state.current?.conversation_id;
  if (!id || state.judging || state.appeals.some(appeal => appeal.status === 'open')) return;
  const request = selectionRequest;
  state.judging = id;
  notice($('transcript-status'), 'Оценка выполняется. Для длинного диалога может понадобиться больше времени.');
  renderEvaluation();
  try {
    const result = await api('/evaluate', { method: 'POST', body: { conversation_id: id } });
    const item = state.items.find(item => item.conversation_id === id);
    if (item) item.evaluated = true;
    renderQueue();
    if (request !== selectionRequest) {
      if (state.selection === id) await refreshEvaluation(id);
      return;
    }
    state.evaluation = result;
    loadResultVersion(result);
    notice($('transcript-status'), result.mock ? 'Сервер вернул демонстрационный результат.' : 'Оценка завершена.', result.mock ? 'warn' : '');
    announce(`Оценка диалога ${id} завершена.`);
  } catch (error) {
    if (request === selectionRequest) notice($('transcript-status'), `Оценка не завершена. ${error.message}`, 'error');
  } finally {
    state.judging = null;
    renderEvaluation();
  }
}

function validAudio(url) {
  try {
    const candidate = new URL(url, location.href);
    if (candidate.protocol === 'https:' || candidate.protocol === 'http:') return candidate.href;
  } catch { /* missing or invalid URL */ }
  return null;
}

function renderTranscript(loading = false) {
  const conversation = state.current;
  const title = $('transcript-title');
  const meta = $('transcript-meta');
  const body = $('transcript-body');
  const player = $('player');
  audio?.pause();
  audio = null;
  player.hidden = true;
  player.replaceChildren();
  body.setAttribute('aria-busy', String(loading));
  title.textContent = state.selection || 'Диалог';
  meta.hidden = !conversation;
  updateEvaluate();
  if (!conversation) {
    body.replaceChildren(loading ? empty('Загрузка диалога…', 'Получаем реплики и данные разговора.', '☰') : empty('Откройте диалог', 'Здесь появится транскрипт с исходными таймкодами.', '☰'));
    return;
  }
  const call = isCall(conversation.channel);
  const turns = conversation.transcript;
  meta.textContent = `${channelLabel(conversation.channel)} · ${conversation.language} · ${turns.length} репл.`;
  const source = call && conversation.audio_url ? validAudio(conversation.audio_url) : null;
  if (call) {
    const error = el('p', { className: 'muted player-message', attrs: { id: 'audio-message', role: 'status' }, props: { hidden: true } });
    if (source) {
      audio = el('audio', { props: { controls: true, preload: 'none', src: source }, attrs: { 'aria-label': 'Запись звонка' } });
      audio.addEventListener('error', () => { error.textContent = 'Запись не загрузилась. Проверьте доступ к источнику.'; error.hidden = false; });
    }
    const estimated = turns.some((_, index) => audioOffset(turns, index)?.approximate);
    player.append(el('strong', { text: 'Запись звонка' }), audio || el('p', { className: 'muted', text: 'Запись недоступна для этого диалога.' }),
      source && estimated ? el('p', { className: 'muted', text: 'Для ISO-таймкодов переход ориентировочный. Отсчёт ведётся от первой реплики.' }) : '', error);
    player.hidden = false;
  }
  body.replaceChildren(turns.length ? el('ol', { className: 'turns' }, ...turns.map((turn, index) => {
    const kind = ['operator', 'client', 'bot', 'system'].includes(turn.speaker) ? turn.speaker : '';
    const offset = audio ? audioOffset(turns, index) : null;
    const jump = offset ? el('button', { className: 'audio-seek', text: offset.approximate ? 'К записи ≈' : 'К записи', props: { type: 'button' }, attrs: { 'aria-label': `Перейти к записи: реплика ${index + 1}, ${turn.timestamp}${offset.approximate ? ', приблизительно' : ''}` } }) : null;
    jump?.addEventListener('click', () => seekAudio(offset.seconds));
    return el('li', { className: `turn ${kind}`, props: { tabIndex: -1 }, attrs: { id: `turn-${index}` } },
      el('header', {}, el('strong', { text: roleLabel(turn.speaker) }), el('time', { text: turn.timestamp })), el('p', { text: turn.text }), jump);
  })) : empty('Транскрипт пуст', 'У этого диалога нет реплик.', '☰'));
}

function seekAudio(seconds) {
  const target = audio;
  if (!target) return;
  const error = $('audio-message');
  const seek = () => {
    if (target !== audio) return;
    const showIssue = message => { error.textContent = message; error.hidden = false; };
    if (Number.isFinite(target.duration) && seconds > target.duration) {
      showIssue('Таймкод выходит за пределы записи.');
      return;
    }
    const seekable = Array.from({ length: target.seekable.length }, (_, index) =>
      target.seekable.start(index) <= seconds && seconds <= target.seekable.end(index));
    if (seconds !== target.currentTime && !seekable.includes(true)) {
      showIssue('Запись не поддерживает переход по этому таймкоду.');
      return;
    }
    error.hidden = true;
    target.currentTime = seconds;
    target.focus();
    target.scrollIntoView({ block: 'nearest' });
  };
  if (target.readyState >= target.HAVE_CURRENT_DATA) {
    seek();
  } else {
    const loading = Boolean(target.onloadeddata);
    target.onloadeddata = () => { target.onloadeddata = null; seek(); };
    if (!loading || target.error) {
      target.preload = 'auto';
      target.load();
    }
  }
}

function jumpToTurn(index) {
  const target = $(`turn-${index}`);
  if (!target) return;
  $('transcript-body').querySelector('.highlight')?.classList.remove('highlight');
  target.classList.add('highlight');
  target.scrollIntoView({ block: 'nearest' });
  target.focus({ preventScroll: true });
  announce(`Открыта реплика ${index + 1}.`);
}

function evidenceNode(evidence) {
  const turn = state.current?.transcript[evidence.turn_index];
  const exact = turn && typeof evidence.quote === 'string' && evidence.quote.trim() && turn.text.includes(evidence.quote);
  const title = `${evidence.role === 'expected_location' ? 'Ожидаемое место' : 'Доказательство'} · ${turn?.timestamp || evidence.timestamp || '—'}`;
  let label = 'Реплика не найдена.';
  if (turn) {
    if (exact) label = `«${evidence.quote}»`;
    else if (!evidence.quote && evidence.role === 'expected_location') label = 'Открыть место, где ожидалось действие.';
    else label = 'Цитата не совпала с транскриптом. Откройте реплику.';
  }
  const node = el(turn ? 'button' : 'div', { className: 'evidence', props: turn ? { type: 'button' } : {} }, el('strong', { text: title }), el('span', { text: label }));
  if (turn) node.addEventListener('click', () => jumpToTurn(evidence.turn_index));
  return node;
}

function renderEvaluation() {
  const body = $('evaluation-body');
  const version = $('result-version');
  const result = state.evaluation;
  const pending = Boolean(state.judging && state.judging === state.selection);
  body.setAttribute('aria-busy', String(pending));
  version.hidden = !result;
  updateEvaluate();
  if (!result) {
    body.replaceChildren(pending ? empty('Оценка выполняется…', 'Результаты появятся после проверки критериев.') : empty('Оценки пока нет', 'Запустите оценку, чтобы увидеть баллы, N/A и основания.'));
    return;
  }
  version.textContent = `v${result.checklist_version}`;
  const rubric = getVersion(result.checklist_version);
  const definition = id => rubric?.criteria.find(item => item.id === id);
  const gross = result.gross_error;
  const total = Number.isFinite(result.total);
  const score = el('div', { className: 'score-card' }, el('small', { text: 'Итог после перераспределения весов' }),
    el('div', { className: 'score-line' }, el('strong', { text: amount(result.total) }), el('span', { text: total ? '/ 100' : 'Нет применимых критериев с весом' })),
    total ? el('meter', { props: { min: 0, max: 100, value: result.total }, attrs: { 'aria-label': 'Итоговый балл' } }) : null);
  const sections = el('ul', { className: 'sections-scores', attrs: { 'aria-label': 'Баллы по секциям' } }, ...(result.sections || []).map(section =>
    el('li', {}, el('span', { text: rubric?.sections.find(item => item.id === section.id)?.name || section.id }), el('strong', { text: amount(section.score) }))));
  const cards = (result.criteria || []).map(item => {
    const name = definition(item.criterion_id)?.name || item.criterion_id;
    const kind = item.answer === 'yes' ? 'pass' : item.answer === 'no' ? 'fail' : '';
    const open = state.appeals.find(a => a.criterion_id === item.criterion_id && a.status === 'open');
    const latest = state.appeals.findLast(a => a.criterion_id === item.criterion_id && a.status === 'resolved');
    const evidence = item.evidence || [];
    const inspected = item.checked_range;
    return el('article', { className: 'criterion' },
      el('div', { className: 'criterion-title' }, el('h3', { text: name }), badge(answerLabel(item.answer), kind)),
      el('p', { className: 'muted', text: `Вес ${amount(item.weight)} · ${item.points == null ? 'вне расчёта' : `${pointsLabel(item.points)} до пересчёта`}` }),
      el('p', { className: 'reason', text: item.explanation || 'Обоснование отсутствует.' }),
      item.na_reason && item.na_reason !== item.explanation ? el('p', { className: 'muted', text: `Причина N/A: ${item.na_reason}` }) : null,
      ...evidence.map(evidenceNode),
      inspected ? button(`Проверены реплики ${inspected.from_turn + 1}–${inspected.to_turn + 1}`, () => jumpToTurn(inspected.from_turn), 'subtle') : null,
      !evidence.length && !inspected && item.answer !== 'na' ? el('p', { className: 'muted', text: 'Сервер не указал источник доказательства.' }) : null,
      latest ? el('p', { className: 'muted', text: `Апелляция: ${answerLabel(latest.original?.answer)} → ${answerLabel(latest.final?.answer)}. ${latest.decision?.reason || ''}` }) : null,
      open ? el('p', { className: 'muted', text: 'Апелляция на рассмотрении.' }) : button('Оспорить критерий', () => review.submit(result.conversation_id, item, name), 'subtle'));
  });
  const grossCard = gross ? el('article', { className: 'criterion' },
    el('div', { className: 'criterion-title' }, el('h3', { text: 'Грубая ошибка' }), badge(gross.flag ? 'Обнаружена' : 'Нет', gross.flag ? 'fail' : 'pass')),
    el('p', { className: 'muted', text: 'Отдельный флаг без веса' }), gross.explanation ? el('p', { className: 'reason', text: gross.explanation }) : null,
    ...(gross.evidence || []).map(evidenceNode)) : null;
  body.replaceChildren(...[
    result.mock ? el('p', { className: 'notice warn', text: 'Демонстрационный результат. Модель не использовалась.' }) : null,
    state.appeals.some(a => a.status === 'open') ? el('p', { className: 'notice warn' }, 'Есть открытая апелляция. ', button('К рассмотрению', () => setView('appeals'), 'subtle')) : null,
    score, sections, el('div', { className: 'criterion-list' }, ...cards, grossCard),
    result.model?.name ? el('p', { className: 'muted model-info', text: `${result.model.name} · Вызовов: ${amount(result.model.calls)}${result.model.cost_usd > 0 ? ` · $${result.model.cost_usd.toFixed(4)}` : ''}` }) : null,
  ].filter(Boolean));
}

document.querySelectorAll('[data-view]').forEach(node => node.addEventListener('click', () => setView(node.dataset.view)));
document.querySelectorAll('[data-group]').forEach(node => node.addEventListener('click', () => void loadGroup(node.dataset.group)));
$('search').addEventListener('input', renderQueue);
for (const id of ['language', 'channel']) $(id).addEventListener('change', renderQueue);
$('refresh').addEventListener('click', () => { void loadHealth(); void loadGroup(state.group, true); });
$('evaluate').addEventListener('click', () => void evaluate());
void loadHealth();
void loadChecklist();
void loadGroup();
