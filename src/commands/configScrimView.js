import { EmbedBuilder, MessageFlags } from 'discord.js';
import { getEmbedColorForGame } from '../config/gameEmbedColors.js';
import { countStaleScrimConfiguredRoles } from '../services/scrimGuildRestrictions.js';
import {
  interactDeferReply,
  interactEditReply,
  interactReply,
} from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const MSG_NEED_GUILD =
  '❌ Cette commande doit être utilisée sur un serveur.';

const MSG_DB_ERROR =
  '❌ Impossible de lire la configuration. Réessayez plus tard.';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeConfigScrimViewCore(interaction, ctx) {
    try {
      if (!interaction.inGuild() || !interaction.guild) {
        await interactReply(interaction, { content: MSG_NEED_GUILD, flags: MessageFlags.Ephemeral });
        return;
      }

      await interactDeferReply(interaction, { flags: MessageFlags.Ephemeral });

      const guildId = interaction.guildId;
      const guild = interaction.guild;

      let modeRow;
      let roleRows;
      let usageRow;
      try {
        modeRow = ctx.stmts.getScrimPermissionMode.get(guildId);
        roleRows = ctx.stmts.listScrimAllowedRoles.all(guildId);
        usageRow = ctx.stmts.getScrimUsageChannel.get(guildId);
      } catch (err) {
        logger.error('config-scrim-view — lecture DB', {
          guild_id: guildId,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        await interactEditReply(interaction, { content: MSG_DB_ERROR });
        return;
      }

      const mode = modeRow?.mode ?? 'everyone';
      const modeLabel =
        mode === 'roles' ? 'Rôles spécifiques' : 'Tout le monde';

      let rolesText;
      if (mode === 'everyone') {
        rolesText = '—';
      } else if (!roleRows.length) {
        rolesText = 'Aucun rôle configuré';
      } else {
        const mentions = roleRows
          .map((r) => r.role_id)
          .filter((id) => guild.roles.cache.has(id))
          .map((id) => `<@&${id}>`);
        rolesText = mentions.length > 0 ? mentions.join(', ') : 'Aucun rôle configuré';
      }

      const salonText = usageRow?.channel_id
        ? `<#${usageRow.channel_id}>`
        : 'Aucune restriction';

      const staleCount = countStaleScrimConfiguredRoles(roleRows, guild);

      const embed = new EmbedBuilder()
        .setTitle('⚙️ Configuration scrim LoL (ce serveur)')
        .setColor(getEmbedColorForGame(''))
        .addFields(
          { name: 'Mode', value: modeLabel, inline: false },
          { name: 'Rôles autorisés', value: rolesText, inline: false },
          {
            name: 'Salon /recherche-scrim',
            value: salonText,
            inline: false,
          },
        )
        .setTimestamp(new Date());

      if (staleCount > 0) {
        embed.addFields({
          name: 'Attention',
          value:
            '⚠️ Certains rôles configurés n’existent plus et sont ignorés.',
          inline: false,
        });
      }

      await interactEditReply(interaction, { embeds: [embed] });

      logger.info('config-scrim-view', {
        guild_id: guildId,
        user_id: interaction.user.id,
      });
    } catch (err) {
      logger.error('config-scrim-view — execute', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      try {
        if (interaction.deferred) {
          await interactEditReply(interaction, { content: MSG_DB_ERROR });
        } else if (!interaction.replied) {
          await interactReply(interaction, { content: MSG_DB_ERROR, flags: MessageFlags.Ephemeral });
        }
      } catch (replyErr) {
        logger.error('config-scrim-view — réponse impossible', {
          message:
            replyErr instanceof Error ? replyErr.message : String(replyErr),
        });
      }
    }
}
