import { answerValues } from './core.mjs';
import { $, amount, announce, answerLabel, api, badge, button, el, empty, labeled, notice, openModal, pointsLabel, roleLabel, selectOptions } from './ui.mjs';

const errorMessage = () => el('p', { className: 'notice', props: { hidden: true }, attrs: { role: 'status' } });

function pair(title, value) {
  return el('div', {}, el('dt', { text: title }), el('dd', { text: value }));
}

function grade(assessment) {
  if (!assessment) return '—';
  if (assessment.answer === assessment.points) return pointsLabel(assessment.points);
  return `${answerLabel(assessment.answer)}${assessment.points == null ? '' : ` · ${pointsLabel(assessment.points)}`}`;
}

function fragmentNode(conversation, range) {
  const container = el('div', { className: 'fragment', props: { tabIndex: 0 }, attrs: { role: 'region', 'aria-label': 'Фрагмент разговора' } });
  if (!range || !conversation.transcript[range.from_turn]) {
    container.append(el('p', { text: 'Для этой оценки сервер не указал фрагмент.' }));
    return container;
  }
  const turns = conversation.transcript.slice(range.from_turn, range.to_turn + 1);
  for (const turn of turns) {
    container.append(el('p', {}, el('strong', { text: `${roleLabel(turn.speaker)} · ${turn.timestamp}` }), turn.text));
  }
  return container;
}

