//! Клиент модели. Два протокола: Anthropic Messages и OpenAI-совместимый chat/completions
//! (подходит для OpenAI, Ollama, LM Studio, vLLM). Ключ не пишется в логи и ошибки.

use std::{future::Future, time::Duration};

use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    Anthropic,
    OpenAi,
}

#[derive(Debug, Clone, Default)]
pub struct LlmReply {
    pub text: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

pub trait Llm: Sync {
    fn model_name(&self) -> String;
    fn complete(
        &self,
        system: &str,
        user: &str,
        temperature: f32,
    ) -> impl Future<Output = Result<LlmReply, String>> + Send;
}

pub struct RealLlm {
    provider: Provider,
    model: String,
    api_key: Option<String>,
    base_url: String,
    max_tokens: u32,
    /// Только для openai-протокола: `none`, `low`, `medium`, `high`. Для «думающих» моделей
    /// (например, Qwen3.5 в Ollama) `none` отключает рассуждения, иначе они съедают контекст.
    reasoning_effort: Option<String>,
    client: reqwest::Client,
}

const RETRIES: u32 = 3;

impl RealLlm {
    /// `Ok(None)`, если `LLM_PROVIDER` не задан: тогда judge работает на заглушке.
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        let Some(raw) = get("LLM_PROVIDER") else {
            return Ok(None);
        };
        let provider = match raw.trim().to_lowercase().as_str() {
            "anthropic" => Provider::Anthropic,
            "openai" => Provider::OpenAi,
            other => return Err(format!("LLM_PROVIDER: нужно anthropic или openai, получено `{other}`")),
        };
        let model = get("LLM_MODEL").ok_or("LLM_MODEL не задан")?;
        let base_url = get("LLM_BASE_URL");
        let api_key = get("LLM_API_KEY");
        // Локальный OpenAI-совместимый сервер (Ollama и т.п.) работает без ключа.
        if api_key.is_none() && (provider == Provider::Anthropic || base_url.is_none()) {
            return Err("LLM_API_KEY не задан".into());
        }
        let default_base = match provider {
            Provider::Anthropic => "https://api.anthropic.com",
            Provider::OpenAi => "https://api.openai.com/v1",
        };
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Some(RealLlm {
            provider,
            model,
            api_key,
            base_url: base_url.unwrap_or_else(|| default_base.into()).trim_end_matches('/').to_string(),
            max_tokens: get("LLM_MAX_TOKENS").and_then(|v| v.parse().ok()).unwrap_or(1024),
            reasoning_effort: get("LLM_REASONING_EFFORT"),
            client,
        }))
    }

    pub fn describe(&self) -> String {
        let p = match self.provider {
            Provider::Anthropic => "anthropic",
            Provider::OpenAi => "openai",
        };
        format!("{p}:{}", self.model)
    }

    fn request(&self, system: &str, user: &str, temperature: f32) -> (String, Value) {
        match self.provider {
            Provider::Anthropic => (
                format!("{}/v1/messages", self.base_url),
                json!({
                    "model": self.model,
                    "max_tokens": self.max_tokens,
                    "temperature": temperature,
                    "system": system,
                    "messages": [{ "role": "user", "content": user }],
                }),
            ),
            // max_tokens не отправляем: новые модели OpenAI требуют другое имя параметра.
            Provider::OpenAi => {
                let mut body = json!({
                    "model": self.model,
                    "messages": [
                        { "role": "system", "content": system },
                        { "role": "user", "content": user },
                    ],
                });
                // Модели с рассуждениями не принимают temperature: при включённых
                // рассуждениях (effort задан и не none) параметр не отправляем.
                let thinking = self.reasoning_effort.as_deref().is_some_and(|e| e != "none");
                if !thinking {
                    body["temperature"] = json!(temperature);
                }
                if let Some(effort) = &self.reasoning_effort {
                    body["reasoning_effort"] = json!(effort);
                }
                (format!("{}/chat/completions", self.base_url), body)
            }
        }
    }
}

impl Llm for RealLlm {
    fn model_name(&self) -> String {
        self.model.clone()
    }

    async fn complete(&self, system: &str, user: &str, temperature: f32) -> Result<LlmReply, String> {
        let (url, body) = self.request(system, user, temperature);
        let mut last = String::new();
        for attempt in 0..RETRIES {
            let mut req = self.client.post(&url).json(&body);
            req = match (self.provider, &self.api_key) {
                (Provider::Anthropic, Some(key)) => req.header("x-api-key", key).header("anthropic-version", "2023-06-01"),
                (Provider::OpenAi, Some(key)) => req.bearer_auth(key),
                _ => req,
            };
            match req.send().await {
                Ok(resp) => {
                    let status = resp.status();
                    let text = resp.text().await.map_err(|e| e.without_url().to_string())?;
                    if status.is_success() {
                        return parse_reply(self.provider, &text);
                    }
                    last = format!("модель ответила статусом {status}: {}", truncate(&text, 300));
                    if !(status.as_u16() == 429 || status.is_server_error()) {
                        return Err(last);
                    }
                }
                Err(e) => last = format!("запрос к модели не удался: {}", e.without_url()),
            }
            if attempt + 1 < RETRIES {
                tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt))).await;
            }
        }
        Err(last)
    }
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

