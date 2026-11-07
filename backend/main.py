from dotenv import load_dotenv
from fastapi import FastAPI

# Читаем переменные из файла .env (если он есть) в окружение процесса.
load_dotenv()

app = FastAPI(title="CQA backend")


@app.get("/api/health")
def health():
    return {"ok": True}
