/**
 * /language — Configure la langue du bot pour ce serveur (fr ou en).
 *
 * Règles :
 *  - Réservé aux administrateurs du serveur.
 *  - Utilisable même si le serveur n'a pas reçu la validation de réception scrim.
 *  - Réponse éphémère.
 *  - Confirmation dans la nouvelle langue.
 */

import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getGuildLocale, normalizeLocale, t } from '../i18n/index.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

export const language = {
  data: new SlashCommandBuilder()
    .setName('language')
    .setDescription('Set the ScrimRéseau language for this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) =>
      opt
        .setName('language')
        .setDescription('Select the language used by the bot on this server.')
        .setRequired(true)
        .addChoices(
          { name: 'Français', value: 'fr' },
          { name: 'English', value: 'en' },
        ),
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
   */
  async execute(interaction, ctx) {
    // ── Vérification guilde ──────────────────────────────────────────────
    if (!interaction.inGuild() || !interaction.guildId) {
      const locale = getGuildLocale(null, null);
      await interactReply(interaction, {
        content: t(locale, 'generic.guildOnly'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildId = interaction.guildId;

    // ── Vérification administrateur ──────────────────────────────────────
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      const locale = getGuildLocale(guildId, ctx.stmts);
      await interactReply(interaction, {
        content: t(locale, 'generic.adminOnly'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const rawLang = interaction.options.getString('language', true);
    const newLocale = normalizeLocale(rawLang);

    // ── Sauvegarde ───────────────────────────────────────────────────────
    try {
      ctx.stmts.upsertGuildLanguage.run(guildId, newLocale);
    } catch (err) {
      logger.error('/language — erreur DB', {
        guild_id: guildId,
        language: newLocale,
        message: err instanceof Error ? err.message : String(err),
      });
      // On répond dans l'ancienne langue (la nouvelle n'a pas été sauvegardée)
      const oldLocale = getGuildLocale(guildId, ctx.stmts);
      await interactReply(interaction, {
        content: t(oldLocale, 'generic.error'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    logger.event('/language', {
      guild_id: guildId,
      user_id: interaction.user.id,
      language: newLocale,
    });

    // ── Confirmation dans la NOUVELLE langue ────────────────────────────
    const confirmKey = newLocale === 'en' ? 'language.successEn' : 'language.successFr';
    await interactReply(interaction, {
      content: t(newLocale, confirmKey),
      flags: MessageFlags.Ephemeral,
    });
  },
};
