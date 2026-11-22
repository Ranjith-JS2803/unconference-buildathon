# Evolve: frontend

Vite + React + TypeScript. Two lanes show one customer message handled by a frozen agent (v1)
and a self-evolving agent side by side, with live execution flow and automatic evolution
(including retries) streamed over SSE (`docs/api-contract-v2.md`). The chat is a pop-up that
docks at the bottom once a query is sent; "How it works" explains the loop.

```bash
npm install

# against the real backend (FastAPI on :8001; override with API_TARGET=http://host:port)
npm run dev

# without a backend: in-browser mock that plays the whole story
VITE_MOCK=1 npm run dev

# production build -> dist/ (served by FastAPI from the same origin)
npm run build
```

- Types: `src/types.ts` · API + SSE client: `src/api.ts` · mock: `src/mock.ts` (only with `VITE_MOCK=1`)
- Stream state: `src/laneState.ts` · writing queue: `src/writing.tsx` · lanes: `src/Lane.tsx` · chat: `src/Chat.tsx`
- Use-case picker and info sheet: `src/UseCases.tsx` (every API call passes `?usecase=<id>`)
- Explainer: `src/HowItWorks.tsx` · pencil strokes: `src/sketch.tsx` · styles: `src/styles.css`