export function createReview({ loadVersion, openConversation, refreshEvaluation }) {
  let appeals = [];
  let request = 0;
  const list = $('appeal-list');
  const status = $('appeal-status');

  function render() {
    const filter = $('appeal-filter').value;
    const filtered = appeals.filter(appeal => filter === 'all' || appeal.status === filter).reverse();
    list.replaceChildren(...(filtered.length ? filtered.map(appeal => {
      const open = appeal.status === 'open';
      return el('article', { className: 'appeal' },
        el('header', {}, el('div', {}, el('h3', { text: `Диалог ${appeal.conversation_id}` }), el('p', { className: 'muted', text: `${appeal.id} · ${appeal.criterion_id}` })),
          badge(open ? 'На рассмотрении' : 'Рассмотрена', open ? 'warn' : 'pass')),
        el('p', { text: appeal.comment }),
        el('dl', { className: 'appeal-grid' }, pair('Исходная оценка критерия', grade(appeal.original)), pair('Решение по критерию', grade(appeal.final)),
          !open ? pair('Итог до → после', `${amount(appeal.total_before)} → ${amount(appeal.total_after)}`) : null),
        appeal.decision ? el('p', { text: `Причина решения: ${appeal.decision.reason}` }) : null,
        el('div', { className: 'actions' },
          open ? button('Рассмотреть апелляцию', () => void resolve(appeal), 'primary') : null,
          button('Открыть диалог', () => openConversation(appeal.conversation_id), 'subtle')));
    }) : [empty('Апелляций пока нет', 'После подачи апелляции она появится в этой очереди.', '↗')]));
  }

  async function load() {
    const id = ++request;
    $('refresh-appeals').disabled = true;
    list.setAttribute('aria-busy', 'true');
    notice(status, 'Загружаем очередь апелляций…');
    try {
      const data = await api('/appeals');
      if (id !== request) return;
      appeals = data;
      notice(status);
      render();
    } catch (error) {
      if (id === request) notice(status, `Не удалось загрузить апелляции. ${error.message}`, 'error');
    } finally {
      if (id === request) {
        list.setAttribute('aria-busy', 'false');
        $('refresh-appeals').disabled = false;
      }
    }
  }

  function submit(conversationId, item, name) {
    const comment = el('textarea', { props: { required: true, maxLength: 1200, rows: 4, placeholder: 'Укажите, с чем вы не согласны и на какую реплику опираетесь.' }, attrs: { 'data-focus': '' } });
    const feedback = errorMessage();
    const send = button('Подать апелляцию', null, 'primary', { type: 'submit' });
    const form = el('form', { className: 'modal-form' },
      el('p', { className: 'muted', text: `${conversationId} · ${name} · ${answerLabel(item.answer)}` }),
      labeled('Комментарий', comment), feedback, el('div', { className: 'actions' }, send));
    const dialog = openModal('Оспорить критерий', form);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const content = comment.value.trim();
      if (!content || send.disabled) { notice(feedback, 'Добавьте комментарий к апелляции.', 'error'); return; }
      send.disabled = true;
      notice(feedback);
      try {
        await api('/appeals', { method: 'POST', body: { conversation_id: conversationId, criterion_id: item.criterion_id, comment: content } });
        if (dialog.open && dialog.contains(form)) dialog.close();
        announce('Апелляция подана. Она доступна в очереди проверяющего.');
        await refreshEvaluation(conversationId);
      } catch (error) { notice(feedback, `Не удалось подать апелляцию. ${error.message}`, 'error'); }
      finally { send.disabled = false; }
    });
  }

  async function resolve(appeal) {
    const form = el('form', { className: 'modal-form' });
    const feedback = errorMessage();
    form.append(el('p', { className: 'muted', text: 'Загружаем спорный фрагмент…' }), feedback);
    const dialog = openModal('Решение по апелляции', form);
    const id = encodeURIComponent(appeal.conversation_id);
    let conversation;
    let evaluation;
    try { [conversation, evaluation] = await Promise.all([api('/conversations/' + id), api('/evaluations/' + id)]); }
    catch (error) { notice(feedback, `Не удалось получить исходную оценку. ${error.message}`, 'error'); return; }
    if (!dialog.open || !dialog.contains(form)) return;
    const checklist = await loadVersion(appeal.checklist_version ?? evaluation.checklist_version);
    if (!dialog.open || !dialog.contains(form)) return;
    const criterion = checklist?.criteria.find(item => item.id === appeal.criterion_id);
    const verdict = evaluation.criteria.find(item => item.criterion_id === appeal.criterion_id);
    const action = selectOptions([['confirm', 'Подтвердить оценку'], ['change', 'Изменить оценку']], 'confirm');
    const choices = criterion ? answerValues(criterion) : null;
    const next = choices
      ? selectOptions([['', 'Выберите новое значение'], ...choices.map((value, index) => [String(index), answerLabel(value)])], '')
      : el('input', { props: { placeholder: typeof appeal.original?.answer === 'number' ? 'Число из исходной шкалы или N/A' : 'Да, нет или N/A' } });
    const nextField = labeled('Новая оценка', next);
    const reason = el('textarea', { props: { required: true, maxLength: 1200, rows: 3, placeholder: 'Обоснуйте решение по критерию.' } });
    const save = button('Сохранить решение', null, 'primary', { type: 'submit' });
    const syncAction = () => { nextField.hidden = action.value !== 'change'; next.required = !nextField.hidden; };
    action.addEventListener('change', syncAction);
    syncAction();
    form.replaceChildren(...[
      el('h3', { text: criterion?.name || appeal.criterion_id }),
      el('p', { className: 'muted', text: `Исходная оценка: ${grade(appeal.original)} · Диалог ${appeal.conversation_id}` }),
      verdict?.explanation ? el('p', { className: 'muted', text: `Обоснование оценки: ${verdict.explanation}` }) : null,
      el('p', { text: `Комментарий: ${appeal.comment}` }),
      fragmentNode(conversation, appeal.fragment || verdict?.checked_range),
      labeled('Решение проверяющего', action), nextField, labeled('Причина решения', reason), feedback,
      el('div', { className: 'actions' }, save),
    ].filter(Boolean));
    action.focus();
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (save.disabled) return;
      if (!reason.value.trim()) { notice(feedback, 'Укажите причину решения.', 'error'); return; }
      const body = { action: action.value, reason: reason.value.trim() };
      if (body.action === 'change') {
        const raw = next.value.trim().toLowerCase();
        const translated = new Map([['да', 'yes'], ['нет', 'no'], ['n/a', 'na']]).get(raw) ?? raw;
        const value = choices ? choices[Number(raw)] : ['yes', 'no', 'na'].includes(translated) ? translated : Number(translated.replace(',', '.'));
        if (!raw || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) { notice(feedback, 'Выберите новое значение.', 'error'); return; }
        body.new_answer = value;
      }
      save.disabled = true;
      notice(feedback);
      try {
        await api(`/appeals/${encodeURIComponent(appeal.id)}/resolve`, { method: 'POST', body });
        if (dialog.open && dialog.contains(form)) dialog.close();
        announce('Решение по апелляции сохранено. Итог обновлён.');
        await Promise.all([load(), refreshEvaluation(appeal.conversation_id)]);
      } catch (error) { notice(feedback, `Не удалось сохранить решение. ${error.message}`, 'error'); }
      finally { save.disabled = false; }
    });
  }

  $('appeal-filter').addEventListener('change', render);
  $('refresh-appeals').addEventListener('click', () => void load());
  return { load, submit };
}
