# Measured numbers, and what to change on the slides

Everything below was measured on the build in this repo, on an **Intel gen-9
integrated GPU** (a weak iGPU — a discrete card or Apple Silicon will be faster).
Re-run `tools/selftest.html` on your own demo laptop and use *those* numbers in the
deck; judges ask which machine produced them.

## Sanitisation pipeline — 900×560 frame, 36 masked regions

| stage | WebGPU | CPU fallback | note |
|---|---|---|---|
| Lens A — full DOM + 1 nested frame | 6.5 ms | — | 11 regions, ~1.8k text nodes |
| Lens B — compute pass | **5.8 ms** | 43 ms | 7,910 tiles, 100 texture fetches/tile |
| component grouping | 0.8 ms | 0.8 ms | shared CPU code |
| PNG decode of the capture | 14.1 ms | 14.1 ms | |
| mask fill | 1.5 ms | 1.5 ms | |
| **uniformity proof** | 2.6 ms | 2.6 ms | full read-back of every region |
| WebP encode (q=0.72) | 36.8 ms | 36.8 ms | now the dominant cost |
| **total** | **62 ms** | 158 ms | |

- **Cold first run is ~315 ms** — WGSL pipeline creation and the first GPU submit.
  Press the button twice before you present.
- GPU vs CPU speedup on the perception pass: **7.4×**, with **identical region
  output** — both back ends implement the same descriptor, which is a claim you can
  demonstrate live by flipping the Backend selector.
- Lens B on the demo page's real `<canvas>` (520×190): **9.3 ms**, 3 merged regions
  covering all 4 planted secret lines.

## Bandwidth

238 KB raw PNG → **20 KB WebP on the wire, 12.1×**. That is the number behind the
"more concurrent agents per cloud GPU" claim, and it is worth stating as bandwidth
rather than as a GPU multiplier unless you have benchmarked the server side.

## GPU memory

There are **no model weights resident at all** — Lens B is a compute kernel, not a
network. Allocation per frame is one `rgba8unorm` texture plus two tile buffers:

```
2880 × 1800 frame:  texture 20.7 MB + tile buffers 2.6 MB  ≈  24 MB
1440 ×  900 frame:  texture  5.2 MB + tile buffers 0.7 MB  ≈   6 MB
```

Both are destroyed at the end of every `detect()` call.

## Detection accuracy on the demo target

| planted secret | location | caught by | result |
|---|---|---|---|
| session JWT | DOM text | Lens A | ✓ `[MASK_TOKEN]` |
| Aadhaar (Verhoeff-valid) | DOM text | Lens A | ✓ `[MASK_AADHAAR]` |
| PAN / passport / DOB / UPI | DOM text | Lens A | ✓ 4 tokens |
| email / mobile | DOM text | Lens A | ✓ 2 tokens |
| password + OTP fields | field attributes | Lens A | ✓ `[MASK_PASSWORD]` `[MASK_OTP]` |
| card number + CVC | nested iframe | Lens A | ✓ correct top-frame coordinates |
| Aadhaar + launch coords + card | `<canvas>` pixels | Lens B | ✓ 3 regions, all 4 lines |
| annexure PAN / account / IFSC | rasterised `<img>` | Lens B | ✓ |
| beneficiary + account | scriptless sandbox iframe | Lens B | ✓ |

False positives correctly avoided: the solid logo block and the noisy photographic
gradient in the self-test frame are both left untouched at the default sensitivity.

---

# Slide edits

Your current deck claims a few things this build does differently — in most cases
*better*. Judges who read the repo will check. Replacement text follows.

### Slide 2 · Uniqueness, bullet 1

> ~~integrates high-speed DOM coordinate extraction with an on-device WebGPU vision
> model to catch canvas-rendered and iframe-isolated PII~~

**Dual-Lens Detection Engine:** checksum-validated DOM extraction (Verhoeff for
Aadhaar, Luhn for cards) fused with a **two-pass WebGPU compute kernel** that scores
every 8×8 tile for glyph-stroke signature — catching canvas-painted, rasterised and
scriptless-sandbox PII that no DOM API can reach. **5.8 ms per frame, zero model
weights resident.**

### Slide 2 · Uniqueness, bullet 2 — strengthen this one, it's your best claim

