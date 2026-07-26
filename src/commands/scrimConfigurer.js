/**
 * /scrim-config — Panneau de configuration interactif ScrimRéseau.
 *
 * Remplace les sous-commandes /scrim-config (channel, command-channel,
 * permissions, messages, view) par une interface avec embed, boutons et
 * menus de sélection Discord.
 *
 * Architecture :
 *  - Réponse éphémère initiale (seul l'admin voit le panneau)
 *  - Collector sur le message pour capturer boutons / menus (10 min)
 *  - Lecture seule à l'ouverture (aucune écriture)
 *  - Écriture uniquement sur action volontaire de l'admin
 *  - Session unique par utilisateur (ferme l'ancien panneau si déjà ouvert)
 *  - Réutilise exactement les mêmes tables/statements que les anciens handlers
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { getEmbedColorForGame } from '../config/gameEmbedColors.js';
import { UI_PRIMARY_GAME_KEY } from '../config/games.js';
import { assertBotCanPostInChannel } from '../services/channelPermissions.js';
import {
  LIFECYCLE_POLICY_DELETE,
  LIFECYCLE_POLICY_KEEP,
} from '../services/scrimMessagePolicy.js';
import { scheduleNetworkDashboardUpdate } from '../services/networkDashboard.js';
import { assertGuildAdministrator } from '../utils/guildAdministratorGuard.js';
import {
  buildScrimReceptionConfigRefusalContent,
  mayConfigureScrimReceptionChannel,
} from '../utils/guildScrimReceptionGate.js';
import { logger } from '../utils/logger.js';
import { getGuildLocale, createTranslator, t } from '../i18n/index.js';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const GAME_KEY = UI_PRIMARY_GAME_KEY;
const EMBED_COLOR = getEmbedColorForGame(GAME_KEY);
const PANEL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ROLES = 5;

/**
 * Panneaux actifs par clé `guildId:userId`.
 * Utiliser la guilde + l'utilisateur permet à un admin qui gère plusieurs
 * serveurs d'avoir un panneau ouvert sur chacun sans fermer les autres.
 */
const activePanels = new Map();

/** Construit un customId de session. Format : `scrimcfg:{userId}:{action}` */
const mkId = (uid, action) => `scrimcfg:${uid}:${action}`;

/** Clé de session pour activePanels. */
const sessionKey = (guildId, uid) => `${guildId}:${uid}`;

// ---------------------------------------------------------------------------
// Lecture de la configuration (READ ONLY — jamais d'écriture ici)
// ---------------------------------------------------------------------------

