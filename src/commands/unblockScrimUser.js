import { MessageFlags } from 'discord.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeUnblockScrimUserCore(interaction, ctx) {
  if (!interaction.inGuild()) {
    await interactReply(interaction, {
      content: '❌ Cette commande doit être utilisée sur un serveur.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const user = interaction.options.getUser('utilisateur', true);

  const info = ctx.stmts.unblockUser.run(interaction.guildId, user.id);

  if (info.changes === 0) {
    await interactReply(interaction, {
      content: `ℹ️ **${user.tag}** n’était pas bloqué pour les scrims.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  logger.event('unblock-scrim-user', {
    guild_id: interaction.guildId,
    target_user_id: user.id,
    moderator_id: interaction.user.id,
  });

  await interactReply(interaction, {
    content: `✅ Les annonces de **${user.tag}** pourront à nouveau être diffusées sur ce serveur.`,
    flags: MessageFlags.Ephemeral,
  });
}
