import { isPersistentBroadcastEnabled } from '../utils/persistentBroadcastFlag.js';
import { logger } from '../utils/logger.js';
import { deliverScrimToDestination } from './scrimDelivery.js';
import { computeNextRetryDelayMs } from './discordRetryPolicy.js';
import { enqueueDiscordTask } from './discordTaskQueue.js';
import { orchestrateScrimCloseIntentionsForMessages } from './scrimLifecycleOrchestrator.js';
import { wakeScrimLifecycleDispatcher } from './scrimLifecycleDispatcher.js';
import {
  beginBroadcastPoolShutdown,
  getBroadcastPoolStats,
  getConfiguredConcurrency,
  isDeliveryInFlight,
  resetBroadcastPool,
  setBroadcastSlotFreedHandler,
  tryReserveBroadcastSlot,
  waitForBroadcastPoolIdle,
} from './scrimBroadcastExecutionPool.js';

/** Durée au-delà de laquelle une delivery "processing" est considérée comme perdue. */
const STALE_PROCESSING_THRESHOLD_MS = 10 * 60 * 1000;

/** Budget unique d'arrêt (ms). Surchargeable en tests via SCRIM_BROADCAST_STOP_TIMEOUT_MS. */
const STOP_WAIT_TIMEOUT_MS = 45_000;

