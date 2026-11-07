//! Загрузка диалогов из API организаторов.
//! Адрес содержит подпись: его нельзя выводить в ответы и логи.

use crate::model::Conversation;
use serde::Deserialize;

#[derive(Deserialize)]
struct ApiResponse {
    #[serde(default)]
    error: String,
    #[serde(rename = "isSuccess")]
    is_success: bool,
    data: Option<ApiData>,
}

#[derive(Deserialize)]
struct ApiData {
    records: Vec<Conversation>,
}

pub async fn fetch(url: &str) -> Result<Vec<Conversation>, String> {
    let resp = reqwest::get(url)
        .await
        .map_err(|e| format!("запрос к API организаторов не удался: {}", e.without_url()))?;
    if !resp.status().is_success() {
        return Err(format!("API организаторов ответил статусом {}", resp.status()));
    }
    let body: ApiResponse = resp
        .json()
        .await
        .map_err(|e| format!("не удалось разобрать ответ API организаторов: {}", e.without_url()))?;
    if !body.is_success {
        return Err(format!("API организаторов вернул ошибку: {}", body.error));
    }
    body.data
        .map(|d| d.records)
        .ok_or_else(|| "в ответе API организаторов нет data.records".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_organizer_format() {
        let json = r#"{ "error": "", "isSuccess": true, "data": {
            "dataset_group_id": "DEV", "total_records": 1,
            "records": [{
              "conversation_id": "p1-ru-001", "channel": "agent chat", "language": "RU",
              "transcript": [{"timestamp": "00:02", "speaker": "operator", "text": "Здравствуйте!"}],
              "audio_url": null }]}}"#;
        let body: ApiResponse = serde_json::from_str(json).unwrap();
        let recs = body.data.unwrap().records;
        assert_eq!(recs[0].conversation_id, "p1-ru-001");
        assert_eq!(recs[0].transcript[0].timestamp, "00:02");
        assert!(recs[0].audio_url.is_none());
    }
}