/**
 * Lit toute la configuration d'un serveur depuis la DB.
 * Ne modifie aucune valeur.
 *
 * @param {string} guildId
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
function readConfig(guildId, stmts) {
  return {
    reception: stmts.getGuildGameChannel.get(guildId, GAME_KEY),
    usage: stmts.getScrimUsageChannel.get(guildId),
    permMode: stmts.getScrimPermissionMode.get(guildId),
    allowedRoles: stmts.listScrimAllowedRoles.all(guildId),
    policy: stmts.getScrimMessageLifecyclePolicy.get(guildId),
  };
}

// ---------------------------------------------------------------------------
// Helpers d'affichage
// ---------------------------------------------------------------------------

function channelDisplay(channelId, guild) {
  if (!channelId) return null;
  if (!guild.channels.cache.has(channelId)) return `⚠️ Salon introuvable`;
  return `<#${channelId}>`;
}

function roleDisplay(roleId, guild) {
  if (!guild.roles.cache.has(roleId)) return `⚠️ Rôle supprimé`;
  return `<@&${roleId}>`;
}

// ---------------------------------------------------------------------------
// Constructeurs d'embeds
// ---------------------------------------------------------------------------

function buildMainEmbed(config, guild, statusMsg = null, T = (k) => k) {
  const receptionText = channelDisplay(config.reception?.channel_id, guild) ?? T('scrimConfig.notConfigured');
  const usageText = channelDisplay(config.usage?.channel_id, guild) ?? T('scrimConfig.allChannels');

  const permMode = config.permMode?.mode ?? 'everyone';
  let permsText;
  if (permMode === 'everyone') {
    permsText = T('scrimConfig.permEveryone');
  } else if (config.allowedRoles.length === 0) {
    permsText = T('scrimConfig.permRolesNone');
  } else {
    const roleList = config.allowedRoles.map((r) => roleDisplay(r.role_id, guild)).join(', ');
    permsText = T('scrimConfig.permRoles', { list: roleList });
  }

  const policy = config.policy?.policy ?? 'keep';
  const policyText = policy === 'delete' ? T('scrimConfig.policyDelete') : T('scrimConfig.policyKeep');

  const descLines = [];
  if (statusMsg) { descLines.push(statusMsg, ''); }
  descLines.push(T('scrimConfig.mainDescription'));

  return new EmbedBuilder()
    .setTitle(T('scrimConfig.mainTitle'))
    .setDescription(descLines.join('\n'))
    .setColor(EMBED_COLOR)
    .addFields(
      { name: T('scrimConfig.fieldReception'), value: receptionText, inline: true },
      { name: T('scrimConfig.fieldCommand'), value: usageText, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: T('scrimConfig.fieldPerms'), value: permsText, inline: false },
      { name: T('scrimConfig.fieldMessages'), value: policyText, inline: false },
    )
    .setTimestamp();
}

function buildSalonsEmbed(config, guild, statusMsg = null, T = (k) => k) {
  const receptionText = channelDisplay(config.reception?.channel_id, guild) ?? T('scrimConfig.notConfigured');
  const usageText = channelDisplay(config.usage?.channel_id, guild) ?? T('scrimConfig.allChannels');

  const descLines = [];
  if (statusMsg) { descLines.push(statusMsg, ''); }
  descLines.push(
    T('scrimConfig.salonsDescLine1'),
    T('scrimConfig.salonsDescLine2'),
  );

  return new EmbedBuilder()
    .setTitle(T('scrimConfig.salonsTitle'))
    .setDescription(descLines.join('\n'))
    .setColor(EMBED_COLOR)
    .addFields(
      { name: T('scrimConfig.salonsFieldReception'), value: receptionText, inline: true },
      { name: T('scrimConfig.salonsFieldCommand'), value: usageText, inline: true },
    );
}

function buildPermsEmbed(config, guild, statusMsg = null, T = (k) => k) {
  const permMode = config.permMode?.mode ?? 'everyone';
  let currentText;
  if (permMode === 'everyone') {
    currentText = T('scrimConfig.permEveryone');
  } else if (config.allowedRoles.length === 0) {
    currentText = T('scrimConfig.permRolesNone');
  } else {
    const roleList = config.allowedRoles.map((r) => roleDisplay(r.role_id, guild)).join(', ');
    currentText = T('scrimConfig.permRoles', { list: roleList });
  }

  const descLines = [];
  if (statusMsg) { descLines.push(statusMsg, ''); }
  descLines.push(
    T('scrimConfig.permsDesc', { max: MAX_ROLES }),
    // desc merged into permsDesc

  );

  return new EmbedBuilder()
    .setTitle(T('scrimConfig.permsTitle'))
    .setDescription(descLines.join('\n'))
    .setColor(EMBED_COLOR)
    .addFields({ name: T('scrimConfig.permsFieldCurrent'), value: currentText });
}

function buildMsgsEmbed(config, statusMsg = null, T = (k) => k) {
  const policy = config.policy?.policy ?? 'keep';
  const policyText = policy === 'delete'
    ? T('scrimConfig.msgsPolicyDeleteLabel')
    : T('scrimConfig.msgsPolicyKeepLabel');

  const descLines = [];
  if (statusMsg) { descLines.push(statusMsg, ''); }
  descLines.push(T('scrimConfig.msgsDesc'));

  return new EmbedBuilder()
    .setTitle(T('scrimConfig.msgsTitle'))
    .setDescription(descLines.join('\n'))
    .setColor(EMBED_COLOR)
    .addFields({ name: T('scrimConfig.msgsFieldCurrent'), value: policyText });
}

function buildResetEmbed(statusMsg = null, T = (k) => k) {
  const descLines = [];
  if (statusMsg) { descLines.push(statusMsg, ''); }
  descLines.push(T('scrimConfig.resetDesc'));

  return new EmbedBuilder()
    .setTitle(T('scrimConfig.resetTitle'))
    .setDescription(descLines.join('\n'))
    .setColor(0xed4245);
}

function buildResetConfirmEmbed(T = (k) => k) {
  return new EmbedBuilder()
    .setTitle(T('scrimConfig.resetConfirmTitle'))
    .setDescription(T('scrimConfig.resetConfirmDesc'))
    .setColor(0xed4245);
}

// ---------------------------------------------------------------------------
// Constructeurs de composants
// ---------------------------------------------------------------------------

function buildMainComponents(uid, T = (k) => k) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(mkId(uid, 'salons')).setLabel(T('scrimConfig.btnSalons')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'perms')).setLabel(T('scrimConfig.btnPerms')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'msgs')).setLabel(T('scrimConfig.btnMsgs')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'reset')).setLabel(T('scrimConfig.btnReset')).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(mkId(uid, 'close')).setLabel(T('scrimConfig.btnClose')).setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildSalonsComponents(uid, T = (k) => k) {
  return [
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(mkId(uid, 'chan_ann'))
        .setPlaceholder(T('scrimConfig.placeholderReception'))
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1)
        .setMaxValues(1),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(mkId(uid, 'rem_ann'))
        .setLabel(T('scrimConfig.btnRemoveReception'))
        .setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(mkId(uid, 'chan_cmd'))
        .setPlaceholder(T('scrimConfig.placeholderCommand'))
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1)
        .setMaxValues(1),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(mkId(uid, 'rem_cmd'))
        .setLabel(T('scrimConfig.btnAllChannels'))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'main')).setLabel(T('scrimConfig.btnBack')).setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildPermsComponents(uid, T = (k) => k) {
  return [
    new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(mkId(uid, 'roles'))
        .setPlaceholder(T('scrimConfig.placeholderRoles', { max: MAX_ROLES }))
        .setMinValues(1)
        .setMaxValues(MAX_ROLES),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(mkId(uid, 'perm_all'))
        .setLabel(T('scrimConfig.btnAllEveryone'))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'main')).setLabel(T('scrimConfig.btnBack')).setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildMsgsComponents(uid, T = (k) => k) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(mkId(uid, 'msg_sel'))
        .setPlaceholder(T('scrimConfig.msgsPlaceholder'))
        .addOptions(
          new StringSelectMenuOptionBuilder()
            .setLabel(T('scrimConfig.msgsPolicyKeepLabel'))
            .setValue(LIFECYCLE_POLICY_KEEP)
            .setDescription(T('scrimConfig.msgsPolicyKeepDesc')),
          new StringSelectMenuOptionBuilder()
            .setLabel(T('scrimConfig.msgsPolicyDeleteLabel'))
            .setValue(LIFECYCLE_POLICY_DELETE)
            .setDescription(T('scrimConfig.msgsPolicyDeleteDesc')),
        ),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(mkId(uid, 'main')).setLabel(T('scrimConfig.btnBack')).setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildResetComponents(uid, T = (k) => k) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(mkId(uid, 'rst_ann')).setLabel(T('scrimConfig.resetBtnAnn')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'rst_cmd')).setLabel(T('scrimConfig.resetBtnCmd')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'rst_perm')).setLabel(T('scrimConfig.resetBtnPerm')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'rst_msg')).setLabel(T('scrimConfig.resetBtnMsg')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'main')).setLabel(T('scrimConfig.btnBack')).setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(mkId(uid, 'rst_all'))
        .setLabel(T('scrimConfig.resetBtnAll'))
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildResetConfirmComponents(uid, T = (k) => k) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(mkId(uid, 'rst_ok'))
        .setLabel(T('scrimConfig.resetConfirmOk'))
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(mkId(uid, 'rst_ko'))
        .setLabel(T('scrimConfig.resetConfirmCancel'))
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Transactions DB (réutilisent les mêmes statements que les anciens handlers)
// ---------------------------------------------------------------------------

/** Remplace tous les rôles autorisés d'un coup (vs l'ancien append-one). */
function transactionSetRoles(ctx, guildId, roleIds) {
  ctx.db.transaction(() => {
    ctx.stmts.deleteScrimAllowedRoles.run(guildId);
    for (const roleId of roleIds) {
      ctx.stmts.insertScrimAllowedRole.run(guildId, roleId);
    }
    ctx.stmts.upsertScrimPermissionMode.run({ guild_id: guildId, mode: 'roles' });
  })();
}

