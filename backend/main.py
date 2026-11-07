from dotenv import load_dotenv
from fastapi import FastAPI

# Читаем переменные из .env (ищется в папке backend/ и выше, то есть в корне репо).
load_dotenv()

from checklist import router as checklist_router  # noqa: E402
from conversations import router as conversations_router  # noqa: E402
from errors import register_error_handlers  # noqa: E402
from evaluation import router as evaluation_router  # noqa: E402

app = FastAPI(title="CQA backend")
register_error_handlers(app)
app.include_router(conversations_router)
app.include_router(checklist_router)
app.include_router(evaluation_router)


@app.get("/api/health")
def health():
    return {"ok": True}
