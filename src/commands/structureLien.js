import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getGuildLocale, t } from '../i18n/index.js';
import {
  applyDescriptionLocalizations,
  applyOptionLocalizations,
  slashMeta,
} from '../i18n/slashLocalizations.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';
import { validateDiscordInviteUrl } from '../utils/validation.js';

const meta = slashMeta.structureLink;

export const structureLien = {
  data: applyDescriptionLocalizations(
    new SlashCommandBuilder()
      .setName('structure-link')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((sub) =>
        applyDescriptionLocalizations(
          sub
            .setName('set')
            .addStringOption((opt) =>
              applyOptionLocalizations(
                opt.setName('lien').setRequired(true),
                meta.options.lien,
              ),
            ),
          meta.subSet.description,
        ),
      )
      .addSubcommand((sub) =>
        applyDescriptionLocalizations(
          sub.setName('remove'),
          meta.subRemove.description,
        ),
      ),
    meta.description,
  ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
   */
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) {
      await interactReply(interaction, {
        content: t('fr', 'structureLink.guildOnly'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildId = interaction.guildId;
    const locale = getGuildLocale(guildId, ctx.stmts);
    const sub = interaction.options.getSubcommand(true);

    // ── /structure-link set ───────────────────────────────────────────────
    if (sub === 'set') {
      const lienRaw = interaction.options.getString('lien', true);
      const res = validateDiscordInviteUrl(lienRaw);

      if (!res.ok) {
        await interactReply(interaction, {
          content: res.errorCode ? t(locale, res.errorCode) : `❌ ${res.error}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      try {
        ctx.stmts.upsertStructureDiscordLink.run({
          guild_id: guildId,
          discord_invite_url: res.value,
          updated_at: new Date().toISOString(),
          updated_by: interaction.user.id,
        });
      } catch (err) {
        logger.error('structure-lien set — erreur DB', {
          guild_id: guildId,
          message: err instanceof Error ? err.message : String(err),
        });
        await interactReply(interaction, {
          content: t(locale, 'structureLink.dbErrorSet'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      logger.info('structure-lien set', {
        guild_id: guildId,
        user_id: interaction.user.id,
        url: res.value,
      });

      await interactReply(interaction, {
        content: t(locale, 'structureLink.setSuccess'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // ── /structure-link remove ────────────────────────────────────────────
    if (sub === 'remove') {
      let changes = 0;
      try {
        const info = ctx.stmts.deleteStructureDiscordLink.run(guildId);
        changes = info.changes;
      } catch (err) {
        logger.error('structure-lien remove — erreur DB', {
          guild_id: guildId,
          message: err instanceof Error ? err.message : String(err),
        });
        await interactReply(interaction, {
          content: t(locale, 'structureLink.dbErrorRemove'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (changes === 0) {
        await interactReply(interaction, {
          content: t(locale, 'structureLink.removeNotFound'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      logger.info('structure-lien remove', {
        guild_id: guildId,
        user_id: interaction.user.id,
      });

      await interactReply(interaction, {
        content: t(locale, 'structureLink.removeSuccess'),
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
