// Mock backend (VITE_MOCK=1). A tiny engine plus two pluggable use-case packs.
// Each pack has the same shape the real framework uses: agent prompt, MCP tools,
// outcome checks and seed cases, plus a hidden integration quirk v1 gets wrong.
import type {
  AgentVersion,
  AppState,
  ChatEvent,
  Check,
  DiffLine,
  EvalCase,
  GateCaseResult,
  GateResult,
  Lane,
  Ledger,
  LedgerItem,
  Lesson,
  UseCase,
} from './types'
import type { Api } from './api'

const now = () => new Date().toISOString()
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const inr = (n: number) => '₹' + n.toLocaleString('en-IN')
const jitter = (min = 200, max = 900) => min + Math.random() * (max - min)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- pack shape

type Mode = 'v1' | 'good' | 'over' // naive SOP, correct fix, over-correction
type Step =
  | { note: string }
  | { rationale: string; tool: string; input: Record<string, unknown>; output: unknown; is_error?: boolean }
interface Sim {
  steps: Step[]
  reply: string
  effect?: string
  ledger: Ledger
  checks: Check[]
}
interface AttemptCopy {
  mode: Mode
  diagnosis: string
  root_cause: string
  change_summary: string
  evidence: string[]
  lesson: string
}
interface Pack {
  uc: UseCase
  prompts: Record<Mode, string>
  subjectRe: RegExp
  simulate(subject: string, mode: Mode): Sim | null // null = unknown subject
  askForId: string
  seedTasks: string[]
  autoCaseTitle: string
  failedCheck: string
  regressCheckLabel: string
  attempts: AttemptCopy[] // last one is the fix that gets promoted
  gateSubject: string // a subject used to replay the auto case
}

const first = (name: string) => name.split(' ')[0]

// ---------------------------------------------------------------- pack: refunds

const REFUNDS_V1 = `You are a customer support agent for ShopKart.
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

const REFUNDS_GOOD = `You are a customer support agent for ShopKart.
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

const REFUNDS_OVER = REFUNDS_V1.replace(
  '5. Issue a refund for the full order amount with create_refund.',
  '5. Do NOT call create_refund: cancelling an order refunds the customer automatically.',
)

const ORDERS: Record<string, { customer: string; amount: number; gateway: string }> = {
  'ORD-1024': { customer: 'Priya Sharma', amount: 2499, gateway: 'Gateway X' },
  'ORD-4410': { customer: 'Rahul Verma', amount: 12999, gateway: 'Gateway X' },
  'ORD-2001': { customer: 'Arjun Mehta', amount: 1899, gateway: 'Gateway Y' },
}

