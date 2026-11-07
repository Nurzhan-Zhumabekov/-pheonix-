// Точка входа: собирает компоненты и связывает их между собой.
import { api, errorText } from './api.js';
import { createChecklistEditor } from './components/checklist-editor.js';
import { createAudioPlayer } from './components/audio-player.js';
import { createBulkEvaluator } from './components/bulk-evaluator.js';
import { computeOffsets } from './call-time.js';
import { createAppealCard } from './components/appeal-card.js';
import { createAppealsList } from './components/appeals-list.js';
import { createConversationHeader } from './components/conversation-header.js';
import { createConversationList } from './components/conversation-list.js';
import { createResultCard } from './components/result-card.js';
import { createTranscript } from './components/transcript.js';

const player = createAudioPlayer();
const transcript = createTranscript({ onSeek: (sec) => player.seek(sec) });
const resultCard = createResultCard({
  onEvidenceClick: (i) => transcript.scrollToTurn(i),
  onReevaluate: () => currentId && evaluate(currentId),
  onAppeal: submitAppeal,
  audioOffsetFor: evidenceOffset,
  onSeekEvidence: (e) => {
    const sec = evidenceOffset(e);
    if (sec !== null) player.seek(sec);
    transcript.scrollToTurn(e.turn_index);
  },
});
const header = createConversationHeader({ onEvaluate: (id) => evaluate(id) });
const list = createConversationList({ api, onSelect: (id) => openConversation(id) });
const bulk = createBulkEvaluator({
  api,
  getTargets: () => list.getTargets(),
  onItemDone: (id, ev) => {
    list.markEvaluated(id);
    if (id === currentId) {
      header.setHasEvaluation(true);
      showEvaluation(ev);
    }
  },
});
list.head.append(bulk.el);

// Для звонка с записью: смещение реплики в аудио (ММ:СС считается в call-time.js).
let currentConv = null;
let currentOffsets = null;
function evidenceOffset(e) {
  if (!currentConv || currentConv.channel !== 'voice call' || !currentConv.audio_url) return null;
  if (typeof e.audio_offset_sec === 'number') return e.audio_offset_sec;
  const o = currentOffsets && currentOffsets[e.turn_index];
  return typeof o === 'number' ? o : null;
}

const editor = createChecklistEditor({ api, onSaved: () => refreshResult() });
const appealsList = createAppealsList({ onSelect: (id) => selectAppeal(id) });
const appealCard = createAppealCard({
  onOpenDialog: (convId, turn) => openDialogFromReview(convId, turn),
  onResolve: resolveAppeal,
});

// ---- навигация между разделами: оба раздела остаются в DOM, поэтому состояние не теряется ----
const views = {
  dialogs: document.getElementById('view-dialogs'),
  review: document.getElementById('view-review'),
  checklist: document.getElementById('view-checklist'),
};
const navButtons = {};
const NAV = [['dialogs', 'Диалоги'], ['review', 'Проверка'], ['checklist', 'Чек-лист']];
const nav = document.getElementById('nav');
NAV.forEach(([name, label]) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.append(document.createTextNode(label));
  b.addEventListener('click', () => showView(name));
  navButtons[name] = b;
  nav.append(b);
});

// Бургер-меню (до 600px): кнопки разделов лежат в раскрывающейся панели.
const navToggle = document.getElementById('nav-toggle');
function setMenu(open) {
  nav.classList.toggle('nav--open', open);
  navToggle.setAttribute('aria-expanded', String(open));
}
navToggle.addEventListener('click', () => setMenu(!nav.classList.contains('nav--open')));
document.addEventListener('click', (e) => {
  if (!nav.contains(e.target) && !navToggle.contains(e.target)) setMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setMenu(false);
});
window.matchMedia('(min-width: 601px)').addEventListener('change', (e) => {
  if (e.matches) setMenu(false);
});

