// Mock backend (VITE_MOCK=1). Simulates the v2 SSE chat stream:
//  "Cancel ORD-1024" -> both lanes double-refund -> automatic evolution promotes v2.
//  "Cancel ORD-4410" -> baseline (v1) double-refunds again, evolving (v2) passes, no evolution.
import type {
  AgentVersion,
  AppState,
  ChatEvent,
  Check,
  DiffLine,
  EvalCase,
  Example,
  GateCaseResult,
  GateResult,
  Lane,
  Ledger,
  Lesson,
  Refund,
} from './types'
import type { Api } from './api'

const now = () => new Date().toISOString()
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const inr = (n: number) => '₹' + n.toLocaleString('en-IN')
const jitter = (min = 200, max = 900) => min + Math.random() * (max - min)

// ---------------------------------------------------------------- fixtures

const V1_PROMPT = `You are a customer support agent for ShopKart.
You help customers cancel orders and get their money back.

Tools (MCP server "commerce"): get_order, cancel_order, get_payment, create_refund, send_notification.

Standard operating procedure for a cancellation request:
1. Look up the order with get_order and confirm it belongs to the customer.
2. If the order has shipped, do not cancel it; offer a return instead.
3. Cancel the order with cancel_order.
4. Check the payment with get_payment.
5. Issue a refund for the full order amount with create_refund.
6. Notify the customer with send_notification, including the refund amount.

Rules:
- Be polite and concise.
- Never refund more than the order amount.
- Always confirm the final outcome to the customer.`

const V2_PROMPT = `You are a customer support agent for ShopKart.
You help customers cancel orders and get their money back.

Tools (MCP server "commerce"): get_order, cancel_order, get_payment, create_refund, send_notification.

Standard operating procedure for a cancellation request:
1. Look up the order with get_order and confirm it belongs to the customer.
2. If the order has shipped, do not cancel it; offer a return instead.
3. Check the payment with get_payment BEFORE cancelling, and note the gateway.
4. Cancel the order with cancel_order.
5. If the payment gateway is "Gateway X", do NOT call create_refund:
   Gateway X refunds card payments automatically (async webhook) on cancellation.
   For all other gateways, issue a refund for the full amount with create_refund.
6. Notify the customer with send_notification, including the refund amount.

Rules:
- Be polite and concise.
- Never refund more than the order amount, counting automatic gateway refunds.
- Always confirm the final outcome to the customer.`

const V2_OVERCORRECT = V1_PROMPT.replace(
  '5. Issue a refund for the full order amount with create_refund.',
  '5. Do NOT call create_refund: cancelling an order refunds the customer automatically.',
)

interface Order {
  order_id: string
  customer: string
  amount: number
  method: 'card' | 'upi'
  gateway: string
  status: 'confirmed' | 'shipped'
}

const ORDERS: Record<string, Order> = {
  'ORD-1024': { order_id: 'ORD-1024', customer: 'Priya Sharma', amount: 2499, method: 'card', gateway: 'Gateway X', status: 'confirmed' },
  'ORD-2051': { order_id: 'ORD-2051', customer: 'Arjun Mehta', amount: 1899, method: 'card', gateway: 'Gateway Y', status: 'confirmed' },
  'ORD-3307': { order_id: 'ORD-3307', customer: 'Kavya Iyer', amount: 5499, method: 'upi', gateway: 'UPI', status: 'shipped' },
  'ORD-4410': { order_id: 'ORD-4410', customer: 'Rahul Verma', amount: 12999, method: 'card', gateway: 'Gateway X', status: 'confirmed' },
}

const EXAMPLES: Example[] = [
  { id: 'ex1', label: 'Cancel ORD-1024', message: 'Hi, please cancel my order ORD-1024 and refund my card. I ordered the wrong size.' },
  { id: 'ex2', label: 'Cancel ORD-4410', message: "I'd like to cancel order ORD-4410 and get my money back." },
]

const SEED_CASES: Omit<EvalCase, 'created_at'>[] = [
  { id: 'case-001', title: 'Card order on Gateway Y', origin: 'seed', task: 'Cancel ORD-2001 (card, Gateway Y) and refund.' },
  { id: 'case-002', title: 'UPI order', origin: 'seed', task: 'Cancel ORD-2002 (UPI) and refund.' },
  { id: 'case-003', title: 'Shipped order: refuse cancellation', origin: 'seed', task: 'Cancel ORD-2003, already shipped.' },
]

