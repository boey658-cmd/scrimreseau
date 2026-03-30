import 'dotenv/config';
import { startBot } from './src/bot.js';
import { closeDb } from './src/database/db.js';
import { stopDailyDevReportJob } from './src/services/dailyDevReportJob.js';
import { stopDiscordEditRetryJob } from './src/services/discordEditRetryJob.js';
import { stopDiscordTaskQueue } from './src/services/discordTaskQueue.js';
import { stopScrimExpirationJob } from './src/services/scrimExpirationJob.js';
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

/** Politique : journaliser chaque rejet non géré (visibilité prod). Pas de sortie immédiate — évite d’arrêter le bot sur une promesse oubliée isolée ; préférer corriger la source une fois identifiée via les logs. */
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

/** Évite deux shutdowns concurrents (double SIGINT / SIGTERM + autre). */
let isShuttingDown = false;
/** Référence au client Discord après démarrage réussi. */
let clientRef = /** @type {import('discord.js').Client | null} */ (null);

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  try {
    logger.health('Arrêt propre — début', { signal, phase: 'shutdown_start' });
  } catch {
    /* ignore */
  }

  try {
    logger.info('Arrêt propre — arrêt du job rapport dev quotidien', {
      phase: 'daily_dev_report_job_stop',
    });
    stopDailyDevReportJob();
  } catch (err) {
    try {
      logger.error('Arrêt propre — échec stopDailyDevReportJob', {
        phase: 'daily_dev_report_job_stop_error',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    } catch {
      /* ignore */
    }
  }

  try {
    logger.info('Arrêt propre — arrêt du job retry éditions messages scrim', {
      phase: 'edit_retry_job_stop',
    });
    await stopDiscordEditRetryJob();
  } catch (err) {
    try {
      logger.error('Arrêt propre — échec stopDiscordEditRetryJob', {
        phase: 'edit_retry_job_stop_error',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    } catch {
      /* ignore */
    }
  }

  try {
    logger.info('Arrêt propre — arrêt du job d’expiration scrims', {
      phase: 'expiration_job_stop',
    });
    await stopScrimExpirationJob();
  } catch (err) {
    try {
      logger.error('Arrêt propre — échec stopScrimExpirationJob', {
        phase: 'expiration_job_stop_error',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    } catch {
      /* ignore */
    }
  }

  try {
    logger.info('Arrêt propre — arrêt de la file tâches Discord (scrim)', {
      phase: 'discord_task_queue_stop',
    });
    await stopDiscordTaskQueue();
  } catch (err) {
    try {
      logger.error('Arrêt propre — échec stopDiscordTaskQueue', {
        phase: 'discord_task_queue_stop_error',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    } catch {
      /* ignore */
    }
  }

  try {
    if (clientRef) {
      try {
        logger.info('Arrêt propre — fermeture du client Discord', { phase: 'client_destroy' });
        await clientRef.destroy();
        try {
          logger.info('Arrêt propre — client Discord fermé', { phase: 'client_closed' });
        } catch {
          /* ignore */
        }
      } catch (err) {
        try {
          logger.error('Arrêt propre — échec client.destroy()', {
            phase: 'client_destroy_error',
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
        } catch {
          /* ignore */
        }
      }
    }
  } catch (err) {
    try {
      logger.error('Arrêt propre — erreur enveloppe client', {
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
  }

  try {
    logger.info('Arrêt propre — fermeture SQLite', { phase: 'db_close_start' });
    closeDb();
    try {
      logger.info('Arrêt propre — SQLite traitée', { phase: 'db_close_done' });
    } catch {
      /* ignore */
    }
  } catch (err) {
    try {
      logger.error('Arrêt propre — erreur enveloppe closeDb', {
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
  }

  try {
    logger.health('Arrêt propre — fin', { signal, phase: 'shutdown_end' });
  } catch {
    /* ignore */
  }

  process.exit(0);
}

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
