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

/** Hand-drawn arrow. `dir` rotates it. */
function Arrow({ dir }: { dir: 'right' | 'left' | 'down' }) {
  return (
    <svg className={`hand-arrow arrow-${dir}`} viewBox="0 0 48 24" aria-hidden>
      <path className="draw" pathLength={1} d="M3 13 C 14 9, 28 15, 42 11" />
      <path className="draw draw-2" pathLength={1} d="M34 5 C 37 8, 40 10, 43 11 C 39 13, 36 16, 34 19" />
    </svg>
  )
}

function Step({ n, cls }: { n: number; cls: string }) {
  const s = STEPS[n - 1]
  return (
    <div className={`loop-step ${cls} ${s.tone ? `step-${s.tone}` : ''}`} style={{ animationDelay: `${n * 0.06}s` }}>
      <div className="loop-head hand">
        <span className="loop-num">{n}</span> {s.title}
      </div>
      <p className="hand">{s.text}</p>
    </div>
  )
}

/** Snake flowchart: 1 → 2 → 3 → 4, down, 7 ← 6 ← 5, and a repeat arrow back to 1. */
function LoopFlow() {
  return (
    <div className="loop">
      <Step n={1} cls="g-s1" />
      <span className="g-a12"><Arrow dir="right" /></span>
      <Step n={2} cls="g-s2" />
      <span className="g-a23"><Arrow dir="right" /></span>
      <Step n={3} cls="g-s3" />
      <span className="g-a34"><Arrow dir="right" /></span>
      <Step n={4} cls="g-s4" />
      <span className="g-a45"><Arrow dir="down" /></span>
      <Step n={5} cls="g-s5" />
      <span className="g-a56"><Arrow dir="left" /></span>
      <Step n={6} cls="g-s6" />
      <span className="g-a67"><Arrow dir="left" /></span>
      <Step n={7} cls="g-s7" />
      <span className="g-back" aria-hidden>
        <svg viewBox="0 0 60 120" preserveAspectRatio="none">
          <path d="M55 108 C 25 110, 8 95, 10 60 C 11 35, 18 20, 30 10" />
          <path d="M20 14 C 24 12, 27 11, 31 9 C 31 13, 32 17, 33 21" />
        </svg>
        <span className="hand">repeat</span>
      </span>
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

          <section aria-label="The loop">
            <LoopFlow />
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
