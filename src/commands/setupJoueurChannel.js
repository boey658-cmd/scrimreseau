import { MessageFlags } from 'discord.js';
import {
  assertBotCanPostInChannel,
  MSG_BOT_PERMISSIONS_SALON_INSUFFISANTES,
} from '../services/channelPermissions.js';
import {
  buildPlayerSearchReceptionConfigRefusalContent,
  mayConfigurePlayerSearchReceptionChannel,
} from '../utils/guildPlayerSearchReceptionGate.js';
import {
  interactDeferReply,
  interactEditReply,
  interactReply,
} from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const MSG_ERREUR_GENERIC =
  '❌ Une erreur est survenue pendant la configuration. Réessayez plus tard.';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{
 *   stmts: ReturnType<import('../database/db.js')['prepareStatements']>,
 *   playerSearchStmts: ReturnType<import('../database/db.js')['preparePlayerSearchStatements']>,
 * }} ctx
 */
export async function executeSetupJoueurChannelCore(interaction, ctx) {
  try {
    await interactDeferReply(interaction, { flags: MessageFlags.Ephemeral });

    if (!interaction.inGuild()) {
      await interactEditReply(interaction, {
        content: '❌ Cette commande doit être utilisée sur un serveur.',
      });
      return;
    }

    const guildId = interaction.guildId;
    const bypassRow = guildId
      ? ctx.stmts.getGuildScrimReceptionBypass.get(guildId)
      : undefined;
    if (!mayConfigurePlayerSearchReceptionChannel(bypassRow)) {
      logger.info('player_search:setup-channel — réception non validée', {
        guild_id: guildId,
      });
      await interactEditReply(interaction, {
        content: buildPlayerSearchReceptionConfigRefusalContent(),
      });
      return;
    }

    const channel = interaction.options.getChannel('salon', true);

    let botMember = interaction.guild.members.me;
    if (!botMember) {
      botMember = await interaction.guild.members.fetchMe().catch(() => null);
    }

    const check = assertBotCanPostInChannel(channel, botMember ?? null);
    if (!check.ok) {
      const content =
        check.error === MSG_BOT_PERMISSIONS_SALON_INSUFFISANTES
          ? check.error
          : `❌ ${check.error}`;
      await interactEditReply(interaction, { content });
      return;
    }

    ctx.playerSearchStmts.upsertGuildPlayerSearchChannel.run({
      guild_id: interaction.guildId,
      channel_id: channel.id,
      created_at: Date.now(),
    });

    logger.event('player_search:setup-channel', {
      guild_id: interaction.guildId,
      channel_id: channel.id,
      user_id: interaction.user.id,
    });

    await interactEditReply(interaction, {
      content: `✅ Salon Recherche Joueur configuré : <#${channel.id}>.`,
    });
  } catch (err) {
    logger.error('player_search:setup-channel — erreur', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    try {
      if (interaction.deferred) {
        await interactEditReply(interaction, { content: MSG_ERREUR_GENERIC });
      } else {
        await interactReply(interaction, {
          content: MSG_ERREUR_GENERIC,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {
      /* ignore */
    }
  }
}
