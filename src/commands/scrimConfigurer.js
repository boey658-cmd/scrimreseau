/**
 * /scrim-config — redirection dashboard (Phase 0.5).
 *
 * Aucune écriture DB. Aucun menu de configuration Discord.
 * Unique réponse : message localisé + bouton vers le dashboard ScrimRéseau.
 *
 * LEGACY (pré-E2E audit) : les modules `configScrim*` exposent encore des helpers
 * transactionnels utilisés UNIQUEMENT par `guildConfigWrites` (HTTP). Les `execute*`
 * slash ne font que redirect — aucun chemin utilisateur Discord n’écrit via ces
 * helpers hors `/language`. Cleanup structurel reporté après tests manuels.
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

export const scrimConfigurer = {
  data: applyDescriptionLocalizations(
    new SlashCommandBuilder()
      .setName('scrim-config')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    slashMeta.scrimConfig.description,
  ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
   */
  async execute(interaction, ctx) {
    const ok = await assertGuildAdministrator(interaction);
    if (!ok) return;

    if (!interaction.guild || !interaction.guildId) {
      await interactReply(interaction, {
        content: t('fr', 'generic.guildOnly'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildId = interaction.guildId;
    const locale = getGuildLocale(guildId, ctx.stmts);

    try {
      const payload = buildConfigDashboardRedirectPayload(locale);
      await interactReply(interaction, payload);
      logger.event('scrim-config.redirect', {
        guild_id: guildId,
        user_id: interaction.user.id,
        locale,
      });
    } catch (err) {
      logger.error('scrim-config.redirect failed', {
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
