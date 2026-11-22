"""Evolver: Claude reads a failed run and rewrites the agent's system prompt."""

from __future__ import annotations

import json
import logging
from typing import Any

from . import llm

EVOLVER_SYSTEM = """You improve the system prompt of an AI agent that runs in production.

You are given the agent's current system prompt, the tools it can call, one production run whose outcome checks failed, and the real end state of the external systems after that run. The tool calls in the trace may all have succeeded; the failure is in what actually happened in the world.

Your job:
1. Diagnose what went wrong, using the evidence in the trace and the end state.
2. Identify the root cause: what fact about this environment the agent did not account for.
3. Write a new system prompt that fixes it.

Rules for the new prompt:
- Make the smallest change that fixes the root cause. Keep the existing structure, tone and steps.
- State the fix as a general rule based on what the agent can observe through its tools. Never hard-code specific order IDs, customer IDs, amounts or names.
- Side effects in real systems are often asynchronous: something triggered by an action may not be visible to the agent until after its run ends. A fix that only re-checks or waits for state is unreliable. Prefer a rule keyed on facts the agent can observe before acting (for example, attributes of the order or payment), and compare with the eval cases where the problem did not occur to find what distinguishes them.
- The new prompt must still handle every case in the eval set correctly (listed below), including cases where the problem does not occur. Do not over-correct.
- Do not mention evals, checks or this review process in the prompt."""

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "diagnosis": {"type": "string", "description": "2-3 sentences: what went wrong in this run, citing evidence."},
        "evidence": {
            "type": "array",
            "items": {"type": "string"},
            "description": "2-4 short observations (under 20 words each) that prove the root cause, each starting with its source in brackets: [trace], [end state] or [eval set]. E.g. '[end state] Second refund initiated_by order-system, created after cancel_order'.",
        },
        "lesson": {
            "type": "string",
            "description": "The lesson learned as one plain-English rule a support lead would understand (under 25 words).",
        },
        "root_cause": {"type": "string", "description": "One sentence: the fact about the environment the agent missed."},
        "change_summary": {"type": "string", "description": "One sentence: what the new prompt changes."},
        "new_prompt": {"type": "string", "description": "The complete new system prompt."},
    },
    "required": ["diagnosis", "evidence", "lesson", "root_cause", "change_summary", "new_prompt"],
    "additionalProperties": False,
}


async def propose(
    current_prompt: str,
    tools: list[dict[str, Any]],
    run: dict[str, Any],
    end_state: dict[str, Any],
    eval_cases: list[dict[str, Any]],
    case_facts: dict[str, Any] | None = None,
    rejected_attempts: list[dict[str, Any]] | None = None,
) -> dict[str, str]:
    failed = [c for c in run["checks"] if not c["passed"]]
    user = f"""<current_prompt>
{current_prompt}
</current_prompt>

<tools>
{json.dumps(tools, indent=2)}
</tools>

<failed_run>
Customer request: {run["task"]}

Trace (in order):
{json.dumps(run["steps"], indent=2)}

Agent's final message: {run["final_text"]}

Failed outcome checks:
{json.dumps(failed, indent=2)}
</failed_run>

<end_state_of_external_systems>
{json.dumps(end_state, indent=2)}
</end_state_of_external_systems>

<eval_set>
The new prompt must pass all of these:
{json.dumps([{"title": c["title"], "customer_request": c["task"], "setup": (case_facts or {}).get(c["id"])} for c in eval_cases], indent=2)}
</eval_set>"""
    if rejected_attempts:
        user += f"""

<rejected_attempts>
Earlier fixes for this failure were tested on the eval set and REJECTED. Learn from them: keep what
worked, and fix what broke. Start again from the current prompt above.
{json.dumps(rejected_attempts, indent=2)}
</rejected_attempts>"""

    system = EVOLVER_SYSTEM
    if not llm.USE_STRUCTURED_OUTPUT:
        system += (
            "\n\nRespond with only a JSON object (no prose, no code fences) with these fields: "
            "diagnosis (string), evidence (array of 2-4 short strings, each starting with [trace], [end state] or [eval set]), "
            "lesson (string, one plain-English rule under 25 words), root_cause (string), change_summary (string), new_prompt (string)."
        )

    if llm.PROVIDER == "openai_compat":
        user += """

Reply with exactly this JSON shape (all fields required):
{"diagnosis": "...",
 "evidence": ["[trace] ...", "[end state] ...", "[eval set] ..."],
 "lesson": "one plain-English rule, under 25 words",
 "root_cause": "...",
 "change_summary": "...",
 "new_prompt": "..."}"""
        # The gateway can't enforce a JSON schema, so parse leniently and, if the reply
        # still isn't valid JSON, ask once more with the parse error.
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        for attempt in range(2):
            completion = await llm.openai_client().chat.completions.create(
                model=llm.EVOLVER_MODEL, max_tokens=12000, messages=messages
            )
            if completion.choices[0].finish_reason == "length":
                raise EvolverError("The evolver ran out of tokens before finishing.")
            text = (completion.choices[0].message.content or "").strip()
            try:
                return _validate(_parse_json(text))
            except ValueError as e:
                log.warning("Evolver reply was not valid JSON (attempt %d): %s; reply starts: %r", attempt + 1, e, text[:300])
                messages += [
                    {"role": "assistant", "content": text or "(empty)"},
                    {
                        "role": "user",
                        "content": f"That reply was not valid JSON ({e}). Reply again with ONLY the JSON object: "
                        "no prose, no code fences, and write line breaks inside strings as \\n.",
                    },
                ]
        raise EvolverError("The evolver did not return valid JSON (after a retry).")
    else:
        response = await llm.create(
            effort=llm.EVOLVER_EFFORT,
            output_format={"type": "json_schema", "schema": OUTPUT_SCHEMA},
            model=llm.EVOLVER_MODEL,
            max_tokens=16000,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        if response.stop_reason == "refusal":
            raise EvolverError("The evolver model declined this request.")
        if response.stop_reason == "max_tokens":
            raise EvolverError("The evolver ran out of tokens before finishing.")
        text = "".join(b.text for b in response.content if b.type == "text").strip()
    try:
        return _validate(_parse_json(text))
    except ValueError as e:
        log.warning("Evolver reply was not valid JSON: %s; reply starts: %r", e, text[:300])
        raise EvolverError("The evolver did not return valid JSON.") from e


def _parse_json(text: str) -> dict[str, Any]:
    """Extract the JSON object from a model reply, tolerating fences and raw newlines in strings."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object found")
    data = json.loads(text[start : end + 1], strict=False)  # strict=False: allow literal newlines/tabs in strings
    if not isinstance(data, dict):
        raise ValueError("JSON is not an object")
    return data


def _validate(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data.get("evidence"), list):
        data["evidence"] = []
    data["evidence"] = [str(e) for e in data["evidence"]][:4]
    if not isinstance(data.get("lesson"), str) or not data["lesson"].strip():
        data["lesson"] = data.get("change_summary") or ""
    missing = [k for k in OUTPUT_SCHEMA["required"] if k != "evidence" and not isinstance(data.get(k), str)]
    if missing:
        raise EvolverError(f"The evolver response is missing: {', '.join(missing)}.")
    return data


class EvolverError(Exception):
    pass


log = logging.getLogger("evolve.evolver")
