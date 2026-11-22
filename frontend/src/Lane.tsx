import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, ChevronRight, Lightbulb, MessageSquareReply, Zap } from 'lucide-react'
import { isEvo, type Item, type LaneState } from './laneState'
import type { Ledger, Lesson } from './types'
import { compactInput, pretty } from './format'
import { Diff } from './Diff'
import { ErrorText, Pill, Spinner } from './ui'
import { Circled, Connector, Hovering, Mark, Node, SketchBox } from './sketch'
import { appliesLine, budgetFor, CAUGHT_LINE, decisionTitle, evidenceOf, lessonOf, retryLine, Typer, type WritePos } from './writing'

type Of<K extends Item['kind']> = Extract<Item, { kind: K }>

interface Props {
  kind: 'baseline' | 'evolving'
  title: string
  subtitle: ReactNode
  state: LaneState
  pos: WritePos
  empty: string
  lessons?: Lesson[] // evolving lane only
  avoided?: string | null // "lesson from case-004" callout above checks
}

/** Outcome of the lane's checks, once they have been written on the page. */
export function revealedOutcome(items: Item[], pos: WritePos): boolean | null | undefined {
  const i = items.findIndex((it) => it.kind === 'checks')
  if (i < 0 || budgetFor(i, pos) < 0) return undefined
  return (items[i] as Of<'checks'>).passed
}

export function LaneColumn({ kind, title, subtitle, state, pos, empty, lessons, avoided }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    if (state.items.length === 0) pinned.current = true
  }, [state.items.length])
  // Follow the pencil down the page unless the viewer scrolled up to read.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [pos, state])
  const onScroll = () => {
    const el = bodyRef.current
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160
  }

  const entries = state.items.map((item, i) => ({ item, budget: budgetFor(i, pos) })).filter((e) => e.budget >= 0)
  const flow = entries.filter((e) => !isEvo(e.item))
  const evo = entries.filter((e) => isEvo(e.item))
  const caughtUp = pos.index >= state.items.length
  const writing = state.running || !caughtUp

  return (
    <section className={`col lane lane-${kind}`}>
      <header className="col-head">
        <div>
          <h2 className="hand">{title}</h2>
          <div className="col-sub">{subtitle}</div>
        </div>
        <LaneStatus items={state.items} pos={pos} writing={writing} />
      </header>
      <div className="col-body" ref={bodyRef} onScroll={onScroll}>
        {lessons && <LessonsStrip lessons={lessons} applying={state.running && lessons.length > 0} />}
        {flow.length === 0 && !state.running && !state.thinking ? (
          <div className="lane-empty hand">{empty}</div>
        ) : (
          <ol className="flow">
            {flow.map(({ item, budget }) => (
              <FlowItem key={item.key} item={item} budget={budget} avoided={avoided} />
            ))}
            {state.thinking && caughtUp && (
              <li className="flow-row">
                <Connector />
                <Node tone="blue" />
                <Hovering />
              </li>
            )}
          </ol>
        )}
        {evo.length > 0 && <EvolutionBlock entries={evo} writing={writing} />}
        {state.errors.map((e, i) => (
          <ErrorText key={i} error={e} />
        ))}
      </div>
    </section>
  )
}

function LaneStatus({ items, pos, writing }: { items: Item[]; pos: WritePos; writing: boolean }) {
  const shown = items.filter((_, i) => i < pos.index)
  const result = shown.find((it) => it.kind === 'evo_result' && it.gate.decision === 'promoted') as Of<'evo_result'> | undefined
  const outcome = revealedOutcome(items, pos)
  const evolvingNow = shown.some((it) => it.kind === 'evo_start') && !result && !shown.some((it) => it.kind === 'evo_skipped')
  if (result?.gate.decision === 'promoted') return <Pill tone="pass">failed → {result.gate.candidate_id} promoted</Pill>
  if (evolvingNow && writing)
    return (
      <Pill tone="accent">
        <Spinner size={10} /> evolving
      </Pill>
    )
  if (outcome === true) return <Pill tone="pass">passed</Pill>
  if (outcome === false) return <Pill tone="fail">failed</Pill>
  if (outcome === null) return <Pill>nothing to judge</Pill>
  if (writing)
    return (
      <Pill tone="accent">
        <Spinner size={10} /> working
      </Pill>
    )
  return null
}

