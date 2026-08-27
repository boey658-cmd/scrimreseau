import { MessageFlags } from 'discord.js';
import { getGuildLocale, t } from '../i18n/index.js';
import {
  botDevForbiddenMessage,
  botDevUnconfiguredMessage,
  resolveBotDevId,
} from '../utils/botDevConfig.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const GUILD_SNOWFLAKE_RE = /^\d{17,20}$/;

/**
 * @param {string | null | undefined} raw
 * @returns {{ ok: true, guildId: string } | { ok: false, reason: 'missing' | 'invalid' }}
 */
function parseGuildIdOption(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { ok: false, reason: 'missing' };
  if (!GUILD_SNOWFLAKE_RE.test(s)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, guildId: s };
}

/**
 * @param {string} locale
 * @param {'missing' | 'invalid'} reason
 */
function guildIdErrorMessage(locale, reason) {
  return reason === 'missing'
    ? t(locale, 'dev.guildIdMissing')
    : t(locale, 'dev.guildIdInvalid');
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeScrimDevGuildAccessCore(interaction, ctx) {
  const locale = getGuildLocale(interaction.guildId, ctx.stmts);
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
        content: botDevUnconfiguredMessage(locale),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.user.id !== dev.devId) {
      await interactReply(interaction, {
        content: botDevForbiddenMessage(locale),
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
          content: guildIdErrorMessage(locale, parsed.reason),
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
        content: t(locale, 'dev.guildAccessAllow', { guildId: parsed.guildId }),
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
          content: guildIdErrorMessage(locale, parsed.reason),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const info = ctx.stmts.deleteGuildScrimReceptionBypass.run(parsed.guildId);
      if (info.changes === 0) {
        await interactReply(interaction, {
          content: t(locale, 'dev.guildAccessNone', { guildId: parsed.guildId }),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interactReply(interaction, {
        content: t(locale, 'dev.guildAccessRevoked', { guildId: parsed.guildId }),
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
            content: guildIdErrorMessage(locale, parsed.reason),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const row = ctx.stmts.getGuildScrimReceptionBypass.get(parsed.guildId);
        if (!row) {
          await interactReply(interaction, {
            content: t(locale, 'dev.guildAccessNoneForGuild', {
              guildId: parsed.guildId,
            }),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await interactReply(interaction, {
          content: t(locale, 'dev.guildAccessDetail', {
            guildId: row.guild_id,
            bypass: row.bypass_member_minimum,
            updatedBy: row.updated_by,
            updatedAt: row.updated_at,
            note: row.note ?? '—',
          }),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const rows = ctx.stmts.listGuildScrimReceptionBypassesRecent.all();
      if (rows.length === 0) {
        await interactReply(interaction, {
          content: t(locale, 'dev.guildAccessEmpty'),
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
          `${t(locale, 'dev.guildAccessListTitle', { count: rows.length })}\n` +
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
        content: t(locale, 'dev.guildAccessError'),
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      /* ignore */
    }
  }
}
