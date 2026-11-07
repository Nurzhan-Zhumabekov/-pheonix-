//! REST API по docs/API_CONTRACT.md.

use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{rejection::JsonRejection, FromRequest, Path, Query, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    judge, loader,
    model::*,
    report,
    scoring,
    store::Store,
};

pub struct AppState {
    pub store: Store,
    pub dev_url: Option<String>,
    pub control_url: Option<String>,
    pub default_checklist: Checklist,
    /// `None`: модель не настроена, judge отдаёт заглушку.
    pub llm: Option<crate::llm::RealLlm>,
    pub judge_opts: judge::JudgeOpts,
}

pub type Shared = Arc<AppState>;

pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

fn err(status: StatusCode, code: &'static str, message: impl Into<String>) -> ApiError {
    ApiError { status, code, message: message.into() }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = json!({ "error": { "code": self.code, "message": self.message } });
        (self.status, Json(body)).into_response()
    }
}

type ApiResult<T> = Result<Json<T>, ApiError>;

/// `Json`, но ошибки разбора тела приходят в формате `{"error": {...}}` из контракта.
pub struct AppJson<T>(pub T);

impl<S, T> FromRequest<S> for AppJson<T>
where
    Json<T>: FromRequest<S, Rejection = JsonRejection>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(AppJson(value)),
            Err(rejection) => Err(err(rejection.status(), "bad_json", rejection.body_text())),
        }
    }
}

pub fn router(state: Shared) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/conversations", get(list_conversations))
        .route("/api/conversations/{id}", get(get_conversation))
        .route("/api/checklist", get(get_checklist).put(put_checklist))
        .route("/api/checklists/{version}", get(get_checklist_version))
        .route("/api/labels", get(list_labels))
        .route("/api/labels/{id}", get(get_label).put(put_label))
        .route("/api/report", get(get_report))
        .route("/api/evaluate", post(evaluate))
        .route("/api/evaluations/{id}", get(get_evaluation))
        .route("/api/appeals", get(list_appeals).post(create_appeal))
        .route("/api/appeals/{id}/resolve", post(resolve_appeal))
        .with_state(state)
}

// ---- вспомогательное ----

fn eval_path(conversation_id: &str) -> String {
    format!("evaluations/{}.json", Store::safe_name(conversation_id))
}

fn now_iso() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn current_checklist(st: &AppState) -> Checklist {
    st.store.read("checklist.json").unwrap_or_else(|| st.default_checklist.clone())
}

/// Чек-лист указанной версии из архива (версия по умолчанию хранится в коде).
fn archived_checklist(st: &AppState, version: u32) -> Option<Checklist> {
    st.store
        .read(&format!("checklists/v{version}.json"))
        .or_else(|| (version == st.default_checklist.version).then(|| st.default_checklist.clone()))
}

/// Чек-лист той версии, по которой выставлена оценка: веса могли измениться позже.
/// Если версии нет, пересчитывать по текущему нельзя: итог молча изменился бы.
fn checklist_for(st: &AppState, version: u32) -> Result<Checklist, ApiError> {
    archived_checklist(st, version).ok_or_else(|| {
        err(
            StatusCode::CONFLICT,
            "checklist_version_missing",
            format!("версия чек-листа {version} не найдена, пересчёт невозможен"),
        )
    })
}

/// Есть ли по диалогу нерассмотренная апелляция.
fn open_appeal_error() -> ApiError {
    err(StatusCode::CONFLICT, "open_appeal", "по диалогу есть нерассмотренная апелляция: сначала примите решение")
}

fn stale_error() -> ApiError {
    err(StatusCode::CONFLICT, "stale_evaluation", "оценка по диалогу изменилась после того, как была подана апелляция")
}

/// Идентификатор сохранённой оценки: время в наносекундах.
fn new_evaluation_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("ev_{nanos:x}")
}

/// Сохраняет оценку, только если по диалогу нет нерассмотренной апелляции. Проверка и запись идут
/// под тем же замком, что и подача апелляции: иначе апелляция, поданная пока модель отвечала,
/// ссылалась бы на оценку, которую мы тут же затираем.
fn save_evaluation(st: &AppState, ev: &Evaluation) -> Result<(), ApiError> {
    st.store.with_lock(|| {
        if has_open_appeal(st, &ev.conversation_id) {
            return Err(open_appeal_error());
        }
        st.store
            .write(&eval_path(&ev.conversation_id), ev)
            .map_err(|m| err(StatusCode::INTERNAL_SERVER_ERROR, "storage_error", m))
    })
}

