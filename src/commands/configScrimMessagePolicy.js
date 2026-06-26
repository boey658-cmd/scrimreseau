import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { UI_PRIMARY_GAME_KEY } from '../config/games.js';
import {
  LIFECYCLE_POLICY_DELETE,
  LIFECYCLE_POLICY_KEEP,
} from '../services/scrimMessagePolicy.js';
import {
  interactDeferReply,
  interactEditReply,
  interactReply,
} from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const MSG_NEED_GUILD = '❌ Cette commande doit être utilisée sur un serveur.';
const MSG_DB_ERROR = '❌ Une erreur est survenue. Réessayez plus tard.';
const MSG_INVALID_POLICY = '❌ Valeur de policy invalide.';

const POLICY_LABEL = {
  [LIFECYCLE_POLICY_KEEP]: 'Garder et marquer les messages',
  [LIFECYCLE_POLICY_DELETE]: 'Supprimer automatiquement',
};

const POLICY_CONFIRM = {
  [LIFECYCLE_POLICY_KEEP]:
    '✅ Policy mise à jour : les scrims trouvés, expirés ou remplacés resteront visibles avec un statut.',
  [LIFECYCLE_POLICY_DELETE]:
    '✅ Policy mise à jour : les scrims trouvés, expirés ou remplacés seront supprimés automatiquement dans ce serveur. Seules les annonces actives resteront visibles.',
};

/**
 * Vérifie si le bot a ManageMessages dans le salon de réception configuré.
 * Retourne un avertissement textuel si la permission manque, null sinon.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ getGuildGameChannel: import('better-sqlite3').Statement }} stmts
 * @returns {string | null}
 */
function buildDeletePermissionWarning(interaction, stmts) {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) return null;

  let channelRow;
  try {
    channelRow = stmts.getGuildGameChannel.get(guildId, UI_PRIMARY_GAME_KEY);
  } catch {
    return null;
  }

  if (!channelRow?.channel_id) return null;

  const channelId = channelRow.channel_id;
  const channel = interaction.guild.channels.cache.get(channelId);
  if (!channel) return null;

  if (
    channel.type !== ChannelType.GuildText
    && channel.type !== ChannelType.GuildAnnouncement
  ) {
    return null;
  }

  let botMember = interaction.guild.members.me;
  if (!botMember) return null;

  const perms = channel.permissionsFor(botMember);
  if (!perms) return null;

  if (!perms.has(PermissionFlagsBits.ManageMessages)) {
    return (
      `\n\n⚠️ Attention : le bot n'a pas la permission **Gérer les messages** dans <#${channelId}>. ` +
      `Les messages ne pourront pas être supprimés tant que cette permission n'est pas accordée (fallback sur édition embed).`
    );
  }

  return null;
}

/**
 * /scrim-config message-policy set
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeConfigScrimMessagePolicySetCore(interaction, ctx) {
  try {
    if (!interaction.inGuild()) {
      await interactReply(interaction, { content: MSG_NEED_GUILD, flags: MessageFlags.Ephemeral });
      return;
    }

    await interactDeferReply(interaction, { flags: MessageFlags.Ephemeral });

    const rawPolicy = interaction.options.getString('mode', true);

    if (rawPolicy !== LIFECYCLE_POLICY_KEEP && rawPolicy !== LIFECYCLE_POLICY_DELETE) {
      await interactEditReply(interaction, { content: MSG_INVALID_POLICY });
      return;
    }

    const policy = /** @type {'keep' | 'delete'} */ (rawPolicy);
    const nowIso = new Date().toISOString();
    const guildId = interaction.guildId;

    ctx.stmts.upsertScrimMessageLifecyclePolicy.run({
      guild_id: guildId,
      policy,
      updated_at: nowIso,
    });

    logger.event('config-scrim-message-policy set', {
      guild_id: guildId,
      policy,
      user_id: interaction.user.id,
    });

    let content = POLICY_CONFIRM[policy];

    if (policy === LIFECYCLE_POLICY_DELETE) {
      const warning = buildDeletePermissionWarning(interaction, ctx.stmts);
      if (warning) content += warning;
    }

    await interactEditReply(interaction, { content });
  } catch (err) {
    logger.error('config-scrim-message-policy set — erreur', {
      guild_id: interaction.guildId,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    try {
      if (interaction.deferred) {
        await interactEditReply(interaction, { content: MSG_DB_ERROR });
      } else if (!interaction.replied) {
        await interactReply(interaction, { content: MSG_DB_ERROR, flags: MessageFlags.Ephemeral });
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * /scrim-config message-policy reset
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeConfigScrimMessagePolicyResetCore(interaction, ctx) {
  try {
    if (!interaction.inGuild()) {
      await interactReply(interaction, { content: MSG_NEED_GUILD, flags: MessageFlags.Ephemeral });
      return;
    }

    const guildId = interaction.guildId;
    const info = ctx.stmts.deleteScrimMessageLifecyclePolicy.run(guildId);
    const removed = info.changes > 0;

    logger.event('config-scrim-message-policy reset', {
      guild_id: guildId,
      had_custom_policy: removed,
      user_id: interaction.user.id,
    });

    const content = removed
      ? `✅ Policy réinitialisée : les messages seront désormais conservés et marqués (comportement par défaut).`
      : `ℹ️ Aucune policy personnalisée n'était configurée sur ce serveur (comportement par défaut déjà actif).`;

    await interactReply(interaction, { content, flags: MessageFlags.Ephemeral });
  } catch (err) {
    logger.error('config-scrim-message-policy reset — erreur', {
      guild_id: interaction.guildId,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    try {
      if (!interaction.replied) {
        await interactReply(interaction, { content: MSG_DB_ERROR, flags: MessageFlags.Ephemeral });
      }
    } catch {
      /* ignore */
    }
  }
}

export { POLICY_LABEL };
