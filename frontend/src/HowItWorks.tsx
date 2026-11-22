import { useEffect, useRef } from 'react'
import { ArrowRight, X } from 'lucide-react'

const STEPS: { title: string; text: string; tone?: 'fail' | 'warn' | 'pass' }[] = [
  { title: 'Run', text: 'The agent handles real requests through MCP tools. Every thought and tool call is traced.' },
  { title: 'Judge', text: 'Outcome checks inspect the real end state of the systems, not tool errors. Teams define what "correct" means, not every possible failure.', tone: 'fail' },
  { title: 'Remember', text: 'Every failure becomes a permanent eval case.' },
  { title: 'Diagnose', text: 'The agent reads its own trace, the end state and past cases to find the root cause.' },
  { title: 'Rewrite', text: 'It writes the lesson into its own instructions as a new prompt version.', tone: 'warn' },
  { title: 'Prove', text: 'The new and current versions replay every eval case in fresh sandboxes.' },
  { title: 'Promote', text: 'Ship only with the failure fixed and zero regressions. Otherwise the agent revises its fix and tries again. Lessons accumulate; nothing learned is lost.', tone: 'pass' },
]

const SIZE = 336 // px, circle diagram
const R = 126 // ring radius
const N = STEPS.length
const angle = (i: number) => -90 + (i * 360) / N // node i, clockwise from the top
const at = (deg: number, r = R) => ({ x: SIZE / 2 + r * Math.cos((deg * Math.PI) / 180), y: SIZE / 2 + r * Math.sin((deg * Math.PI) / 180) })

function LoopCircle() {
  return (
    <div className="loop-circle" style={{ width: SIZE, height: SIZE }} aria-hidden>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <circle className="loop-ring" cx={SIZE / 2} cy={SIZE / 2} r={R} />
        {STEPS.map((_, i) => {
          const a = angle(i + 0.5)
          const p = at(a)
          return <path key={i} className="loop-chevron" d="M-5 -7 L4 0 L-5 7" transform={`translate(${p.x} ${p.y}) rotate(${a + 90})`} />
        })}
      </svg>
      <div className="loop-center hand">the loop</div>
      {STEPS.map((s, i) => {
        const p = at(angle(i))
        return (
          <div key={s.title} className={`loop-node ${s.tone ? `node-${s.tone}` : ''}`} style={{ left: p.x, top: p.y, animationDelay: `${i * 0.07}s` }}>
            <span className="loop-node-num">{i + 1}</span>
            <span className="loop-node-label hand">{s.title}</span>
          </div>
        )
      })}
    </div>
  )
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** The framework explainer. A real dialog: traps focus, restores it on close. */
export function HowItWorks({ open, onClose, onTry }: { open: boolean; onClose: () => void; onTry: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const tryRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    tryRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !ref.current) return
      const els = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute('disabled'))
      if (els.length === 0) return
      const firstEl = els[0]
      const lastEl = els[els.length - 1]
      if (e.shiftKey && (document.activeElement === firstEl || !ref.current.contains(document.activeElement))) {
        e.preventDefault()
        lastEl.focus()
      } else if (!e.shiftKey && (document.activeElement === lastEl || !ref.current.contains(document.activeElement))) {
        e.preventDefault()
        firstEl.focus()
      }
    }
    // Capture phase so the chat pop-up underneath never sees this Esc.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={ref} className="modal how" role="dialog" aria-modal="true" aria-labelledby="hiw-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 id="hiw-title" className="hand">Evolve: a self-improving harness for production agents</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body how-body">
          <section className="problem hand">
            <div className="problem-title">The problem</div>
            <p>
              Agents ship once and never improve. The costliest failures throw no errors: every tool call succeeds, and the outcome is
              still wrong. Nobody notices, so the agent repeats it.
            </p>
          </section>

          <section className="loop-wrap">
            <LoopCircle />
            <ol className="loop-list">
              {STEPS.map((s, i) => (
                <li key={s.title} className={s.tone ? `li-${s.tone}` : ''}>
                  <span className="loop-list-num">{i + 1}</span>
                  <span className="hand">
                    <strong>{s.title}:</strong> {s.text}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section className="plug">
            <div>
              <div className="plug-title hand">You plug in</div>
              <ul className="hand">
                <li>Agent prompt + MCP tools · Outcome checks · Optional seed cases</li>
              </ul>
              <p className="plug-note hand">
                Use-case pack = agent prompt + MCP server + outcome checks + seed cases. Two packs ship with this demo.
              </p>
            </div>
            <div>
              <div className="plug-title hand text-pass">Evolve does the rest</div>
              <ul className="hand">
                <li>Tracing, failure capture, diagnosis, rewriting, replay testing, promotion, version history</li>
              </ul>
            </div>
          </section>
        </div>
        <footer className="modal-foot">
          <p className="control hand">The non-evolving agent on the left is the control group: same model, same tools, never learns.</p>
          <button ref={tryRef} className="btn btn-primary try-btn hand" onClick={onTry}>
            Got it, try an example <ArrowRight size={16} />
          </button>
        </footer>
      </div>
    </div>
  )
}