/// Решение по апелляции применимо только к той оценке, по которой она подана.
/// У апелляций без `evaluation_id` (созданных раньше) проверка пропускается.
fn check_not_stale(appeal: &Appeal, ev: &Evaluation) -> Result<(), ApiError> {
    if !appeal.evaluation_id.is_empty() && appeal.evaluation_id != ev.evaluation_id {
        return Err(stale_error());
    }
    Ok(())
}

/// Создаёт апелляцию. Оценка читается под замком и привязывается по `evaluation_id`. Если клиент
/// прислал `evaluation_id` другой оценки (диалог успели переоценить), результат 409.
fn new_appeal(st: &AppState, req: &AppealReq) -> Result<Appeal, ApiError> {
    if req.comment.trim().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "empty_comment", "нужен комментарий"));
    }
    st.store.with_lock(|| {
        let ev: Evaluation = st
            .store
            .read(&eval_path(&req.conversation_id))
            .ok_or_else(|| err(StatusCode::NOT_FOUND, "no_evaluation", "сначала оцените диалог"))?;
        if let Some(seen) = &req.evaluation_id {
            if *seen != ev.evaluation_id {
                return Err(stale_error());
            }
        }
        let r = ev
            .criteria
            .iter()
            .find(|c| c.criterion_id == req.criterion_id)
            .ok_or_else(|| err(StatusCode::NOT_FOUND, "no_criterion", "критерий не найден в оценке"))?;
        let mut all: Vec<Appeal> = st.store.read("appeals.json").unwrap_or_default();
        let appeal = Appeal {
            id: format!("ap_{}", all.len() + 1),
            conversation_id: req.conversation_id.clone(),
            evaluation_id: ev.evaluation_id.clone(),
            criterion_id: req.criterion_id.clone(),
            comment: req.comment.trim().to_string(),
            fragment: fragment_of(r),
            status: "open".into(),
            created_at: now_iso(),
            original: AnswerPoints { answer: r.answer.clone(), points: r.points },
            decision: None,
            fin: None,
            total_before: None,
            total_after: None,
        };
        all.push(appeal.clone());
        st.store
            .write("appeals.json", &all)
            .map_err(|m| err(StatusCode::INTERNAL_SERVER_ERROR, "storage_error", m))?;
        Ok(appeal)
    })
}

fn has_open_appeal(st: &AppState, conversation_id: &str) -> bool {
    st.store
        .read::<Vec<Appeal>>("appeals.json")
        .unwrap_or_default()
        .iter()
        .any(|a| a.conversation_id == conversation_id && a.status == "open")
}

fn validate_checklist(c: &Checklist) -> Result<(), String> {
    if c.criteria.is_empty() {
        return Err("в чек-листе нет критериев".into());
    }
    let section_ids: HashSet<&str> = c.sections.iter().map(|s| s.id.as_str()).collect();
    let mut seen = HashSet::new();
    for cr in &c.criteria {
        if cr.id.trim().is_empty() || !seen.insert(cr.id.as_str()) {
            return Err(format!("id критерия пустой или повторяется: `{}`", cr.id));
        }
        if !cr.weight.is_finite() || cr.weight < 0.0 {
            return Err(format!("вес критерия `{}` должен быть числом не меньше 0", cr.id));
        }
        match cr.kind {
            CriterionType::Scale => {
                if cr.scale.is_empty() || cr.scale.iter().any(|v| !v.is_finite() || *v < 0.0) {
                    return Err(format!("у шкального критерия `{}` нужна шкала из неотрицательных чисел", cr.id));
                }
            }
            CriterionType::Flag if cr.weight != 0.0 => {
                return Err(format!("у флага `{}` вес должен быть 0", cr.id));
            }
            _ => {}
        }
        if let Some(sec) = &cr.section {
            if !section_ids.contains(sec.as_str()) {
                return Err(format!("секция `{sec}` критерия `{}` не объявлена", cr.id));
            }
        }
    }
    Ok(())
}

