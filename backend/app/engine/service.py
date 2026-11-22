"""The evolution engine.

Every chat message runs two agents side by side in fresh sandboxes:
  - baseline: frozen at v1, never learns (the control group)
  - evolving: the current champion, which evolves itself automatically

When the evolving agent fails its outcome checks, the engine runs the evolution loop on its
own (autopilot): capture the failure as an eval case → the agent diagnoses and proposes a new
prompt → gate (champion vs candidate on every eval case) → promote or reject.

Nothing in this module knows about orders or refunds; that lives in the domain pack.
"""

from __future__ import annotations

import asyncio
import copy
import difflib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable

from mcp import Client

from ..domain import commerce as domain
from . import agent, evolver

DATA_FILE = Path(os.getenv("DATA_FILE", Path(__file__).resolve().parents[2] / "data" / "state.json"))
GATE_CONCURRENCY = int(os.getenv("GATE_CONCURRENCY", "8"))
AUTOPILOT = os.getenv("AUTOPILOT", "true").lower() in ("1", "true", "yes", "on")
MAX_ATTEMPTS = int(os.getenv("MAX_EVOLVE_ATTEMPTS", "3"))

Emit = Callable[[dict[str, Any]], Awaitable[None]]


async def _no_emit(_: dict[str, Any]) -> None:
    return None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class EngineError(Exception):
    """A user-facing error (bad request, wrong state)."""


