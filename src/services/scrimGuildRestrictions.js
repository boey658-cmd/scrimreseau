import { logger } from '../utils/logger.js';

/** @typedef {{ ok: true } | { ok: false, error: string }} ScrimGateResult */

export const MSG_WRONG_SCRIM_CHANNEL =
  '❌ Tu ne peux pas utiliser cette commande dans ce salon.';

export const MSG_NO_SCRIM_PERMISSION =
  '❌ Tu n’as pas la permission d’utiliser cette commande.';

export const MSG_SCRIM_GUILD_CONFIG_ERROR =
  '❌ Impossible de vérifier la configuration du serveur. Réessayez plus tard.';

/**
 * Identifiant du salon « parent » pour la contrainte d’usage : fil ou salon classique.
 * @param {import('discord.js').Channel | null | undefined} channel
 * @returns {string | null}
 */
export function getScrimUsageParentChannelId(channel) {
  if (!channel || typeof channel !== 'object') return null;
  if (
    'isThread' in channel
    && typeof channel.isThread === 'function'
    && channel.isThread()
  ) {
    const parentId =
      'parentId' in channel ? /** @type {{ parentId: string | null }} */ (channel).parentId : null;
    return parentId ?? null;
  }
  if ('id' in channel && typeof /** @type {{ id: string }} */ (channel).id === 'string') {
    return /** @type {{ id: string }} */ (channel).id;
  }
  return null;
}

/**
 * Salon d’usage de /recherche-scrim pour ce serveur (si défini).
 * Sans ligne en base : autorise sans résoudre le canal courant.
 * Avec restriction : fils → compare le salon parent enregistré.
 * @param {string} guildId
 * @param {import('discord.js').Channel | null | undefined} channel Salon ou fil (interaction.channel)
 * @param {{ getScrimUsageChannel: import('better-sqlite3').Statement }} stmts
 * @returns {ScrimGateResult}
 */
