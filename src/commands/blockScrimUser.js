import { MessageFlags } from 'discord.js';
import { t } from '../i18n/index.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 * @param {string} [locale='fr']
 */
export async function executeBlockScrimUserCore(interaction, ctx, locale = 'fr') {
  if (!interaction.inGuild()) {
    await interactReply(interaction, {
      content: t(locale, 'generic.guildOnly'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const user = interaction.options.getUser('utilisateur', true);

  if (user.id === interaction.client.user?.id) {
    await interactReply(interaction, {
      content: t(locale, 'scrimModeration.blockBot'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const now = Date.now();
  const info = ctx.stmts.blockUser.run(interaction.guildId, user.id, now);

  if (info.changes === 0) {
    await interactReply(interaction, {
      content: t(locale, 'scrimModeration.alreadyBlocked', { tag: user.tag }),
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
    content: t(locale, 'scrimModeration.blockSuccess', { tag: user.tag }),
    flags: MessageFlags.Ephemeral,
  });
}
