/**
 * Lens A's pattern registry, checked from Node. Checksum validators are the whole
 * reason the false-positive rate is low enough to mask automatically, so they are
 * tested in both directions.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

globalThis.self = globalThis;
new Function(readFileSync(new URL('../extension/lib/pii-patterns.js', import.meta.url), 'utf8'))();
const P = globalThis.AegisPatterns;

test('Verhoeff accepts valid Aadhaar and rejects a transposition', () => {
  assert.equal(P.verhoeff('352741839170'), true);
  assert.equal(P.verhoeff('352741839171'), false);
  assert.equal(P.verhoeff('352741839107'), false); // last two digits swapped
});

test('Luhn accepts a valid card and rejects a mutated one', () => {
  assert.equal(P.luhn('4111111111111111'), true);
  assert.equal(P.luhn('4111111111111112'), false);
});

test('checksum-failing candidates are not reported', () => {
  const hits = P.scanText('reference 1234 5678 9012 is an order number');
  assert.equal(hits.filter((h) => h.ruleId === 'aadhaar').length, 0);
});

test('each planted secret class is detected exactly once', () => {
  const text = [
    'Aadhaar 3527 4183 9170', 'PAN BQXPV4417K', 'card 4111 1111 1111 1111',
    'mail a.verma@ops.example.in', 'phone +91 9845512207', 'dob 14/03/1994',
    'passport M4471829', 'upi averma.ops@okhdfcbank', 'ifsc HDFC0001742',
    'pad 13.7199 N, 80.2304 E',
    'tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcHMtNDIifQ.q7Zx1KpLm9AeVv3TdRb8Nw'
  ].join(' | ');
  const found = new Set(P.scanText(text).map((h) => h.ruleId));
  for (const rule of ['aadhaar', 'pan', 'card', 'email', 'phone_in', 'dob',
                      'passport', 'upi', 'ifsc', 'geo', 'jwt']) {
    assert.ok(found.has(rule), `missed ${rule}`);
  }
});

test('severity-3 rules cover every credential field type', () => {
  const sev3 = P.FIELD_RULES.filter((r) => r.severity >= 3).map((r) => r.id);
  for (const id of ['password', 'otp', 'cc_field', 'cvc_field']) {
    assert.ok(sev3.includes(id), `${id} must be severity 3`);
  }
});

test('field classification reads attributes, never values', () => {
  const fake = (attrs) => ({
    type: attrs.type || 'text',
    id: attrs.id || '',
    className: '',
    hasAttribute: (k) => k in attrs,
    getAttribute: (k) => attrs[k] ?? null
  });
  assert.equal(P.classifyField(fake({ type: 'password' })).token, '[MASK_PASSWORD]');
  assert.equal(P.classifyField(fake({ autocomplete: 'one-time-code' })).token, '[MASK_OTP]');
  assert.equal(P.classifyField(fake({ autocomplete: 'cc-csc' })).token, '[MASK_CVC]');
  assert.equal(P.classifyField(fake({ name: 'aadhaarNumber' })).token, '[MASK_AADHAAR]');
  assert.equal(P.classifyField(fake({ 'data-aegis-sensitive': '' })).token, '[MASK_PII]');
  assert.equal(P.classifyField(fake({ name: 'city' })), null);
});