export function checkScrimChannel(guildId, channel, stmts) {
  try {
    const row = stmts.getScrimUsageChannel.get(guildId);
    if (!row?.channel_id) {
      return { ok: true };
    }

    const effectiveId = getScrimUsageParentChannelId(channel);
    if (effectiveId === null) {
      logger.warn('checkScrimChannel: canal efficace introuvable (restriction configurée)', {
        guild_id: guildId,
        channel_id_configured: row.channel_id,
      });
      return { ok: false, error: MSG_SCRIM_GUILD_CONFIG_ERROR };
    }
    if (row.channel_id !== effectiveId) {
      return { ok: false, error: MSG_WRONG_SCRIM_CHANNEL };
    }
    return { ok: true };
  } catch (err) {
    logger.error('checkScrimChannel', {
      guild_id: guildId,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return { ok: false, error: MSG_SCRIM_GUILD_CONFIG_ERROR };
  }
}

/**
 * Supprime en base les entrées dont le rôle n’existe plus sur la guilde.
 * À n’appeler que depuis un flux explicite (ex. future commande admin), pas automatiquement.
 * @param {string} guildId
 * @param {import('discord.js').Guild} guild
 * @param {{
 *   listScrimAllowedRoles: import('better-sqlite3').Statement,
 *   deleteScrimAllowedRole: import('better-sqlite3').Statement,
 * }} stmts
 * @returns {{ ok: true, removed: number } | { ok: false, removed: number, error: string }}
 */
/**
 * Nombre d’entrées en base dont le rôle n’existe plus dans le cache de la guilde.
 * @param {{ role_id: string }[]} roleRows
 * @param {import('discord.js').Guild} guild
 * @returns {number}
 */
export function countStaleScrimConfiguredRoles(roleRows, guild) {
  if (!roleRows.length) return 0;
  if (!guild?.roles?.cache) return roleRows.length;
  return roleRows.filter((r) => !guild.roles.cache.has(r.role_id)).length;
}

export function cleanInvalidRoles(guildId, guild, stmts) {
  let removed = 0;
  try {
    const rows = stmts.listScrimAllowedRoles.all(guildId);
    for (const row of rows) {
      const roleId = row.role_id;
      if (!guild.roles.cache.has(roleId)) {
        stmts.deleteScrimAllowedRole.run(guildId, roleId);
        removed += 1;
      }
    }
    if (removed > 0) {
      logger.info('cleanInvalidRoles', { guild_id: guildId, removed });
    }
    return { ok: true, removed };
  } catch (err) {
    logger.error('cleanInvalidRoles', {
      guild_id: guildId,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return {
      ok: false,
      removed,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Qui peut lancer /recherche-scrim dans ce serveur (hors broadcast).
 * Défaut sans ligne en base : everyone.
 * Rôles inexistants sur la guilde sont ignorés ; s’il ne reste aucun rôle valide en mode « roles » → ouverture (fallback type everyone) + warn en log.
 * @param {import('discord.js').GuildMember | import('discord.js').APIInteractionGuildMember | null} member
 * @param {string} guildId
 * @param {import('discord.js').Guild | null} guild
 * @param {{
 *   getScrimPermissionMode: import('better-sqlite3').Statement,
 *   listScrimAllowedRoles: import('better-sqlite3').Statement,
 * }} stmts
 * @returns {ScrimGateResult}
 */
export function checkScrimPermissions(member, guildId, guild, stmts) {
  try {
    const rowMode = stmts.getScrimPermissionMode.get(guildId);
    const mode = rowMode?.mode ?? 'everyone';

    if (mode === 'everyone') {
      return { ok: true };
    }

    if (mode !== 'roles') {
      logger.warn('checkScrimPermissions: mode inconnu, refus par prudence', {
        guild_id: guildId,
        mode,
      });
      return { ok: false, error: MSG_NO_SCRIM_PERMISSION };
    }

    const roleRows = stmts.listScrimAllowedRoles.all(guildId);

    if (!guild?.roles?.cache) {
      logger.warn('checkScrimPermissions: cache des rôles indisponible', {
        guild_id: guildId,
      });
      return { ok: false, error: MSG_SCRIM_GUILD_CONFIG_ERROR };
    }

    const validRoleIds = roleRows
      .map((r) => r.role_id)
      .filter((id) => guild.roles.cache.has(id));

    if (validRoleIds.length === 0) {
      logger.warn('Scrim permissions fallback to everyone: no valid roles remaining', {
        guildId,
      });
      return { ok: true };
    }

    const allowedIds = new Set(validRoleIds);

    if (!member || typeof member !== 'object') {
      return { ok: false, error: MSG_NO_SCRIM_PERMISSION };
    }

    /** GuildMember */
    if (
      'roles' in member
      && member.roles
      && typeof member.roles === 'object'
      && 'cache' in member.roles
      && member.roles.cache
    ) {
      const cache = member.roles.cache;
      for (const roleId of allowedIds) {
        if (cache.has(roleId)) {
          return { ok: true };
        }
      }
      return { ok: false, error: MSG_NO_SCRIM_PERMISSION };
    }

    /** APIInteractionGuildMember : roles = Snowflake[] */
    if (
      'roles' in member
      && Array.isArray(member.roles)
      && member.roles.every((x) => typeof x === 'string')
    ) {
      const have = new Set(member.roles);
      for (const roleId of allowedIds) {
        if (have.has(roleId)) {
          return { ok: true };
        }
      }
      return { ok: false, error: MSG_NO_SCRIM_PERMISSION };
    }

    return { ok: false, error: MSG_NO_SCRIM_PERMISSION };
  } catch (err) {
    logger.error('checkScrimPermissions', {
      guild_id: guildId,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return { ok: false, error: MSG_SCRIM_GUILD_CONFIG_ERROR };
  }
}