function getStopWaitTimeoutMs() {
  const n = Number(process.env.SCRIM_BROADCAST_STOP_TIMEOUT_MS?.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : STOP_WAIT_TIMEOUT_MS;
}

/** Horodatage monotone pour last_dispatched_at (fairness même ms). */
let lastDispatchedMonoMs = 0;

function nextMonotonicDispatchedAtIso() {
  const now = Date.now();
  lastDispatchedMonoMs = Math.max(lastDispatchedMonoMs + 1, now);
  return new Date(lastDispatchedMonoMs).toISOString();
}

/** Intervalle entre cycles idle (ms). Configurable via SCRIM_BROADCAST_DELIVERY_INTERVAL_MS. */
function getIntervalMs() {
  const n = Number(process.env.SCRIM_BROADCAST_DELIVERY_INTERVAL_MS?.trim());
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

const FIRST_PASS_DELAY_MS = 3000;

/** @type {boolean} */
let jobStarted = false;

/** @type {boolean} */
let isPassRunning = false;

/** @type {boolean} */
let wakeRequested = false;

/** @type {ReturnType<typeof setTimeout> | null} */
let timerRef = null;

/** @type {(() => void) | null} */
let wakeResolve = null;

/**
 * Exposé tests : état wake sticky / passe.
 * @returns {{ wakeRequested: boolean, isPassRunning: boolean, jobStarted: boolean }}
 */
export function getBroadcastDeliveryJobDebugState() {
  return { wakeRequested, isPassRunning, jobStarted };
}

/**
 * Réveille le dispatcher (sticky : survivit si appelé pendant une passe).
 */
export function wakeScrimBroadcastDeliveryJob() {
  wakeRequested = true;
  if (wakeResolve) {
    const r = wakeResolve;
    wakeResolve = null;
    r();
  }
}

/**
 * Arrête le dispatcher (idempotent).
 * Plus de nouveaux claims ; attend les in-flight (budget unique 45s).
 * Ne remet JAMAIS processing → pending.
 * Ne réouvre PAS le pool (reset uniquement au prochain start).
 * @returns {Promise<void>}
 */
export async function stopScrimBroadcastDeliveryJob() {
  jobStarted = false;
  beginBroadcastPoolShutdown();
  if (timerRef !== null) {
    clearTimeout(timerRef);
    timerRef = null;
  }
  wakeScrimBroadcastDeliveryJob();

  const deadline = Date.now() + getStopWaitTimeoutMs();

  while (isPassRunning && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const remaining = Math.max(0, deadline - Date.now());
  const idle = await waitForBroadcastPoolIdle(remaining);
  if (idle.timedOut || isPassRunning || getBroadcastPoolStats().activeCount > 0) {
    logger.warn('stopScrimBroadcastDeliveryJob: timeout — processing laissées pour startup→unknown', {
      ...getBroadcastPoolStats(),
      pass_running: isPassRunning,
    });
  }
  // NE PAS resetBroadcastPool ici — pool reste stopping jusqu’au prochain start.
}

/**
 * Démarre le dispatcher de livraison persistante (idempotent, désactivé si flag off).
 *
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
export function startScrimBroadcastDeliveryJob(client, db, stmts) {
  if (!isPersistentBroadcastEnabled()) {
    logger.info('scrimBroadcastDeliveryJob: désactivé (flag off)');
    return;
  }
  if (jobStarted) {
    logger.warn('scrimBroadcastDeliveryJob: déjà démarré, ignoré');
    return;
  }
  jobStarted = true;
  resetBroadcastPool();
  logger.info('scrimBroadcastDeliveryJob: démarrage', {
    interval_ms: getIntervalMs(),
    first_pass_delay_ms: FIRST_PASS_DELAY_MS,
    concurrency: getConfiguredConcurrency(),
  });

  const loop = async () => {
    while (jobStarted) {
      if (!isPassRunning) {
        try {
          await runScrimBroadcastDeliveryPass(client, db, stmts);
        } catch (err) {
          logger.error('scrimBroadcastDeliveryJob: erreur passe', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (!jobStarted) return;

      // Sticky wake : travail signalé pendant la passe → pas de sleep poll
      if (wakeRequested) {
        wakeRequested = false;
        continue;
      }

      await new Promise((resolve) => {
        wakeResolve = resolve;
        timerRef = setTimeout(() => {
          wakeResolve = null;
          resolve(undefined);
        }, getIntervalMs());
      });
      if (timerRef !== null) {
        clearTimeout(timerRef);
        timerRef = null;
      }
      wakeRequested = false;
    }
  };

  timerRef = setTimeout(() => {
    timerRef = null;
    void loop().catch((err) => {
      logger.error('scrimBroadcastDeliveryJob: boucle crash', {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }, FIRST_PASS_DELAY_MS);
}

/**
 * Finalise un batch s’il ne reste aucune delivery exécutable
 * (pending / processing / retry). Les états terminaux (sent, failed_terminal,
 * cancelled, unknown_outcome) comptent comme terminés.
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number|string} batchId
 * @returns {boolean} true si le batch vient d’être marqué completed
 */
export function tryFinalizeScrimBroadcastBatch(stmts, batchId) {
  const pending = stmts.hasPendingDeliveriesForBatch.get(batchId);
  if (pending) return false;
  const nowFinal = new Date().toISOString();
  stmts.setScrimBroadcastBatchCompleted.run({
    id: batchId,
    status: 'completed',
    completed_at: nowFinal,
    updated_at: nowFinal,
  });
  logger.info('scrimBroadcastDeliveryJob: batch terminé', { batch_id: batchId });
  return true;
}

/**
 * Remet en unknown_outcome les deliveries « processing » trop anciennes
 * qui ne sont PAS actuellement in-flight dans CE process.
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
function recoverStaleProcessingDuringPass(stmts) {
  const staleThreshold = new Date(Date.now() - STALE_PROCESSING_THRESHOLD_MS).toISOString();
  const nowIso = new Date().toISOString();
  try {
    const staleDeliveries = stmts.listStaleProcessingDeliveries.all({
      stale_threshold_iso: staleThreshold,
    });
    for (const d of staleDeliveries) {
      if (isDeliveryInFlight(Number(d.id))) {
        continue;
      }
      try {
        stmts.markDeliveryUnknownOutcome.run({
          id: d.id,
          last_error_code: 'STALE_PROCESSING',
          last_error_message: 'Processing sans fin (passe worker)',
          completed_at: nowIso,
          updated_at: nowIso,
        });
        logger.info('scrimBroadcastDeliveryJob: delivery stale → unknown_outcome', {
          delivery_id: d.id,
          batch_id: d.batch_id,
          claimed_at: d.claimed_at,
        });
        if (d.batch_id != null) {
          tryFinalizeScrimBroadcastBatch(stmts, d.batch_id);
        }
      } catch (err) {
        logger.error('scrimBroadcastDeliveryJob: erreur markDeliveryUnknownOutcome (passe)', {
          delivery_id: d.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.error('scrimBroadcastDeliveryJob: erreur lecture stale deliveries (passe)', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Dispatcher : remplit les slots libres en continu (continuous refill).
 * Fairness : un batch due le plus starved, une delivery claimée, puis slot suivant.
 *
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @returns {Promise<{ batchesProcessed: number, dispatched: number }>}
 */
export async function runScrimBroadcastDeliveryPass(client, db, stmts) {
  if (isPassRunning) {
    return { batchesProcessed: 0, dispatched: 0 };
  }
  isPassRunning = true;
  let batchesProcessed = 0;
  let dispatched = 0;

  try {
    recoverStaleProcessingDuringPass(stmts);

    await new Promise((resolveOuter) => {
      let settled = false;
      const finishIfDone = () => {
        if (settled) return;
        const stats = getBroadcastPoolStats();
        if (stats.inFlight > 0) return;
        const nowIso = new Date().toISOString();
        const more = stmts.getNextActiveBatchDueForDispatch.get({ now_iso: nowIso });
        if (more && stats.acceptNewWork) {
          // Travail restant sans in-flight : retenter un refill synchrone.
          // Si aucun slot/claim n’aboutit, terminer la passe (prochain wake/poll).
          refill();
          if (!settled && getBroadcastPoolStats().inFlight === 0) {
            settled = true;
            setBroadcastSlotFreedHandler(null);
            resolveOuter(undefined);
          }
          return;
        }
        settled = true;
        setBroadcastSlotFreedHandler(null);
        resolveOuter(undefined);
      };

      const refill = () => {
        if (settled) return;
        const allowClaim = getBroadcastPoolStats().acceptNewWork !== false;
        while (allowClaim) {
          const token = tryReserveBroadcastSlot();
          if (!token) break;

          const nowIso = new Date().toISOString();
          const batch = stmts.getNextActiveBatchDueForDispatch.get({ now_iso: nowIso });
          if (!batch) {
            token.release();
            try {
              for (const b of stmts.listActiveBatchesDueForDispatch.all()) {
                tryFinalizeScrimBroadcastBatch(stmts, b.id);
              }
            } catch { /* ignore */ }
            break;
          }

          batchesProcessed += 1;
          const delivery = stmts.claimNextDeliveryForBatch.get({
            batch_id: batch.id,
            now_iso: nowIso,
            claimed_at: nowIso,
            updated_at: nowIso,
          });
          if (!delivery) {
            token.release();
            tryFinalizeScrimBroadcastBatch(stmts, batch.id);
            continue;
          }

          const dispatchedAt = nextMonotonicDispatchedAtIso();
          stmts.updateScrimBroadcastBatchLastDispatched.run({
            id: batch.id,
            last_dispatched_at: dispatchedAt,
            updated_at: dispatchedAt,
          });

          const deliveryId = Number(delivery.id);
          token.bindDelivery(deliveryId);
          dispatched += 1;

          void processDelivery(client, db, stmts, delivery)
            .catch((err) => {
              logger.error('scrimBroadcastDeliveryJob: processDelivery crash', {
                delivery_id: deliveryId,
                batch_id: batch.id,
                message: err instanceof Error ? err.message : String(err),
              });
              // Si encore processing → unknown (pas de resend auto)
              try {
                const row = stmts.getScrimBroadcastDeliveryById.get(deliveryId);
                if (row && row.status === 'processing') {
                  const nowCrash = new Date().toISOString();
                  stmts.markDeliveryUnknownOutcome.run({
                    id: deliveryId,
                    last_error_code: 'PROCESS_DELIVERY_CRASH',
                    last_error_message: (err instanceof Error ? err.message : String(err)).slice(0, 200),
                    completed_at: nowCrash,
                    updated_at: nowCrash,
                  });
                }
              } catch { /* best effort */ }
              tryFinalizeScrimBroadcastBatch(stmts, batch.id);
            })
            .finally(() => {
              token.release();
              wakeScrimBroadcastDeliveryJob();
              refill();
              finishIfDone();
            });
        }
        finishIfDone();
      };

      setBroadcastSlotFreedHandler(() => {
        refill();
        finishIfDone();
      });
      refill();
    });

    if (dispatched > 0) {
      logger.info('scrimBroadcastDeliveryJob: passe terminée', {
        batches_processed: batchesProcessed,
        dispatched,
        concurrency: getConfiguredConcurrency(),
      });
    }
  } finally {
    setBroadcastSlotFreedHandler(null);
    isPassRunning = false;
  }

  return { batchesProcessed, dispatched };
}

/**
 * Traite une delivery claimée.
 *
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {Record<string, unknown>} delivery
 */
async function processDelivery(client, db, stmts, delivery) {
  const deliveryId = Number(delivery.id);
  const batchId = Number(delivery.batch_id);
  const scrimPostDbId = Number(delivery.scrim_post_db_id);
  const nowAfter = new Date().toISOString();

  // 1. Vérifier que le scrim est encore actif
  const scrimRow = stmts.getScrimPostById.get(scrimPostDbId);
  if (!scrimRow || scrimRow.status !== 'active') {
    const cancelInfo = stmts.markDeliveryCancelled.run({
      id: deliveryId,
      completed_at: nowAfter,
      updated_at: nowAfter,
    });
    if (cancelInfo.changes === 0) {
      logger.info('scrimBroadcastDeliveryJob: annulation delivery sans effet (état déjà changé)', {
        delivery_id: deliveryId,
        scrim_post_db_id: scrimPostDbId,
      });
    } else {
      logger.info('scrimBroadcastDeliveryJob: delivery annulée (scrim inactif)', {
        delivery_id: deliveryId,
        scrim_post_db_id: scrimPostDbId,
        scrim_status: scrimRow?.status ?? 'not_found',
      });
    }
    tryFinalizeScrimBroadcastBatch(stmts, batchId);
    return;
  }

  // Reconstruire le payload pour l'embed
  const { scrimDbRowToEmbedPayload } = await import('./scrimEmbedBuilder.js');
  const payload = scrimDbRowToEmbedPayload(scrimRow);

  const row = { guild_id: String(delivery.guild_id), channel_id: String(delivery.channel_id) };
  const authorUserId = String(scrimRow.author_user_id);

  // 2. Livrer (send direct at-most-once applicatif ; fetch micro-retries ≤2)
  const result = await deliverScrimToDestination({
    client,
    stmts,
    row,
    authorUserId,
    payload,
    delayMs: 0,
    sendMode: 'direct',
    discordMaxAttempts: 2,
    deliveryId,
  });

  const nowResult = new Date().toISOString();

  if (result.outcome === 'sent') {
    // 3. Transaction courte APRÈS send Discord : insert message + mark sent (processing → sent)
    try {
      const txnResult = db.transaction(() => {
        stmts.insertScrimPostMessage.run({
          scrim_post_db_id: scrimPostDbId,
          guild_id: row.guild_id,
          channel_id: row.channel_id,
          message_id: result.message.id,
        });
        const markInfo = stmts.markDeliverySent.run({
          id: deliveryId,
          message_id: result.message.id,
          completed_at: nowResult,
          updated_at: nowResult,
        });
        if (markInfo.changes === 0) {
          throw new Error('markDeliverySent: transitions refused (status was not processing)');
        }
        return true;
      })();
      if (!txnResult) {
        /* unreachable */
      }
      logger.info('scrimBroadcastDeliveryJob: delivery envoyée', {
        delivery_id: deliveryId,
        batch_id: batchId,
        guild_id: row.guild_id,
        message_id: result.message.id,
      });
      // Vérification post-send : le scrim a-t-il été fermé pendant l'envoi ?
      const scrimAfterSend = stmts.getScrimPostById.get(scrimPostDbId);
      if (scrimAfterSend && scrimAfterSend.status !== 'active') {
        logger.info('scrimBroadcastDeliveryJob: scrim fermé pendant envoi — synchronisation lifecycle', {
          delivery_id: deliveryId,
          scrim_status: scrimAfterSend.status,
          guild_id: row.guild_id,
          message_id: result.message.id,
        });
        // Phase 3G : déléguer le lifecycle Discord au dispatcher — aucun edit/delete direct.
        try {
          const { operations } = orchestrateScrimCloseIntentionsForMessages(
            db,
            stmts,
            scrimPostDbId,
            [{
              guild_id: row.guild_id,
              channel_id: row.channel_id,
              message_id: result.message.id,
            }],
          );
          logger.info('scrimBroadcastDeliveryJob: intention lifecycle close post-send', {
            delivery_id: deliveryId,
            scrim_status: scrimAfterSend.status,
            guild_id: row.guild_id,
            message_id: result.message.id,
            operation_count: operations.length,
          });
          wakeScrimLifecycleDispatcher();
        } catch (syncErr) {
          logger.error('scrimBroadcastDeliveryJob: sync lifecycle post-fermeture échouée (delivery reste sent)', {
            delivery_id: deliveryId,
            guild_id: row.guild_id,
            message_id: result.message.id,
            message: syncErr instanceof Error ? syncErr.message : String(syncErr),
          });
        }
      }
    } catch (dbErr) {
      // DB échoue après send réussi — ou mark sent refusé
      logger.error('scrimBroadcastDeliveryJob: DB échouée après send', {
        delivery_id: deliveryId,
        guild_id: row.guild_id,
        message_id: result.message.id,
        message: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
      // Rollback Discord best-effort
      try {
        await enqueueDiscordTask(
          () => result.message.delete(),
          { kind: 'persistent_delivery_rollback', guild_id: row.guild_id, delivery_id: deliveryId },
          'high',
        );
      } catch {
        /* best effort */
      }
      try {
        const unk = stmts.markDeliveryUnknownOutcome.run({
          id: deliveryId,
          last_error_code: 'DB_INSERT_FAILED',
          last_error_message: (dbErr instanceof Error ? dbErr.message : String(dbErr)).slice(0, 200),
          completed_at: nowResult,
          updated_at: nowResult,
        });
        if (unk.changes === 0) {
          logger.warn('scrimBroadcastDeliveryJob: markDeliveryUnknownOutcome sans effet après DB fail', {
            delivery_id: deliveryId,
          });
        }
      } catch {
        /* best effort */
      }
    }
  } else if (result.outcome === 'terminal_error' || result.outcome === 'blocked') {
    const termInfo = stmts.markDeliveryTerminal.run({
      id: deliveryId,
      last_error_code: result.errorCode ?? 'TERMINAL',
      last_error_message: (result.errorMessage ?? '').slice(0, 200),
      completed_at: nowResult,
      updated_at: nowResult,
    });
    if (termInfo.changes === 0) {
      logger.warn('scrimBroadcastDeliveryJob: markDeliveryTerminal sans effet', {
        delivery_id: deliveryId,
        outcome: result.outcome,
      });
    } else {
      logger.info('scrimBroadcastDeliveryJob: delivery terminale', {
        delivery_id: deliveryId,
        batch_id: batchId,
        guild_id: row.guild_id,
        channel_id: row.channel_id,
        outcome: result.outcome,
        error_code: result.errorCode ?? 'TERMINAL',
      });
    }
  } else if (result.outcome === 'retryable_error') {
    const attemptCount = Number(delivery.attempt_count ?? 0) + 1;
    if (attemptCount >= 5) {
      const termInfo = stmts.markDeliveryTerminal.run({
        id: deliveryId,
        last_error_code: result.errorCode ?? 'MAX_RETRIES',
        last_error_message: (result.errorMessage ?? '').slice(0, 200),
        completed_at: nowResult,
        updated_at: nowResult,
      });
      if (termInfo.changes === 0) {
        logger.warn('scrimBroadcastDeliveryJob: markDeliveryTerminal (max retries) sans effet', {
          delivery_id: deliveryId,
        });
      }
    } else {
      const delayMs = computeNextRetryDelayMs(attemptCount) ?? 3600000;
      const retryInfo = stmts.markDeliveryRetry.run({
        id: deliveryId,
        next_attempt_at: new Date(Date.now() + delayMs).toISOString(),
        last_error_code: result.errorCode ?? 'RETRYABLE',
        last_error_message: (result.errorMessage ?? '').slice(0, 200),
        updated_at: nowResult,
      });
      if (retryInfo.changes === 0) {
        logger.warn('scrimBroadcastDeliveryJob: markDeliveryRetry sans effet', {
          delivery_id: deliveryId,
        });
      }
    }
  } else if (result.outcome === 'unknown_outcome') {
    const unk = stmts.markDeliveryUnknownOutcome.run({
      id: deliveryId,
      last_error_code: result.errorCode ?? 'SEND_AMBIGUOUS',
      last_error_message: (result.errorMessage ?? '').slice(0, 200),
      completed_at: nowResult,
      updated_at: nowResult,
    });
    if (unk.changes === 0) {
      logger.info('scrimBroadcastDeliveryJob: markDeliveryUnknownOutcome sans effet', {
        delivery_id: deliveryId,
      });
    }
  } else if (result.outcome === 'cancelled') {
    // Contrat DeliveryResult : non produit aujourd’hui par deliverScrimToDestination.
    // Si un jour émis, ne pas laisser la ligne en processing.
    const cancelInfo = stmts.markDeliveryCancelled.run({
      id: deliveryId,
      completed_at: nowResult,
      updated_at: nowResult,
    });
    if (cancelInfo.changes === 0) {
      logger.info('scrimBroadcastDeliveryJob: markDeliveryCancelled (outcome cancelled) sans effet', {
        delivery_id: deliveryId,
      });
    }
  } else {
    // Outcome inattendu — terminal soft, pas de resend
    const unk = stmts.markDeliveryUnknownOutcome.run({
      id: deliveryId,
      last_error_code: 'UNEXPECTED_OUTCOME',
      last_error_message: `outcome=${String(result.outcome)}`.slice(0, 200),
      completed_at: nowResult,
      updated_at: nowResult,
    });
    if (unk.changes === 0) {
      logger.info('scrimBroadcastDeliveryJob: markDeliveryUnknownOutcome (unexpected) sans effet', {
        delivery_id: deliveryId,
        outcome: result.outcome,
      });
    } else {
      logger.info('scrimBroadcastDeliveryJob: outcome delivery inattendu → unknown_outcome', {
        delivery_id: deliveryId,
        outcome: result.outcome,
      });
    }
  }

  tryFinalizeScrimBroadcastBatch(stmts, batchId);
}

/**
 * Récupère les deliveries abandonnées au démarrage du process,
 * et les batches staging orphelins.
 * À appeler au démarrage uniquement (avant de lancer le job).
 *
 * Politique unknown_outcome : terminal soft — JAMAIS de resend automatique
 * (pas de unknown → pending). Une processing de l’ancien process devient
 * unknown_outcome (Discord a peut‑être déjà reçu le message).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
export function recoverStaleScrimBroadcastDeliveries(db, stmts) {
  const nowIso = new Date().toISOString();

  // 1. Toute delivery encore "processing" appartient à l’ancien process → unknown_outcome
  try {
    const abandoned = stmts.listAllProcessingDeliveries.all();
    for (const d of abandoned) {
      try {
        const info = stmts.markDeliveryUnknownOutcome.run({
          id: d.id,
          last_error_code: 'ABANDONED_PROCESSING_STARTUP',
          last_error_message: 'Processing abandonnée au démarrage (pas de resend auto)',
          completed_at: nowIso,
          updated_at: nowIso,
        });
        if (info.changes > 0) {
          logger.warn('scrimBroadcastDeliveryJob recovery: processing → unknown_outcome (startup)', {
            delivery_id: d.id,
            claimed_at: d.claimed_at,
          });
        }
      } catch (err) {
        logger.error('scrimBroadcastDeliveryJob recovery: erreur markDeliveryUnknownOutcome', {
          delivery_id: d.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.error('scrimBroadcastDeliveryJob recovery: erreur lecture processing deliveries', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Batches staging :
  //    ≥1 sent → active (bootstrap avait confirmé un succès)
  //    0 sent → JAMAIS reprendre la diffusion (interaction Discord perdue) :
  //      cancel pending/retry, unknown inchangé, batch failed, rollback scrim.
  //    Pas de FK CASCADE : deleteScrimPostById ne supprime pas les deliveries
  //    (unknown_outcome reste pour diagnostic).
  try {
    const stagingBatches = stmts.listStagingBatchesForRecovery.all();
    for (const batch of stagingBatches) {
      try {
        const sentCount = stmts.countSentDeliveriesForBatch.get(batch.id);
        if (sentCount && Number(sentCount.n) > 0) {
          stmts.setScrimBroadcastBatchActive.run({
            id: batch.id,
            started_at: nowIso,
            updated_at: nowIso,
          });
          logger.info('scrimBroadcastDeliveryJob recovery: batch staging → active', {
            batch_id: batch.id,
            sent_count: sentCount.n,
          });
        } else {
          // processing résiduelles → unknown (pas pending). unknown_outcome inchangé.
          const deliveries = stmts.listDeliveriesForBatch.all(batch.id);
          for (const d of deliveries) {
            if (d.status === 'processing') {
              try {
                stmts.markDeliveryUnknownOutcome.run({
                  id: d.id,
                  last_error_code: 'ABANDONED_PROCESSING_STAGING',
                  last_error_message: 'Processing abandonnée (batch staging, pas de resend auto)',
                  completed_at: nowIso,
                  updated_at: nowIso,
                });
              } catch (updErr) {
                logger.error('scrimBroadcastDeliveryJob recovery: processing→unknown staging', {
                  delivery_id: d.id,
                  message: updErr instanceof Error ? updErr.message : String(updErr),
                });
              }
            }
          }

          // Annuler toute delivery encore exécutable (pending/retry uniquement —
          // cancelPendingDeliveriesForScrim ne touche pas unknown_outcome / sent / terminal).
          try {
            stmts.cancelPendingDeliveriesForScrim.run({
              scrim_post_db_id: batch.scrim_post_db_id,
              completed_at: nowIso,
              updated_at: nowIso,
            });
          } catch (cancelErr) {
            logger.error('scrimBroadcastDeliveryJob recovery: cancel pending staging échoué', {
              batch_id: batch.id,
              message: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
            });
          }

          try {
            stmts.setScrimBroadcastBatchCompleted.run({
              id: batch.id,
              status: 'failed',
              completed_at: nowIso,
              updated_at: nowIso,
            });
            stmts.deleteScrimPostById.run(batch.scrim_post_db_id);
            logger.warn('scrimBroadcastDeliveryJob recovery: batch staging zéro sent → failed + scrim supprimé (pas de reprise auto)', {
              batch_id: batch.id,
              scrim_post_db_id: batch.scrim_post_db_id,
            });
          } catch (casC) {
            logger.error('scrimBroadcastDeliveryJob recovery: rollback staging 0-sent échoué', {
              batch_id: batch.id,
              message: casC instanceof Error ? casC.message : String(casC),
            });
          }
        }
      } catch (err) {
        logger.error('scrimBroadcastDeliveryJob recovery: erreur batch staging', {
          batch_id: batch.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.error('scrimBroadcastDeliveryJob recovery: erreur lecture staging batches', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Retourne un snapshot des métriques de santé (requêtes DB pures, pas de réseau).
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @returns {{
 *   batches_staging: number,
 *   batches_active: number,
 *   batches_completed: number,
 *   batches_failed: number,
 *   batches_cancelled: number,
 *   deliveries_pending: number,
 *   deliveries_processing: number,
 *   deliveries_retry: number,
 *   deliveries_sent: number,
 *   deliveries_failed_terminal: number,
 *   deliveries_cancelled: number,
 *   deliveries_unknown_outcome: number,
 *   oldest_pending_created_at: string | null,
 *   oldest_retry_next_attempt_at: string | null,
 * }}
 */
export function getScrimBroadcastHealthSnapshot(stmts) {
  const batchCounts = {};
  try {
    for (const row of stmts.countBroadcastBatchesByStatus.all()) {
      batchCounts[row.status] = Number(row.n);
    }
  } catch { /* ignore */ }

  const deliveryCounts = {};
  try {
    for (const row of stmts.countBroadcastDeliveriesByStatus.all()) {
      deliveryCounts[row.status] = Number(row.n);
    }
  } catch { /* ignore */ }

  let oldestPending = null;
  try {
    const r = stmts.oldestPendingDelivery.get();
    if (r) oldestPending = r.created_at;
  } catch { /* ignore */ }

  let oldestRetry = null;
  try {
    const r = stmts.oldestRetryDelivery.get();
    if (r) oldestRetry = r.next_attempt_at;
  } catch { /* ignore */ }

  return {
    batches_staging: batchCounts['staging'] ?? 0,
    batches_active: batchCounts['active'] ?? 0,
    batches_completed: batchCounts['completed'] ?? 0,
    batches_failed: batchCounts['failed'] ?? 0,
    batches_cancelled: batchCounts['cancelled'] ?? 0,
    deliveries_pending: deliveryCounts['pending'] ?? 0,
    deliveries_processing: deliveryCounts['processing'] ?? 0,
    deliveries_retry: deliveryCounts['retry'] ?? 0,
    deliveries_sent: deliveryCounts['sent'] ?? 0,
    deliveries_failed_terminal: deliveryCounts['failed_terminal'] ?? 0,
    deliveries_cancelled: deliveryCounts['cancelled'] ?? 0,
    deliveries_unknown_outcome: deliveryCounts['unknown_outcome'] ?? 0,
    oldest_pending_created_at: oldestPending,
    oldest_retry_next_attempt_at: oldestRetry,
  };
}