pub fn parse_reply(provider: Provider, body: &str) -> Result<LlmReply, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("ответ модели не JSON: {e}"))?;
    let (text, input, output) = match provider {
        Provider::Anthropic => (
            v["content"].as_array().map(|blocks| {
                blocks.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("")
            }),
            v["usage"]["input_tokens"].as_u64(),
            v["usage"]["output_tokens"].as_u64(),
        ),
        Provider::OpenAi => (
            v["choices"][0]["message"]["content"].as_str().map(str::to_string),
            v["usage"]["prompt_tokens"].as_u64(),
            v["usage"]["completion_tokens"].as_u64(),
        ),
    };
    match text {
        Some(t) if !t.trim().is_empty() => Ok(LlmReply {
            text: t,
            input_tokens: input.unwrap_or(0),
            output_tokens: output.unwrap_or(0),
        }),
        _ => Err("в ответе модели нет текста".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: std::collections::HashMap<String, String> =
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| map.get(k).cloned()
    }

    #[test]
    fn no_provider_means_mock() {
        assert!(RealLlm::from_env(env(&[])).unwrap().is_none());
    }

    #[test]
    fn config_errors_are_clear() {
        let e = |p: &[(&str, &str)]| RealLlm::from_env(env(p)).err().unwrap();
        assert!(e(&[("LLM_PROVIDER", "foo")]).contains("anthropic или openai"));
        assert!(e(&[("LLM_PROVIDER", "anthropic")]).contains("LLM_MODEL"));
        assert!(e(&[("LLM_PROVIDER", "anthropic"), ("LLM_MODEL", "m")]).contains("LLM_API_KEY"));
        assert!(e(&[("LLM_PROVIDER", "openai"), ("LLM_MODEL", "m")]).contains("LLM_API_KEY"));
    }

    #[test]
    fn local_openai_compatible_needs_no_key() {
        let llm = RealLlm::from_env(env(&[
            ("LLM_PROVIDER", "openai"),
            ("LLM_MODEL", "llama"),
            ("LLM_BASE_URL", "http://localhost:11434/v1/"),
        ]))
        .unwrap()
        .unwrap();
        let (url, body) = llm.request("sys", "usr", 0.0);
        assert_eq!(url, "http://localhost:11434/v1/chat/completions");
        assert_eq!(body["messages"][0]["role"], "system");
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn reasoning_effort_is_sent_only_when_configured() {
        let make = |extra: &[(&str, &str)]| {
            let mut p = vec![("LLM_PROVIDER", "openai"), ("LLM_MODEL", "m"), ("LLM_BASE_URL", "http://x/v1")];
            p.extend_from_slice(extra);
            RealLlm::from_env(env(&p)).unwrap().unwrap()
        };
        let plain = make(&[]).request("s", "u", 0.3).1;
        assert!(plain.get("reasoning_effort").is_none());
        assert_eq!(plain["temperature"].as_f64().map(|t| (t * 10.0).round()), Some(3.0));

        let none = make(&[("LLM_REASONING_EFFORT", "none")]).request("s", "u", 0.0).1;
        assert_eq!(none["reasoning_effort"], "none");
        assert!(none.get("temperature").is_some(), "при none температура отправляется");

        let medium = make(&[("LLM_REASONING_EFFORT", "medium")]).request("s", "u", 0.3).1;
        assert_eq!(medium["reasoning_effort"], "medium");
        assert!(medium.get("temperature").is_none(), "при включённых рассуждениях температуры нет");
    }

    #[test]
    fn anthropic_request_shape() {
        let llm = RealLlm::from_env(env(&[
            ("LLM_PROVIDER", "anthropic"),
            ("LLM_MODEL", "claude-x"),
            ("LLM_API_KEY", "k"),
        ]))
        .unwrap()
        .unwrap();
        let (url, body) = llm.request("sys", "usr", 0.3);
        assert_eq!(url, "https://api.anthropic.com/v1/messages");
        assert_eq!(body["system"], "sys");
        assert_eq!(body["messages"][0]["content"], "usr");
        assert_eq!(body["max_tokens"], 1024);
        assert_eq!(llm.describe(), "anthropic:claude-x");
    }

    #[test]
    fn parses_both_reply_formats() {
        let a = r#"{"content":[{"type":"text","text":"{\"a\":1}"}],"usage":{"input_tokens":12,"output_tokens":5}}"#;
        let r = parse_reply(Provider::Anthropic, a).unwrap();
        assert_eq!((r.text.as_str(), r.input_tokens, r.output_tokens), ("{\"a\":1}", 12, 5));

        let o = r#"{"choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":7,"completion_tokens":2}}"#;
        let r = parse_reply(Provider::OpenAi, o).unwrap();
        assert_eq!((r.text.as_str(), r.input_tokens, r.output_tokens), ("hi", 7, 2));

        assert!(parse_reply(Provider::OpenAi, "not json").is_err());
        assert!(parse_reply(Provider::Anthropic, r#"{"content":[]}"#).is_err());
    }
}
