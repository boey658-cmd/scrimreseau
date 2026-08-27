/**
 * /language — Configure la langue du bot pour ce serveur (7 locales).
 *
 * Règles :
 *  - Réservé aux administrateurs du serveur.
 *  - Utilisable même si le serveur n'a pas reçu la validation de réception scrim.
 *  - Réponse éphémère.
 *  - Confirmation dans la nouvelle langue.
 *  - Ne jamais utiliser interaction.locale pour les réponses bot.
 */

import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  ENABLED_GUILD_LOCALES,
  getGuildLocale,
  normalizeEnabledGuildLocale,
  t,
} from '../i18n/index.js';
import {
  applyDescriptionLocalizations,
  applyOptionLocalizations,
  localizedChoice,
  slashMeta,
} from '../i18n/slashLocalizations.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const meta = slashMeta.language;

export const language = {
  data: applyDescriptionLocalizations(
    new SlashCommandBuilder()
      .setName('language')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((opt) =>
        applyOptionLocalizations(
          opt.setName('language').setRequired(true).addChoices(
            localizedChoice('fr', meta.choices.fr),
            localizedChoice('en', meta.choices.en),
            localizedChoice('es', meta.choices.es),
            localizedChoice('de', meta.choices.de),
            localizedChoice('it', meta.choices.it),
            localizedChoice('pl', meta.choices.pl),
            localizedChoice('pt', meta.choices.pt),
          ),
          meta.options.language,
        ),
      ),
    meta.description,
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
    if (
      typeof rawLang !== 'string' ||
      !ENABLED_GUILD_LOCALES.includes(/** @type {any} */ (rawLang))
    ) {
      const locale = getGuildLocale(guildId, ctx.stmts);
      await interactReply(interaction, {
        content: t(locale, 'language.invalidChoice'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const newLocale = normalizeEnabledGuildLocale(rawLang);

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
    await interactReply(interaction, {
      content: t(newLocale, 'language.success'),
      flags: MessageFlags.Ephemeral,
    });
  },
};
