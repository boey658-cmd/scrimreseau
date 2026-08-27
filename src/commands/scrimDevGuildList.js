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
import {
  getGuildLocale,
  intlLocaleForBotLocale,
  t,
} from '../i18n/index.js';
import {
  botDevUnconfiguredMessage,
  resolveBotDevId,
} from '../utils/botDevConfig.js';
import { logger } from '../utils/logger.js';

const PAGE_SIZE = 10;
const PANEL_TIMEOUT_MS = 5 * 60 * 1000;

/** Sessions de pagination actives, clé : userId. */
const activePanels = new Map();

const mkId = (uid, action) => `devgl:${uid}:${action}`;

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
 * @param {string} [locale]
 * @returns {string}
 */
export function formatGuildEntry(guild, idx, locale = 'fr') {
  if (!guild.available) {
    return [
      t(locale, 'dev.serversUnavailable', { idx }),
      t(locale, 'dev.serversEntryMeta', {
        id: guild.id,
        members: '—',
        joined: '—',
      }),
    ].join('\n');
  }

  const name = guild.name ?? t(locale, 'dev.serversUnknownName');
  const intl = intlLocaleForBotLocale(locale);

  const members =
    typeof guild.memberCount === 'number'
      ? guild.memberCount.toLocaleString(intl)
      : t(locale, 'dev.serversUnknownMembers');

  let joinedStr = t(locale, 'dev.serversUnknownDate');
  if (guild.joinedAt instanceof Date && !Number.isNaN(guild.joinedAt.getTime())) {
    joinedStr = guild.joinedAt.toLocaleDateString(intl, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  }

  return [
    `**${idx}. ${name}**`,
    t(locale, 'dev.serversEntryMeta', {
      id: guild.id,
      members,
      joined: joinedStr,
    }),
  ].join('\n');
}

/**
 * @param {import('discord.js').Guild[]} guilds Liste triée complète
 * @param {number} page Index de page (0-indexed)
 * @param {number} pageCount Nombre total de pages
 * @param {string} [locale]
 * @returns {EmbedBuilder}
 */
export function buildGuildListEmbed(guilds, page, pageCount, locale = 'fr') {
  const total = guilds.length;

  let description;
  if (total === 0) {
    description = t(locale, 'dev.serversEmpty');
  } else {
    const start = page * PAGE_SIZE;
    const pageGuilds = guilds.slice(start, start + PAGE_SIZE);
    description = pageGuilds
      .map((g, i) => formatGuildEntry(g, start + i + 1, locale))
      .join('\n\n');
  }

  return new EmbedBuilder()
    .setTitle(t(locale, 'dev.serversTitle'))
    .setDescription(description)
    .setColor(0x5865f2)
    .setFooter({
      text: t(locale, 'dev.serversFooter', {
        total,
        page: page + 1,
        pageCount,
      }),
    });
}

/**
 * @param {string} uid
 * @param {number} page
 * @param {number} pageCount
 * @param {string} [locale]
 * @returns {ActionRowBuilder[]}
 */
export function buildGuildListComponents(uid, page, pageCount, locale = 'fr') {
  const prevDisabled = page === 0;
  const nextDisabled = page >= pageCount - 1;

  const buttons = [];

  if (pageCount > 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(mkId(uid, 'prev'))
        .setLabel(t(locale, 'dev.btnPrev'))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(prevDisabled),
      new ButtonBuilder()
        .setCustomId(mkId(uid, 'next'))
        .setLabel(t(locale, 'dev.btnNext'))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(nextDisabled),
    );
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId(mkId(uid, 'close'))
      .setLabel(t(locale, 'dev.btnClose'))
      .setStyle(ButtonStyle.Secondary),
  );

  return [new ActionRowBuilder().addComponents(...buttons)];
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function executeScrimDevGuildListCore(interaction) {
  const locale = getGuildLocale(interaction.guildId, null);
  const denied = t(locale, 'dev.denied');
  const devGuildId = process.env.DEV_GUILD_ID?.trim() ?? '';

  if (!interaction.inGuild()) {
    await interaction.reply({ content: denied, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!devGuildId || interaction.guildId !== devGuildId) {
    await interaction.reply({ content: denied, flags: MessageFlags.Ephemeral });
    return;
  }

  const dev = resolveBotDevId();
  if (!dev.ok) {
    logger.error(`scrim-dev serveurs — BOT_DEV_ID absent`, { reason: dev.reason });
    await interaction.reply({
      content: botDevUnconfiguredMessage(locale),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== dev.devId) {
    await interaction.reply({ content: denied, flags: MessageFlags.Ephemeral });
    return;
  }

  const uid = interaction.user.id;

  const existing = activePanels.get(uid);
  if (existing) existing.stop('replaced');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guilds = getSortedGuilds(interaction.client);
  const total = guilds.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  let currentPage = 0;

  const message = await interaction.editReply({
    embeds: [buildGuildListEmbed(guilds, currentPage, pageCount, locale)],
    components: buildGuildListComponents(uid, currentPage, pageCount, locale),
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
        await i.update({
          content: t(locale, 'dev.panelClosed'),
          embeds: [],
          components: [],
        });
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
        embeds: [buildGuildListEmbed(guilds, currentPage, pageCount, locale)],
        components: buildGuildListComponents(uid, currentPage, pageCount, locale),
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
        await interaction.editReply({
          content: t(locale, 'dev.panelExpired'),
          embeds: [],
          components: [],
        });
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
