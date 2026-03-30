import { ChannelType, MessageFlags } from 'discord.js';
import {
  interactDeferReply,
  interactEditReply,
  interactReply,
} from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const MSG_NEED_GUILD =
  '❌ Cette commande doit être utilisée sur un serveur.';

const MSG_BAD_CHANNEL_TYPE =
  '❌ Choisis un salon texte ou une annonce.';

const MSG_DB_ERROR =
  '❌ Impossible d’enregistrer la configuration. Réessayez plus tard.';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
 */
export async function executeConfigScrimChannelUsageCore(interaction, ctx) {
    try {
      if (!interaction.inGuild()) {
        await interactReply(interaction, { content: MSG_NEED_GUILD, flags: MessageFlags.Ephemeral });
        return;
      }

      await interactDeferReply(interaction, { flags: MessageFlags.Ephemeral });

      const guildId = interaction.guildId;
      const channel = interaction.options.getChannel('salon', true);

      if (
        channel.type !== ChannelType.GuildText
        && channel.type !== ChannelType.GuildAnnouncement
      ) {
        await interactEditReply(interaction, { content: MSG_BAD_CHANNEL_TYPE });
        return;
      }

      try {
        ctx.stmts.upsertScrimUsageChannel.run({
          guild_id: guildId,
          channel_id: channel.id,
        });
      } catch (err) {
        logger.error('config-scrim-channel-usage — écriture', {
          guild_id: guildId,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        await interactEditReply(interaction, { content: MSG_DB_ERROR });
        return;
      }

      logger.info('config-scrim-channel-usage', {
        guild_id: guildId,
        channel_id: channel.id,
        user_id: interaction.user.id,
      });

      await interactEditReply(interaction, {
        content: `✅ La commande /recherche-scrim est maintenant autorisée dans : <#${channel.id}>.`,
      });
    } catch (err) {
      logger.error('config-scrim-channel-usage — execute', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      try {
        if (interaction.deferred) {
          await interactEditReply(interaction, { content: MSG_DB_ERROR });
        } else if (!interaction.replied) {
          await interactReply(interaction, { content: MSG_DB_ERROR, flags: MessageFlags.Ephemeral });
        }
      } catch (replyErr) {
        logger.error('config-scrim-channel-usage — impossible de répondre', {
          message:
            replyErr instanceof Error ? replyErr.message : String(replyErr),
        });
      }
    }
}
