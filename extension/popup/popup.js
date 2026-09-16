/** Aegis-Agent :: popup — operator console and evidence viewer. */
'use strict';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const LENS_ORDER = ['dom-field', 'dom-text', 'gpu-visual'];
const LENS_LABEL = {
  'dom-field': 'Lens A · field attributes',
  'dom-text': 'Lens A · rendered text',
  'gpu-visual': 'Lens B · WebGPU pixels'
};
const LENS_SHORT = { 'dom-field': 'A·field', 'dom-text': 'A·text', 'gpu-visual': 'B·gpu' };

const SETTING_IDS = ['serverUrl', 'mode', 'useGpu', 'strictCapture', 'wantTileMap', 'threshold', 'tile', 'quality', 'maxSteps'];
let current = null;

/* ------------------------------------------------------------------ logging */

function log(text, cls) {
  const line = document.createElement('div');
  line.className = cls ? `l-${cls}` : '';
  line.textContent = text;
  $('log').appendChild(line);
  $('log').scrollTop = $('log').scrollHeight;
}

/* ---------------------------------------------------------------- rendering */

function metric(k, v, hi) {
  return `<div class="metric${hi ? ' hi' : ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
}

function renderMetrics(m) {
  if (!m) { $('metrics').innerHTML = ''; return; }
  $('metrics').innerHTML = [
    metric('DOM lens', `${m.domScanMs ?? '—'} ms`),
    metric('GPU pass', `${m.gpuMs ?? '—'} ms`, true),
    metric('Group', `${m.groupMs ?? '—'} ms`),
    metric('Mask', `${m.maskMs ?? '—'} ms`),
    metric('Verify', `${m.verifyMs ?? '—'} ms`),
    metric('Encode', `${m.encodeMs ?? '—'} ms`),
    metric('Network', `${m.networkMs ?? 0} ms`),
    metric('Round trip', `${m.roundtripMs ?? m.totalMs} ms`, true),
    metric('Frame', `${m.imageW}×${m.imageH}`),
    metric('DPR', `${m.dpr}`),
    metric('Wire size', `${(m.sanitizedBytes ?? 0) ? Math.round(m.sanitizedBytes / 1024) + ' KB' : '—'}`),
    metric('Compression', `${m.compressionRatio ?? '—'}×`)
  ].join('');
}

function renderVerdict(entry) {
  const v = entry.verification;
  const el = $('verdict');
  if (!v) { el.className = 'verdict idle'; el.textContent = 'No verification data.'; return; }
  const total = v.proofs.length;
  if (v.allUniform) {
    el.className = 'verdict ok';
    const px = v.proofs.reduce((a, p) => a + p.pixels, 0);
    el.textContent =
      `✓ ${total}/${total} redacted regions verified pixel-uniform · ${px.toLocaleString()} px destroyed · 0 bits recoverable\n` +
      `  capture: ${entry.captureMode} · lens B: ${entry.vision.backend}${entry.vision.adapter ? ' (' + (entry.vision.adapter.vendor || '?') + ')' : ''} · sha256 ${entry.attestation.sanitizedSha256.slice(0, 24)}…`;
  } else {
    const bad = v.proofs.filter((p) => !p.uniform).length;
    el.className = 'verdict bad';
    el.textContent = `✗ ${bad}/${total} regions failed the uniformity proof — egress will be refused.`;
  }
}

function renderMasks(regions) {
  $('maskCount').textContent = regions ? regions.length : 0;
  const tb = $('maskTable').querySelector('tbody');
  tb.innerHTML = '';
  if (!regions || !regions.length) {
    $('maskSummary').textContent = 'Nothing redacted in the last frame.';
    return;
  }
  // Summarise in a fixed order with distinct labels. Both DOM sources used to
  // render as "Lens A (DOM)", which read as a duplicated row rather than as the
  // two different detection paths they actually are.
  const counts = regions.reduce((a, r) => { a[r.source] = (a[r.source] || 0) + 1; return a; }, {});
  $('maskSummary').innerHTML = LENS_ORDER
    .filter((k) => counts[k])
    .map((k) => `<b>${counts[k]}</b> ${LENS_LABEL[k]}`)
    .join(' &nbsp;·&nbsp; ');

  const proofs = (current && current.verification && current.verification.proofs) || [];
  regions.forEach((r, i) => {
    const tr = document.createElement('tr');
    if (r.severity >= 3) tr.className = 'sev3';
    const p = proofs[i];
    const proof = !p ? '—'
      : p.uniform ? `<span class="ok" title="${p.pixels} px overwritten, ${p.distinctColours} distinct colour">✓ 0 bits</span>`
      : `<span class="bad" title="${p.deviantPixels} pixels differ from the mask fill">✗ ${p.deviantPixels}</span>`;
    tr.innerHTML =
      `<td class="tok">${r.token}</td>` +
      `<td><span class="lens${r.source === 'gpu-visual' ? ' lensGpu' : ''}">${LENS_SHORT[r.source] || r.source}</span></td>` +
      `<td>${r.label}</td>` +
      `<td class="box">${r.box.w}×${r.box.h}<span class="at">@${r.box.x},${r.box.y}</span></td>` +
      `<td>${proof}</td>`;
    tb.appendChild(tr);
  });
}

function renderWire(entry) {
  const fw = entry.firewall;
  const el = $('fwVerdict');
  if (!fw) { el.className = 'verdict idle'; el.textContent = 'Egress firewall has not run.'; }
  else if (fw.allowed) {
    el.className = 'verdict ok';
    el.textContent = `✓ egress permitted — attestation present, redaction verified, ${fw.scannedChars} chars of metadata re-scanned, 0 PII hits`;
  } else {
    el.className = 'verdict bad';
    el.textContent = `✗ egress BLOCKED — ${fw.violations.join(', ')}`;
  }
  if (entry.envelopePreview) {
    $('wire').textContent = JSON.stringify(entry.envelopePreview, null, 2);
  }
}

function renderEntry(entry) {
  current = entry;
  if (entry.sanitizedDataUrl) {
    $('shot').src = entry.sanitizedDataUrl;
    $('stageEmpty').hidden = true;
  }
  if (entry.heatmapDataUrl) $('heat').src = entry.heatmapDataUrl;
  renderVerdict(entry);
  renderMetrics({ ...entry.metrics, sanitizedBytes: entry.attestation && entry.attestation.sanitizedBytes });
  renderMasks(entry.masks);
  renderWire(entry);
}

/* ------------------------------------------------------------------ actions */

async function dryRun() {
  $('dryRun').disabled = true;
  log('— perceive & redact (no network) —', 'dim');
  try {
    const r = await send({ type: 'AEGIS_DRYRUN', overrides: readSettings() });
    if (!r.ok) throw new Error(r.error);
    renderEntry(r.entry);
    const gpu = r.entry.vision;
    log(`lens A: ${r.entry.stats.framesResponded} frame(s), ${r.entry.stats.textNodes} text nodes, ${r.entry.metrics.domScanMs} ms`, 'dim');
    log(`lens B: ${gpu.backend}, ${gpu.cells} tiles, ${gpu.candidates} candidates, ${r.entry.metrics.gpuMs} ms`, 'dim');
    log(`redacted ${r.entry.masks.length} region(s); total ${r.entry.metrics.totalMs} ms`, 'ok');
  } catch (e) {
    log(`error: ${e.message}`, 'bad');
  } finally {
    $('dryRun').disabled = false;
  }
}

async function run() {
  const goal = $('goal').value.trim();
  if (!goal) { log('enter a goal first', 'bad'); return; }
  $('run').disabled = true; $('dryRun').disabled = true; $('stop').disabled = false;
  log(`— run: "${goal}" —`, 'dim');
  try {
    const r = await send({ type: 'AEGIS_RUN', goal, overrides: readSettings() });
    if (!r.ok) throw new Error(r.error + (r.firewall ? ` [${r.firewall.violations.join(',')}]` : ''));
    log(`run ended after ${r.steps} step(s): ${r.reason}`, 'ok');
  } catch (e) {
    log(`error: ${e.message}`, 'bad');
  } finally {
    $('run').disabled = false; $('dryRun').disabled = false; $('stop').disabled = true;
    const t = await send({ type: 'AEGIS_GET_TRACE' });
    if (t.ok && t.trace.length) renderEntry(t.trace[t.trace.length - 1]);
  }
}

/* ----------------------------------------------------------------- settings */

function readSettings() {
  return {
    serverUrl: $('serverUrl').value.trim(),
    mode: $('mode').value,
    useGpu: $('useGpu').checked,
    strictCapture: $('strictCapture').checked,
    wantTileMap: $('wantTileMap').checked,
    threshold: parseFloat($('threshold').value),
    tile: parseInt($('tile').value, 10),
    quality: parseFloat($('quality').value),
    maxSteps: parseInt($('maxSteps').value, 10)
  };
}

function applySettings(s) {
  $('serverUrl').value = s.serverUrl;
  $('mode').value = s.mode;
  $('useGpu').checked = s.useGpu;
  $('strictCapture').checked = s.strictCapture;
  $('wantTileMap').checked = s.wantTileMap;
  $('threshold').value = s.threshold;
  $('tile').value = String(s.tile);
  $('quality').value = String(s.quality);
  $('maxSteps').value = s.maxSteps;
  $('thrVal').textContent = Number(s.threshold).toFixed(2);
}

async function persist() {
  const patch = readSettings();
  $('thrVal').textContent = patch.threshold.toFixed(2);
  await send({ type: 'AEGIS_SAVE_SETTINGS', patch });
  $('saveNote').textContent = `saved ${new Date().toLocaleTimeString()}`;
}

/* --------------------------------------------------------------------- init */

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${t.dataset.tab}`));
  });
});

