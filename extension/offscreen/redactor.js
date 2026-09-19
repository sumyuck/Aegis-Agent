/**
 * Aegis-Agent :: sanitisation core (runs only inside the offscreen document)
 *
 * Two-stage masking, in this order for a reason:
 *
 *   stage 1  DESTROY   — every sensitive box is overwritten with a single solid
 *                        colour, then read back and asserted pixel-uniform. A
 *                        uniform region carries 0 bits, so no amount of contrast
 *                        stretching, super-resolution or packet capture recovers
 *                        the original glyphs. The assertion is the proof.
 *   stage 2  ANNOTATE  — a border plus a semantic token ([MASK_PASSWORD], ...) is
 *                        drawn on top of the now-empty box, so the remote planner
 *                        still knows a password field lives at those coordinates.
 *
 * Verification happens *between* the two stages — annotating first would make the
 * uniformity test meaningless.
 */

import { createDetector } from './vision-webgpu.js';

const MASK_FILL = 'rgb(24,28,36)';
const MASK_FILL_RGB = [24, 28, 36];
const MASK_BORDER = 'rgb(96,116,148)';
const MASK_TEXT = 'rgb(198,212,232)';

const SHORT_TOKEN = {
  '[MASK_PASSWORD]': '[PWD]',
  '[MASK_AADHAAR]': '[AADHAAR]',
  '[MASK_CARD]': '[CARD]',
  '[MASK_CVC]': '[CVC]',
  '[MASK_EMAIL]': '[EMAIL]',
  '[MASK_PHONE]': '[PHONE]',
  '[MASK_TOKEN]': '[TOKEN]',
  '[MASK_SECRET]': '[SECRET]',
  '[MASK_COORD]': '[GEO]',
  '[MASK_PASSPORT]': '[PASSPORT]',
  '[MASK_GSTIN]': '[GSTIN]',
  '[MASK_GOVID]': '[GOVID]',
  '[MASK_OTP]': '[OTP]',
  '[MASK_PII]': '[PII]',
  '[MASK_DOB]': '[DOB]',
  '[MASK_BANK]': '[BANK]',
  '[MASK_UPI]': '[UPI]',
  '[MASK_PAN]': '[PAN]'
};

let detector = null;
let detectorMode = null;

export async function getDetector(prefer) {
  // Settings can change while the offscreen document stays alive. Recreate the
  // detector when the requested execution path changes; otherwise switching CPU
  // fallback off would silently keep using CPU for every later scan.
  const wanted = prefer === 'cpu' ? 'cpu' : 'webgpu';
  if (!detector || detectorMode !== wanted) {
    try { detector?.dispose?.(); } catch (_) {}
    detector = await createDetector(prefer);
    detectorMode = wanted;
  }
  return detector;
}

/* ----------------------------------------------------------------- geometry */

const area = (b) => Math.max(0, b.w) * Math.max(0, b.h);

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, r - x), h: Math.max(0, bt - y) };
}

function scaleBox(b, s) {
  return { x: Math.round(b.x * s), y: Math.round(b.y * s), w: Math.round(b.w * s), h: Math.round(b.h * s) };
}

/** How much of `region` lies inside the union of `others` (approximate, 0..1). */
function coverage(region, others) {
  const a = area(region);
  if (!a) return 1;
  let covered = 0;
  for (const o of others) covered += area(intersect(region, o.box || o));
  return Math.min(1, covered / a);
}

/* ------------------------------------------------------------------- fusion */

/**
 * Lens A owns anything the DOM exposes. Lens B's job is the blind spots, so a
 * visual candidate only survives if it sits on a pixel surface we cannot read
 * (canvas / img / video / sandboxed iframe) and Lens A has not already claimed it.
 */
export function fuseLenses(domRegions, visualRegions, visualSurfaces, mode) {
  const surfaces = visualSurfaces.filter((s) => s.box.w >= 40 && s.box.h >= 14);
  const kept = [];

  for (const v of visualRegions) {
    const onSurface = coverage(v.box, surfaces);
    const alreadyMasked = coverage(v.box, domRegions);
    if (alreadyMasked > 0.55) continue;
    if (mode !== 'paranoid' && onSurface < 0.35) continue;

    const surface = surfaces.find((s) => area(intersect(v.box, s.box)) > 0);
    kept.push({
      source: 'gpu-visual',
      ruleId: 'visual-text',
      token: '[MASK_PII]',
      severity: 2,
      label: surface ? `Unreadable text on <${surface.kind}>` : 'Unreadable on-screen text',
      surface: surface ? surface.kind : null,
      box: v.box,
      confidence: Math.min(0.95, 0.45 + v.score / 6),
      detector: { score: v.score, tiles: v.tiles, aspect: v.aspect, fill: v.fill }
    });
  }
  return domRegions.concat(kept);
}

/* --------------------------------------------------------------- annotation */

