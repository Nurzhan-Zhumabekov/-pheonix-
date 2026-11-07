//! Расчёт итога по docs/SCORING.md. LLM сюда не входит.

use crate::model::{Answer, Checklist, Criterion, CriterionResult, CriterionType, SectionScore};
use std::collections::BTreeMap;

#[derive(Debug, PartialEq)]
pub enum ScoreError {
    UnknownCriterion(String),
    NaNotAllowed(String),
    InvalidAnswer(String),
}

impl std::fmt::Display for ScoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ScoreError::UnknownCriterion(id) => write!(f, "критерий `{id}` не найден в чек-листе"),
            ScoreError::NaNotAllowed(id) => write!(f, "для критерия `{id}` N/A не разрешён"),
            ScoreError::InvalidAnswer(id) => write!(f, "недопустимый ответ для критерия `{id}`"),
        }
    }
}

/// Округление до двух знаков, half up (допущение A1, см. docs/OPEN_QUESTIONS.md).
pub fn round2(x: f64) -> f64 {
    ((x * 100.0) + 0.5 + 1e-9).floor() / 100.0
}

fn is_na(a: &Answer) -> bool {
    matches!(a, Answer::Text(t) if t == "na")
}

/// Доля оценки: Some(0..=1) или None для N/A. Для `flag` всегда None (в итог не входит).
pub fn share(c: &Criterion, a: &Answer) -> Result<Option<f64>, ScoreError> {
    if c.kind == CriterionType::Flag {
        return Ok(None);
    }
    if is_na(a) {
        return if c.na_allowed {
            Ok(None)
        } else {
            Err(ScoreError::NaNotAllowed(c.id.clone()))
        };
    }
    match (c.kind, a) {
        (CriterionType::Binary, Answer::Text(t)) if t == "yes" => Ok(Some(1.0)),
        (CriterionType::Binary, Answer::Text(t)) if t == "no" => Ok(Some(0.0)),
        (CriterionType::Scale, Answer::Num(v)) => {
            let max = c.scale.iter().cloned().fold(f64::MIN, f64::max);
            if max > 0.0 && c.scale.iter().any(|s| (s - v).abs() < 1e-9) {
                Ok(Some(v / max))
            } else if max <= 0.0 && c.scale.iter().any(|s| (s - v).abs() < 1e-9) {
                Ok(Some(0.0))
            } else {
                Err(ScoreError::InvalidAnswer(c.id.clone()))
            }
        }
        _ => Err(ScoreError::InvalidAnswer(c.id.clone())),
    }
}

/// 100 × Σ(вес × доля) / Σ(вес) по применимым критериям с весом. None, если таких нет.
fn total_of<'a>(items: impl Iterator<Item = (f64, Option<f64>)> + 'a) -> Option<f64> {
    let (mut points, mut weights) = (0.0, 0.0);
    for (w, s) in items {
        if let Some(s) = s {
            if w > 0.0 {
                points += w * s;
                weights += w;
            }
        }
    }
    if weights > 0.0 {
        Some(round2(100.0 * points / weights))
    } else {
        None
    }
}