/// Ответы разметки: критерий есть в версии чек-листа, не флаг, значение допустимо
/// (N/A только где разрешён, число только из шкалы). Пустой набор допустим: черновик.
fn validate_label_answers(cl: &Checklist, answers: &BTreeMap<String, Answer>) -> Result<(), String> {
    for (cid, answer) in answers {
        let c = cl
            .criteria
            .iter()
            .find(|c| c.id == *cid)
            .ok_or_else(|| format!("критерий `{cid}` не найден в версии {} чек-листа", cl.version))?;
        if c.kind == CriterionType::Flag {
            return Err(format!("`{cid}` это флаг: используйте поле gross"));
        }
        scoring::share(c, answer).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn group_name(raw: &Option<String>) -> Result<&'static str, ApiError> {
    match raw.as_deref().unwrap_or("dev") {
        "dev" => Ok("dev"),
        "control" => Ok("control"),
        _ => Err(err(StatusCode::BAD_REQUEST, "bad_group", "group: dev или control")),
    }
}

async fn load_group(st: &AppState, group: &'static str, refresh: bool) -> Result<Vec<Conversation>, ApiError> {
    let rel = format!("conversations_{group}.json");
    if !refresh {
        if let Some(cached) = st.store.read::<Vec<Conversation>>(&rel) {
            return Ok(cached);
        }
    }
    let url = if group == "dev" { &st.dev_url } else { &st.control_url };
    let url = url.as_deref().ok_or_else(|| {
        err(StatusCode::BAD_REQUEST, "no_source", format!("адрес набора `{group}` не задан в .env"))
    })?;
    let convs = loader::fetch(url)
        .await
        .map_err(|m| err(StatusCode::BAD_GATEWAY, "upstream_error", m))?;
    st.store
        .write(&rel, &convs)
        .map_err(|m| err(StatusCode::INTERNAL_SERVER_ERROR, "storage_error", m))?;
    Ok(convs)
}

fn find_conversation(st: &AppState, id: &str) -> Result<Conversation, ApiError> {
    for group in ["dev", "control"] {
        if let Some(list) = st.store.read::<Vec<Conversation>>(&format!("conversations_{group}.json")) {
            if let Some(c) = list.into_iter().find(|c| c.conversation_id == id) {
                return Ok(c);
            }
        }
    }
    Err(err(
        StatusCode::NOT_FOUND,
        "no_conversation",
        "диалог не найден; сначала загрузите набор: GET /api/conversations?group=dev",
    ))
}

fn fragment_of(r: &CriterionResult) -> Option<TurnRange> {
    let min = r.evidence.iter().map(|e| e.turn_index).min();
    let max = r.evidence.iter().map(|e| e.turn_index).max();
    match (min, max) {
        (Some(a), Some(b)) => Some(TurnRange { from_turn: a, to_turn: b }),
        _ => r.checked_range,
    }
}

// ---- обработчики ----

async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}

#[derive(Deserialize)]
struct GroupQuery {
    group: Option<String>,
    refresh: Option<bool>,
}

/// Элемент списка диалогов. `turns_count` и `has_evaluation` дублируют `turns` и `evaluated`:
/// их ждёт интерфейс Дарии. Это добавление, прежние поля не менялись.
fn conversation_summary(c: &Conversation, evaluated: bool) -> Value {
    json!({
        "conversation_id": c.conversation_id,
        "channel": c.channel,
        "language": c.language,
        "turns": c.transcript.len(),
        "turns_count": c.transcript.len(),
        "evaluated": evaluated,
        "has_evaluation": evaluated,
    })
}

async fn list_conversations(State(st): State<Shared>, Query(q): Query<GroupQuery>) -> ApiResult<Value> {
    let group = group_name(&q.group)?;
    let convs = load_group(&st, group, q.refresh.unwrap_or(false)).await?;
    let items: Vec<Value> = convs
        .iter()
        .map(|c| conversation_summary(c, st.store.exists(&eval_path(&c.conversation_id))))
        .collect();
    Ok(Json(json!({ "group": group, "count": items.len(), "items": items })))
}

async fn get_conversation(State(st): State<Shared>, Path(id): Path<String>) -> ApiResult<Conversation> {
    find_conversation(&st, &id).map(Json)
}

async fn get_checklist(State(st): State<Shared>) -> Json<Checklist> {
    Json(current_checklist(&st))
}

async fn get_checklist_version(State(st): State<Shared>, Path(version): Path<u32>) -> ApiResult<Checklist> {
    archived_checklist(&st, version)
        .map(Json)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "no_checklist_version", format!("версия {version} не найдена")))
}

