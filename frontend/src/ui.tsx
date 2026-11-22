import { useEffect, type ReactNode } from 'react'
import { AlertCircle, X } from 'lucide-react'
import { Mark } from './sketch'
import type { AgentVersion } from './types'

export type Tone = 'neutral' | 'accent' | 'pass' | 'fail' | 'warn'

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>
}

export function StatusPill({ status }: { status: AgentVersion['status'] }) {
  const tone = status === 'champion' ? 'pass' : status === 'candidate' ? 'warn' : status === 'rejected' ? 'fail' : 'neutral'
  return <Pill tone={tone}>{status}</Pill>
}

export function PassMark({ passed, size = 16 }: { passed: boolean; size?: number }) {
  return <Mark passed={passed} size={size} />
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="in progress" />
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  if (!error) return null
  return (
    <div className="error-text" role="alert">
      <AlertCircle size={14} />
      <span>{error}</span>
    </div>
  )
}

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h3>{title}</h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  )
}
