import { MessageFlags } from 'discord.js';
import { fr } from '../i18n/fr.js';
import { getGuildLocale, t } from '../i18n/index.js';
import {
  interactDeferReply,
  interactEditReply,
  interactReply,
} from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

export const SCRIM_ALLOWED_ROLES_MAX = 5;

/** @deprecated Prefer t(locale, 'permissions.maxRoles') */
export const MSG_MAX_ROLES = fr['permissions.maxRoles'];
/** @deprecated Prefer t(locale, 'permissions.roleAlreadyAllowed') */
export const MSG_ROLE_ALREADY_ALLOWED = fr['permissions.roleAlreadyAllowed'];

/**
 * @param {string[]} roleIds
 * @param {string} locale
 * @returns {string}
 */
function formatRoleIdsAllowlist(roleIds, locale) {
  if (!roleIds.length) return '';
  const lines = roleIds.map((id) => `- <@&${id}>`);
  return `\n\n${t(locale, 'permissions.allowedRolesHeader')}\n${lines.join('\n')}`;
}

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
 * Réinitialise les permissions scrim au mode « tout le monde » (même transaction que mode everyone).
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
 * Aucun await réseau à l'intérieur.
 *
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
 * Retire la restriction par rôles : retour au défaut everyone.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
 */
export async function executeConfigScrimPermissionsRemoveCore(
  interaction,
  ctx,
) {
  const locale = getGuildLocale(interaction.guildId, ctx.stmts);
  try {
    if (!interaction.inGuild() || !interaction.guild) {
      await interactReply(interaction, {
        content: t(locale, 'generic.guildOnly'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interactDeferReply(interaction, { flags: MessageFlags.Ephemeral });

    const guildId = interaction.guildId;

    try {
      transactionSetEveryoneMode(ctx, guildId);
    } catch (err) {
      logger.error('config-scrim-permissions — transaction remove', {
        guild_id: guildId,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      await interactEditReply(interaction, { content: t(locale, 'permissions.dbError') });
      return;
    }

    logger.info('config-scrim-permissions', {
      guild_id: guildId,
      mode: 'everyone',
      user_id: interaction.user.id,
    });

    await interactEditReply(interaction, {
      content: `${t(locale, 'permissions.okPrefix')}\n\n${t(locale, 'permissions.okSuffix')}`,
    });
  } catch (err) {
    logger.error('config-scrim-permissions — remove execute', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    try {
      if (interaction.deferred || interaction.replied) {
        await interactEditReply(interaction, { content: t(locale, 'permissions.dbError') });
      } else {
        await interactReply(interaction, {
          content: t(locale, 'permissions.dbError'),
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (replyErr) {
      logger.error('config-scrim-permissions — remove réponse impossible', {
        message: replyErr instanceof Error ? replyErr.message : String(replyErr),
      });
    }
  }
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
 */
export async function executeConfigScrimPermissionsCore(interaction, ctx) {
  const locale = getGuildLocale(interaction.guildId, ctx.stmts);
  try {
    if (!interaction.inGuild() || !interaction.guild) {
      await interactReply(interaction, {
        content: t(locale, 'generic.guildOnly'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interactDeferReply(interaction, { flags: MessageFlags.Ephemeral });

    const guildId = interaction.guildId;
    const mode = interaction.options.getString('mode', true);
    const role = interaction.options.getRole('roles');

    if (mode === 'everyone') {
      try {
        transactionSetEveryoneMode(ctx, guildId);
      } catch (err) {
        logger.error('config-scrim-permissions — transaction everyone', {
          guild_id: guildId,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        await interactEditReply(interaction, { content: t(locale, 'permissions.dbError') });
        return;
      }
      logger.info('config-scrim-permissions', {
        guild_id: guildId,
        mode: 'everyone',
        user_id: interaction.user.id,
      });
      await interactEditReply(interaction, {
        content: `${t(locale, 'permissions.okPrefix')}\n\n${t(locale, 'permissions.okSuffix')}`,
      });
      return;
    }

    if (!role) {
      await interactEditReply(interaction, {
        content: t(locale, 'permissions.rolesModeNeedRoles'),
      });
      return;
    }

    if (role.guild?.id !== guildId) {
      await interactEditReply(interaction, {
        content: t(locale, 'permissions.roleNotInGuild'),
      });
      return;
    }

    /** @type {string[]} */
    let existingRoleIds;
    try {
      existingRoleIds = ctx.stmts
        .listScrimAllowedRoles.all(guildId)
        .map((r) => String(r.role_id));
    } catch (err) {
      logger.error('config-scrim-permissions — lecture rôles existants', {
        guild_id: guildId,
        message: err instanceof Error ? err.message : String(err),
      });
      await interactEditReply(interaction, { content: t(locale, 'permissions.dbError') });
      return;
    }

    const check = validateScrimAllowedRoleAppend(existingRoleIds, role.id);
    if (!check.ok) {
      const msg = check.reason === 'duplicate'
        ? t(locale, 'permissions.roleAlreadyAllowed')
        : t(locale, 'permissions.maxRoles');
      logger.info('config-scrim-permissions — refus ajout rôle', {
        guild_id: guildId,
        reason: check.reason,
        role_id: role.id,
      });
      await interactEditReply(interaction, { content: msg });
      return;
    }

    try {
      transactionAppendScrimAllowedRole(ctx, guildId, role.id);
    } catch (err) {
      logger.error('config-scrim-permissions — transaction roles', {
        guild_id: guildId,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      await interactEditReply(interaction, { content: t(locale, 'permissions.dbError') });
      return;
    }

    /** @type {string[]} */
    let allRoleIds;
    try {
      allRoleIds = ctx.stmts
        .listScrimAllowedRoles.all(guildId)
        .map((r) => String(r.role_id));
    } catch (err) {
      logger.error('config-scrim-permissions — lecture rôles après ajout', {
        guild_id: guildId,
        message: err instanceof Error ? err.message : String(err),
      });
      await interactEditReply(interaction, { content: t(locale, 'permissions.dbError') });
      return;
    }

    logger.info('config-scrim-permissions', {
      guild_id: guildId,
      mode: 'roles',
      role_count: allRoleIds.length,
      user_id: interaction.user.id,
    });

    await interactEditReply(interaction, {
      content: `${t(locale, 'permissions.okPrefix')}${formatRoleIdsAllowlist(allRoleIds, locale)}\n\n${t(locale, 'permissions.okSuffix')}`,
    });
  } catch (err) {
    logger.error('config-scrim-permissions — execute', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    try {
      if (interaction.deferred || interaction.replied) {
        await interactEditReply(interaction, { content: t(locale, 'permissions.dbError') });
      } else {
        await interactReply(interaction, {
          content: t(locale, 'permissions.dbError'),
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (replyErr) {
      logger.error('config-scrim-permissions — impossible de répondre', {
        message: replyErr instanceof Error ? replyErr.message : String(replyErr),
      });
    }
  }
}