async fn put_checklist(State(st): State<Shared>, AppJson(mut cl): AppJson<Checklist>) -> ApiResult<Checklist> {
    validate_checklist(&cl).map_err(|m| err(StatusCode::BAD_REQUEST, "invalid_checklist", m))?;
    st.store.with_lock(|| {
        cl.version = current_checklist(&st).version + 1;
        let storage = |m: String| err(StatusCode::INTERNAL_SERVER_ERROR, "storage_error", m);
        st.store
            .write(&format!("checklists/v{}.json", cl.version), &cl)
            .map_err(storage)?;
        st.store.write("checklist.json", &cl).map_err(storage)?;
        Ok(Json(cl))
    })
}

#[derive(Deserialize)]
struct EvaluateReq {
    conversation_id: String,
}

async fn evaluate(State(st): State<Shared>, AppJson(req): AppJson<EvaluateReq>) -> ApiResult<Evaluation> {
    let conv = find_conversation(&st, &req.conversation_id)?;
    if has_open_appeal(&st, &conv.conversation_id) {
        return Err(open_appeal_error());
    }
    let checklist = current_checklist(&st);
    let mut ev = judge::evaluate(st.llm.as_ref(), &st.judge_opts, &conv, &checklist)
        .await
        .map_err(|m| err(StatusCode::BAD_GATEWAY, "judge_error", m))?;
    let (total, sections) = scoring::rescore(&checklist, &mut ev.criteria)
        .map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, "score_error", e.to_string()))?;
    ev.total = total;
    ev.sections = sections;
    ev.evaluation_id = new_evaluation_id();
    save_evaluation(&st, &ev)?;
    Ok(Json(ev))
}

async fn get_evaluation(State(st): State<Shared>, Path(id): Path<String>) -> ApiResult<Evaluation> {
    st.store
        .read::<Evaluation>(&eval_path(&id))
        .map(Json)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "no_evaluation", "оценка не найдена"))
}

async fn list_labels(State(st): State<Shared>) -> Json<BTreeMap<String, Label>> {
    Json(st.store.read("labels.json").unwrap_or_default())
}

async fn get_label(State(st): State<Shared>, Path(id): Path<String>) -> ApiResult<Label> {
    st.store
        .read::<BTreeMap<String, Label>>("labels.json")
        .and_then(|mut all| all.remove(&id))
        .map(Json)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "no_label", "разметка не найдена"))
}

#[derive(Deserialize)]
struct LabelReq {
    /// Если не указана, берётся версия текущего чек-листа.
    checklist_version: Option<u32>,
    #[serde(default)]
    answers: BTreeMap<String, Answer>,
    #[serde(default)]
    gross: Option<bool>,
    #[serde(default)]
    labeler: String,
    #[serde(default)]
    note: String,
}

/// Полная замена записи о разметке диалога.
async fn put_label(
    State(st): State<Shared>,
    Path(id): Path<String>,
    AppJson(req): AppJson<LabelReq>,
) -> ApiResult<Label> {
    find_conversation(&st, &id)?;
    let version = req.checklist_version.unwrap_or_else(|| current_checklist(&st).version);
    let cl = archived_checklist(&st, version).ok_or_else(|| {
        err(StatusCode::BAD_REQUEST, "no_checklist_version", format!("версия чек-листа {version} не найдена"))
    })?;
    validate_label_answers(&cl, &req.answers).map_err(|m| err(StatusCode::BAD_REQUEST, "bad_label", m))?;

    let label = Label {
        checklist_version: version,
        answers: req.answers,
        gross: req.gross,
        labeler: req.labeler.trim().to_string(),
        note: req.note,
        updated_at: now_iso(),
    };
    st.store
        .with_lock(|| -> Result<(), String> {
            let mut all: BTreeMap<String, Label> = st.store.read("labels.json").unwrap_or_default();
            all.insert(id.clone(), label.clone());
            st.store.write("labels.json", &all)
        })
        .map_err(|m| err(StatusCode::INTERNAL_SERVER_ERROR, "storage_error", m))?;
    Ok(Json(label))
}

async fn get_report(State(st): State<Shared>) -> Json<report::Report> {
    let labels: BTreeMap<String, Label> = st.store.read("labels.json").unwrap_or_default();
    let evals: BTreeMap<String, Evaluation> = labels
        .keys()
        .filter_map(|id| st.store.read::<Evaluation>(&eval_path(id)).map(|e| (id.clone(), e)))
        .collect();
    Json(report::build_report(|v| archived_checklist(&st, v), &labels, &evals))
}

