import { MessageFlags } from 'discord.js';
import { UI_PRIMARY_GAME_KEY } from '../config/games.js';
import {
  assertBotCanPostInChannel,
  MSG_BOT_PERMISSIONS_SALON_INSUFFISANTES,
} from '../services/channelPermissions.js';
import {
  interactDeferReply,
  interactEditReply,
  interactFollowUp,
  interactReply,
} from '../utils/interactionDiscord.js';
import {
  buildScrimReceptionConfigRefusalContent,
  mayConfigureScrimReceptionChannel,
} from '../utils/guildScrimReceptionGate.js';
import { logger } from '../utils/logger.js';

const DEBUG = 'DEBUG setup-scrim-channel';

const MSG_ERREUR_GENERIC =
  '❌ Une erreur est survenue pendant la configuration. Réessayez plus tard ou contactez un administrateur.';

async function envoyerReponseErreurFinale(interaction) {
  try {
    if (interaction.deferred) {
      await interactEditReply(interaction, { content: MSG_ERREUR_GENERIC });
    } else if (!interaction.replied) {
      await interactReply(interaction, {
        content: MSG_ERREUR_GENERIC,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interactFollowUp(interaction, {
        content: MSG_ERREUR_GENERIC,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    logger.error('setup-scrim-channel — impossible d’envoyer le message d’erreur final', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeSetupScrimChannelCore(interaction, ctx) {
  try {
    await interactDeferReply(interaction, { flags: MessageFlags.Ephemeral });

    logger.info(DEBUG, { step: 'debut', user_id: interaction.user.id, guild_id: interaction.guildId });

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
    if (
      !mayConfigureScrimReceptionChannel(
        interaction.guild?.memberCount,
        bypassRow,
      )
    ) {
      await interactEditReply(interaction, {
        content: buildScrimReceptionConfigRefusalContent(),
      });
      return;
    }

    const channel = interaction.options.getChannel('salon', true);
    const gameKey = UI_PRIMARY_GAME_KEY;

    logger.info(DEBUG, {
      step: 'salon_recu',
      channel_id: channel?.id,
      channel_type: channel?.type,
    });
    logger.info(DEBUG, { step: 'game_key', game_key: gameKey });

    let botMember = interaction.guild.members.me;
    if (!botMember) {
      botMember = await interaction.guild.members.fetchMe().catch(() => null);
    }

    const check = assertBotCanPostInChannel(channel, botMember ?? null);
    logger.info(DEBUG, {
      step: 'check_permissions',
      ok: check.ok,
      error: check.ok ? undefined : check.error,
    });

    if (!check.ok) {
      const content =
        check.error === MSG_BOT_PERMISSIONS_SALON_INSUFFISANTES
          ? check.error
          : `❌ ${check.error}`;
      await interactEditReply(interaction, { content });
      return;
    }

    const now = Date.now();
    logger.info(DEBUG, { step: 'avant_ecriture_db', guild_id: interaction.guildId, channel_id: channel.id });

    ctx.stmts.upsertGuildChannel.run({
      guild_id: interaction.guildId,
      channel_id: channel.id,
      game_key: gameKey,
      created_at: now,
    });

    logger.info(DEBUG, { step: 'apres_ecriture_db' });

    logger.event('setup-scrim-channel', {
      guild_id: interaction.guildId,
      channel_id: channel.id,
      game_key: gameKey,
      user_id: interaction.user.id,
    });

    logger.info(DEBUG, { step: 'avant_editreply_final' });
    await interactEditReply(interaction, {
      content: `✅ Salon de diffusion des scrims League of Legends configuré : <#${channel.id}>.`,
    });
  } catch (err) {
    logger.error('setup-scrim-channel — erreur', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    await envoyerReponseErreurFinale(interaction);
  }
}
