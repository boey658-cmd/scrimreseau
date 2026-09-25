/**
 * Phase 0.5 — helper commun : commandes config Discord legacy → dashboard.
 * Aucun write DB.
 */

import { MessageFlags } from 'discord.js';
import { getGuildLocale, t } from '../i18n/index.js';
import { buildConfigDashboardRedirectPayload } from '../utils/configDashboardRedirect.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 * @param {string} eventName
 */
export async function replyConfigDashboardRedirect(interaction, ctx, eventName) {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interactReply(interaction, {
      content: t('fr', 'generic.guildOnly'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const locale = getGuildLocale(interaction.guildId, ctx.stmts);
  await interactReply(interaction, buildConfigDashboardRedirectPayload(locale));
  try {
    logger.event(eventName, {
      guild_id: interaction.guildId,
      user_id: interaction.user.id,
      locale,
    });
  } catch {
    /* ignore */
  }
}