function transactionSetEveryone(ctx, guildId) {
  ctx.db.transaction(() => {
    ctx.stmts.deleteScrimAllowedRoles.run(guildId);
    ctx.stmts.upsertScrimPermissionMode.run({ guild_id: guildId, mode: 'everyone' });
  })();
}

// ---------------------------------------------------------------------------
// Gestionnaire des interactions composants
// ---------------------------------------------------------------------------

/**
 * @param {import('discord.js').MessageComponentInteraction} i
 * @param {import('discord.js').Guild} guild
 * @param {string} guildId
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
 * @param {string} uid
 * @param {import('discord.js').InteractionCollector<any>} collector
 */
async function handleComponent(i, guild, guildId, ctx, uid, collector, T = (k) => k) {
  const action = i.customId.split(':')[2];

  // ── Navigation ────────────────────────────────────────────────────────
  if (action === 'main') {
    const config = readConfig(guildId, ctx.stmts);
    return i.update({ embeds: [buildMainEmbed(config, guild, null, T)], components: buildMainComponents(uid, T) });
  }
  if (action === 'salons') {
    const config = readConfig(guildId, ctx.stmts);
    return i.update({ embeds: [buildSalonsEmbed(config, guild, null, T)], components: buildSalonsComponents(uid, T) });
  }
  if (action === 'perms') {
    const config = readConfig(guildId, ctx.stmts);
    return i.update({ embeds: [buildPermsEmbed(config, guild, null, T)], components: buildPermsComponents(uid, T) });
  }
  if (action === 'msgs') {
    const config = readConfig(guildId, ctx.stmts);
    return i.update({ embeds: [buildMsgsEmbed(config, null, T)], components: buildMsgsComponents(uid, T) });
  }
  if (action === 'reset') {
    return i.update({ embeds: [buildResetEmbed(null, T)], components: buildResetComponents(uid, T) });
  }

  // ── Salon des annonces — set (async : check bypass + permissions bot) ──
  if (action === 'chan_ann') {
    const channelId = i.values[0];
    await i.deferUpdate();

    try {
      // Vérification gate réception (même logique que l'ancien channel set)
      const bypassRow = ctx.stmts.getGuildScrimReceptionBypass.get(guildId);
      if (!mayConfigureScrimReceptionChannel(guild.memberCount, bypassRow)) {
        logger.info('scrimConfigurer.chan_ann — accès révoqué pendant session', { guild_id: guildId });
        // Stoppe le collector → déclenche le handler 'end' qui nettoie activePanels
        collector.stop('access_revoked');
        return i.editReply({
          content: buildScrimReceptionConfigRefusalContent(T),
          embeds: [],
          components: [],
        });
      }

      // Récupération du salon
      let channel = guild.channels.cache.get(channelId) ?? null;
      if (!channel) {
        channel = await guild.channels.fetch(channelId).catch(() => null);
      }
      if (!channel) {
        const config = readConfig(guildId, ctx.stmts);
        return i.editReply({
          embeds: [buildSalonsEmbed(config, guild, T('scrimConfig.chanAnnNotFound'), T)],
          components: buildSalonsComponents(uid, T),
        });
      }

      // Vérification permissions bot
      let botMember = guild.members.me;
      if (!botMember) {
        botMember = await guild.members.fetchMe().catch(() => null);
      }
      const check = assertBotCanPostInChannel(channel, botMember ?? null);
      if (!check.ok) {
        const config = readConfig(guildId, ctx.stmts);
        return i.editReply({
          embeds: [buildSalonsEmbed(config, guild, `❌ ${check.error}`, T)],
          components: buildSalonsComponents(uid, T),
        });
      }

      // Sauvegarde (même statement que l'ancien setupScrimChannel)
      ctx.stmts.upsertGuildChannel.run({
        guild_id: guildId,
        channel_id: channelId,
        game_key: GAME_KEY,
        created_at: Date.now(),
      });
      scheduleNetworkDashboardUpdate(i.client, ctx.stmts);
      logger.event('scrimConfigurer.channel.set', { guild_id: guildId, channel_id: channelId, user_id: i.user.id });

      const config = readConfig(guildId, ctx.stmts);
      return i.editReply({
        embeds: [buildSalonsEmbed(config, guild, T('scrimConfig.chanAnnSet', { channel: `<#${channelId}>` }), T)],
        components: buildSalonsComponents(uid, T),
      });
    } catch (err) {
      logger.error('scrimConfigurer.chan_ann', {
        guild_id: guildId,
        message: err instanceof Error ? err.message : String(err),
      });
      const config = readConfig(guildId, ctx.stmts);
      return i.editReply({
        embeds: [buildSalonsEmbed(config, guild, T('scrimConfig.genericError'), T)],
        components: buildSalonsComponents(uid, T),
      });
    }
  }

  // ── Salon des annonces — remove ──────────────────────────────────────
  if (action === 'rem_ann') {
    const info = ctx.stmts.deleteGuildChannel.run(guildId, GAME_KEY);
    if (info.changes > 0) {
      scheduleNetworkDashboardUpdate(i.client, ctx.stmts);
      logger.event('scrimConfigurer.channel.remove', { guild_id: guildId, user_id: i.user.id });
    }
    const statusMsg = info.changes > 0
      ? T('scrimConfig.chanAnnRemoved')
      : T('scrimConfig.chanAnnNone');
    const config = readConfig(guildId, ctx.stmts);
    return i.update({ embeds: [buildSalonsEmbed(config, guild, statusMsg, T)], components: buildSalonsComponents(uid, T) });
  }

  // ── Salon des commandes — set ────────────────────────────────────────
  if (action === 'chan_cmd') {
    const channelId = i.values[0];
    const cachedCh = guild.channels.cache.get(channelId);
    if (
      cachedCh
      && cachedCh.type !== ChannelType.GuildText
      && cachedCh.type !== ChannelType.GuildAnnouncement
    ) {
      const config = readConfig(guildId, ctx.stmts);
      return i.update({
        embeds: [buildSalonsEmbed(config, guild, T('scrimConfig.chanCmdWrongType'), T)],
        components: buildSalonsComponents(uid, T),
      });
    }
    ctx.stmts.upsertScrimUsageChannel.run({ guild_id: guildId, channel_id: channelId });
    logger.event('scrimConfigurer.command_channel.set', { guild_id: guildId, channel_id: channelId, user_id: i.user.id });
    const config = readConfig(guildId, ctx.stmts);
    return i.update({
      embeds: [buildSalonsEmbed(config, guild, T('scrimConfig.chanCmdSet', { channel: `<#${channelId}>` }), T)],
      components: buildSalonsComponents(uid, T),
    });
  }

  // ── Salon des commandes — reset ──────────────────────────────────────
  if (action === 'rem_cmd') {
    ctx.stmts.deleteScrimUsageChannel.run(guildId);
    logger.event('scrimConfigurer.command_channel.reset', { guild_id: guildId, user_id: i.user.id });
    const config = readConfig(guildId, ctx.stmts);
    return i.update({
      embeds: [buildSalonsEmbed(config, guild, T('scrimConfig.chanCmdRemoved'), T)],
      components: buildSalonsComponents(uid, T),
    });
  }

  // ── Permissions — set rôles ───────────────────────────────────────────
  if (action === 'roles') {
    const roleIds = i.values;
    if (roleIds.length === 0 || roleIds.length > MAX_ROLES) {
      const config = readConfig(guildId, ctx.stmts);
      return i.update({
        embeds: [buildPermsEmbed(config, guild, T('scrimConfig.rolesInvalidCount', { max: MAX_ROLES }), T)],
        components: buildPermsComponents(uid, T),
      });
    }
    transactionSetRoles(ctx, guildId, roleIds);
    logger.event('scrimConfigurer.permissions.set', { guild_id: guildId, role_count: roleIds.length, user_id: i.user.id });
    const config = readConfig(guildId, ctx.stmts);
    const roleList = roleIds.map((rId) => `<@&${rId}>`).join(', ');
    return i.update({
      embeds: [buildPermsEmbed(config, guild, T('scrimConfig.rolesSet', { roles: roleList }), T)],
      components: buildPermsComponents(uid, T),
    });
  }

  // ── Permissions — tout le monde ──────────────────────────────────────
  if (action === 'perm_all') {
    transactionSetEveryone(ctx, guildId);
    logger.event('scrimConfigurer.permissions.everyone', { guild_id: guildId, user_id: i.user.id });
    const config = readConfig(guildId, ctx.stmts);
    return i.update({
      embeds: [buildPermsEmbed(config, guild, T('scrimConfig.everyoneSet'), T)],
      components: buildPermsComponents(uid, T),
    });
  }

  // ── Messages — sélection policy ──────────────────────────────────────
  if (action === 'msg_sel') {
    const policy = i.values[0];
    if (policy !== LIFECYCLE_POLICY_KEEP && policy !== LIFECYCLE_POLICY_DELETE) {
      const config = readConfig(guildId, ctx.stmts);
      return i.update({
        embeds: [buildMsgsEmbed(config, T('scrimConfig.msgsPolicyInvalid'), T)],
        components: buildMsgsComponents(uid, T),
      });
    }
    ctx.stmts.upsertScrimMessageLifecyclePolicy.run({
      guild_id: guildId,
      policy,
      updated_at: new Date().toISOString(),
    });
    logger.event('scrimConfigurer.messages.set', { guild_id: guildId, policy, user_id: i.user.id });
    const config = readConfig(guildId, ctx.stmts);
    const policyLabel = policy === LIFECYCLE_POLICY_DELETE
      ? T('scrimConfig.msgsPolicyDeleteLabel')
      : T('scrimConfig.msgsPolicyKeepLabel');
    return i.update({
      embeds: [buildMsgsEmbed(config, T('scrimConfig.msgsPolicySet', { policy: policyLabel }), T)],
      components: buildMsgsComponents(uid, T),
    });
  }

  // ── Réinitialisation individuelle ─────────────────────────────────────
  if (action === 'rst_ann') {
    const info = ctx.stmts.deleteGuildChannel.run(guildId, GAME_KEY);
    if (info.changes > 0) scheduleNetworkDashboardUpdate(i.client, ctx.stmts);
    logger.event('scrimConfigurer.reset.salon_annonces', { guild_id: guildId, user_id: i.user.id });
    return i.update({ embeds: [buildResetEmbed(T('scrimConfig.resetAnnDone'), T)], components: buildResetComponents(uid, T) });
  }
  if (action === 'rst_cmd') {
    ctx.stmts.deleteScrimUsageChannel.run(guildId);
    logger.event('scrimConfigurer.reset.salon_commandes', { guild_id: guildId, user_id: i.user.id });
    return i.update({ embeds: [buildResetEmbed(T('scrimConfig.resetCmdDone'), T)], components: buildResetComponents(uid, T) });
  }
  if (action === 'rst_perm') {
    transactionSetEveryone(ctx, guildId);
    logger.event('scrimConfigurer.reset.permissions', { guild_id: guildId, user_id: i.user.id });
    return i.update({ embeds: [buildResetEmbed(T('scrimConfig.resetPermDone'), T)], components: buildResetComponents(uid, T) });
  }
  if (action === 'rst_msg') {
    ctx.stmts.deleteScrimMessageLifecyclePolicy.run(guildId);
    logger.event('scrimConfigurer.reset.messages', { guild_id: guildId, user_id: i.user.id });
    return i.update({ embeds: [buildResetEmbed(T('scrimConfig.resetMsgDone'), T)], components: buildResetComponents(uid, T) });
  }

  // ── Réinitialisation complète — confirmation ──────────────────────────
  if (action === 'rst_all') {
    return i.update({ embeds: [buildResetConfirmEmbed(T)], components: buildResetConfirmComponents(uid, T) });
  }
  if (action === 'rst_ok') {
    ctx.db.transaction(() => {
      ctx.stmts.deleteGuildChannel.run(guildId, GAME_KEY);
      ctx.stmts.deleteScrimUsageChannel.run(guildId);
      ctx.stmts.deleteScrimAllowedRoles.run(guildId);
      ctx.stmts.upsertScrimPermissionMode.run({ guild_id: guildId, mode: 'everyone' });
      ctx.stmts.deleteScrimMessageLifecyclePolicy.run(guildId);
    })();
    scheduleNetworkDashboardUpdate(i.client, ctx.stmts);
    logger.event('scrimConfigurer.reset.all', { guild_id: guildId, user_id: i.user.id });
    const config = readConfig(guildId, ctx.stmts);
    return i.update({
      embeds: [buildMainEmbed(config, guild, T('scrimConfig.resetAllDone'), T)],
      components: buildMainComponents(uid, T),
    });
  }
  if (action === 'rst_ko') {
    return i.update({ embeds: [buildResetEmbed(null, T)], components: buildResetComponents(uid, T) });
  }
}