// Счётчик открытых апелляций на ярлыке «Проверка».
const badge = document.createElement('span');
badge.className = 'nav__badge';
badge.hidden = true;
navButtons.review.append(badge);
function setOpenCount(n) {
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

function showView(name) {
  setMenu(false);
  Object.entries(views).forEach(([n, node]) => { node.hidden = n !== name; });
  Object.entries(navButtons).forEach(([n, b]) => {
    if (n === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (name === 'checklist') editor.load();
  else if (name === 'review') loadReview();
  else refreshResult(); // версия чек-листа могла измениться
}

document.getElementById('view-checklist').append(editor.el);
document.getElementById('list-pane').append(list.el);
document.getElementById('center-pane').append(header.el, player.el, transcript.el);
document.getElementById('result-pane').append(resultCard.el);
document.getElementById('appeals-list-pane').append(appealsList.el);
document.getElementById('appeal-card-pane').append(appealCard.el);
appealCard.setPlaceholder('Выберите апелляцию в списке слева.');

let openToken = 0; // чтобы устаревший ответ не перезаписал текущий выбор
let currentId = null;
let pendingScroll = null; // {id, turn}: прокрутить транскрипт после открытия диалога из «Проверки»
let lastEvaluation = null; // результат, показанный сейчас, чтобы перерисовать его при смене чек-листа

transcript.setPlaceholder('Выберите диалог в списке слева.');
resultCard.setPlaceholder('Здесь появится результат оценки.');

// Названия критериев берём из чек-листа; если он недоступен, покажем id.
async function loadChecklistSafe() {
  try {
    return await api.getChecklist();
  } catch {
    return null;
  }
}

async function loadDialogAppealsSafe(conversationId) {
  try {
    return await api.listAppeals(conversationId);
  } catch {
    return [];
  }
}

async function showEvaluation(ev) {
  lastEvaluation = ev;
  const [checklist, appeals] = await Promise.all([loadChecklistSafe(), loadDialogAppealsSafe(ev.conversation_id)]);
  if (lastEvaluation === ev) resultCard.show(ev, checklist, appeals);
}

async function refreshResult() {
  if (lastEvaluation) await showEvaluation(lastEvaluation);
}

async function openConversation(id) {
  const token = ++openToken;
  currentId = id;
  lastEvaluation = null;
  currentConv = null;
  currentOffsets = null;
  player.hide();
  header.hide();
  transcript.setLoading();
  resultCard.setPlaceholder('Здесь появится результат оценки.');

  let conv;
  try {
    conv = await api.getConversation(id);
  } catch (e) {
    if (token !== openToken) return;
    transcript.setError(`Не удалось загрузить диалог. ${errorText(e)}`);
    return;
  }
  if (token !== openToken) return;
  currentConv = conv;
  currentOffsets = conv.channel === 'voice call' ? computeOffsets(conv.transcript || []) : null;
  player.show(conv);
  transcript.show(conv);
  if (pendingScroll !== null && pendingScroll.id === id) {
    const turn = pendingScroll.turn;
    pendingScroll = null;
    if (turn !== null) setTimeout(() => transcript.scrollToTurn(turn), 80);
  }

  // Уже есть оценка? 404 «оценки нет» — это не ошибка.
  resultCard.setLoading();
  try {
    const ev = await api.getEvaluation(id);
    if (token !== openToken) return;
    header.show(conv, true);
    await showEvaluation(ev);
  } catch (e) {
    if (token !== openToken) return;
    header.show(conv, false);
    if (e && e.status === 404) {
      resultCard.setPlaceholder('Диалог ещё не оценён. Нажмите «Оценить».');
    } else {
      resultCard.setError(`Не удалось загрузить оценку. ${errorText(e)}`);
    }
  }
}

async function evaluate(id) {
  const token = openToken;
  header.setBusy(true);
  resultCard.setLoading('Оцениваем диалог…');
  try {
    const ev = await api.evaluate(id);
    list.markEvaluated(id);
    if (token !== openToken || id !== currentId) return; // пользователь уже открыл другой диалог
    header.setHasEvaluation(true);
    await showEvaluation(ev);
  } catch (e) {
    if (token !== openToken) return;
    resultCard.setError(`Не удалось оценить диалог. ${errorText(e)}`);
  } finally {
    if (token === openToken) header.setBusy(false);
  }
}

// ---------- подача апелляции ----------
async function submitAppeal(criterionId, comment) {
  await api.createAppeal({ conversation_id: currentId, criterion_id: criterionId, comment });
  // форма закрывается перерисовкой карточки: апелляции диалога загружаются заново
  await refreshResult();
  refreshAppealsAll().catch(() => {});
}

// ---------- экран проверяющего ----------
let allAppeals = [];
let reviewToken = 0;
let checklistNames = new Map();
const convCache = new Map();

const nameOf = (id) => checklistNames.get(id) || id;

async function refreshAppealsAll() {
  const appeals = await api.listAppeals();
  allAppeals = appeals;
  setOpenCount(appeals.filter((a) => a.status === 'open').length);
  return appeals;
}

async function loadReview() {
  appealsList.clearPin();
  appealsList.setLoading();
  try {
    const [appeals, checklist] = await Promise.all([refreshAppealsAll(), loadChecklistSafe()]);
    checklistNames = new Map(((checklist && checklist.criteria) || []).map((c) => [c.id, c.name]));
    appealsList.setData(appeals, nameOf);
  } catch (e) {
    appealsList.setError(`Не удалось загрузить апелляции. ${errorText(e)}`);
  }
}

async function selectAppeal(id) {
  const token = ++reviewToken;
  const appeal = allAppeals.find((a) => a.id === id);
  if (!appeal) return;
  appealCard.setLoading();
  try {
    let conv = convCache.get(appeal.conversation_id);
    if (!conv) {
      try {
        conv = await api.getConversation(appeal.conversation_id);
        convCache.set(appeal.conversation_id, conv);
      } catch (e) {
        if (e && e.code === 'network') throw e;
        conv = null; // диалога нет: карточка покажет апелляцию без фрагмента
      }
    }
    const checklist = await loadChecklistSafe();
    if (token !== reviewToken) return;
    appealCard.show(appeal, conv, checklist);
  } catch (e) {
    if (token !== reviewToken) return;
    appealCard.setError(`Не удалось загрузить апелляцию. ${errorText(e)}`);
  }
}

async function resolveAppeal(appeal, body) {
  const resolved = await api.resolveAppeal(appeal.id, body); // ошибки уходят в форму решения
  // обновляем список, счётчик и (если этот диалог открыт) оценку и метки в «Диалогах»
  try {
    appealsList.setData(await refreshAppealsAll(), nameOf);
  } catch {
    allAppeals = allAppeals.map((a) => (a.id === resolved.id ? resolved : a));
    setOpenCount(allAppeals.filter((a) => a.status === 'open').length);
    appealsList.setData(allAppeals, nameOf);
  }
  appealsList.pin(resolved.id);
  await selectAppeal(resolved.id);
  if (currentId === resolved.conversation_id) {
    try {
      await showEvaluation(await api.getEvaluation(currentId));
    } catch {
      /* оценка обновится при следующем открытии диалога */
    }
  }
}

function openDialogFromReview(convId, turn) {
  showView('dialogs');
  if (currentId === convId && lastEvaluation !== null) {
    if (turn !== null) transcript.scrollToTurn(turn);
    return;
  }
  pendingScroll = { id: convId, turn };
  list.select(convId);
}

showView('dialogs');
list.refresh();
refreshAppealsAll().catch(() => {}); // только для счётчика на ярлыке
