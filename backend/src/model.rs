use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

// ---- Чек-лист ----

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Checklist {
    pub version: u32,
    #[serde(default)]
    pub sections: Vec<Section>,
    pub criteria: Vec<Criterion>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Section {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CriterionType {
    Binary,
    Scale,
    Flag,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Criterion {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "type")]
    pub kind: CriterionType,
    #[serde(default)]
    pub weight: f64,
    #[serde(default)]
    pub scale: Vec<f64>,
    #[serde(default)]
    pub na_allowed: bool,
    #[serde(default)]
    pub na_condition: Option<String>,
    #[serde(default)]
    pub section: Option<String>,
}

// ---- Диалоги (формат API организаторов) ----

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Turn {
    pub timestamp: String,
    pub speaker: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Conversation {
    pub conversation_id: String,
    pub channel: String,
    pub language: String,
    pub transcript: Vec<Turn>,
    #[serde(default)]
    pub audio_url: Option<String>,
}

// ---- Результат оценки ----

/// "yes" | "no" | "na" или число из шкалы.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum Answer {
    Num(f64),
    Text(String),
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Evidence {
    pub turn_index: usize,
    pub speaker: String,
    pub timestamp: String,
    pub quote: String,
    /// "supports" или "expected_location"
    pub role: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct TurnRange {
    pub from_turn: usize,
    pub to_turn: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CriterionResult {
    pub criterion_id: String,
    pub answer: Answer,
    pub share: Option<f64>,
    pub weight: f64,
    pub points: Option<f64>,
    pub explanation: String,
    pub evidence: Vec<Evidence>,
    pub checked_range: Option<TurnRange>,
    pub na_reason: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SectionScore {
    pub id: String,
    pub score: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct GrossError {
    pub flag: bool,
    pub explanation: Option<String>,
    pub evidence: Vec<Evidence>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ModelInfo {
    pub name: String,
    pub calls: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Evaluation {
    pub mock: bool,
    pub conversation_id: String,
    /// Идентификатор этого сохранённого результата. Апелляция привязана к нему.
    #[serde(default)]
    pub evaluation_id: String,
    pub channel: String,
    pub language: String,
    pub checklist_version: u32,
    pub criteria: Vec<CriterionResult>,
    pub sections: Vec<SectionScore>,
    pub total: Option<f64>,
    pub gross_error: GrossError,
    pub model: ModelInfo,
}

// ---- Апелляции ----

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AnswerPoints {
    pub answer: Answer,
    pub points: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Decision {
    pub action: String,
    pub new_answer: Option<Answer>,
    pub reason: String,
    pub decided_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Appeal {
    pub id: String,
    pub conversation_id: String,
    /// Оценка, по которой подана апелляция. Пусто у апелляций, созданных до появления поля.
    #[serde(default)]
    pub evaluation_id: String,
    pub criterion_id: String,
    pub comment: String,
    pub fragment: Option<TurnRange>,
    /// "open" | "resolved"
    pub status: String,
    pub created_at: String,
    pub original: AnswerPoints,
    pub decision: Option<Decision>,
    #[serde(rename = "final")]
    pub fin: Option<AnswerPoints>,
    pub total_before: Option<f64>,
    pub total_after: Option<f64>,
}

// ---- Ручная разметка (формат утверждён в docs/coordination/BOARD.md) ----

/// Нет ключа в `answers` значит «не размечено», `"na"` явный N/A, `gross: None` не размечено.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Label {
    pub checklist_version: u32,
    #[serde(default)]
    pub answers: BTreeMap<String, Answer>,
    #[serde(default)]
    pub gross: Option<bool>,
    #[serde(default)]
    pub labeler: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub updated_at: String,
}
