import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getGuildLocale, t } from '../i18n/index.js';
import {
  applyDescriptionLocalizations,
  applyOptionLocalizations,
  slashMeta,
} from '../i18n/slashLocalizations.js';
import { createOrUpdateNetworkDashboardMessage } from '../services/networkDashboard.js';
import {
  interactDeferReply,
  interactEditReply,
  interactReply,
} from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

/**
 * Vérifie que l'auteur de l'interaction est le propriétaire déclaré dans l'env.
 * @param {string} userId
 * @returns {boolean}
 */
function isOwner(userId) {
  const ownerId = process.env.SCRIMRESEAU_OWNER_ID?.trim();
  return Boolean(ownerId) && userId === ownerId;
}

const data = applyDescriptionLocalizations(
  new SlashCommandBuilder()
    .setName('dashboard-reseau')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((opt) =>
      applyOptionLocalizations(
        opt.setName('salon').setRequired(true),
        slashMeta.dashboardReseau.options.salon,
      ),
    ),
  slashMeta.dashboardReseau.description,
);

export const dashboardReseau = {
  data,

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
   */
  async execute(interaction, ctx) {
    const locale = getGuildLocale(interaction.guildId, ctx.stmts);

    if (!isOwner(interaction.user.id)) {
      await interactReply(interaction, {
        content: t(locale, 'dev.dashboardNotOwner'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.inGuild() || !interaction.guild) {
      await interactReply(interaction, {
        content: t(locale, 'dev.dashboardNeedGuild'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interactDeferReply(interaction, { flags: MessageFlags.Ephemeral });

    const channel = interaction.options.getChannel('salon', true);

    if (
      channel.type !== ChannelType.GuildText
      && channel.type !== ChannelType.GuildAnnouncement
    ) {
      await interactEditReply(interaction, {
        content: t(locale, 'dev.dashboardInvalidChannel'),
      });
      return;
    }

    let resolvedChannel;
    try {
      resolvedChannel = interaction.guild.channels.cache.get(channel.id)
        ?? await interaction.guild.channels.fetch(channel.id).catch(() => null);
    } catch {
      resolvedChannel = null;
    }

    if (!resolvedChannel?.isTextBased()) {
      await interactEditReply(interaction, {
        content: t(locale, 'dev.dashboardInvalidChannel'),
      });
      return;
    }

    const textChannel = /** @type {import('discord.js').TextChannel} */ (resolvedChannel);

    logger.info('dashboard-reseau: commande déclenchée', {
      user_id: interaction.user.id,
      guild_id: interaction.guildId,
      channel_id: channel.id,
    });

    const result = await createOrUpdateNetworkDashboardMessage(
      interaction.client,
      textChannel,
      interaction.user.id,
      ctx.stmts,
    );

    if (!result.ok) {
      await interactEditReply(interaction, {
        content: result.error ?? t(locale, 'dev.dashboardError'),
      });
      return;
    }

    await interactEditReply(interaction, {
      content: t(locale, 'dev.dashboardConfigured', {
        channel: `<#${channel.id}>`,
      }),
    });
  },
};