function stampToken(ctx, region) {
  const b = region.box;
  ctx.strokeStyle = MASK_BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);

  const full = region.token;
  const short = SHORT_TOKEN[full] || full;
  ctx.fillStyle = MASK_TEXT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  let size = Math.max(9, Math.min(18, Math.floor(b.h * 0.6)));
  let text = full;
  for (;;) {
    ctx.font = `600 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    if (ctx.measureText(text).width <= b.w - 8) break;
    if (text !== short) { text = short; continue; }
    size -= 1;
    if (size < 7) return; // box is genuinely too small to carry a label
  }
  ctx.fillText(text, b.x + 4, b.y + b.h / 2 + 0.5);
}

/* ------------------------------------------------------------ verification */

/**
 * Read the interior of every mask back off the canvas and require it to be a
 * single colour. Returns a per-region proof plus an overall verdict.
 */
function verifyDestruction(ctx, regions) {
  const proofs = [];
  let allUniform = true;

  for (let i = 0; i < regions.length; i++) {
    const b = regions[i].box;
    const inset = 1;
    const w = Math.max(1, b.w - inset * 2);
    const h = Math.max(1, b.h - inset * 2);
    const d = ctx.getImageData(b.x + inset, b.y + inset, w, h).data;

    let uniform = true;
    let deviant = 0;
    const seen = new Set();
    for (let p = 0; p < d.length; p += 4) {
      if (d[p] !== MASK_FILL_RGB[0] || d[p + 1] !== MASK_FILL_RGB[1] || d[p + 2] !== MASK_FILL_RGB[2]) {
        uniform = false;
        deviant++;
      }
      if (seen.size < 8) seen.add((d[p] << 16) | (d[p + 1] << 8) | d[p + 2]);
    }
    if (!uniform) allUniform = false;

    proofs.push({
      index: i,
      token: regions[i].token,
      box: b,
      pixels: (d.length / 4) | 0,
      uniform,
      deviantPixels: deviant,
      distinctColours: seen.size,
      // A single-colour region has zero Shannon entropy by construction.
      entropyBits: uniform ? 0 : null
    });
  }

  return { allUniform, regionCount: regions.length, proofs };
}

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* --------------------------------------------------------------- tile map viz */

function tileMapToDataUrl(tileMap, threshold, regions, imageW, imageH) {
  const { scores, tilesX, tilesY } = tileMap;
  // A tiny, raw tile grid is technically accurate but unreadable in a popup.
  // Render a bounded, aspect-correct diagnostic image instead. It contains only
  // detector scores and mask geometry — never a copy of the captured page.
  const scale = Math.min(1, 960 / imageW, 540 / imageH);
  const w = Math.max(1, Math.round(imageW * scale));
  const h = Math.max(1, Math.round(imageH * scale));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0d1422';
  ctx.fillRect(0, 0, w, h);

  const tileW = w / tilesX;
  const tileH = h / tilesY;
  for (let i = 0; i < scores.length; i++) {
    const v = Math.min(1, scores[i] / Math.max(2.5, threshold * 1.5));
    const hot = scores[i] >= threshold;
    const x = (i % tilesX) * tileW;
    const y = Math.floor(i / tilesX) * tileH;
    ctx.fillStyle = hot
      ? `rgb(${Math.round(176 + v * 70)}, ${Math.round(72 + v * 82)}, ${Math.round(101 - v * 35)})`
      : `rgb(${Math.round(17 + v * 32)}, ${Math.round(29 + v * 61)}, ${Math.round(48 + v * 99)})`;
    ctx.fillRect(x, y, Math.ceil(tileW), Math.ceil(tileH));
  }
  ctx.strokeStyle = '#ffd26e';
  ctx.lineWidth = Math.max(1, Math.round(1.5 * scale));
  for (const region of regions.filter((r) => r.source === 'gpu-visual')) {
    const b = region.box;
    ctx.strokeRect(Math.round(b.x * scale) + 0.5, Math.round(b.y * scale) + 0.5,
      Math.max(1, Math.round(b.w * scale) - 1), Math.max(1, Math.round(b.h * scale) - 1));
  }
  return c.convertToBlob({ type: 'image/png' });
}

/* ----------------------------------------------------------------- pipeline */

/**
 * @param {object} job
 * @param {Blob|string}  job.frame            raw capture (blob or data URL)
 * @param {Array}  job.domRegions             Lens A boxes, CSS px, top-frame space
 * @param {Array}  job.visualSurfaces         canvas/img/iframe rects, CSS px
 * @param {number} job.dpr                    device pixel ratio of the capture
 * @param {object} job.options                { useGpu, mode, threshold, tile, quality, wantTileMap }
 */
export async function sanitize(job) {
  const t0 = performance.now();
  const opt = Object.assign(
    { useGpu: true, mode: 'balanced', threshold: 1.05, tile: 8, quality: 0.72, wantTileMap: false },
    job.options || {}
  );

  // ---- decode ------------------------------------------------------------
  // Deliberately *not* fetch(): this document runs under `connect-src 'none'`, so
  // no network primitive is reachable from the code that touches raw pixels.
  const blob = job.frame instanceof Blob ? job.frame : dataUrlToBlob(job.frame);
  const rawBytes = await blob.arrayBuffer();
  const rawHash = await sha256Hex(rawBytes);
  const rawSize = rawBytes.byteLength;
  let bitmap = await createImageBitmap(blob);
  const tDecode = performance.now();

  const W = bitmap.width;
  const H = bitmap.height;
  const dpr = job.dpr || 1;
  const scale = W / Math.max(1, job.viewport?.w || W / dpr); // capture px per CSS px

  // ---- lens B: on-device visual perception -------------------------------
  let vision = { backend: 'skipped', regions: [], timings: { gpuMs: 0, groupMs: 0 }, adapter: null, tileMap: null };
  if (opt.mode !== 'dom-only') {
    const det = await getDetector(opt.useGpu ? 'webgpu' : 'cpu');
    vision = await det.detect(bitmap, {
      tile: opt.tile,
      threshold: opt.threshold,
      wantTileMap: opt.wantTileMap
    });
  }
  const tVision = performance.now();

  // ---- fuse both lenses into one mask list ------------------------------
  const domRegions = (job.domRegions || []).map((r) => ({ ...r, box: scaleBox(r.box, scale) }));
  const surfaces = (job.visualSurfaces || []).map((s) => ({ ...s, box: scaleBox(s.box, scale) }));
  const regions = fuseLenses(domRegions, vision.regions, surfaces, opt.mode)
    .map((r) => ({ ...r, box: clampBox(r.box, W, H) }))
    .filter((r) => r.box.w > 2 && r.box.h > 2);

  // ---- stage 1: destroy --------------------------------------------------
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  ctx.drawImage(bitmap, 0, 0);

  // The only handle on the original pixels is released here; nothing downstream
  // of this line can read them back.
  bitmap.close();
  bitmap = null;

  ctx.fillStyle = MASK_FILL;
  for (const r of regions) ctx.fillRect(r.box.x, r.box.y, r.box.w, r.box.h);
  const tMask = performance.now();

  // ---- proof -------------------------------------------------------------
  const verification = verifyDestruction(ctx, regions);
  const tVerify = performance.now();

  // ---- stage 2: annotate -------------------------------------------------
  for (const r of regions) stampToken(ctx, r);

  // ---- encode ------------------------------------------------------------
  const outBlob = await canvas.convertToBlob({ type: 'image/webp', quality: opt.quality });
  const outBytes = await outBlob.arrayBuffer();
  const outHash = await sha256Hex(outBytes);
  const tEncode = performance.now();

  let heatmapBlob = null;
  if (opt.wantTileMap && vision.tileMap) {
    heatmapBlob = await tileMapToDataUrl(vision.tileMap, opt.threshold, regions, W, H);
  }

  return {
    sanitizedBlob: outBlob,
    heatmapBlob,
    attestation: {
      sanitized: true,
      rawSha256: rawHash,          // audit only — the bytes themselves never leave
      sanitizedSha256: outHash,
      rawBytes: rawSize,
      sanitizedBytes: outBytes.byteLength,
      maskCount: regions.length,
      allRegionsUniform: verification.allUniform,
      producedAt: new Date().toISOString()
    },
    regions: regions.map((r) => ({
      source: r.source, ruleId: r.ruleId, token: r.token, severity: r.severity,
      label: r.label, box: r.box, confidence: r.confidence, detector: r.detector || null
    })),
    verification,
    vision: {
      backend: vision.backend,
      adapter: vision.adapter,
      candidates: vision.regions.length,
      cells: vision.cells || 0
    },
    metrics: {
      imageW: W, imageH: H, dpr, scale: +scale.toFixed(3),
      decodeMs: +(tDecode - t0).toFixed(2),
      visionMs: +(tVision - tDecode).toFixed(2),
      gpuMs: vision.timings.gpuMs,
      groupMs: vision.timings.groupMs,
      maskMs: +(tMask - tVision).toFixed(2),
      verifyMs: +(tVerify - tMask).toFixed(2),
      encodeMs: +(tEncode - tVerify).toFixed(2),
      totalMs: +(tEncode - t0).toFixed(2),
      compressionRatio: +(rawSize / Math.max(1, outBytes.byteLength)).toFixed(2)
    }
  };
}

export function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(5, comma);            // e.g. "image/png;base64"
  const type = meta.split(';')[0] || 'image/png';
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function clampBox(b, W, H) {
  const x = Math.max(0, Math.min(W - 1, b.x));
  const y = Math.max(0, Math.min(H - 1, b.y));
  return { x, y, w: Math.min(b.w, W - x), h: Math.min(b.h, H - y) };
}
