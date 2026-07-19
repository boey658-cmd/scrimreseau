/**
 * /scrim-configurer — Panneau de configuration interactif ScrimRéseau.
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
import { mayConfigureScrimReceptionChannel } from '../utils/guildScrimReceptionGate.js';
import { logger } from '../utils/logger.js';

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

function buildMainEmbed(config, guild, statusMsg = null) {
  const receptionText = channelDisplay(config.reception?.channel_id, guild) ?? `*Non configuré*`;
  const usageText = channelDisplay(config.usage?.channel_id, guild) ?? `*Tous les salons*`;

  const permMode = config.permMode?.mode ?? 'everyone';
  let permsText;
  if (permMode === 'everyone') {
    permsText = 'Tout le monde';
  } else if (config.allowedRoles.length === 0) {
    permsText = `Rôles spécifiques *(aucun rôle configuré)*`;
  } else {
    const roleList = config.allowedRoles.map((r) => roleDisplay(r.role_id, guild)).join(', ');
    permsText = `Rôles : ${roleList}`;
  }

  const policy = config.policy?.policy ?? 'keep';
  const policyText = policy === 'delete' ? 'Supprimer automatiquement' : 'Garder et marquer';

  const descLines = [];
  if (statusMsg) { descLines.push(statusMsg, ''); }
  descLines.push('Utilisez les boutons pour modifier la configuration de ce serveur.');

  return new EmbedBuilder()
    .setTitle('⚙️ Configuration ScrimRéseau')
    .setDescription(descLines.join('\n'))
    .setColor(EMBED_COLOR)
    .addFields(
      { name: '📢 Salon des annonces', value: receptionText, inline: true },
      { name: '📝 Salon des commandes', value: usageText, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: '🔑 Permissions /recherche-scrim', value: permsText, inline: false },
      { name: '💬 Messages inactifs', value: policyText, inline: false },
    )
    .setTimestamp();
}

function buildSalonsEmbed(config, guild, statusMsg = null) {
  const receptionText = channelDisplay(config.reception?.channel_id, guild) ?? `*Non configuré*`;
  const usageText = channelDisplay(config.usage?.channel_id, guild) ?? `*Tous les salons*`;

  const descLines = [];
  if (statusMsg) { descLines.push(statusMsg, ''); }
  descLines.push(
    `**Salon des annonces** — où sont publiées les recherches de scrim.`,
    `**Salon des commandes** — où \`/recherche-scrim\` peut être utilisée.`,
  );

  return new EmbedBuilder()
    .setTitle('📢 Configuration — Salons')
    .setDescription(descLines.join('\n'))
    .setColor(EMBED_COLOR)
    .addFields(
      { name: 'Salon des annonces', value: receptionText, inline: true },
      { name: 'Salon des commandes', value: usageText, inline: true },
    );
}

function buildPermsEmbed(config, guild, statusMsg = null) {
  const permMode = config.permMode?.mode ?? 'everyone';
  let currentText;
  if (permMode === 'everyone') {
    currentText = 'Tout le monde';
  } else if (config.allowedRoles.length === 0) {
    currentText = `Rôles spécifiques *(aucun rôle configuré)*`;
  } else {
    const roleList = config.allowedRoles.map((r) => roleDisplay(r.role_id, guild)).join(', ');
    currentText = `Rôles : ${roleList}`;
  }

  const descLines = [];
  if (statusMsg) { descLines.push(statusMsg, ''); }
  descLines.push(
    `Sélectionnez les rôles autorisés à utiliser \`/recherche-scrim\` (max ${MAX_ROLES}).`,
    `La sélection **remplace** la liste actuelle.`,
    `Pour autoriser tout le monde, utilisez le bouton dédié.`,
  );

  return new EmbedBuilder()
    .setTitle('🔑 Configuration — Permissions')
    .setDescription(descLines.join('\n'))
    .setColor(EMBED_COLOR)
    .addFields({ name: 'Configuration actuelle', value: currentText });
}

function buildMsgsEmbed(config, statusMsg = null) {
  const policy = config.policy?.policy ?? 'keep';
  const policyText = policy === 'delete'
    ? 'Supprimer automatiquement'
    : 'Garder et marquer les messages';

  const descLines = [];
  if (statusMsg) { descLines.push(statusMsg, ''); }
  descLines.push(`Comportement des messages de scrims **terminés, expirés ou remplacés** sur ce serveur.`);

  return new EmbedBuilder()
    .setTitle('💬 Configuration — Messages inactifs')
    .setDescription(descLines.join('\n'))
    .setColor(EMBED_COLOR)
    .addFields({ name: 'Configuration actuelle', value: policyText });
}

function buildResetEmbed(statusMsg = null) {
  const descLines = [];
  if (statusMsg) { descLines.push(statusMsg, ''); }
  descLines.push(
    'Choisissez ce que vous souhaitez réinitialiser.',
    `**Attention** : la réinitialisation complète demande une confirmation.`,
  );

  return new EmbedBuilder()
    .setTitle('🔄 Réinitialisation')
    .setDescription(descLines.join('\n'))
    .setColor(0xed4245);
}

function buildResetConfirmEmbed() {
  return new EmbedBuilder()
    .setTitle(`⚠️ Confirmer la réinitialisation complète ?`)
    .setDescription(
      `Cette action va **supprimer toute la configuration** de ce serveur :\n` +
      `- Salon des annonces\n` +
      `- Salon des commandes\n` +
      `- Permissions\n` +
      `- Politique des messages\n\n` +
      `**Cette action est irréversible. Confirmez-vous ?**`,
    )
    .setColor(0xed4245);
}

// ---------------------------------------------------------------------------
// Constructeurs de composants
// ---------------------------------------------------------------------------

function buildMainComponents(uid) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(mkId(uid, 'salons')).setLabel('📢 Salons').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'perms')).setLabel('🔑 Permissions').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'msgs')).setLabel('💬 Messages').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'reset')).setLabel('🔄 Réinitialiser').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(mkId(uid, 'close')).setLabel('✖ Fermer').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildSalonsComponents(uid) {
  return [
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(mkId(uid, 'chan_ann'))
        .setPlaceholder('Choisir le salon des annonces scrim')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1)
        .setMaxValues(1),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(mkId(uid, 'rem_ann'))
        .setLabel('Retirer le salon des annonces')
        .setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(mkId(uid, 'chan_cmd'))
        .setPlaceholder('Restreindre /recherche-scrim à un salon')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1)
        .setMaxValues(1),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(mkId(uid, 'rem_cmd'))
        .setLabel('Autoriser les commandes partout')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'main')).setLabel('← Retour').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildPermsComponents(uid) {
  return [
    new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(mkId(uid, 'roles'))
        .setPlaceholder(`Sélectionnez les rôles autorisés (1 à ${MAX_ROLES})`)
        .setMinValues(1)
        .setMaxValues(MAX_ROLES),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(mkId(uid, 'perm_all'))
        .setLabel('Autoriser tout le monde')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'main')).setLabel('← Retour').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildMsgsComponents(uid) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(mkId(uid, 'msg_sel'))
        .setPlaceholder('Choisir le comportement des messages inactifs')
        .addOptions(
          new StringSelectMenuOptionBuilder()
            .setLabel('Garder et marquer les messages')
            .setValue(LIFECYCLE_POLICY_KEEP)
            .setDescription('Comportement par défaut'),
          new StringSelectMenuOptionBuilder()
            .setLabel('Supprimer automatiquement')
            .setValue(LIFECYCLE_POLICY_DELETE)
            .setDescription('Supprime les annonces de scrims terminés/remplacés'),
        ),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(mkId(uid, 'main')).setLabel('← Retour').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildResetComponents(uid) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(mkId(uid, 'rst_ann')).setLabel('Salon annonces').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'rst_cmd')).setLabel('Salon commandes').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'rst_perm')).setLabel('Permissions').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'rst_msg')).setLabel('Messages').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(mkId(uid, 'main')).setLabel('← Retour').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(mkId(uid, 'rst_all'))
        .setLabel('⚠️ Tout réinitialiser')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildResetConfirmComponents(uid) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(mkId(uid, 'rst_ok'))
        .setLabel('✅ Confirmer')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(mkId(uid, 'rst_ko'))
        .setLabel('❌ Annuler')
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
 */
