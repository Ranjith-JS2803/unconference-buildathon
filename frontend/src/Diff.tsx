import { useMemo, useState } from 'react'
import type { DiffLine } from './types'

type Block = { kind: 'lines' | 'fold'; lines: DiffLine[] }

/** Groups unchanged runs into folds, keeping `context` lines around each change. */
function buildBlocks(lines: DiffLine[], context: number): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const start = i
    if (lines[i].op !== ' ') {
      while (i < lines.length && lines[i].op !== ' ') i++
      blocks.push({ kind: 'lines', lines: lines.slice(start, i) })
      continue
    }
    while (i < lines.length && lines[i].op === ' ') i++
    const run = lines.slice(start, i)
    const head = start === 0 ? 0 : context
    const tail = i === lines.length ? 0 : context
    if (run.length - head - tail >= 2) {
      if (head) blocks.push({ kind: 'lines', lines: run.slice(0, head) })
      blocks.push({ kind: 'fold', lines: run.slice(head, run.length - tail) })
      if (tail) blocks.push({ kind: 'lines', lines: run.slice(run.length - tail) })
    } else {
      blocks.push({ kind: 'lines', lines: run })
    }
  }
  return blocks
}

export function Diff({ lines, context = 1 }: { lines: DiffLine[]; context?: number }) {
  const blocks = useMemo(() => buildBlocks(lines, context), [lines, context])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const added = lines.filter((l) => l.op === '+').length
  const removed = lines.filter((l) => l.op === '-').length
  return (
    <div className="diff mono">
      <div className="diff-stats">
        <span className="text-pass">+{added}</span> <span className="text-fail">−{removed}</span>
        <span className="muted"> system prompt</span>
      </div>
      {blocks.map((b, bi) =>
        b.kind === 'fold' && !expanded.has(bi) ? (
          <button key={bi} className="diff-fold" onClick={() => setExpanded(new Set(expanded).add(bi))}>
            ··· {b.lines.length} unchanged lines
          </button>
        ) : (
          b.lines.map((l, li) => (
            <div key={`${bi}-${li}`} className={`diff-line diff-${l.op === '+' ? 'add' : l.op === '-' ? 'del' : 'ctx'}`}>
              <span className="diff-op">{l.op === ' ' ? '' : l.op === '-' ? '−' : '+'}</span>
              <span className="diff-text">{l.text || ' '}</span>
            </div>
          ))
        ),
      )}
    </div>
  )
}