// ---------------------------------------------------------------------------
// Export de la commande
// ---------------------------------------------------------------------------

// Export utilisé uniquement par la suite de tests pour tester le vrai
// parcours du handler de composant (notamment le catch de chan_ann).
// Non utilisé en production.
export { handleComponent as _handleComponentForTest };

export const scrimConfigurer = {
  data: new SlashCommandBuilder()
    .setName('scrim-config')
    .setDescription('Configure ScrimRéseau for this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
   */
  async execute(interaction, ctx) {
    // assertGuildAdministrator gère aussi le cas hors-guilde (fallback fr par défaut)
    const ok = await assertGuildAdministrator(interaction);
    if (!ok) return;

    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({
        content: t('fr', 'generic.guildOnly'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildId = interaction.guildId;
    const guild = interaction.guild;
    const uid = interaction.user.id;

    // Locale résolu dès que guildId est disponible — avant le gate et les erreurs catch.
    const locale = getGuildLocale(guildId, ctx.stmts);
    const T = createTranslator(locale);

    // ── Gate réception scrim — vérification avant toute création de panneau ──
    // Exécuté avant deferReply, readConfig, activePanels et le collector.
    // Utilise le même helper que l'ancien setupScrimChannel.
    try {
      const bypassRow = ctx.stmts.getGuildScrimReceptionBypass.get(guildId);
      if (!mayConfigureScrimReceptionChannel(guild.memberCount, bypassRow)) {
        logger.info('scrimConfigurer.execute — réception non validée', { guild_id: guildId });
        await interaction.reply({
          content: buildScrimReceptionConfigRefusalContent(T),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    } catch (gateErr) {
      logger.error('scrimConfigurer.execute — erreur lecture bypass', {
        guild_id: guildId,
        message: gateErr instanceof Error ? gateErr.message : String(gateErr),
      });
      await interaction.reply({
        content: T('scrimConfig.accessError'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Ferme un panneau déjà ouvert par cet utilisateur sur ce même serveur
    const sKey = sessionKey(guildId, uid);
    const existing = activePanels.get(sKey);
    if (existing) {
      existing.stop('replaced');
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let config;
    try {
      config = readConfig(guildId, ctx.stmts);
    } catch (err) {
      logger.error('scrimConfigurer.execute — readConfig', {
        guild_id: guildId,
        message: err instanceof Error ? err.message : String(err),
      });
      await interaction.editReply({ content: T('scrimConfig.readConfigError') });
      return;
    }

    // Envoi du panneau initial — aucune écriture DB ici
    const message = await interaction.editReply({
      embeds: [buildMainEmbed(config, guild, null, T)],
      components: buildMainComponents(uid, T),
    });

    const collector = message.createMessageComponentCollector({
      time: PANEL_TIMEOUT_MS,
      filter: (i) => i.user.id === uid,
    });

    activePanels.set(sKey, collector);

    collector.on('collect', async (i) => {
      // Bouton Fermer — arrête le collector proprement
      if (i.customId === mkId(uid, 'close')) {
        collector.stop('closed');
        try {
          await i.update({ content: T('scrimConfig.panelClosed'), embeds: [], components: [] });
        } catch {
          /* ignore */
        }
        return;
      }

      // Re-vérification des permissions admin à chaque interaction
      if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        try {
          await i.reply({ content: T('scrimConfig.noPermissions'), flags: MessageFlags.Ephemeral });
        } catch {
          /* ignore */
        }
        return;
      }

      try {
        await handleComponent(i, guild, guildId, ctx, uid, collector, T);
      } catch (err) {
        logger.error('scrimConfigurer.collect', {
          guild_id: guildId,
          customId: i.customId,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        try {
          const errConfig = readConfig(guildId, ctx.stmts);
          if (i.deferred) {
            await i.editReply({
              embeds: [buildMainEmbed(errConfig, guild, T('scrimConfig.genericError'), T)],
              components: buildMainComponents(uid, T),
            });
          } else if (!i.replied) {
            await i.update({
              embeds: [buildMainEmbed(errConfig, guild, T('scrimConfig.genericError'), T)],
              components: buildMainComponents(uid, T),
            });
          }
        } catch {
          /* ignore */
        }
      }
    });

    collector.on('end', async (_, reason) => {
      activePanels.delete(sKey);
      // Expiration naturelle : on signale à l'utilisateur
      if (reason !== 'replaced' && reason !== 'closed' && reason !== 'access_revoked') {
        try {
          await interaction.editReply({ content: T('scrimConfig.panelExpired'), embeds: [], components: [] });
        } catch {
          /* ignore */
        }
      }
    });
  },
};
