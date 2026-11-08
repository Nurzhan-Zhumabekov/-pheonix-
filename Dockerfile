# Запуск одной командой: docker compose up --build
# Интерфейс и API откроются на http://127.0.0.1:8080 (подробности в README).

FROM rust:1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# config нужен при сборке: чек-лист и промпты по умолчанию вшиваются в бинарник
COPY backend ./backend
COPY config ./config
WORKDIR /src/backend
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /app app \
    && mkdir -p /data && chown app /data
WORKDIR /app/backend
COPY --from=build /src/backend/target/release/backend /app/backend/cqa-backend
COPY config /app/config
COPY web /app/web
ENV BIND_ADDR=0.0.0.0 \
    PORT=8080 \
    STORAGE_DIR=/data \
    WEB_DIR=/app/web \
    PROMPTS_DIR=/app/config/prompts
USER app
VOLUME /data
EXPOSE 8080
CMD ["/app/backend/cqa-backend"]
