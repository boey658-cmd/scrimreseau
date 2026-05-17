import { EmbedBuilder, MessageFlags } from 'discord.js';
import { resolveBotDevId } from '../utils/botDevConfig.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const MSG_DENIED = '❌ Non autorisé.';
const MSG_EMPTY = 'Aucun serveur n’a configuré de salon de réception.';
const UNKNOWN_GUILD_LABEL = 'serveur inconnu / bot absent du cache';
const DISPLAY_LIMIT = 20;
const EMBED_DESCRIPTION_MAX = 4096;

/**
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @returns {string}
 */
function resolveGuildDisplayName(client, guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (guild?.name) return guild.name;
  return UNKNOWN_GUILD_LABEL;
}

/**
 * @param {{
 *   guild_id: string,
 *   channel_id: string,
 *   game_key: string,
 * }} row
 * @param {import('discord.js').Client} client
 * @returns {string}
 */
function formatReceptionListEntry(row, client) {
  const guildId = String(row.guild_id);
  const channelId = String(row.channel_id);
  const gameKey = String(row.game_key);
  const name = resolveGuildDisplayName(client, guildId);
  const title =
    name === UNKNOWN_GUILD_LABEL ? `**${UNKNOWN_GUILD_LABEL}**` : `**${name}**`;

  return [
    title,
    `ID serveur: \`${guildId}\``,
    `Salon: <#${channelId}> (\`${channelId}\`)`,
    `Jeu: \`${gameKey}\``,
  ].join('\n');
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeScrimDevReceptionListCore(interaction, ctx) {
  const devGuildId = process.env.DEV_GUILD_ID?.trim() ?? '';

  if (!interaction.inGuild()) {
    await interactReply(interaction, { content: MSG_DENIED, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!devGuildId || interaction.guildId !== devGuildId) {
    await interactReply(interaction, { content: MSG_DENIED, flags: MessageFlags.Ephemeral });
    return;
  }

  const dev = resolveBotDevId();
  if (!dev.ok || interaction.user.id !== dev.devId) {
    await interactReply(interaction, { content: MSG_DENIED, flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    /** @type {{ n?: number } | undefined} */
    const countRow = ctx.stmts.countGuildGameChannels.get();
    const total = Number(countRow?.n ?? 0);

    if (total === 0) {
      await interactReply(interaction, {
        content: MSG_EMPTY,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const rows = ctx.stmts.listGuildGameChannelsRecent.all(DISPLAY_LIMIT);
    const blocks = rows.map((row) =>
      formatReceptionListEntry(row, interaction.client),
    );

    let description = blocks.join('\n\n');
    const overflow = total > DISPLAY_LIMIT ? total - DISPLAY_LIMIT : 0;
    if (overflow > 0) {
      description += `\n\n_+ ${overflow} autre${overflow > 1 ? 's' : ''}._`;
    }

    if (description.length > EMBED_DESCRIPTION_MAX) {
      description = `${description.slice(0, EMBED_DESCRIPTION_MAX - 1)}…`;
    }

    const embed = new EmbedBuilder()
      .setTitle('Salons de réception scrim configurés')
      .setDescription(description)
      .setColor(0x5865f2)
      .setFooter({
        text: `${Math.min(total, DISPLAY_LIMIT)} affiché${total > 1 ? 's' : ''} sur ${total} · tri created_at DESC`,
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
      content: '❌ Impossible de charger la liste pour le moment.',
      flags: MessageFlags.Ephemeral,
    });
  }
}
