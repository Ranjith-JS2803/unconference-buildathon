# API contract v2: side-by-side chat with live execution + automatic evolution

Backend: FastAPI on `http://localhost:8001` (Vite proxies `/api`). JSON unless noted.

## Concept
- Every chat message is handled by **two agents in parallel**, each in its own fresh sandbox:
  - **baseline** lane: the non-evolving agent, frozen at `v1` forever.
  - **evolving** lane: the current champion (`v1`, then `v2`, ...).
- After each run, outcome checks judge the real end state.
- If the **evolving** agent fails, the engine evolves it **automatically, with no button**:
  failure → added to the eval set → agent diagnoses and proposes a new prompt → gate (champion vs
  candidate on all eval cases) → promote or reject. All of this streams as events on the evolving lane.
- The next message then shows the contrast: baseline fails again, evolving passes.

## Types

```ts
type Lane = "baseline" | "evolving";

interface DiffLine { op: "+" | "-" | " "; text: string }
interface Check { name: string; label: string; passed: boolean; detail: string }
interface Refund { refund_id: string; amount: number; status: string; initiated_by: string }
interface Ledger {
  order_id: string; order_status_before: string; order_status_after: string;
  amount: number; currency: string; refunds: Refund[];
  notifications: { notification_id: string; message: string }[];
}
interface EvalCase { id: string; title: string; origin: "seed" | "auto"; source_run_id?: string; task: string; created_at: string }
interface AgentVersion {
  id: string; status: "champion" | "candidate" | "rejected" | "retired";
  parent_id: string | null; prompt: string; created_at: string;
  source_run_id?: string; diagnosis?: string; root_cause?: string; change_summary?: string;
  evidence?: string[];   // 2-4 observations, each starting with "[trace]", "[end state]" or "[eval set]"
  lesson?: string;       // the lesson learned, one plain-English rule
  diff?: DiffLine[]; gate?: GateResult | null;
}
interface GateCaseResult {
  case_id: string; title: string; origin: "seed" | "auto";
  champion: { run_id: string; passed: boolean; failed_checks: string[] };
  candidate: { run_id: string; passed: boolean; failed_checks: string[] };
}
interface GateResult {
  champion_id: string; candidate_id: string; results: GateCaseResult[];
  champion_score: number; candidate_score: number; total: number;
  regressions: string[]; decision: "promoted" | "rejected"; reason: string;
}

interface Example { id: string; label: string; message: string }   // clickable example queries
interface Lesson { version_id: string; lesson: string; case_id: string | null }  // a lesson a version carries

interface AppState {
  baseline_id: string;          // always "v1"
  champion_id: string;          // evolving lane's current version
  autopilot: boolean;           // automatic evolution on (always true for now)
  evolving_now: boolean;        // an evolution cycle is in progress
  versions: AgentVersion[];     // oldest first
  eval_cases: EvalCase[];       // oldest first
  examples: Example[];
  lessons: Lesson[];            // lessons the current champion has learned, oldest first
}
```

## Routes

| Method | Path | Returns |
|---|---|---|
| GET  | `/api/state` | `AppState` |
| GET  | `/api/chat/stream?message=<urlencoded>` | **Server-Sent Events** stream (use `EventSource`) |
| POST | `/api/reset` | `AppState` |

Errors on JSON routes: non-2xx with `{ "detail": string }`.

## SSE events
Each SSE message is `data: <json>` with a `type` field. Events from the two lanes interleave.
The stream ends after `{"type":"done"}`. The client should then close the EventSource and refetch `/api/state`.

```ts
type ChatEvent =
  // ---- both lanes: the agent run ----
  | { type: "run_started";  lane: Lane; version_id: string; run_id: string; lessons: Lesson[] }  // lessons this agent runs with
  | { type: "agent_thinking"; lane: Lane }                       // model call in flight
  | { type: "agent_text";   lane: Lane; text: string }           // text the agent wrote between tool calls
  | { type: "tool_call";    lane: Lane; call_id: string; server: "commerce"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result";  lane: Lane; call_id: string; tool: string; output: unknown; is_error: boolean }
  | { type: "agent_reply";  lane: Lane; text: string }           // final reply to the customer
  | { type: "async_effects"; lane: Lane; description: string }   // e.g. "Order-system webhook delivered: refund ₹2,499"
  | { type: "checks";       lane: Lane; run_id: string; passed: boolean | null; checks: Check[]; ledger: Ledger | null }
      // passed === null when the message didn't reference a known order (nothing to judge)
  | { type: "lane_done";    lane: Lane }

  // ---- evolving lane only: automatic evolution ----
  | { type: "evolution_started"; lane: "evolving"; run_id: string; reason: string;
      belief: string;          // what the agent believed: its own final reply to the customer
      reality: string[];       // what actually happened: "<check label>: <detail>" per failed check
      ledger: Ledger | null }
  | { type: "eval_case_added";   lane: "evolving"; case: EvalCase }
  | { type: "diagnosing";        lane: "evolving"; version_id: string }      // "Agent is diagnosing the failure..."
  | { type: "candidate_proposed"; lane: "evolving"; version: AgentVersion }  // diagnosis, root_cause, change_summary, diff
  | { type: "gate_started";      lane: "evolving"; champion_id: string; candidate_id: string; cases: { case_id: string; title: string; origin: "seed" | "auto" }[] }
  | { type: "gate_case";         lane: "evolving"; result: GateCaseResult }  // one per case as it completes
  | { type: "gate_result";       lane: "evolving"; gate: GateResult }
  | { type: "evolution_retry";   lane: "evolving"; attempt: number; max_attempts: number; reason: string }
      // after a rejected gate_result: the agent revises its fix (diagnosing → candidate_proposed → gate… repeat)
      // diagnosing / candidate_proposed / gate_result also carry `attempt: number`
  | { type: "evolution_skipped"; lane: "evolving"; reason: string }          // e.g. "already learned", "evolution already running"

  | { type: "error"; lane?: Lane; detail: string }
  | { type: "done" };
```

Typical timeline for "Cancel ORD-1024" on a fresh system: both lanes stream tool calls
(get_order → cancel_order → get_payment → create_refund → send_notification), then
`async_effects`, then `checks` with passed=false on both. The baseline lane ends. The evolving lane continues:
evolution_started → eval_case_added → diagnosing → candidate_proposed → gate_started → gate_case ×N →
gate_result (promoted) → lane_done → done.
