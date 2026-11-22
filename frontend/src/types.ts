// Copied from docs/api-contract-v2.md — keep in sync with the backend.

export type Lane = "baseline" | "evolving";

export interface DiffLine { op: "+" | "-" | " "; text: string }
export interface Check { name: string; label: string; passed: boolean; detail: string }
export interface Refund { refund_id: string; amount: number; status: string; initiated_by: string }
export interface LedgerItem { id: string; text: string; by: string; flagged: boolean }
export interface Ledger {
  subject: string;                                  // "ORD-1024" | "SHP-5521"
  facts: { label: string; value: string }[];
  items_label: string;                              // "Refunds" | "Replacement shipments"
  items: LedgerItem[];                              // flagged = created by hidden automation
  total: { label: string; value: string; bad: boolean };
  notifications: { notification_id: string; message: string }[];
}
export interface EvalCase { id: string; title: string; origin: "seed" | "auto"; source_run_id?: string; task: string; created_at: string }
export interface AgentVersion {
  id: string; status: "champion" | "candidate" | "rejected" | "retired";
  parent_id: string | null; prompt: string; created_at: string;
  source_run_id?: string; diagnosis?: string; root_cause?: string; change_summary?: string;
  evidence?: string[];   // 2-4 observations, each starting with "[trace]", "[end state]" or "[eval set]"
  lesson?: string;       // the lesson learned, one plain-English rule
  diff?: DiffLine[]; gate?: GateResult | null;
}
export interface GateCaseResult {
  case_id: string; title: string; origin: "seed" | "auto";
  champion: { run_id: string; passed: boolean; failed_checks: string[] };
  candidate: { run_id: string; passed: boolean; failed_checks: string[] };
}
export interface GateResult {
  champion_id: string; candidate_id: string; results: GateCaseResult[];
  champion_score: number; candidate_score: number; total: number;
  regressions: string[]; decision: "promoted" | "rejected"; reason: string;
}

export interface Example { id: string; label: string; message: string }   // clickable example queries
export interface Lesson { version_id: string; lesson: string; case_id: string | null }  // a lesson a version carries

export interface AppState {
  baseline_id: string;          // always "v1"
  champion_id: string;          // evolving lane's current version
  autopilot: boolean;           // automatic evolution on (always true for now)
  evolving_now: boolean;        // an evolution cycle is in progress
  versions: AgentVersion[];     // oldest first
  eval_cases: EvalCase[];       // oldest first
  examples: Example[];
  lessons: Lesson[];            // lessons the current champion has learned, oldest first
  usecase?: string;
}

export interface UseCase {
  id: string;
  name: string;
  domain: string;
  icon: string;               // lucide icon name hint: "receipt" | "package"
  summary: string;
  agent_role: string;
  mcp_server: string;
  tools: { name: string; description: string }[];
  hidden_behavior: string;
  expected_failure: string;
  checks: string[];
  seed_cases: string[];
  queries: { label: string; message: string }[];
}

export type GateCaseRef = { case_id: string; title: string; origin: "seed" | "auto" }

export type ChatEvent =
  // ---- both lanes: the agent run ----
  | { type: "run_started";  lane: Lane; version_id: string; run_id: string; lessons?: Lesson[] }
  | { type: "agent_thinking"; lane: Lane }
  | { type: "agent_text";   lane: Lane; text: string }
  | { type: "tool_call";    lane: Lane; call_id: string; server: string; tool: string; input: Record<string, unknown> }
  | { type: "tool_result";  lane: Lane; call_id: string; tool: string; output: unknown; is_error: boolean }
  | { type: "agent_reply";  lane: Lane; text: string }
  | { type: "async_effects"; lane: Lane; description: string }
  | { type: "checks";       lane: Lane; run_id: string; passed: boolean | null; checks: Check[]; ledger: Ledger | null }
  | { type: "lane_done";    lane: Lane }
  // ---- evolving lane only: automatic evolution ----
  | { type: "evolution_started"; lane: "evolving"; run_id: string; reason: string;
      belief?: string; reality?: string[]; ledger?: Ledger | null }
  | { type: "eval_case_added";   lane: "evolving"; case: EvalCase }
  | { type: "diagnosing";        lane: "evolving"; version_id: string }
  | { type: "candidate_proposed"; lane: "evolving"; version: AgentVersion }
  | { type: "gate_started";      lane: "evolving"; champion_id: string; candidate_id: string; cases: GateCaseRef[] }
  | { type: "gate_case";         lane: "evolving"; result: GateCaseResult }
  | { type: "gate_result";       lane: "evolving"; gate: GateResult }
  | { type: "evolution_skipped"; lane: "evolving"; reason: string }
  | { type: "evolution_retry";   lane: "evolving"; attempt: number; max_attempts: number; reason: string }
  | { type: "error"; lane?: Lane; detail: string }
  | { type: "done" };
