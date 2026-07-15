import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';
import { validateDiscordInviteUrl } from '../utils/validation.js';

export const structureLien = {
  data: new SlashCommandBuilder()
    .setName('structure-lien')
    .setDescription('Gère le lien Discord public de votre structure partenaire ScrimRéseau')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Définit le lien d\'invitation Discord de votre structure')
        .addStringOption((opt) =>
          opt
            .setName('lien')
            .setDescription('Lien d\'invitation Discord (ex. https://discord.gg/xxxx)')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Retire le lien Discord de votre structure'),
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
   */
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) {
      await interactReply(interaction, {
        content: '❌ Cette commande ne peut être utilisée que dans un serveur.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand(true);

    // ── /structure-lien set ───────────────────────────────────────────────
    if (sub === 'set') {
      const lienRaw = interaction.options.getString('lien', true);
      const res = validateDiscordInviteUrl(lienRaw);

      if (!res.ok) {
        await interactReply(interaction, {
          content: `❌ ${res.error}`,
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
          content: '❌ Une erreur est survenue lors de l\'enregistrement. Réessayez plus tard.',
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
        content: '✅ Lien Discord de la structure enregistré.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // ── /structure-lien remove ────────────────────────────────────────────
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
          content: '❌ Une erreur est survenue lors de la suppression. Réessayez plus tard.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (changes === 0) {
        await interactReply(interaction, {
          content: 'ℹ️ Aucun lien Discord n\'était configuré pour cette structure.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      logger.info('structure-lien remove', {
        guild_id: guildId,
        user_id: interaction.user.id,
      });

      await interactReply(interaction, {
        content: '✅ Lien Discord de la structure retiré.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
