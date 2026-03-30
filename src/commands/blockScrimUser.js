import { MessageFlags } from 'discord.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeBlockScrimUserCore(interaction, ctx) {
  if (!interaction.inGuild()) {
    await interactReply(interaction, {
      content: '❌ Cette commande doit être utilisée sur un serveur.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const user = interaction.options.getUser('utilisateur', true);

  if (user.id === interaction.client.user?.id) {
    await interactReply(interaction, {
      content: '❌ Vous ne pouvez pas bloquer le bot.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const now = Date.now();
  const info = ctx.stmts.blockUser.run(interaction.guildId, user.id, now);

  if (info.changes === 0) {
    await interactReply(interaction, {
      content: `ℹ️ **${user.tag}** est déjà bloqué pour les scrims sur ce serveur.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  logger.event('block-scrim-user', {
    guild_id: interaction.guildId,
    target_user_id: user.id,
    moderator_id: interaction.user.id,
  });

  await interactReply(interaction, {
    content: `✅ Les annonces de **${user.tag}** ne seront plus diffusées sur ce serveur.`,
    flags: MessageFlags.Ephemeral,
  });
}
