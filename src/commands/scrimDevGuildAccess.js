import { MessageFlags } from 'discord.js';
import {
  MSG_BOT_DEV_FORBIDDEN,
  MSG_BOT_DEV_UNCONFIGURED,
  resolveBotDevId,
} from '../utils/botDevConfig.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const GUILD_SNOWFLAKE_RE = /^\d{17,20}$/;

/**
 * @param {string | null | undefined} raw
 * @returns {{ ok: true, guildId: string } | { ok: false, error: string }}
 */
function parseGuildIdOption(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { ok: false, error: '❌ `guild_id` invalide ou manquant.' };
  if (!GUILD_SNOWFLAKE_RE.test(s)) {
    return { ok: false, error: '❌ `guild_id` doit être un identifiant de serveur Discord valide.' };
  }
  return { ok: true, guildId: s };
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeScrimDevGuildAccessCore(interaction, ctx) {
  try {
    const dev = resolveBotDevId();
    if (!dev.ok) {
      try {
        logger.warn('scrim-dev guild-access — BOT_DEV_ID absent ou invalide', {
          reason: dev.reason,
        });
      } catch {
        /* ignore */
      }
      await interactReply(interaction, {
        content: MSG_BOT_DEV_UNCONFIGURED,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.user.id !== dev.devId) {
      await interactReply(interaction, {
        content: MSG_BOT_DEV_FORBIDDEN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const sub = interaction.options.getSubcommand(true);

    if (sub === 'allow') {
      const rawGid = interaction.options.getString('guild_id', true);
      const parsed = parseGuildIdOption(rawGid);
      if (!parsed.ok) {
        await interactReply(interaction, {
          content: parsed.error,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const note = interaction.options.getString('note')?.trim() ?? null;
      const now = new Date().toISOString();
      ctx.stmts.upsertGuildScrimReceptionBypass.run({
        guild_id: parsed.guildId,
        bypass_member_minimum: 1,
        updated_by: interaction.user.id,
        updated_at: now,
        note,
      });
      await interactReply(interaction, {
        content: `✅ Exception réception scrim activée pour la guilde \`${parsed.guildId}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      try {
        logger.info('guild-access allow', {
          guild_id: parsed.guildId,
          updated_by: interaction.user.id,
        });
      } catch {
        /* ignore */
      }
      return;
    }

    if (sub === 'revoke') {
      const rawGid = interaction.options.getString('guild_id', true);
      const parsed = parseGuildIdOption(rawGid);
      if (!parsed.ok) {
        await interactReply(interaction, {
          content: parsed.error,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const info = ctx.stmts.deleteGuildScrimReceptionBypass.run(parsed.guildId);
      if (info.changes === 0) {
        await interactReply(interaction, {
          content: `ℹ️ Aucune exception active pour la guilde \`${parsed.guildId}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interactReply(interaction, {
        content: `✅ Exception réception scrim retirée pour la guilde \`${parsed.guildId}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      try {
        logger.info('guild-access revoke', {
          guild_id: parsed.guildId,
          updated_by: interaction.user.id,
        });
      } catch {
        /* ignore */
      }
      return;
    }

    if (sub === 'view') {
      const rawFilter = interaction.options.getString('guild_id');
      if (rawFilter?.trim()) {
        const parsed = parseGuildIdOption(rawFilter);
        if (!parsed.ok) {
          await interactReply(interaction, {
            content: parsed.error,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const row = ctx.stmts.getGuildScrimReceptionBypass.get(parsed.guildId);
        if (!row) {
          await interactReply(interaction, {
            content: `ℹ️ Aucune exception enregistrée pour \`${parsed.guildId}\`.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await interactReply(interaction, {
          content:
            `**Exception réception** — guilde \`${row.guild_id}\`\n` +
            `bypass_member_minimum: ${row.bypass_member_minimum}\n` +
            `updated_by: ${row.updated_by}\n` +
            `updated_at: ${row.updated_at}\n` +
            `note: ${row.note ?? '—'}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const rows = ctx.stmts.listGuildScrimReceptionBypassesRecent.all();
      if (rows.length === 0) {
        await interactReply(interaction, {
          content: 'ℹ️ Aucune exception réception scrim enregistrée.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const lines = rows.map(
        (r) =>
          `\`${r.guild_id}\` — ${r.updated_at}${r.note ? ` — ${r.note}` : ''}`,
      );
      await interactReply(interaction, {
        content:
          `**Exceptions réception scrim** (${rows.length} dernières)\n` +
          lines.join('\n').slice(0, 1900),
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    logger.error('scrim-dev guild-access', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    try {
      await interactReply(interaction, {
        content: '❌ Erreur lors de la gestion guild-access.',
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      /* ignore */
    }
  }
}
