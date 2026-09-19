/** Aegis-Agent operator console — concise evidence first, forensic detail on demand. */
'use strict';

const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);
const LENS_ORDER = ['dom-field', 'dom-text', 'gpu-visual'];
const LENS_SHORT = { 'dom-field': 'A · fields', 'dom-text': 'A · text', 'gpu-visual': 'B · visual' };
const SETTING_IDS = ['serverUrl', 'mode', 'useGpu', 'strictCapture', 'wantTileMap', 'threshold', 'tile', 'quality', 'maxSteps'];
let current = null;

function log(text, cls) {
  const line = document.createElement('div');
  line.className = cls ? `l-${cls}` : '';
  line.textContent = text;
  $('log').appendChild(line);
  $('log').scrollTop = $('log').scrollHeight;
}

function setVerdict(id, kind, title, detail) {
  const el = $(id);
  el.className = `verdict ${kind}`;
  el.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = title;
  const span = document.createElement('span');
  span.textContent = detail;
  el.append(strong, span);
}

function metric(label, value, kind = '') {
  return `<div class="metric ${kind}"><div class="k">${label}</div><div class="v">${value}</div></div>`;
}

function renderMetrics(entry) {
  const masks = entry.masks || [];
  const verified = entry.verification && entry.verification.allUniform;
  const egress = entry.dryRun ? 'local only' : entry.firewall?.allowed ? 'verified' : 'blocked';
  $('metrics').innerHTML = [
    metric('Protected', `${masks.length} masks`, 'hi'),
    metric('Pixel proof', verified ? '0 bits' : 'blocked', verified ? 'ok' : ''),
    metric('Egress', egress, egress === 'verified' || egress === 'local only' ? 'ok' : '')
  ].join('');
}

function renderTimings(entry) {
  const m = entry.metrics || {};
  const pairs = [
    ['DOM scan', m.domScanMs], ['Visual lens', m.gpuMs], ['Grouping', m.groupMs],
    ['Mask + proof', (Number(m.maskMs || 0) + Number(m.verifyMs || 0)).toFixed(1)],
    ['Encode', m.encodeMs], ['End to end', m.roundtripMs ?? m.totalMs]
  ];
  $('timings').innerHTML = pairs.map(([label, value]) =>
    `<div class="timing"><span>${label}</span> ${value ?? '—'} ms</div>`).join('');
}

function renderVerdict(entry) {
  const verification = entry.verification;
  if (!verification) {
    setVerdict('verdict', 'idle', 'No verification data', 'Run a new protection scan.');
    return;
  }
  const count = verification.proofs?.length || 0;
  if (verification.allUniform) {
    const lens = entry.vision?.backend === 'skipped' ? 'DOM protection' : `Lens B: ${entry.vision?.backend || 'ready'}`;
    setVerdict('verdict', 'ok', 'Safe preview verified', `${count} regions overwritten locally · ${lens}`);
  } else {
    const failed = verification.proofs?.filter((proof) => !proof.uniform).length || 0;
    setVerdict('verdict', 'bad', 'Preview blocked', `${failed} region(s) failed verification; egress remains closed.`);
  }
}

function renderMasks(regions) {
  const list = regions || [];
  $('maskCount').textContent = list.length;
  const counts = list.reduce((out, region) => {
    out[region.source] = (out[region.source] || 0) + 1;
    return out;
  }, {});
  $('maskSummary').textContent = list.length
    ? `${list.length} protected regions · ${LENS_ORDER.filter((source) => counts[source]).map((source) => `${counts[source]} ${LENS_SHORT[source]}`).join(' · ')}`
    : 'No protection scan yet.';

  const proofs = current?.verification?.proofs || [];
  const tbody = $('maskTable').querySelector('tbody');
  tbody.replaceChildren();
  for (let i = 0; i < list.length; i++) {
    const region = list[i];
    const proof = proofs[i];
    const tr = document.createElement('tr');
    if (region.severity >= 3) tr.className = 'sev3';
    const proofText = !proof ? '—' : proof.uniform ? '✓ 0 bits' : `✗ ${proof.deviantPixels}`;
    const token = document.createElement('td');
    token.className = 'tok';
    token.title = `${region.label} at ${region.box.x},${region.box.y}`;
    token.textContent = region.token;
    const lensCell = document.createElement('td');
    const lens = document.createElement('span');
    lens.className = `lens${region.source === 'gpu-visual' ? ' lensGpu' : ''}`;
    lens.textContent = LENS_SHORT[region.source] || region.source;
    lensCell.appendChild(lens);
    const proofCell = document.createElement('td');
    proofCell.className = proof?.uniform ? 'ok' : proof ? 'bad' : '';
    proofCell.textContent = proofText;
    tr.append(token, lensCell, proofCell);
    tbody.appendChild(tr);
  }
}

