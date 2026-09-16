/**
 * Aegis-Agent :: offscreen enclave host
 *
 * Receives sanitisation jobs from the service worker, runs the WebGPU perception +
 * redaction pipeline, and hands back *only* the masked buffer plus an attestation.
 *
 * Two capture modes:
 *   frame      — the worker passes a captureVisibleTab data URL (default; works
 *                everywhere, but the worker has briefly held the raw bytes).
 *   streamId   — the worker passes a tabCapture media-stream id and this document
 *                pulls the frame itself, so the worker provably never sees a pixel.
 */

import { sanitize, getDetector } from './redactor.js';

const statusEl = document.getElementById('status');
const video = document.getElementById('tapVideo');
let jobSeq = 0;

function status(s) { statusEl.textContent = `aegis enclave: ${s}`; }

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** Pull exactly one frame from a tabCapture stream, then tear the stream down. */
async function grabFrameFromStream(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: 3840,
        maxHeight: 2160
      }
    }
  });
  try {
    video.srcObject = stream;
    await video.play();
    // One extra frame of settle time — the first frame after play() is often blank.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const bitmap = await createImageBitmap(video);
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    c.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    return await c.convertToBlob({ type: 'image/png' });
  } finally {
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || msg.target !== 'aegis-offscreen') return false;

  if (msg.type === 'AEGIS_GPU_INFO') {
    (async () => {
      try {
        const det = await getDetector(msg.useGpu === false ? 'cpu' : 'webgpu');
        respond({
          ok: true,
          backend: det.backend,
          adapter: det.adapterInfo,
          webgpuAvailable: typeof navigator !== 'undefined' && 'gpu' in navigator
        });
      } catch (e) {
        respond({ ok: false, error: String(e), webgpuAvailable: 'gpu' in navigator });
      }
    })();
    return true;
  }

  if (msg.type === 'AEGIS_SANITIZE') {
    const id = ++jobSeq;
    (async () => {
      try {
        status(`job #${id} — acquiring frame`);
        let frame = msg.job.frame;
        let captureMode = 'captureVisibleTab';
        if (msg.job.streamId) {
          frame = await grabFrameFromStream(msg.job.streamId);
          captureMode = 'tabCapture (worker never sees pixels)';
        }

        status(`job #${id} — perceiving + redacting`);
        const result = await sanitize({ ...msg.job, frame });

        const payload = {
          ok: true,
          captureMode,
          sanitizedDataUrl: await blobToDataUrl(result.sanitizedBlob),
          heatmapDataUrl: result.heatmapBlob ? await blobToDataUrl(result.heatmapBlob) : null,
          attestation: result.attestation,
          regions: result.regions,
          verification: result.verification,
          vision: result.vision,
          metrics: result.metrics
        };
        status(`job #${id} — done (${result.regions.length} masks, ${result.metrics.totalMs} ms)`);
        respond(payload);
      } catch (e) {
        console.error('[aegis:enclave]', e);
        status(`job #${id} — FAILED: ${e.message}`);
        respond({ ok: false, error: String(e && e.stack || e) });
      }
    })();
    return true;
  }

  return false;
});

status('ready');