const refunds: Pack = {
  uc: {
    id: 'refunds',
    name: 'Order cancellation & refunds',
    domain: 'E-commerce customer support',
    icon: 'receipt',
    summary: 'Cancels orders and refunds customers through a commerce MCP server.',
    agent_role: 'A support agent for an online store. It handles cancellation requests: checks the order, cancels it, refunds the customer and notifies them.',
    mcp_server: 'commerce',
    tools: [
      { name: 'get_order', description: 'Look up an order: status, amount, customer, payment method.' },
      { name: 'cancel_order', description: 'Cancel an order that has not shipped.' },
      { name: 'get_payment', description: 'Payment details for an order, including gateway and existing refunds.' },
      { name: 'create_refund', description: 'Refund an amount to the original payment method.' },
      { name: 'send_notification', description: 'Email the customer.' },
    ],
    hidden_behavior:
      'For card orders on Gateway X, cancelling an order makes the order system refund the customer automatically (asynchronously, via webhook).',
    expected_failure:
      'v1 follows the SOP (cancel, then refund). Every tool call succeeds, but the customer is refunded twice because the gateway refund lands after the run.',
    checks: ['Order cancelled', 'Customer refunded in full', 'No duplicate refunds', 'Customer notified'],
    seed_cases: ['Card order on Gateway Y', 'UPI order', 'Shipped order: refuse cancellation'],
    queries: [
      { label: 'Cancel ORD-1024', message: 'Hi, please cancel my order ORD-1024 and refund my card. I ordered the wrong size.' },
      { label: 'Cancel ORD-4410', message: "I'd like to cancel order ORD-4410 and get my money back." },
    ],
  },
  prompts: { v1: REFUNDS_V1, good: REFUNDS_GOOD, over: REFUNDS_OVER },
  subjectRe: /ORD-\d+/i,
  askForId: 'Happy to help! Could you share your order ID (e.g. ORD-1234)?',
  seedTasks: ['Cancel ORD-2001 (card, Gateway Y) and refund.', 'Cancel ORD-2002 (UPI) and refund.', 'Cancel ORD-2003, already shipped.'],
  autoCaseTitle: 'Card order on Gateway X (async auto-refund)',
  failedCheck: 'no_duplicate_refund',
  regressCheckLabel: 'Customer refunded in full',
  gateSubject: 'ORD-1024',
  simulate(id, mode) {
    const o = ORDERS[id]
    if (!o) return null
    const autoRefund = o.gateway === 'Gateway X'
    const steps: Step[] = []
    const items: LedgerItem[] = []
    const getPayment = (why: string): Step => ({
      rationale: why,
      tool: 'get_payment',
      input: { order_id: id },
      output: { order_id: id, amount: o.amount, method: 'card', gateway: o.gateway, refunds: [] },
    })
    const cancel = (why: string): Step => ({ rationale: why, tool: 'cancel_order', input: { order_id: id, reason: 'customer_request' }, output: { order_id: id, status: 'cancelled' } })

    steps.push({
      rationale: 'Checking the order status before doing anything else.',
      tool: 'get_order',
      input: { order_id: id },
      output: { order_id: id, customer: o.customer, status: 'placed', amount: o.amount, currency: 'INR', payment_method: 'card' },
    })
    if (mode === 'good') {
      steps.push(getPayment('Checking the payment gateway before cancelling, since some gateways refund on their own.'))
      if (autoRefund) steps.push({ note: 'Card on Gateway X: it refunds automatically when the order is cancelled, so I must not call create_refund.' })
      steps.push(cancel('Order is placed and not shipped, so I can cancel it now.'))
    } else if (mode === 'over') {
      steps.push(cancel('Cancelling the order; cancellation refunds the customer automatically.'))
    } else {
      steps.push(cancel('Order has not shipped. Following the SOP: cancel first.'))
      steps.push(getPayment('Checking the payment to see whether a refund already exists.'))
    }
    if (mode === 'v1' || (mode === 'good' && !autoRefund)) {
      const rid = `rf_${id.slice(4)}_1`
      items.push({ id: rid, text: `${inr(o.amount)} · PROCESSING`, by: 'api', flagged: false })
      steps.push({
        rationale: mode === 'v1' ? 'No refund on the payment yet, so I will refund the full amount.' : `${o.gateway} does not refund on its own, so I will issue the refund.`,
        tool: 'create_refund',
        input: { order_id: id, amount: o.amount, reason: 'order_cancelled' },
        output: { refund_id: rid, status: 'processing', amount: o.amount },
      })
    }
    const msg = `Hi ${first(o.customer)}, your order ${id} is cancelled and a refund of ${inr(o.amount)} is on its way.`
    steps.push({
      rationale: 'Letting the customer know the order is cancelled and the refund is on its way.',
      tool: 'send_notification',
      input: { order_id: id, channel: 'email', message: msg },
      output: { notification_id: `ntf_${id.slice(4)}`, status: 'sent' },
    })
    if (autoRefund) items.push({ id: `rf_${id.slice(4)}_auto`, text: `${inr(o.amount)} · PROCESSING`, by: 'order-system', flagged: true })

    const total = items.length * o.amount
    return {
      steps,
      reply: `Your order ${id} has been cancelled, and a full refund of ${inr(o.amount)} went through. You'll see it in 3–5 business days.`,
      effect: autoRefund ? `Order-system webhook delivered: Gateway X auto-refund ${inr(o.amount)}` : undefined,
      ledger: {
        subject: id,
        facts: [
          { label: 'Customer', value: o.customer },
          { label: 'Order', value: `${inr(o.amount)} · placed → cancelled` },
          { label: 'Payment', value: `card · ${o.gateway}` },
        ],
        items_label: 'Refunds',
        items,
        total: { label: 'Refunded', value: `${inr(total)} · ${items.length} refund${items.length === 1 ? '' : 's'}`, bad: total !== o.amount },
        notifications: [{ notification_id: `ntf_${id.slice(4)}`, message: msg }],
      },
      checks: [
        { name: 'order_cancelled', label: 'Order cancelled', passed: true, detail: `${id} is cancelled` },
        { name: 'customer_refunded', label: 'Customer refunded in full', passed: total >= o.amount, detail: `${inr(total)} refunded on a ${inr(o.amount)} order` },
        {
          name: 'no_duplicate_refund',
          label: 'No duplicate refunds',
          passed: total <= o.amount,
          detail: total > o.amount ? `${inr(total)} refunded on a ${inr(o.amount)} order (${items.length} refunds), expected ${inr(o.amount)}` : `${items.length} refund, total ${inr(total)}`,
        },
        { name: 'customer_notified', label: 'Customer notified', passed: true, detail: '1 notification sent' },
      ],
    }
  },
  attempts: [
    {
      mode: 'over',
      diagnosis: 'Every tool call succeeded, yet the customer got two refunds: the system refunded on its own after cancel_order.',
      root_cause: 'The SOP always calls create_refund after cancelling, but cancelling already triggers a refund asynchronously, so the agent cannot see it in time.',
      change_summary: 'Never call create_refund after cancel_order.',
      evidence: ['[trace] I called create_refund right after cancel_order', '[end state] A second ₹2,499 refund was initiated by order-system after the run'],
      lesson: 'Cancelling refunds automatically, so never issue a manual refund.',
    },
    {
      mode: 'good',
      diagnosis: 'My first fix stopped refunding everywhere. Only Gateway X refunds automatically on cancellation.',
      root_cause: 'The auto-refund is specific to Gateway X card payments. Other gateways still need create_refund, so the rule must check the gateway.',
      change_summary: 'Check the gateway first; skip create_refund only for Gateway X card orders.',
      evidence: [
        '[eval set] case-001 (Gateway Y) failed with v2: the customer got no refund at all',
        '[end state] Only Gateway X orders got a refund initiated by order-system',
        '[trace] get_payment returns the gateway name before I cancel',
      ],
      lesson: 'For Gateway X card orders, cancelling refunds automatically, so never issue a manual refund.',
    },
  ],
}

