import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { getEmbedColorForGame } from '../config/gameEmbedColors.js';
import { getGuildLocale, t } from '../i18n/index.js';
import {
  applyDescriptionLocalizations,
  slashMeta,
} from '../i18n/slashLocalizations.js';
import { interactReply } from '../utils/interactionDiscord.js';

const EMBED_COLOR = getEmbedColorForGame('');

export const help = {
  data: applyDescriptionLocalizations(
    new SlashCommandBuilder().setName('help-scrim'),
    slashMeta.helpScrim.description,
  ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
   */
  async execute(interaction, ctx) {
    const locale = getGuildLocale(interaction.guildId ?? '', ctx.stmts);

    const embed = new EmbedBuilder()
      .setTitle(t(locale, 'help.title'))
      .setColor(EMBED_COLOR)
      .addFields(
        {
          name: t(locale, 'help.findTitle'),
          value: t(locale, 'help.findValue'),
        },
        {
          name: t(locale, 'help.manageTitle'),
          value: t(locale, 'help.manageValue'),
        },
        {
          name: t(locale, 'help.tipTitle'),
          value: t(locale, 'help.tipValue'),
        },
      );

    await interactReply(interaction, {
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });
  },
};
