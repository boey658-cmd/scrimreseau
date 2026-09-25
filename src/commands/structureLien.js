/**
 * /structure-link — redirection dashboard (Phase 0.5).
 *
 * La config structure se gère uniquement via le dashboard.
 * Aucune écriture DB depuis Discord.
 */

import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getGuildLocale, t } from '../i18n/index.js';
import {
  applyDescriptionLocalizations,
  slashMeta,
} from '../i18n/slashLocalizations.js';
import { assertGuildAdministrator } from '../utils/guildAdministratorGuard.js';
import { buildConfigDashboardRedirectPayload } from '../utils/configDashboardRedirect.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

export const structureLien = {
  data: applyDescriptionLocalizations(
    new SlashCommandBuilder()
      .setName('structure-link')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    slashMeta.structureLink.description,
  ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
   */
  async execute(interaction, ctx) {
    const ok = await assertGuildAdministrator(interaction);
    if (!ok) return;

    if (!interaction.inGuild() || !interaction.guildId) {
      await interactReply(interaction, {
        content: t('fr', 'structureLink.guildOnly'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildId = interaction.guildId;
    const locale = getGuildLocale(guildId, ctx.stmts);

    try {
      const payload = buildConfigDashboardRedirectPayload(locale, {
        titleKey: 'structureLink.redirectTitle',
        descriptionKey: 'structureLink.redirectDescription',
        buttonKey: 'structureLink.redirectButton',
      });
      await interactReply(interaction, payload);
      logger.event('structure-link.redirect', {
        guild_id: guildId,
        user_id: interaction.user.id,
        locale,
      });
    } catch (err) {
      logger.error('structure-link.redirect failed', {
        guild_id: guildId,
        message: err instanceof Error ? err.message : String(err),
      });
      try {
        await interactReply(interaction, {
          content: t(locale, 'generic.error'),
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        /* ignore */
      }
    }
  },
};
