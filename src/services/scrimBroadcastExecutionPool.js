/**
 * Pool d’exécution global pour le pipeline de diffusion persistante.
 *
 * Limite process-wide (SCRIM_BROADCAST_CONCURRENCY) partagée entre :
 * - le dispatcher background
 * - le bootstrap `/find-scrim`
 * - le repost classique (1 slot autour du broadcast)
 *
 * Invariant : aucune delivery DB en `processing` sans slot réellement acquis.
 */

import { logger } from '../utils/logger.js';

const HARD_MAX = 20;
const DEFAULT_CONCURRENCY = 1;

export const BROADCAST_POOL_STOPPING = 'BROADCAST_POOL_STOPPING';

/** @type {number | null} */
let cachedLimit = null;

/** @type {number} */
let activeCount = 0;

/** @type {Set<number>} */
const inFlightDeliveryIds = new Set();

/**
 * @typedef {{ resolve: (token: BroadcastSlotToken) => void, reject: (err: Error) => void }} BroadcastSlotWaiter
 * @type {BroadcastSlotWaiter[]}
 */
const waiters = [];

/** @type {boolean} */
let acceptNewWork = true;

/** @type {boolean} */
let stopping = false;

/** @type {(() => void) | null} */
let onSlotFreed = null;

/**
 * @typedef {{
 *   bindDelivery: (deliveryId: number) => void,
 *   release: () => void,
 *   isReleased: () => boolean,
 * }} BroadcastSlotToken
 */

/**
 * @param {string | undefined} raw
 * @returns {number}
 */
export function parseBroadcastConcurrency(raw) {
  if (raw == null || String(raw).trim() === '') {
    return DEFAULT_CONCURRENCY;
  }
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || Number.isNaN(n)) {
    console.warn(
      `[scrimBroadcastExecutionPool] SCRIM_BROADCAST_CONCURRENCY invalide (${JSON.stringify(raw)}) → fallback ${DEFAULT_CONCURRENCY}`,
    );
    return DEFAULT_CONCURRENCY;
  }
  const floored = Math.floor(n);
  if (floored < 1) {
    console.warn(
      `[scrimBroadcastExecutionPool] SCRIM_BROADCAST_CONCURRENCY=${floored} < 1 → fallback ${DEFAULT_CONCURRENCY}`,
    );
    return DEFAULT_CONCURRENCY;
  }
  if (floored > HARD_MAX) {
    console.warn(
      `[scrimBroadcastExecutionPool] SCRIM_BROADCAST_CONCURRENCY=${floored} > ${HARD_MAX} → cap ${HARD_MAX}`,
    );
    return HARD_MAX;
  }
  return floored;
}

export function getConfiguredConcurrency() {
  if (cachedLimit == null) {
    cachedLimit = parseBroadcastConcurrency(process.env.SCRIM_BROADCAST_CONCURRENCY);
  }
  return cachedLimit;
}

export function invalidateBroadcastConcurrencyCache() {
  cachedLimit = null;
}

/**
 * @returns {{
 *   concurrencyLimit: number,
 *   activeCount: number,
 *   inFlight: number,
 *   inFlightIds: number[],
 *   waitingCount: number,
 *   stopping: boolean,
 *   acceptNewWork: boolean,
 *   queuedMemory: number,
 * }}
 */
export function getBroadcastPoolStats() {
  return {
    concurrencyLimit: getConfiguredConcurrency(),
    activeCount,
    inFlight: activeCount,
    inFlightIds: [...inFlightDeliveryIds],
    waitingCount: waiters.length,
    stopping,
    acceptNewWork,
    queuedMemory: waiters.length,
  };
}

/**
 * @param {number} deliveryId
 * @returns {boolean}
 */
export function isDeliveryInFlight(deliveryId) {
  return inFlightDeliveryIds.has(Number(deliveryId));
}

/**
 * @returns {ReadonlySet<number>}
 */
export function getInFlightDeliveryIds() {
  return inFlightDeliveryIds;
}

/**
 * @param {(() => void) | null} cb
 */
export function setBroadcastSlotFreedHandler(cb) {
  onSlotFreed = cb;
}

function stoppingError() {
  return Object.assign(new Error('broadcast pool stopping'), { code: BROADCAST_POOL_STOPPING });
}

