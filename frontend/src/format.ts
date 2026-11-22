/** Compact one-line rendering of a tool input: key: value, key: value */
export function compactInput(input: Record<string, unknown>, max = 140): string {
  const s = Object.entries(input ?? {})
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`)
    .join(', ')
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export function pretty(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function time(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
