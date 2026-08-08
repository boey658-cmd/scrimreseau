import { isPersistentBroadcastEnabled } from '../utils/persistentBroadcastFlag.js';
import { logger } from '../utils/logger.js';
import { deliverScrimToDestination } from './scrimDelivery.js';
import { computeNextRetryDelayMs } from './discordRetryPolicy.js';
import { enqueueDiscordTask } from './discordTaskQueue.js';
import { safeScrimEmbedMessageEdit } from './safeDiscordMessageEdit.js';
import { buildScrimClosedMessageEditOptions } from './scrimEmbedBuilder.js';
import { getGuildScrimMessageLifecyclePolicy } from './scrimMessagePolicy.js';
import { getGuildLocale } from '../i18n/index.js';

/** Durée au-delà de laquelle une delivery "processing" est considérée comme perdue. */
const STALE_PROCESSING_THRESHOLD_MS = 10 * 60 * 1000;

/** Délai max d'attente de fin de passe lors de l'arrêt (ms). */
const STOP_WAIT_TIMEOUT_MS = 30_000;

/** Intervalle entre passes (ms). Configurable via SCRIM_BROADCAST_DELIVERY_INTERVAL_MS. */
function getIntervalMs() {
  const n = Number(process.env.SCRIM_BROADCAST_DELIVERY_INTERVAL_MS?.trim());
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

const FIRST_PASS_DELAY_MS = 3000;

/** @type {boolean} */
let jobStarted = false;

/** @type {boolean} */
let isPassRunning = false;

/** @type {ReturnType<typeof setTimeout> | null} */
let timerRef = null;

/** @type {(() => void) | null} */
let wakeResolve = null;

/**
 * Réveille le worker si en attente.
 */
export function wakeScrimBroadcastDeliveryJob() {
  if (wakeResolve) {
    const r = wakeResolve;
    wakeResolve = null;
    r();
  }
}

/**
 * Arrête le worker de livraison (idempotent).
 * Attend la fin de la passe courante avec un timeout borné à 30 s.
 * @returns {Promise<void>}
 */
export async function stopScrimBroadcastDeliveryJob() {
  jobStarted = false;
  if (timerRef !== null) {
    clearTimeout(timerRef);
    timerRef = null;
  }
  wakeScrimBroadcastDeliveryJob();

  // Attendre la fin de la passe courante (timeout borné)
  if (isPassRunning) {
    const deadline = Date.now() + STOP_WAIT_TIMEOUT_MS;
    while (isPassRunning && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (isPassRunning) {
      logger.warn('stopScrimBroadcastDeliveryJob: timeout atteint, passe courante interrompue');
    }
  }
}

/**
 * Démarre le worker de livraison persistante (idempotent, désactivé si flag off).
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
  logger.info('scrimBroadcastDeliveryJob: démarrage', {
    interval_ms: getIntervalMs(),
    first_pass_delay_ms: FIRST_PASS_DELAY_MS,
  });

  const loop = async () => {
    if (!jobStarted) return;
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

    // Attendre l'intervalle ou un wake
    await new Promise((resolve) => {
      wakeResolve = resolve;
      timerRef = setTimeout(() => {
        wakeResolve = null;
        resolve(undefined);
      }, getIntervalMs());
    });

    if (jobStarted) {
      void loop().catch((err) => {
        logger.error('scrimBroadcastDeliveryJob: boucle crash', {
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
  };

  timerRef = setTimeout(() => {
    timerRef = null;
    void loop().catch((err) => {
      logger.error('scrimBroadcastDeliveryJob: premier démarrage crash', {
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
 * (même logique que le recovery au démarrage), pour débloquer la finalisation.
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
      try {
        stmts.markDeliveryUnknownOutcome.run({
          id: d.id,
          last_error_code: 'STALE_PROCESSING',
          last_error_message: 'Processing sans fin (passe worker)',
          completed_at: nowIso,
          updated_at: nowIso,
        });
        logger.warn('scrimBroadcastDeliveryJob: delivery stale → unknown_outcome', {
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
 * Effectue une passe de livraison : pour chaque batch actif, dispatch une delivery.
 * Testable isolément.
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
    // Débloque les batches coincés sur une delivery « processing » abandonnée
    // sans attendre un redémarrage du processus.
    recoverStaleProcessingDuringPass(stmts);

    const activeBatches = stmts.listActiveBatchesDueForDispatch.all();

    for (const batch of activeBatches) {
      batchesProcessed += 1;

      const nowIso = new Date().toISOString();
      const due = stmts.getNextDueDeliveryForBatch.get({ batch_id: batch.id, now_iso: nowIso });
      if (!due) {
        // Plus rien à claim : finaliser si toutes les deliveries sont terminales.
        // Corrige les batches restés « active » avec dispatched:0 indéfiniment.
        tryFinalizeScrimBroadcastBatch(stmts, batch.id);
        continue;
      }

      // Claim atomique
      const claimInfo = stmts.claimNextDeliveryForBatch.run({
        batch_id: batch.id,
        now_iso: nowIso,
        claimed_at: nowIso,
        updated_at: nowIso,
      });
      if (claimInfo.changes === 0) {
        tryFinalizeScrimBroadcastBatch(stmts, batch.id);
        continue;
      }

      // Mettre à jour last_dispatched_at sur le batch
      stmts.updateScrimBroadcastBatchLastDispatched.run({
        id: batch.id,
        last_dispatched_at: nowIso,
        updated_at: nowIso,
      });

      const delivery = stmts.getProcessingDeliveryForBatch.get(batch.id);
      if (!delivery) {
        tryFinalizeScrimBroadcastBatch(stmts, batch.id);
        continue;
      }

      dispatched += 1;
      await processDelivery(client, db, stmts, delivery).catch((err) => {
        logger.error('scrimBroadcastDeliveryJob: processDelivery crash', {
          delivery_id: delivery.id,
          batch_id: batch.id,
          message: err instanceof Error ? err.message : String(err),
        });
        // Après un crash, tenter quand même la finalisation si plus rien d’exécutable.
        tryFinalizeScrimBroadcastBatch(stmts, batch.id);
      });
    }

    // Recompter les batches encore actifs après éventuelles finalisations
    const stillActive = stmts.listActiveBatchesDueForDispatch.all().length;
    if (dispatched > 0 || stillActive > 0) {
      logger.info('scrimBroadcastDeliveryJob: passe terminée', {
        batches_active: stillActive,
        batches_processed: batchesProcessed,
        dispatched,
      });
    }
  } finally {
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
    stmts.markDeliveryCancelled.run({
      id: deliveryId,
      completed_at: nowAfter,
      updated_at: nowAfter,
    });
    logger.info('scrimBroadcastDeliveryJob: delivery annulée (scrim inactif)', {
      delivery_id: deliveryId,
      scrim_post_db_id: scrimPostDbId,
      scrim_status: scrimRow?.status ?? 'not_found',
    });
    tryFinalizeScrimBroadcastBatch(stmts, batchId);
    return;
  }

  // Reconstruire le payload pour l'embed
  const { scrimDbRowToEmbedPayload } = await import('./scrimEmbedBuilder.js');
  const payload = scrimDbRowToEmbedPayload(scrimRow);

  const row = { guild_id: String(delivery.guild_id), channel_id: String(delivery.channel_id) };
  const authorUserId = String(scrimRow.author_user_id);

  // 2. Livrer
  const result = await deliverScrimToDestination({
    client,
    stmts,
    row,
    authorUserId,
    payload,
    delayMs: 0,
  });

  const nowResult = new Date().toISOString();

  if (result.outcome === 'sent') {
    // 3. Transaction : insertScrimPostMessage + markDeliverySent
    try {
      db.transaction(() => {
        stmts.insertScrimPostMessage.run({
          scrim_post_db_id: scrimPostDbId,
          guild_id: row.guild_id,
          channel_id: row.channel_id,
          message_id: result.message.id,
        });
        stmts.markDeliverySent.run({
          id: deliveryId,
          message_id: result.message.id,
          completed_at: nowResult,
          updated_at: nowResult,
        });
      })();
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
        // La synchronisation lifecycle ne doit JAMAIS effacer le succès de la delivery.
        // Toute erreur ici est loguée mais ne change pas le statut de la delivery.
        try {
          const locale = getGuildLocale(row.guild_id, stmts);
          const closedStatus = /** @type {'closed_manual' | 'closed_expired'} */ (
            scrimAfterSend.status === 'closed_expired' ? 'closed_expired' : 'closed_manual'
          );
          const editOptions = buildScrimClosedMessageEditOptions(closedStatus, scrimAfterSend, locale);
          const policy = getGuildScrimMessageLifecyclePolicy(stmts, row.guild_id);

          if (policy === 'delete') {
            // Tenter la suppression directe (best-effort)
            let deleted = false;
            try {
              await enqueueDiscordTask(
                () => result.message.delete(),
                { kind: 'persistent_delivery_post_close_delete', guild_id: row.guild_id, delivery_id: deliveryId },
                'high',
              );
              stmts.markScrimPostMessageDiscordDeleted.run({
                discord_deleted_at: new Date().toISOString(),
                guild_id: row.guild_id,
                channel_id: row.channel_id,
                message_id: result.message.id,
              });
              deleted = true;
            } catch (delErr) {
              logger.warn('scrimBroadcastDeliveryJob: suppression post-fermeture échouée — fallback édition', {
                delivery_id: deliveryId,
                guild_id: row.guild_id,
                message_id: result.message.id,
                message: delErr instanceof Error ? delErr.message : String(delErr),
              });
            }
            if (!deleted) {
              await safeScrimEmbedMessageEdit({
                client,
                stmts,
                scrimPostDbId,
                guildId: row.guild_id,
                channelId: row.channel_id,
                messageId: result.message.id,
                targetStatus: closedStatus,
                editOptions,
                message: result.message,
              });
            }
          } else {
            // Policy keep : éditer l'embed en rendu inactif (via le service partagé avec retry SQLite)
            await safeScrimEmbedMessageEdit({
              client,
              stmts,
              scrimPostDbId,
              guildId: row.guild_id,
              channelId: row.channel_id,
              messageId: result.message.id,
              targetStatus: closedStatus,
              editOptions,
              message: result.message,
            });
          }
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
      // DB échoue après send réussi
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
        stmts.markDeliveryUnknownOutcome.run({
          id: deliveryId,
          last_error_code: 'DB_INSERT_FAILED',
          last_error_message: (dbErr instanceof Error ? dbErr.message : String(dbErr)).slice(0, 200),
          completed_at: nowResult,
          updated_at: nowResult,
        });
      } catch {
        /* best effort */
      }
    }
  } else if (result.outcome === 'terminal_error' || result.outcome === 'blocked') {
    stmts.markDeliveryTerminal.run({
      id: deliveryId,
      last_error_code: result.errorCode ?? 'TERMINAL',
      last_error_message: (result.errorMessage ?? '').slice(0, 200),
      completed_at: nowResult,
      updated_at: nowResult,
    });
    logger.info('scrimBroadcastDeliveryJob: delivery terminale', {
      delivery_id: deliveryId,
      batch_id: batchId,
      guild_id: row.guild_id,
      channel_id: row.channel_id,
      outcome: result.outcome,
      error_code: result.errorCode ?? 'TERMINAL',
    });
  } else if (result.outcome === 'retryable_error') {
    const attemptCount = Number(delivery.attempt_count ?? 0) + 1;
    if (attemptCount >= 5) {
      stmts.markDeliveryTerminal.run({
        id: deliveryId,
        last_error_code: result.errorCode ?? 'MAX_RETRIES',
        last_error_message: (result.errorMessage ?? '').slice(0, 200),
        completed_at: nowResult,
        updated_at: nowResult,
      });
    } else {
      const delayMs = computeNextRetryDelayMs(attemptCount) ?? 3600000;
      stmts.markDeliveryRetry.run({
        id: deliveryId,
        next_attempt_at: new Date(Date.now() + delayMs).toISOString(),
        last_error_code: result.errorCode ?? 'RETRYABLE',
        last_error_message: (result.errorMessage ?? '').slice(0, 200),
        updated_at: nowResult,
      });
    }
  }

  tryFinalizeScrimBroadcastBatch(stmts, batchId);
}

