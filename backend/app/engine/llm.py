"""Claude client + shared request settings.

Works against the Claude API directly or through an Anthropic-compatible gateway
(set ANTHROPIC_BASE_URL). Gateways may not support every newer API feature, so
each one can be switched off with an env var.
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Any

import anthropic


def _flag(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


_VIA_GATEWAY = bool(os.getenv("ANTHROPIC_BASE_URL"))

AGENT_MODEL = os.getenv("AGENT_MODEL", "claude-opus-5-5")
AGENT_EFFORT = os.getenv("AGENT_EFFORT", "low")
EVOLVER_MODEL = os.getenv("EVOLVER_MODEL", AGENT_MODEL)
EVOLVER_EFFORT = os.getenv("EVOLVER_EFFORT", "high")

# Server-side refusal fallback (retries a declined request on a fallback model).
USE_FALLBACKS = _flag("USE_FALLBACKS", not _VIA_GATEWAY)
USE_EFFORT = _flag("USE_EFFORT", True)
USE_STRUCTURED_OUTPUT = _flag("USE_STRUCTURED_OUTPUT", True)
FALLBACK_BETA = "server-side-fallback-2026-07-01"


# "anthropic" (default): Claude API via the Anthropic SDK.
# "openai_compat": an OpenAI-format gateway (OPENAI_COMPAT_BASE_URL / OPENAI_COMPAT_API_KEY).
PROVIDER = os.getenv("LLM_PROVIDER", "anthropic")
if PROVIDER == "openai_compat":
    USE_STRUCTURED_OUTPUT = False  # evolver asks for JSON in the prompt instead


@lru_cache(maxsize=1)
def openai_client():
    from openai import AsyncOpenAI

    return AsyncOpenAI(base_url=os.environ["OPENAI_COMPAT_BASE_URL"], api_key=os.environ["OPENAI_COMPAT_API_KEY"])


@lru_cache(maxsize=1)
def client() -> anthropic.AsyncAnthropic:
    # Reads ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL from the environment.
    return anthropic.AsyncAnthropic()


async def create(*, effort: str, output_format: dict[str, Any] | None = None, **kwargs: Any):
    """messages.create with the optional features applied per the flags above."""
    output_config: dict[str, Any] = {}
    if USE_EFFORT:
        output_config["effort"] = effort
    if output_format is not None and USE_STRUCTURED_OUTPUT:
        output_config["format"] = output_format
    if output_config:
        kwargs["output_config"] = output_config
    if USE_FALLBACKS:
        kwargs["betas"] = [FALLBACK_BETA]
        kwargs["fallbacks"] = "default"
    return await client().beta.messages.create(**kwargs)
