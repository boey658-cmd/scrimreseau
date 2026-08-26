import { logger } from '../utils/logger.js';
import {
  drainScrimLifecycleDispatcher,
  recoverScrimLifecycleDispatcherAtStartup,
} from './scrimLifecycleDispatcher.js';

/**
 * Phase 3F — recovery job remplacé par le dispatcher lifecycle.
 * Ce module reste pour compat tests / imports legacy.
 */

let jobStarted = false;
let jobShuttingDown = false;

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
export function recoverOrchestratedLifecycleOperationsAtStartup(stmts) {
  return recoverScrimLifecycleDispatcherAtStartup(stmts);
}

/**
 * @param {import('discord.js').Client} client
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
export async function runScrimLifecycleRecoveryPass(client, stmts) {
  const processed = await drainScrimLifecycleDispatcher(client, stmts);
  return {
    processed,
    completed: processed,
    queued: 0,
    skipped: 0,
    failed: 0,
  };
}

export function getScrimLifecycleRecoveryJobHealthSnapshot() {
  return {
    started: jobStarted,
    shuttingDown: jobShuttingDown,
    passInProgress: false,
    intervalMinutes: 0,
    deprecated: true,
  };
}

/**
 * @param {import('discord.js').Client} _client
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} _stmts
 */
export function startScrimLifecycleRecoveryJob(_client, _stmts) {
  if (jobStarted) return;
  jobStarted = true;
  try {
    logger.info('scrimLifecycleRecoveryJob: deprecated — dispatcher 3F actif');
  } catch {
    /* ignore */
  }
}

export async function stopScrimLifecycleRecoveryJob() {
  jobShuttingDown = true;
  jobStarted = false;
}