async function handleComponent(i, guild, guildId, ctx, uid) {
  const action = i.customId.split(':')[2];

  // ── Navigation ────────────────────────────────────────────────────────
  if (action === 'main') {
    const config = readConfig(guildId, ctx.stmts);
    return i.update({ embeds: [buildMainEmbed(config, guild)], components: buildMainComponents(uid) });
  }
  if (action === 'salons') {
    const config = readConfig(guildId, ctx.stmts);
    return i.update({ embeds: [buildSalonsEmbed(config, guild)], components: buildSalonsComponents(uid) });
  }
  if (action === 'perms') {
    const config = readConfig(guildId, ctx.stmts);
    return i.update({ embeds: [buildPermsEmbed(config, guild)], components: buildPermsComponents(uid) });
  }
  if (action === 'msgs') {
    const config = readConfig(guildId, ctx.stmts);
    return i.update({ embeds: [buildMsgsEmbed(config)], components: buildMsgsComponents(uid) });
  }
  if (action === 'reset') {
    return i.update({ embeds: [buildResetEmbed()], components: buildResetComponents(uid) });
  }

  // ── Salon des annonces — set (async : check bypass + permissions bot) ──
  if (action === 'chan_ann') {
    const channelId = i.values[0];
    await i.deferUpdate();

    try {
      // Vérification gate réception (même logique que l'ancien channel set)
      const bypassRow = ctx.stmts.getGuildScrimReceptionBypass.get(guildId);
      if (!mayConfigureScrimReceptionChannel(guild.memberCount, bypassRow)) {
        const config = readConfig(guildId, ctx.stmts);
        logger.info('scrimConfigurer.chan_ann — réception non validée', { guild_id: guildId });
        return i.editReply({
          embeds: [buildSalonsEmbed(config, guild,
            `⛔ Ce salon ne peut pas être configuré — votre serveur doit être validé manuellement par l'équipe ScrimRéseau.`,
          )],
          components: buildSalonsComponents(uid),
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
          embeds: [buildSalonsEmbed(config, guild, `❌ Salon introuvable.`)],
          components: buildSalonsComponents(uid),
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
          embeds: [buildSalonsEmbed(config, guild, `❌ ${check.error}`)],
          components: buildSalonsComponents(uid),
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
        embeds: [buildSalonsEmbed(config, guild, `✅ Salon des annonces configuré : <#${channelId}>`)],
        components: buildSalonsComponents(uid),
      });
    } catch (err) {
      logger.error('scrimConfigurer.chan_ann', {
        guild_id: guildId,
        message: err instanceof Error ? err.message : String(err),
      });
      const config = readConfig(guildId, ctx.stmts);
      return i.editReply({
        embeds: [buildSalonsEmbed(config, guild, `❌ Une erreur est survenue. Réessayez.`)],
        components: buildSalonsComponents(uid),
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
      ? `✅ Salon des annonces retiré.`
      : `ℹ️ Aucun salon d'annonces n'était configuré.`;
    const config = readConfig(guildId, ctx.stmts);
    return i.update({ embeds: [buildSalonsEmbed(config, guild, statusMsg)], components: buildSalonsComponents(uid) });
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
        embeds: [buildSalonsEmbed(config, guild, `❌ Choisis un salon texte ou une annonce.`)],
        components: buildSalonsComponents(uid),
      });
    }
    ctx.stmts.upsertScrimUsageChannel.run({ guild_id: guildId, channel_id: channelId });
    logger.event('scrimConfigurer.command_channel.set', { guild_id: guildId, channel_id: channelId, user_id: i.user.id });
    const config = readConfig(guildId, ctx.stmts);
    return i.update({
      embeds: [buildSalonsEmbed(config, guild, `✅ Salon des commandes configuré : <#${channelId}>`)],
      components: buildSalonsComponents(uid),
    });
  }

  // ── Salon des commandes — reset ──────────────────────────────────────
  if (action === 'rem_cmd') {
    ctx.stmts.deleteScrimUsageChannel.run(guildId);
    logger.event('scrimConfigurer.command_channel.reset', { guild_id: guildId, user_id: i.user.id });
    const config = readConfig(guildId, ctx.stmts);
    return i.update({
      embeds: [buildSalonsEmbed(config, guild, `✅ Les commandes sont maintenant autorisées partout.`)],
      components: buildSalonsComponents(uid),
    });
  }

  // ── Permissions — set rôles ───────────────────────────────────────────
  if (action === 'roles') {
    const roleIds = i.values;
    if (roleIds.length === 0 || roleIds.length > MAX_ROLES) {
      const config = readConfig(guildId, ctx.stmts);
      return i.update({
        embeds: [buildPermsEmbed(config, guild, `❌ Sélectionnez entre 1 et ${MAX_ROLES} rôles.`)],
        components: buildPermsComponents(uid),
      });
    }
    transactionSetRoles(ctx, guildId, roleIds);
    logger.event('scrimConfigurer.permissions.set', { guild_id: guildId, role_count: roleIds.length, user_id: i.user.id });
    const config = readConfig(guildId, ctx.stmts);
    const roleList = roleIds.map((rId) => `<@&${rId}>`).join(', ');
    return i.update({
      embeds: [buildPermsEmbed(config, guild, `✅ Permissions mises à jour : ${roleList}`)],
      components: buildPermsComponents(uid),
    });
  }

  // ── Permissions — tout le monde ──────────────────────────────────────
  if (action === 'perm_all') {
    transactionSetEveryone(ctx, guildId);
    logger.event('scrimConfigurer.permissions.everyone', { guild_id: guildId, user_id: i.user.id });
    const config = readConfig(guildId, ctx.stmts);
    return i.update({
      embeds: [buildPermsEmbed(config, guild, `✅ Tout le monde peut utiliser /recherche-scrim.`)],
      components: buildPermsComponents(uid),
    });
  }

  // ── Messages — sélection policy ──────────────────────────────────────
  if (action === 'msg_sel') {
    const policy = i.values[0];
    if (policy !== LIFECYCLE_POLICY_KEEP && policy !== LIFECYCLE_POLICY_DELETE) {
      const config = readConfig(guildId, ctx.stmts);
      return i.update({
        embeds: [buildMsgsEmbed(config, `❌ Valeur invalide.`)],
        components: buildMsgsComponents(uid),
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
      ? 'Supprimer automatiquement'
      : 'Garder et marquer les messages';
    return i.update({
      embeds: [buildMsgsEmbed(config, `✅ Politique mise à jour : **${policyLabel}**`)],
      components: buildMsgsComponents(uid),
    });
  }

  // ── Réinitialisation individuelle ─────────────────────────────────────
  if (action === 'rst_ann') {
    const info = ctx.stmts.deleteGuildChannel.run(guildId, GAME_KEY);
    if (info.changes > 0) scheduleNetworkDashboardUpdate(i.client, ctx.stmts);
    logger.event('scrimConfigurer.reset.salon_annonces', { guild_id: guildId, user_id: i.user.id });
    return i.update({ embeds: [buildResetEmbed(`✅ Salon des annonces réinitialisé.`)], components: buildResetComponents(uid) });
  }
  if (action === 'rst_cmd') {
    ctx.stmts.deleteScrimUsageChannel.run(guildId);
    logger.event('scrimConfigurer.reset.salon_commandes', { guild_id: guildId, user_id: i.user.id });
    return i.update({ embeds: [buildResetEmbed(`✅ Salon des commandes réinitialisé.`)], components: buildResetComponents(uid) });
  }
  if (action === 'rst_perm') {
    transactionSetEveryone(ctx, guildId);
    logger.event('scrimConfigurer.reset.permissions', { guild_id: guildId, user_id: i.user.id });
    return i.update({ embeds: [buildResetEmbed(`✅ Permissions réinitialisées (tout le monde).`)], components: buildResetComponents(uid) });
  }
  if (action === 'rst_msg') {
    ctx.stmts.deleteScrimMessageLifecyclePolicy.run(guildId);
    logger.event('scrimConfigurer.reset.messages', { guild_id: guildId, user_id: i.user.id });
    return i.update({ embeds: [buildResetEmbed(`✅ Politique des messages réinitialisée.`)], components: buildResetComponents(uid) });
  }

  // ── Réinitialisation complète — confirmation ──────────────────────────
  if (action === 'rst_all') {
    return i.update({ embeds: [buildResetConfirmEmbed()], components: buildResetConfirmComponents(uid) });
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
      embeds: [buildMainEmbed(config, guild, `✅ Configuration entièrement réinitialisée.`)],
      components: buildMainComponents(uid),
    });
  }
  if (action === 'rst_ko') {
    return i.update({ embeds: [buildResetEmbed()], components: buildResetComponents(uid) });
  }
}

// ---------------------------------------------------------------------------
// Export de la commande
// ---------------------------------------------------------------------------

export const scrimConfigurer = {
  data: new SlashCommandBuilder()
    .setName('scrim-configurer')
    .setDescription('Panneau de configuration interactif ScrimRéseau')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
   */
  async execute(interaction, ctx) {
    const ok = await assertGuildAdministrator(interaction);
    if (!ok) return;

    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({
        content: `❌ Cette commande doit être utilisée sur un serveur.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildId = interaction.guildId;
    const guild = interaction.guild;
    const uid = interaction.user.id;

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
      await interaction.editReply({ content: `❌ Impossible de lire la configuration. Réessayez plus tard.` });
      return;
    }

    // Envoi du panneau initial — aucune écriture DB ici
    const message = await interaction.editReply({
      embeds: [buildMainEmbed(config, guild)],
      components: buildMainComponents(uid),
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
          await i.update({ content: `✅ Panneau fermé.`, embeds: [], components: [] });
        } catch {
          /* ignore */
        }
        return;
      }

      // Re-vérification des permissions admin à chaque interaction
      if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        try {
          await i.reply({ content: `❌ Vous n'avez plus les permissions nécessaires.`, flags: MessageFlags.Ephemeral });
        } catch {
          /* ignore */
        }
        return;
      }

      try {
        await handleComponent(i, guild, guildId, ctx, uid);
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
              embeds: [buildMainEmbed(errConfig, guild, `❌ Une erreur est survenue.`)],
              components: buildMainComponents(uid),
            });
          } else if (!i.replied) {
            await i.update({
              embeds: [buildMainEmbed(errConfig, guild, `❌ Une erreur est survenue.`)],
              components: buildMainComponents(uid),
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
      if (reason !== 'replaced' && reason !== 'closed') {
        try {
          await interaction.editReply({ content: `⏰ Le panneau a expiré.`, embeds: [], components: [] });
        } catch {
          /* ignore */
        }
      }
    });
  },
};
