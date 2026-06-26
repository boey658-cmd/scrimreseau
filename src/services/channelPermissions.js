import {
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';

/** Message utilisateur si le bot manque de droits sur le salon (texte contractuel). */
export const MSG_BOT_PERMISSIONS_SALON_INSUFFISANTES =
  'Je n’ai pas les permissions nécessaires dans ce salon. Vérifie : Voir le salon, Envoyer des messages, Intégrer des liens.';

/**
 * Vérifie que le bot peut voir le salon, envoyer des messages et intégrer des embeds.
 * @param {import('discord.js').GuildChannel | null} channel
 * @param {import('discord.js').GuildMember | null} botMember
 * @returns {{ ok: boolean, error?: string }}
 */
export function assertBotCanPostInChannel(channel, botMember) {
  if (!channel) {
    return { ok: false, error: 'Salon introuvable.' };
  }
  if (
    channel.type !== ChannelType.GuildText
    && channel.type !== ChannelType.GuildAnnouncement
  ) {
    return {
      ok: false,
      error: 'Le salon doit être un salon texte ou une annonce.',
    };
  }
  if (!botMember) {
    return { ok: false, error: 'Impossible de vérifier les permissions du bot.' };
  }

  const perms = channel.permissionsFor(botMember);
  if (!perms) {
    return {
      ok: false,
      error:
        'Impossible de déterminer les permissions du bot sur ce salon (salon inaccessible ou droits indisponibles).',
    };
  }

  const need = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ];

  const missing = need.filter((p) => !perms.has(p));
  if (missing.length > 0) {
    return {
      ok: false,
      error: MSG_BOT_PERMISSIONS_SALON_INSUFFISANTES,
    };
  }

  return { ok: true };
}

/** Message utilisateur si le bot manque de droits pour supprimer des messages. */
export const MSG_BOT_PERMISSIONS_DELETE_INSUFFISANTES =
  `Je n'ai pas les permissions nécessaires pour supprimer des messages dans ce salon. Vérifie : Voir le salon, Voir l'historique des messages, Gérer les messages.`;

/**
 * Vérifie que le bot peut supprimer des messages dans le salon
 * (ViewChannel + ReadMessageHistory + ManageMessages).
 * @param {import('discord.js').GuildChannel | null} channel
 * @param {import('discord.js').GuildMember | null} botMember
 * @returns {{ ok: boolean, error?: string }}
 */
export function assertBotCanDeleteInChannel(channel, botMember) {
  if (!channel) {
    return { ok: false, error: 'Salon introuvable.' };
  }
  if (
    channel.type !== ChannelType.GuildText
    && channel.type !== ChannelType.GuildAnnouncement
  ) {
    return {
      ok: false,
      error: 'Le salon doit être un salon texte ou une annonce.',
    };
  }
  if (!botMember) {
    return { ok: false, error: 'Impossible de vérifier les permissions du bot.' };
  }

  const perms = channel.permissionsFor(botMember);
  if (!perms) {
    return {
      ok: false,
      error: 'Impossible de déterminer les permissions du bot sur ce salon.',
    };
  }

  const need = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageMessages,
  ];

  const missing = need.filter((p) => !perms.has(p));
  if (missing.length > 0) {
    return {
      ok: false,
      error: MSG_BOT_PERMISSIONS_DELETE_INSUFFISANTES,
    };
  }

  return { ok: true };
}