document.querySelectorAll('.seg').forEach((s) => {
  s.addEventListener('click', () => {
    document.querySelectorAll('.seg').forEach((x) => x.classList.toggle('active', x === s));
    const heat = s.dataset.view === 'heatmap';
    $('shot').hidden = heat;
    $('heat').hidden = !heat;
    if (heat && !$('heat').src) log('enable "Produce GPU heatmap" in Settings, then re-run', 'dim');
  });
});

$('dryRun').addEventListener('click', dryRun);
$('run').addEventListener('click', run);
$('stop').addEventListener('click', () => send({ type: 'AEGIS_STOP' }));
$('ping').addEventListener('click', async () => {
  const r = await send({ type: 'AEGIS_PING_SERVER', overrides: readSettings() });
  if (r.ok) {
    $('srvBadge').className = 'badge good';
    $('srvBadge').textContent = `server ${r.planner || 'up'}`;
    log(`planner: ${r.planner} · model ${r.model || 'n/a'}`, 'ok');
  } else {
    $('srvBadge').className = 'badge bad';
    $('srvBadge').textContent = 'server down';
    log(`planner unreachable: ${r.error}`, 'bad');
  }
});
SETTING_IDS.forEach((id) => $(id).addEventListener('change', persist));
$('threshold').addEventListener('input', () => { $('thrVal').textContent = parseFloat($('threshold').value).toFixed(2); });
$('goal').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target === 'aegis-offscreen' || msg.type !== 'AEGIS_EVENT') return;
  const e = msg.event;
  if (e.kind === 'step-start') log(`step ${e.step} — perceiving`, 'dim');
  if (e.kind === 'perceived') log(`  masked ${e.masks} region(s) · gpu ${e.metrics.gpuMs} ms · total ${e.metrics.totalMs} ms`, 'dim');
  if (e.kind === 'step-done') {
    const a = e.entry.action;
    const desc = `${a.op}${a.ref ? ' ' + a.ref : ''}${a.point ? ` (${a.point.x},${a.point.y})` : ''}${a.text ? ` "${a.text}"` : ''}`;
    log(`  action: ${desc}`, 'act');
    if (e.entry.rationale) log(`  why: ${e.entry.rationale}`, 'dim');
    const r = e.entry.result;
    log(`  result: ${r.ok ? 'ok' : (r.code || 'failed')}${r.reason ? ' — ' + r.reason : ''}`, r.ok ? 'ok' : 'bad');
    renderEntry({ ...e.entry, sanitizedDataUrl: null });
  }
  if (e.kind === 'run-end') log(`run ended (${e.steps} steps): ${e.reason}`, 'ok');
});

