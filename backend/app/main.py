"""FastAPI app: the evolution engine API (state, streaming chat, reset) + the built frontend."""

from __future__ import annotations

import json
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

import anthropic  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from .engine.evolver import EvolverError  # noqa: E402
from .engine.service import Engine, EngineError  # noqa: E402


def describe_error(exc: BaseException) -> str:
    """Turn any failure into a short, user-facing message."""
    while isinstance(exc, BaseExceptionGroup) and len(exc.exceptions) == 1:
        exc = exc.exceptions[0]  # MCP's client wraps errors in TaskGroup exception groups
    if isinstance(exc, (EngineError, EvolverError)):
        return str(exc)
    if isinstance(exc, TypeError) and "authentication" in str(exc):
        return "No LLM credentials found. Check backend/.env."
    if isinstance(exc, anthropic.AuthenticationError):
        return "Claude API authentication failed. Check ANTHROPIC_API_KEY in backend/.env."
    if isinstance(exc, anthropic.RateLimitError):
        return "Claude API rate limit hit. Try again in a moment."
    if isinstance(exc, anthropic.APIStatusError):
        return f"Claude API error ({exc.status_code}): {exc.message}"
    if isinstance(exc, anthropic.APIConnectionError):
        return "Could not reach the Claude API."
    if type(exc).__module__.startswith("openai"):
        return f"LLM gateway error: {getattr(exc, 'message', str(exc))}"
    return f"Unexpected error: {exc}"


app = FastAPI(title="Evolve: self-improving agents")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"], allow_headers=["*"])

engine = Engine(describe_error)


@app.get("/api/state")
async def get_state():
    return engine.public_state()


@app.get("/api/chat/stream")
async def chat_stream(message: str):
    async def events():
        async for event in engine.chat_stream(message):
            yield f"data: {json.dumps(event, default=str)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/reset")
async def reset():
    try:
        return await engine.reset()
    except EngineError as e:
        raise HTTPException(status_code=409, detail=str(e))


# ---- serve the built frontend (single URL for the demo) -----------------
DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    async def spa(path: str):
        file = DIST / path
        if path and file.is_file():
            return FileResponse(file)
        return FileResponse(DIST / "index.html")