class Engine:
    def __init__(self, describe_error: Callable[[BaseException], str] = str) -> None:
        self._lock = asyncio.Lock()
        self._evolve_lock = asyncio.Lock()
        self.describe_error = describe_error
        self.state: dict[str, Any] = self._load() or self._fresh_state()
        self._save()

    # ---- persistence --------------------------------------------------
    def _fresh_state(self) -> dict[str, Any]:
        state: dict[str, Any] = {
            "baseline_id": "v1",
            "champion_id": "v1",
            "versions": [
                {"id": "v1", "status": "champion", "parent_id": None, "prompt": domain.V1_PROMPT, "created_at": _now()}
            ],
            "eval_cases": [],
            "runs": {},
            "counters": {"run": 0, "case": 0, "version": 1},
        }
        for case in domain.SEED_CASES:
            state["counters"]["case"] += 1
            state["eval_cases"].append(
                {
                    "id": f"case-{state['counters']['case']:03d}",
                    "title": case["title"],
                    "origin": "seed",
                    "task": case["task"],
                    "seed": case["seed"],
                    "created_at": _now(),
                }
            )
        return state

    def _load(self) -> dict[str, Any] | None:
        if DATA_FILE.exists():
            try:
                state = json.loads(DATA_FILE.read_text())
                return state if "baseline_id" in state else None  # ignore pre-v2 state files
            except json.JSONDecodeError:
                return None
        return None

    def _save(self) -> None:
        DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = DATA_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=2))
        tmp.replace(DATA_FILE)

    async def reset(self) -> dict[str, Any]:
        if self._evolve_lock.locked():
            raise EngineError("An evolution cycle is running; reset once it finishes.")
        async with self._lock:
            self.state = self._fresh_state()
            self._save()
        return self.public_state()

    # ---- lookups / views ----------------------------------------------
    def _version(self, version_id: str) -> dict[str, Any]:
        for v in self.state["versions"]:
            if v["id"] == version_id:
                return v
        raise EngineError(f"Unknown version {version_id}")

    def public_state(self) -> dict[str, Any]:
        return {
            "baseline_id": self.state["baseline_id"],
            "champion_id": self.state["champion_id"],
            "autopilot": AUTOPILOT,
            "evolving_now": self._evolve_lock.locked(),
            "versions": self.state["versions"],
            "eval_cases": [_public_case(c) for c in self.state["eval_cases"]],
            "examples": domain.EXAMPLES,
            "lessons": self._lessons(self.state["champion_id"]),
        }

    def _lessons(self, version_id: str) -> list[dict[str, Any]]:
        """Lessons carried by a version: one per promoted ancestor, oldest first."""
        lessons = []
        v = self._version(version_id)
        while v.get("parent_id"):
            if v.get("lesson"):
                case = next((c for c in self.state["eval_cases"] if c.get("source_run_id") == v.get("source_run_id")), None)
                lessons.append({"version_id": v["id"], "lesson": v["lesson"], "case_id": case["id"] if case else None})
            v = self._version(v["parent_id"])
        return list(reversed(lessons))

    async def _next_run_id(self) -> str:
        async with self._lock:
            self.state["counters"]["run"] += 1
            return f"run-{self.state['counters']['run']:04d}"

    # ---- one agent run --------------------------------------------------
    async def _execute(
        self,
        version: dict[str, Any],
        task: str,
        seed: dict[str, Any],
        emit: Emit = _no_emit,
        **tags: Any,
    ) -> dict[str, Any]:
        run_id = await self._next_run_id()
        await emit(
            {"type": "run_started", "version_id": version["id"], "run_id": run_id, "lessons": self._lessons(version["id"])}
        )

        world = domain.build_world(seed)
        result = await agent.run_agent(version["prompt"], task, domain.build_server(world), emit)

        # Let asynchronous side effects (e.g. webhooks) land before judging the outcome.
        for description in world.settle():
            await emit({"type": "async_effects", "description": description})

        judged = seed.get("order_id") is not None
        checks = domain.run_checks(world, seed) if judged else []
        run = {
            "id": run_id,
            "version_id": version["id"],
            "task": task,
            "seed": seed,
            "steps": result["steps"],
            "final_text": result["final_text"],
            "checks": checks,
            "passed": all(c["passed"] for c in checks) if judged else None,
            "ledger": domain.ledger_view(world, seed) if judged else None,
            "end_state": world.ledger(),
            "created_at": _now(),
            **tags,
        }
        await emit(
            {"type": "checks", "run_id": run_id, "passed": run["passed"], "checks": checks, "ledger": run["ledger"]}
        )
        return run

    # ---- chat: both lanes, streamed --------------------------------------
    async def chat_stream(self, message: str) -> AsyncIterator[dict[str, Any]]:
        message = message.strip()
        if not message:
            yield {"type": "error", "detail": "Message is empty."}
            yield {"type": "done"}
            return

        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        seed = domain.seed_for_message(message) or domain.empty_seed()

        def lane_emit(lane: str) -> Emit:
            async def emit(event: dict[str, Any]) -> None:
                await queue.put({**event, "lane": lane})

            return emit

        async def lane(name: str, version_id: str) -> None:
            emit = lane_emit(name)
            try:
                run = await self._execute(
                    self._version(version_id), message, copy.deepcopy(seed), emit, lane=name, source="chat"
                )
                async with self._lock:
                    self.state["runs"][run["id"]] = run
                    self._save()
                if name == "evolving" and run["passed"] is False:
                    await self._auto_evolve(run, emit)
            except Exception as exc:  # surface per-lane errors in the stream
                await emit({"type": "error", "detail": self.describe_error(exc)})
            finally:
                await emit({"type": "lane_done"})

        async def run_all() -> None:
            try:
                await asyncio.gather(
                    lane("baseline", self.state["baseline_id"]),
                    lane("evolving", self.state["champion_id"]),
                )
            finally:
                await queue.put(None)

        task = asyncio.create_task(run_all())
        try:
            while (event := await queue.get()) is not None:
                yield event
            yield {"type": "done"}
        finally:
            if not task.done():
                task.cancel()

    # ---- automatic evolution --------------------------------------------
    async def _auto_evolve(self, run: dict[str, Any], emit: Emit) -> None:
        if not AUTOPILOT:
            await emit({"type": "evolution_skipped", "reason": "Autopilot is off."})
            return
        if self._evolve_lock.locked():
            await emit({"type": "evolution_skipped", "reason": "Another evolution cycle is already running."})
            return

        async with self._evolve_lock:
            failed = [c for c in run["checks"] if not c["passed"]]
            await emit(
                {
                    "type": "evolution_started",
                    "run_id": run["id"],
                    "reason": "Outcome check failed: " + "; ".join(c["label"] for c in failed),
                    # How it knew: what the agent believed vs what actually happened.
                    "belief": run["final_text"],
                    "reality": [f"{c['label']}: {c['detail']}" for c in failed],
                    "ledger": run["ledger"],
                }
            )

            case = await self._capture_failure(run)
            if case:
                await emit({"type": "eval_case_added", "case": _public_case(case)})

            rejected: list[dict[str, Any]] = []
            for attempt in range(1, MAX_ATTEMPTS + 1):
                await emit({"type": "diagnosing", "version_id": run["version_id"], "attempt": attempt})
                candidate = await self._propose(run, rejected)
                await emit({"type": "candidate_proposed", "version": candidate, "attempt": attempt})

                gate = await self._gate(candidate, emit)
                await emit({"type": "gate_result", "gate": gate, "attempt": attempt})
                if gate["decision"] == "promoted":
                    return

                rejected.append(self._rejection_feedback(candidate, gate))
                if attempt < MAX_ATTEMPTS:
                    await emit(
                        {
                            "type": "evolution_retry",
                            "attempt": attempt + 1,
                            "max_attempts": MAX_ATTEMPTS,
                            "reason": rejected[-1]["summary"],
                        }
                    )
            await emit(
                {
                    "type": "evolution_skipped",
                    "reason": f"Gave up after {MAX_ATTEMPTS} attempts; {self.state['champion_id']} stays champion.",
                }
            )

    async def _capture_failure(self, run: dict[str, Any]) -> dict[str, Any] | None:
        """A failed production run becomes an eval case (once per kind of failure)."""
        sig = domain.case_signature(run["seed"])
        async with self._lock:
            if any(domain.case_signature(c["seed"]) == sig for c in self.state["eval_cases"]):
                return None
            self.state["counters"]["case"] += 1
            case = {
                "id": f"case-{self.state['counters']['case']:03d}",
                "title": domain.case_title(run["seed"]),
                "origin": "auto",
                "source_run_id": run["id"],
                "task": run["task"],
                "seed": copy.deepcopy(run["seed"]),
                "created_at": _now(),
            }
            self.state["eval_cases"].append(case)
            self._save()
            return case

    def _rejection_feedback(self, candidate: dict[str, Any], gate: dict[str, Any]) -> dict[str, Any]:
        """What the evolver needs to know about a rejected attempt to do better next time."""
        failing = []
        for r in gate["results"]:
            if r["candidate"]["passed"]:
                continue
            cand_run = self.state["runs"][r["candidate"]["run_id"]]
            failing.append(
                {
                    "case": r["title"],
                    "customer_request": cand_run["task"],
                    "trace": [{"tool": s["tool"], "input": s["input"]} for s in cand_run["steps"]],
                    "failed_checks": [f"{c['label']}: {c['detail']}" for c in cand_run["checks"] if not c["passed"]],
                }
            )
        first = next((r for r in gate["results"] if not r["candidate"]["passed"]), None)
        if first:
            why = f"{first['title']} ({first['case_id']}): {', '.join(first['candidate']['failed_checks'])}"
            verb = "regressed on" if first["case_id"] in gate["regressions"] else "still fails"
            summary = f"{candidate['id']} {verb} {why}"
        else:
            summary = f"{candidate['id']} rejected: {gate['reason']}"
        return {
            "version": candidate["id"],
            "prompt": candidate["prompt"],
            "gate_reason": gate["reason"],
            "failing_cases": failing,
            "summary": summary,
        }

    async def _propose(self, run: dict[str, Any], rejected: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        parent = self._version(run["version_id"])
        async with Client(domain.build_server(domain.build_world(run["seed"]))) as mcp:
            listed = await mcp.list_tools()
        tools = [{"name": t.name, "description": t.description} for t in listed.tools]

        proposal = await evolver.propose(
            parent["prompt"],
            tools,
            run,
            run["end_state"],
            self.state["eval_cases"],
            {c["id"]: domain.case_facts(c["seed"]) for c in self.state["eval_cases"]},
            [{k: v for k, v in r.items() if k != "summary"} for r in (rejected or [])],
        )
        new_prompt = proposal["new_prompt"].strip()
        async with self._lock:
            self.state["counters"]["version"] += 1
            version = {
                "id": f"v{self.state['counters']['version']}",
                "status": "candidate",
                "parent_id": parent["id"],
                "prompt": new_prompt,
                "created_at": _now(),
                "source_run_id": run["id"],
                "diagnosis": proposal["diagnosis"],
                "evidence": proposal["evidence"],
                "lesson": proposal["lesson"],
                "root_cause": proposal["root_cause"],
                "change_summary": proposal["change_summary"],
                "diff": _diff(parent["prompt"], new_prompt),
                "gate": None,
            }
            self.state["versions"].append(version)
            self._save()
        return version

    async def _gate(self, candidate: dict[str, Any], emit: Emit) -> dict[str, Any]:
        """Champion vs candidate on every eval case; promote only on a clean win."""
        champion = self._version(self.state["champion_id"])
        cases = list(self.state["eval_cases"])
        await emit(
            {
                "type": "gate_started",
                "champion_id": champion["id"],
                "candidate_id": candidate["id"],
                "cases": [{"case_id": c["id"], "title": c["title"], "origin": c["origin"]} for c in cases],
            }
        )

        sem = asyncio.Semaphore(GATE_CONCURRENCY)

        async def one(version: dict[str, Any], case: dict[str, Any]) -> dict[str, Any]:
            async with sem:
                return await self._execute(version, case["task"], copy.deepcopy(case["seed"]), case_id=case["id"])

        async def pair(case: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
            champ_run, cand_run = await asyncio.gather(one(champion, case), one(candidate, case))
            result = {
                "case_id": case["id"],
                "title": case["title"],
                "origin": case["origin"],
                "champion": _gate_side(champ_run),
                "candidate": _gate_side(cand_run),
            }
            await emit({"type": "gate_case", "result": result})
            return result, [champ_run, cand_run]

        pairs = await asyncio.gather(*(pair(c) for c in cases))
        results = [p[0] for p in pairs]
        runs = [r for p in pairs for r in p[1]]

        # The case(s) this candidate was evolved to fix: same kind as its source run.
        target_ids: list[str] = []
        source = self.state["runs"].get(candidate.get("source_run_id") or "")
        if source:
            sig = domain.case_signature(source["seed"])
            target_ids = [c["id"] for c in cases if domain.case_signature(c["seed"]) == sig]
        unfixed = [r["case_id"] for r in results if r["case_id"] in target_ids and not r["candidate"]["passed"]]

        champ_score = sum(r["champion"]["passed"] for r in results)
        cand_score = sum(r["candidate"]["passed"] for r in results)
        regressions = [r["case_id"] for r in results if r["champion"]["passed"] and not r["candidate"]["passed"]]
        total = len(cases)

        if regressions:
            decision, reason = "rejected", f"Regressed on {', '.join(regressions)}."
        elif unfixed:
            decision, reason = "rejected", f"Does not fix the failure it was evolved from ({', '.join(unfixed)})."
        elif cand_score <= champ_score:
            decision, reason = "rejected", f"No improvement ({cand_score}/{total} vs {champ_score}/{total})."
        else:
            decision, reason = "promoted", f"Passes {cand_score}/{total} vs {champ_score}/{total} with no regressions."

        gate = {
            "champion_id": champion["id"],
            "candidate_id": candidate["id"],
            "results": results,
            "champion_score": champ_score,
            "candidate_score": cand_score,
            "total": total,
            "regressions": regressions,
            "decision": decision,
            "reason": reason,
        }

        async with self._lock:
            for run in runs:
                self.state["runs"][run["id"]] = run
            candidate["gate"] = gate
            if decision == "promoted":
                champion["status"] = "retired"
                candidate["status"] = "champion"
                self.state["champion_id"] = candidate["id"]
            else:
                candidate["status"] = "rejected"
            self._save()
        return gate


# ---- helpers ------------------------------------------------------------
def _public_case(case: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in case.items() if k != "seed"}


def _gate_side(run: dict[str, Any]) -> dict[str, Any]:
    return {
        "run_id": run["id"],
        "passed": bool(run["passed"]),
        "failed_checks": [c["label"] for c in run["checks"] if not c["passed"]],
    }


def _diff(old: str, new: str) -> list[dict[str, str]]:
    lines = []
    for line in difflib.ndiff(old.splitlines(), new.splitlines()):
        tag, text = line[:2], line[2:]
        if tag == "? ":
            continue
        lines.append({"op": {"+ ": "+", "- ": "-"}.get(tag, " "), "text": text})
    return lines