function rejectAllWaiters(err) {
  const pending = waiters.splice(0, waiters.length);
  for (const w of pending) {
    try {
      w.reject(err);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Token pour un slot déjà comptabilisé dans activeCount.
 *
 * @param {{ notifyOnUnboundRelease?: boolean }} [opts]
 * - notifyOnUnboundRelease=false : réservation dispatcher (tryReserve) —
 *   release sans delivery ne doit PAS rappeler onSlotFreed (évite refill récursif).
 * - notifyOnUnboundRelease=true : slot générique (acquire / bootstrap / repost) —
 *   un vrai release doit réveiller le dispatcher même sans bindDelivery.
 * @returns {BroadcastSlotToken}
 */
function createSlotToken(opts = {}) {
  const notifyOnUnboundRelease = opts.notifyOnUnboundRelease === true;
  /** @type {number | null} */
  let boundId = null;
  let released = false;

  return {
    bindDelivery(deliveryId) {
      if (released) return;
      const id = Number(deliveryId);
      if (boundId != null && boundId !== id) {
        inFlightDeliveryIds.delete(boundId);
      }
      boundId = id;
      inFlightDeliveryIds.add(id);
    },
    release() {
      if (released) return;
      released = true;
      const hadDelivery = boundId != null;
      if (boundId != null) {
        inFlightDeliveryIds.delete(boundId);
        boundId = null;
      }

      // Transfert du slot au prochain waiter (activeCount inchangé) — pas de notify
      // (aucun slot réellement libre). Les waiters viennent d’acquire → génériques.
      if (waiters.length > 0 && acceptNewWork && !stopping) {
        const next = waiters.shift();
        next.resolve(createSlotToken({ notifyOnUnboundRelease: true }));
        return;
      }
      if (activeCount > 0) activeCount -= 1;
      if (waiters.length > 0 && (stopping || !acceptNewWork)) {
        rejectAllWaiters(stoppingError());
      }
      // Vrai release : notifier si delivery liée OU slot générique (repost/bootstrap).
      if (hadDelivery || notifyOnUnboundRelease) {
        try {
          onSlotFreed?.();
        } catch {
          /* ignore */
        }
      }
    },
    isReleased() {
      return released;
    },
  };
}

/**
 * Réserve un slot sans bloquer (dispatcher). Retourne un token ou null.
 * @returns {BroadcastSlotToken | null}
 */
export function tryReserveBroadcastSlot() {
  if (!acceptNewWork || stopping) return null;
  if (activeCount >= getConfiguredConcurrency()) return null;
  activeCount += 1;
  return createSlotToken({ notifyOnUnboundRelease: false });
}

/**
 * @param {BroadcastSlotToken | void} token
 */
export function releaseReservedBroadcastSlot(token) {
  if (token && typeof token.release === 'function') {
    token.release();
  }
}

/**
 * @deprecated préférer token.bindDelivery
 * @param {number} deliveryId
 */
export function bindBroadcastSlotDelivery(deliveryId) {
  inFlightDeliveryIds.add(Number(deliveryId));
}

/**
 * @deprecated préférer token.release
 * @param {number} deliveryId
 */
export function releaseBroadcastSlot(deliveryId) {
  inFlightDeliveryIds.delete(Number(deliveryId));
  if (activeCount > 0) activeCount -= 1;
  if (waiters.length > 0 && acceptNewWork && !stopping) {
    const next = waiters.shift();
    activeCount += 1;
    next.resolve(createSlotToken({ notifyOnUnboundRelease: true }));
    return;
  }
  try {
    onSlotFreed?.();
  } catch {
    /* ignore */
  }
}

/**
 * Acquisition bloquante — AUCUNE delivery liée tant que bindDelivery n’est pas appelé.
 * @returns {Promise<BroadcastSlotToken>}
 */
export function acquireBroadcastSlot() {
  if (!acceptNewWork || stopping) {
    return Promise.reject(stoppingError());
  }
  if (activeCount < getConfiguredConcurrency()) {
    activeCount += 1;
    return Promise.resolve(createSlotToken({ notifyOnUnboundRelease: true }));
  }
  return new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
  });
}

/**
 * @template T
 * @param {(token: BroadcastSlotToken) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function runWithReservedBroadcastSlot(fn) {
  const token = await acquireBroadcastSlot();
  try {
    return await fn(token);
  } finally {
    if (!token.isReleased()) token.release();
  }
}

/**
 * Compat : slot puis bind immédiat d’un id connu.
 * @template T
 * @param {number} deliveryId
 * @param {() => Promise<T>} fn
 */
export async function runWithBroadcastSlot(deliveryId, fn) {
  return runWithReservedBroadcastSlot(async (token) => {
    token.bindDelivery(deliveryId);
    return fn();
  });
}

/**
 * @param {number} [timeoutMs]
 * @returns {Promise<{ idle: boolean, timedOut: boolean }>}
 */
export async function waitForBroadcastPoolIdle(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (activeCount > 0 || waiters.length > 0) {
    if (Date.now() >= deadline) {
      return { idle: false, timedOut: true };
    }
    if (stopping && waiters.length > 0) {
      rejectAllWaiters(stoppingError());
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return { idle: true, timedOut: false };
}

export function beginBroadcastPoolShutdown() {
  acceptNewWork = false;
  stopping = true;
  rejectAllWaiters(stoppingError());
}

/**
 * Réactive le pool — UNIQUEMENT start job / tests. Pas depuis stop.
 */
export function resetBroadcastPool() {
  acceptNewWork = true;
  stopping = false;
  if (activeCount === 0 && inFlightDeliveryIds.size === 0 && waiters.length > 0) {
    rejectAllWaiters(Object.assign(new Error('broadcast pool reset'), { code: 'BROADCAST_POOL_RESET' }));
  }
  cachedLimit = null;
  onSlotFreed = null;
}

export function resetBroadcastPoolForTests() {
  rejectAllWaiters(Object.assign(new Error('broadcast pool reset'), { code: 'BROADCAST_POOL_RESET' }));
  activeCount = 0;
  inFlightDeliveryIds.clear();
  waiters.length = 0;
  acceptNewWork = true;
  stopping = false;
  cachedLimit = null;
  onSlotFreed = null;
}

/**
 * @param {string} message
 * @param {Record<string, unknown>} [meta]
 */
export function logBroadcastPoolCritical(message, meta = {}) {
  logger.error(`scrimBroadcastExecutionPool: ${message}`, meta);
}
