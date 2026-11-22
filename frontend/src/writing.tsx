// "Pencil on paper": a per-lane render queue that writes items one after another.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Item } from './laneState'
import type { AgentVersion } from './types'
import { compactInput } from './format'
import { PencilTip } from './sketch'

const BASE_CPS = 55 // chars per second when the lane is keeping up
const MAX_LAG_S = 2 // never fall more than ~2s behind the stream
const MIN_CHARS = 16 // every item takes at least ~0.3s (connector + marks draw)

export const prefersReducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** The text segments an item writes, in render order. Rendering must consume them in the same order. */
export function segmentsOf(it: Item): string[] {
  switch (it.kind) {
    case 'thought':
      return [it.text]
    case 'tool':
      return [it.tool, compactInput(it.input)]
    case 'reply':
      return ['Sent the final reply']
    case 'effect':
      return [it.text]
    case 'checks': {
      if (it.passed === null) return ['Nothing to judge: no known record was referenced.']
      const failed = it.checks.find((c) => !c.passed)
      const head = failed ? [it.allToolsOk ? 'All tool calls succeeded — but' : 'Outcome check failed', failed.detail] : ['All checks passed']
      return [...head, ...it.checks.flatMap((c) => [c.label, c.detail])]
    }
    case 'evo_start':
      return [it.belief, ...it.reality, CAUGHT_LINE]
    case 'evo_case':
      return [`Saved as eval case ${it.evalCase.id}`]
    case 'evo_diag':
      return ['Agent is diagnosing the failure']
    case 'evo_candidate':
      return candidateSegments(it.version)
    case 'evo_gate':
      return [`Testing ${it.champion_id} vs ${it.candidate_id} on ${it.cases.length} eval cases`]
    case 'evo_gate_case':
      return []
    case 'evo_result':
      return [decisionTitle(it.gate), it.gate.reason, ...(it.gate.decision === 'promoted' ? [appliesLine(it.gate.candidate_id)] : [])]
    case 'evo_retry':
      return [retryLine(it.attempt - 1, it.reason)]
    case 'evo_skipped':
      return [`Evolution skipped: ${it.reason}`]
  }
}

export const CAUGHT_LINE = "Outcome checks look at the real end state of the systems, not at tool errors. That's how the failure was caught."
export const appliesLine = (v: string) => `From now on, ${v} applies this lesson to every request.`

/** Evidence notes (tag stripped) + root cause + lesson, falling back to older fields. */
export function evidenceOf(v: AgentVersion): { tag: string; text: string }[] {
  if (v.evidence?.length) {
    return v.evidence.map((e) => {
      const m = e.match(/^\s*\[([^\]]+)\]\s*(.*)$/)
      return m ? { tag: m[1], text: m[2] } : { tag: '', text: e }
    })
  }
  return v.diagnosis ? [{ tag: '', text: v.diagnosis }] : []
}
export const lessonOf = (v: AgentVersion) => v.lesson || v.change_summary || ''
export function candidateSegments(v: AgentVersion): string[] {
  return [...evidenceOf(v).map((e) => e.text), v.root_cause ?? '', lessonOf(v)].filter((x) => !!x)
}

export const retryLine = (n: number, reason: string) => `Attempt ${n} rejected: ${reason} → the agent revises its fix`

export const decisionTitle = (g: { decision: string; candidate_id: string; champion_id: string }) =>
  g.decision === 'promoted' ? `PROMOTED · ${g.candidate_id} is the new champion` : `REJECTED · ${g.champion_id} stays champion`

const costOf = (it: Item) => Math.max(MIN_CHARS, segmentsOf(it).reduce((s, t) => s + t.length, 0))

export interface WritePos {
  index: number // items before this are fully written
  chars: number // progress into items[index]
}

/** Advances a lane's write position over time. Resets when `runKey` changes,
 *  jumps to the end when `finished` (stream done) or reduced motion is on. */
export function useWriter(items: Item[], finished: boolean, runKey: number): WritePos {
  const [pos, setPos] = useState<WritePos>({ index: 0, chars: 0 })
  const posRef = useRef(pos)
  const itemsRef = useRef(items)
  itemsRef.current = items

  useEffect(() => {
    posRef.current = { index: 0, chars: 0 }
    setPos(posRef.current)
  }, [runKey])

  useEffect(() => {
    if (finished || prefersReducedMotion()) {
      posRef.current = { index: Number.MAX_SAFE_INTEGER, chars: 0 }
      setPos(posRef.current)
      return
    }
    let raf = 0
    let last = performance.now()
    const tick = (t: number) => {
      const dt = Math.min(0.1, (t - last) / 1000)
      last = t
      const its = itemsRef.current
      let { index, chars } = posRef.current
      if (index > its.length) index = its.length
      if (index < its.length) {
        let remaining = costOf(its[index]) - chars
        for (let j = index + 1; j < its.length; j++) remaining += costOf(its[j])
        let speed = Math.max(BASE_CPS, remaining / MAX_LAG_S)
        if (its.length - index - 1 > 3) speed *= 1.6
        chars += speed * dt
        while (index < its.length && chars >= costOf(its[index])) {
          chars -= costOf(its[index])
          index++
        }
        if (index >= its.length) chars = 0
        posRef.current = { index, chars }
        setPos(posRef.current)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [finished, runKey])

  return pos
}

/** Visible-char budget for item i given the lane write position. -1 = not started yet. */
export function budgetFor(i: number, pos: WritePos): number {
  if (i < pos.index) return Infinity
  if (i === pos.index) return pos.chars
  return -1
}

/** Consumes a char budget across segments in order; puts the pencil at the writing tip. */
export class Typer {
  private left: number
  constructor(budget: number) {
    this.left = budget
  }
  get started() {
    return this.left > 0
  }
  /** Returns the visible part of `text`, or null if writing hasn't reached it yet. */
  t(text: string): ReactNode | null {
    if (this.left <= 0 && text.length > 0) return null
    const shown = text.slice(0, Math.max(0, Math.floor(this.left)))
    const writing = this.left < text.length
    this.left -= text.length
    return (
      <>
        {shown}
        {writing && <PencilTip />}
      </>
    )
  }
  /** True once every segment before this point has been written completely. */
  get reached() {
    return this.left >= 0
  }
}

/** Standalone typewriter for chat bubbles. */
export function TypeOut({ text, instant }: { text: string; instant?: boolean }) {
  const [n, setN] = useState(() => (instant || prefersReducedMotion() ? text.length : 0))
  useEffect(() => {
    if (instant || prefersReducedMotion()) {
      setN(text.length)
      return
    }
    let raf = 0
    let last = performance.now()
    let acc = 0
    const tick = (t: number) => {
      acc += ((t - last) / 1000) * 70
      last = t
      const v = Math.min(text.length, Math.floor(acc))
      setN(v)
      if (v < text.length) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [text, instant])
  return (
    <>
      {text.slice(0, n)}
      {n < text.length && <PencilTip />}
    </>
  )
}