(async () => {
  const st = await send({ type: 'AEGIS_STATUS' });
  if (!st || !st.ok) { log('service worker did not answer — reload the extension', 'bad'); return; }
  applySettings(st.settings);
  const g = st.gpu || {};
  if (g.ok && g.backend === 'webgpu') {
    $('gpuBadge').className = 'badge good';
    $('gpuBadge').textContent = `WebGPU · ${(g.adapter && (g.adapter.vendor || g.adapter.description)) || 'active'}`;
  } else if (g.ok) {
    $('gpuBadge').textContent = `CPU fallback${g.webgpuAvailable ? ' (by choice)' : ' (no WebGPU)'}`;
  } else {
    $('gpuBadge').className = 'badge bad';
    $('gpuBadge').textContent = 'perception offline';
  }
  send({ type: 'AEGIS_PING_SERVER', overrides: readSettings() }).then((r) => {
    $('srvBadge').className = `badge ${r.ok ? 'good' : 'bad'}`;
    $('srvBadge').textContent = r.ok ? `server ${r.planner}` : 'server down';
  });
  const t = await send({ type: 'AEGIS_GET_TRACE' });
  if (t.ok && t.trace.length) renderEntry(t.trace[t.trace.length - 1]);
  else log('ready. open the demo page and press "Perceive & Redact".', 'dim');
})();
