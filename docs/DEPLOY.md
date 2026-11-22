# Deploying Evolve (demo)

**Recommended setup:** one Render web service, built from the repo's `Dockerfile`. FastAPI serves
`/api/*` (including the SSE chat stream) and the built React UI from the same URL, so you don't
need CORS, a proxy or a frontend code change.

Why this setup: the chat stream stays open for 15–60 s, and the engine keeps state in memory and in
`backend/data/*.json`. Both need a single long-running process, and a Render web service is one.
Vercel Functions are short-lived serverless instances with a read-only filesystem, so they don't fit
the backend (see "Why not Vercel" below).

Files used: `Dockerfile`, `.dockerignore`, `render.yaml` (all at the repo root).

---

## 0. Before you start

1. **Commit and push everything to `main`.** Render builds from GitHub, not from your laptop.
   Check with `git status`. Anything you haven't pushed won't be deployed.
2. Optional local check, which needs Docker:
   ```bash
   docker build -t evolve-demo .
   docker run --rm -p 8080:10000 --env-file backend/.env evolve-demo
   # open http://localhost:8080
   ```

## 1. Create the service (Blueprint: about 5 clicks)

1. Sign in at https://dashboard.render.com with GitHub.
2. **New → Blueprint**. Connect GitHub and grant access to `Ranjith-JS2803/unconference-buildathon`,
   then select the repo. Render reads `render.yaml`.
3. Render asks for the values of the secret env vars (`sync: false`). Paste them from your local
   `backend/.env`:

   | Variable | Required | Notes |
   |---|---|---|
   | `LLM_PROVIDER` | yes | `openai_compat` when you use the gateway |
   | `OPENAI_COMPAT_BASE_URL` | yes | the gateway URL (`https://api.preview.divyam.ai/v1`) |
   | `OPENAI_COMPAT_API_KEY` | yes | secret |
   | `AGENT_MODEL` | yes | same as local |
   | `EVOLVER_MODEL` | yes | same as local |
   | `ANTHROPIC_API_KEY` | only if `LLM_PROVIDER=anthropic` | add it under Environment |

   Optional settings that already have defaults: `AGENT_EFFORT`, `EVOLVER_EFFORT`, `GATE_CONCURRENCY`
   (default 8), `AUTOPILOT`, `MAX_EVOLVE_ATTEMPTS`.
4. **Plan:** `render.yaml` uses **Starter** (paid, never sleeps). To try it out for free first,
   change `plan: starter` to `plan: free` (it sleeps after 15 minutes idle; see section 3).
   You can also change the plan later under the service's **Settings → Instance Type**.
5. Click **Apply**. The first build takes about 3–5 minutes (npm build plus `uv sync`).

*Alternative without the Blueprint:* **New → Web Service → repo → Language: Docker**, then health
check path `/api/state`, add the env vars above, and pick an instance type.

*Alternative without Docker (native Python runtime):* Language **Python 3**, root directory empty,
and env var `PYTHON_VERSION=3.12.8` (Render's default is now 3.14).
- Build command: `pip install uv && cd backend && uv sync --frozen --no-dev && cd ../frontend && npm ci && npm run build`
- Start command: `cd backend && .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port $PORT`

These commands were tested locally. On Render itself, Docker is the safer choice because it pins
Python 3.12, Node 20 and uv exactly.

## 2. Verify

Replace `URL` with `https://<service>.onrender.com`:

```bash
curl -s URL/api/state | head -c 200                       # JSON, HTTP 200
curl -s URL/api/usecases | head -c 200                    # list of use cases
curl -sN "URL/api/chat/stream?message=hello" | head -20   # SSE: run_started, agent_thinking, ...
```

Then open `URL` in the browser and run one full chat turn end to end (agents, evolution and the
gate). If you see `LLM gateway error`, check the env vars under **Environment** and redeploy.

State resets on every deploy or restart, because there is no disk. That's fine for the demo. If you
want a clean start on stage, use the app's reset (`POST /api/reset`).

## 3. Demo-day checklist (reliability)

- **Use Starter for the demo.** The free plan spins down after 15 minutes without traffic, takes
  about 1 minute to wake, and "might restart at any time" (wiping in-memory state).
  Starter doesn't sleep. You can downgrade back to free after the demo.
- If you stay on free, warm it up: open the URL about 2 minutes before you go on stage, and keep
  the tab open. To keep it awake all day, add a free uptime monitor (for example UptimeRobot)
  hitting `URL/api/state` every 5–10 minutes. 750 free hours a month covers one service 24/7.
- Don't push to `main` during the demo, because `autoDeploy: true` would redeploy and reset state.
  Turn off Auto-Deploy in Settings if you're unsure.
- Do a full dry run on the deployed URL from the stage laptop, using the venue Wi-Fi.
- Fallback: run it locally (`uv run uvicorn app.main:app --port 8001` and `npm run dev`), or use
  the Docker command from step 0.

## Why not Vercel for the backend

- Functions are capped by max duration (300 s on Hobby), which a 60 s stream would fit. But
  instances are ephemeral and can scale out: the filesystem is read-only except a per-instance
  `/tmp`, and nothing persists after the instance stops. So `/api/state`, `/api/chat/stream` and
  `/api/reset` could reach different instances with different in-memory state. That's not
  dependable on stage.

## Optional: frontend on Vercel, backend on Render

This needs no code change: keep the relative `/api` URLs and let Vercel proxy them. Create the
Vercel project with **Root Directory = `frontend`** (framework preset Vite) and add
`frontend/vercel.json`:

```json
{
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://<service>.onrender.com/api/:path*" },
    { "source": "/((?!assets/).*)", "destination": "/index.html" }
  ]
}
```

Caveats: Vercel's external-rewrite (proxy) timeout is 120 s on all plans, and the docs don't say
whether SSE streams through a rewrite without buffering. You also still need the Render backend, so
this adds a second moving part and no reliability. Use it only if you want a vercel.app URL.
