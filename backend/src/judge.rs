//! Judge: оценка диалога по чек-листу, один вызов модели на критерий.
//!
//! Модель выбирает ответ и приводит цитаты, баллы и итог считает `scoring::rescore`.
//! Подход описан в docs/ML_APPROACH.md. Без настроенной модели возвращается заглушка.

use std::path::PathBuf;

use futures::future::join_all;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Semaphore;

use crate::{
    llm::{Llm, RealLlm},
    model::*,
    scoring,
};

const SYSTEM_DEFAULT: &str = include_str!("../../config/prompts/system.txt");
const CRITERION_DEFAULT: &str = include_str!("../../config/prompts/criterion.txt");

#[derive(Clone, Debug)]
pub struct JudgeOpts {
    /// Число запусков для шкальных критериев (медиана). Для остальных всегда 1.
    pub votes: usize,
    /// Максимум одновременных запросов к модели.
    pub concurrency: usize,
    /// Каталог с `system.txt` и `criterion.txt`. Если файла нет, берутся встроенные.
    pub prompts_dir: PathBuf,
    /// Цена за 1 млн токенов, USD.
    pub price_in: f64,
    pub price_out: f64,
}

impl Default for JudgeOpts {
    fn default() -> Self {
        JudgeOpts {
            votes: 3,
            concurrency: 4,
            prompts_dir: PathBuf::from("../config/prompts"),
            price_in: 0.0,
            price_out: 0.0,
        }
    }
}

impl JudgeOpts {
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Self {
        let d = JudgeOpts::default();
        JudgeOpts {
            votes: get("LLM_VOTES").and_then(|v| v.parse().ok()).unwrap_or(d.votes),
            concurrency: get("LLM_CONCURRENCY").and_then(|v| v.parse().ok()).unwrap_or(d.concurrency),
            prompts_dir: get("PROMPTS_DIR").map(PathBuf::from).unwrap_or(d.prompts_dir),
            price_in: get("LLM_PRICE_IN").and_then(|v| v.parse().ok()).unwrap_or(0.0),
            price_out: get("LLM_PRICE_OUT").and_then(|v| v.parse().ok()).unwrap_or(0.0),
        }
    }
}

pub async fn evaluate(
    llm: Option<&RealLlm>,
    opts: &JudgeOpts,
    conv: &Conversation,
    checklist: &Checklist,
) -> Result<Evaluation, String> {
    match llm {
        Some(llm) => run(llm, opts, conv, checklist).await,
        None => Ok(mock(conv, checklist)),
    }
}

// ---- реальная оценка ----

struct Ctx<'a, L> {
    llm: &'a L,
    sem: &'a Semaphore,
    sys: &'a str,
    tmpl: &'a str,
    transcript: &'a str,
    conv: &'a Conversation,
    opts: &'a JudgeOpts,
}

#[derive(Debug)]
struct Verdict {
    answer: Answer,
    explanation: String,
    evidence: Vec<Evidence>,
    checked_range: Option<TurnRange>,
    na_reason: Option<String>,
    unverified: bool,
    calls: u32,
    input: u64,
    output: u64,
}

struct Parsed {
    verdict: Verdict,
    bad_quotes: Vec<String>,
}

#[derive(Deserialize)]
struct RawVerdict {
    #[serde(default)]
    evidence: Vec<RawEvidence>,
    #[serde(default)]
    checked_range: Option<RawRange>,
    #[serde(default)]
    reasoning: String,
    answer: Value,
    #[serde(default)]
    na_reason: Option<String>,
}

#[derive(Deserialize)]
struct RawEvidence {
    #[serde(default)]
    turn_index: Option<Value>,
    #[serde(default)]
    quote: String,
    #[serde(default)]
    role: Option<String>,
}

#[derive(Deserialize)]
struct RawRange {
    #[serde(default)]
    from_turn: Option<Value>,
    #[serde(default)]
    to_turn: Option<Value>,
}

fn load_prompt(opts: &JudgeOpts, name: &str, default: &str) -> String {
    std::fs::read_to_string(opts.prompts_dir.join(name)).unwrap_or_else(|_| default.to_string())
}

