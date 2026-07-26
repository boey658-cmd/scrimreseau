import 'dotenv/config';
import { startBot } from './src/bot.js';
import { closeDb } from './src/database/db.js';
import { stopDailyDevReportJob } from './src/services/dailyDevReportJob.js';
import { stopDiscordEditRetryJob } from './src/services/discordEditRetryJob.js';
import { stopDiscordTaskQueue } from './src/services/discordTaskQueue.js';
import { stopPlayerSearchExpirationJob } from './src/jobs/playerSearchExpirationJob.js';
import { stopScrimExpirationJob } from './src/services/scrimExpirationJob.js';
import { stopScrimRepostJob } from './src/services/scrimRepostJob.js';
import { stopDashboardRefreshJob } from './src/services/networkDashboard.js';
import { stopScrimBroadcastDeliveryJob } from './src/services/scrimBroadcastDeliveryJob.js';
import { isPersistentBroadcastEnabled } from './src/utils/persistentBroadcastFlag.js';
import { createGracefulShutdown } from './src/services/shutdownOrchestrator.js';
import { logger } from './src/utils/logger.js';
import { recordUncaughtException, recordUnhandledRejection } from './src/utils/processHealth.js';

let uncaughtExitScheduled = false;

function scheduleExitAfterUncaughtException() {
  if (uncaughtExitScheduled) return;
  uncaughtExitScheduled = true;
  setTimeout(() => {
    process.exit(1);
  }, 250);
}

/** Politique : journaliser chaque rejet non géré (visibilité prod). Pas de sortie immédiate — évite d'arrêter le bot sur une promesse oubliée isolée ; préférer corriger la source une fois identifiée via les logs. */
process.on('unhandledRejection', (reason) => {
  try {
    recordUnhandledRejection(reason);
    logger.error('Promesse rejetée non gérée (unhandledRejection)', {
      type: 'unhandledRejection',
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  } catch {
    /* ne pas faire échouer le handler process */
  }
});

process.on('uncaughtException', (err) => {
  recordUncaughtException(err);
  try {
    logger.error('Exception non capturée', {
      message: err.message,
      stack: err.stack,
    });
  } catch {
    /* ignore */
  }
  scheduleExitAfterUncaughtException();
});

/** Référence au client Discord après démarrage réussi. */
let clientRef = /** @type {import('discord.js').Client | null} */ (null);

/**
 * Orchestrateur unique de graceful shutdown.
 * Arrêt dans l'ordre : jobs → (worker persistant) → file Discord → client Discord → SQLite.
 * Le garde-fou interne `shutdownPromise` garantit qu'une seule séquence s'exécute
 * même si SIGINT et SIGTERM arrivent simultanément ou deux SIGINT successifs.
 */
const gracefulShutdown = createGracefulShutdown({
  steps: [
    {
      // En premier : positionner jobStarted = false + clearTimeout synchroniquement
      // avant tout autre await, pour empêcher immédiatement toute nouvelle réclamation de delivery.
      name: 'arrêt du worker diffusion persistante',
      phase: 'persistent_broadcast_job_stop',
      stop: async () => {
        if (isPersistentBroadcastEnabled()) {
          await stopScrimBroadcastDeliveryJob();
        }
      },
    },
    {
      name: 'arrêt du job dashboard réseau',
      phase: 'dashboard_refresh_job_stop',
      stop: stopDashboardRefreshJob,
    },
    {
      name: 'arrêt du job rapport dev quotidien',
      phase: 'daily_dev_report_job_stop',
      stop: stopDailyDevReportJob,
    },
    {
      name: 'arrêt du job retry éditions messages scrim',
      phase: 'edit_retry_job_stop',
      stop: stopDiscordEditRetryJob,
    },
    {
      name: 'arrêt du job repost scrims',
      phase: 'repost_job_stop',
      stop: stopScrimRepostJob,
    },
    {
      name: "arrêt du job d'expiration recherches joueur",
      phase: 'player_search_expiration_job_stop',
      stop: stopPlayerSearchExpirationJob,
    },
    {
      name: "arrêt du job d'expiration scrims",
      phase: 'expiration_job_stop',
      stop: stopScrimExpirationJob,
    },
    {
      name: 'arrêt de la file tâches Discord (scrim)',
      phase: 'discord_task_queue_stop',
      stop: stopDiscordTaskQueue,
    },
  ],
  getClient: () => clientRef,
  closeDb,
});

function registerSignalHandlers() {
  process.on('SIGINT', () => {
    try {
      logger.info('Signal reçu', { signal: 'SIGINT' });
    } catch {
      /* ignore */
    }
    void gracefulShutdown('SIGINT').catch((err) => {
      try {
        logger.error('Arrêt propre — promesse rejetée (gracefulShutdown)', {
          signal: 'SIGINT',
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      } catch {
        /* ignore */
      }
    });
  });
  process.on('SIGTERM', () => {
    try {
      logger.info('Signal reçu', { signal: 'SIGTERM' });
    } catch {
      /* ignore */
    }
    void gracefulShutdown('SIGTERM').catch((err) => {
      try {
        logger.error('Arrêt propre — promesse rejetée (gracefulShutdown)', {
          signal: 'SIGTERM',
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      } catch {
        /* ignore */
      }
    });
  });
}

registerSignalHandlers();

try {
  const { client } = await startBot();
  clientRef = client;
} catch (err) {
  try {
    logger.error('Échec du démarrage du bot', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  } catch {
    /* ignore */
  }
  try {
    closeDb();
  } catch {
    /* closeDb est déjà défensif */
  }
  process.exitCode = 1;
}
