# Evolve: a self-improvement loop for production agents

Most agents ship once and never get better. When they fail in production, a human has to notice,
debug the trace, rewrite the prompt and hope nothing else broke.

**Evolve is a framework that makes any tool-using agent learn from its own production failures.**
It reads the failure, fixes itself and proves it got better before the fix goes live, with no human
in the loop.

**Live demo: https://unconference-buildathon.onrender.com**: pick a use case in the chat, send one of
the suggested queries, and watch the evolving agent catch its own failure, fix itself and get promoted.

## The problem it solves

The hardest agent failures produce **no errors**. Every tool call succeeds, every API is documented
correctly, and the outcome is still wrong. That happens because of how *your* systems behave
together: a webhook, an automation or a side effect that no tool description mentions.

- Better tool descriptions can't fix it, because no single tool's author knows about it.
- Retries and error handling can't catch it, because nothing errored.
- Prompting up front can't prevent it, because nobody knew until it happened.

The only reliable signal is the **real end state** of the systems after the agent has run.

## The loop

```
     ┌──────────────────────────────────────────────────────────────────┐
     ▼                                                                  │
  1 RUN ──► 2 JUDGE ──► 3 REMEMBER ──► 4 DIAGNOSE ──► 5 REWRITE ──► 6 PROVE ──► 7 PROMOTE
```

| Step | What Evolve does |
|---|---|
| **1. Run** | The agent handles real requests through MCP tools. Every thought and tool call is traced. |
| **2. Judge** | **Outcome checks** inspect the real end state of the systems, not tool errors. Teams define what "correct" means, not every possible failure. |
| **3. Remember** | Every failure becomes a permanent **eval case**, so the eval set builds itself from real errors. |
| **4. Diagnose** | The agent reads its own trace, the end state and past cases, and cites the evidence for the root cause. |
| **5. Rewrite** | It writes the **lesson** into its own instructions as a new, versioned prompt. |
| **6. Prove** | The new and current versions replay **every** eval case in fresh, isolated sandboxes. |
| **7. Promote** | Ship only if the new version fixes the failure, scores higher and has **zero regressions**. Otherwise the rejection evidence goes back to step 4 and the agent revises its fix (up to 3 attempts). |

Lessons accumulate across versions, and nothing learned is lost: every past failure stays in the
eval set, so a later version can't quietly unlearn an earlier lesson.

### Who decides what's "wrong"?

Teams write a few **outcome checks**, which are invariants about a good end state, such as "the
customer is refunded exactly the order amount" or "at most one replacement per lost parcel". They
don't enumerate failures. One invariant catches a whole family of failures nobody predicted:
duplicates from webhooks, retries or races all break "exactly once".
**Humans define what correct means. The agent works out how to achieve it.**

## Plugging in a use case

The engine knows nothing about any business domain. A **use-case pack** plugs one agent into it:

| You plug in | Evolve does the rest |
|---|---|
| Agent's starting prompt | Tracing every thought and tool call |
| MCP server (the agent's tools) | Judging outcomes on the real end state |
| Outcome checks (what "correct" means) | Turning failures into eval cases |
| Optional seed eval cases | Diagnosis, lessons and prompt rewriting |
| | Replay testing, promotion, retries and version history |

A pack is one Python module (see `backend/app/usecases/__init__.py` for the interface). Register it
in `PACKS`, and the engine, API and UI pick it up.

### Architecture

```
backend/app/
  engine/            # the framework (domain-agnostic)
    agent.py         #   agent runner: Claude + MCP tools, live event stream, traces
    service.py       #   the loop: run → judge → remember → diagnose → rewrite → prove → promote
    evolver.py       #   self-diagnosis + prompt rewriting (evidence, root cause, lesson)
    llm.py           #   model client (Claude API, or an OpenAI-format gateway)
  usecases/          # pluggable use-case packs
    refunds/         #   order cancellation & refunds
    parcels/         #   lost-parcel replacement
  main.py            # FastAPI: /api/usecases, /api/state, /api/chat/stream (SSE), /api/reset
frontend/            # React UI: control agent vs evolving agent, live execution flow
docs/api-contract-v2.md
```

## Demo: a control group, side by side

Every chat message is handled by two agents at once, each on its own fresh copy of the mocked systems:

- **Non-evolving agent:** v1, frozen. Same model, same tools, never learns. This is the control group.
- **Evolving agent:** the current champion. When it fails, Evolve runs the loop automatically.

The next message shows the difference: the control agent repeats the mistake, and the evolved agent avoids it.

## Use cases included

Both packs share the same kind of trap: a **hidden asynchronous side effect** that leads a
well-behaved agent to perform an action twice.

### 1. Order cancellation & refunds (e-commerce support)
- **Tools (MCP `commerce`):** `get_order`, `cancel_order`, `get_payment`, `create_refund`, `send_notification`.
- **Hidden behaviour:** cancelling a card order on **Gateway X** makes the order system refund it automatically, via a delayed webhook.
- **What v1 gets wrong:** it cancels the order, then refunds it, so the customer is refunded twice while every tool call succeeds.
- **What it learns:** "Check the payment's gateway before refunding. On Gateway X, cancelling auto-refunds, so don't create a second refund."

### 2. Lost-parcel replacement (logistics support)
- **Tools (MCP `logistics`):** `get_shipment`, `file_lost_claim`, `list_replacements`, `create_replacement`, `send_notification`.
- **Hidden behaviour:** filing a lost claim on a **SwiftShip** shipment makes SwiftShip dispatch a replacement automatically, via a delayed webhook.
- **What v1 gets wrong:** it files the claim, then ships a replacement, so the customer receives two parcels.
- **What it learns:** "Only dispatch a replacement when the carrier isn't SwiftShip. SwiftShip replaces through its own claim."

What's mocked: the external systems (order system, payment gateway, carrier and notifications) are
in-memory and seeded per run. The agents, MCP protocol, outcome checks, evaluation and evolution are real.

## Try it

**Web app: https://unconference-buildathon.onrender.com** (deployed on Render: one Docker service
serving the UI, the API and the live event stream; see [docs/DEPLOY.md](docs/DEPLOY.md)).

## Run it yourself

```bash
# backend (Python 3.12, uv)
cd backend
cp .env.example .env          # add ANTHROPIC_API_KEY (or an OpenAI-format gateway, see .env.example)
uv sync
uv run uvicorn app.main:app --reload --port 8001

# frontend (dev server with hot reload, proxies /api to the backend)
cd frontend
npm install
npm run dev
```

For a single URL like the deployed app, run `cd frontend && npm run build`; the backend then serves the UI too.
Set `AUTOPILOT=false` in `backend/.env` to turn off automatic evolution.
