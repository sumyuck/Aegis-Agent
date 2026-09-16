/**
 * Aegis-Agent :: orchestrator + egress firewall (MV3 service worker)
 *
 * Owns the agent loop:
 *   scan (all frames) -> capture -> sanitise in the enclave -> egress firewall ->
 *   remote plan -> local dispatch -> repeat
 *
 * This is the only realm in the extension that can reach the network, and
 * `transmit()` below is the only function in it that does. Everything on the wire
 * must arrive with an enclave attestation, or it does not go out.
 */

importScripts('/lib/pii-patterns.js');
const P = self.AegisPatterns;

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const SCAN_TIMEOUT_MS = 400;

const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:8077',
  useGpu: true,
  mode: 'balanced',        // 'dom-only' | 'balanced' | 'paranoid'
  threshold: 1.05,
  tile: 8,
  quality: 0.72,
  strictCapture: false,    // true => tabCapture, worker never holds raw pixels
  maxSteps: 8,
  wantTileMap: true
};

const state = {
  running: false,
  abort: false,
  tabId: null,
  step: 0,
  trace: [],
  lastFrame: null
};

/* ------------------------------------------------------------------ settings */

async function settings(overrides) {
  const stored = await chrome.storage.local.get('aegisSettings');
  return { ...DEFAULTS, ...(stored.aegisSettings || {}), ...(overrides || {}) };
}

async function saveSettings(patch) {
  const cur = await settings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ aegisSettings: next });
  return next;
}

/* ----------------------------------------------------------------- offscreen */

let offscreenReady = null;

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const has = await chrome.offscreen.hasDocument?.();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS', 'USER_MEDIA'],
        justification:
          'Runs WebGPU screen perception and irreversible PII redaction on raw frames in a network-isolated document.'
      });
    }
    return true;
  })();
  return offscreenReady;
}

function askEnclave(msg) {
  return chrome.runtime.sendMessage({ target: 'aegis-offscreen', ...msg });
}

/* ------------------------------------------------- lens A: multi-frame scan */

const pendingScans = new Map();

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'AEGIS_SCAN_RESULT') {
    const entry = pendingScans.get(msg.scanId);
    if (!entry) return;
    entry.results.push({ ...msg, frameId: sender.frameId ?? null });
    entry.expected += msg.frame.childFrames;
    if (entry.results.length >= entry.expected) entry.finish();
  }
});

async function scanAllFrames(tabId) {
  const scanId = `s${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const t0 = performance.now();

  const collected = await new Promise((resolve) => {
    const entry = {
      results: [],
      expected: 1,
      finish: () => {
        clearTimeout(entry.timer);
        pendingScans.delete(scanId);
        resolve(entry.results);
      }
    };
    entry.timer = setTimeout(entry.finish, SCAN_TIMEOUT_MS);
    pendingScans.set(scanId, entry);

    chrome.tabs.sendMessage(tabId, { type: 'AEGIS_SCAN', scanId, frameId: 0 }, { frameId: 0 })
      .catch((e) => {
        entry.finish();
        console.warn('[aegis] top-frame scan failed:', e.message);
      });
  });

  const top = collected.find((r) => r.frame.isTop) || collected[0];
  if (!top) throw new Error('No frame responded. Reload the page so the content script attaches.');

  const sensitiveRegions = [];
  const visualSurfaces = [];
  const actionMap = [];
  const frames = [];
  for (const r of collected) {
    sensitiveRegions.push(...r.sensitiveRegions);
    visualSurfaces.push(...r.visualSurfaces);
    actionMap.push(...r.actionMap);
    frames.push({ url: r.frame.url, depth: r.frame.depth, offset: r.frame.offset, regions: r.sensitiveRegions.length });
  }

  return {
    viewport: top.viewport,
    sensitiveRegions,
    visualSurfaces,
    actionMap,
    frames,
    stats: {
      framesResponded: collected.length,
      domScanMs: +(performance.now() - t0).toFixed(2),
      textNodes: collected.reduce((a, r) => a + r.stats.textNodes, 0)
    }
  };
}

/* -------------------------------------------------------------- capture step */

async function captureFrame(tabId, cfg) {
  const tab = await chrome.tabs.get(tabId);
  if (cfg.strictCapture) {
    // Worker receives an opaque stream id, never image bytes.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    return { streamId };
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return { frame: dataUrl };
}

/* --------------------------------------------------------- egress firewall */

/**
 * Last line of defence before anything touches the network. Independent of the
 * enclave: it re-derives its verdict from the envelope itself, so a bug in the
 * perception stage still cannot leak a government identifier through metadata.
 */
function egressFirewall(envelope) {
  const violations = [];
  const att = envelope.attestation;

  if (!att || att.sanitized !== true) violations.push('MISSING_ATTESTATION');
  if (att && att.allRegionsUniform !== true) violations.push('REDACTION_NOT_VERIFIED');
  if (typeof envelope.image !== 'string' || !envelope.image.startsWith('data:image/webp;base64,')) {
    violations.push('IMAGE_NOT_ENCLAVE_ENCODED');
  }
  if (att && envelope.image && !att.sanitizedSha256) violations.push('IMAGE_UNHASHED');

  // Any *textual* field on the envelope is re-scanned for PII.
  const textOnly = { ...envelope };
  delete textOnly.image;
  const blob = JSON.stringify(textOnly);
  const hits = P.scanText(blob).filter((h) => h.severity >= 2);
  for (const h of hits) violations.push(`PII_IN_METADATA:${h.ruleId}`);

  return { allowed: violations.length === 0, violations, scannedChars: blob.length };
}

/* ------------------------------------------------------------- transmission */

async function transmit(cfg, envelope) {
  const verdict = egressFirewall(envelope);
  if (!verdict.allowed) {
    const err = new Error(`Egress blocked: ${verdict.violations.join(', ')}`);
    err.firewall = verdict;
    throw err;
  }
  const t0 = performance.now();
  const res = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}/v1/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Aegis-Attestation': envelope.attestation.sanitizedSha256 },
    body: JSON.stringify(envelope)
  });
  const networkMs = +(performance.now() - t0).toFixed(2);
  if (!res.ok) throw new Error(`Planner ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const plan = await res.json();
  return { plan, networkMs, firewall: verdict };
}

