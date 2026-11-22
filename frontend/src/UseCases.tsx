import { useEffect } from 'react'
import { Boxes, Info, Package, Receipt, X } from 'lucide-react'
import type { UseCase } from './types'
import { Mark } from './sketch'

export function UcIcon({ icon, size = 20 }: { icon: string; size?: number }) {
  if (icon === 'receipt') return <Receipt size={size} />
  if (icon === 'package') return <Package size={size} />
  return <Boxes size={size} />
}

/** First screen of the chat pop-up: one card per use-case pack. */
export function UseCasePicker({ usecases, onPick, onInfo }: { usecases: UseCase[]; onPick: (id: string) => void; onInfo: (uc: UseCase) => void }) {
  return (
    <div className="picker">
      <p className="hand chat-empty-title">Choose a use case</p>
      <p className="hand muted picker-sub">Each one is a pluggable pack running on the same engine.</p>
      {usecases.length === 0 && <p className="hand muted">Loading use cases…</p>}
      <div className="uc-cards">
        {usecases.map((uc, i) => (
          <div key={uc.id} className={`uc-card ${i % 2 ? 'tilt-r' : 'tilt-l'}`}>
            <button className="uc-main" onClick={() => onPick(uc.id)}>
              <span className="uc-icon">
                <UcIcon icon={uc.icon} size={26} />
              </span>
              <span className="uc-text">
                <span className="uc-name hand">{uc.name}</span>
                <span className="uc-domain">{uc.domain}</span>
                <span className="uc-summary hand">{uc.summary}</span>
              </span>
            </button>
            <button className="info-btn uc-info" onClick={() => onInfo(uc)} aria-label={`About ${uc.name}`} title="See the full pack">
              <Info size={16} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The complete picture of a use-case pack. */
export function UseCaseInfo({ uc, onClose, onUse, current }: { uc: UseCase | null; onClose: () => void; onUse: (id: string) => void; current: string | null }) {
  useEffect(() => {
    if (!uc) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [uc, onClose])
  if (!uc) return null
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal uc-sheet" role="dialog" aria-modal="true" aria-labelledby="uc-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 id="uc-title" className="hand uc-sheet-title">
            <UcIcon icon={uc.icon} size={24} /> {uc.name}
            <span className="uc-domain">{uc.domain}</span>
          </h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body uc-body">
          <section>
            <h3 className="hand">The agent</h3>
            <p className="hand">{uc.agent_role}</p>
          </section>
          <section>
            <h3 className="hand">
              MCP server: <span className="mono">{uc.mcp_server}</span>
            </h3>
            <ul className="uc-tools">
              {uc.tools.map((t) => (
                <li key={t.name}>
                  <span className="mono tool-name">{t.name}</span>: <span className="hand">{t.description}</span>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3 className="hand">The hidden behaviour</h3>
            <div className="highlight-note hand">
              {uc.hidden_behavior}
              <div className="note-foot">No tool description mentions this.</div>
            </div>
          </section>
          <section>
            <h3 className="hand">What v1 will get wrong</h3>
            <p className="hand text-fail">{uc.expected_failure}</p>
          </section>
          <section>
            <h3 className="hand">What “correct” means</h3>
            <ul className="uc-checks hand">
              {uc.checks.map((c) => (
                <li key={c}>
                  <Mark passed size={16} /> {c}
                </li>
              ))}
            </ul>
            <p className="hand muted caption">Outcome checks: written once, judge the real end state.</p>
          </section>
          <section>
            <h3 className="hand">Seed eval cases</h3>
            <ul className="uc-seeds hand">
              {uc.seed_cases.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </section>
          <div className="uc-actions">
            <button className="btn btn-primary hand use-btn" onClick={() => onUse(uc.id)}>
              {current === uc.id ? 'Use this use case (restart)' : 'Use this use case'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
