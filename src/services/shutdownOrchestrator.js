import { logger } from '../utils/logger.js';

/**
 * Crée un gestionnaire de graceful shutdown idempotent.
 *
 * Garanties :
 * - Une seule séquence d'arrêt s'exécute, même si le signal est reçu plusieurs fois
 *   (SIGINT + SIGTERM simultanés, double SIGINT, etc.).
 * - Chaque étape est exécutée dans l'ordre déclaré.
 * - Un échec d'étape est journalisé mais n'arrête pas les étapes suivantes.
 * - Le client Discord est détruit après tous les jobs.
 * - SQLite est fermée en dernier.
 *
 * @param {{
 *   steps: Array<{
 *     name: string,
 *     phase: string,
 *     stop: () => void | Promise<void>,
 *   }>,
 *   getClient: () => ({ destroy: () => void | Promise<void> } | null | undefined),
 *   closeDb: () => void,
 *   onExit?: (code: number) => void,
 * }} deps
 * @returns {(signal: string) => Promise<void>}
 */
export function createGracefulShutdown({ steps, getClient, closeDb, onExit }) {
  const _onExit = onExit ?? ((code) => process.exit(code));

  /** @type {Promise<void> | null} */
  let shutdownPromise = null;

  async function performShutdown(signal) {
    try {
      logger.health('Arrêt propre — début', { signal, phase: 'shutdown_start' });
    } catch { /* ignore */ }

    for (const step of steps) {
      try {
        logger.info(`Arrêt propre — ${step.name}`, { phase: step.phase });
        await step.stop();
      } catch (err) {
        try {
          logger.error(`Arrêt propre — échec ${step.name}`, {
            phase: `${step.phase}_error`,
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
        } catch { /* ignore */ }
      }
    }

    // Détruire le client Discord après tous les jobs
    try {
      const client = getClient();
      if (client) {
        try {
          logger.info('Arrêt propre — fermeture du client Discord', { phase: 'client_destroy' });
        } catch { /* ignore */ }
        await client.destroy();
        try {
          logger.info('Arrêt propre — client Discord fermé', { phase: 'client_closed' });
        } catch { /* ignore */ }
      }
    } catch (err) {
      try {
        logger.error('Arrêt propre — échec client.destroy()', {
          phase: 'client_destroy_error',
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      } catch { /* ignore */ }
    }

    // Fermer SQLite en dernier
    try {
      try {
        logger.info('Arrêt propre — fermeture SQLite', { phase: 'db_close_start' });
      } catch { /* ignore */ }
      closeDb();
      try {
        logger.info('Arrêt propre — SQLite traitée', { phase: 'db_close_done' });
      } catch { /* ignore */ }
    } catch (err) {
      try {
        logger.error('Arrêt propre — erreur enveloppe closeDb', {
          message: err instanceof Error ? err.message : String(err),
        });
      } catch { /* ignore */ }
    }

    try {
      logger.health('Arrêt propre — fin', { signal, phase: 'shutdown_end' });
    } catch { /* ignore */ }

    _onExit(0);
  }

  return function gracefulShutdown(signal) {
    if (!shutdownPromise) {
      shutdownPromise = performShutdown(signal);
    }
    return shutdownPromise;
  };
}
