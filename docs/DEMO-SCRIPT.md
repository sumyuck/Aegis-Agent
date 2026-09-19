# Three-minute judge demo

Have running before you start: the extension loaded, and
**https://aegis-agent-yg91.onrender.com/demo/** open with the browser window at a normal size.
(For offline practice, use `./run.sh` and `http://127.0.0.1:8077/demo/` instead.)
Keep the popup's **Settings** tab on *Balanced*, WebGPU on, heatmap on.

---

### 0:00 — the setup (20 s)

> "This page is a simulated mission-ops dashboard. It has nine secrets planted on
> it — Aadhaar, PAN, card numbers, a session token, launch coordinates — and they
> are planted in four deliberately different places. Scroll to the bottom and the
> page tells you exactly what they are and which detector is supposed to catch
> each one."

Scroll to the manifest table. Let them read it for five seconds.

### 0:20 — the failure mode we're fixing (25 s)

Open Settings, switch mode to **DOM only**, press **Scan & protect**.

> "This is what a conventional agent does — read the DOM, mask what the DOM admits
> to. Eleven regions masked. Now look at the canvas box and the scanned annexure."

Point at the sanitised image: the canvas Aadhaar and the rasterised annexure are
still fully legible.

> "Those three rows leak. There is no DOM node behind them — the text was painted
> as pixels. `document.body.innerText` returns nothing from that box."

### 0:45 — the fix (35 s)

Switch mode back to **Balanced**, press **Scan & protect** again.

> "Same frame, second lens: a WebGPU compute shader over the pixels themselves."

Click the **Lens B map** toggle.

> "One invocation per 8×8 tile. It measures how often luminance flips sign across a
> scanline — glyph strokes do that constantly, photographs and flat UI don't. That's
> why the photo region and the logo stay unmasked while every line of type lights
> up."

Toggle back to the sanitised view.

> "Canvas closed. Annexure closed. Sandboxed iframe closed — and that one has no
> `allow-scripts`, so *no* content script can run inside it. Lens A is blind there
> by construction; the GPU pass isn't."

### 1:20 — the proof (30 s)

Point at the green verdict bar, then open the **Audit** tab.

> "Every mask is verified, not asserted. Masking runs in two stages: first every
> region is overwritten with one solid colour and read *back* off the canvas to
> confirm it is pixel-uniform — one distinct colour, zero Shannon entropy, nothing
> to recover. Only *then* do we draw the token label on top. Verifying before
> annotating is the whole trick; verifying after would prove nothing."

Scroll the mask table so they see the `yes · 0 bits` column and the `1` in Colours.

### 1:50 — structure survives (20 s)

Open the **On the wire** tab.

> "This is the exact JSON the server gets. No pixels you haven't seen, and the
> masked regions travel as *tokens* — `[MASK_PASSWORD]` at these coordinates. The
> model learns that a password field exists and where it is, and learns nothing
> inside it. That's why the agent still works."

Point at the firewall line.

> "And the worker re-scans every text field on that envelope independently before
> it goes out. A bug in the perception stage still can't leak an Aadhaar through a
> metadata label."

### 2:10 — the agent actually acts (35 s)

Type into the goal box:

```
open the Payments tab and then start a new transfer
```

Press **Run mission**. Open **Activity** only if a judge asks for the trace.

> "Two steps, each one a fresh perceive-redact-plan-act cycle. The planner grounded
> both to element refs. Note what it never had: any redacted value."

Then type:

```
type hunter2 into the password field
```

> "And this is refused locally — `BLOCKED_CREDENTIAL_FIELD`. The remote planner is
> structurally incapable of writing to a password, OTP or CVC field. Even if the
> model is fully compromised, it cannot inject or harvest a credential."

### 2:45 — the numbers (15 s)

Point at the metrics row.

> "Six milliseconds for the GPU pass on an integrated Intel chip. Sixty-two
> milliseconds for the whole sanitisation. 238 KB of raw screenshot becomes 20 KB on
> the wire — twelve times less bandwidth per agent step, which is also why one cloud
> GPU serves far more concurrent agents."

---

## If something goes wrong on stage

| symptom | cause | fix |
|---|---|---|
| "No frame responded" | content script hasn't attached | reload the demo tab |
| backend badge says CPU fallback | no WebGPU on that machine | fine — say so, it's 43 ms instead of 6 ms |
| logos or charts get masked | sensitivity too low | raise the Lens B slider to ~1.3 |
| small text missed | sensitivity too high | lower to ~0.85, or set tile = 4 |
| `server down` badge | uvicorn not running | `./run.sh` |
| first run is slow (~300 ms) | cold WGSL pipeline | press the button twice before presenting |

## Backup if the extension won't load

Open **http://127.0.0.1:8077/tools/selftest.html** and press **Run self-test**. It
exercises the identical perception and redaction code with printed assertions, and
lets you show the heatmap, the uniformity proofs and the timings without Chrome
extension loading working at all.