#[derive(Deserialize)]
struct AppealQuery {
    conversation_id: Option<String>,
}

async fn list_appeals(State(st): State<Shared>, Query(q): Query<AppealQuery>) -> Json<Vec<Appeal>> {
    let all: Vec<Appeal> = st.store.read("appeals.json").unwrap_or_default();
    Json(
        all.into_iter()
            .filter(|a| q.conversation_id.as_deref().map_or(true, |id| a.conversation_id == id))
            .collect(),
    )
}

#[derive(Deserialize)]
struct AppealReq {
    conversation_id: String,
    criterion_id: String,
    comment: String,
    /// Необязательно: `evaluation_id` оценки, которую видел пользователь. При несовпадении 409.
    #[serde(default)]
    evaluation_id: Option<String>,
}

async fn create_appeal(State(st): State<Shared>, AppJson(req): AppJson<AppealReq>) -> ApiResult<Appeal> {
    new_appeal(&st, &req).map(Json)
}

#[derive(Deserialize)]
struct ResolveReq {
    action: String,
    new_answer: Option<Answer>,
    reason: String,
}

async fn resolve_appeal(
    State(st): State<Shared>,
    Path(id): Path<String>,
    AppJson(req): AppJson<ResolveReq>,
) -> ApiResult<Appeal> {
    if req.reason.trim().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "empty_reason", "нужна причина решения"));
    }
    if req.action != "confirm" && req.action != "change" {
        return Err(err(StatusCode::BAD_REQUEST, "bad_action", "action: confirm или change"));
    }
    st.store
        .with_lock(|| -> Result<Appeal, ApiError> {
            let storage = |m: String| err(StatusCode::INTERNAL_SERVER_ERROR, "storage_error", m);
            let mut all: Vec<Appeal> = st.store.read("appeals.json").unwrap_or_default();
            let idx = all
                .iter()
                .position(|a| a.id == id)
                .ok_or_else(|| err(StatusCode::NOT_FOUND, "no_appeal", "апелляция не найдена"))?;
            if all[idx].status == "resolved" {
                return Err(err(StatusCode::CONFLICT, "already_resolved", "апелляция уже рассмотрена"));
            }
            let path = eval_path(&all[idx].conversation_id);
            let mut ev: Evaluation = st
                .store
                .read(&path)
                .ok_or_else(|| err(StatusCode::NOT_FOUND, "no_evaluation", "оценка не найдена"))?;
            check_not_stale(&all[idx], &ev)?;
            let checklist = checklist_for(&st, ev.checklist_version)?;
            let crit_id = all[idx].criterion_id.clone();
            let total_before = ev.total;

            if req.action == "change" {
                let new_answer = req.new_answer.clone().ok_or_else(|| {
                    err(StatusCode::BAD_REQUEST, "no_answer", "для change нужен new_answer")
                })?;
                let r = ev
                    .criteria
                    .iter_mut()
                    .find(|c| c.criterion_id == crit_id)
                    .ok_or_else(|| err(StatusCode::NOT_FOUND, "no_criterion", "критерий не найден в оценке"))?;
                r.answer = new_answer;
                let (total, sections) = scoring::rescore(&checklist, &mut ev.criteria)
                    .map_err(|e| err(StatusCode::BAD_REQUEST, "score_error", e.to_string()))?;
                ev.total = total;
                ev.sections = sections;
            }

            let fin = ev
                .criteria
                .iter()
                .find(|c| c.criterion_id == crit_id)
                .map(|c| AnswerPoints { answer: c.answer.clone(), points: c.points })
                .unwrap_or_else(|| all[idx].original.clone());

            let appeal = &mut all[idx];
            appeal.status = "resolved".into();
            appeal.decision = Some(Decision {
                action: req.action.clone(),
                new_answer: req.new_answer.clone(),
                reason: req.reason.trim().to_string(),
                decided_at: now_iso(),
            });
            appeal.fin = Some(fin);
            appeal.total_before = total_before;
            appeal.total_after = ev.total;
            let result = appeal.clone();

            st.store.write(&path, &ev).map_err(storage)?;
            st.store.write("appeals.json", &all).map_err(|m| {
                err(StatusCode::INTERNAL_SERVER_ERROR, "storage_error", m)
            })?;
            Ok(result)
        })
        .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_checklist_is_valid() {
        let cl: Checklist = serde_json::from_str(include_str!("../../config/checklist.default.json")).unwrap();
        assert_eq!(validate_checklist(&cl), Ok(()));
        assert_eq!(cl.criteria.len(), 8);
    }

    #[test]
    fn invalid_checklists_are_rejected() {
        let mut cl: Checklist = serde_json::from_str(include_str!("../../config/checklist.default.json")).unwrap();
        cl.criteria[1].id = cl.criteria[0].id.clone();
        assert!(validate_checklist(&cl).is_err());

        let mut cl: Checklist = serde_json::from_str(include_str!("../../config/checklist.default.json")).unwrap();
        cl.criteria[0].weight = -1.0;
        assert!(validate_checklist(&cl).is_err());

        let mut cl: Checklist = serde_json::from_str(include_str!("../../config/checklist.default.json")).unwrap();
        cl.criteria[0].section = Some("nope".into());
        assert!(validate_checklist(&cl).is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 12)]
    async fn parallel_checklist_saves_keep_distinct_versions() {
        let (st, dir) = test_state("parallel_checklists");
        let st = Arc::new(st);
        let count = 12;
        let initial_version = st.default_checklist.version;
        let barrier = Arc::new(tokio::sync::Barrier::new(count));
        let requests = (0..count).map(|index| {
            let st = Arc::clone(&st);
            let barrier = Arc::clone(&barrier);
            tokio::spawn(async move {
                let mut checklist = st.default_checklist.clone();
                let name = format!("Parallel criterion {index}");
                checklist.criteria[0].name = name.clone();
                barrier.wait().await;
                put_checklist(State(st), AppJson(checklist))
                    .await
                    .map(|Json(saved)| (saved.version, name, saved.criteria[0].name.clone()))
                    .map_err(|error| error.code)
            })
        });
        let responses = futures::future::join_all(requests).await;
        let versions = initial_version + 1..=initial_version + count as u32;
        let archives: Vec<_> = versions
            .clone()
            .map(|version| archived_checklist(&st, version).map(|cl| cl.criteria[0].name.clone()))
            .collect();
        let current = current_checklist(&st);
        let _ = std::fs::remove_dir_all(dir);

        let mut saved: Vec<_> = responses
            .into_iter()
            .map(|response| response.unwrap())
            .collect::<Result<_, _>>()
            .expect("all parallel saves should succeed");
        saved.sort_by_key(|(version, _, _)| *version);
        assert_eq!(
            saved.iter().map(|(version, _, _)| *version).collect::<Vec<_>>(),
            versions.clone().collect::<Vec<_>>()
        );
        for ((_, submitted, returned), archived) in saved.iter().zip(archives) {
            assert_eq!(submitted, returned);
            assert_eq!(archived.as_ref(), Some(submitted));
        }
        assert_eq!(current.version, *versions.end());
        assert_eq!(current.criteria[0].name, saved.last().unwrap().1);
    }

    #[test]
    fn checklist_for_uses_the_evaluated_version() {
        let dir = std::env::temp_dir().join(format!("cqa_api_test_{}", std::process::id()));
        let default: Checklist =
            serde_json::from_str(include_str!("../../config/checklist.default.json")).unwrap();
        let st = AppState {
            store: Store::new(&dir),
            dev_url: None,
            control_url: None,
            default_checklist: default.clone(),
            llm: None,
            judge_opts: judge::JudgeOpts::default(),
        };

        let mut v2 = default.clone();
        v2.version = 2;
        v2.criteria[3].weight = 40.0;
        st.store.write("checklists/v2.json", &v2).unwrap();
        let mut v3 = v2.clone();
        v3.version = 3;
        v3.criteria[3].weight = 10.0;
        st.store.write("checklists/v3.json", &v3).unwrap();
        st.store.write("checklist.json", &v3).unwrap();

        let w = |v: u32| checklist_for(&st, v).map(|c| c.criteria[3].weight).ok();
        assert_eq!(w(1), Some(20.0)); // версия по умолчанию
        assert_eq!(w(2), Some(40.0));
        assert_eq!(w(3), Some(10.0));
        assert_eq!(w(9), None, "неизвестная версия не заменяется текущей");
        assert!(archived_checklist(&st, 9).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn open_appeal_blocks_only_its_conversation() {
        let dir = std::env::temp_dir().join(format!("cqa_api_test2_{}", std::process::id()));
        let st = AppState {
            store: Store::new(&dir),
            dev_url: None,
            control_url: None,
            default_checklist: serde_json::from_str(include_str!("../../config/checklist.default.json")).unwrap(),
            llm: None,
            judge_opts: judge::JudgeOpts::default(),
        };
        let appeal = |id: &str, conv: &str, status: &str| Appeal {
            id: id.into(),
            conversation_id: conv.into(),
            evaluation_id: String::new(),
            criterion_id: "contact".into(),
            comment: "c".into(),
            fragment: None,
            status: status.into(),
            created_at: "t".into(),
            original: AnswerPoints { answer: Answer::Text("yes".into()), points: Some(10.0) },
            decision: None,
            fin: None,
            total_before: None,
            total_after: None,
        };
        assert!(!has_open_appeal(&st, "a"), "файла апелляций ещё нет");
        st.store
            .write("appeals.json", &vec![appeal("ap_1", "a", "open"), appeal("ap_2", "b", "resolved")])
            .unwrap();
        assert!(has_open_appeal(&st, "a"));
        assert!(!has_open_appeal(&st, "b"), "рассмотренная не блокирует");
        assert!(!has_open_appeal(&st, "c"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn label_answers_are_validated_against_the_checklist() {
        let cl: Checklist = serde_json::from_str(include_str!("../../config/checklist.default.json")).unwrap();
        let ans = |pairs: &[(&str, Answer)]| -> BTreeMap<String, Answer> {
            pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
        };
        let yes = || Answer::Text("yes".into());
        let na = || Answer::Text("na".into());

        assert_eq!(validate_label_answers(&cl, &BTreeMap::new()), Ok(()), "черновик без ответов допустим");
        assert_eq!(
            validate_label_answers(&cl, &ans(&[("contact", yes()), ("needs", na()), ("consultation", Answer::Num(15.0))])),
            Ok(())
        );
        let bad = |pairs: &[(&str, Answer)]| validate_label_answers(&cl, &ans(pairs)).unwrap_err();
        assert!(bad(&[("nope", yes())]).contains("не найден"));
        assert!(bad(&[("gross", yes())]).contains("gross"), "флаг только через поле gross");
        assert!(bad(&[("contact", na())]).contains("N/A"), "N/A там, где запрещён");
        assert!(bad(&[("consultation", Answer::Num(12.0))]).contains("недопустимый"), "значение вне шкалы");
        assert!(bad(&[("contact", Answer::Num(1.0))]).contains("недопустимый"), "число для бинарного");
    }

    #[test]
    fn list_item_has_both_field_name_variants() {
        let c = Conversation {
            conversation_id: "t-9".into(),
            channel: "agent chat".into(),
            language: "KZ".into(),
            transcript: vec![
                Turn { timestamp: "00:01".into(), speaker: "client".into(), text: "a".into() },
                Turn { timestamp: "00:02".into(), speaker: "operator".into(), text: "b".into() },
            ],
            audio_url: None,
        };
        let item = conversation_summary(&c, true);
        assert_eq!(item["conversation_id"], "t-9");
        assert_eq!((item["turns"].as_u64(), item["turns_count"].as_u64()), (Some(2), Some(2)));
        assert_eq!((item["evaluated"].as_bool(), item["has_evaluation"].as_bool()), (Some(true), Some(true)));
        assert_eq!(conversation_summary(&c, false)["has_evaluation"], false);
        assert!(item.get("audio_url").is_none(), "ссылка на аудио в список не попадает");
    }

    fn test_state(tag: &str) -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("cqa_api_{tag}_{}", std::process::id()));
        let st = AppState {
            store: Store::new(&dir),
            dev_url: None,
            control_url: None,
            default_checklist: serde_json::from_str(include_str!("../../config/checklist.default.json")).unwrap(),
            llm: None,
            judge_opts: judge::JudgeOpts::default(),
        };
        (st, dir)
    }

    fn evaluation(conv: &str, ev_id: &str) -> Evaluation {
        Evaluation {
            mock: false,
            conversation_id: conv.into(),
            evaluation_id: ev_id.into(),
            channel: "agent chat".into(),
            language: "RU".into(),
            checklist_version: 1,
            criteria: vec![CriterionResult {
                criterion_id: "contact".into(),
                answer: Answer::Text("yes".into()),
                share: Some(1.0),
                weight: 10.0,
                points: Some(10.0),
                explanation: String::new(),
                evidence: vec![],
                checked_range: None,
                na_reason: None,
            }],
            sections: vec![],
            total: Some(100.0),
            gross_error: GrossError::default(),
            model: ModelInfo::default(),
        }
    }

    fn appeal_of(conv: &str, ev_id: &str, status: &str) -> Appeal {
        Appeal {
            id: "ap_1".into(),
            conversation_id: conv.into(),
            evaluation_id: ev_id.into(),
            criterion_id: "contact".into(),
            comment: "c".into(),
            fragment: None,
            status: status.into(),
            created_at: "t".into(),
            original: AnswerPoints { answer: Answer::Text("yes".into()), points: Some(10.0) },
            decision: None,
            fin: None,
            total_before: None,
            total_after: None,
        }
    }

    #[test]
    fn saving_a_new_evaluation_is_refused_while_an_appeal_is_open() {
        let (st, dir) = test_state("save");
        save_evaluation(&st, &evaluation("c1", "ev_1")).unwrap_or_else(|e| panic!("{}", e.code));
        assert!(st.store.exists(&eval_path("c1")));

        // пока модель отвечала, подана апелляция: новая оценка не должна затереть прежнюю
        st.store.write("appeals.json", &vec![appeal_of("c1", "ev_1", "open")]).unwrap();
        let refused = save_evaluation(&st, &evaluation("c1", "ev_2")).err().expect("нужен отказ");
        assert_eq!(refused.code, "open_appeal");
        assert_eq!(st.store.read::<Evaluation>(&eval_path("c1")).unwrap().evaluation_id, "ev_1");

        // другой диалог не блокируется, рассмотренная апелляция тоже
        assert!(save_evaluation(&st, &evaluation("c2", "ev_3")).is_ok());
        st.store.write("appeals.json", &vec![appeal_of("c1", "ev_1", "resolved")]).unwrap();
        assert!(save_evaluation(&st, &evaluation("c1", "ev_4")).is_ok());
        assert_eq!(st.store.read::<Evaluation>(&eval_path("c1")).unwrap().evaluation_id, "ev_4");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn appeal_is_bound_to_the_evaluation_it_was_filed_against() {
        let (st, dir) = test_state("bind");
        st.store.write(&eval_path("c1"), &evaluation("c1", "ev_1")).unwrap();
        let req = |seen: Option<&str>, crit: &str, comment: &str| AppealReq {
            conversation_id: "c1".into(),
            criterion_id: crit.into(),
            comment: comment.into(),
            evaluation_id: seen.map(String::from),
        };
        let first = new_appeal(&st, &req(None, "contact", "спорно")).ok().expect("создана");
        assert_eq!((first.evaluation_id.as_str(), first.status.as_str()), ("ev_1", "open"));
        let second = new_appeal(&st, &req(Some("ev_1"), "contact", "ещё")).ok().expect("создана");
        assert_eq!(second.id, "ap_2");

        // клиент видел другую оценку: диалог успели переоценить
        let stale = |r: AppealReq| new_appeal(&st, &r).err().map(|e| e.code);
        assert_eq!(stale(req(Some("ev_0"), "contact", "x")), Some("stale_evaluation"));
        assert_eq!(stale(req(None, "nope", "x")), Some("no_criterion"));
        assert_eq!(stale(req(None, "contact", "   ")), Some("empty_comment"));
        assert_eq!(st.store.read::<Vec<Appeal>>("appeals.json").unwrap().len(), 2, "отказы ничего не пишут");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn resolving_against_a_replaced_evaluation_is_refused() {
        let current = evaluation("c1", "ev_2");
        assert!(check_not_stale(&appeal_of("c1", "ev_2", "open"), &current).is_ok());
        assert_eq!(
            check_not_stale(&appeal_of("c1", "ev_1", "open"), &current).err().map(|e| e.code),
            Some("stale_evaluation")
        );
        // апелляции, созданные до появления поля, не блокируются
        assert!(check_not_stale(&appeal_of("c1", "", "open"), &current).is_ok());
    }

    #[test]
    fn evaluation_ids_are_unique_and_prefixed() {
        let (a, b) = (new_evaluation_id(), new_evaluation_id());
        assert!(a.starts_with("ev_") && a.len() > 6);
        assert_ne!(a, b);
    }

    #[test]
    fn iso_time_has_expected_shape() {
        let t = now_iso();
        assert_eq!(t.len(), 20);
        assert!(t.ends_with('Z') && t.as_bytes()[10] == b'T');
    }
}
