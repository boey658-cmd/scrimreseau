/**
 * Helpers transactionnels permissions scrim (utilisés par guildConfigWrites).
 * Execute Discord = redirection dashboard Phase 0.5 (0 write depuis slash).
 */

import { fr } from '../i18n/fr.js';
import { replyConfigDashboardRedirect } from '../utils/legacyConfigDiscordRedirect.js';

export const SCRIM_ALLOWED_ROLES_MAX = 5;

/** @deprecated Prefer t(locale, 'permissions.maxRoles') */
export const MSG_MAX_ROLES = fr['permissions.maxRoles'];
/** @deprecated Prefer t(locale, 'permissions.roleAlreadyAllowed') */
export const MSG_ROLE_ALREADY_ALLOWED = fr['permissions.roleAlreadyAllowed'];

/**
 * @param {string[]} existingRoleIds
 * @param {string} newRoleId
 * @returns {{ ok: true } | { ok: false, reason: 'duplicate' | 'max' }}
 */
export function validateScrimAllowedRoleAppend(existingRoleIds, newRoleId) {
  if (existingRoleIds.includes(newRoleId)) {
    return { ok: false, reason: 'duplicate' };
  }
  if (existingRoleIds.length >= SCRIM_ALLOWED_ROLES_MAX) {
    return { ok: false, reason: 'max' };
  }
  return { ok: true };
}

/**
 * Ajoute un rôle autorisé sans effacer les existants (mode roles).
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
 * @param {string} guildId
 * @param {string} roleId
 */
export function transactionAppendScrimAllowedRole(ctx, guildId, roleId) {
  const trx = ctx.db.transaction(() => {
    ctx.stmts.insertScrimAllowedRole.run(guildId, roleId);
    ctx.stmts.upsertScrimPermissionMode.run({
      guild_id: guildId,
      mode: 'roles',
    });
  });
  trx();
}

/**
 * Réinitialise les permissions scrim au mode « tout le monde ».
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
 * @param {string} guildId
 */
export function transactionSetEveryoneMode(ctx, guildId) {
  const trx = ctx.db.transaction(() => {
    ctx.stmts.deleteScrimAllowedRoles.run(guildId);
    ctx.stmts.upsertScrimPermissionMode.run({
      guild_id: guildId,
      mode: 'everyone',
    });
  });
  trx();
}

/**
 * Remplace les rôles autorisés + mode roles (transaction sync courte).
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
 * @param {string} guildId
 * @param {string[]} roleIds
 */
export function transactionReplaceScrimAllowedRoles(ctx, guildId, roleIds) {
  const trx = ctx.db.transaction(() => {
    ctx.stmts.deleteScrimAllowedRoles.run(guildId);
    for (const roleId of roleIds) {
      ctx.stmts.insertScrimAllowedRole.run(guildId, roleId);
    }
    ctx.stmts.upsertScrimPermissionMode.run({
      guild_id: guildId,
      mode: 'roles',
    });
  });
  trx();
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeConfigScrimPermissionsRemoveCore(interaction, ctx) {
  await replyConfigDashboardRedirect(interaction, ctx, 'config-scrim-permissions.remove.redirect');
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeConfigScrimPermissionsCore(interaction, ctx) {
  await replyConfigDashboardRedirect(interaction, ctx, 'config-scrim-permissions.redirect');
}
