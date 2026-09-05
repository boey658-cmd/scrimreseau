/**
 * Commande /dashboard-admin — gestion des dashboards réseau + exclusions site public
 * (owner-only, dev-guild only).
 *
 * Sous-commandes :
 *   list           — liste les dashboards configurés avec leur statut Discord.
 *   remove         — retire une entrée de network_dashboard_config par channel_id.
 *   refresh        — force updateNetworkDashboard immédiatement.
 *   exclude-add    — masque un serveur de la page publique /network.
 *   exclude-remove — retire un serveur de la blacklist publique.
 *   exclude-list   — liste les exclusions publiques actuelles.
 *
 * Sécurité :
 *   - Déployée uniquement sur DEV_GUILD_ID (voir deploy-commands.js).
 *   - Exécution réservée à SCRIMRESEAU_OWNER_ID.
 *   - Refus ephemeral si mauvais utilisateur.
 */

import { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getGuildLocale, t } from '../i18n/index.js';
import {
  applyDescriptionLocalizations,
  slashMeta,
} from '../i18n/slashLocalizations.js';
import { updateNetworkDashboard } from '../services/networkDashboard.js';
import {
  interactAutocompleteRespond,
  interactDeferReply,
  interactEditReply,
  interactReply,
} from '../utils/interactionDiscord.js';
import {
  filterAutocompleteChoices,
  normalizeExclusionReason,
  parseGuildIdOption,
} from '../utils/networkPublicExclusionAdmin.js';
import { logger } from '../utils/logger.js';

/**
 * @param {string} userId
 * @returns {boolean}
 */
function isOwner(userId) {
  const ownerId = process.env.SCRIMRESEAU_OWNER_ID?.trim();
  return Boolean(ownerId) && userId === ownerId;
}

/**
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @returns {string}
 */
function resolveGuildLabel(client, guildId) {
  const guild = client.guilds.cache.get(guildId);
  return guild?.name ?? guildId;
}

