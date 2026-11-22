# Evolve: agents that learn from their own production failures

Agents usually ship once and never improve. Evolve runs an agent in production, catches
failures from the **real outcome** (not from tool errors), turns each failure into an eval case,
has Claude rewrite the agent's prompt, and promotes the new version only if it beats the
current one on the whole eval set with no regressions.

**Demo agent:** ShopKart order support. It cancels orders and refunds customers through an MCP
server (`get_order`, `cancel_order`, `get_payment`, `create_refund`, `send_notification`). Every
tool is documented accurately. The catch is in how the systems are wired: cancelling a
**Gateway X** card order auto-refunds it, so agent v1 refunds the customer twice while every
tool call succeeds.

## The loop (fully automatic)

Every chat message is handled by two agents side by side, each in a fresh seeded sandbox:
a **non-evolving** agent (v1, frozen: the control group) and the **evolving** agent (current champion).
Both stream their execution live: thinking, MCP tool calls, results, async side effects and outcome checks.

When the evolving agent fails, with no human in the loop:

1. **Failure caught**: outcome checks run on the real end state (e.g. "no duplicate refunds"), not on tool errors.
2. **Eval set grows**: the failed run becomes an eval case automatically.
3. **Agent diagnoses itself**: it reads the trace and the end state, then proposes a new prompt (shown as a diff).
4. **Prove & promote**: champion and candidate both run every eval case. The candidate is promoted only if it
   fixes the failure it came from, scores higher, and has zero regressions. Otherwise it's rejected.

The next message shows the difference: the frozen agent makes the same mistake, the evolved one doesn't.
Set `AUTOPILOT=false` in `backend/.env` to stop automatic evolution.

## Run it

```bash
# backend (Python 3.12, uv)
cd backend
cp .env.example .env          # add ANTHROPIC_API_KEY (or an OpenAI-format gateway, see .env.example)
uv sync
uv run uvicorn app.main:app --reload --port 8001

# frontend (dev)
cd frontend
npm install
npm run dev                   # http://localhost:5173, proxies /api to :8001
```

Single-URL mode (for the demo): `cd frontend && npm run build`, then the backend serves the
built app at http://localhost:8001.

## Layout

```
backend/app/
  domain/      # the one agent we evolve: mocked world, MCP server, checks, seed cases, v1 prompt
  engine/      # domain-agnostic: agent runner, evolver, run/eval/gate/promote service
  main.py      # FastAPI routes
frontend/      # React + Vite UI
docs/api-contract-v2.md
```

## What's mocked

Mocked: the order system, payment gateway (including the async order-system webhook) and notifications (in-memory, seeded per run).
Real: the Claude agent, the MCP protocol and tool calls, the outcome checks, the evolver and the gate.
