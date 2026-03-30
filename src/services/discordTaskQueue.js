import { logger } from '../utils/logger.js';
import {
  isDiscordRequestDebug,
  runTransientDiscord,
} from './discordApiGuard.js';

/** @typedef {'stopped' | 'running' | 'stopping'} DiscordTaskQueueState */

/** @type {DiscordTaskQueueState} */
let state = 'stopped';

/** @type {boolean} */
let rejectingNew = false;

/** @type {number} */
let delayMs = 100;

/** @type {number} */
let queueTaskMaxAttempts = 4;

/** @typedef {'high' | 'low'} DiscordTaskPriority */

/** @type {Array<{ taskFn: () => Promise<unknown>, metadata?: Record<string, unknown>, resolve: (v: unknown) => void, reject: (e: unknown) => void }>} */
const queueHigh = [];

/** @type {typeof queueHigh} */
const queueLow = [];

function totalQueueLength() {
  return queueHigh.length + queueLow.length;
}

/** @returns {{ taskFn: () => Promise<unknown>, metadata?: Record<string, unknown>, resolve: (v: unknown) => void, reject: (e: unknown) => void } | undefined} */
function dequeueNext() {
  if (queueHigh.length > 0) return queueHigh.shift();
  return queueLow.shift();
}

/** @type {boolean} */
let pumpRunning = false;

/** @type {boolean} */
let currentTaskRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string | undefined} raw
 * @param {number} fallbackMs
 */
function parseDelayMs(raw, fallbackMs) {
  const n = Number(raw?.trim());
  if (!Number.isFinite(n) || n < 0) return fallbackMs;
  return Math.min(Math.max(Math.floor(n), 0), 5000);
}

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 */
function parseQueueMaxAttempts(raw, fallback) {
  const n = Number(raw?.trim());
  if (!Number.isFinite(n) || n < 1 || n > 10) return fallback;
  return Math.floor(n);
}

/**
 * @param {unknown} err
 */
