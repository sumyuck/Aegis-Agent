/**
 * Aegis-Agent :: local action dispatcher (content script, all_frames)
 *
 * The planner never touches the page. It returns structured JSON; this module is
 * the only thing that can move the mouse or keyboard, and it enforces one hard
 * invariant: **no text is ever typed into a severity-3 field** (password, OTP,
 * CVC, card number). A remote model therefore cannot inject or harvest a
 * credential even if it is fully compromised.
 */
(function () {
  'use strict';
  if (window.__aegisActuatorLoaded) return;
  window.__aegisActuatorLoaded = true;

  const P = self.AegisPatterns;
  const isTop = window.top === window;
  const FWD = 'AEGIS_ACT_FWD_v1';

  function refTable() { return window.__aegisRefTable || new Map(); }

  function centre(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function fireMouse(el, x, y) {
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
    el.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseover', base));
    el.dispatchEvent(new MouseEvent('mousemove', base));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true, button: 0 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, button: 0, buttons: 1 }));
    if (el.focus) try { el.focus({ preventScroll: true }); } catch (_) {}
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true, button: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, button: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...base, button: 0, detail: 1 }));
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
  }

  function describe(el) {
    return {
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()
    };
  }

  // ----------------------------------------------------------------- handlers
  function doClick(el, point) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const c = point || centre(el);
    fireMouse(el, c.x, c.y);
    if (el.tagName === 'INPUT' || el.tagName === 'BUTTON' || el.tagName === 'A') {
      // Some frameworks only bind the activation behaviour.
      try { el.click(); } catch (_) {}
    }
    return { ok: true, op: 'click', target: describe(el) };
  }

  function doType(el, text) {
    const rule = P.classifyField(el);
    if (rule && rule.severity >= 3) {
      return {
        ok: false,
        op: 'type',
        blocked: true,
        code: 'BLOCKED_CREDENTIAL_FIELD',
        reason: `Aegis policy: the remote planner may not write to a ${rule.label.toLowerCase()}.`,
        target: describe(el)
      };
    }
    if (P.scanText(String(text)).some((h) => h.severity >= 2)) {
      return {
        ok: false,
        op: 'type',
        blocked: true,
        code: 'BLOCKED_PII_PAYLOAD',
        reason: 'Aegis policy: planner-supplied text matched a government/financial identifier.',
        target: describe(el)
      };
    }
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    try { el.focus({ preventScroll: true }); } catch (_) {}
    if (el.isContentEditable) {
      el.textContent = String(text);
    } else {
      setNativeValue(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      setNativeValue(el, String(text));
    }
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, op: 'type', chars: String(text).length, target: describe(el) };
  }

  function doPress(el, key) {
    const target = el || document.activeElement || document.body;
    const init = { key, code: key, bubbles: true, cancelable: true, composed: true };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    if (key === 'Enter' && target.form && typeof target.form.requestSubmit === 'function') {
      // Mirrors the browser's implicit-submission behaviour.
      target.form.requestSubmit();
    }
    return { ok: true, op: 'press', key };
  }

  /** Resolve a top-frame viewport point to a local element, descending frames. */
  function resolvePoint(pt) {
    const el = document.elementFromPoint(pt.x, pt.y);
    if (!el) return { kind: 'miss' };
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      const r = el.getBoundingClientRect();
      return { kind: 'frame', win: el.contentWindow, local: { x: pt.x - r.left, y: pt.y - r.top } };
    }
    return { kind: 'el', el };
  }

  function execute(action) {
    const table = refTable();

    if (action.ref) {
      const el = table.get(action.ref);
      if (!el || !el.isConnected) return null; // not ours — another frame owns it
      switch (action.op) {
        case 'click': return doClick(el, null);
        case 'type': return doType(el, action.text ?? '');
        case 'press': return doPress(el, action.key || 'Enter');
        case 'select':
          setNativeValue(el, action.value);
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, op: 'select', target: describe(el) };
        default: return { ok: false, code: 'UNKNOWN_OP', op: action.op };
      }
    }

    if (action.op === 'scroll') {
      window.scrollBy({ top: action.dy ?? 400, behavior: 'instant' });
      return { ok: true, op: 'scroll', dy: action.dy ?? 400, scrollY: window.scrollY };
    }

    if (action.op === 'press' && !action.ref) return doPress(null, action.key || 'Enter');

    if (action.point) {
      const hit = resolvePoint(action.point);
      if (hit.kind === 'miss') return { ok: false, code: 'NO_ELEMENT_AT_POINT', point: action.point };
      if (hit.kind === 'frame') {
        try {
          hit.win.postMessage({ channel: FWD, action: { ...action, point: hit.local } }, '*');
        } catch (_) {}
        return { ok: true, op: action.op, forwardedToFrame: true };
      }
      if (action.op === 'click') return doClick(hit.el, action.point);
      if (action.op === 'type') return doType(hit.el, action.text ?? '');
    }

    return null;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!msg || msg.type !== 'AEGIS_ACT') return false;
    // Coordinate-addressed actions are owned by the top frame, which forwards down.
    if (!msg.action.ref && !isTop) return false;
    let result = null;
    try { result = execute(msg.action); } catch (e) { result = { ok: false, code: 'DISPATCH_ERROR', error: String(e) }; }
    if (result === null) return false; // stay silent so the owning frame can answer
    respond(result);
    return true;
  });

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.channel !== FWD || ev.source !== window.parent) return;
    try { execute(d.action); } catch (_) {}
  }, false);
})();
