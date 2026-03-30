import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import {
  commandListWithoutDev,
  scrimDev,
} from '../src/commands/index.js';
import { logger } from '../src/utils/logger.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

/**
 * @param {string | undefined} raw
 * @returns {string[]}
 */
function parseGuildIds(raw) {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/** `1`, `true`, `yes` (insensible à la casse) → vrai. Désactivé par défaut. */
function envTruthy(key) {
  const v = process.env[key]?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

if (!token?.trim()) {
  logger.error('DISCORD_TOKEN requis pour déployer les commandes.');
  process.exit(1);
}
if (!clientId?.trim()) {
  logger.error('CLIENT_ID requis (ID de l’application Discord).');
  process.exit(1);
}

const publicBody = commandListWithoutDev.map((c) => c.data.toJSON());
const scrimDevBody = [scrimDev.data.toJSON()];
const devGuildId = process.env.DEV_GUILD_ID?.trim() ?? '';

if (!devGuildId) {
  logger.warn(
    'DEV_GUILD_ID absent : /scrim-dev ne sera enregistrée sur aucune guilde (commande ignorée au déploiement).',
  );
}

const fromList = parseGuildIds(process.env.GUILD_IDS);
const legacySingle = process.env.GUILD_ID?.trim() ?? '';
const guildIds =
  fromList.length > 0
    ? fromList
    : legacySingle
      ? [legacySingle]
      : [];

const mode = guildIds.length > 0 ? 'guild' : 'global';

/** Nettoyage manuel complet : global + (en mode guilde) chaque guilde ciblée. */
const clearAllBeforeDeploy = envTruthy('CLEAR_ALL_COMMANDS_BEFORE_DEPLOY');
/** Nettoyage guilde seul (sans toucher au global), uniquement en mode guilde. */
const clearGuildOnlyBeforeDeploy = envTruthy('CLEAR_GUILD_COMMANDS_BEFORE_DEPLOY');

const preClearGlobalCommands = clearAllBeforeDeploy;
const preClearGuildCommands =
  mode === 'guild' && (clearAllBeforeDeploy || clearGuildOnlyBeforeDeploy);

/** Guildes à vider avant redéploiement (inclut la guilde dev si définie). */
const guildsToClearSet = new Set(guildIds);
if (devGuildId) {
  guildsToClearSet.add(devGuildId);
}
const guildsToClear =
  preClearGuildCommands && guildsToClearSet.size > 0
    ? [...guildsToClearSet]
    : preClearGuildCommands
      ? [...guildIds]
      : [];

logger.info('Déploiement slash — résumé', {
  mode,
  publicCommandCount: publicBody.length,
  scrimDevGuildOnly: Boolean(devGuildId),
  publicCommandNames: commandListWithoutDev.map((c) => c.data.name),
  clearGlobalBeforeDeploy: preClearGlobalCommands,
  clearGuildBeforeDeploy: preClearGuildCommands,
  ...(guildIds.length > 0 ? { targetGuilds: guildIds } : {}),
  ...(devGuildId ? { devGuildId } : {}),
});

const rest = new REST({ version: '10' }).setToken(token);

try {
  if (preClearGlobalCommands) {
    try {
      await rest.put(Routes.applicationCommands(clientId), { body: [] });
      logger.info('Commandes globales supprimées');
    } catch (err) {
      logger.error('Échec de la suppression des commandes globales', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      process.exit(1);
    }
  }

  if (preClearGuildCommands) {
    const failedGuildClears = [];

    for (const guildId of guildsToClear) {
      try {
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
          body: [],
        });
        logger.info(`Commandes supprimées pour la guilde ${guildId}`);
      } catch (err) {
        logger.error('Échec de la suppression des commandes sur une guilde', {
          guildId,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        failedGuildClears.push(guildId);
      }
    }

    if (failedGuildClears.length > 0) {
      logger.error('Suppression guilde interrompue — au moins une guilde a échoué', {
        failedCount: failedGuildClears.length,
        failedGuilds: failedGuildClears,
      });
      process.exit(1);
    }
  }

  if (guildIds.length > 0) {
    const failedGuilds = [];

    for (const guildId of guildIds) {
      try {
        const body =
          devGuildId && guildId === devGuildId
            ? [...publicBody, ...scrimDevBody]
            : publicBody;
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
          body,
        });
        logger.info(`Déploiement sur guilde ${guildId} réussi`, {
          includesScrimDev: Boolean(devGuildId && guildId === devGuildId),
        });
      } catch (err) {
        logger.error('Échec du déploiement sur une guilde', {
          guildId,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        failedGuilds.push(guildId);
      }
    }

    if (devGuildId && !guildIds.includes(devGuildId)) {
      try {
        await rest.put(
          Routes.applicationGuildCommands(clientId, devGuildId),
          {
            body: [...publicBody, ...scrimDevBody],
          },
        );
        logger.info(
          `Déploiement guilde dev ${devGuildId} (liste complète incluant /scrim-dev)`,
        );
      } catch (err) {
        logger.error('Échec du déploiement sur la guilde dev', {
          guildId: devGuildId,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        failedGuilds.push(devGuildId);
      }
    }

    if (failedGuilds.length > 0) {
      logger.error('Déploiement guilde terminé avec erreurs', {
        failedCount: failedGuilds.length,
        failedGuilds,
      });
      process.exit(1);
    }

    logger.info('Tous les déploiements sur guildes sont OK', {
      guildCount: guildIds.length,
    });
  } else {
    logger.info(
      'Déploiement des commandes (global — propagation pouvant prendre jusqu’à ~1 h)',
    );
    await rest.put(Routes.applicationCommands(clientId), { body: publicBody });
    logger.info('Déploiement global enregistré avec succès', {
      commandCount: publicBody.length,
    });

    if (devGuildId) {
      await rest.put(
        Routes.applicationGuildCommands(clientId, devGuildId),
        { body: scrimDevBody },
      );
      logger.info(
        `/scrim-dev enregistrée uniquement sur la guilde dev ${devGuildId}`,
      );
    }
  }
} catch (err) {
  logger.error('Échec du déploiement des commandes', {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
}