/* ------------------------------------------------------------- action relay */

async function dispatch(tabId, action) {
  // Broadcast: only the frame that owns the ref (or the top frame, for coordinate
  // actions) answers. Everything else declines and stays silent.
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'AEGIS_ACT', action });
    if (r) return r;
  } catch (_) { /* fall through */ }
  return { ok: false, code: 'NO_FRAME_HANDLED_ACTION', action };
}

/* ------------------------------------------------------------------- events */

function emit(event) {
  chrome.runtime.sendMessage({ type: 'AEGIS_EVENT', event }).catch(() => {});
}

async function pushTrace(entry) {
  state.trace.push(entry);
  if (state.trace.length > 24) state.trace.shift();
  // chrome.storage.session lives in memory only — the trace never hits disk.
  try {
    await chrome.storage.session.set({
      aegisTrace: state.trace.map((t, i) => (i >= state.trace.length - 3 ? t : { ...t, sanitizedDataUrl: null, heatmapDataUrl: null }))
    });
  } catch (_) { /* quota */ }
}

/* -------------------------------------------------------------- perceive one */

/** scan + capture + sanitise. No network. Used by both the loop and Dry Run. */
async function perceive(tabId, cfg) {
  await ensureOffscreen();
  const [scan, cap] = await Promise.all([
    scanAllFrames(tabId),
    captureFrame(tabId, cfg)
  ]);

  const job = {
    ...cap,
    domRegions: scan.sensitiveRegions,
    visualSurfaces: scan.visualSurfaces,
    viewport: scan.viewport,
    dpr: scan.viewport.dpr,
    options: {
      useGpu: cfg.useGpu,
      mode: cfg.mode,
      threshold: cfg.threshold,
      tile: cfg.tile,
      quality: cfg.quality,
      wantTileMap: cfg.wantTileMap
    }
  };

  const enclave = await askEnclave({ type: 'AEGIS_SANITIZE', job });
  // Drop our only reference to the raw frame the moment the enclave is done.
  job.frame = null;
  cap.frame = null;

  if (!enclave || !enclave.ok) throw new Error(`Enclave failed: ${enclave && enclave.error}`);
  return { scan, enclave };
}

function buildEnvelope(goal, step, cfg, scan, enclave, history) {
  return {
    protocol: 'aegis/1',
    goal,
    step,
    maxSteps: cfg.maxSteps,
    image: enclave.sanitizedDataUrl,
    viewport: { w: scan.viewport.w, h: scan.viewport.h, dpr: scan.viewport.dpr },
    pageTitle: scan.viewport.title || '',
    // Masked regions travel as *tokens*, never values: the planner learns that a
    // password field sits at (x,y,w,h) without learning anything inside it.
    semanticTokens: enclave.regions.map((r) => ({
      token: r.token, label: r.label, severity: r.severity, source: r.source, box: r.box
    })),
    actionMap: scan.actionMap,
    history: history.slice(-6),
    attestation: enclave.attestation
  };
}

/* ----------------------------------------------------------------- the loop */