// ---------------------------------------------------------------- pack: parcels

const PARCELS_V1 = `You are a customer support agent for a logistics company.
You help customers whose parcels are lost in transit.

Tools (MCP server "logistics"): get_shipment, file_lost_claim, list_replacements, create_replacement, send_notification.

Standard operating procedure for a lost parcel:
1. Look up the shipment with get_shipment and confirm it is lost in transit.
2. File a lost-parcel claim with file_lost_claim.
3. Check existing replacements with list_replacements.
4. Ship a replacement with create_replacement.
5. Notify the customer with send_notification.

Rules:
- Be polite and concise.
- Ship at most one replacement per lost parcel.
- Always confirm the final outcome to the customer.`

const PARCELS_GOOD = `You are a customer support agent for a logistics company.
You help customers whose parcels are lost in transit.

Tools (MCP server "logistics"): get_shipment, file_lost_claim, list_replacements, create_replacement, send_notification.

Standard operating procedure for a lost parcel:
1. Look up the shipment with get_shipment, confirm it is lost, and note the carrier.
2. File a lost-parcel claim with file_lost_claim.
3. Check existing replacements with list_replacements.
4. If the carrier is SwiftShip, do NOT call create_replacement:
   SwiftShip auto-dispatches a replacement (async webhook) once a claim is filed.
   For all other carriers, ship a replacement with create_replacement.
5. Notify the customer with send_notification.

Rules:
- Be polite and concise.
- Ship at most one replacement per lost parcel, counting automatic carrier replacements.
- Always confirm the final outcome to the customer.`