/**
 * Récupère les deliveries bloquées en "processing" depuis trop longtemps,
 * et les batches staging orphelins.
 * À appeler au démarrage, avant de lancer le job.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
export function recoverStaleScrimBroadcastDeliveries(db, stmts) {
  const staleThreshold = new Date(Date.now() - STALE_PROCESSING_THRESHOLD_MS).toISOString();
  const nowIso = new Date().toISOString();

  // 1. Deliveries bloquées en "processing" → unknown_outcome
  try {
    const staleDeliveries = stmts.listStaleProcessingDeliveries.all({ stale_threshold_iso: staleThreshold });
    for (const d of staleDeliveries) {
      try {
        stmts.markDeliveryUnknownOutcome.run({
          id: d.id,
          last_error_code: 'STALE_PROCESSING',
          last_error_message: 'Processing sans fin au démarrage',
          completed_at: nowIso,
          updated_at: nowIso,
        });
        logger.warn('scrimBroadcastDeliveryJob recovery: delivery stale → unknown_outcome', {
          delivery_id: d.id,
          claimed_at: d.claimed_at,
        });
      } catch (err) {
        logger.error('scrimBroadcastDeliveryJob recovery: erreur markDeliveryUnknownOutcome', {
          delivery_id: d.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.error('scrimBroadcastDeliveryJob recovery: erreur lecture stale deliveries', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Batches staging : si au moins 1 sent → active ; sinon remettre pending
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
          // Remettre les non-terminales en pending avec next_attempt_at = maintenant
          const deliveries = stmts.listDeliveriesForBatch.all(batch.id);
          for (const d of deliveries) {
            if (d.status === 'processing' || d.status === 'unknown_outcome') {
              try {
                db.prepare(`
                  UPDATE scrim_broadcast_deliveries
                  SET status = 'pending', next_attempt_at = ?, claimed_at = NULL, updated_at = ?
                  WHERE id = ? AND status IN ('processing', 'unknown_outcome')
                `).run(nowIso, nowIso, d.id);
              } catch (updErr) {
                logger.error('scrimBroadcastDeliveryJob recovery: reset delivery staging', {
                  delivery_id: d.id,
                  message: updErr instanceof Error ? updErr.message : String(updErr),
                });
              }
            }
          }

          // Cas C : toutes les deliveries sont terminales et 0 sent → batch mort, rollback scrim
          const hasPending = stmts.hasPendingDeliveriesForBatch.get(batch.id);
          if (!hasPending) {
            const sentNow = stmts.countSentDeliveriesForBatch.get(batch.id);
            if (!sentNow || Number(sentNow.n) === 0) {
              try {
                stmts.setScrimBroadcastBatchCompleted.run({
                  id: batch.id,
                  status: 'failed',
                  completed_at: nowIso,
                  updated_at: nowIso,
                });
                stmts.deleteScrimPostById.run(batch.scrim_post_db_id);
                logger.warn('scrimBroadcastDeliveryJob recovery: batch staging zéro sent, toutes terminales → batch failed + scrim supprimé', {
                  batch_id: batch.id,
                  scrim_post_db_id: batch.scrim_post_db_id,
                });
              } catch (casC) {
                logger.error('scrimBroadcastDeliveryJob recovery: Cas C rollback échoué', {
                  batch_id: batch.id,
                  message: casC instanceof Error ? casC.message : String(casC),
                });
              }
            }
          }

          logger.info('scrimBroadcastDeliveryJob recovery: batch staging — deliveries remises en pending', {
            batch_id: batch.id,
          });
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
