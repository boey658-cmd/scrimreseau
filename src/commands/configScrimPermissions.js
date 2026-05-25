import { MessageFlags } from 'discord.js';
import {
  interactDeferReply,
  interactEditReply,
  interactReply,
} from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const MSG_OK_PREFIX = '✅ Configuration mise à jour.';
const MSG_OK_SUFFIX =
  '⚠️ Cette configuration s’applique uniquement à ce serveur.';

const MSG_NEED_GUILD =
  '❌ Cette commande doit être utilisée sur un serveur.';

const MSG_ROLES_MODE_NEED_ROLES =
  '❌ Tu dois sélectionner au moins un rôle.';

const MSG_ROLE_NOT_IN_GUILD =
  '❌ Un ou plusieurs rôles n’appartiennent pas à ce serveur.';

const MSG_DB_ERROR =
  '❌ Impossible d’enregistrer la configuration. Réessayez plus tard.';

export const SCRIM_ALLOWED_ROLES_MAX = 5;

export const MSG_MAX_ROLES =
  'Vous ne pouvez pas configurer plus de 5 rôles autorisés.';

export const MSG_ROLE_ALREADY_ALLOWED = 'Ce rôle est déjà autorisé.';

/**
 * @param {string[]} roleIds
 * @returns {string}
 */
function formatRoleIdsAllowlist(roleIds) {
  if (!roleIds.length) return '';
  const lines = roleIds.map((id) => `- <@&${id}>`);
  return `\n\nRôles autorisés :\n${lines.join('\n')}`;
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
 * Retire la restriction par rôles : retour au défaut everyone.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
 */
export async function executeConfigScrimPermissionsRemoveCore(
  interaction,
  ctx,
) {
  try {
    if (!interaction.inGuild() || !interaction.guild) {
      await interactReply(interaction, {
        content: MSG_NEED_GUILD,
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
      await interactEditReply(interaction, { content: MSG_DB_ERROR });
      return;
    }

    logger.info('config-scrim-permissions', {
      guild_id: guildId,
      mode: 'everyone',
      user_id: interaction.user.id,
      via: 'remove',
    });
    await interactEditReply(interaction, {
      content: `${MSG_OK_PREFIX}\n\n${MSG_OK_SUFFIX}`,
    });
  } catch (err) {
    logger.error('config-scrim-permissions — remove execute', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    try {
      if (interaction.deferred) {
        await interactEditReply(interaction, { content: MSG_DB_ERROR });
      } else if (!interaction.replied) {
        await interactReply(interaction, {
          content: MSG_DB_ERROR,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (replyErr) {
      logger.error('config-scrim-permissions — remove réponse impossible', {
        message:
          replyErr instanceof Error ? replyErr.message : String(replyErr),
      });
    }
  }
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
 */
export async function executeConfigScrimPermissionsCore(interaction, ctx) {
  try {
    if (!interaction.inGuild() || !interaction.guild) {
      await interactReply(interaction, {
        content: MSG_NEED_GUILD,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interactDeferReply(interaction, { flags: MessageFlags.Ephemeral });

    const guildId = interaction.guildId;
    const mode = interaction.options.getString('mode', true);

    if (mode === 'everyone') {
      try {
        transactionSetEveryoneMode(ctx, guildId);
      } catch (err) {
        logger.error('config-scrim-permissions — transaction everyone', {
          guild_id: guildId,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        await interactEditReply(interaction, { content: MSG_DB_ERROR });
        return;
      }

      logger.info('config-scrim-permissions', {
        guild_id: guildId,
        mode: 'everyone',
        user_id: interaction.user.id,
      });
      await interactEditReply(interaction, {
        content: `${MSG_OK_PREFIX}\n\n${MSG_OK_SUFFIX}`,
      });
      return;
    }

    const role = interaction.options.getRole('roles');
    if (!role) {
      await interactEditReply(interaction, { content: MSG_ROLES_MODE_NEED_ROLES });
      return;
    }

    const gid = interaction.guild.id;
    if (role.guild.id !== gid) {
      await interactEditReply(interaction, { content: MSG_ROLE_NOT_IN_GUILD });
      return;
    }

    let existingRows;
    try {
      existingRows = ctx.stmts.listScrimAllowedRoles.all(guildId);
    } catch (err) {
      logger.error('config-scrim-permissions — lecture rôles existants', {
        guild_id: guildId,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      await interactEditReply(interaction, { content: MSG_DB_ERROR });
      return;
    }

    const existingIds = existingRows.map((r) => r.role_id);
    const validation = validateScrimAllowedRoleAppend(existingIds, role.id);
    if (!validation.ok) {
      const content =
        validation.reason === 'duplicate'
          ? MSG_ROLE_ALREADY_ALLOWED
          : MSG_MAX_ROLES;
      logger.info('config-scrim-permissions — refus ajout rôle', {
        guild_id: guildId,
        role_id: role.id,
        reason: validation.reason,
        existing_count: existingIds.length,
        user_id: interaction.user.id,
      });
      await interactEditReply(interaction, { content });
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
      await interactEditReply(interaction, { content: MSG_DB_ERROR });
      return;
    }

    let allRoleIds;
    try {
      allRoleIds = ctx.stmts.listScrimAllowedRoles
        .all(guildId)
        .map((r) => r.role_id);
    } catch (err) {
      logger.error('config-scrim-permissions — lecture rôles après ajout', {
        guild_id: guildId,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      await interactEditReply(interaction, { content: MSG_DB_ERROR });
      return;
    }

    logger.info('config-scrim-permissions', {
      guild_id: guildId,
      mode: 'roles',
      role_count: allRoleIds.length,
      added_role_id: role.id,
      user_id: interaction.user.id,
    });
    await interactEditReply(interaction, {
      content: `${MSG_OK_PREFIX}${formatRoleIdsAllowlist(allRoleIds)}\n\n${MSG_OK_SUFFIX}`,
    });
  } catch (err) {
    logger.error('config-scrim-permissions — execute', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    try {
      if (interaction.deferred) {
        await interactEditReply(interaction, { content: MSG_DB_ERROR });
      } else if (!interaction.replied) {
        await interactReply(interaction, {
          content: MSG_DB_ERROR,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (replyErr) {
      logger.error('config-scrim-permissions — impossible de répondre', {
        message:
          replyErr instanceof Error ? replyErr.message : String(replyErr),
      });
    }
  }
}