/// Пересчитывает доли, баллы, итог и итоги секций. Веса берутся из чек-листа.
pub fn rescore(
    checklist: &Checklist,
    results: &mut [CriterionResult],
) -> Result<(Option<f64>, Vec<SectionScore>), ScoreError> {
    let mut per_item: Vec<(Option<&str>, f64, Option<f64>)> = vec![];
    for r in results.iter_mut() {
        let c = checklist
            .criteria
            .iter()
            .find(|c| c.id == r.criterion_id)
            .ok_or_else(|| ScoreError::UnknownCriterion(r.criterion_id.clone()))?;
        let s = share(c, &r.answer)?;
        r.weight = c.weight;
        r.share = s;
        r.points = s.map(|s| c.weight * s);
        per_item.push((c.section.as_deref(), c.weight, s));
    }

    let total = total_of(per_item.iter().map(|(_, w, s)| (*w, *s)));

    let mut by_section: BTreeMap<&str, Vec<(f64, Option<f64>)>> = BTreeMap::new();
    for (sec, w, s) in &per_item {
        if let Some(sec) = sec {
            by_section.entry(*sec).or_default().push((*w, *s));
        }
    }
    let sections = checklist
        .sections
        .iter()
        .map(|sec| SectionScore {
            id: sec.id.clone(),
            score: by_section
                .get(sec.id.as_str())
                .and_then(|v| total_of(v.iter().cloned())),
        })
        .collect();

    Ok((total, sections))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Section;

    fn crit(id: &str, kind: CriterionType, weight: f64, scale: &[f64], na: bool, sec: &str) -> Criterion {
        Criterion {
            id: id.into(),
            name: id.into(),
            description: String::new(),
            kind,
            weight,
            scale: scale.to_vec(),
            na_allowed: na,
            na_condition: None,
            section: Some(sec.into()),
        }
    }

    fn default_checklist() -> Checklist {
        serde_json::from_str(include_str!("../../config/checklist.default.json")).unwrap()
    }

    fn res(id: &str, a: Answer) -> CriterionResult {
        CriterionResult {
            criterion_id: id.into(),
            answer: a,
            share: None,
            weight: 0.0,
            points: None,
            explanation: String::new(),
            evidence: vec![],
            checked_range: None,
            na_reason: None,
        }
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

    fn doc_example(consult: f64) -> Vec<CriterionResult> {
        vec![
            res("contact", yes()),
            res("needs", na()),
            res("identification", yes()),
            res("consultation", Answer::Num(consult)),
            res("empathy", no()),
            res("dialog", Answer::Num(7.0)),
            res("closing", yes()),
        ]
    }

    #[test]
    fn example_from_scoring_doc() {
        let cl = default_checklist();
        let mut r = doc_example(15.0);
        let (total, _) = rescore(&cl, &mut r).unwrap();
        assert_eq!(total, Some(71.18));
        let dialog = r.iter().find(|x| x.criterion_id == "dialog").unwrap();
        assert!((dialog.points.unwrap() - 10.5).abs() < 1e-9);
        let needs = r.iter().find(|x| x.criterion_id == "needs").unwrap();
        assert_eq!(needs.points, None);
    }

    #[test]
    fn appeal_example_recalculates() {
        let cl = default_checklist();
        let mut r = doc_example(20.0);
        let (total, _) = rescore(&cl, &mut r).unwrap();
        assert_eq!(total, Some(77.06));
    }

    #[test]
    fn section_scores() {
        let cl = default_checklist();
        let mut r = doc_example(15.0);
        let (_, sections) = rescore(&cl, &mut r).unwrap();
        let get = |id: &str| sections.iter().find(|s| s.id == id).unwrap().score;
        // start: contact=yes(10), needs=N/A -> 100
        assert_eq!(get("start"), Some(100.0));
        // safety: identification=yes(20), consultation=15/20 (20) -> 87.5
        assert_eq!(get("safety"), Some(87.5));
        // flow: empathy=no(15)=0, dialog=0.7*15=10.5, closing=5 -> 15.5/35 = 44.29
        assert_eq!(get("flow"), Some(44.29));
        // gross: нет весов -> нет итога
        assert_eq!(get("gross"), None);
    }

    #[test]
    fn all_na_gives_no_total() {
        let cl = Checklist {
            version: 1,
            sections: vec![],
            criteria: vec![
                crit("a", CriterionType::Binary, 10.0, &[], true, "s"),
                crit("b", CriterionType::Binary, 5.0, &[], true, "s"),
            ],
        };
        let mut r = vec![res("a", na()), res("b", na())];
        assert_eq!(rescore(&cl, &mut r).unwrap().0, None);
    }

    #[test]
    fn single_applicable_criterion() {
        let cl = Checklist {
            version: 1,
            sections: vec![],
            criteria: vec![
                crit("a", CriterionType::Binary, 10.0, &[], true, "s"),
                crit("b", CriterionType::Binary, 5.0, &[], true, "s"),
            ],
        };
        let mut r = vec![res("a", na()), res("b", yes())];
        assert_eq!(rescore(&cl, &mut r).unwrap().0, Some(100.0));
    }

    #[test]
    fn zero_weight_criteria_are_ignored() {
        let cl = Checklist {
            version: 1,
            sections: vec![],
            criteria: vec![
                crit("a", CriterionType::Binary, 0.0, &[], false, "s"),
                crit("b", CriterionType::Binary, 10.0, &[], false, "s"),
            ],
        };
        let mut r = vec![res("a", yes()), res("b", no())];
        assert_eq!(rescore(&cl, &mut r).unwrap().0, Some(0.0));
    }

    #[test]
    fn rounding_is_half_up() {
        // 1/32 от шкалы 0..32 даёт ровно 3.125 -> 3.13
        let cl = Checklist {
            version: 1,
            sections: vec![Section { id: "s".into(), name: "s".into() }],
            criteria: vec![crit("a", CriterionType::Scale, 1.0, &[0.0, 1.0, 32.0], false, "s")],
        };
        let mut r = vec![res("a", Answer::Num(1.0))];
        assert_eq!(rescore(&cl, &mut r).unwrap().0, Some(3.13));
    }

    #[test]
    fn changed_scale_is_applied() {
        let mut cl = default_checklist();
        let c = cl.criteria.iter_mut().find(|c| c.id == "consultation").unwrap();
        c.scale = vec![0.0, 10.0];
        c.weight = 50.0;
        let mut r = vec![res("consultation", Answer::Num(10.0)), res("contact", no())];
        // consultation: полный вес 50, contact: 0 из 10 -> 100*50/60 = 83.33
        assert_eq!(rescore(&cl, &mut r).unwrap().0, Some(83.33));
    }

    #[test]
    fn flag_does_not_affect_total() {
        let cl = default_checklist();
        let mut r = vec![res("contact", yes()), res("gross", yes())];
        assert_eq!(rescore(&cl, &mut r).unwrap().0, Some(100.0));
    }

    #[test]
    fn invalid_answers_are_rejected() {
        let cl = default_checklist();
        // N/A там, где не разрешён
        let mut r = vec![res("contact", na())];
        assert_eq!(rescore(&cl, &mut r), Err(ScoreError::NaNotAllowed("contact".into())));
        // значение вне шкалы
        let mut r = vec![res("consultation", Answer::Num(12.0))];
        assert_eq!(rescore(&cl, &mut r), Err(ScoreError::InvalidAnswer("consultation".into())));
        // число для бинарного
        let mut r = vec![res("contact", Answer::Num(1.0))];
        assert_eq!(rescore(&cl, &mut r), Err(ScoreError::InvalidAnswer("contact".into())));
        // неизвестный критерий
        let mut r = vec![res("nope", yes())];
        assert_eq!(rescore(&cl, &mut r), Err(ScoreError::UnknownCriterion("nope".into())));
    }
}
