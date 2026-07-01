/**
 * Commande /dashboard-admin — gestion des dashboards réseau (owner-only, dev-guild only).
 *
 * Sous-commandes :
 *   list    — liste les dashboards configurés avec leur statut Discord.
 *   remove  — retire une entrée de network_dashboard_config par channel_id.
 *   refresh — force updateNetworkDashboard immédiatement.
 *
 * Sécurité : identique à /dashboard-reseau.
 *   - Déployée uniquement sur DEV_GUILD_ID (voir deploy-commands.js).
 *   - Exécution réservée à SCRIMRESEAU_OWNER_ID.
 *   - Refus ephemeral si mauvais utilisateur.
 */

import { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { updateNetworkDashboard } from '../services/networkDashboard.js';
import {
  interactDeferReply,
  interactEditReply,
  interactReply,
} from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const MSG_NOT_OWNER = '❌ Cette commande est réservée au propriétaire de ScrimRéseau.';

// ---------------------------------------------------------------------------
// Garde owner
// ---------------------------------------------------------------------------

/**
 * @param {string} userId
 * @returns {boolean}
 */
function isOwner(userId) {
  const ownerId = process.env.SCRIMRESEAU_OWNER_ID?.trim();
  return Boolean(ownerId) && userId === ownerId;
}

// ---------------------------------------------------------------------------
// Définition slash
// ---------------------------------------------------------------------------

const data = new SlashCommandBuilder()
  .setName('dashboard-admin')
  .setDescription('Gestion des dashboards réseau ScrimRéseau (owner only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('Liste tous les dashboards réseau configurés avec leur statut'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Retire un dashboard de la configuration par son channel_id')
      .addStringOption((opt) =>
        opt
          .setName('channel_id')
          .setDescription('ID Discord du salon (ex: 123456789012345678)')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('refresh')
      .setDescription('Force la mise à jour immédiate de tous les dashboards réseau'),
  );

// ---------------------------------------------------------------------------
// Sous-commande : list
// ---------------------------------------------------------------------------

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
async function handleList(interaction, ctx) {
  let rows;
  try {
    rows = ctx.stmts.getAllNetworkDashboards.all();
  } catch (err) {
    logger.error('dashboard-admin list: erreur lecture DB', {
      message: err instanceof Error ? err.message : String(err),
    });
    await interactEditReply(interaction, { content: '❌ Erreur lors de la lecture de la base.' });
    return;
  }

  if (!rows || rows.length === 0) {
    await interactEditReply(interaction, { content: 'ℹ️ Aucun dashboard réseau configuré.' });
    return;
  }

  const fields = [];

  for (const row of rows) {
    const guildId = String(row.guild_id);
    const channelId = String(row.channel_id);
    const messageId = row.message_id ? String(row.message_id) : null;

    const guild = interaction.client.guilds.cache.get(guildId);
    const guildName = guild?.name ?? `*(serveur inconnu)*`;

    let channelLabel = `\`${channelId}\``;
    let status = '✅ OK';

    if (!guild) {
      status = '⚠️ serveur introuvable';
    } else {
      const channel = guild.channels.cache.get(channelId);
      if (!channel) {
        status = '⚠️ salon introuvable';
      } else {
        channelLabel = `<#${channelId}>`;

        // Vérification permissions bot dans ce salon
        const me = guild.members.me;
        if (me) {
          const perms = channel.permissionsFor(me);
          const hasPerms =
            perms?.has(PermissionFlagsBits.ViewChannel)
            && perms?.has(PermissionFlagsBits.SendMessages)
            && perms?.has(PermissionFlagsBits.AttachFiles);
          if (!hasPerms) {
            status = '⚠️ bot sans permission';
          }
        }

        if (status === '✅ OK' && !messageId) {
          status = '⚠️ message_id absent en DB';
        }
      }
    }

    const msgInfo = messageId ? `\`${messageId}\`` : '`null`';
    const updatedAt = row.updated_at ? String(row.updated_at).slice(0, 19) : '?';

    fields.push({
      name: `${status} ${guildName}`,
      value:
        `Salon : ${channelLabel}\n` +
        `channel\_id : \`${channelId}\`\n` +
        `message\_id : ${msgInfo}\n` +
        `Mis à jour : ${updatedAt}`,
      inline: false,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(`Dashboards réseau configurés (${rows.length})`)
    .setColor(0x5865f2)
    .setFields(fields.slice(0, 25))  // embed limit : 25 fields max
    .setFooter({ text: rows.length > 25 ? `+ ${rows.length - 25} entrée(s) non affichée(s)` : 'Toutes les entrées affichées' })
    .setTimestamp();

  await interactEditReply(interaction, { embeds: [embed] });
}

// ---------------------------------------------------------------------------
// Sous-commande : remove
// ---------------------------------------------------------------------------

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
async function handleRemove(interaction, ctx) {
  const rawChannelId = interaction.options.getString('channel_id', true).trim();

  // Lecture de tous les dashboards pour trouver l'entrée correspondante
  let rows;
  try {
    rows = ctx.stmts.getAllNetworkDashboards.all();
  } catch (err) {
    logger.error('dashboard-admin remove: erreur lecture DB', {
      message: err instanceof Error ? err.message : String(err),
    });
    await interactEditReply(interaction, { content: '❌ Erreur lors de la lecture de la base.' });
    return;
  }

  const row = rows.find((r) => String(r.channel_id) === rawChannelId);
  if (!row) {
    await interactEditReply(interaction, {
      content: `❌ Aucun dashboard trouvé pour ce salon (\`${rawChannelId}\`).`,
    });
    return;
  }

  const guildId = String(row.guild_id);
  const channelId = String(row.channel_id);

  // Suppression DB
  try {
    ctx.stmts.deleteNetworkDashboard.run(guildId, channelId);
  } catch (err) {
    logger.error('dashboard-admin remove: erreur suppression DB', {
      guild_id: guildId,
      channel_id: channelId,
      message: err instanceof Error ? err.message : String(err),
    });
    await interactEditReply(interaction, { content: '❌ Erreur lors de la suppression en base.' });
    return;
  }

  logger.info('dashboard-admin: dashboard retiré de la config', {
    user_id: interaction.user.id,
    guild_id: guildId,
    channel_id: channelId,
    message_id: row.message_id ?? null,
  });

  // Récupérer le nom du serveur et du salon pour feedback
  const guild = interaction.client.guilds.cache.get(guildId);
  const guildName = guild?.name ?? `\`${guildId}\``;
  const channel = guild?.channels.cache.get(channelId);
  const channelMention = channel ? `<#${channelId}>` : `\`${channelId}\``;

  await interactEditReply(interaction, {
    content:
      `✅ Dashboard retiré de la configuration.\n` +
      `Serveur : **${guildName}** | Salon : ${channelMention}`,
  });
}

// ---------------------------------------------------------------------------
// Sous-commande : refresh
// ---------------------------------------------------------------------------

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
async function handleRefresh(interaction, ctx) {
  logger.info('dashboard-admin: refresh forcé', { user_id: interaction.user.id });

  try {
    await updateNetworkDashboard(interaction.client, ctx.stmts);
    await interactEditReply(interaction, { content: '✅ Refresh dashboard terminé.' });
  } catch (err) {
    logger.error('dashboard-admin refresh: erreur', {
      message: err instanceof Error ? err.message : String(err),
    });
    await interactEditReply(interaction, {
      content: '❌ Erreur lors du refresh. Consulte les logs pour plus de détails.',
    });
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const dashboardAdmin = {
  data,

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
   */
  async execute(interaction, ctx) {
    if (!isOwner(interaction.user.id)) {
      await interactReply(interaction, {
        content: MSG_NOT_OWNER,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interactDeferReply(interaction, { flags: MessageFlags.Ephemeral });

    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      await handleList(interaction, ctx);
    } else if (sub === 'remove') {
      await handleRemove(interaction, ctx);
    } else if (sub === 'refresh') {
      await handleRefresh(interaction, ctx);
    } else {
      await interactEditReply(interaction, { content: '❌ Sous-commande inconnue.' });
    }
  },
};
