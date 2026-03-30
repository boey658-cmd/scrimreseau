/** Compteur mémoire process (mono-instance, non persistant). */

let unhandledRejectionTotal = 0;

/** @type {string | null} */
let lastUnhandledRejectionAtIso = null;

/** @type {string | null} */
let lastUnhandledRejectionPreview = null;

let uncaughtExceptionTotal = 0;

/** @type {string | null} */
let uncaughtExceptionLastAt = null;

/** @type {string | null} */
let uncaughtExceptionLastPreview = null;

const PREVIEW_MAX = 160;

/**
 * @param {unknown} reason
 * @returns {string}
 */
function formatPreview(reason) {
  try {
    if (reason instanceof Error) {
      const s = `${reason.name}: ${reason.message}`.trim();
      return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX - 1)}…` : s;
    }
    const s = String(reason);
    return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX - 1)}…` : s;
  } catch {
    return '(aperçu indisponible)';
  }
}

/**
 * @param {unknown} reason
 */
export function recordUnhandledRejection(reason) {
  unhandledRejectionTotal += 1;
  lastUnhandledRejectionAtIso = new Date().toISOString();
  lastUnhandledRejectionPreview = formatPreview(reason);
}

/**
 * @param {unknown} error
 */
export function recordUncaughtException(error) {
  uncaughtExceptionTotal += 1;
  uncaughtExceptionLastAt = new Date().toISOString();
  uncaughtExceptionLastPreview = formatPreview(error);
}

/**
 * @returns {{
 *   unhandledRejectionTotal: number,
 *   lastUnhandledRejectionAtIso: string | null,
 *   lastUnhandledRejectionPreview: string | null,
 *   uncaughtExceptionTotal: number,
 *   uncaughtExceptionLastAt: string | null,
 *   uncaughtExceptionLastPreview: string | null,
 * }}
 */
export function getProcessHealthSnapshot() {
  return {
    unhandledRejectionTotal,
    lastUnhandledRejectionAtIso,
    lastUnhandledRejectionPreview,
    uncaughtExceptionTotal,
    uncaughtExceptionLastAt,
    uncaughtExceptionLastPreview,
  };
}
