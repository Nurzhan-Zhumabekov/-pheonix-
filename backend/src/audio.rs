//! Запись звонка. В данных организаторов `audio_url` ведёт на HTML-страницу их плеера, а не на аудиофайл,
//! поэтому `<audio src=audio_url>` не воспроизводится («Format error»). Берём адрес файла со страницы
//! и перенаправляем на него: браузер сам запрашивает нужные куски (Range), перемотка работает.
//! Адреса не попадают ни в ответы об ошибках, ни в лог.
use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::json;

use crate::{api::Shared, model::Conversation};

/// Страница плеера весит пару килобайт; больше миллиона байт это уже не она.
const MAX_PAGE_BYTES: u64 = 1_000_000;

pub fn router(state: Shared) -> Router {
    Router::new().route("/api/conversations/{id}/audio", get(audio)).with_state(state)
}

fn fail(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "error": { "code": code, "message": message } }))).into_response()
}

async fn audio(State(st): State<Shared>, Path(id): Path<String>) -> Response {
    let found = ["dev", "control"].iter().find_map(|group| {
        st.store
            .read::<Vec<Conversation>>(&format!("conversations_{group}.json"))
            .and_then(|list| list.into_iter().find(|c| c.conversation_id == id))
    });
    let Some(conversation) = found else {
        return fail(StatusCode::NOT_FOUND, "no_conversation", "диалог не найден");
    };
    let Some(page_url) = conversation.audio_url.filter(|u| !u.trim().is_empty()) else {
        return fail(StatusCode::NOT_FOUND, "no_audio", "у диалога нет записи");
    };
    match resolve(&page_url).await {
        Ok(target) => (StatusCode::FOUND, [(header::LOCATION, target)]).into_response(),
        Err(message) => fail(StatusCode::BAD_GATEWAY, "audio_unavailable", &message),
    }
}

async fn resolve(page_url: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(page_url).map_err(|_| "адрес записи не разобран".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("адрес записи должен быть http или https".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "http-клиент не создан".to_string())?;
    let resp = client
        .get(url.clone())
        .send()
        .await
        .map_err(|_| "страница записи не открылась".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("страница записи ответила кодом {}", resp.status().as_u16()));
    }
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.starts_with("audio/") {
        // Ссылка сразу на файл: тело не читаем, соединение закроется при выходе из функции.
        return Ok(url.to_string());
    }
    if resp.content_length().is_some_and(|n| n > MAX_PAGE_BYTES) {
        return Err("страница записи слишком большая".into());
    }
    let page = resp.text().await.map_err(|_| "страница записи не прочитана".to_string())?;
    source_from_page(&page, &url).ok_or_else(|| "на странице записи нет адреса файла".to_string())
}

/// Адрес файла из первого `<source src>` (или `<audio src>`); относительный адрес достраивается от страницы.
fn source_from_page(page: &str, base: &reqwest::Url) -> Option<String> {
    // Нижний регистр ASCII не меняет длину в байтах, поэтому позиции годятся и для `page`.
    let lower = page.to_ascii_lowercase();
    for tag in ["<source", "<audio"] {
        let mut from = 0;
        while let Some(pos) = lower[from..].find(tag) {
            let start = from + pos;
            let end = lower[start..].find('>').map_or(lower.len(), |e| start + e);
            if let Some(value) = attr(&page[start..end], "src") {
                let value = value.replace("&amp;", "&");
                if let Ok(target) = base.join(&value) {
                    if matches!(target.scheme(), "http" | "https") {
                        return Some(target.to_string());
                    }
                }
            }
            from = end;
        }
    }
    None
}

/// Значение атрибута `name` внутри одного тега; `data-src` и подобные не считаются.
fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(pos) = lower[from..].find(name) {
        let at = from + pos;
        let after_space = at > 0 && lower.as_bytes()[at - 1].is_ascii_whitespace();
        let rest = tag[at + name.len()..].trim_start();
        if after_space && rest.starts_with('=') {
            let value = rest[1..].trim_start();
            let quote = value.chars().next()?;
            if quote == '"' || quote == '\'' {
                let inner = &value[1..];
                return inner.find(quote).map(|e| &inner[..e]);
            }
            let end = value.find(|c: char| c.is_whitespace() || c == '>').unwrap_or(value.len());
            return Some(&value[..end]);
        }
        from = at + name.len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> reqwest::Url {
        reqwest::Url::parse("https://pages.example/play?id=1").unwrap()
    }

    #[test]
    fn takes_file_from_source_tag() {
        let page = r#"<audio id="a" controls><source src="https://files.example/a.mp3?x=1&amp;y=2" type="audio/mpeg"></audio>"#;
        assert_eq!(
            source_from_page(page, &base()).as_deref(),
            Some("https://files.example/a.mp3?x=1&y=2")
        );
    }

    #[test]
    fn relative_address_is_resolved_against_the_page() {
        let page = "<SOURCE SRC='/media/a.mp3' TYPE='audio/mpeg'>";
        assert_eq!(source_from_page(page, &base()).as_deref(), Some("https://pages.example/media/a.mp3"));
    }

    #[test]
    fn src_on_the_audio_tag_is_used_when_there_is_no_source_tag() {
        let page = r#"<audio controls src="https://files.example/b.wav"></audio>"#;
        assert_eq!(source_from_page(page, &base()).as_deref(), Some("https://files.example/b.wav"));
    }

    #[test]
    fn page_without_a_file_gives_nothing() {
        assert_eq!(source_from_page("<html><body><h3>Запись</h3></body></html>", &base()), None);
        assert_eq!(source_from_page("", &base()), None);
    }

    #[test]
    fn data_src_and_foreign_schemes_are_ignored() {
        assert_eq!(source_from_page(r#"<source data-src="https://files.example/c.mp3">"#, &base()), None);
        assert_eq!(source_from_page(r#"<source src="javascript:alert(1)">"#, &base()), None);
    }
}
