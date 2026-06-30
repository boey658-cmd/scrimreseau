import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { createOrUpdateNetworkDashboardMessage } from '../services/networkDashboard.js';
import {
  interactDeferReply,
  interactEditReply,
  interactReply,
} from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const MSG_NOT_OWNER =
  '❌ Cette commande est réservée au propriétaire de ScrimRéseau.';
const MSG_NEED_GUILD =
  '❌ Cette commande doit être utilisée sur un serveur.';
const MSG_INVALID_CHANNEL =
  '❌ Le salon sélectionné doit être un salon texte ou une annonce.';
const MSG_ERROR =
  '❌ Une erreur est survenue lors de la création du dashboard. Réessayez plus tard.';

/**
 * Vérifie que l'auteur de l'interaction est le propriétaire déclaré dans l'env.
 * @param {string} userId
 * @returns {boolean}
 */
function isOwner(userId) {
  const ownerId = process.env.SCRIMRESEAU_OWNER_ID?.trim();
  return Boolean(ownerId) && userId === ownerId;
}

const data = new SlashCommandBuilder()
  .setName('dashboard-reseau')
  .setDescription('Initialise ou met à jour le dashboard réseau ScrimRéseau dans un salon')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addChannelOption((opt) =>
    opt
      .setName('salon')
      .setDescription('Salon texte où poster le dashboard')
      .setRequired(true),
  );

export const dashboardReseau = {
  data,

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
   */
  async execute(interaction, ctx) {
    // Garde owner
    if (!isOwner(interaction.user.id)) {
      await interactReply(interaction, {
        content: MSG_NOT_OWNER,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.inGuild() || !interaction.guild) {
      await interactReply(interaction, {
        content: MSG_NEED_GUILD,
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
      await interactEditReply(interaction, { content: MSG_INVALID_CHANNEL });
      return;
    }

    // Résoudre le channel complet (l'option peut retourner un partial)
    let resolvedChannel;
    try {
      resolvedChannel = interaction.guild.channels.cache.get(channel.id)
        ?? await interaction.guild.channels.fetch(channel.id).catch(() => null);
    } catch {
      resolvedChannel = null;
    }

    if (!resolvedChannel?.isTextBased()) {
      await interactEditReply(interaction, { content: MSG_INVALID_CHANNEL });
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
      await interactEditReply(interaction, { content: result.error ?? MSG_ERROR });
      return;
    }

    await interactEditReply(interaction, {
      content: `✅ Dashboard réseau configuré dans <#${channel.id}>. Il sera automatiquement mis à jour.`,
    });
  },
};