> ~~Destroys sensitive pixel data on an offscreen canvas; mathematically guarantees
> zero recovery from intercepted packets.~~

**Verified Irreversible Redaction:** masking runs destroy-then-annotate — each region
is overwritten with a single colour, **read back off the canvas and asserted
pixel-uniform (one distinct colour, zero Shannon entropy) before any label is drawn**.
Irreversibility ships as a per-region proof in the audit record, not as an assurance.

### Slide 2 · add a fourth uniqueness bullet (you have two demo-able guarantees the deck omits)

**Two Structural Guarantees, Not Policies:** the raw-pixel enclave runs under
`connect-src 'none'` — `fetch`/XHR/WebSocket do not exist in the realm that sees your
screen. And the local actuator **refuses every write to a severity-3 field**, so a
fully compromised remote model cannot inject or harvest a password, OTP or CVC.

### Slide 3 · Process flow, step 2

> ~~An offscreen worker runs an INT4-quantized vision model (Tiny-ViT / MobileNetV4)~~

**On-Device WebGPU Detection:** a network-isolated offscreen document dispatches a
WGSL compute pass — one invocation per 8×8 tile measuring luminance variance, Sobel
energy, gradient anisotropy and **edge-crossing density**, the term that separates
glyph strokes from photographic gradients. Connected-component grouping yields
line-shaped candidate regions. A byte-parity CPU path covers machines without WebGPU.

### Slide 3 · Tech stack

> ~~On-Device Vision: Transformers.js, ONNX Runtime Web (WASM + WebGPU), INT4/INT8
> Quantized Tiny-ViT~~

**On-Device Vision:** WebGPU / WGSL compute shaders, `OffscreenCanvas`, CPU-parity
fallback. *Roadmap:* ONNX Runtime Web adapter behind the existing `createDetector()`
interface for per-region PII classification.

> ~~Execution & Testing: Chrome DevTools Protocol (CDP), HTML5 Canvas 2D API~~

**Execution & Testing:** synthetic `PointerEvent`/`KeyboardEvent` dispatch from an
isolated content script, HTML5 Canvas 2D read-back assertions, in-browser self-test
harness with pass/fail assertions.

### Slide 4 · Challenge 02, solution

> ~~Models are quantized to INT4 ONNX format and maintained in a persistent Offscreen
> Document, keeping memory under 250 MB VRAM.~~

No model weights are resident at all. The kernel allocates one frame texture plus
tile buffers — **≈24 MB of GPU memory at 2880×1800, destroyed after every frame** —
inside a persistent offscreen document, so the page's own main thread is untouched
apart from a 6.5 ms DOM scan.

### Slide 4 · Challenge 04, solution

> ~~Parallel DOM evaluation (<15ms) + WebGPU inference (<65ms) + WebP compression
> keeps total agent action latency under 500ms.~~

Measured on an Intel gen-9 iGPU: DOM lens **6.5 ms**, GPU pass **5.8 ms**, uniformity
proof **2.6 ms**, WebP encode **36.8 ms** — **62 ms of total on-device sanitisation**,
and 12.1× less data on the wire. End-to-end step latency is then bounded by the
planner: sub-200 ms against a grounding planner, 1–3 s against a 7B VLM.

### Slide 5 · Key impact pillar 3

> ~~Maintains <250 MB VRAM and 0% impact on main webpage rendering speed.~~

**Ultra-Low Footprint:** ≈24 MB of transient GPU memory and no resident model
weights. Perception runs in a separate offscreen document; the page's own main
thread pays only a 6.5 ms DOM pass.

### Slide 5 · Key impact pillar 4 — this one needs softening

> ~~Universal Compatibility: Functions natively across Chromium and Firefox without
> requiring custom OS-level drivers.~~

**Driver-Free Portability:** runs on stock Chromium 116+ with no native binary, no
OS driver and no model download; the CPU-parity path covers hardware without WebGPU.
Firefox support is scoped for the next milestone — it ships neither MV3 offscreen
documents nor WebGPU enabled by default.

### Slide 3 · Working prototype details

```
Deployed Prototype : run.sh → http://127.0.0.1:8077/demo/  (local, no cloud needed)
Self-test harness  : http://127.0.0.1:8077/tools/selftest.html  (assertions, no install)
GitHub Repository  : <your repo>
Demo Video         : <your link>
```
