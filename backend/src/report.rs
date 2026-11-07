//! Согласие модели с ручной разметкой. Сравниваются только размеченные поля
//! и только если версия метки совпадает с версией оценки.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::{model::*, scoring};

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Report {
    pub conversations: ConvStats,
    pub criteria: Vec<CriterionStats>,
    pub na: NaStats,
    pub gross: GrossStats,
    pub total: TotalStats,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct ConvStats {
    pub labeled: usize,
    pub evaluated_and_labeled: usize,
    pub compared: usize,
    pub skipped_no_evaluation: Vec<String>,
    pub skipped_version_mismatch: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct CriterionStats {
    pub criterion_id: String,
    pub compared: usize,
    pub exact: usize,
    pub exact_rate: Option<f64>,
    /// Только для шкальных критериев.
    pub scale_compared: usize,
    pub within_one_step: usize,
    pub within_one_step_rate: Option<f64>,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct NaStats {
    pub both_na: usize,
    pub label_only_na: usize,
    pub model_only_na: usize,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct GrossStats {
    pub compared: usize,
    pub agree: usize,
    pub label_yes_model_no: usize,
    pub label_no_model_yes: usize,
}

/// Итог разметки считается, только если размечены все критерии кроме флага.
#[derive(Serialize, Debug, Default, PartialEq)]
pub struct TotalStats {
    pub compared: usize,
    pub unavailable: usize,
    pub mean_abs_diff: Option<f64>,
    pub max_abs_diff: Option<f64>,
}

#[derive(Default)]
struct Acc {
    compared: usize,
    exact: usize,
    scale_compared: usize,
    within: usize,
}

fn is_na(a: &Answer) -> bool {
    matches!(a, Answer::Text(t) if t == "na")
}

fn same(a: &Answer, b: &Answer) -> bool {
    match (a, b) {
        (Answer::Num(x), Answer::Num(y)) => (x - y).abs() < 1e-9,
        (Answer::Text(x), Answer::Text(y)) => x == y,
        _ => false,
    }
}

fn step_index(scale: &[f64], v: f64) -> Option<usize> {
    let mut s = scale.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    s.iter().position(|x| (x - v).abs() < 1e-9)
}

/// Числовые ответы отличаются не больше чем на одну ступень шкалы. N/A сюда не входит.
fn within_one_step(c: &Criterion, a: &Answer, b: &Answer) -> bool {
    match (a, b) {
        (Answer::Num(x), Answer::Num(y)) => {
            matches!((step_index(&c.scale, *x), step_index(&c.scale, *y)), (Some(i), Some(j)) if i.abs_diff(j) <= 1)
        }
        _ => false,
    }
}

fn rate(n: usize, d: usize) -> Option<f64> {
    (d > 0).then(|| (n as f64 / d as f64 * 1000.0).round() / 1000.0)
}

fn blank_result(id: &str, answer: Answer) -> CriterionResult {
    CriterionResult {
        criterion_id: id.into(),
        answer,
        share: None,
        weight: 0.0,
        points: None,
        explanation: String::new(),
        evidence: vec![],
        checked_range: None,
        na_reason: None,
    }
}

/// `evals` содержит оценки по id диалога. `checklist_of` отдаёт чек-лист версии из архива.
pub fn build_report(
    checklist_of: impl Fn(u32) -> Option<Checklist>,
    labels: &BTreeMap<String, Label>,
    evals: &BTreeMap<String, Evaluation>,
) -> Report {
    let mut r = Report::default();
    r.conversations.labeled = labels.len();
    let mut accs: Vec<(String, Acc)> = vec![];
    let (mut sum_diff, mut max_diff, mut diffs) = (0.0_f64, 0.0_f64, 0usize);

    for (id, label) in labels {
        let Some(ev) = evals.get(id) else {
            r.conversations.skipped_no_evaluation.push(id.clone());
            continue;
        };
        r.conversations.evaluated_and_labeled += 1;
        let cl = match checklist_of(label.checklist_version) {
            Some(cl) if ev.checklist_version == label.checklist_version => cl,
            _ => {
                r.conversations.skipped_version_mismatch.push(id.clone());
                continue;
            }
        };
        r.conversations.compared += 1;

        for c in cl.criteria.iter().filter(|c| c.kind != CriterionType::Flag) {
            let (Some(la), Some(res)) = (
                label.answers.get(&c.id),
                ev.criteria.iter().find(|x| x.criterion_id == c.id),
            ) else {
                continue;
            };
            let idx = match accs.iter().position(|(k, _)| *k == c.id) {
                Some(i) => i,
                None => {
                    accs.push((c.id.clone(), Acc::default()));
                    accs.len() - 1
                }
            };
            let acc = &mut accs[idx].1;
            acc.compared += 1;
            if same(la, &res.answer) {
                acc.exact += 1;
            }
            if c.kind == CriterionType::Scale {
                acc.scale_compared += 1;
                if within_one_step(c, la, &res.answer) {
                    acc.within += 1;
                }
            }
            match (is_na(la), is_na(&res.answer)) {
                (true, true) => r.na.both_na += 1,
                (true, false) => r.na.label_only_na += 1,
                (false, true) => r.na.model_only_na += 1,
                _ => {}
            }
        }

        if let Some(label_gross) = label.gross {
            let model_gross = ev.gross_error.flag;
            r.gross.compared += 1;
            match (label_gross, model_gross) {
                (a, b) if a == b => r.gross.agree += 1,
                (true, false) => r.gross.label_yes_model_no += 1,
                _ => r.gross.label_no_model_yes += 1,
            }
        }

        let weighted: Vec<&Criterion> = cl.criteria.iter().filter(|c| c.kind != CriterionType::Flag).collect();
        let complete = weighted.iter().all(|c| label.answers.contains_key(&c.id));
        let label_total = if complete {
            let mut rs: Vec<CriterionResult> = weighted
                .iter()
                .map(|c| blank_result(&c.id, label.answers[&c.id].clone()))
                .collect();
            scoring::rescore(&cl, &mut rs).ok().and_then(|(t, _)| t)
        } else {
            None
        };
        match (label_total, ev.total) {
            (Some(a), Some(b)) => {
                let d = (a - b).abs();
                sum_diff += d;
                max_diff = max_diff.max(d);
                diffs += 1;
            }
            _ => r.total.unavailable += 1,
        }
    }

    r.criteria = accs
        .into_iter()
        .map(|(criterion_id, a)| CriterionStats {
            criterion_id,
            compared: a.compared,
            exact: a.exact,
            exact_rate: rate(a.exact, a.compared),
            scale_compared: a.scale_compared,
            within_one_step: a.within,
            within_one_step_rate: rate(a.within, a.scale_compared),
        })
        .collect();
    r.total.compared = diffs;
    if diffs > 0 {
        r.total.mean_abs_diff = Some(scoring::round2(sum_diff / diffs as f64));
        r.total.max_abs_diff = Some(scoring::round2(max_diff));
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cl() -> Checklist {
        serde_json::from_str(include_str!("../../config/checklist.default.json")).unwrap()
    }
    fn yes() -> Answer {
        Answer::Text("yes".into())
    }
    fn no() -> Answer {
        Answer::Text("no".into())
    }
    fn na() -> Answer {
        Answer::Text("na".into())
    }
    fn num(x: f64) -> Answer {
        Answer::Num(x)
    }

    fn ev(version: u32, answers: &[(&str, Answer)], gross: bool, total: Option<f64>) -> Evaluation {
        Evaluation {
            mock: false,
            conversation_id: "x".into(),
            channel: "agent chat".into(),
            language: "RU".into(),
            checklist_version: version,
            criteria: answers.iter().map(|(id, a)| blank_result(id, a.clone())).collect(),
            sections: vec![],
            total,
            gross_error: GrossError { flag: gross, explanation: None, evidence: vec![] },
            model: ModelInfo::default(),
        }
    }

    fn lab(version: u32, answers: &[(&str, Answer)], gross: Option<bool>) -> Label {
        Label {
            checklist_version: version,
            answers: answers.iter().map(|(id, a)| (id.to_string(), a.clone())).collect(),
            gross,
            labeler: "n".into(),
            note: String::new(),
            updated_at: String::new(),
        }
    }

    fn one(label: Label, eval: Evaluation) -> Report {
        let labels = BTreeMap::from([("c1".to_string(), label)]);
        let evals = BTreeMap::from([("c1".to_string(), eval)]);
        build_report(|v| (v == 1).then(cl), &labels, &evals)
    }

    fn stats<'a>(r: &'a Report, id: &str) -> &'a CriterionStats {
        r.criteria.iter().find(|c| c.criterion_id == id).unwrap()
    }

    #[test]
    fn perfect_match() {
        let r = one(
            lab(1, &[("contact", yes()), ("consultation", num(15.0))], Some(false)),
            ev(1, &[("contact", yes()), ("consultation", num(15.0)), ("empathy", yes())], false, None),
        );
        assert_eq!(r.conversations.compared, 1);
        assert_eq!(stats(&r, "contact").exact_rate, Some(1.0));
        assert_eq!(stats(&r, "consultation").exact_rate, Some(1.0));
        assert_eq!(stats(&r, "consultation").within_one_step_rate, Some(1.0));
        assert!(r.criteria.iter().all(|c| c.criterion_id != "empathy"), "не размечено: не сравниваем");
        assert_eq!(r.gross, GrossStats { compared: 1, agree: 1, label_yes_model_no: 0, label_no_model_yes: 0 });
    }

    #[test]
    fn scale_within_one_step() {
        // шкала консультации 0/5/10/15/20: 15 и 20 соседние, 5 и 20 нет
        let near = one(lab(1, &[("consultation", num(15.0))], None), ev(1, &[("consultation", num(20.0))], false, None));
        let s = stats(&near, "consultation");
        assert_eq!((s.exact, s.within_one_step, s.scale_compared), (0, 1, 1));

        let far = one(lab(1, &[("consultation", num(5.0))], None), ev(1, &[("consultation", num(20.0))], false, None));
        assert_eq!(stats(&far, "consultation").within_one_step, 0);

        // N/A и число не считаются соседними ступенями
        let with_na = one(lab(1, &[("consultation", na())], None), ev(1, &[("consultation", num(20.0))], false, None));
        assert_eq!(stats(&with_na, "consultation").within_one_step, 0);
    }

    #[test]
    fn na_agreement_is_counted_separately() {
        let r = one(
            lab(1, &[("needs", na()), ("identification", na()), ("closing", yes())], None),
            ev(1, &[("needs", na()), ("identification", yes()), ("closing", na())], false, None),
        );
        assert_eq!(r.na, NaStats { both_na: 1, label_only_na: 1, model_only_na: 1 });
    }

    #[test]
    fn skips_missing_evaluation_and_version_mismatch() {
        let labels = BTreeMap::from([
            ("a".to_string(), lab(1, &[("contact", yes())], None)),
            ("b".to_string(), lab(1, &[("contact", yes())], None)),
            ("c".to_string(), lab(2, &[("contact", yes())], None)),
        ]);
        let evals = BTreeMap::from([
            ("a".to_string(), ev(1, &[("contact", yes())], false, None)),
            ("c".to_string(), ev(2, &[("contact", yes())], false, None)), // версии 2 в архиве нет
        ]);
        let r = build_report(|v| (v == 1).then(cl), &labels, &evals);
        assert_eq!(r.conversations.labeled, 3);
        assert_eq!(r.conversations.evaluated_and_labeled, 2);
        assert_eq!(r.conversations.compared, 1);
        assert_eq!(r.conversations.skipped_no_evaluation, vec!["b"]);
        assert_eq!(r.conversations.skipped_version_mismatch, vec!["c"]);

        // оценка другой версии, чем метка
        let r = one(lab(1, &[("contact", yes())], None), ev(2, &[("contact", yes())], false, None));
        assert_eq!(r.conversations.compared, 0);
        assert_eq!(r.conversations.skipped_version_mismatch, vec!["c1"]);
        assert!(r.criteria.is_empty());
    }

    #[test]
    fn gross_confusion_and_unlabeled_gross() {
        let both = |label_gross, model_gross| {
            one(lab(1, &[("contact", yes())], label_gross), ev(1, &[("contact", yes())], model_gross, None)).gross
        };
        assert_eq!(both(Some(true), false).label_yes_model_no, 1);
        assert_eq!(both(Some(false), true).label_no_model_yes, 1);
        assert_eq!(both(Some(true), true).agree, 1);
        assert_eq!(both(None, true).compared, 0, "gross: null не размечен");
    }

    #[test]
    fn total_difference_only_for_fully_labeled() {
        // пример из SCORING.md: итог разметки 71.18
        let full = [
            ("contact", yes()),
            ("needs", na()),
            ("identification", yes()),
            ("consultation", num(15.0)),
            ("empathy", no()),
            ("dialog", num(7.0)),
            ("closing", yes()),
        ];
        let r = one(lab(1, &full, Some(false)), ev(1, &full, false, Some(75.0)));
        assert_eq!(r.total.compared, 1);
        assert_eq!(r.total.mean_abs_diff, Some(3.82));
        assert_eq!(r.total.max_abs_diff, Some(3.82));

        // размечена только часть критериев: итог не сравниваем
        let partial = one(lab(1, &full[..3], None), ev(1, &full, false, Some(75.0)));
        assert_eq!((partial.total.compared, partial.total.unavailable), (0, 1));
        assert_eq!(partial.total.mean_abs_diff, None);

        // у модели нет итога
        let no_model_total = one(lab(1, &full, None), ev(1, &full, false, None));
        assert_eq!((no_model_total.total.compared, no_model_total.total.unavailable), (0, 1));
    }

    #[test]
    fn criteria_follow_checklist_order() {
        let r = one(
            lab(1, &[("closing", yes()), ("contact", yes())], None),
            ev(1, &[("closing", yes()), ("contact", yes())], false, None),
        );
        let ids: Vec<&str> = r.criteria.iter().map(|c| c.criterion_id.as_str()).collect();
        assert_eq!(ids, vec!["contact", "closing"]);
    }
}
