/**
 * Hash payload billing (audit sans données sensibles).
 */

import { createHash } from 'node:crypto';

/**
 * @param {unknown} payload
 * @returns {string}
 */
export function hashBillingPayload(payload) {
  const normalized = stableStringify(payload);
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const keys = Object.keys(/** @type {Record<string, unknown>} */ (value)).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(/** @type {any} */ (value)[k])}`).join(',')}}`;
}
