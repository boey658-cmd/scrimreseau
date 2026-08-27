import { EmbedBuilder, MessageFlags } from 'discord.js';
import { getGuildLocale, t } from '../i18n/index.js';
import { resolveBotDevId } from '../utils/botDevConfig.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const DISPLAY_LIMIT = 20;
const EMBED_DESCRIPTION_MAX = 4096;

/**
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {string} locale
 * @returns {string}
 */
function resolveGuildDisplayName(client, guildId, locale) {
  const guild = client.guilds.cache.get(guildId);
  if (guild?.name) return guild.name;
  return t(locale, 'dev.receptionUnknownGuild');
}

/**
 * @param {{
 *   guild_id: string,
 *   channel_id: string,
 *   game_key: string,
 * }} row
 * @param {import('discord.js').Client} client
 * @param {string} locale
 * @returns {string}
 */
function formatReceptionListEntry(row, client, locale) {
  const guildId = String(row.guild_id);
  const channelId = String(row.channel_id);
  const gameKey = String(row.game_key);
  const name = resolveGuildDisplayName(client, guildId, locale);
  const unknown = t(locale, 'dev.receptionUnknownGuild');
  const title = name === unknown ? `**${unknown}**` : `**${name}**`;

  return [
    title,
    t(locale, 'dev.receptionEntryMeta', { guildId, channelId, gameKey }),
  ].join('\n');
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeScrimDevReceptionListCore(interaction, ctx) {
  const locale = getGuildLocale(interaction.guildId, ctx.stmts);
  const denied = t(locale, 'dev.denied');
  const devGuildId = process.env.DEV_GUILD_ID?.trim() ?? '';

  if (!interaction.inGuild()) {
    await interactReply(interaction, { content: denied, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!devGuildId || interaction.guildId !== devGuildId) {
    await interactReply(interaction, { content: denied, flags: MessageFlags.Ephemeral });
    return;
  }

  const dev = resolveBotDevId();
  if (!dev.ok || interaction.user.id !== dev.devId) {
    await interactReply(interaction, { content: denied, flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    /** @type {{ n?: number } | undefined} */
    const countRow = ctx.stmts.countGuildGameChannels.get();
    const total = Number(countRow?.n ?? 0);

    if (total === 0) {
      await interactReply(interaction, {
        content: t(locale, 'dev.receptionListEmpty'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const rows = ctx.stmts.listGuildGameChannelsRecent.all(DISPLAY_LIMIT);
    const blocks = rows.map((row) =>
      formatReceptionListEntry(row, interaction.client, locale),
    );

    let description = blocks.join('\n\n');
    const overflow = total > DISPLAY_LIMIT ? total - DISPLAY_LIMIT : 0;
    if (overflow > 0) {
      description += `\n\n${t(locale, 'dev.receptionOverflow', { count: overflow })}`;
    }

    if (description.length > EMBED_DESCRIPTION_MAX) {
      description = `${description.slice(0, EMBED_DESCRIPTION_MAX - 1)}…`;
    }

    const shown = Math.min(total, DISPLAY_LIMIT);
    const embed = new EmbedBuilder()
      .setTitle(t(locale, 'dev.receptionListTitle'))
      .setDescription(description)
      .setColor(0x5865f2)
      .setFooter({
        text: t(locale, 'dev.receptionFooter', { shown, total }),
      });

    await interactReply(interaction, {
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });

    logger.info('scrim-dev reception-list', {
      user_id: interaction.user.id,
      total,
      displayed: rows.length,
    });
  } catch (err) {
    logger.error('scrim-dev reception-list', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    await interactReply(interaction, {
      content: t(locale, 'dev.receptionListLoadError'),
      flags: MessageFlags.Ephemeral,
    });
  }
}
