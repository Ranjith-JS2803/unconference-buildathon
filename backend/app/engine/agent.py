"""Agent runner: Claude + MCP tools, with every tool call recorded in a trace."""

from __future__ import annotations

import json
from typing import Any, Awaitable, Callable

from mcp import Client

from . import llm

MAX_TURNS = 12

# Added by the harness (not part of the evolvable prompt) so the agent's reasoning is visible.
NARRATE = (
    "\n\nBefore each tool call, write one short sentence (under 20 words) saying what you are "
    "about to do and why. Do not narrate anything else."
)

CallTool = Callable[[str, str, dict[str, Any]], Awaitable[tuple[str, bool]]]
Emit = Callable[[dict[str, Any]], Awaitable[None]]


async def _no_emit(_: dict[str, Any]) -> None:
    return None


def _tool_output(result: Any) -> Any:
    if result.structured_content is not None:
        return result.structured_content
    texts = [c.text for c in result.content if getattr(c, "type", None) == "text"]
    return "\n".join(texts)


async def run_agent(system_prompt: str, task: str, mcp_server: Any, emit: Emit | None = None) -> dict[str, Any]:
    """Run one task to completion. Returns {"steps": [...], "final_text": str}.

    emit (optional) receives live events: agent_thinking, agent_text, tool_call, tool_result, agent_reply.
    """
    emit = emit or _no_emit
    steps: list[dict[str, Any]] = []

    async with Client(mcp_server) as mcp:
        listed = await mcp.list_tools()
        tools = [
            {"name": t.name, "description": t.description or "", "input_schema": t.input_schema}
            for t in listed.tools
        ]

        async def call_tool(call_id: str, name: str, args: dict[str, Any]) -> tuple[str, bool]:
            await emit({"type": "tool_call", "call_id": call_id, "server": "commerce", "tool": name, "input": args})
            result = await mcp.call_tool(name, args)
            output = _tool_output(result)
            is_error = bool(result.is_error)
            steps.append({"tool": name, "input": args, "output": output, "is_error": is_error})
            await emit({"type": "tool_result", "call_id": call_id, "tool": name, "output": output, "is_error": is_error})
            return (output if isinstance(output, str) else json.dumps(output)), is_error

        loop = _openai_compat_loop if llm.PROVIDER == "openai_compat" else _claude_loop
        final_text = await loop(system_prompt + NARRATE, task, tools, call_tool, emit)
        await emit({"type": "agent_reply", "text": final_text})

    return {"steps": steps, "final_text": final_text}


async def _claude_loop(
    system_prompt: str, task: str, tools: list[dict[str, Any]], call_tool: CallTool, emit: Emit
) -> str:
    messages: list[dict[str, Any]] = [{"role": "user", "content": task}]
    for _ in range(MAX_TURNS):
        await emit({"type": "agent_thinking"})
        response = await llm.create(
            effort=llm.AGENT_EFFORT,
            model=llm.AGENT_MODEL,
            max_tokens=16000,
            system=system_prompt,
            tools=tools,
            messages=messages,
        )
        if response.stop_reason == "refusal":
            return "(The model declined this request.)"

        # Append the full content (thinking blocks included) unchanged.
        messages.append({"role": "assistant", "content": response.content})

        tool_uses = [b for b in response.content if b.type == "tool_use"]
        if not tool_uses:
            return "\n".join(b.text for b in response.content if b.type == "text").strip()

        text = "\n".join(b.text for b in response.content if b.type == "text").strip()
        if text:
            await emit({"type": "agent_text", "text": text})
        results = []
        for block in tool_uses:
            content, is_error = await call_tool(block.id, block.name, block.input)
            results.append({"type": "tool_result", "tool_use_id": block.id, "content": content, "is_error": is_error})
        messages.append({"role": "user", "content": results})
    return "(Stopped: too many turns.)"


def _strip_titles(schema: Any) -> Any:
    """The gateway rejects JSON-schema 'title' keys, which MCP adds to every schema."""
    if isinstance(schema, dict):
        return {k: _strip_titles(v) for k, v in schema.items() if k != "title"}
    if isinstance(schema, list):
        return [_strip_titles(v) for v in schema]
    return schema


async def _openai_compat_loop(
    system_prompt: str, task: str, tools: list[dict[str, Any]], call_tool: CallTool, emit: Emit
) -> str:
    """Same loop for an OpenAI-format gateway (temporary, until a Claude API key is set)."""
    fn_tools = [
        {
            "type": "function",
            "function": {"name": t["name"], "description": t["description"], "parameters": _strip_titles(t["input_schema"])},
        }
        for t in tools
    ]
    messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}, {"role": "user", "content": task}]
    for _ in range(MAX_TURNS):
        await emit({"type": "agent_thinking"})
        response = await llm.openai_client().chat.completions.create(
            model=llm.AGENT_MODEL, max_tokens=4000, messages=messages, tools=fn_tools
        )
        msg = response.choices[0].message
        if not msg.tool_calls:
            return (msg.content or "").strip()
        if (msg.content or "").strip():
            await emit({"type": "agent_text", "text": msg.content.strip()})

        messages.append(
            {
                "role": "assistant",
                "content": msg.content or None,  # the gateway rejects empty text blocks
                "tool_calls": [
                    {"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments}}
                    for c in msg.tool_calls
                ],
            }
        )
        for c in msg.tool_calls:
            try:
                args = json.loads(c.function.arguments or "{}")
            except json.JSONDecodeError:
                content = "Error: tool arguments were not valid JSON."
            else:
                content, _ = await call_tool(c.id, c.function.name, args)
            messages.append({"role": "tool", "tool_call_id": c.id, "content": content})
    return "(Stopped: too many turns.)"
