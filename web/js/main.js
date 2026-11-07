// Точка входа: собирает компоненты и связывает их между собой.
import { api, errorText } from './api.js';
import { createConversationHeader } from './components/conversation-header.js';
import { createConversationList } from './components/conversation-list.js';
import { createResultCard } from './components/result-card.js';
import { createTranscript } from './components/transcript.js';

const transcript = createTranscript();
const resultCard = createResultCard({ onEvidenceClick: (i) => transcript.scrollToTurn(i) });
const header = createConversationHeader({ onEvaluate: (id) => evaluate(id) });
const list = createConversationList({ api, onSelect: (id) => openConversation(id) });

document.getElementById('list-pane').append(list.el);
document.getElementById('center-pane').append(header.el, transcript.el);
document.getElementById('result-pane').append(resultCard.el);

let openToken = 0; // чтобы устаревший ответ не перезаписал текущий выбор
let currentId = null;

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

async function showEvaluation(ev) {
  resultCard.show(ev, await loadChecklistSafe());
}

async function openConversation(id) {
  const token = ++openToken;
  currentId = id;
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
  transcript.show(conv);

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

list.refresh();