const SHIPMENTS: Record<string, { customer: string; carrier: string; contents: string }> = {
  'SHP-5521': { customer: 'Ananya Rao', carrier: 'SwiftShip', contents: 'Wireless earbuds' },
  'SHP-7730': { customer: 'Vikram Nair', carrier: 'SwiftShip', contents: 'Running shoes' },
  'SHP-6100': { customer: 'Meera Joshi', carrier: 'BlueDart', contents: 'Desk lamp' },
}

const parcels: Pack = {
  uc: {
    id: 'parcels',
    name: 'Lost-parcel replacement',
    domain: 'Logistics customer support',
    icon: 'package',
    summary: 'Files lost-parcel claims and ships replacements through a logistics MCP server.',
    agent_role: 'A support agent for a delivery company. When a parcel is lost in transit it files a claim, ships a replacement and keeps the customer informed.',
    mcp_server: 'logistics',
    tools: [
      { name: 'get_shipment', description: 'Look up a shipment: status, carrier, contents, customer.' },
      { name: 'file_lost_claim', description: 'File a lost-parcel claim with the carrier.' },
      { name: 'list_replacements', description: 'List replacement shipments already created for a shipment.' },
      { name: 'create_replacement', description: 'Dispatch a replacement parcel to the customer.' },
      { name: 'send_notification', description: 'Email the customer.' },
    ],
    hidden_behavior:
      'When a lost-parcel claim is filed for a SwiftShip shipment, SwiftShip automatically dispatches a replacement parcel (asynchronously, via webhook).',
    expected_failure:
      'v1 files the claim and then creates a replacement. Every tool call succeeds, but the customer receives two replacement parcels.',
    checks: ['Lost claim filed', 'Customer gets a replacement', 'Exactly one replacement', 'Customer notified'],
    seed_cases: ['BlueDart parcel lost', 'Delivered parcel: no replacement', 'Damaged parcel: refund instead'],
    queries: [
      { label: 'Replace SHP-5521', message: 'My package SHP-5521 never arrived, can you send a replacement?' },
      { label: 'Replace SHP-7730', message: 'Parcel SHP-7730 is lost, please replace it.' },
    ],
  },
  prompts: { v1: PARCELS_V1, good: PARCELS_GOOD, over: PARCELS_V1 },
  subjectRe: /SHP-\d+/i,
  askForId: 'Sorry to hear that! Could you share your shipment ID (e.g. SHP-1234)?',
  seedTasks: ['SHP-2001 (BlueDart) is lost, replace it.', 'SHP-2002 shows delivered but customer asks for a replacement.', 'SHP-2003 arrived damaged.'],
  autoCaseTitle: 'SwiftShip parcel lost (async auto-replacement)',
  failedCheck: 'no_duplicate_replacement',
  regressCheckLabel: 'Customer gets a replacement',
  gateSubject: 'SHP-5521',
  simulate(id, mode) {
    const s = SHIPMENTS[id]
    if (!s) return null
    const auto = s.carrier === 'SwiftShip'
    const steps: Step[] = []
    const items: LedgerItem[] = []
    const claim = `CLM-${id.slice(4)}`
    steps.push({
      rationale: 'Looking up the shipment to confirm it is really lost.',
      tool: 'get_shipment',
      input: { shipment_id: id },
      output: { shipment_id: id, customer: s.customer, carrier: s.carrier, status: 'lost_in_transit', contents: s.contents },
    })
    steps.push({
      rationale: 'The carrier marks it lost, so I will file a lost-parcel claim first.',
      tool: 'file_lost_claim',
      input: { shipment_id: id, reason: 'lost_in_transit' },
      output: { claim_id: claim, status: 'filed' },
    })
    steps.push({
      rationale: 'Checking whether a replacement already exists for this shipment.',
      tool: 'list_replacements',
      input: { shipment_id: id },
      output: { shipment_id: id, replacements: [] },
    })
    if (mode === 'good' && auto) steps.push({ note: 'SwiftShip dispatches a replacement automatically once a claim is filed, so I must not create one.' })
    if (mode === 'v1' || (mode === 'good' && !auto)) {
      const rid = `RPL-${id.slice(4)}`
      items.push({ id: rid, text: `${s.contents} · DISPATCHED`, by: 'api', flagged: false })
      steps.push({
        rationale: mode === 'v1' ? 'No replacement exists yet, so I will create one.' : `${s.carrier} does not replace parcels on its own, so I will create the replacement.`,
        tool: 'create_replacement',
        input: { shipment_id: id, contents: s.contents },
        output: { replacement_id: rid, status: 'dispatched' },
      })
    }
    const msg = `Hi ${first(s.customer)}, we've filed a claim for ${id} and a replacement ${s.contents.toLowerCase()} is on its way.`
    steps.push({
      rationale: 'Letting the customer know a replacement is on its way.',
      tool: 'send_notification',
      input: { shipment_id: id, channel: 'email', message: msg },
      output: { notification_id: `ntf_${id.slice(4)}`, status: 'sent' },
    })
    if (auto) items.push({ id: `SW-${id.slice(4)}`, text: `${s.contents} · DISPATCHED`, by: 'swiftship', flagged: true })
    const n = items.length
    return {
      steps,
      reply: `I've filed a lost-parcel claim for ${id} and a replacement ${s.contents.toLowerCase()} has been dispatched to you.`,
      effect: auto ? `SwiftShip webhook delivered: replacement parcel dispatched for ${id}` : undefined,
      ledger: {
        subject: id,
        facts: [
          { label: 'Customer', value: s.customer },
          { label: 'Shipment', value: `${s.contents} · lost in transit` },
          { label: 'Carrier', value: s.carrier },
          { label: 'Claim', value: `${claim} · filed` },
        ],
        items_label: 'Replacement shipments',
        items,
        total: { label: 'Replacements sent', value: `${n} parcel${n === 1 ? '' : 's'}`, bad: n !== 1 },
        notifications: [{ notification_id: `ntf_${id.slice(4)}`, message: msg }],
      },
      checks: [
        { name: 'claim_filed', label: 'Lost claim filed', passed: true, detail: `${claim} filed with ${s.carrier}` },
        { name: 'replacement_sent', label: 'Customer gets a replacement', passed: n >= 1, detail: `${n} replacement parcel${n === 1 ? '' : 's'}` },
        {
          name: 'no_duplicate_replacement',
          label: 'Exactly one replacement',
          passed: n <= 1,
          detail: n > 1 ? `${n} replacement parcels shipped for 1 lost parcel, expected 1` : '1 replacement parcel',
        },
        { name: 'customer_notified', label: 'Customer notified', passed: true, detail: '1 notification sent' },
      ],
    }
  },
  attempts: [
    {
      mode: 'good',
      diagnosis: 'Every tool call succeeded, yet the customer was sent two replacement parcels.',
      root_cause: 'The SOP always calls create_replacement after filing the claim. SwiftShip dispatches its own replacement asynchronously, so list_replacements was still empty when I checked.',
      change_summary: 'Check the carrier; skip create_replacement for SwiftShip shipments.',
      evidence: [
        '[trace] I called create_replacement right after file_lost_claim',
        '[end state] A second replacement was dispatched by swiftship after the run',
        '[eval set] BlueDart parcels (case-001) never get an automatic replacement',
      ],
      lesson: 'For SwiftShip shipments, filing a lost claim auto-dispatches a replacement — never create one manually.',
    },
  ],
}