function LessonsStrip({ lessons, applying }: { lessons: Lesson[]; applying: boolean }) {
  return (
    <div className={`lessons ${applying ? 'lessons-applying' : ''}`}>
      <div className="lessons-title hand">{applying ? 'Applying these lessons' : `Lessons learned (${lessons.length})`}</div>
      {lessons.length === 0 ? (
        <div className="lessons-none hand">No lessons yet</div>
      ) : (
        <ul>
          {lessons.map((l, i) => (
            <li key={i} className="sticky-mini">
              <span className="hand">{l.lesson}</span>
              <span className="mono small">{l.case_id ?? l.version_id}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- timeline rows

function FlowItem({ item, budget, avoided }: { item: Item; budget: number; avoided?: string | null }) {
  const t = new Typer(budget)
  switch (item.kind) {
    case 'thought':
      return (
        <li className="flow-row">
          <Connector />
          <Node tone="blue" />
          <div className="thought hand">
            <Lightbulb size={16} className="thought-ico" />
            {t.t(item.text)}
          </div>
        </li>
      )
    case 'tool':
      return <ToolRow item={item} typer={t} />
    case 'reply':
      return <ReplyRow item={item} typer={t} />
    case 'effect':
      return (
        <li className="flow-row">
          <Connector />
          <Node />
          <div className="effect hand">
            <Zap size={16} />
            <span>{t.t(item.text)}</span>
          </div>
        </li>
      )
    case 'checks':
      return (
        <li className="flow-row">
          <Connector />
          <Node tone={item.passed === false ? 'fail' : item.passed ? 'pass' : 'ink'} />
          {avoided && item.passed && <div className="avoided hand">✓ Avoided the mistake v1 made ({avoided})</div>}
          <ChecksCard item={item} typer={t} />
        </li>
      )
    default:
      return null
  }
}

function ToolRow({ item, typer }: { item: Of<'tool'>; typer: Typer }) {
  const [open, setOpen] = useState(false)
  const r = item.result
  const name = typer.t(item.tool)
  const args = typer.t(compactInput(item.input))
  const written = typer.reached
  return (
    <li className={`flow-row tool ${r?.is_error ? 'tool-error' : ''}`}>
      <Connector />
      <Node tone={r?.is_error ? 'fail' : 'blue'} />
      <button className="tool-head" onClick={() => r && setOpen((o) => !o)} aria-expanded={open} disabled={!r}>
        <span className="tool-state">{r && written ? <Mark passed={!r.is_error} size={18} /> : <Spinner size={14} />}</span>
        <span className="mcp-tag">MCP · {item.server}</span>
        <span className="tool-name mono">{name}</span>
        <span className="tool-args mono">{args}</span>
        {r && <ChevronRight size={15} className={`chev ${open ? 'chev-open' : ''}`} />}
      </button>
      {open && r && <pre className="tool-output mono">{pretty(r.output)}</pre>}
    </li>
  )
}

function ReplyRow({ item, typer }: { item: Of<'reply'>; typer: Typer }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="flow-row">
      <Connector />
      <Node />
      <button className="reply-row hand" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <MessageSquareReply size={16} />
        <span>{typer.t('Sent the final reply')}</span>
        <ChevronRight size={15} className={`chev ${open ? 'chev-open' : ''}`} />
      </button>
      {open && <p className="reply-text hand">{item.text}</p>}
    </li>
  )
}

function ChecksCard({ item, typer: t }: { item: Of<'checks'>; typer: Typer }) {
  if (item.passed === null) {
    return <div className="checks-card checks-null hand">{t.t('Nothing to judge: no known record was referenced.')}</div>
  }
  const failed = item.checks.find((c) => !c.passed)
  const head = failed ? (
    <>
      <div className="kicker hand">{t.t(item.allToolsOk ? 'All tool calls succeeded — but' : 'Outcome check failed')}</div>
      <div className="headline hand">{t.t(failed.detail)}</div>
    </>
  ) : (
    <div className="headline hand">{t.t('All checks passed')}</div>
  )
  const rows = item.checks.map((c) => {
    const label = t.t(c.label)
    if (label === null) return null
    const detail = t.t(c.detail)
    const done = t.reached
    return (
      <li key={c.name} className={c.passed ? '' : 'check-failed'}>
        <span className="check-mark">{done ? <Mark passed={c.passed} size={17} /> : null}</span>
        <span className="check-label">{label}</span>
        <span className={`check-detail ${!c.passed && done ? 'scribble' : ''}`}>{detail}</span>
      </li>
    )
  })
  const all = t.reached
  return (
    <div className={`checks-card ${failed ? 'checks-fail' : 'checks-pass'}`}>
      <div className="checks-headline">{head}</div>
      <ul className="checks hand">{rows}</ul>
      {all && item.ledger && <LedgerView ledger={item.ledger} />}
    </div>
  )
}

/** Generic end-state card: facts, the items the hidden automation may duplicate, and a total. */
function LedgerView({ ledger: l, compact }: { ledger: Ledger; compact?: boolean }) {
  return (
    <div className={`ledger fade-in ${compact ? 'ledger-compact' : ''}`}>
      {!compact && (
        <>
          <div className="ledger-subject mono">{l.subject}</div>
          {l.facts.map((f, i) => (
            <div key={i} className="ledger-fact">
              <span className="muted">{f.label}</span>
              <span>{f.value}</span>
            </div>
          ))}
        </>
      )}
      {l.items.length > 0 && (
        <>
          {!compact && <div className="ledger-items-label">{l.items_label}</div>}
          {l.items.map((it) => (
            <div key={it.id} className={`ledger-item ${it.flagged ? 'text-fail' : ''}`}>
              {!compact && <span className="mono">{it.id}</span>}
              <span>{it.text}</span>
              <span className="mono small">by {it.flagged ? <Circled>{it.by}</Circled> : it.by}</span>
            </div>
          ))}
        </>
      )}
      <div className={`ledger-total ${l.total.bad ? 'text-fail' : ''}`}>
        {l.total.label} <strong>{l.total.value}</strong>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- self-evolution story

type Entry = { item: Item; budget: number }

function Stage({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="stage fade-in">
      <h3 className="stage-title hand">
        <span className="stage-num">{n}</span> {title}
      </h3>
      <div className="stage-body">{children}</div>
    </div>
  )
}

interface AttemptGroup {
  diag?: { item: Of<'evo_diag'>; budget: number }
  cand?: { item: Of<'evo_candidate'>; budget: number }
  gate?: { item: Of<'evo_gate'>; budget: number }
  cases: Of<'evo_gate_case'>[]
  result?: { item: Of<'evo_result'>; budget: number }
  retry?: { item: Of<'evo_retry'>; budget: number }
}

/** Splits evolution entries into attempts: a new attempt starts at each `diagnosing`. */
function groupAttempts(entries: Entry[]): AttemptGroup[] {
  const groups: AttemptGroup[] = []
  let cur = null as AttemptGroup | null
  const fresh = () => {
    cur = { cases: [] }
    groups.push(cur)
    return cur
  }
  for (const e of entries) {
    const it = e.item
    switch (it.kind) {
      case 'evo_diag':
        fresh().diag = { item: it, budget: e.budget }
        break
      case 'evo_candidate': {
        const g: AttemptGroup = cur && !cur.cand ? cur : fresh()
        g.cand = { item: it, budget: e.budget }
        break
      }
      case 'evo_gate':
        ;(cur ?? fresh()).gate = { item: it, budget: e.budget }
        break
      case 'evo_gate_case':
        ;(cur ?? fresh()).cases.push(it)
        break
      case 'evo_result':
        ;(cur ?? fresh()).result = { item: it, budget: e.budget }
        break
      case 'evo_retry':
        ;(cur ?? fresh()).retry = { item: it, budget: e.budget }
        break
    }
  }
  return groups
}

function EvolutionBlock({ entries, writing }: { entries: Entry[]; writing: boolean }) {
  const find = <K extends Item['kind']>(k: K) => entries.find((e) => e.item.kind === k) as { item: Of<K>; budget: number } | undefined
  const start = find('evo_start')
  const ecase = find('evo_case')
  const skipped = find('evo_skipped')
  const groups = groupAttempts(entries)
  const multi = groups.length > 1
  const skippedNote = skipped && <div className="evo-note hand">{new Typer(skipped.budget).t(`Evolution skipped: ${skipped.item.reason}`)}</div>

  return (
    <div className="evo">
      <div className="evo-title hand">Self-evolution (automatic)</div>
      {!start && skippedNote}
      {start && <StageOne entry={start} ecase={ecase} />}
      {groups.map((g, i) =>
        i < groups.length - 1 ? (
          <PastAttempt key={i} g={g} n={i + 1} />
        ) : (
          <Attempt key={i} g={g} n={i + 1} label={multi} writing={writing} />
        ),
      )}
      {start && skippedNote}
    </div>
  )
}

function RetryLine({ retry }: { retry: { item: Of<'evo_retry'>; budget: number } }) {
  return <p className="retry hand">{new Typer(retry.budget).t(retryLine(retry.item.attempt - 1, retry.item.reason))}</p>
}

function Attempt({ g, n, label, writing }: { g: AttemptGroup; n: number; label: boolean; writing: boolean }) {
  const gateDone = new Map(g.cases.map((c) => [c.result.case_id, c.result]))
  return (
    <div className="attempt">
      {label && <div className="attempt-label hand">Attempt {n}</div>}
      <StageTwoThree cand={g.cand} writing={writing} />
      {g.gate && (
        <Stage n="④" title="Did the fix work?">
          <GateView gate={g.gate} gateDone={gateDone} result={g.result} writing={writing} />
        </Stage>
      )}
      {g.retry && <RetryLine retry={g.retry} />}
    </div>
  )
}

function PastAttempt({ g, n }: { g: AttemptGroup; n: number }) {
  const v = g.cand?.item.version
  const gate = g.result?.item.gate
  const why = gate ? (gate.regressions.length ? `regressed on ${gate.regressions.join(', ')}` : gate.reason) : 'no result'
  return (
    <div className="past">
      <details className="past-attempt">
        <summary className="hand">
          <ChevronRight size={15} className="chev" />
          Attempt {n} · <span className="mono">{v?.id ?? '?'}</span> · <span className={gate?.decision === 'promoted' ? 'text-pass' : 'text-fail'}>{gate?.decision ?? 'unfinished'}</span> · {why}
        </summary>
        <Attempt g={{ ...g, retry: undefined }} n={n} label={false} writing={false} />
      </details>
      {g.retry && <RetryLine retry={g.retry} />}
    </div>
  )
}

function StageOne({ entry, ecase }: { entry: { item: Of<'evo_start'>; budget: number }; ecase?: { item: Of<'evo_case'>; budget: number } }) {
  const it = entry.item
  const t = new Typer(entry.budget)
  const belief = t.t(it.belief)
  const reality = it.reality.map((line, i) => {
    const node = t.t(line)
    return node === null ? null : <li key={i}>{node}</li>
  })
  const realityDone = t.reached
  const caught = t.t(CAUGHT_LINE)
  const ct = ecase ? new Typer(ecase.budget) : null
  return (
    <Stage n="①" title="How did it know something was wrong?">
      <div className="two-cards">
        <div className="paper-card tilt-l">
          <div className="card-label hand">What the agent thought</div>
          <blockquote className="hand">“{belief}”</blockquote>
          {it.allToolsOk && it.toolCount > 0 && (
            <div className="tools-ok hand">
              <Mark passed size={15} /> all {it.toolCount} tool calls succeeded
            </div>
          )}
        </div>
        <div className="paper-card card-fail tilt-r">
          <div className="card-label hand">What actually happened</div>
          <ul className="reality hand">{reality}</ul>
          {realityDone && it.ledger && <LedgerView ledger={it.ledger} compact />}
        </div>
      </div>
      {caught && <p className="caught hand">{caught}</p>}
      {ct && (
        <p className="saved hand">
          {ct.t(`Saved as eval case ${ecase!.item.evalCase.id}`)}
          {ct.reached && <span className="muted"> · {ecase!.item.evalCase.title}</span>}
        </p>
      )}
    </Stage>
  )
}

function StageTwoThree({ cand, writing }: { cand?: { item: Of<'evo_candidate'>; budget: number }; writing: boolean }) {
  const [showDiff, setShowDiff] = useState(false)
  if (!cand) {
    return (
      <Stage n="②" title="Why did it happen?">
        {writing ? <Hovering label="Agent is diagnosing the failure" /> : <p className="hand muted">Agent was diagnosing the failure.</p>}
      </Stage>
    )
  }
  const v = cand.item.version
  const t = new Typer(cand.budget)
  const evidence = evidenceOf(v).map((e, i) => {
    const node = t.t(e.text)
    if (node === null) return null
    return (
      <li key={i}>
        {e.tag && <span className={`src-tag src-${e.tag.replace(/\s+/g, '-')}`}>{e.tag}</span>}
        <span>{node}</span>
      </li>
    )
  })
  const root = v.root_cause ? t.t(v.root_cause) : null
  const lessonText = lessonOf(v)
  const lesson = lessonText ? t.t(lessonText) : null
  const lessonDone = t.reached
  return (
    <>
      <Stage n="②" title="Why did it happen?">
        <p className="hand muted small-hand">The agent's own diagnosis:</p>
        <ul className="evidence hand">{evidence}</ul>
        {root && (
          <p className="root hand">
            <strong>Root cause:</strong> {root}
          </p>
        )}
      </Stage>
      {lesson && (
        <Stage n="③" title="What did it learn?">
          <div className="sticky tilt-l">
            <div className="sticky-label hand">Lesson learned</div>
            <div className="sticky-text hand">{lesson}</div>
          </div>
          {lessonDone && v.diff && v.diff.length > 0 && (
            <div className="diff-toggle">
              <button className="link-btn hand" onClick={() => setShowDiff((s) => !s)} aria-expanded={showDiff}>
                <ChevronRight size={15} className={`chev ${showDiff ? 'chev-open' : ''}`} />
                {showDiff ? 'Hide' : 'See'} the prompt change ({v.parent_id} <ArrowRight size={12} className="inline-icon" /> {v.id})
              </button>
              {showDiff && <Diff lines={v.diff} />}
            </div>
          )}
        </Stage>
      )}
    </>
  )
}

function GateView({
  gate,
  gateDone,
  result,
  writing,
}: {
  gate: { item: Of<'evo_gate'>; budget: number }
  gateDone: Map<string, import('./types').GateCaseResult>
  result?: { item: Of<'evo_result'>; budget: number }
  writing: boolean
}) {
  const g = gate.item
  const t = new Typer(gate.budget)
  const line = t.t(`Testing ${g.champion_id} vs ${g.candidate_id} on ${g.cases.length} eval cases`)
  const cases = [...g.cases]
  gateDone.forEach((r) => {
    if (!cases.some((c) => c.case_id === r.case_id)) cases.push({ case_id: r.case_id, title: r.title, origin: r.origin })
  })
  return (
    <>
      <p className="hand">{line}</p>
      {t.reached && (
        <table className="gate-table fade-in">
          <thead>
            <tr>
              <th>Eval case</th>
              <th className="center mono">{g.champion_id}</th>
              <th className="center mono">{g.candidate_id}</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c) => {
              const r = gateDone.get(c.case_id)
              const fixed = r && !r.champion.passed && r.candidate.passed
              const regressed = r && r.champion.passed && !r.candidate.passed
              return (
                <tr key={c.case_id} className={fixed ? 'row-pass' : regressed ? 'row-fail' : ''}>
                  <td>
                    <span className="mono small muted">{c.case_id}</span> {c.title} {c.origin === 'auto' && <Pill tone="accent">auto ★</Pill>}
                  </td>
                  <td className="center">{r ? <Mark passed={r.champion.passed} size={17} /> : writing ? <Spinner /> : '–'}</td>
                  <td className="center">{r ? <Mark passed={r.candidate.passed} size={17} /> : writing ? <Spinner /> : '–'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {result && <Verdict entry={result} />}
    </>
  )
}

function Verdict({ entry }: { entry: { item: Of<'evo_result'>; budget: number } }) {
  const g = entry.item.gate
  const t = new Typer(entry.budget)
  const promoted = g.decision === 'promoted'
  const title = t.t(decisionTitle(g))
  const reason = t.t(g.reason)
  const applies = promoted ? t.t(appliesLine(g.candidate_id)) : null
  return (
    <div className="verdict">
      <div className="score-totals hand">
        <div className="score">
          <div className="score-label mono">{g.champion_id}</div>
          <div className="score-num">
            {g.champion_score}/{g.total}
          </div>
        </div>
        <ArrowRight size={24} />
        <div className="score">
          <div className="score-label mono">{g.candidate_id}</div>
          <div className={`score-num ${promoted ? 'text-pass' : 'text-fail'}`}>
            {g.candidate_score}/{g.total}
          </div>
        </div>
      </div>
      <SketchBox tone={promoted ? 'pass' : 'fail'} className="tilt-l">
        <div className={`decision ${promoted ? 'text-pass' : 'text-fail'}`}>
          <div className="decision-title hand">{title}</div>
          {reason && <div className="decision-reason hand">{reason}</div>}
          {g.regressions.length > 0 && t.reached && (
            <div className="hand">
              Regressions: <span className="mono">{g.regressions.join(', ')}</span>
            </div>
          )}
        </div>
      </SketchBox>
      {applies && <p className="applies hand">{applies}</p>}
    </div>
  )
}