fn format_transcript(conv: &Conversation) -> String {
    conv.transcript
        .iter()
        .enumerate()
        .map(|(i, t)| format!("[{i}] {} {}: {}", t.timestamp, t.speaker, t.text))
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_prompt(tmpl: &str, conv: &Conversation, c: &Criterion, transcript: &str) -> String {
    let scale = c.scale.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(", ");
    let na = if c.na_allowed { " или \"na\"" } else { "" };
    let (answers, kind_rules) = match c.kind {
        CriterionType::Binary => (
            format!("\"yes\" или \"no\"{na}"),
            "\"yes\": критерий выполнен. \"no\": действие было нужно, но оператор его пропустил или выполнил неправильно.".to_string(),
        ),
        CriterionType::Scale => (
            format!("число из шкалы [{scale}]{na}"),
            "Выбери ступень шкалы, описание которой точнее всего соответствует диалогу. Верхняя ступень означает полное выполнение.".to_string(),
        ),
        CriterionType::Flag => (
            "\"yes\" или \"no\"".to_string(),
            "\"yes\": выявлено хотя бы одно из перечисленных нарушений, достаточно самого факта в переписке. \"no\": ни одно не выявлено.".to_string(),
        ),
    };
    let na_rule = match (&c.na_allowed, &c.na_condition) {
        (true, Some(cond)) => format!(
            "Ответ \"na\" допустим только при условии: {cond} В остальных случаях выбирай другой ответ: «Нет» и N/A не одно и то же."
        ),
        (true, None) => "Ответ \"na\" допустим, только если критерий неприменим к диалогу.".to_string(),
        (false, _) => "Ответ \"na\" недопустим.".to_string(),
    };
    let channel_hint = if conv.channel.to_lowercase().contains("voice") {
        "Это транскрипт звонка: оценивай логичность, понятность, уместность выражений и управление паузами. Артефакты распознавания речи не штрафуй."
    } else {
        ""
    };
    tmpl.replace("{{name}}", &c.name)
        .replace("{{description}}", &c.description)
        .replace("{{answers}}", &answers)
        .replace("{{kind_rules}}", &kind_rules)
        .replace("{{na_rule}}", &na_rule)
        .replace("{{channel}}", &conv.channel)
        .replace("{{language}}", &conv.language)
        .replace("{{channel_hint}}", channel_hint)
        .replace("{{transcript}}", transcript)
}

fn norm(s: &str) -> String {
    s.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn short(s: &str) -> String {
    s.chars().take(60).collect()
}

fn as_index(v: &Value) -> Option<usize> {
    match v {
        Value::Number(n) => n.as_u64().map(|x| x as usize).or_else(|| {
            n.as_f64().filter(|f| *f >= 0.0 && f.fract() == 0.0).map(|f| f as usize)
        }),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn normalize_answer(c: &Criterion, raw: &Value) -> Result<Answer, String> {
    let answer = match raw {
        Value::Number(n) => Answer::Num(n.as_f64().ok_or("число вне диапазона")?),
        Value::Bool(b) => Answer::Text(if *b { "yes" } else { "no" }.into()),
        Value::String(s) => {
            let t = s.trim().to_lowercase();
            match t.as_str() {
                "да" | "yes" | "true" => Answer::Text("yes".into()),
                "нет" | "no" | "false" => Answer::Text("no".into()),
                "na" | "n/a" | "н/п" => Answer::Text("na".into()),
                other => other
                    .replace(',', ".")
                    .parse::<f64>()
                    .map(Answer::Num)
                    .map_err(|_| format!("неизвестный ответ `{s}`"))?,
            }
        }
        _ => return Err("answer должен быть строкой или числом".into()),
    };
    if c.kind == CriterionType::Flag {
        return match &answer {
            Answer::Text(t) if t == "yes" || t == "no" => Ok(answer),
            _ => Err("для флага допустимы только yes и no".into()),
        };
    }
    scoring::share(c, &answer).map_err(|e| e.to_string())?;
    Ok(answer)
}

fn check_evidence(ev: &RawEvidence, conv: &Conversation) -> Result<Evidence, String> {
    let idx = ev
        .turn_index
        .as_ref()
        .and_then(as_index)
        .ok_or_else(|| format!("реплика без номера: «{}»", short(&ev.quote)))?;
    let turn = conv.transcript.get(idx).ok_or_else(|| format!("нет реплики с номером {idx}"))?;
    let q = norm(&ev.quote);
    if q.is_empty() || !norm(&turn.text).contains(&q) {
        return Err(format!("[{idx}] «{}»", short(&ev.quote)));
    }
    Ok(Evidence {
        turn_index: idx,
        speaker: turn.speaker.clone(),
        timestamp: turn.timestamp.clone(),
        quote: ev.quote.trim().to_string(),
        role: match ev.role.as_deref() {
            Some("expected_location") => "expected_location",
            _ => "supports",
        }
        .into(),
    })
}

fn parse_verdict(text: &str, c: &Criterion, conv: &Conversation) -> Result<Parsed, String> {
    let json = match (text.find('{'), text.rfind('}')) {
        (Some(s), Some(e)) if e > s => &text[s..=e],
        _ => return Err("в ответе нет JSON-объекта".into()),
    };
    let raw: RawVerdict = serde_json::from_str(json).map_err(|e| format!("некорректный JSON: {e}"))?;
    let answer = normalize_answer(c, &raw.answer)?;
    let na_reason = raw.na_reason.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if answer == Answer::Text("na".into()) && na_reason.is_none() {
        return Err("для ответа na нужна непустая na_reason".into());
    }

    let (mut evidence, mut bad_quotes) = (vec![], vec![]);
    for ev in &raw.evidence {
        match check_evidence(ev, conv) {
            Ok(e) => evidence.push(e),
            Err(b) => bad_quotes.push(b),
        }
    }

    let last = conv.transcript.len();
    let checked_range = raw
        .checked_range
        .and_then(|r| {
            let a = r.from_turn.as_ref().and_then(as_index)?;
            let b = r.to_turn.as_ref().and_then(as_index)?;
            (a <= b && b < last).then_some(TurnRange { from_turn: a, to_turn: b })
        })
        .or_else(|| (last > 0).then(|| TurnRange { from_turn: 0, to_turn: last - 1 }));

    Ok(Parsed {
        verdict: Verdict {
            answer,
            explanation: raw.reasoning.trim().to_string(),
            evidence,
            checked_range,
            na_reason,
            unverified: false,
            calls: 0,
            input: 0,
            output: 0,
        },
        bad_quotes,
    })
}

/// Один запрос по критерию. При невалидном ответе или непроверяемых цитатах один повтор.
async fn ask_once<L: Llm>(cx: &Ctx<'_, L>, c: &Criterion, temperature: f32) -> Result<Verdict, String> {
    let base = build_prompt(cx.tmpl, cx.conv, c, cx.transcript);
    let (mut calls, mut input, mut output) = (0u32, 0u64, 0u64);
    let mut note = String::new();

    for attempt in 0..2 {
        let prompt = if note.is_empty() {
            base.clone()
        } else {
            format!("{base}\n\nПредыдущий ответ отклонён: {note}\nИсправь и ответь заново, соблюдая формат.")
        };
        let reply = {
            let _permit = cx.sem.acquire().await.map_err(|e| e.to_string())?;
            cx.llm.complete(cx.sys, &prompt, temperature).await?
        };
        calls += 1;
        input += reply.input_tokens;
        output += reply.output_tokens;

        match parse_verdict(&reply.text, c, cx.conv) {
            Ok(mut p) if p.bad_quotes.is_empty() || attempt == 1 => {
                // После повтора неподтверждённые цитаты отбрасываем, но помечаем результат.
                p.verdict.unverified = !p.bad_quotes.is_empty();
                p.verdict.calls = calls;
                p.verdict.input = input;
                p.verdict.output = output;
                return Ok(p.verdict);
            }
            Ok(p) => {
                note = format!("цитаты не найдены дословно в указанных репликах: {}.", p.bad_quotes.join("; "));
            }
            Err(e) if attempt == 1 => return Err(format!("критерий `{}`: {e}", c.id)),
            Err(e) => note = e,
        }
    }
    Err(format!("критерий `{}`: не удалось получить ответ", c.id))
}

async fn judge_criterion<L: Llm>(cx: &Ctx<'_, L>, c: &Criterion) -> Result<Verdict, String> {
    let votes = if c.kind == CriterionType::Scale { cx.opts.votes.max(1) } else { 1 };
    if votes == 1 {
        return ask_once(cx, c, 0.0).await;
    }

    let results = join_all((0..votes).map(|_| ask_once(cx, c, 0.3))).await;
    let (mut ok, mut last_err) = (Vec::new(), None);
    let (mut calls, mut input, mut output) = (0u32, 0u64, 0u64);
    for r in results {
        match r {
            Ok(v) => {
                calls += v.calls;
                input += v.input;
                output += v.output;
                ok.push(v);
            }
            Err(e) => last_err = Some(e),
        }
    }
    if ok.is_empty() {
        return Err(last_err.unwrap_or_else(|| format!("критерий `{}`: нет ответов", c.id)));
    }

    let is_na = |v: &Verdict| v.answer == Answer::Text("na".into());
    let na_votes = ok.iter().filter(|v| is_na(v)).count();
    let idx = if na_votes * 2 > ok.len() {
        ok.iter().position(|v| is_na(v))
    } else {
        // Нижняя медиана среди числовых ответов.
        let mut nums: Vec<f64> = ok
            .iter()
            .filter_map(|v| if let Answer::Num(x) = v.answer { Some(x) } else { None })
            .collect();
        nums.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let med = nums[(nums.len() - 1) / 2];
        ok.iter().position(|v| v.answer == Answer::Num(med))
    }
    .unwrap_or(0);

    let mut chosen = ok.swap_remove(idx);
    chosen.calls = calls;
    chosen.input = input;
    chosen.output = output;
    Ok(chosen)
}

async fn run<L: Llm>(
    llm: &L,
    opts: &JudgeOpts,
    conv: &Conversation,
    checklist: &Checklist,
) -> Result<Evaluation, String> {
    let sys = load_prompt(opts, "system.txt", SYSTEM_DEFAULT);
    let tmpl = load_prompt(opts, "criterion.txt", CRITERION_DEFAULT);
    let transcript = format_transcript(conv);
    let sem = Semaphore::new(opts.concurrency.max(1));
    let cx = Ctx { llm, sem: &sem, sys: &sys, tmpl: &tmpl, transcript: &transcript, conv, opts };

    let outcomes = join_all(checklist.criteria.iter().map(|c| judge_criterion(&cx, c))).await;

    let mut criteria = vec![];
    let mut gross = GrossError::default();
    let (mut calls, mut input, mut output) = (0u32, 0u64, 0u64);
    for (c, outcome) in checklist.criteria.iter().zip(outcomes) {
        let v = outcome?;
        calls += v.calls;
        input += v.input;
        output += v.output;
        let explanation = if v.unverified {
            format!("[цитата не подтверждена] {}", v.explanation)
        } else {
            v.explanation.clone()
        };
        if c.kind == CriterionType::Flag {
            gross = GrossError {
                flag: v.answer == Answer::Text("yes".into()),
                explanation: Some(explanation),
                evidence: v.evidence,
            };
            continue;
        }
        criteria.push(CriterionResult {
            criterion_id: c.id.clone(),
            answer: v.answer,
            share: None,
            weight: c.weight,
            points: None,
            explanation,
            evidence: v.evidence,
            checked_range: v.checked_range,
            na_reason: v.na_reason,
        });
    }

    Ok(Evaluation {
        mock: false,
        conversation_id: conv.conversation_id.clone(),
        channel: conv.channel.clone(),
        language: conv.language.clone(),
        checklist_version: checklist.version,
        criteria,
        sections: vec![],
        total: None,
        gross_error: gross,
        model: ModelInfo {
            name: llm.model_name(),
            calls,
            input_tokens: input,
            output_tokens: output,
            cost_usd: (input as f64 * opts.price_in + output as f64 * opts.price_out) / 1_000_000.0,
        },
    })
}

// ---- заглушка (модель не настроена) ----

fn mock(conv: &Conversation, checklist: &Checklist) -> Evaluation {
    let first_operator = conv
        .transcript
        .iter()
        .position(|t| t.speaker == "operator")
        .or(if conv.transcript.is_empty() { None } else { Some(0) });

    let evidence: Vec<Evidence> = first_operator
        .map(|i| {
            let t = &conv.transcript[i];
            vec![Evidence {
                turn_index: i,
                speaker: t.speaker.clone(),
                timestamp: t.timestamp.clone(),
                quote: t.text.clone(),
                role: "supports".into(),
            }]
        })
        .unwrap_or_default();

    let checked_range = if conv.transcript.is_empty() {
        None
    } else {
        Some(TurnRange { from_turn: 0, to_turn: conv.transcript.len() - 1 })
    };

    let criteria = checklist
        .criteria
        .iter()
        .filter(|c| c.kind != CriterionType::Flag)
        .map(|c| {
            let answer = match c.kind {
                CriterionType::Scale => {
                    let mut s = c.scale.clone();
                    s.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
                    Answer::Num(*s.get(1).or(s.first()).unwrap_or(&0.0))
                }
                _ => Answer::Text("yes".into()),
            };
            CriterionResult {
                criterion_id: c.id.clone(),
                answer,
                share: None,
                weight: c.weight,
                points: None,
                explanation: "Заглушка: модель не настроена (LLM_PROVIDER не задан).".into(),
                evidence: evidence.clone(),
                checked_range,
                na_reason: None,
            }
        })
        .collect();

    Evaluation {
        mock: true,
        conversation_id: conv.conversation_id.clone(),
        channel: conv.channel.clone(),
        language: conv.language.clone(),
        checklist_version: checklist.version,
        criteria,
        sections: vec![],
        total: None,
        gross_error: GrossError::default(),
        model: ModelInfo { name: "mock".into(), ..ModelInfo::default() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::LlmReply;
    use std::sync::{
        atomic::{AtomicUsize, Ordering::SeqCst},
        Mutex,
    };

    struct FakeLlm {
        f: Box<dyn Fn(&str, f32) -> Result<String, String> + Send + Sync>,
    }

    impl Llm for FakeLlm {
        fn model_name(&self) -> String {
            "fake".into()
        }
        fn complete(
            &self,
            _system: &str,
            user: &str,
            temperature: f32,
        ) -> impl std::future::Future<Output = Result<LlmReply, String>> + Send {
            let r = (self.f)(user, temperature).map(|text| LlmReply { text, input_tokens: 100, output_tokens: 20 });
            async move { r }
        }
    }

    fn fake(f: impl Fn(&str, f32) -> Result<String, String> + Send + Sync + 'static) -> FakeLlm {
        FakeLlm { f: Box::new(f) }
    }

    fn conv() -> Conversation {
        let t = |ts: &str, sp: &str, tx: &str| Turn { timestamp: ts.into(), speaker: sp.into(), text: tx.into() };
        Conversation {
            conversation_id: "t-001".into(),
            channel: "agent chat".into(),
            language: "RU".into(),
            transcript: vec![
                t("00:02", "client", "Добрый день, хочу узнать про комиссию."),
                t("00:15", "operator", "Здравствуйте! Меня зовут Айгерим."),
                t("00:40", "operator", "Комиссия составляет 0,1%."),
            ],
            audio_url: None,
        }
    }

    fn checklist() -> Checklist {
        serde_json::from_str(include_str!("../../config/checklist.default.json")).unwrap()
    }

    fn only(ids: &[&str]) -> Checklist {
        let mut cl = checklist();
        cl.criteria.retain(|c| ids.contains(&c.id.as_str()));
        cl
    }

    fn reply(answer: &str, idx: usize, quote: &str) -> String {
        format!(
            r#"{{"evidence":[{{"turn_index":{idx},"quote":"{quote}","role":"supports"}}],"checked_range":{{"from_turn":0,"to_turn":2}},"reasoning":"ok","answer":{answer},"na_reason":null}}"#
        )
    }

    fn reply_na() -> String {
        r#"{"evidence":[],"checked_range":{"from_turn":0,"to_turn":2},"reasoning":"неприменимо","answer":"na","na_reason":"условие выполнено"}"#.into()
    }

    const GREETING: &str = "Здравствуйте! Меня зовут Айгерим.";
    const FEE: &str = "Комиссия составляет 0,1%.";

    fn opts() -> JudgeOpts {
        JudgeOpts::default()
    }

    #[tokio::test]
    async fn full_checklist_happy_path_and_total() {
        let llm = fake(|user, _| {
            Ok(if user.contains("Критерий: Корректная") {
                reply("15", 2, FEE)
            } else if user.contains("Критерий: Управление") {
                reply("7", 1, GREETING)
            } else if user.contains("Критерий: Грубые") {
                r#"{"evidence":[],"reasoning":"нарушений нет","answer":"no"}"#.into()
            } else if ["Выявление", "Идентификация", "Завершение"].iter().any(|n| user.contains(&format!("Критерий: {n}"))) {
                reply_na()
            } else {
                reply("\"yes\"", 1, GREETING)
            })
        });
        let cl = checklist();
        let mut ev = run(&llm, &opts(), &conv(), &cl).await.unwrap();

        assert!(!ev.mock);
        assert_eq!(ev.criteria.len(), 7); // флаг в criteria не попадает
        assert!(!ev.gross_error.flag);
        // 6 одиночных вызовов + 2 шкальных критерия по 3 запуска
        assert_eq!(ev.model.calls, 12);
        assert_eq!((ev.model.input_tokens, ev.model.output_tokens), (1200, 240));

        let (total, _) = scoring::rescore(&cl, &mut ev.criteria).unwrap();
        // contact 10 + consultation 0.75*20 + empathy 15 + dialog 0.7*15 = 50.5 из 60
        assert_eq!(total, Some(84.17));
        let contact = &ev.criteria[0];
        assert_eq!(contact.evidence[0].turn_index, 1);
        assert_eq!(contact.evidence[0].speaker, "operator");
        assert_eq!(contact.evidence[0].timestamp, "00:15");
    }

    #[tokio::test]
    async fn bad_quote_is_retried_with_feedback() {
        let n = AtomicUsize::new(0);
        let prompts = std::sync::Arc::new(Mutex::new(vec![]));
        let seen = prompts.clone();
        let llm = fake(move |user, _| {
            seen.lock().unwrap().push(user.to_string());
            Ok(if n.fetch_add(1, SeqCst) == 0 {
                reply("\"yes\"", 1, "такой цитаты в диалоге нет")
            } else {
                reply("\"yes\"", 1, GREETING)
            })
        });
        let ev = run(&llm, &opts(), &conv(), &only(&["contact"])).await.unwrap();
        assert_eq!(ev.model.calls, 2);
        assert_eq!(ev.criteria[0].evidence[0].quote, GREETING);
        assert!(!ev.criteria[0].explanation.contains("не подтверждена"));
        let p = prompts.lock().unwrap();
        assert!(!p[0].contains("Предыдущий ответ отклонён"));
        assert!(p[1].contains("Предыдущий ответ отклонён"));
        assert!(p[1].contains("такой цитаты"));
    }

    #[tokio::test]
    async fn unverifiable_quote_is_dropped_and_marked() {
        let llm = fake(|_, _| Ok(reply("\"yes\"", 1, "выдуманная цитата")));
        let ev = run(&llm, &opts(), &conv(), &only(&["contact"])).await.unwrap();
        assert_eq!(ev.model.calls, 2);
        assert!(ev.criteria[0].evidence.is_empty());
        assert!(ev.criteria[0].explanation.starts_with("[цитата не подтверждена]"));
    }

    #[tokio::test]
    async fn quote_match_ignores_case_and_whitespace() {
        let llm = fake(|_, _| Ok(reply("\"yes\"", 1, "здравствуйте!   МЕНЯ зовут айгерим.")));
        let ev = run(&llm, &opts(), &conv(), &only(&["contact"])).await.unwrap();
        assert_eq!(ev.model.calls, 1);
        assert_eq!(ev.criteria[0].evidence.len(), 1);
    }

    #[tokio::test]
    async fn scale_vote_takes_lower_median() {
        let n = AtomicUsize::new(0);
        let llm = fake(move |_, t| {
            assert!(t > 0.0, "при голосовании температура выше нуля");
            let answers = ["10", "15", "15"];
            Ok(reply(answers[n.fetch_add(1, SeqCst) % 3], 2, FEE))
        });
        let ev = run(&llm, &opts(), &conv(), &only(&["consultation"])).await.unwrap();
        assert_eq!(ev.criteria[0].answer, Answer::Num(15.0));
        assert_eq!(ev.model.calls, 3);
    }

    #[tokio::test]
    async fn na_majority_wins_the_vote() {
        let n = AtomicUsize::new(0);
        let llm = fake(move |_, _| {
            Ok(if n.fetch_add(1, SeqCst) == 2 { reply("15", 2, FEE) } else { reply_na() })
        });
        let ev = run(&llm, &opts(), &conv(), &only(&["consultation"])).await.unwrap();
        assert_eq!(ev.criteria[0].answer, Answer::Text("na".into()));
        assert_eq!(ev.criteria[0].na_reason.as_deref(), Some("условие выполнено"));
    }

    #[tokio::test]
    async fn flag_goes_to_gross_error() {
        let llm = fake(|_, _| Ok(reply("\"yes\"", 2, FEE)));
        let ev = run(&llm, &opts(), &conv(), &only(&["gross"])).await.unwrap();
        assert!(ev.criteria.is_empty());
        assert!(ev.gross_error.flag);
        assert_eq!(ev.gross_error.evidence[0].turn_index, 2);
    }

    #[tokio::test]
    async fn fenced_json_and_russian_answers_are_accepted() {
        let llm = fake(|_, _| {
            Ok(format!("Вот результат:\n```json\n{}\n```", reply("\"Да\"", 1, GREETING)))
        });
        let ev = run(&llm, &opts(), &conv(), &only(&["contact"])).await.unwrap();
        assert_eq!(ev.criteria[0].answer, Answer::Text("yes".into()));
    }

    #[tokio::test]
    async fn invalid_answers_fail_with_criterion_name() {
        let llm = fake(|_, _| Ok(reply("\"maybe\"", 1, GREETING)));
        let err = run(&llm, &opts(), &conv(), &only(&["contact"])).await.unwrap_err();
        assert!(err.contains("`contact`"), "{err}");

        // значение вне шкалы
        let llm = fake(|_, _| Ok(reply("12", 2, FEE)));
        let err = run(&llm, &opts(), &conv(), &only(&["consultation"])).await.unwrap_err();
        assert!(err.contains("`consultation`"), "{err}");

        // N/A там, где он запрещён
        let llm = fake(|_, _| Ok(reply_na()));
        assert!(run(&llm, &opts(), &conv(), &only(&["contact"])).await.is_err());
    }

    #[tokio::test]
    async fn model_failure_fails_the_evaluation() {
        let llm = fake(|_, _| Err("модель недоступна".into()));
        let err = run(&llm, &opts(), &conv(), &only(&["contact"])).await.unwrap_err();
        assert!(err.contains("недоступна"));
    }

    #[test]
    fn prompt_contains_rubric_transcript_and_na_rule() {
        let cl = checklist();
        let c = cl.criteria.iter().find(|c| c.id == "consultation").unwrap();
        let p = build_prompt(CRITERION_DEFAULT, &conv(), c, &format_transcript(&conv()));
        assert!(p.contains("Критерий: Корректная и полная консультация"));
        assert!(p.contains("20 — все существенные вопросы закрыты"));
        assert!(p.contains("[0, 5, 10, 15, 20]"));
        assert!(p.contains("Чат закончился до того, как клиент сформулировал запрос."));
        assert!(p.contains("[1] 00:15 operator: Здравствуйте! Меня зовут Айгерим."));
        assert!(!p.contains("{{"), "не все плейсхолдеры подставлены");
        assert!(!p.contains("Это транскрипт звонка"));

        let mut voice = conv();
        voice.channel = "voice call".into();
        let p = build_prompt(CRITERION_DEFAULT, &voice, c, "");
        assert!(p.contains("Это транскрипт звонка"));

        let contact = cl.criteria.iter().find(|c| c.id == "contact").unwrap();
        assert!(build_prompt(CRITERION_DEFAULT, &conv(), contact, "").contains("Ответ \"na\" недопустим."));
    }

    #[test]
    fn replaced_criterion_reaches_the_prompt() {
        // Организаторы заменят критерий: промпт строится только из конфигурации.
        let mut c = checklist().criteria[0].clone();
        c.name = "Новый критерий".into();
        c.description = "Да — оператор назвал комиссию.".into();
        let p = build_prompt(CRITERION_DEFAULT, &conv(), &c, "");
        assert!(p.contains("Критерий: Новый критерий"));
        assert!(p.contains("Да — оператор назвал комиссию."));
    }

    #[tokio::test]
    async fn without_model_the_mock_is_returned() {
        let ev = evaluate(None, &opts(), &conv(), &checklist()).await.unwrap();
        assert!(ev.mock);
        assert_eq!(ev.criteria.len(), 7);
    }
}
