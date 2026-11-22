import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, Crown, FlaskConical, GitBranch, Info, RotateCcw, Zap } from 'lucide-react'
import type { AppState, ChatEvent, Lane, UseCase } from './types'
import { api, errMsg, IS_MOCK } from './api'
import { emptyLanes, lanesReduce, type Lanes } from './laneState'
import { LaneColumn, revealedOutcome } from './Lane'
import { useWriter } from './writing'
import { Chat, type Turn } from './Chat'
import { HowItWorks } from './HowItWorks'
import { UcIcon, UseCaseInfo } from './UseCases'
import { Drawer, ErrorText, Pill, StatusPill } from './ui'
import { time } from './format'

const UC_KEY = 'evolve.usecase'
function readUc(): string | null {
  try {
    return localStorage.getItem(UC_KEY)
  } catch {
    return null
  }
}
function writeUc(id: string) {
  try {
    localStorage.setItem(UC_KEY, id)
  } catch {
    /* storage unavailable */
  }
}

export default function App() {
  const [usecases, setUsecases] = useState<UseCase[]>([])
  const [ucId, setUcId] = useState<string | null>(readUc)
  const [picking, setPicking] = useState(() => readUc() === null)
  const [infoUc, setInfoUc] = useState<UseCase | null>(null)
  const [runSeq, setRunSeq] = useState(0)
  const ucRef = useRef(ucId)
  ucRef.current = ucId
  const [state, setState] = useState<AppState | null>(null)
  const [lanes, setLanes] = useState<Lanes>(emptyLanes)
  const [turns, setTurns] = useState<Turn[]>([])
  const [streaming, setStreaming] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [liveChampion, setLiveChampion] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<'evals' | 'versions' | null>(null)
  const [chatOpen, setChatOpen] = useState(true)
  const [howOpen, setHowOpen] = useState(false)
  const closeChat = useCallback(() => setChatOpen(false), [])
  const closeHow = useCallback(() => setHowOpen(false), [])
  const closeInfo = useCallback(() => setInfoUc(null), [])
  const closeStream = useRef<(() => void) | null>(null)

  const refresh = useCallback(async () => {
    const uc = ucRef.current
    if (!uc) return
    try {
      const s = await api.getState(uc)
      if (ucRef.current !== uc) return
      setState(s)
      setLiveChampion(null)
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }, [])

  useEffect(() => {
    api
      .listUsecases()
      .then((list) => {
        setUsecases(list)
        // A stored use case that no longer exists sends the viewer back to the picker.
        if (ucRef.current && !list.some((u) => u.id === ucRef.current)) {
          setUcId(null)
          setPicking(true)
        }
      })
      .catch((e) => setError(errMsg(e)))
    return () => closeStream.current?.()
  }, [])

  useEffect(() => {
    setState(null)
    refresh()
  }, [ucId, refresh])

  function chooseUsecase(id: string) {
    closeStream.current?.()
    closeStream.current = null
    writeUc(id)
    setUcId(id)
    setPicking(false)
    setInfoUc(null)
    setLanes(emptyLanes())
    setTurns([])
    setStreaming(false)
    setLiveChampion(null)
    setError(null)
    setRunSeq((n) => n + 1)
    setChatOpen(true)
  }

  const updateTurn = (fn: (t: Turn) => Turn) =>
    setTurns((ts) => (ts.length ? [...ts.slice(0, -1), fn(ts[ts.length - 1])] : ts))
  const setSlot = (lane: Lane, patch: Partial<Turn['replies'][Lane]>) =>
    updateTurn((t) => ({ ...t, replies: { ...t.replies, [lane]: { ...t.replies[lane], ...patch } } }))

  function onEvent(ev: ChatEvent) {
    setLanes((l) => lanesReduce(l, ev))
    switch (ev.type) {
      case 'run_started':
        setSlot(ev.lane, { version: ev.version_id })
        break
      case 'agent_reply':
        setSlot(ev.lane, { text: ev.text })
        break
      case 'checks':
        setSlot(ev.lane, { outcome: ev.passed })
        break
      case 'gate_result':
        if (ev.gate.decision === 'promoted') setLiveChampion(ev.gate.candidate_id)
        break
      case 'error':
        if (!ev.lane) setError(ev.detail)
        break
      case 'done':
        closeStream.current = null
        updateTurn((t) => ({
          ...t,
          replies: {
            baseline: { ...t.replies.baseline, text: t.replies.baseline.text ?? '(no reply)' },
            evolving: { ...t.replies.evolving, text: t.replies.evolving.text ?? '(no reply)' },
          },
        }))
        setStreaming(false)
        refresh()
        break
    }
  }

  function send(text: string) {
    if (streaming || !ucId) return
    setError(null)
    setLanes(emptyLanes())
    setTurns((ts) => [...ts, { id: Date.now(), text, replies: { baseline: {}, evolving: {} } }])
    setStreaming(true)
    setRunSeq((n) => n + 1)
    setChatOpen(false)
    closeStream.current = api.stream(ucId, text, onEvent)
  }

  async function reset() {
    if (!ucId) return
    closeStream.current?.()
    closeStream.current = null
    setResetting(true)
    try {
      setState(await api.reset(ucId))
      setRunSeq((n) => n + 1)
      setLanes(emptyLanes())
      setTurns([])
      setStreaming(false)
      setLiveChampion(null)
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setResetting(false)
    }
  }



  const runKey = runSeq
  const usecase = usecases.find((u) => u.id === ucId) ?? null
  const posB = useWriter(lanes.baseline.items, !streaming, runKey)
  const posE = useWriter(lanes.evolving.items, !streaming, runKey)
  const liveOutcome = { baseline: revealedOutcome(lanes.baseline.items, posB), evolving: revealedOutcome(lanes.evolving.items, posE) }

  const evoLessons = (lanes.evolving.running ? lanes.evolving.lessons : undefined) ?? state?.lessons ?? []
  const ranWith = lanes.evolving.lessons ?? []
  const checksOf = (items: typeof lanes.baseline.items) => items.find((it) => it.kind === 'checks')
  const bChecks = checksOf(lanes.baseline.items)
  const eChecks = checksOf(lanes.evolving.items)
  const avoided =
    bChecks?.kind === 'checks' && bChecks.passed === false && eChecks?.kind === 'checks' && eChecks.passed === true && ranWith.length > 0
      ? `lesson from ${ranWith[0].case_id ?? ranWith[0].version_id}`
      : null

  const champion = liveChampion ?? state?.champion_id ?? 'v1'
  const baseline = state?.baseline_id ?? 'v1'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden>
            <Activity size={18} strokeWidth={2.5} />
          </div>
          <div>
            <h1 className="hand">Evolve</h1>
            <p className="tagline hand">Agents that learn from their own production failures</p>
          </div>
          {usecase && (
            <span className="uc-pill">
              <UcIcon icon={usecase.icon} size={15} />
              <span className="hand">
                Use case: <strong>{usecase.name}</strong>
              </span>
              <button className="info-btn" onClick={() => setInfoUc(usecase)} aria-label={`About ${usecase.name}`} title="What is in this use-case pack?">
                <Info size={14} />
              </button>
            </span>
          )}
        </div>
        <div className="topbar-right">
          {IS_MOCK && <Pill tone="warn">mock API</Pill>}
          <button className="btn btn-ghost btn-sm" onClick={() => setDrawer('evals')}>
            <FlaskConical size={14} /> Eval set ({state?.eval_cases.length ?? 0})
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setDrawer('versions')}>
            <GitBranch size={14} /> Versions
          </button>
          <span className="champion-badge" key={champion}>
            <Crown size={14} /> Champion: <strong>{champion}</strong>
          </span>
          <span className={`autopilot ${state?.autopilot === false ? 'off' : ''}`}>
            <Zap size={12} /> Autopilot: {state?.autopilot === false ? 'off' : 'on'}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={reset} disabled={resetting || streaming}>
            <RotateCcw size={14} className={resetting ? 'spin' : ''} /> Reset
          </button>
        </div>
      </header>

      <div className="strip">
        <span className="hand strip-problem">
          <strong className="text-fail">The problem:</strong> Agents ship once and never improve. Every tool call can succeed and the outcome can
          still be wrong.
        </span>
        <button className="btn btn-sm how-btn hand" onClick={() => setHowOpen(true)}>
          <Info size={15} /> How it works
        </button>
      </div>

      <div className="columns">
        <LaneColumn
          kind="evolving"
          title="Evolving agent"
          subtitle={
            <>
              <span className="mono strong">{champion}</span> · learns from failures
            </>
          }
          state={lanes.evolving}
          pos={posE}
          lessons={evoLessons}
          avoided={avoided}
          empty="The self-evolving agent's execution flow appears here. When it fails, watch it fix itself."
        />
        <LaneColumn
          kind="baseline"
          title="Non-evolving agent"
          subtitle={
            <>
              <span className="mono strong">{baseline}</span> · never learns, repeats its mistakes
            </>
          }
          state={lanes.baseline}
          pos={posB}
          empty="The frozen agent's execution flow appears here."
        />
      </div>


      <Chat
        turns={turns}
        examples={state?.examples ?? []}
        streaming={streaming}
        error={error}
        liveOutcome={liveOutcome}
        open={chatOpen}
        onOpen={() => setChatOpen(true)}
        onClose={closeChat}
        onSend={send}
        usecases={usecases}
        usecase={picking ? null : usecase}
        onPick={chooseUsecase}
        onChangeUsecase={() => setPicking(true)}
        onInfo={setInfoUc}
      />
      <UseCaseInfo uc={infoUc} onClose={closeInfo} onUse={chooseUsecase} current={ucId} />
      <HowItWorks open={howOpen} onClose={closeHow} />

      <Drawer open={drawer === 'evals'} onClose={() => setDrawer(null)} title={`Eval set (${state?.eval_cases.length ?? 0})`}>
        <ErrorText error={error} />
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Case</th>
                <th>Origin</th>
              </tr>
            </thead>
            <tbody>
              {state?.eval_cases.map((c) => (
                <tr key={c.id} className={c.origin === 'auto' ? 'row-auto' : ''}>
                  <td className="mono small">{c.id}</td>
                  <td>
                    <div>{c.title}</div>
                    <div className="muted small">{c.task}</div>
                  </td>
                  <td>{c.origin === 'auto' ? <Pill tone="accent">auto ★</Pill> : <Pill>seed</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Drawer>

      <Drawer open={drawer === 'versions'} onClose={() => setDrawer(null)} title="Agent versions">
        {[...(state?.versions ?? [])].reverse().map((v) => (
          <details key={v.id} className="version" open={v.id === champion}>
            <summary>
              <span className="mono strong">{v.id}</span>
              <StatusPill status={v.status} />
              {v.gate && (
                <span className="muted small">
                  gate {v.gate.champion_score}/{v.gate.total} → {v.gate.candidate_score}/{v.gate.total}
                </span>
              )}
              <span className="muted small version-time">{time(v.created_at)}</span>
            </summary>
            <p className="version-summary">
              {v.change_summary ?? (v.parent_id ? `Evolved from ${v.parent_id}` : 'Initial prompt, follows the SOP')}
            </p>
            <pre className="prompt mono">{v.prompt}</pre>
          </details>
        ))}
      </Drawer>
    </div>
  )
}
