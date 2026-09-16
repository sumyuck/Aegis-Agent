/**
 * Aegis-Agent :: Lens A — structural perception (content script, all_frames)
 *
 * Runs in every frame. Produces, for the *current* frame:
 *   - sensitiveRegions : boxes to destroy, each carrying a semantic token
 *   - actionMap        : interactive elements the planner may target (PII-scrubbed labels)
 *   - visualSurfaces   : canvas/img/video/iframe rects, i.e. where Lens B must look
 *
 * Cross-origin frames cannot read their own position on the top-level viewport, so
 * the parent frame pushes each child its absolute offset over postMessage; the child
 * adds it to every rect it reports and forwards the (accumulated) offset downward.
 */
(function () {
  'use strict';
  if (window.__aegisPerceptionLoaded) return;
  window.__aegisPerceptionLoaded = true;

  const P = self.AegisPatterns;
  const CHANNEL = 'AEGIS_FRAME_CTX_v1';
  const MAX_TEXT_NODES = 6000;
  const MAX_ELEMENTS = 4000;

  let refSeq = 0;
  const refTable = new Map(); // refId -> Element (per-frame, rebuilt each scan)
  // Region of the top-level viewport this frame is actually allowed to report in.
  let frameClip = { x: 0, y: 0, w: 1e6, h: 1e6 };

  // --------------------------------------------------------------- utilities
  const isTop = window.top === window;

  function visible(el) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    return true;
  }

  function onScreen(r) {
    return r.width > 1 && r.height > 1 &&
      r.bottom > 0 && r.right > 0 &&
      r.top < window.innerHeight && r.left < window.innerWidth;
  }

  function box(r, offset, pad) {
    const p = pad || 0;
    return clip({
      x: Math.round(r.left + offset.x - p),
      y: Math.round(r.top + offset.y - p),
      w: Math.round(r.width + p * 2),
      h: Math.round(r.height + p * 2)
    });
  }

  /**
   * Clamp a top-frame box to this frame's visible window.
   *
   * Without this, a frame whose content overflows (or that is scrolled inside a
   * smaller element) reports boxes that stick out past the iframe, and we would
   * paint masks over unrelated parts of the parent page. Returns null when the
   * box falls entirely outside, so the caller drops it.
   */
  function clip(b) {
    const c = frameClip;
    const x = Math.max(b.x, c.x);
    const y = Math.max(b.y, c.y);
    const w = Math.min(b.x + b.w, c.x + c.w) - x;
    const h = Math.min(b.y + b.h, c.y + c.h) - y;
    if (w <= 1 || h <= 1) return null;
    return { x: Math.max(0, x), y: Math.max(0, y), w: Math.round(w), h: Math.round(h) };
  }

  function intersectRect(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y };
  }

  /** Strip any PII out of a label before it can travel to the planner. */
  function scrub(s) {
    if (!s) return '';
    let out = String(s).replace(/\s+/g, ' ').trim().slice(0, 120);
    const hits = P.scanText(out).sort((a, b) => b.index - a.index);
    for (const h of hits) {
      out = out.slice(0, h.index) + h.token + out.slice(h.index + h.length);
    }
    return out;
  }

  /** Depth-first walk that descends into open shadow roots. */
  function* walkElements(root) {
    const stack = [root];
    let n = 0;
    while (stack.length && n < MAX_ELEMENTS) {
      const node = stack.pop();
      if (!node) continue;
      if (node.nodeType === 1) {
        n++;
        yield node;
        if (node.shadowRoot) stack.push(node.shadowRoot);
      }
      const kids = node.children;
      if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }

  // ------------------------------------------------- lens A.1: form controls
  function scanFields(offset, out) {
    for (const el of walkElements(document.documentElement)) {
      const tag = el.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' &&
          !el.hasAttribute('data-aegis-sensitive') && !el.isContentEditable) continue;
      const rule = P.classifyField(el);
      if (!rule) continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (!onScreen(r)) continue;
      const b = box(r, offset, 2);
      if (!b) continue;
      out.push({
        source: 'dom-field',
        ruleId: rule.id,
        token: rule.token,
        severity: rule.severity,
        label: rule.label,
        tag: tag.toLowerCase(),
        box: b,
        confidence: 1.0
      });
    }
  }

  // ------------------------------------------- lens A.2: rendered text nodes
  function scanTextNodes(offset, out) {
    const walker = document.createTreeWalker(document.body || document.documentElement,
      NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (!n.nodeValue || n.nodeValue.trim().length < 6) return NodeFilter.FILTER_REJECT;
          const p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          const t = p.tagName;
          if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });

    let count = 0;
    let node;
    while ((node = walker.nextNode()) && count < MAX_TEXT_NODES) {
      count++;
      const hits = P.scanText(node.nodeValue);
      if (!hits.length) continue;
      if (!visible(node.parentElement)) continue;

      for (const h of hits) {
        // Range gives us a tight box around just the matched substring.
        const range = document.createRange();
        try {
          range.setStart(node, h.index);
          range.setEnd(node, h.index + h.length);
        } catch (_) { continue; }
        for (const r of range.getClientRects()) {
          if (!onScreen(r)) continue;
          const b = box(r, offset, 2);
          if (!b) continue;
          out.push({
            source: 'dom-text',
            ruleId: h.ruleId,
            token: h.token,
            severity: h.severity,
            label: h.label,
            tag: (node.parentElement.tagName || '').toLowerCase(),
            box: b,
            confidence: 0.95
          });
        }
        range.detach && range.detach();
      }
    }
    return count;
  }

  // ------------------------------------------- lens A.3: action map + canvas
  const INTERACTIVE = 'a,button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[onclick],[contenteditable=true]';

  function scanActionMap(offset, frameId) {
    const items = [];
    for (const el of walkElements(document.documentElement)) {
      if (!el.matches || !el.matches(INTERACTIVE)) continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (!onScreen(r)) continue;
      if (el.disabled) continue;
      const b = box(r, offset, 0);
      if (!b) continue;

      const refId = `f${frameId}:${++refSeq}`;
      refTable.set(refId, el);
      const rule = P.classifyField(el);
      const raw = el.getAttribute('aria-label') || el.placeholder ||
        (el.tagName === 'INPUT' || el.tagName === 'SELECT' ? (el.name || el.id) : el.innerText) ||
        el.value || el.title || '';

      items.push({
        ref: refId,
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        type: el.type || null,
        // A severity-3 field never contributes a free-text label.
        label: rule && rule.severity >= 3 ? rule.token : scrub(raw),
        sensitive: !!rule,
        box: b
      });
      if (items.length >= 250) break;
    }
    return items;
  }

  function scanVisualSurfaces(offset) {
    const out = [];
    for (const el of walkElements(document.documentElement)) {
      const t = el.tagName;
      if (t !== 'CANVAS' && t !== 'IMG' && t !== 'VIDEO' && t !== 'SVG' &&
          t !== 'IFRAME' && t !== 'EMBED' && t !== 'OBJECT') continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (!onScreen(r)) continue;
      const b = box(r, offset, 0);
      if (!b) continue;
      out.push({ kind: t.toLowerCase(), box: b });
      if (out.length >= 80) break;
    }
    return out;
  }

  // ------------------------------------------------- child frame propagation
  function propagate(scanId, offset, depth) {
    if (depth > 6) return 0;
    let sent = 0;
    for (const el of walkElements(document.documentElement)) {
      if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') continue;
      const r = el.getBoundingClientRect();
      if (!onScreen(r)) continue;
      let win = null;
      try { win = el.contentWindow; } catch (_) { /* cross-origin: still postMessage-able */ }
      if (!win) continue;
      // Border/padding shift the child's viewport origin inside the element box.
      let bx = 0, by = 0;
      try {
        const cs = getComputedStyle(el);
        bx = parseFloat(cs.borderLeftWidth) || 0;
        by = parseFloat(cs.borderTopWidth) || 0;
      } catch (_) { /* ignore */ }
      try {
        // The child may only report inside its own element box, further narrowed
        // by whatever clip this frame itself is under.
        const childClip = intersectRect(frameClip, {
          x: offset.x + r.left + bx,
          y: offset.y + r.top + by,
          w: r.width - bx * 2,
          h: r.height - by * 2
        });
        if (childClip.w <= 1 || childClip.h <= 1) continue;
        win.postMessage({
          channel: CHANNEL,
          scanId,
          offset: { x: offset.x + r.left + bx, y: offset.y + r.top + by },
          clip: childClip,
          depth: depth + 1
        }, '*');
        sent++;
      } catch (_) { /* ignore */ }
    }
    return sent;
  }

  // ---------------------------------------------------------------- the scan
  function runScan(scanId, offset, depth, frameId, clipRect) {
    const t0 = performance.now();
    refSeq = 0;
    refTable.clear();
    frameClip = clipRect || { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };

    const childFrames = propagate(scanId, offset, depth);

    const sensitive = [];
    scanFields(offset, sensitive);
    const textNodes = scanTextNodes(offset, sensitive);
    const actionMap = scanActionMap(offset, frameId);
    const visualSurfaces = scanVisualSurfaces(offset);

    const payload = {
      type: 'AEGIS_SCAN_RESULT',
      scanId,
      frame: {
        depth,
        isTop: isTop,
        offset,
        clip: frameClip,
        url: location.origin + location.pathname,
        childFrames
      },
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        scrollY: window.scrollY,
        title: isTop ? scrub(document.title) : undefined
      },
      sensitiveRegions: dedupe(sensitive),
      actionMap,
      visualSurfaces,
      stats: { textNodes, domScanMs: +(performance.now() - t0).toFixed(2) }
    };

    chrome.runtime.sendMessage(payload).catch(() => {});
  }

  /** Merge boxes that overlap >70% and keep the highest severity token. */
  function dedupe(list) {
    const keep = [];
    for (const item of list) {
      let merged = false;
      for (const k of keep) {
        const ix = Math.max(0, Math.min(item.box.x + item.box.w, k.box.x + k.box.w) - Math.max(item.box.x, k.box.x));
        const iy = Math.max(0, Math.min(item.box.y + item.box.h, k.box.y + k.box.h) - Math.max(item.box.y, k.box.y));
        const inter = ix * iy;
        const minArea = Math.min(item.box.w * item.box.h, k.box.w * k.box.h) || 1;
        if (inter / minArea > 0.7) {
          if (item.severity > k.severity) { k.token = item.token; k.severity = item.severity; k.label = item.label; k.ruleId = item.ruleId; }
          k.box = {
            x: Math.min(k.box.x, item.box.x),
            y: Math.min(k.box.y, item.box.y),
            w: Math.max(k.box.x + k.box.w, item.box.x + item.box.w) - Math.min(k.box.x, item.box.x),
            h: Math.max(k.box.y + k.box.h, item.box.y + item.box.h) - Math.min(k.box.y, item.box.y)
          };
          merged = true;
          break;
        }
      }
      if (!merged) keep.push(item);
    }
    return keep;
  }

  // ------------------------------------------------------------- entry points
  // Top frame is kicked off by the service worker.
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg && msg.type === 'AEGIS_SCAN' && isTop) {
      runScan(msg.scanId, { x: 0, y: 0 }, 0, msg.frameId ?? 0,
        { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
      respond({ ok: true, started: true });
      return true;
    }
    if (msg && msg.type === 'AEGIS_RESOLVE_REF') {
      respond({ ok: refTable.has(msg.ref) });
      return true;
    }
    return false;
  });

  // Child frames are kicked off by their parent.
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.channel !== CHANNEL || isTop) return;
    // Trust only our real parent chain for the offset.
    if (ev.source !== window.parent) return;
    runScan(d.scanId, d.offset, d.depth,
      d.depth * 1000 + Math.floor(Math.random() * 999), d.clip);
  }, false);

  window.__aegisRefTable = refTable; // consumed by actuator.js
})();
