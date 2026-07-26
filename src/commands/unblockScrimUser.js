import { MessageFlags } from 'discord.js';
import { t } from '../i18n/index.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 * @param {string} [locale='fr']
 */
export async function executeUnblockScrimUserCore(interaction, ctx, locale = 'fr') {
  if (!interaction.inGuild()) {
    await interactReply(interaction, {
      content: t(locale, 'generic.guildOnly'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const user = interaction.options.getUser('utilisateur', true);

  const info = ctx.stmts.unblockUser.run(interaction.guildId, user.id);

  if (info.changes === 0) {
    await interactReply(interaction, {
      content: t(locale, 'scrimModeration.notBlocked', { tag: user.tag }),
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
    content: t(locale, 'scrimModeration.unblockSuccess', { tag: user.tag }),
    flags: MessageFlags.Ephemeral,
  });
}
