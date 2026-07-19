/**
 * /scrim-dev serveurs — Liste TOUS les serveurs où le bot est présent.
 *
 * Source : interaction.client.guilds.cache (client Discord, pas la DB).
 * Affiche les serveurs qu'ils aient ou non une configuration Scrim.
 *
 * Sécurité :
 *  - Enregistrée uniquement sur DEV_GUILD_ID (guild-only, pas global)
 *  - Vérification DEV_GUILD_ID + BOT_DEV_ID à l'exécution (fail-closed)
 *  - Réponse obligatoirement éphémère
 *
 * Base de données : aucun accès (ni lecture ni écriture).
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { MSG_BOT_DEV_UNCONFIGURED, resolveBotDevId } from '../utils/botDevConfig.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const MSG_DENIED = `❌ Non autorisé.`;
const PAGE_SIZE = 10;
const PANEL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Sessions de pagination actives, clé : userId. */
const activePanels = new Map();

const mkId = (uid, action) => `devgl:${uid}:${action}`;

// ---------------------------------------------------------------------------
// Construction de la liste de guildes (tri, display)
// ---------------------------------------------------------------------------

/**
 * Retourne les guildes du cache triées par nom (insensible à la casse).
 * Source : client Discord uniquement — jamais la base de données.
 *
 * @param {import('discord.js').Client} client
 * @returns {import('discord.js').Guild[]}
 */
export function getSortedGuilds(client) {
  return [...client.guilds.cache.values()].sort((a, b) => {
    const nameA = a.available ? (a.name ?? '') : '';
    const nameB = b.available ? (b.name ?? '') : '';
    return nameA.localeCompare(nameB, 'fr', { sensitivity: 'base' });
  });
}

/**
 * Formate une entrée pour un serveur donné.
 *
 * @param {import('discord.js').Guild} guild
 * @param {number} idx Numéro affiché (1-indexed)
 * @returns {string}
 */
export function formatGuildEntry(guild, idx) {
  if (!guild.available) {
    return [`**${idx}. ⚠️ Serveur temporairement indisponible**`, `ID : \`${guild.id}\``].join('\n');
  }

  const name = guild.name ?? '*(nom inconnu)*';

  const members =
    typeof guild.memberCount === 'number'
      ? guild.memberCount.toLocaleString('fr-FR')
      : 'Inconnus';

  let joinedStr = `Date inconnue`;
  if (guild.joinedAt instanceof Date && !Number.isNaN(guild.joinedAt.getTime())) {
    joinedStr = guild.joinedAt.toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  }

  return [
    `**${idx}. ${name}**`,
    `ID : \`${guild.id}\``,
    `Membres : ${members}`,
    `Bot ajouté le : ${joinedStr}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Constructeurs embed + composants
// ---------------------------------------------------------------------------

/**
 * @param {import('discord.js').Guild[]} guilds Liste triée complète
 * @param {number} page Index de page (0-indexed)
 * @param {number} pageCount Nombre total de pages
 * @returns {EmbedBuilder}
 */
export function buildGuildListEmbed(guilds, page, pageCount) {
  const total = guilds.length;

  let description;
  if (total === 0) {
    description = `Le bot n'est actuellement présent sur aucun serveur.`;
  } else {
    const start = page * PAGE_SIZE;
    const pageGuilds = guilds.slice(start, start + PAGE_SIZE);
    description = pageGuilds.map((g, i) => formatGuildEntry(g, start + i + 1)).join('\n\n');
  }

  return new EmbedBuilder()
    .setTitle(`🌐 Serveurs du bot`)
    .setDescription(description)
    .setColor(0x5865f2)
    .setFooter({
      text: `Serveurs actuels du bot : ${total} · Page ${page + 1}/${pageCount}`,
    });
}

/**
 * @param {string} uid
 * @param {number} page
 * @param {number} pageCount
 * @returns {ActionRowBuilder[]}
 */
export function buildGuildListComponents(uid, page, pageCount) {
  const prevDisabled = page === 0;
  const nextDisabled = page >= pageCount - 1;

  const buttons = [];

  if (pageCount > 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(mkId(uid, 'prev'))
        .setLabel('← Précédent')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(prevDisabled),
      new ButtonBuilder()
        .setCustomId(mkId(uid, 'next'))
        .setLabel('Suivant →')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(nextDisabled),
    );
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId(mkId(uid, 'close'))
      .setLabel('✖ Fermer')
      .setStyle(ButtonStyle.Secondary),
  );

  return [new ActionRowBuilder().addComponents(...buttons)];
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function executeScrimDevGuildListCore(interaction) {
  const devGuildId = process.env.DEV_GUILD_ID?.trim() ?? '';

  // Vérification 1 : doit être dans la guilde de développement
  if (!interaction.inGuild()) {
    await interaction.reply({ content: MSG_DENIED, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!devGuildId || interaction.guildId !== devGuildId) {
    await interaction.reply({ content: MSG_DENIED, flags: MessageFlags.Ephemeral });
    return;
  }

  // Vérification 2 : doit être le développeur du bot (fail-closed)
  const dev = resolveBotDevId();
  if (!dev.ok) {
    logger.error(`scrim-dev serveurs — ${MSG_BOT_DEV_UNCONFIGURED}`, { reason: dev.reason });
    await interaction.reply({
      content: `❌ Cette commande est indisponible : BOT_DEV_ID non configuré.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== dev.devId) {
    await interaction.reply({ content: MSG_DENIED, flags: MessageFlags.Ephemeral });
    return;
  }

  const uid = interaction.user.id;

  // Ferme une session déjà ouverte par ce développeur
  const existing = activePanels.get(uid);
  if (existing) existing.stop('replaced');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Source : cache client Discord — aucun accès base de données
  const guilds = getSortedGuilds(interaction.client);
  const total = guilds.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  let currentPage = 0;

  const message = await interaction.editReply({
    embeds: [buildGuildListEmbed(guilds, currentPage, pageCount)],
    components: buildGuildListComponents(uid, currentPage, pageCount),
  });

  const collector = message.createMessageComponentCollector({
    time: PANEL_TIMEOUT_MS,
    filter: (i) => i.user.id === uid,
  });

  activePanels.set(uid, collector);

  collector.on('collect', async (i) => {
    const action = i.customId.split(':')[2];

    if (action === 'close') {
      collector.stop('closed');
      try {
        await i.update({ content: `✅ Panneau fermé.`, embeds: [], components: [] });
      } catch {
        /* ignore */
      }
      return;
    }

    if (action === 'prev' && currentPage > 0) {
      currentPage--;
    } else if (action === 'next' && currentPage < pageCount - 1) {
      currentPage++;
    }

    try {
      await i.update({
        embeds: [buildGuildListEmbed(guilds, currentPage, pageCount)],
        components: buildGuildListComponents(uid, currentPage, pageCount),
      });
    } catch (err) {
      logger.error('scrim-dev serveurs — mise à jour pagination', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  collector.on('end', async (_, reason) => {
    activePanels.delete(uid);
    if (reason !== 'replaced' && reason !== 'closed') {
      try {
        await interaction.editReply({ content: `⏰ Session expirée.`, embeds: [], components: [] });
      } catch {
        /* ignore */
      }
    }
  });

  logger.info('scrim-dev serveurs', {
    user_id: uid,
    guild_id: interaction.guildId,
    total_guilds: total,
    page_count: pageCount,
  });
}
