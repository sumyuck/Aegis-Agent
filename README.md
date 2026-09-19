# Aegis-Agent

**A privacy-first browser agent that understands a page without sending its private details away.**

Browser agents often send a full screenshot to a remote model. That can include passwords, IDs, payment details, and session tokens. Aegis-Agent finds sensitive content on the device, replaces it with safe labels, verifies the replacement, and only then allows a planner to receive the page.

<p align="center">
  <img src="docs/images/evidence-verdict.png" alt="Aegis-Agent showing a verified protected preview" width="760">
</p>

## What it does

- Finds sensitive text and credential fields in the DOM.
- Detects text rendered inside images, canvases, and inaccessible frames with WebGPU.
- Replaces each sensitive region locally and checks that the original pixels are gone.
- Sends the planner a protected image plus safe position tokens such as `[MASK_PASSWORD]`.
- Refuses unsafe typing into passwords, OTPs, card details, and other high-risk fields.

## Try it

```bash
git clone https://github.com/sumyuck/Aegis-Agent.git
cd Aegis-Agent
./run.sh
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select the `extension` folder.
3. Open the [live demo](https://aegis-agent-yg91.onrender.com/demo/).
4. Open the extension and click **Scan & protect**.
5. Try **Run mission** with: `Open Payments, then start a transfer`.

The planner endpoint is preconfigured for the live demo. For a local setup, open **Settings** in the extension and use `http://127.0.0.1:8077`.

## Two ways Aegis sees a page

**Lens A: page structure**

It scans visible text, form fields, and iframes for patterns such as Aadhaar, PAN, email, phone numbers, cards, OTPs, passwords, JWTs, and API keys.

**Lens B: pixels**

It looks for text-like pixels inside canvas content, images, videos, and frames where ordinary DOM inspection cannot help. This is useful for scanned documents, screenshots, and third-party widgets.

<p align="center">
  <img src="docs/images/masks-proofs.png" alt="Protected regions and their verification results" width="760">
</p>

## Why the preview is safe

Before anything leaves the browser, each sensitive region is filled with one solid colour and read back from the canvas. If the pixels are not uniform, the request is blocked. The remote planner gets the protected image, the action map, and mask tokens only.

<p align="center">
  <img src="docs/images/selftest-assertions.png" alt="Self-test showing protected output and assertions" width="760">
</p>

## Self-test

Open [the self-test](https://aegis-agent-yg91.onrender.com/tools/selftest.html) and click **Run self-test**. It runs the real perception and redaction pipeline in the browser and shows the source frame, Lens B map, protected output, timing, and verification results.

## Demo page

The bundled demo places synthetic sensitive values in normal text, form fields, a nested frame, a canvas, an image, and a sandboxed widget. Switch between **DOM only** and **Balanced** in the extension to show why both lenses matter.

All identifiers in the demo are fabricated.

## License

[MIT](LICENSE)