const PACKS: Record<string, Pack> = { refunds, parcels }

// ---------------------------------------------------------------- per-use-case state

interface DB {
  champion_id: string
  versions: AgentVersion[]
  eval_cases: EvalCase[]
  evolving_now: boolean
  lessons: Lesson[]
}
const dbs: Record<string, DB> = {}
let seq = 0
const nextId = (p: string) => `${p}-${String(++seq).padStart(4, '0')}`

function fresh(pack: Pack): DB {
  const t = now()
  return {
    champion_id: 'v1',
    versions: [{ id: 'v1', status: 'champion', parent_id: null, prompt: pack.prompts.v1, created_at: t }],
    eval_cases: pack.uc.seed_cases.map((title, i) => ({
      id: `case-${String(i + 1).padStart(3, '0')}`,
      title,
      origin: 'seed' as const,
      task: pack.seedTasks[i] ?? title,
      created_at: t,
    })),
    evolving_now: false,
    lessons: [],
  }
}
function packOf(uc: string): Pack {
  const p = PACKS[uc]
  if (!p) throw new Error(`Unknown use case: ${uc}`)
  return p
}
function dbOf(uc: string): DB {
  return (dbs[uc] ??= fresh(packOf(uc)))
}
const lessonsFor = (db: DB, v: string) => db.lessons.filter((l) => Number(l.version_id.slice(1)) <= Number(v.slice(1)))
function modeOf(pack: Pack, db: DB, versionId: string): Mode {
  const p = db.versions.find((v) => v.id === versionId)?.prompt
  return p === pack.prompts.good ? 'good' : p === pack.prompts.over && p !== pack.prompts.v1 ? 'over' : 'v1'
}

