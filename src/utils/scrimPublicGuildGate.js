/**
 * Restriction /recherche-scrim : l’utilisateur doit être membre du serveur public ScrimRéseau.
 * Vérif. ponctuelle via API (guild.members.fetch) — le bot doit être dans cette guilde.
 */

import { logger } from './logger.js';

/** Discord API : Unknown Member (utilisateur pas dans la guilde). */
const DISCORD_UNKNOWN_MEMBER = 10007;

/**
 * @returns {string | null}
 */
export function getScrimReseauPublicGuildIdFromEnv() {
  const s = process.env.SCRIMRESEAU_PUBLIC_GUILD_ID?.trim();
  return s || null;
}

/**
 * Lien affiché dans le message de refus (invite ou URL déjà utilisée ailleurs).
 * @returns {string}
 */
export function getScrimReseauPublicInviteUrlForMessage() {
  const direct = process.env.SCRIMRESEAU_PUBLIC_INVITE_URL?.trim();
  if (direct) return direct;
  const fallback = process.env.SCRIM_COMMUNITY_SERVER_URL?.trim();
  if (fallback) return fallback;
  return 'https://discord.gg/';
}

/**
 * @param {string} inviteUrl
 * @returns {string}
 */
export function buildScrimReseauPublicMembershipRefusalContent(inviteUrl) {
  return (
    `Bonjour, pour utiliser cette commande, tu dois être présent sur le Discord ScrimRéseau : ${inviteUrl}\n\n` +
    'Une fois dedans, tu pourras faire tes recherches depuis ton propre serveur. Cela permet aux autres joueurs de pouvoir te retrouver et te contacter plus facilement pour organiser les scrims.\n\n' +
    'Les autres commandes du bot restent disponibles.'
  );
}

/**
 * @param {import('discord.js').Client} client
 * @param {string} userId
 * @returns {Promise<{ ok: true } | { ok: false, content: string }>}
 */
export async function checkScrimReseauPublicGuildMembership(client, userId) {
  const guildId = getScrimReseauPublicGuildIdFromEnv();
  if (!guildId) {
    logger.warn(
      'scrimPublicGuildGate: SCRIMRESEAU_PUBLIC_GUILD_ID absent — restriction /recherche-scrim désactivée',
    );
    return { ok: true };
  }

  const inviteUrl = getScrimReseauPublicInviteUrlForMessage();

  let guild;
  try {
    guild =
      client.guilds.cache.get(guildId) ??
      (await client.guilds.fetch(guildId));
  } catch (err) {
    logger.error('scrimPublicGuildGate: guilde publique inaccessible (bot absent ou ID invalide)', {
      guild_id: guildId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: true };
  }

  if (!guild) {
    return { ok: true };
  }

  try {
    await guild.members.fetch({ user: userId, force: true });
    return { ok: true };
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? /** @type {{ code?: number }} */ (err).code
        : undefined;

    if (code === DISCORD_UNKNOWN_MEMBER) {
      return {
        ok: false,
        content: buildScrimReseauPublicMembershipRefusalContent(inviteUrl),
      };
    }

    logger.error('scrimPublicGuildGate: erreur lors du fetch membre', {
      guild_id: guildId,
      user_id: userId,
      code,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: true };
  }
}
