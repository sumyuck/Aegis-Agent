/**
 * Aegis-Agent :: PII pattern registry (Lens A — structural/textual)
 *
 * Every entry yields a semantic token that replaces the redacted pixels, so the
 * remote VLM keeps the *shape* of the page while losing the *value*.
 * Checksum validators (Verhoeff / Luhn) keep false positives low — a black box
 * over the wrong element silently breaks the agent's grounding.
 */
(function (root) {
  'use strict';

  // ---- checksum validators -------------------------------------------------
  const VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
  ];
  const VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
  ];

  function verhoeff(digits) {
    let c = 0;
    const rev = digits.split('').reverse();
    for (let i = 0; i < rev.length; i++) {
      c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(rev[i])]];
    }
    return c === 0;
  }

  function luhn(digits) {
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = Number(digits[i]);
      if (alt) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  // ---- textual patterns ----------------------------------------------------
  // severity: 3 = credential/secret, 2 = government or financial ID, 1 = contact
  const TEXT_RULES = [
    {
      id: 'aadhaar',
      token: '[MASK_AADHAAR]',
      severity: 2,
      label: 'Aadhaar number',
      re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g,
      validate: (m) => verhoeff(m.replace(/\D/g, ''))
    },
    {
      id: 'pan',
      token: '[MASK_PAN]',
      severity: 2,
      label: 'PAN card',
      re: /\b[A-Z]{5}\d{4}[A-Z]\b/g
    },
    {
      id: 'card',
      token: '[MASK_CARD]',
      severity: 3,
      label: 'Payment card',
      re: /\b(?:\d[ -]?){13,19}\b/g,
      validate: (m) => {
        const d = m.replace(/\D/g, '');
        return d.length >= 13 && d.length <= 19 && luhn(d);
      }
    },
    {
      id: 'ifsc',
      token: '[MASK_BANK]',
      severity: 2,
      label: 'IFSC code',
      re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g
    },
    {
      id: 'gstin',
      token: '[MASK_GSTIN]',
      severity: 2,
      label: 'GSTIN',
      re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/g
    },
    {
      id: 'passport',
      token: '[MASK_PASSPORT]',
      severity: 2,
      label: 'Passport number',
      re: /\b[A-PR-WY][1-9]\d{6}\b/g
    },
    {
      id: 'email',
      token: '[MASK_EMAIL]',
      severity: 1,
      label: 'Email address',
      re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
    },
    {
      id: 'phone_in',
      token: '[MASK_PHONE]',
      severity: 1,
      label: 'Phone number',
      re: /(?:\+91[ -]?)?\b[6-9]\d{9}\b/g
    },
    {
      id: 'upi',
      token: '[MASK_UPI]',
      severity: 2,
      label: 'UPI handle',
      re: /\b[a-zA-Z0-9.\-_]{2,}@(?:oksbi|okhdfcbank|okicici|okaxis|ybl|paytm|upi|apl|ibl)\b/g
    },
    {
      id: 'jwt',
      token: '[MASK_TOKEN]',
      severity: 3,
      label: 'Session token / JWT',
      re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
    },
    {
      id: 'apikey',
      token: '[MASK_SECRET]',
      severity: 3,
      label: 'API key / secret',
      re: /\b(?:sk|pk|api|key|tok|ghp|AKIA)[-_A-Za-z0-9]{16,}\b/g
    },
    {
      id: 'geo',
      token: '[MASK_COORD]',
      severity: 3,
      label: 'Geospatial coordinate',
      // e.g. "13.7199 N, 80.2304 E" — mission/telemetry dashboards
      re: /\b\d{1,3}\.\d{3,6}\s*[°]?\s*[NSns]\s*[,/]?\s*\d{1,3}\.\d{3,6}\s*[°]?\s*[EWew]\b/g
    },
    {
      id: 'dob',
      token: '[MASK_DOB]',
      severity: 1,
      label: 'Date of birth',
      re: /\b(?:0?[1-9]|[12]\d|3[01])[/-](?:0?[1-9]|1[0-2])[/-](?:19|20)\d{2}\b/g
    }
  ];

  // ---- DOM attribute heuristics (no text read required) --------------------
  const FIELD_RULES = [
    { id: 'password', token: '[MASK_PASSWORD]', severity: 3, label: 'Password field',
      match: (el) => el.type === 'password' },
    { id: 'otp', token: '[MASK_OTP]', severity: 3, label: 'One-time code',
      match: (el) => /one-?time|\botp\b/i.test(hint(el)) },
    { id: 'cc_field', token: '[MASK_CARD]', severity: 3, label: 'Card number field',
      match: (el) => /cc-number|card-?number|cardnum/i.test(hint(el)) },
    { id: 'cvc_field', token: '[MASK_CVC]', severity: 3, label: 'Card security code',
      match: (el) => /cc-csc|\bcvv\b|\bcvc\b|security-?code/i.test(hint(el)) },
    { id: 'aadhaar_field', token: '[MASK_AADHAAR]', severity: 2, label: 'Aadhaar field',
      match: (el) => /aadhaar|aadhar|uidai/i.test(hint(el)) },
    { id: 'ssn_field', token: '[MASK_GOVID]', severity: 2, label: 'Government ID field',
      match: (el) => /\bssn\b|national-?id|gov-?id|pan-?(no|number)/i.test(hint(el)) },
    { id: 'email_field', token: '[MASK_EMAIL]', severity: 1, label: 'Email field',
      match: (el) => el.type === 'email' || /\bemail\b/i.test(hint(el)) },
    { id: 'tel_field', token: '[MASK_PHONE]', severity: 1, label: 'Phone field',
      match: (el) => el.type === 'tel' || /\b(phone|mobile|tel)\b/i.test(hint(el)) },
    { id: 'opt_out', token: '[MASK_PII]', severity: 3, label: 'Site-declared sensitive region',
      match: (el) => el.hasAttribute && (el.hasAttribute('data-aegis-sensitive') ||
                                         el.hasAttribute('data-sensitive')) }
  ];

  function hint(el) {
    if (!el || !el.getAttribute) return '';
    return [
      el.getAttribute('autocomplete'),
      el.getAttribute('name'),
      el.id,
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder'),
      el.getAttribute('data-testid'),
      el.className && typeof el.className === 'string' ? el.className : ''
    ].filter(Boolean).join(' ');
  }

  /** Scan a string; returns [{ruleId, token, severity, label, index, length, text}] */
  function scanText(text) {
    const hits = [];
    if (!text || text.length > 20000) return hits;
    for (const rule of TEXT_RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(text)) !== null) {
        if (rule.validate && !rule.validate(m[0])) continue;
        hits.push({
          ruleId: rule.id,
          token: rule.token,
          severity: rule.severity,
          label: rule.label,
          index: m.index,
          length: m[0].length,
          text: m[0]
        });
        if (m[0].length === 0) rule.re.lastIndex++;
      }
    }
    return hits;
  }

  /** Classify an element by attributes alone. Returns rule or null. */
  function classifyField(el) {
    for (const rule of FIELD_RULES) {
      try {
        if (rule.match(el)) return rule;
      } catch (_) { /* detached node */ }
    }
    return null;
  }

  root.AegisPatterns = {
    TEXT_RULES, FIELD_RULES, scanText, classifyField, hint, verhoeff, luhn
  };
})(typeof self !== 'undefined' ? self : globalThis);
