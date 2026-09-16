# Deploying

Two things need hosting, and they have very different requirements:

| part | what it is | needs |
|---|---|---|
| **demo page** + **self-test harness** | pure static HTML/JS (`demo/`, `tools/`, `extension/`) | any static host, **HTTPS** — WebGPU only runs in a secure context |
| **planner API** | FastAPI (`server/`) | a Python runtime |

The extension itself is **never** deployed to a web host. It is loaded from disk via
`chrome://extensions` → Load unpacked, or packaged as a `.crx`/`.zip` for the Chrome
Web Store. A hosted URL cannot install it.

---

## Recommended: Render (one URL for everything)

Render runs a persistent process, so it behaves exactly like `./run.sh` — the same
origin serves the API, the demo page and the self-test harness, and the in-memory
audit ring survives between requests.

[`render.yaml`](../render.yaml) is already in the repo:

1. Push the repo to GitHub.
2. [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**.
3. Pick the repo. Render reads `render.yaml` and fills everything in.
4. **Apply**. First build takes ~2 minutes.

You get `https://aegis-agent.onrender.com` (the name is taken from `render.yaml`;
Render appends a suffix if it collides):

```
https://<your-app>.onrender.com/demo/                  ← demo target page
https://<your-app>.onrender.com/tools/selftest.html    ← self-test, assertions
https://<your-app>.onrender.com/v1/health              ← planner status
https://<your-app>.onrender.com/v1/audit               ← hash-only audit log
```

Then, in the extension popup → **Settings** → **Planner endpoint**, replace
`http://127.0.0.1:8077` with your Render URL. CORS already allows
`chrome-extension://` origins, so nothing else changes.

**Free tier caveat:** the instance sleeps after 15 minutes idle and takes ~30 s to
wake. Hit `/v1/health` a minute before you present, or upgrade for the demo day.

## Alternative: Vercel

Vercel is excellent at the static half and workable for the API. It checks the
filesystem before applying rewrites, so `demo/`, `tools/` and `extension/` are served
as static assets and only `/v1/*` reaches the Python function.

[`vercel.json`](../vercel.json) and [`api/index.py`](../api/index.py) are in the repo:

```bash
npm i -g vercel
vercel login
vercel --prod        # from the repo root
```

Or import the repo at [vercel.com/new](https://vercel.com/new) — no build settings to
change; the root `requirements.txt` re-exports `server/requirements.txt`.

Two things to know:

- **Functions are ephemeral.** `/v1/audit` resets on every cold start, because the
  audit ring is in memory. Fine for a demo, and the client keeps its own copy of every
  attestation anyway.
- **`AEGIS_PLANNER=ollama` cannot work from Vercel** — the function has no route to a
  model server on your laptop. Keep the heuristic planner, or point `AEGIS_BASE` at a
  publicly reachable inference endpoint.

## Static-only (GitHub Pages, Netlify, Cloudflare Pages)

If all you need is a public link for the demo page and the self-test harness — which
is usually what a submission form wants — host the repo statically. Both work with no
server at all, because the self-test imports the enclave modules directly:

```
/demo/index.html
/tools/selftest.html
```

For GitHub Pages: **Settings → Pages → Deploy from a branch → `main` / root.** The
demo page then lives at `https://<user>.github.io/<repo>/demo/`.

The only thing you lose is **Run agent**, since there is no planner to call.
**Perceive & Redact** still works completely — it makes no network call by design,
which is the part worth showing anyway.

## Docker / anywhere else

```bash
docker build -f deploy/Dockerfile -t aegis-agent .
docker run -p 8077:8077 aegis-agent
```

[`deploy/Procfile`](../deploy/Procfile) covers Heroku-style buildpack platforms
(Railway, Fly, Dokku).

## Environment variables

| variable | default | meaning |
|---|---|---|
| `PORT` | `8077` | bound by the host platform |
| `AEGIS_PLANNER` | `heuristic` | `heuristic`, `ollama`, `openai` / `vllm` |
| `AEGIS_MODEL` | `qwen2.5vl:7b` | model id for the non-heuristic back ends |
| `AEGIS_BASE` | `http://127.0.0.1:11434` | inference server base URL |
| `AEGIS_API_KEY` | — | bearer token for an OpenAI-compatible endpoint |
| `AEGIS_TIMEOUT` | `120` | seconds to wait on the model |
| `AEGIS_MAX_IMAGE_BYTES` | `8388608` | reject frames larger than this |

## Before you hand out the link

- [ ] `/v1/health` returns `ok: true` and the planner you expect
- [ ] `/tools/selftest.html` → **Run self-test** shows *all 8 assertions passed*, and
      the backend line says `webgpu` (it will say `cpu` on a host without a GPU —
      that is the fallback working, not a failure)
- [ ] `/demo/` renders all six panels, including the canvas chit and the annexure image
- [ ] the popup's **Planner endpoint** points at the deployed URL, and the server badge
      is green
- [ ] you warmed the free-tier instance

## Production hardening this repo does not do

The deployed planner is a demo. Before it faces anything real:

- **TLS and request signing.** Attestations are currently unsigned, so a client could
  fabricate one. Signing them with a per-install key, and pinning that key server-side,
  is what makes the attestation load-bearing rather than advisory.
- **Rate limiting and auth** on `/v1/plan` — right now anyone with the URL can spend
  your GPU.
- **Lock CORS down** to your published extension id instead of the
  `chrome-extension://.*` regex in [`server/main.py`](../server/main.py).
- **Drop `/extension` and `/tools`** from the static mounts. They exist so the
  self-test can import the real enclave modules without a build step; a production
  planner should not serve extension source.
