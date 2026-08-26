/** Cap max raisonnable pour SCRIM_LIFECYCLE_CONCURRENCY. */
export const SCRIM_LIFECYCLE_CONCURRENCY_MAX = 10;

/** Défaut production : faible pour ne pas saturer Discord. */
export const SCRIM_LIFECYCLE_CONCURRENCY_DEFAULT = 1;

/**
 * @param {string | undefined} raw
 * @returns {number}
 */
export function parseScrimLifecycleConcurrency(raw = process.env.SCRIM_LIFECYCLE_CONCURRENCY) {
  const n = Number(typeof raw === 'string' ? raw.trim() : raw);
  if (!Number.isFinite(n) || n <= 0) return SCRIM_LIFECYCLE_CONCURRENCY_DEFAULT;
  return Math.min(SCRIM_LIFECYCLE_CONCURRENCY_MAX, Math.floor(n));
}
