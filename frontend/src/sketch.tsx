// Hand-drawn primitives: pencil strokes animated with stroke-dashoffset.
import type { ReactNode } from 'react'
import { Pencil } from 'lucide-react'

/** ✓ / ✗ drawn as pencil strokes. */
export function Mark({ passed, size = 18 }: { passed: boolean; size?: number }) {
  return (
    <svg className={`mark ${passed ? 'mark-pass' : 'mark-fail'}`} width={size} height={size} viewBox="0 0 24 24" aria-label={passed ? 'passed' : 'failed'} role="img">
      {passed ? (
        <path className="draw" pathLength={1} d="M3.5 12.5 C 6 14.5, 7.5 16.5, 9.5 19 C 12.5 13, 16 8, 21 4.5" />
      ) : (
        <>
          <path className="draw" pathLength={1} d="M5 5.5 C 9 9.5, 14 14, 19 19" />
          <path className="draw draw-2" pathLength={1} d="M18.5 5 C 14 9.5, 10 13.5, 5.5 19" />
        </>
      )}
    </svg>
  )
}

/** Hand-drawn box drawn around its children. */
export function SketchBox({ tone, children, className = '' }: { tone: 'pass' | 'fail' | 'ink'; children: ReactNode; className?: string }) {
  return (
    <div className={`sketchbox ${className}`}>
      <svg className={`sketchbox-svg reveal-x ink-${tone}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        <path d="M2 4 C 30 2.5, 70 3, 98.5 2 C 97.5 35, 98.5 70, 97.5 97.5 C 65 98.5, 30 97, 1.5 98 C 2.5 65, 1 30, 2 4" />
        <path d="M3 2.5 C 35 3.5, 68 1.5, 97 3.5 C 99 40, 97 72, 98.5 96 C 62 97.5, 28 99, 3 96.5 C 1.5 60, 3 28, 3 2.5" />
      </svg>
      {children}
    </div>
  )
}

/** Pencil circle around inline content. */
export function Circled({ children }: { children: ReactNode }) {
  return (
    <span className="circled">
      {children}
      <svg className="reveal-x" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden>
        <path d="M10 8 C 35 1, 80 2, 95 12 C 102 22, 85 36, 50 37 C 18 38, 1 30, 3 19 C 5 10, 20 5, 40 4" />
      </svg>
    </span>
  )
}

/** Wobbly connector drawn down the left edge of a timeline row. */
export function Connector() {
  return (
    <svg className="connector reveal-y" viewBox="0 0 10 100" preserveAspectRatio="none" aria-hidden>
      <path d="M5 0 C 3.5 25, 6.5 50, 4.5 75 C 4 88, 5.5 95, 5 100" />
    </svg>
  )
}

export function Node({ tone = 'ink' }: { tone?: 'ink' | 'pass' | 'fail' | 'blue' }) {
  return (
    <svg className={`node ink-${tone}`} viewBox="0 0 12 12" aria-hidden>
      <path className="draw" pathLength={1} d="M6 1.5 C 9 1.2, 10.8 3.5, 10.5 6.2 C 10.2 9, 8 10.8, 5.6 10.5 C 3 10.2, 1.2 8.3, 1.5 5.6 C 1.8 3.4, 3.6 1.7, 6.5 1.8" />
    </svg>
  )
}

/** The pencil at the tip of text being written. */
export function PencilTip() {
  return (
    <span className="pencil-tip" aria-hidden>
      <Pencil size={15} strokeWidth={2.2} />
    </span>
  )
}

/** A pencil hovering over the page while the model thinks. */
export function Hovering({ label = 'Thinking' }: { label?: string }) {
  return (
    <div className="hovering">
      <span className="hover-pencil" aria-hidden>
        <Pencil size={17} strokeWidth={2.2} />
      </span>
      <span className="hand">{label}</span>
      <span className="hover-dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
    </div>
  )
}
