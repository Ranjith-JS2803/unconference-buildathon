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
from .usecases import DEFAULT, PACKS  # noqa: E402


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

engines = {uid: Engine(pack, describe_error) for uid, pack in PACKS.items()}


def _engine(usecase: str) -> Engine:
    if usecase not in engines:
        raise HTTPException(status_code=404, detail=f"Unknown use case '{usecase}'.")
    return engines[usecase]


async def _tools(pack) -> list[dict]:
    from mcp import Client

    async with Client(pack.build_server(pack.build_world(pack.empty_seed()))) as mcp:
        listed = await mcp.list_tools()
    return [{"name": t.name, "description": " ".join((t.description or "").split())} for t in listed.tools]


@app.get("/api/usecases")
async def usecases():
    return [{**pack.META, "tools": await _tools(pack)} for pack in PACKS.values()]


@app.get("/api/state")
async def get_state(usecase: str = DEFAULT):
    return _engine(usecase).public_state()


@app.get("/api/chat/stream")
async def chat_stream(message: str, usecase: str = DEFAULT):
    engine = _engine(usecase)

    async def events():
        async for event in engine.chat_stream(message):
            yield f"data: {json.dumps(event, default=str)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/reset")
async def reset(usecase: str = DEFAULT):
    try:
        return await _engine(usecase).reset()
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
