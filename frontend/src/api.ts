import type { AppState, ChatEvent, UseCase } from './types'
import { mockApi } from './mock'

export class ApiError extends Error {}

async function request<T>(method: 'GET' | 'POST', path: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { method })
  } catch {
    throw new ApiError('Cannot reach the backend. Is it running?')
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const data = await res.json()
      if (data && typeof data.detail === 'string') detail = data.detail
      else if (data && data.detail) detail = JSON.stringify(data.detail)
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(detail)
  }
  return (await res.json()) as T
}

/** Opens the chat stream. Calls onEvent for every event (including the final `done`).
 *  Returns a function that closes the stream. */
export type StreamFn = (usecase: string, message: string, onEvent: (ev: ChatEvent) => void) => () => void

export interface Api {
  listUsecases(): Promise<UseCase[]>
  getState(usecase: string): Promise<AppState>
  reset(usecase: string): Promise<AppState>
  stream: StreamFn
}

const realStream: StreamFn = (usecase, message, onEvent) => {
  const es = new EventSource(`/api/chat/stream?usecase=${encodeURIComponent(usecase)}&message=${encodeURIComponent(message)}`)
  let finished = false
  const close = () => {
    finished = true
    es.close()
  }
  es.onmessage = (msg) => {
    let ev: ChatEvent
    try {
      ev = JSON.parse(msg.data) as ChatEvent
    } catch {
      return
    }
    if (ev.type === 'done') close()
    onEvent(ev)
  }
  es.onerror = () => {
    // EventSource would auto-reconnect and re-send the message; never let it.
    if (finished) return
    close()
    onEvent({ type: 'error', detail: 'Lost connection to the backend stream.' })
    onEvent({ type: 'done' })
  }
  return close
}

const realApi: Api = {
  listUsecases: () => request('GET', '/api/usecases'),
  getState: (uc) => request('GET', `/api/state?usecase=${encodeURIComponent(uc)}`),
  reset: (uc) => request('POST', `/api/reset?usecase=${encodeURIComponent(uc)}`),
  stream: realStream,
}

export const IS_MOCK = import.meta.env.VITE_MOCK === '1'
export const api: Api = IS_MOCK ? mockApi : realApi

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