// ---------------------------------------------------------------- state

interface DB {
  champion_id: string
  versions: AgentVersion[]
  eval_cases: EvalCase[]
  evolving_now: boolean
  seq: number
  lessons: Lesson[] // lessons carried by each version (cumulative)
}
let db: DB = fresh()

function fresh(): DB {
  const t = now()
  return {
    champion_id: 'v1',
    versions: [{ id: 'v1', status: 'champion', parent_id: null, prompt: V1_PROMPT, created_at: t }],
    eval_cases: SEED_CASES.map((c) => ({ ...c, created_at: t })),
    evolving_now: false,
    seq: 0,
    lessons: [],
  }
}

const snapshot = (): AppState =>
  clone({
    baseline_id: 'v1',
    champion_id: db.champion_id,
    autopilot: true,
    evolving_now: db.evolving_now,
    versions: db.versions,
    eval_cases: db.eval_cases,
    examples: EXAMPLES,
    lessons: lessonsFor(db.champion_id),
  })

const lessonsFor = (v: string) => db.lessons.filter((l) => Number(l.version_id.slice(1)) <= Number(v.slice(1)))
const nextId = (p: string) => `${p}-${String(++db.seq).padStart(4, '0')}`
const knowsGatewayX = (versionId: string) => db.versions.find((v) => v.id === versionId)?.prompt.includes('Gateway X refunds') ?? false

function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split('\n')
  const B = b.split('\n')
  const L: number[][] = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0))
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { out.push({ op: ' ', text: A[i] }); i++; j++ }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', text: A[i++] })
    else out.push({ op: '+', text: B[j++] })
  }
  while (i < A.length) out.push({ op: '-', text: A[i++] })
  while (j < B.length) out.push({ op: '+', text: B[j++] })
  return out
}

// ---------------------------------------------------------------- stream

class Cancelled extends Error {}

