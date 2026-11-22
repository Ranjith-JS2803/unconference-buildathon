import type { AgentVersion, ChatEvent, Check, EvalCase, GateCaseRef, GateCaseResult, GateResult, Lane, Ledger, Lesson } from './types'

/** Everything a lane shows, in arrival order. Evolution steps are items too, so the
 *  render queue writes the whole story strictly in order. */
export type Item =
  | { kind: 'thought'; key: number; text: string }
  | { kind: 'tool'; key: number; call_id: string; server: string; tool: string; input: Record<string, unknown>; result?: { output: unknown; is_error: boolean } }
  | { kind: 'reply'; key: number; text: string }
  | { kind: 'effect'; key: number; text: string }
  | { kind: 'checks'; key: number; passed: boolean | null; checks: Check[]; ledger: Ledger | null; allToolsOk: boolean }
  | { kind: 'evo_start'; key: number; reason: string; belief: string; reality: string[]; ledger: Ledger | null; toolCount: number; allToolsOk: boolean }
  | { kind: 'evo_case'; key: number; evalCase: EvalCase }
  | { kind: 'evo_diag'; key: number; version_id: string }
  | { kind: 'evo_candidate'; key: number; version: AgentVersion }
  | { kind: 'evo_gate'; key: number; champion_id: string; candidate_id: string; cases: GateCaseRef[] }
  | { kind: 'evo_gate_case'; key: number; result: GateCaseResult }
  | { kind: 'evo_result'; key: number; gate: GateResult }
  | { kind: 'evo_skipped'; key: number; reason: string }
  | { kind: 'evo_retry'; key: number; attempt: number; max_attempts: number; reason: string }

export const isEvo = (it: Item) => it.kind.startsWith('evo_')

export interface LaneState {
  versionId?: string
  lessons?: Lesson[]
  items: Item[]
  thinking: boolean
  running: boolean
  errors: string[]
}

export const emptyLane = (): LaneState => ({ items: [], thinking: false, running: false, errors: [] })
export type Lanes = Record<Lane, LaneState>
export const emptyLanes = (): Lanes => ({ baseline: emptyLane(), evolving: emptyLane() })

let keySeq = 0
const k = () => ++keySeq

function laneReduce(s: LaneState, ev: ChatEvent): LaneState {
  // Any event other than agent_thinking ends the "Thinking…" indicator.
  const base: LaneState = { ...s, thinking: ev.type === 'agent_thinking' }
  const add = (it: Item): LaneState => ({ ...base, items: [...s.items, it] })
  switch (ev.type) {
    case 'run_started':
      return { ...base, versionId: ev.version_id, lessons: ev.lessons, running: true }
    case 'agent_thinking':
      return base
    case 'agent_text':
      return add({ kind: 'thought', key: k(), text: ev.text })
    case 'tool_call':
      return add({ kind: 'tool', key: k(), call_id: ev.call_id, server: ev.server, tool: ev.tool, input: ev.input })
    case 'tool_result':
      return {
        ...base,
        items: s.items.map((it) => (it.kind === 'tool' && it.call_id === ev.call_id ? { ...it, result: { output: ev.output, is_error: ev.is_error } } : it)),
      }
    case 'agent_reply':
      return add({ kind: 'reply', key: k(), text: ev.text })
    case 'async_effects':
      return add({ kind: 'effect', key: k(), text: ev.description })
    case 'checks': {
      const allToolsOk = s.items.every((it) => it.kind !== 'tool' || !it.result?.is_error)
      return add({ kind: 'checks', key: k(), passed: ev.passed, checks: ev.checks, ledger: ev.ledger, allToolsOk })
    }
    case 'lane_done':
      return { ...base, running: false }
    case 'evolution_started':
    {
      const tools = s.items.filter((it) => it.kind === 'tool')
      const lastChecks = [...s.items].reverse().find((it) => it.kind === 'checks')
      return add({
        kind: 'evo_start',
        key: k(),
        reason: ev.reason,
        belief: ev.belief ?? [...s.items].reverse().find((it) => it.kind === 'reply')?.text ?? '',
        reality:
          ev.reality ??
          (lastChecks?.kind === 'checks' ? lastChecks.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.detail}`) : []),
        ledger: ev.ledger ?? (lastChecks?.kind === 'checks' ? lastChecks.ledger : null),
        toolCount: tools.length,
        allToolsOk: tools.every((it) => it.kind === 'tool' && !it.result?.is_error),
      })
    }
    case 'eval_case_added':
      return add({ kind: 'evo_case', key: k(), evalCase: ev.case })
    case 'diagnosing':
      return add({ kind: 'evo_diag', key: k(), version_id: ev.version_id })
    case 'candidate_proposed':
      return add({ kind: 'evo_candidate', key: k(), version: ev.version })
    case 'gate_started':
      return add({ kind: 'evo_gate', key: k(), champion_id: ev.champion_id, candidate_id: ev.candidate_id, cases: ev.cases })
    case 'gate_case':
      return add({ kind: 'evo_gate_case', key: k(), result: ev.result })
    case 'gate_result':
      return add({ kind: 'evo_result', key: k(), gate: ev.gate })
    case 'evolution_retry':
      return add({ kind: 'evo_retry', key: k(), attempt: ev.attempt, max_attempts: ev.max_attempts, reason: ev.reason })
    case 'evolution_skipped':
      return add({ kind: 'evo_skipped', key: k(), reason: ev.reason })
    case 'error':
      return { ...base, errors: [...s.errors, ev.detail] }
    default:
      return s
  }
}

export function lanesReduce(lanes: Lanes, ev: ChatEvent): Lanes {
  if (ev.type === 'done') {
    return {
      baseline: { ...lanes.baseline, thinking: false, running: false },
      evolving: { ...lanes.evolving, thinking: false, running: false },
    }
  }
  if (!('lane' in ev) || !ev.lane) return lanes
  return { ...lanes, [ev.lane]: laneReduce(lanes[ev.lane], ev) }
}