async function runAgent(goal, overrides) {
  const cfg = await settings(overrides);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');
  if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
    throw new Error('Browser-internal pages block content scripts. Open the demo page or any http(s) site.');
  }

  state.running = true;
  state.abort = false;
  state.tabId = tab.id;
  state.step = 0;
  state.trace = [];
  chrome.action.setBadgeBackgroundColor({ color: '#2f6fed' });

  const history = [];
  let finalReason = 'step budget exhausted';

  try {
    for (let step = 1; step <= cfg.maxSteps; step++) {
      if (state.abort) { finalReason = 'stopped by user'; break; }
      state.step = step;
      chrome.action.setBadgeText({ text: String(step) });
      emit({ kind: 'step-start', step });

      const t0 = performance.now();
      const { scan, enclave } = await perceive(tab.id, cfg);
      emit({ kind: 'perceived', step, metrics: enclave.metrics, vision: enclave.vision, masks: enclave.regions.length });

      const envelope = buildEnvelope(goal, step, cfg, scan, enclave, history);
      const { plan, networkMs, firewall } = await transmit(cfg, envelope);
      const action = plan.action || { op: 'noop' };

      let result = { ok: true, op: 'noop', skipped: true };
      if (!plan.done && action.op !== 'noop') {
        result = await dispatch(tab.id, action);
      }

      const entry = {
        step,
        goal,
        action,
        result,
        rationale: plan.rationale || '',
        confidence: plan.confidence ?? null,
        done: !!plan.done,
        planner: plan.planner || 'unknown',
        masks: enclave.regions,
        verification: enclave.verification,
        vision: enclave.vision,
        captureMode: enclave.captureMode,
        attestation: enclave.attestation,
        firewall,
        sanitizedDataUrl: enclave.sanitizedDataUrl,
        heatmapDataUrl: enclave.heatmapDataUrl,
        frames: scan.frames,
        metrics: {
          ...enclave.metrics,
          domScanMs: scan.stats.domScanMs,
          networkMs,
          roundtripMs: +(performance.now() - t0).toFixed(2)
        },
        stats: scan.stats,
        at: new Date().toISOString()
      };
      await pushTrace(entry);
      emit({ kind: 'step-done', step, entry: { ...entry, sanitizedDataUrl: undefined, heatmapDataUrl: undefined } });

      history.push({ step, action, ok: !!result.ok, code: result.code || null });

      if (plan.done) { finalReason = plan.rationale || 'planner reported goal complete'; break; }
      if (result.blocked) { finalReason = `policy block: ${result.code}`; break; }
      await new Promise((r) => setTimeout(r, 150)); // let the page settle
    }
  } finally {
    state.running = false;
    chrome.action.setBadgeText({ text: '' });
    emit({ kind: 'run-end', reason: finalReason, steps: state.step });
  }
  return { steps: state.step, reason: finalReason };
}

/** Sanitise once and show the result — no server, no network, at all. */
async function dryRun(overrides) {
  const cfg = await settings(overrides);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');
  if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
    throw new Error('Browser-internal pages block content scripts. Open the demo page or any http(s) site.');
  }
  const { scan, enclave } = await perceive(tab.id, cfg);
  const envelope = buildEnvelope('(dry run — nothing transmitted)', 0, cfg, scan, enclave, []);
  const firewall = egressFirewall(envelope);
  const entry = {
    step: 0,
    dryRun: true,
    masks: enclave.regions,
    verification: enclave.verification,
    vision: enclave.vision,
    captureMode: enclave.captureMode,
    attestation: enclave.attestation,
    firewall,
    sanitizedDataUrl: enclave.sanitizedDataUrl,
    heatmapDataUrl: enclave.heatmapDataUrl,
    frames: scan.frames,
    envelopePreview: { ...envelope, image: `<${enclave.attestation.sanitizedBytes} bytes webp, sha256 ${enclave.attestation.sanitizedSha256.slice(0, 16)}…>` },
    metrics: { ...enclave.metrics, domScanMs: scan.stats.domScanMs, networkMs: 0 },
    stats: scan.stats,
    at: new Date().toISOString()
  };
  state.trace = [entry];
  await pushTrace(entry);
  return entry;
}

/* --------------------------------------------------------------- popup RPC */

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || !msg.type || msg.target === 'aegis-offscreen') return false;

  const handlers = {
    AEGIS_STATUS: async () => {
      await ensureOffscreen();
      const cfg = await settings();
      let gpu = { ok: false };
      try { gpu = await askEnclave({ type: 'AEGIS_GPU_INFO', useGpu: cfg.useGpu }); } catch (_) {}
      return { running: state.running, step: state.step, settings: cfg, gpu };
    },
    AEGIS_SAVE_SETTINGS: async () => ({ settings: await saveSettings(msg.patch || {}) }),
    AEGIS_DRYRUN: async () => ({ entry: await dryRun(msg.overrides) }),
    AEGIS_RUN: async () => {
      if (state.running) throw new Error('A run is already in progress');
      return await runAgent(msg.goal || 'Describe what is on screen', msg.overrides);
    },
    AEGIS_STOP: async () => { state.abort = true; return { stopping: true }; },
    AEGIS_GET_TRACE: async () => ({ trace: state.trace }),
    AEGIS_PING_SERVER: async () => {
      const cfg = await settings(msg.overrides);
      const res = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}/v1/health`);
      return await res.json();
    }
  };

  const h = handlers[msg.type];
  if (!h) return false;
  h().then((data) => respond({ ok: true, ...data }))
    .catch((e) => respond({ ok: false, error: String(e.message || e), firewall: e.firewall || null }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#2f6fed' });
  console.log('[aegis] installed — enclave will initialise on first use');
});