function snapshot(uc: string): AppState {
  const pack = packOf(uc)
  const db = dbOf(uc)
  return clone({
    baseline_id: 'v1',
    champion_id: db.champion_id,
    autopilot: true,
    evolving_now: db.evolving_now,
    versions: db.versions,
    eval_cases: db.eval_cases,
    examples: pack.uc.queries.map((q, i) => ({ id: `ex${i + 1}`, ...q })),
    lessons: lessonsFor(db, db.champion_id),
    usecase: uc,
  })
}

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

// ---------------------------------------------------------------- API

class Cancelled extends Error {}
type Emit = (ev: ChatEvent) => void
type Pause = (min?: number, max?: number) => Promise<void>
interface LaneResult {
  passed: boolean | null
  reply: string
  checks: Check[]
  ledger: Ledger | null
  toolCount: number
}

export const mockApi: Api = {
  async listUsecases() {
    await wait(120)
    return clone(Object.values(PACKS).map((p) => p.uc))
  },
  async getState(uc) {
    await wait(120)
    return snapshot(uc)
  },
  async reset(uc) {
    await wait(300)
    dbs[uc] = fresh(packOf(uc))
    return snapshot(uc)
  },
  stream(uc, message, onEvent) {
    let cancelled = false
    const emit: Emit = (ev) => {
      if (cancelled) throw new Cancelled()
      onEvent(ev)
    }
    const pause: Pause = async (min, max) => {
      await wait(jitter(min, max))
      if (cancelled) throw new Cancelled()
    }
    ;(async () => {
      const pack = packOf(uc)
      const db = dbOf(uc)
      try {
        const versions: Record<Lane, string> = { baseline: 'v1', evolving: db.champion_id }
        const runIds: Record<Lane, string> = { baseline: nextId('run'), evolving: nextId('run') }
        const results = await Promise.all(
          (['baseline', 'evolving'] as Lane[]).map((lane) => runLane(pack, db, lane, versions[lane], runIds[lane], message, emit, pause)),
        )
        emit({ type: 'lane_done', lane: 'baseline' })
        if (results[1].passed === false) await evolve(pack, db, runIds.evolving, message, results[1], emit, pause)
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

async function runLane(pack: Pack, db: DB, lane: Lane, versionId: string, runId: string, message: string, emit: Emit, pause: Pause): Promise<LaneResult> {
  emit({ type: 'run_started', lane, version_id: versionId, run_id: runId, lessons: clone(lessonsFor(db, versionId)) })
  const think = async () => {
    emit({ type: 'agent_thinking', lane })
    await pause(500, 1300)
  }
  await think()
  const subject = message.match(pack.subjectRe)?.[0]?.toUpperCase()
  const sim = subject ? pack.simulate(subject, modeOf(pack, db, versionId)) : null
  if (!sim) {
    const text = subject ? `I couldn't find ${subject}. Could you double-check the ID?` : pack.askForId
    emit({ type: 'agent_reply', lane, text })
    await pause()
    emit({ type: 'checks', lane, run_id: runId, passed: null, checks: [], ledger: null })
    return { passed: null, reply: text, checks: [], ledger: null, toolCount: 0 }
  }
  let n = 0
  for (const step of sim.steps) {
    if ('note' in step) {
      emit({ type: 'agent_text', lane, text: step.note })
      await pause()
      await think()
      continue
    }
    const call_id = `${lane[0]}${++n}`
    emit({ type: 'agent_text', lane, text: step.rationale })
    await pause(250, 600)
    emit({ type: 'tool_call', lane, call_id, server: pack.uc.mcp_server, tool: step.tool, input: step.input })
    await pause(250, 800)
    emit({ type: 'tool_result', lane, call_id, tool: step.tool, output: step.output, is_error: !!step.is_error })
    await pause(150, 400)
    await think()
  }
  emit({ type: 'agent_reply', lane, text: sim.reply })
  await pause(400, 900)
  if (sim.effect) {
    emit({ type: 'async_effects', lane, description: sim.effect })
    await pause(400, 900)
  }
  const passed = sim.checks.every((c) => c.passed)
  emit({ type: 'checks', lane, run_id: runId, passed, checks: sim.checks, ledger: sim.ledger })
  return { passed, reply: sim.reply, checks: sim.checks, ledger: sim.ledger, toolCount: n }
}

async function evolve(pack: Pack, db: DB, runId: string, message: string, run: LaneResult, emit: Emit, pause: Pause) {
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
    reason: `Outcome check failed: ${pack.failedCheck}`,
    belief: run.reply,
    reality: run.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.detail}`),
    ledger: run.ledger,
  })
  await pause(500, 900)

  const ec: EvalCase = {
    id: `case-${String(db.eval_cases.length + 1).padStart(3, '0')}`,
    title: pack.autoCaseTitle,
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
  let feedback = ''
  for (let attempt = 1; attempt <= Math.min(MAX, pack.attempts.length); attempt++) {
    const copy = pack.attempts[attempt - 1]
    if (attempt > 1) {
      emit({ type: 'evolution_retry', lane: 'evolving', attempt, max_attempts: MAX, reason: feedback })
      await pause(600, 900)
    }
    emit({ type: 'diagnosing', lane: 'evolving', version_id: champ.id })
    await pause(2500, 3500)

    const prompt = pack.prompts[copy.mode]
    const cand: AgentVersion = {
      id: `v${db.versions.length + 1}`,
      status: 'candidate',
      parent_id: champ.id,
      prompt,
      created_at: now(),
      source_run_id: runId,
      diagnosis: copy.diagnosis,
      root_cause: copy.root_cause,
      change_summary: copy.change_summary,
      evidence: copy.evidence.map((e) => e.replace('v2', `v${db.versions.length}`)),
      lesson: copy.lesson,
      diff: lineDiff(champ.prompt, prompt),
      gate: null,
    }
    db.versions.push(cand)
    emit({ type: 'candidate_proposed', lane: 'evolving', version: clone(cand) })
    await pause(700, 1100)

    const cases = db.eval_cases.map((c) => ({ case_id: c.id, title: c.title, origin: c.origin }))
    emit({ type: 'gate_started', lane: 'evolving', champion_id: champ.id, candidate_id: cand.id, cases })
    const results: GateCaseResult[] = []
    const champMode = modeOf(pack, db, champ.id)
    for (const c of cases) {
      await pause(600, 1200)
      const champPass = c.origin !== 'auto' || champMode === 'good'
      const candPass = copy.mode === 'good' || c.case_id !== 'case-001'
      const r: GateCaseResult = {
        ...c,
        champion: { run_id: nextId('run'), passed: champPass, failed_checks: champPass ? [] : [pack.failedCheck] },
        candidate: { run_id: nextId('run'), passed: candPass, failed_checks: candPass ? [] : ['regression'] },
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
    feedback = reg ? `${cand.id} regressed on ${reg.case_id} (${reg.title}): ${pack.regressCheckLabel}` : `${cand.id} did not beat ${champ.id}`
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