function renderWire(entry) {
  const fw = entry.firewall;
  if (!fw) setVerdict('fwVerdict', 'idle', 'Egress firewall idle', 'Nothing has been sent to a planner.');
  else if (fw.allowed) setVerdict('fwVerdict', 'ok', 'Egress allowed', `${fw.scannedChars} metadata characters re-scanned · no PII found`);
  else setVerdict('fwVerdict', 'bad', 'Egress blocked', (fw.violations || []).join(' · ') || 'Policy check failed');
  if (entry.envelopePreview) $('wire').textContent = JSON.stringify(entry.envelopePreview, null, 2);
}

function selectedView() {
  return document.querySelector('.seg.active')?.dataset.view || 'sanitized';
}

function showView(view) {
  const isHeat = view === 'heatmap';
  if (isHeat && !current?.heatmapDataUrl) {
    $('shot').hidden = true;
    $('heat').hidden = true;
    $('heatLegend').hidden = true;
    $('stageEmpty').hidden = false;
    $('stageEmpty').textContent = 'Lens B map is unavailable. Enable it in Settings and scan again.';
    log('Lens B map is unavailable. Enable it in Settings and scan again.', 'dim');
    return;
  }
  $('shot').hidden = isHeat;
  $('heat').hidden = !isHeat;
  $('heatLegend').hidden = !isHeat;
  if (current?.sanitizedDataUrl) $('stageEmpty').hidden = true;
}

function renderEntry(entry) {
  current = entry;
  if (entry.sanitizedDataUrl) {
    $('shot').src = entry.sanitizedDataUrl;
    $('stageEmpty').hidden = true;
  }
  if (entry.heatmapDataUrl) $('heat').src = entry.heatmapDataUrl;
  const m = entry.metrics || {};
  $('previewMeta').textContent = m.imageW ? `${m.imageW}×${m.imageH} · ${(entry.masks || []).length} masks` : 'Latest frame';
  renderVerdict(entry);
  renderMetrics(entry);
  renderTimings(entry);
  renderMasks(entry.masks);
  renderWire(entry);
  showView(selectedView());
}

async function dryRun() {
  $('dryRun').disabled = true;
  log('Scanning locally — no planner request.', 'dim');
  try {
    const result = await send({ type: 'AEGIS_DRYRUN', overrides: readSettings() });
    if (!result.ok) throw new Error(result.error);
    renderEntry(result.entry);
    log(`Protected ${result.entry.masks.length} regions in ${result.entry.metrics.totalMs} ms.`, 'ok');
  } catch (error) {
    log(`Scan failed: ${error.message}`, 'bad');
  } finally {
    $('dryRun').disabled = false;
  }
}

async function run() {
  const goal = $('goal').value.trim();
  if (!goal) { log('Enter a mission first.', 'bad'); return; }
  $('run').disabled = true; $('dryRun').disabled = true; $('stop').disabled = false;
  log(`Running: ${goal}`, 'dim');
  try {
    const result = await send({ type: 'AEGIS_RUN', goal, overrides: readSettings() });
    if (!result.ok) throw new Error(result.error + (result.firewall ? ` (${result.firewall.violations.join(', ')})` : ''));
    log(`Mission complete after ${result.steps} step(s): ${result.reason}`, 'ok');
  } catch (error) {
    log(`Mission stopped: ${error.message}`, 'bad');
  } finally {
    $('run').disabled = false; $('dryRun').disabled = false; $('stop').disabled = true;
    const trace = await send({ type: 'AEGIS_GET_TRACE' });
    if (trace.ok && trace.trace.length) renderEntry(trace.trace[trace.trace.length - 1]);
  }
}

function readSettings() {
  return {
    serverUrl: $('serverUrl').value.trim(), mode: $('mode').value, useGpu: $('useGpu').checked,
    strictCapture: $('strictCapture').checked, wantTileMap: $('wantTileMap').checked,
    threshold: parseFloat($('threshold').value), tile: parseInt($('tile').value, 10),
    quality: parseFloat($('quality').value), maxSteps: parseInt($('maxSteps').value, 10)
  };
}

