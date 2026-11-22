import { useEffect, useRef, useState } from 'react'
import { Lock, MessageCircle, Minus, Send, Sparkles } from 'lucide-react'
import { Hovering } from './sketch'
import type { Example, Lane } from './types'
import { ErrorText, PassMark, Pill, Spinner } from './ui'
import { TypeOut } from './writing'
import type { UseCase } from './types'
import { UcIcon, UseCasePicker } from './UseCases'

export interface ReplySlot {
  version?: string
  text?: string
  outcome?: boolean | null // undefined until `checks` arrives
}
export interface Turn {
  id: number
  text: string
  replies: Record<Lane, ReplySlot>
}

interface Props {
  turns: Turn[]
  examples: Example[]
  streaming: boolean
  error: string | null
  /** Outcomes as currently written in the lanes; applies to the latest turn. */
  liveOutcome: Record<Lane, boolean | null | undefined>
  open: boolean
  onOpen: () => void
  onClose: () => void
  onSend: (text: string) => void
  usecases: UseCase[]
  /** null while the viewer is choosing a use case */
  usecase: UseCase | null
  onPick: (id: string) => void
  onChangeUsecase: () => void
  onInfo: (uc: UseCase) => void
}

/** Chat as a centred pop-up over a blurred page; sending a query docks it at the bottom. */
export function Chat({ turns, examples, streaming, error, liveOutcome, open, onOpen, onClose, onSend, usecases, usecase, onPick, onChangeUsecase, onInfo }: Props) {
  const [draft, setDraft] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [turns, open])

  // Keep the docked pop-up out of the tab order; close on Esc.
  useEffect(() => {
    const el = popRef.current as (HTMLElement & { inert?: boolean }) | null
    if (el) el.inert = !open
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const send = (text: string) => {
    const t = text.trim()
    if (!t || streaming) return
    onSend(t)
    setDraft('')
  }
  const last = turns.at(-1)

  return (
    <>
      <div className={`chat-backdrop ${open ? 'show' : ''}`} onClick={onClose} aria-hidden />
      <section ref={popRef} className={`col chat chat-pop ${open ? 'open' : 'docked'}`} role="dialog" aria-modal={open} aria-label="Chat">
        <header className="col-head">
          <div className="chat-title">
            <h2 className="hand">Chat</h2>
            {usecase && (
              <button className="link-btn hand change-uc" onClick={onChangeUsecase} disabled={streaming}>
                ← Change use case
              </button>
            )}
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Send chat to the back" title="Minimise (Esc)">
            <Minus size={16} />
          </button>
        </header>
        <div className="col-body chat-body" ref={bodyRef}>
          {!usecase ? (
            <UseCasePicker usecases={usecases} onPick={onPick} onInfo={onInfo} />
          ) : turns.length === 0 ? (
            <div className="chat-empty">
              <p className="hand chat-empty-title">Recommended queries</p>
              <p className="hand muted uc-for">
                <UcIcon icon={usecase.icon} size={16} /> {usecase.name}
              </p>
              <div className="suggestions">
                {examples.map((ex, i) => (
                  <button key={ex.id} className={`suggestion hand ${i % 2 ? 'tilt-r' : 'tilt-l'}`} onClick={() => send(ex.message)} disabled={streaming}>
                    “{ex.message}”
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((t, i) => {
              const isLast = i === turns.length - 1
              return (
                <div key={t.id} className="turn">
                  <div className="bubble-user hand">{t.text}</div>
                  <AgentReply lane="baseline" slot={t.replies.baseline} outcome={isLast ? liveOutcome.baseline : t.replies.baseline.outcome} />
                  <AgentReply lane="evolving" slot={t.replies.evolving} outcome={isLast ? liveOutcome.evolving : t.replies.evolving.outcome} />
                </div>
              )
            })
          )}
        </div>
        {usecase && <div className="chat-foot">
          <ErrorText error={error} />
          {turns.length > 0 && (
            <div className="chips">
              {examples.map((ex) => (
                <button key={ex.id} className="chip chip-sm hand" onClick={() => send(ex.message)} disabled={streaming} title={ex.message}>
                  {ex.message}
                </button>
              ))}
            </div>
          )}
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault()
              send(draft)
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={streaming ? 'Agents are working…' : 'Type a message for the agents…'}
              disabled={streaming}
              aria-label="Message"
            />
            <button className="btn btn-primary btn-icon-lg" type="submit" disabled={streaming || !draft.trim()} aria-label="Send">
              <Send size={16} />
            </button>
          </form>
        </div>}
      </section>
      <button className={`chat-dock ${open ? '' : 'show'}`} onClick={onOpen} tabIndex={open ? -1 : 0} aria-label="Open chat">
        <MessageCircle size={18} />
        <span className="dock-title hand">Chat</span>
        <span className="dock-last hand">{last ? last.text : usecase ? usecase.name : 'Choose a use case'}</span>
        {streaming && <Spinner size={13} />}
      </button>
    </>
  )
}

function AgentReply({ lane, slot, outcome }: { lane: Lane; slot: ReplySlot; outcome: boolean | null | undefined }) {
  const label = lane === 'baseline' ? `Non-evolving (${slot.version ?? 'v1'})` : `Evolving (${slot.version ?? '…'})`
  return (
    <div className={`bubble-agent bubble-${lane}`}>
      <div className="bubble-head">
        {lane === 'baseline' ? <Lock size={12} /> : <Sparkles size={12} />}
        <span>{label}</span>
        <span className="bubble-badge">
          {outcome === true || outcome === false ? (
            <PassMark passed={outcome} size={18} />
          ) : outcome === null ? (
            <Pill>n/a</Pill>
          ) : null}
        </span>
      </div>
      {slot.text ? (
        <p className="hand">
          <TypeOut text={slot.text} />
        </p>
      ) : (
        <Hovering label="working" />
      )}
    </div>
  )
}
