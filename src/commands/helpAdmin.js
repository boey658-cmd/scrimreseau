import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getEmbedColorForGame } from '../config/gameEmbedColors.js';
import { getGuildLocale, t } from '../i18n/index.js';
import {
  applyDescriptionLocalizations,
  slashMeta,
} from '../i18n/slashLocalizations.js';
import { assertGuildAdministrator } from '../utils/guildAdministratorGuard.js';
import { interactReply } from '../utils/interactionDiscord.js';

const EMBED_COLOR = getEmbedColorForGame('');

export const helpAdmin = {
  data: applyDescriptionLocalizations(
    new SlashCommandBuilder()
      .setName('helpadmin-scrim')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    slashMeta.helpAdminScrim.description,
  ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
   */
  async execute(interaction, ctx) {
    const ok = await assertGuildAdministrator(interaction);
    if (!ok) return;

    const locale = getGuildLocale(interaction.guildId ?? '', ctx.stmts);

    const embed = new EmbedBuilder()
      .setTitle(t(locale, 'helpAdmin.title'))
      .setDescription(t(locale, 'helpAdmin.description'))
      .setColor(EMBED_COLOR)
      .addFields(
        { name: t(locale, 'helpAdmin.scrimConfigTitle'), value: t(locale, 'helpAdmin.scrimConfigValue') },
        {
          name: t(locale, 'helpAdmin.moderationTitle'),
          value: t(locale, 'helpAdmin.moderationValue'),
        },
        { name: t(locale, 'helpAdmin.reportSpamTitle'), value: t(locale, 'helpAdmin.reportSpamValue') },
        { name: t(locale, 'helpAdmin.practicesTitle'), value: t(locale, 'helpAdmin.practicesValue') },
        {
          name: t(locale, 'helpAdmin.tipTitle'),
          value: t(locale, 'helpAdmin.tipValue'),
        },
      );

    await interactReply(interaction, {
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });
  },
};