function applySettings(settings) {
  for (const id of SETTING_IDS) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = !!settings[id];
    else el.value = settings[id];
  }
  $('thrVal').textContent = Number(settings.threshold).toFixed(2);
}

async function persist() {
  const patch = readSettings();
  $('thrVal').textContent = patch.threshold.toFixed(2);
  await send({ type: 'AEGIS_SAVE_SETTINGS', patch });
  $('saveNote').textContent = `Saved ${new Date().toLocaleTimeString()}`;
}

const isExpanded = new URLSearchParams(location.search).has('expanded');
if (isExpanded) {
  document.body.classList.add('expanded');
  $('popOut').hidden = true;
} else {
  $('popOut').addEventListener('click', () => {
    chrome.windows.create({ url: chrome.runtime.getURL('popup/popup.html?expanded=1'), type: 'popup', width: 1080, height: 780 });
    window.close();
  });
}

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((node) => node.classList.toggle('active', node === tab));
  document.querySelectorAll('.panel').forEach((node) => node.classList.toggle('active', node.id === `panel-${tab.dataset.tab}`));
}));
document.querySelectorAll('.seg').forEach((segment) => segment.addEventListener('click', () => {
  document.querySelectorAll('.seg').forEach((node) => node.classList.toggle('active', node === segment));
  showView(segment.dataset.view);
}));
document.querySelectorAll('[data-goal]').forEach((button) => button.addEventListener('click', () => {
  $('goal').value = button.dataset.goal;
  $('goal').focus();
}));
$('dryRun').addEventListener('click', dryRun);
$('run').addEventListener('click', run);
$('stop').addEventListener('click', () => send({ type: 'AEGIS_STOP' }));
$('goal').addEventListener('keydown', (event) => { if (event.key === 'Enter') run(); });
$('ping').addEventListener('click', async () => {
  const result = await send({ type: 'AEGIS_PING_SERVER', overrides: readSettings() });
  $('srvBadge').className = `badge ${result.ok ? 'good' : 'bad'}`;
  $('srvBadge').textContent = result.ok ? `planner · ${result.planner || 'ready'}` : 'planner offline';
  log(result.ok ? 'Planner policy endpoint is ready.' : `Planner unavailable: ${result.error}`, result.ok ? 'ok' : 'bad');
});
SETTING_IDS.forEach((id) => $(id).addEventListener('change', persist));
$('threshold').addEventListener('input', () => { $('thrVal').textContent = parseFloat($('threshold').value).toFixed(2); });

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target === 'aegis-offscreen' || message.type !== 'AEGIS_EVENT') return;
  const event = message.event;
  if (event.kind === 'step-start') log(`Step ${event.step}: protecting current frame.`, 'dim');
  if (event.kind === 'perceived') log(`Frame protected · ${event.masks} masks · ${event.metrics.totalMs} ms.`, 'dim');
  if (event.kind === 'step-done') {
    const action = event.entry.action || {};
    log(`Action: ${action.op}${action.ref ? ` ${action.ref}` : ''}`, 'act');
    log(event.entry.result?.ok ? 'Action completed.' : `Action failed: ${event.entry.result?.code || 'unknown'}`, event.entry.result?.ok ? 'ok' : 'bad');
    renderEntry({ ...event.entry, sanitizedDataUrl: null, heatmapDataUrl: null });
  }
  if (event.kind === 'run-end') log(`Run ended: ${event.reason}`, 'ok');
});

(async () => {
  const status = await send({ type: 'AEGIS_STATUS' });
  if (!status?.ok) { log('Service worker did not answer — reload the extension.', 'bad'); return; }
  applySettings(status.settings);
  const gpu = status.gpu || {};
  $('gpuBadge').className = `badge ${gpu.ok ? 'good' : 'bad'}`;
  $('gpuBadge').textContent = gpu.ok ? (gpu.backend === 'webgpu' ? 'WebGPU ready' : 'CPU fallback') : 'perception offline';
  send({ type: 'AEGIS_PING_SERVER', overrides: readSettings() }).then((result) => {
    $('srvBadge').className = `badge ${result.ok ? 'good' : 'bad'}`;
    $('srvBadge').textContent = result.ok ? `planner · ${result.planner || 'ready'}` : 'planner offline';
  });
  const trace = await send({ type: 'AEGIS_GET_TRACE' });
  if (trace.ok && trace.trace.length) renderEntry(trace.trace[trace.trace.length - 1]);
  else log('Ready. Scan the demo page to create a safe preview.', 'dim');
})();