const data = applyDescriptionLocalizations(
  new SlashCommandBuilder()
    .setName('dashboard-admin')
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
    )
    .addSubcommand((sub) =>
      sub
        .setName('exclude-add')
        .setDescription('Masque un serveur de la page publique /network')
        .addStringOption((opt) =>
          opt
            .setName('serveur')
            .setDescription('Serveur à masquer (autocomplete)')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('raison')
            .setDescription('Raison optionnelle (ex. serveur de test)')
            .setRequired(false)
            .setMaxLength(100),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('exclude-remove')
        .setDescription('Retire un serveur de la liste masquée du site')
        .addStringOption((opt) =>
          opt
            .setName('serveur')
            .setDescription('Serveur à réafficher (autocomplete exclusions)')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('exclude-list')
        .setDescription('Liste les serveurs masqués de la page publique /network'),
    ),
  slashMeta.dashboardAdmin.description,
);

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 * @param {string} locale
 */
async function handleList(interaction, ctx, locale) {
  let rows;
  try {
    rows = ctx.stmts.getAllNetworkDashboards.all();
  } catch (err) {
    logger.error('dashboard-admin list: erreur lecture DB', {
      message: err instanceof Error ? err.message : String(err),
    });
    await interactEditReply(interaction, { content: t(locale, 'dev.dbReadError') });
    return;
  }

  if (!rows || rows.length === 0) {
    await interactEditReply(interaction, { content: t(locale, 'dev.dashboardNone') });
    return;
  }

  const fields = [];

  for (const row of rows) {
    const guildId = String(row.guild_id);
    const channelId = String(row.channel_id);
    const messageId = row.message_id ? String(row.message_id) : null;

    const guild = interaction.client.guilds.cache.get(guildId);
    const guildName = guild?.name ?? t(locale, 'dev.dashboardUnknownGuild');

    let channelLabel = `\`${channelId}\``;
    let status = t(locale, 'dev.dashboardStatusOk');

    if (!guild) {
      status = t(locale, 'dev.dashboardStatusGuildMissing');
    } else {
      const channel = guild.channels.cache.get(channelId);
      if (!channel) {
        status = t(locale, 'dev.dashboardStatusChannelMissing');
      } else {
        channelLabel = `<#${channelId}>`;

        const me = guild.members.me;
        if (me) {
          const perms = channel.permissionsFor(me);
          const hasPerms =
            perms?.has(PermissionFlagsBits.ViewChannel)
            && perms?.has(PermissionFlagsBits.SendMessages)
            && perms?.has(PermissionFlagsBits.AttachFiles);
          if (!hasPerms) {
            status = t(locale, 'dev.dashboardStatusNoPerms');
          }
        }

        if (status === t(locale, 'dev.dashboardStatusOk') && !messageId) {
          status = t(locale, 'dev.dashboardStatusNoMessageId');
        }
      }
    }

    const msgInfo = messageId ? `\`${messageId}\`` : '`null`';
    const updatedAt = row.updated_at ? String(row.updated_at).slice(0, 19) : '?';

    fields.push({
      name: `${status} ${guildName}`,
      value: t(locale, 'dev.dashboardFieldValue', {
        channel: channelLabel,
        channelId,
        messageId: msgInfo,
        updatedAt,
      }),
      inline: false,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(t(locale, 'dev.dashboardListTitle', { count: rows.length }))
    .setColor(0x5865f2)
    .setFields(fields.slice(0, 25))
    .setFooter({
      text:
        rows.length > 25
          ? t(locale, 'dev.dashboardFooterTruncated', { count: rows.length - 25 })
          : t(locale, 'dev.dashboardFooterAll'),
    })
    .setTimestamp();

  await interactEditReply(interaction, { embeds: [embed] });
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 * @param {string} locale
 */
async function handleRemove(interaction, ctx, locale) {
  const rawChannelId = interaction.options.getString('channel_id', true).trim();

  let rows;
  try {
    rows = ctx.stmts.getAllNetworkDashboards.all();
  } catch (err) {
    logger.error('dashboard-admin remove: erreur lecture DB', {
      message: err instanceof Error ? err.message : String(err),
    });
    await interactEditReply(interaction, { content: t(locale, 'dev.dbReadError') });
    return;
  }

  const row = rows.find((r) => String(r.channel_id) === rawChannelId);
  if (!row) {
    await interactEditReply(interaction, {
      content: t(locale, 'dev.dashboardNotFound', { channelId: rawChannelId }),
    });
    return;
  }

  const guildId = String(row.guild_id);
  const channelId = String(row.channel_id);

  try {
    ctx.stmts.deleteNetworkDashboard.run(guildId, channelId);
  } catch (err) {
    logger.error('dashboard-admin remove: erreur suppression DB', {
      guild_id: guildId,
      channel_id: channelId,
      message: err instanceof Error ? err.message : String(err),
    });
    await interactEditReply(interaction, { content: t(locale, 'dev.dashboardDeleteError') });
    return;
  }

  logger.info('dashboard-admin: dashboard retiré de la config', {
    user_id: interaction.user.id,
    guild_id: guildId,
    channel_id: channelId,
    message_id: row.message_id ?? null,
  });

  const guild = interaction.client.guilds.cache.get(guildId);
  const guildName = guild?.name ?? `\`${guildId}\``;
  const channel = guild?.channels.cache.get(channelId);
  const channelMention = channel ? `<#${channelId}>` : `\`${channelId}\``;

  await interactEditReply(interaction, {
    content: t(locale, 'dev.dashboardRemovedDetail', {
      guild: guildName,
      channel: channelMention,
    }),
  });
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 * @param {string} locale
 */
async function handleRefresh(interaction, ctx, locale) {
  logger.info('dashboard-admin: refresh forcé', { user_id: interaction.user.id });

  try {
    await updateNetworkDashboard(interaction.client, ctx.stmts);
    await interactEditReply(interaction, { content: t(locale, 'dev.dashboardRefreshOk') });
  } catch (err) {
    logger.error('dashboard-admin refresh: erreur', {
      message: err instanceof Error ? err.message : String(err),
    });
    await interactEditReply(interaction, {
      content: t(locale, 'dev.dashboardRefreshError'),
    });
  }
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 * @param {string} locale
 */
async function handleExcludeAdd(interaction, ctx, locale) {
  const guildId = parseGuildIdOption(interaction.options.getString('serveur', true));
  if (!guildId) {
    await interactEditReply(interaction, { content: t(locale, 'dev.excludeInvalidGuild') });
    return;
  }

  if (!interaction.client.guilds.cache.has(guildId)) {
    await interactEditReply(interaction, { content: t(locale, 'dev.excludeInvalidGuild') });
    return;
  }

  const reason = normalizeExclusionReason(interaction.options.getString('raison'));
  const name = resolveGuildLabel(interaction.client, guildId);

  try {
    const existing = ctx.stmts.getNetworkPublicExclusion.get(guildId);
    if (existing) {
      await interactEditReply(interaction, {
        content: t(locale, 'dev.excludeAlready', { name, id: guildId }),
      });
      return;
    }

    ctx.stmts.upsertNetworkPublicExclusion.run({
      guild_id: guildId,
      created_at: new Date().toISOString(),
      reason,
    });
  } catch (err) {
    logger.error('dashboard-admin exclude-add: erreur DB', {
      guild_id: guildId,
      message: err instanceof Error ? err.message : String(err),
    });
    await interactEditReply(interaction, { content: t(locale, 'dev.excludeDbError') });
    return;
  }

  logger.info('dashboard-admin: exclusion publique ajoutée', {
    user_id: interaction.user.id,
    guild_id: guildId,
    reason: reason ?? null,
  });

  const key = reason ? 'dev.excludeAdded' : 'dev.excludeAddedNoReason';
  await interactEditReply(interaction, {
    content: t(locale, key, { name, id: guildId, reason: reason ?? '' }),
  });
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 * @param {string} locale
 */
async function handleExcludeRemove(interaction, ctx, locale) {
  const guildId = parseGuildIdOption(interaction.options.getString('serveur', true));
  if (!guildId) {
    await interactEditReply(interaction, { content: t(locale, 'dev.excludeInvalidGuild') });
    return;
  }

  const name = resolveGuildLabel(interaction.client, guildId);

  try {
    const existing = ctx.stmts.getNetworkPublicExclusion.get(guildId);
    if (!existing) {
      await interactEditReply(interaction, {
        content: t(locale, 'dev.excludeNotFound', { id: guildId }),
      });
      return;
    }

    ctx.stmts.deleteNetworkPublicExclusion.run(guildId);
  } catch (err) {
    logger.error('dashboard-admin exclude-remove: erreur DB', {
      guild_id: guildId,
      message: err instanceof Error ? err.message : String(err),
    });
    await interactEditReply(interaction, { content: t(locale, 'dev.excludeDbError') });
    return;
  }

  logger.info('dashboard-admin: exclusion publique retirée', {
    user_id: interaction.user.id,
    guild_id: guildId,
  });

  await interactEditReply(interaction, {
    content: t(locale, 'dev.excludeRemoved', { name, id: guildId }),
  });
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 * @param {string} locale
 */
async function handleExcludeList(interaction, ctx, locale) {
  let rows;
  try {
    rows = ctx.stmts.listNetworkPublicExclusions.all();
  } catch (err) {
    logger.error('dashboard-admin exclude-list: erreur DB', {
      message: err instanceof Error ? err.message : String(err),
    });
    await interactEditReply(interaction, { content: t(locale, 'dev.excludeDbError') });
    return;
  }

  if (!rows || rows.length === 0) {
    await interactEditReply(interaction, { content: t(locale, 'dev.excludeNone') });
    return;
  }

  const lines = rows.map((row, index) => {
    const guildId = String(row.guild_id);
    const name = resolveGuildLabel(interaction.client, guildId);
    const reason = row.reason != null && String(row.reason).trim()
      ? String(row.reason).trim()
      : null;
    const key = reason ? 'dev.excludeListEntry' : 'dev.excludeListEntryNoReason';
    return t(locale, key, {
      idx: index + 1,
      name,
      id: guildId,
      reason: reason ?? '',
    });
  });

  const body = [
    t(locale, 'dev.excludeListTitle', { count: rows.length }),
    '',
    ...lines,
  ].join('\n');

  // Discord message content limit ~2000
  const content = body.length > 1900
    ? `${body.slice(0, 1890)}\n…`
    : body;

  await interactEditReply(interaction, { content });
}

/**
 * @param {import('discord.js').AutocompleteInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
async function handleExcludeAddAutocomplete(interaction, ctx) {
  const focused = interaction.options.getFocused(true);
  const query = typeof focused.value === 'string' ? focused.value : '';

  /** @type {{ name: string, value: string }[]} */
  const entries = [];
  for (const guild of interaction.client.guilds.cache.values()) {
    entries.push({ name: guild.name ?? guild.id, value: guild.id });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  await interactAutocompleteRespond(
    interaction,
    filterAutocompleteChoices(entries, query),
  );
}

/**
 * @param {import('discord.js').AutocompleteInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
async function handleExcludeRemoveAutocomplete(interaction, ctx) {
  const focused = interaction.options.getFocused(true);
  const query = typeof focused.value === 'string' ? focused.value : '';

  let rows = [];
  try {
    rows = ctx.stmts.listNetworkPublicExclusions.all();
  } catch (err) {
    logger.warn('dashboard-admin exclude-remove autocomplete: DB', {
      message: err instanceof Error ? err.message : String(err),
    });
    await interactAutocompleteRespond(interaction, []);
    return;
  }

  /** @type {{ name: string, value: string }[]} */
  const entries = rows.map((row) => {
    const guildId = String(row.guild_id);
    const guild = interaction.client.guilds.cache.get(guildId);
    return { name: guild?.name ?? guildId, value: guildId };
  });

  await interactAutocompleteRespond(
    interaction,
    filterAutocompleteChoices(entries, query),
  );
}

export const dashboardAdmin = {
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

    await interactDeferReply(interaction, { flags: MessageFlags.Ephemeral });

    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      await handleList(interaction, ctx, locale);
    } else if (sub === 'remove') {
      await handleRemove(interaction, ctx, locale);
    } else if (sub === 'refresh') {
      await handleRefresh(interaction, ctx, locale);
    } else if (sub === 'exclude-add') {
      await handleExcludeAdd(interaction, ctx, locale);
    } else if (sub === 'exclude-remove') {
      await handleExcludeRemove(interaction, ctx, locale);
    } else if (sub === 'exclude-list') {
      await handleExcludeList(interaction, ctx, locale);
    } else {
      await interactEditReply(interaction, { content: t(locale, 'dev.unknownSubcommand') });
    }
  },

  /**
   * @param {import('discord.js').AutocompleteInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
   */
  async autocomplete(interaction, ctx) {
    if (!isOwner(interaction.user.id)) {
      await interactAutocompleteRespond(interaction, []);
      return;
    }

    const sub = interaction.options.getSubcommand(false);
    if (sub === 'exclude-add') {
      await handleExcludeAddAutocomplete(interaction, ctx);
      return;
    }
    if (sub === 'exclude-remove') {
      await handleExcludeRemoveAutocomplete(interaction, ctx);
      return;
    }

    await interactAutocompleteRespond(interaction, []);
  },
};