function logTaskFailure(err, metadata) {
  try {
    logger.error('discordTaskQueue: tâche échouée', {
      metadata: metadata ?? {},
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  } catch {
    /* ne pas faire échouer la queue */
  }
}

async function runPump() {
  if (pumpRunning) return;
  pumpRunning = true;
  try {
    while (
      totalQueueLength() > 0 &&
      (state === 'running' || state === 'stopping')
    ) {
      const item = dequeueNext();
      if (!item) break;

      currentTaskRunning = true;
      try {
        const kind = `queue:${item.metadata?.kind ?? 'task'}`;
        const result = await runTransientDiscord(() => item.taskFn(), {
          kind,
          metadata: {
            .../** @type {Record<string, unknown>} */ (item.metadata ?? {}),
            queue_length_after_dequeue: totalQueueLength(),
          },
          maxAttempts: queueTaskMaxAttempts,
        });
        item.resolve(result);
      } catch (err) {
        logTaskFailure(err, item.metadata);
        try {
          item.reject(err);
        } catch {
          /* ignore */
        }
      } finally {
        currentTaskRunning = false;
      }

      const applyDelay =
        state === 'running' && delayMs > 0 && totalQueueLength() > 0;
      if (applyDelay) {
        await sleep(delayMs);
      }
    }
  } finally {
    pumpRunning = false;
  }
}

/**
 * Démarre la file (mono-instance). Idempotent.
 */
export function startDiscordTaskQueue() {
  if (state === 'running') {
    try {
      logger.warn('discordTaskQueue: déjà démarrée, ignoré');
    } catch {
      /* ignore */
    }
    return;
  }
  delayMs = parseDelayMs(process.env.DISCORD_TASK_QUEUE_DELAY_MS, 100);
  queueTaskMaxAttempts = parseQueueMaxAttempts(
    process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS,
    4,
  );
  rejectingNew = false;
  state = 'running';
  try {
    logger.info('discordTaskQueue: démarrage', {
      delay_ms: delayMs,
      env_key: 'DISCORD_TASK_QUEUE_DELAY_MS',
      max_attempts_per_task: queueTaskMaxAttempts,
      env_key_attempts: 'DISCORD_TASK_QUEUE_MAX_ATTEMPTS',
    });
  } catch {
    /* ignore */
  }
}

/**
 * Arrêt best-effort : refuse les nouvelles tâches, vide la file, n’attend pas indéfiniment.
 * @returns {Promise<void>}
 */
export async function stopDiscordTaskQueue() {
  if (state === 'stopped') return;

  rejectingNew = true;
  state = 'stopping';

  try {
    logger.info('discordTaskQueue: arrêt demandé', { phase: 'shutdown_start' });
  } catch {
    /* ignore */
  }

  const deadline = Date.now() + 10_000;
  while (
    (totalQueueLength() > 0 || currentTaskRunning || pumpRunning) &&
    Date.now() < deadline
  ) {
    void runPump();
    await sleep(50);
  }

  if (totalQueueLength() > 0 || currentTaskRunning) {
    try {
      logger.warn('discordTaskQueue: arrêt — file ou tâche encore active après attente', {
        queue_length: totalQueueLength(),
        queue_length_high: queueHigh.length,
        queue_length_low: queueLow.length,
        current_task: currentTaskRunning,
      });
    } catch {
      /* ignore */
    }
  }

  const flushErr = new Error('discordTaskQueue: arrêt (file vidée)');
  while (queueHigh.length > 0) {
    const item = queueHigh.shift();
    if (!item) break;
    try {
      item.reject(flushErr);
    } catch {
      /* ignore */
    }
  }
  while (queueLow.length > 0) {
    const item = queueLow.shift();
    if (!item) break;
    try {
      item.reject(flushErr);
    } catch {
      /* ignore */
    }
  }

  state = 'stopped';

  try {
    logger.info('discordTaskQueue: arrêté', { phase: 'shutdown_done' });
  } catch {
    /* ignore */
  }
}

/**
 * Enfile une tâche async (une exécution Discord à la fois + délai entre tâches si running).
 * Pas de retry au niveau file : les erreurs sont journalisées et propagées au caller.
 * Priorité : `high` traitée avant `low` ; FIFO à priorité égale.
 *
 * @param {() => Promise<unknown>} taskFn
 * @param {Record<string, unknown>} [metadata]
 * @param {DiscordTaskPriority} [priority]
 * @returns {Promise<unknown>}
 */
export function enqueueDiscordTask(taskFn, metadata, priority = 'high') {
  if (state !== 'running' || rejectingNew) {
    return Promise.reject(
      new Error('discordTaskQueue: file indisponible (arrêt ou non démarrée)'),
    );
  }

  if (typeof taskFn !== 'function') {
    return Promise.reject(new TypeError('discordTaskQueue: taskFn doit être une fonction'));
  }

  if (priority !== 'high' && priority !== 'low') {
    return Promise.reject(
      new TypeError('discordTaskQueue: priorité invalide (attendu "high" | "low")'),
    );
  }

  return new Promise((resolve, reject) => {
    const item = {
      taskFn,
      metadata,
      resolve,
      reject,
    };
    if (priority === 'high') {
      queueHigh.push(item);
    } else {
      queueLow.push(item);
    }
    if (isDiscordRequestDebug()) {
      try {
        logger.info('discord_request_debug: enqueue', {
          queue_length: totalQueueLength(),
          queue_length_high: queueHigh.length,
          queue_length_low: queueLow.length,
          queue_priority: priority,
          .../** @type {Record<string, unknown>} */ (metadata ?? {}),
        });
      } catch {
        /* ignore */
      }
    }
    void runPump();
  });
}

/**
 * @returns {{
 *   state: DiscordTaskQueueState,
 *   started: boolean,
 *   rejectingNew: boolean,
 *   queueLength: number,
 *   queueLengthHigh: number,
 *   queueLengthLow: number,
 *   currentTaskRunning: boolean,
 *   delayMsConfigured: number,
 *   maxAttemptsPerTask: number,
 * }}
 */
export function getDiscordTaskQueueHealthSnapshot() {
  return {
    state,
    started: state === 'running' || state === 'stopping',
    rejectingNew,
    queueLength: totalQueueLength(),
    queueLengthHigh: queueHigh.length,
    queueLengthLow: queueLow.length,
    currentTaskRunning,
    delayMsConfigured: delayMs,
    maxAttemptsPerTask: queueTaskMaxAttempts,
  };
}
