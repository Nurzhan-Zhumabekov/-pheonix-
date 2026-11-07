mod api;
mod judge;
mod llm;
mod loader;
mod model;
mod report;
mod scoring;
mod store;

use std::{env, sync::Arc};

use tower_http::{
    cors::{Any, CorsLayer},
    services::ServeDir,
};

#[tokio::main]
async fn main() {
    // Значения не печатаем: в .env лежат ключи.
    match dotenvy::dotenv() {
        Ok(path) => println!("env: {}", path.display()),
        Err(e) if e.not_found() => println!("env: файл .env не найден, настройки берутся из переменных окружения"),
        Err(dotenvy::Error::LineParse(_, line)) => {
            println!("env: ошибка разбора .env в строке {line}, дальнейшие строки пропущены")
        }
        Err(_) => println!("env: не удалось прочитать .env"),
    }

    let storage = env::var("STORAGE_DIR").unwrap_or_else(|_| "../storage".into());
    let web = env::var("WEB_DIR").unwrap_or_else(|_| "../web".into());
    let port: u16 = env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let nonempty = |key: &str| env::var(key).ok().filter(|v| !v.trim().is_empty());

    let default_checklist = serde_json::from_str(include_str!("../../config/checklist.default.json"))
        .expect("config/checklist.default.json должен быть валидным");

    let llm = llm::RealLlm::from_env(nonempty).unwrap_or_else(|e| panic!("настройка модели: {e}"));
    match &llm {
        Some(l) => println!("judge: {}", l.describe()),
        None => println!("judge: заглушка (LLM_PROVIDER не задан), ответы помечены mock"),
    }

    let state = Arc::new(api::AppState {
        store: store::Store::new(storage),
        dev_url: nonempty("DEV_API_URL"),
        control_url: nonempty("CONTROL_API_URL"),
        default_checklist,
        llm,
        judge_opts: judge::JudgeOpts::from_env(nonempty),
    });

    // Интерфейс и API отдаются с одного адреса, поэтому CORS не нужен и по умолчанию выключен.
    // Нужен отдельный адрес для разработки интерфейса: CORS_ALLOW_ORIGIN=http://127.0.0.1:5173
    let mut app = api::router(state).fallback_service(ServeDir::new(web));
    if let Some(origin) = nonempty("CORS_ALLOW_ORIGIN") {
        let origin: axum::http::HeaderValue =
            origin.parse().unwrap_or_else(|_| panic!("CORS_ALLOW_ORIGIN: недопустимое значение"));
        println!("cors: разрешён только origin {origin:?}");
        app = app.layer(CorsLayer::new().allow_origin(origin).allow_methods(Any).allow_headers(Any));
    }

    // Только localhost: в хранилище лежат реальные данные звонков.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap_or_else(|e| panic!("не удалось занять порт {port}: {e}"));
    println!("http://127.0.0.1:{port}");
    axum::serve(listener, app).await.expect("ошибка сервера");
}