export const mockApi: Api = {
  async getState() {
    await wait(120)
    return snapshot()
  },
  async reset() {
    await wait(300)
    db = fresh()
    return snapshot()
  },
  stream(message, onEvent) {
    let cancelled = false
    const emit = (ev: ChatEvent) => {
      if (cancelled) throw new Cancelled()
      onEvent(ev)
    }
    const pause = async (min?: number, max?: number) => {
      await wait(jitter(min, max))
      if (cancelled) throw new Cancelled()
    }
    ;(async () => {
      try {
        const runIds: Record<Lane, string> = { baseline: nextId('run'), evolving: nextId('run') }
        const versions: Record<Lane, string> = { baseline: 'v1', evolving: db.champion_id }
        const results = await Promise.all(
          (['baseline', 'evolving'] as Lane[]).map((lane) => runLane(lane, versions[lane], runIds[lane], message, emit, pause)),
        )
        emit({ type: 'lane_done', lane: 'baseline' })
        const evolving = results[1]
        if (evolving.passed === false) await evolve(runIds.evolving, message, evolving, emit, pause)
        emit({ type: 'lane_done', lane: 'evolving' })
        emit({ type: 'done' })
      } catch (e) {
        if (!(e instanceof Cancelled)) {
          onEvent({ type: 'error', detail: String(e) })
          onEvent({ type: 'done' })
        }
      } finally {
        db.evolving_now = false
      }
    })()
    return () => {
      cancelled = true
    }
  },
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

type Emit = (ev: ChatEvent) => void
type Pause = (min?: number, max?: number) => Promise<void>

async function runLane(lane: Lane, versionId: string, runId: string, message: string, emit: Emit, pause: Pause) {
  emit({ type: 'run_started', lane, version_id: versionId, run_id: runId, lessons: clone(lessonsFor(versionId)) })
  const orderId = message.toUpperCase().match(/ORD-\d+/)?.[0]
  const order = orderId ? ORDERS[orderId] : undefined
  const fixed = knowsGatewayX(versionId)

  const think = async () => {
    emit({ type: 'agent_thinking', lane })
    await pause(500, 1300)
  }
  let callSeq = 0
  const call = async (rationale: string, tool: string, input: Record<string, unknown>, output: unknown, is_error = false) => {
    const call_id = `${lane[0]}${++callSeq}`
    emit({ type: 'agent_text', lane, text: rationale })
    await pause(250, 600)
    emit({ type: 'tool_call', lane, call_id, server: 'commerce', tool, input })
    await pause(250, 800)
    emit({ type: 'tool_result', lane, call_id, tool, output, is_error })
    await pause(150, 400)
  }

  await think()

  if (!orderId) {
    const text = "Happy to help! Could you share your order ID (e.g. ORD-1234) so I can look into it?"
    emit({ type: 'agent_reply', lane, text })
    await pause()
    emit({ type: 'checks', lane, run_id: runId, passed: null, checks: [], ledger: null })
    return { passed: null, reply: text, checks: [] as Check[], ledger: null }
  }

  if (!order) {
    await call(`Looking up ${orderId} to see what the customer ordered.`, 'get_order', { order_id: orderId }, `Order ${orderId} not found`, true)
    await think()
    emit({ type: 'agent_reply', lane, text: `I couldn't find order ${orderId}. Could you double-check the ID?` })
    await pause()
    emit({ type: 'checks', lane, run_id: runId, passed: null, checks: [], ledger: null })
    return { passed: null, reply: '', checks: [] as Check[], ledger: null }
  }

  const refunds: Refund[] = []
  const notifications: Ledger['notifications'] = []
  let rf = 0
  const refundId = () => `rf_${order.order_id.slice(4)}_${++rf}`

  await call('Checking the order status before doing anything else.', 'get_order', { order_id: order.order_id }, {
    order_id: order.order_id,
    customer: order.customer,
    status: order.status,
    amount: order.amount,
    currency: 'INR',
    payment_method: order.method,
  })
  await think()

  const payment = (r: Refund[]) => ({ order_id: order.order_id, amount: order.amount, gateway: order.gateway, method: order.method, refunds: r.map((x) => ({ ...x })) })

  let reply: string
  let statusAfter: string = order.status

  if (order.status === 'shipped') {
    emit({ type: 'agent_text', lane, text: 'The order has already shipped, so it cannot be cancelled. I should offer a return instead.' })
    await pause()
    await think()
    const msg = `Hi ${order.customer.split(' ')[0]}, ${order.order_id} has already shipped so we can't cancel it, but you can return it within 7 days of delivery for a full refund.`
    await call('Emailing the customer the return steps instead.', 'send_notification', { order_id: order.order_id, channel: 'email', message: msg }, { notification_id: 'ntf_' + order.order_id.slice(4), status: 'sent' })
    notifications.push({ notification_id: 'ntf_' + order.order_id.slice(4), message: msg })
    reply = `Your order ${order.order_id} has already shipped, so it can't be cancelled. You can return it after delivery for a full refund — I've emailed you the steps.`
  } else {
    if (fixed) {
      await call('Checking the payment gateway before cancelling, since some gateways refund on their own.', 'get_payment', { order_id: order.order_id }, payment(refunds))
      if (order.gateway === 'Gateway X') {
        await think()
        emit({ type: 'agent_text', lane, text: 'Paid by card on Gateway X: it refunds automatically when the order is cancelled, so I must not call create_refund.' })
        await pause()
      }
      await think()
      await call('Order is confirmed and not shipped, so I can cancel it now.', 'cancel_order', { order_id: order.order_id, reason: 'customer_request' }, { order_id: order.order_id, status: 'cancelled' })
    } else {
      await call('Order has not shipped. Following the SOP: cancel first.', 'cancel_order', { order_id: order.order_id, reason: 'customer_request' }, { order_id: order.order_id, status: 'cancelled' })
      await think()
      await call('Checking the payment to see whether a refund already exists.', 'get_payment', { order_id: order.order_id }, payment(refunds))
      await think()
    }
    statusAfter = 'cancelled'
    if (!(fixed && order.gateway === 'Gateway X')) {
      if (fixed) await think()
      const r: Refund = { refund_id: refundId(), amount: order.amount, status: 'processing', initiated_by: 'agent' }
      refunds.push(r)
      await call(refunds.length ? 'Issuing the refund.' : 'No refund on the payment yet, so I will refund the full amount.', 'create_refund', { order_id: order.order_id, amount: order.amount, reason: 'order_cancelled' }, { refund_id: r.refund_id, status: r.status, amount: r.amount })
    }
    await think()
    const msg = `Hi ${order.customer.split(' ')[0]}, your order ${order.order_id} is cancelled and a refund of ${inr(order.amount)} is on its way (3–5 business days).`
    const nid = `ntf_${order.order_id.slice(4)}`
    await call('Letting the customer know the order is cancelled and the refund is on its way.', 'send_notification', { order_id: order.order_id, channel: 'email', message: msg }, { notification_id: nid, status: 'sent' })
    notifications.push({ notification_id: nid, message: msg })
    reply = `Your order ${order.order_id} has been cancelled, and a full refund of ${inr(order.amount)} went through. You'll see it in 3–5 business days.`
  }

  await think()
  emit({ type: 'agent_reply', lane, text: reply })
  await pause(400, 900)

  if (order.gateway === 'Gateway X' && statusAfter === 'cancelled') {
    refunds.unshift({ refund_id: refundId(), amount: order.amount, status: 'processing', initiated_by: 'order-system' })
    emit({ type: 'async_effects', lane, description: `Order-system webhook delivered: Gateway X auto-refund ${inr(order.amount)}` })
    await pause(400, 900)
  }

  const total = refunds.reduce((s, r) => s + r.amount, 0)
  const checks: Check[] =
    order.status === 'shipped'
      ? [
          { name: 'not_cancelled', label: 'Shipped order not cancelled', passed: true, detail: `${order.order_id} is still shipped` },
          { name: 'no_refund', label: 'No refund for shipped order', passed: total === 0, detail: `${inr(total)} refunded` },
          { name: 'customer_notified', label: 'Customer notified', passed: true, detail: 'Return instructions sent' },
        ]
      : [
          { name: 'order_cancelled', label: 'Order cancelled', passed: true, detail: `${order.order_id} is cancelled` },
          { name: 'customer_refunded', label: 'Customer refunded in full', passed: total >= order.amount, detail: `${inr(total)} refunded on a ${inr(order.amount)} order` },
          {
            name: 'no_duplicate_refund',
            label: 'No duplicate refunds',
            passed: total <= order.amount,
            detail: total > order.amount ? `${inr(total)} refunded on a ${inr(order.amount)} order (${refunds.length} refunds), expected ${inr(order.amount)}` : `${refunds.length} refund, total ${inr(total)}`,
          },
          { name: 'customer_notified', label: 'Customer notified', passed: notifications.length > 0, detail: `${notifications.length} notification sent` },
        ]
  const passed = checks.every((c) => c.passed)
  const ledger: Ledger = {
    order_id: order.order_id,
    order_status_before: order.status,
    order_status_after: statusAfter,
    amount: order.amount,
    currency: 'INR',
    refunds,
    notifications,
  }
  emit({ type: 'checks', lane, run_id: runId, passed, checks, ledger })
  return { passed, reply, checks, ledger }
}

async function evolve(runId: string, message: string, run: { reply: string; checks: Check[]; ledger: Ledger | null }, emit: Emit, pause: Pause) {
  await pause(500, 900)
  if (db.evolving_now) {
    emit({ type: 'evolution_skipped', lane: 'evolving', reason: 'An evolution cycle is already running.' })
    return
  }
  if (db.lessons.length > 0) {
    emit({ type: 'evolution_skipped', lane: 'evolving', reason: 'Already learned from this failure mode.' })
    return
  }
  db.evolving_now = true
  emit({
    type: 'evolution_started',
    lane: 'evolving',
    run_id: runId,
    reason: 'Outcome check failed: no_duplicate_refund',
    belief: run.reply,
    reality: run.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.detail}`),
    ledger: run.ledger,
  })
  await pause(500, 900)

  const ec: EvalCase = {
    id: `case-${String(db.eval_cases.length + 1).padStart(3, '0')}`,
    title: 'Card order on Gateway X (async auto-refund)',
    origin: 'auto',
    source_run_id: runId,
    task: message,
    created_at: now(),
  }
  db.eval_cases.push(ec)
  emit({ type: 'eval_case_added', lane: 'evolving', case: clone(ec) })
  await pause(400, 800)

  const champ = db.versions.find((v) => v.id === db.champion_id)!
  const MAX = 3
  let feedback: string | null = null
  for (let attempt = 1; attempt <= MAX; attempt++) {
    if (attempt > 1) {
      emit({ type: 'evolution_retry', lane: 'evolving', attempt, max_attempts: MAX, reason: feedback! })
      await pause(600, 900)
    }
    emit({ type: 'diagnosing', lane: 'evolving', version_id: champ.id })
    await pause(2500, 3500)

    // Attempt 1 over-corrects (never refunds at all); attempt 2 gets it right.
    const good = attempt > 1
    const prompt = good ? V2_PROMPT : V2_OVERCORRECT
    const cand: AgentVersion = {
      id: `v${db.versions.length + 1}`,
      status: 'candidate',
      parent_id: champ.id,
      prompt,
      created_at: now(),
      source_run_id: runId,
      diagnosis: good
        ? 'My first fix stopped refunding everywhere. Only Gateway X refunds automatically on cancellation.'
        : 'Every tool call succeeded, yet the customer got two refunds: the gateway refunded on its own after cancel_order.',
      root_cause: good
        ? 'The auto-refund is specific to Gateway X card payments. Other gateways still need create_refund, so the rule must check the gateway.'
        : 'The SOP always calls create_refund after cancelling, but cancelling already triggers a refund asynchronously, so the agent cannot see it in time.',
      change_summary: good
        ? 'Check the gateway first; skip create_refund only for Gateway X card orders.'
        : 'Never call create_refund after cancel_order.',
      evidence: good
        ? [
            '[eval set] case-001 (Gateway Y) failed with v2: the customer got no refund at all',
            `[end state] Only Gateway X orders got a refund initiated by order-system`,
            '[trace] get_payment returns the gateway name before I cancel',
          ]
        : [
            '[trace] I called create_refund right after cancel_order',
            `[end state] A second ${inr(run.ledger?.amount ?? 0)} refund was initiated by order-system after the run`,
          ],
      lesson: good
        ? 'For Gateway X card orders, cancelling refunds automatically, so never issue a manual refund.'
        : 'Cancelling refunds automatically, so never issue a manual refund.',
      diff: lineDiff(champ.prompt, prompt),
      gate: null,
    }
    db.versions.push(cand)
    emit({ type: 'candidate_proposed', lane: 'evolving', version: clone(cand) })
    await pause(700, 1100)

    const cases = db.eval_cases.map((c) => ({ case_id: c.id, title: c.title, origin: c.origin }))
    emit({ type: 'gate_started', lane: 'evolving', champion_id: champ.id, candidate_id: cand.id, cases })
    const results: GateCaseResult[] = []
    for (const c of cases) {
      await pause(600, 1200)
      const champPass = c.origin !== 'auto' || knowsGatewayX(champ.id)
      const candPass = good || c.case_id !== 'case-001'
      const r: GateCaseResult = {
        ...c,
        champion: { run_id: nextId('run'), passed: champPass, failed_checks: champPass ? [] : ['no_duplicate_refund'] },
        candidate: { run_id: nextId('run'), passed: candPass, failed_checks: candPass ? [] : ['customer_refunded'] },
      }
      results.push(r)
      emit({ type: 'gate_case', lane: 'evolving', result: r })
    }
    await pause(400, 700)

    const champion_score = results.filter((r) => r.champion.passed).length
    const candidate_score = results.filter((r) => r.candidate.passed).length
    const regressions = results.filter((r) => r.champion.passed && !r.candidate.passed).map((r) => r.case_id)
    const promoted = candidate_score > champion_score && regressions.length === 0
    const reg = results.find((r) => regressions.includes(r.case_id))
    feedback = reg
      ? `${cand.id} regressed on ${reg.case_id} (${reg.title}): Customer refunded in full`
      : `${cand.id} did not beat ${champ.id}`
    const gate: GateResult = {
      champion_id: champ.id,
      candidate_id: cand.id,
      results,
      champion_score,
      candidate_score,
      total: results.length,
      regressions,
      decision: promoted ? 'promoted' : 'rejected',
      reason: promoted
        ? `${cand.id} passes ${candidate_score}/${results.length} vs ${champion_score}/${results.length} with no regressions.`
        : `${feedback}. Fixed the new case but broke one that used to pass.`,
    }
    cand.gate = gate
    if (promoted) {
      champ.status = 'retired'
      cand.status = 'champion'
      db.champion_id = cand.id
      db.lessons.push({ version_id: cand.id, lesson: cand.lesson!, case_id: ec.id })
    } else cand.status = 'rejected'
    emit({ type: 'gate_result', lane: 'evolving', gate: clone(gate) })
    if (promoted) break
    if (attempt === MAX) {
      await pause()
      emit({ type: 'evolution_skipped', lane: 'evolving', reason: `Gave up after ${MAX} attempts; ${champ.id} stays champion.` })
    }
  }
  db.evolving_now = false
}
