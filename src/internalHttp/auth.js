import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Extrait le bearer token sans logger la valeur.
 * @param {string | undefined} authorizationHeader
 * @returns {string | null}
 */
export function extractBearerToken(authorizationHeader) {
  if (!authorizationHeader || typeof authorizationHeader !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorizationHeader.trim());
  return match ? match[1] : null;
}

/**
 * Comparaison timing-safe via SHA-256 (longueurs arbitraires).
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
export function verifyInternalHttpToken(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') {
    return false;
  }
  if (!provided || !expected) {
    return false;
  }
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
