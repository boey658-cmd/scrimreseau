/**
 * Restriction /recherche-scrim : l’utilisateur doit être membre du serveur public ScrimRéseau.
 * Vérif. ponctuelle via API (guild.members.fetch) — le bot doit être dans cette guilde.
 */

import { getScrimCommunityServerUrlFromEnv } from '../services/scrimEmbedBuilder.js';
import { t } from '../i18n/index.js';
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
 * True si `guildId` est le serveur public ScrimRéseau (env), jamais via le nom.
 * @param {string | null | undefined} guildId
 * @returns {boolean}
 */
export function isScrimReseauPublicGuildId(guildId) {
  const publicId = getScrimReseauPublicGuildIdFromEnv();
  return Boolean(publicId && guildId === publicId);
}

/**
 * Lien affiché dans le message de refus — même source que le bouton
 * « Rejoindre le serveur ScrimRéseau » (`SCRIM_COMMUNITY_SERVER_URL`).
 * @returns {string}
 */
export function getScrimReseauPublicInviteUrlForMessage() {
  return getScrimCommunityServerUrlFromEnv() ?? 'https://discord.gg/';
}

/**
 * @param {string} inviteUrl
 * @returns {string}
 */
export function buildScrimReseauPublicMembershipRefusalContent(inviteUrl, locale = 'fr') {
  return t(locale, 'publicGate.refusal', { url: inviteUrl });
}

/**
 * @param {string} inviteUrl
 * @param {string} [locale]
 * @returns {string}
 */
export function buildScrimReseauPublicContactMembershipRefusalContent(inviteUrl, locale = 'fr') {
  return t(locale, 'publicGate.contactRefusal', { url: inviteUrl });
}

/**
 * @param {import('discord.js').Client} client
 * @param {string} userId
 * @param {string} [locale]
 * @param {{
 *   failClosedOnError?: boolean,
 *   refusalKey?: string,
 * }} [options]
 *   `failClosedOnError` défaut false = comportement historique fail-open (sauf 10007).
 *   `refusalKey` défaut `publicGate.refusal` (auteur) ; contact utilise `publicGate.contactRefusal`.
 * @returns {Promise<{ ok: true } | { ok: false, content: string }>}
 */
export async function checkScrimReseauPublicGuildMembership(
  client,
  userId,
  locale = 'fr',
  options = {},
) {
  const failClosedOnError = options?.failClosedOnError === true;
  const refusalKey =
    typeof options?.refusalKey === 'string' && options.refusalKey
      ? options.refusalKey
      : 'publicGate.refusal';

  const guildId = getScrimReseauPublicGuildIdFromEnv();
  if (!guildId) {
    logger.warn(
      'scrimPublicGuildGate: SCRIMRESEAU_PUBLIC_GUILD_ID absent — restriction /recherche-scrim désactivée',
    );
    return { ok: true };
  }

  const inviteUrl = getScrimReseauPublicInviteUrlForMessage();
  const refusalContent = () => t(locale, refusalKey, { url: inviteUrl });

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
    if (failClosedOnError) {
      return { ok: false, content: refusalContent() };
    }
    return { ok: true };
  }

  if (!guild) {
    if (failClosedOnError) {
      return { ok: false, content: refusalContent() };
    }
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
        content: refusalContent(),
      };
    }

    logger.error('scrimPublicGuildGate: erreur lors du fetch membre', {
      guild_id: guildId,
      user_id: userId,
      code,
      message: err instanceof Error ? err.message : String(err),
    });
    if (failClosedOnError) {
      return { ok: false, content: refusalContent() };
    }
    return { ok: true };
  }
}
