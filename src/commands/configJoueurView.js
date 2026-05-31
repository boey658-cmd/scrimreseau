import { EmbedBuilder, MessageFlags } from 'discord.js';
import {
  interactDeferReply,
  interactEditReply,
  interactReply,
} from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const MSG_NEED_GUILD =
  '❌ Cette commande doit être utilisée sur un serveur.';

const MSG_DB_ERROR =
  '❌ Impossible de lire la configuration. Réessayez plus tard.';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ playerSearchStmts: ReturnType<import('../database/db.js')['preparePlayerSearchStatements']> }} ctx
 */
export async function executeConfigJoueurViewCore(interaction, ctx) {
  try {
    if (!interaction.inGuild()) {
      await interactReply(interaction, {
        content: MSG_NEED_GUILD,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interactDeferReply(interaction, { flags: MessageFlags.Ephemeral });

    const guildId = interaction.guildId;
    let channelRow;
    try {
      channelRow = ctx.playerSearchStmts.getGuildPlayerSearchChannel.get(
        guildId,
      );
    } catch (err) {
      logger.error('player_search:config-view — lecture DB', {
        guild_id: guildId,
        message: err instanceof Error ? err.message : String(err),
      });
      await interactEditReply(interaction, { content: MSG_DB_ERROR });
      return;
    }

    const salonText = channelRow?.channel_id
      ? `<#${channelRow.channel_id}>`
      : 'Aucun salon configuré';

    const embed = new EmbedBuilder()
      .setTitle('⚙️ Configuration Recherche Joueur (ce serveur)')
      .setColor(0x57f287)
      .addFields({
        name: 'Salon de réception',
        value: salonText,
        inline: false,
      })
      .setTimestamp(new Date());

    await interactEditReply(interaction, { embeds: [embed] });

    logger.info('player_search:config-view', {
      guild_id: guildId,
      user_id: interaction.user.id,
    });
  } catch (err) {
    logger.error('player_search:config-view — execute', {
      message: err instanceof Error ? err.message : String(err),
    });
    try {
      if (interaction.deferred) {
        await interactEditReply(interaction, { content: MSG_DB_ERROR });
      } else if (!interaction.replied) {
        await interactReply(interaction, {
          content: MSG_DB_ERROR,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {
      /* ignore */
    }
  }
}
