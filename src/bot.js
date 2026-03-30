import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from 'discord.js';
import { commandList } from './commands/index.js';
import { getDb, prepareStatements } from './database/db.js';
import { startDailyDevReportJob } from './services/dailyDevReportJob.js';
import { startDiscordEditRetryJob } from './services/discordEditRetryJob.js';
import { startDiscordTaskQueue } from './services/discordTaskQueue.js';
import { startScrimExpirationJob } from './services/scrimExpirationJob.js';
import {
  interactAutocompleteRespond,
  interactFollowUp,
  interactReply,
} from './utils/interactionDiscord.js';
import { configureDiscordLogger, logger } from './utils/logger.js';

export async function startBot() {
  const token = process.env.DISCORD_TOKEN;
  if (!token || !token.trim()) {
    throw new Error('Variable d’environnement DISCORD_TOKEN manquante ou vide.');
  }

  const db = getDb();
  const stmts = prepareStatements(db);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  /** @type {Collection<string, typeof commandList[number]>} */
  const commands = new Collection();
  for (const cmd of commandList) {
    commands.set(cmd.data.name, cmd);
  }

  client.once(Events.ClientReady, (readyClient) => {
    logger.health(`Bot prêt — connecté en tant que ${readyClient.user.tag}`, {
      guilds: readyClient.guilds.cache.size,
    });
    void configureDiscordLogger(readyClient).catch((err) => {
      try {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[logger] configureDiscordLogger: ${msg}`);
      } catch {
        /* ignore */
      }
    });
    startDiscordTaskQueue();
    startScrimExpirationJob(readyClient, db, stmts);
    startDiscordEditRetryJob(readyClient, stmts);
    startDailyDevReportJob(readyClient, db);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isAutocomplete()) {
      const command = commands.get(interaction.commandName);
      try {
        if (command?.autocomplete) {
          await command.autocomplete(interaction);
        } else {
          await interactAutocompleteRespond(interaction, []);
        }
      } catch (err) {
        logger.error('Erreur autocomplete', {
          command: interaction.commandName,
          user_id: interaction.user.id,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        try {
          await interactAutocompleteRespond(interaction, []);
        } catch (respondErr) {
          logger.error('Échec respond([]) après erreur autocomplete', {
            message:
              respondErr instanceof Error
                ? respondErr.message
                : String(respondErr),
          });
        }
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) return;

    try {
      logger.info('Commande reçue', {
        command: interaction.commandName,
        user_id: interaction.user.id,
        guild_id: interaction.guildId,
      });
      await command.execute(interaction, { stmts, db });
    } catch (err) {
      logger.error('Erreur lors de l’exécution de la commande', {
        command: interaction.commandName,
        user_id: interaction.user.id,
        guild_id: interaction.guildId,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });

      const payload = {
        content: '❌ Une erreur est survenue. Réessaie plus tard.',
        flags: MessageFlags.Ephemeral,
      };

      try {
        if (interaction.replied || interaction.deferred) {
          await interactFollowUp(interaction, payload);
        } else {
          await interactReply(interaction, payload);
        }
      } catch (replyErr) {
        logger.error('Impossible d’envoyer le message d’erreur à l’utilisateur', {
          message:
            replyErr instanceof Error ? replyErr.message : String(replyErr),
        });
      }
    }
  });

  await client.login(token);
  return { client };
}
