import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  buildSpamReportHeader,
  buildSpamReportMessages,
  checkGlobalBlacklist,
  checkRecentSpamReport,
  createSpamReport,
  formatModerationScrimHistoryLine,
} from '../services/scrimModeration.js';
import { runTransientDiscord } from '../services/discordApiGuard.js';
import { enqueueDiscordTask } from '../services/discordTaskQueue.js';
import {
  interactFollowUp,
  interactReply,
} from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';
import { getGuildLocale, t } from '../i18n/index.js';

export const spammer = {
  data: new SlashCommandBuilder()
    .setName('report-spam')
    .setDescription('Report a user for excessive scrim search spam.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('Select the user to report.')
        .setRequired(true),
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
   */
  async execute(interaction, ctx) {
    const locale = getGuildLocale(interaction.guildId, ctx.stmts);
    try {
      if (!interaction.inGuild()) {
        await interactReply(interaction, {
          content: t(locale, 'reportSpam.guildOnly'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (
        !interaction.memberPermissions?.has(
          PermissionFlagsBits.Administrator,
        )
      ) {
        await interactReply(interaction, {
          content: t(locale, 'reportSpam.adminOnly'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const target = interaction.options.getUser('user', true);
      const reporterId = interaction.user.id;

      if (target.id === reporterId) {
        await interactReply(interaction, {
          content: t(locale, 'reportSpam.selfReport'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (target.bot) {
        await interactReply(interaction, {
          content: t(locale, 'reportSpam.botReport'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (checkRecentSpamReport(ctx.stmts, reporterId, target.id)) {
        await interactReply(interaction, {
          content: t(locale, 'reportSpam.alreadyReported'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (checkGlobalBlacklist(ctx.stmts, target.id).result === 'blocked') {
        await interactReply(interaction, {
          content: t(locale, 'reportSpam.alreadyBlacklisted'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const reportChannelId = process.env.SPAM_REPORT_CHANNEL_ID?.trim();
      if (!reportChannelId) {
        logger.error('spammer — SPAM_REPORT_CHANNEL_ID manquant');
        await interactReply(interaction, {
          content: t(locale, 'reportSpam.noChannel'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const channel = await runTransientDiscord(
        () => interaction.client.channels.fetch(reportChannelId),
        {
          kind: 'spammer.fetch_report_channel',
          metadata: { channel_id: reportChannelId },
        },
      ).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        logger.error('spammer — salon signalement introuvable ou non texte', {
          channel_id: reportChannelId,
        });
        await interactReply(interaction, {
          content: t(locale, 'reportSpam.channelInaccessible'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const historyRows = ctx.stmts.listRecentScrimPostsByAuthorForModeration.all(
        target.id,
      );
      const historyLines = historyRows.map(formatModerationScrimHistoryLine);

      const guild = interaction.guild;
      const header = buildSpamReportHeader({
        targetTag: target.tag,
        targetId: target.id,
        reporterTag: interaction.user.tag,
        reporterId,
        guildName: guild?.name ?? '—',
        guildId: interaction.guildId ?? '',
      });
      const payloads = buildSpamReportMessages(header, historyLines);

      const MOD_FAIL_USER = t(locale, 'reportSpam.modFail');

      let modPartsSent = 0;
      for (let i = 0; i < payloads.length; i += 1) {
        try {
          await enqueueDiscordTask(
            () => channel.send({ content: payloads[i] }),
            {
              kind: 'spammer_mod_report_part',
              guild_id: interaction.guildId,
              part_index: i,
            },
            'high',
          );
          modPartsSent += 1;
        } catch (sendErr) {
          if (i === 0) {
            try {
              logger.error('spammer — échec envoi salon mod (aucun message posté)', {
                guild_id: interaction.guildId,
                reporter_user_id: reporterId,
                target_user_id: target.id,
                message:
                  sendErr instanceof Error ? sendErr.message : String(sendErr),
              });
            } catch {
              /* ignore */
            }
            await interactReply(interaction, {
              content: MOD_FAIL_USER,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          try {
            logger.warn('spammer — envoi partiel salon mod (suite des messages échouée)', {
              guild_id: interaction.guildId,
              reporter_user_id: reporterId,
              target_user_id: target.id,
              parts_sent: modPartsSent,
              parts_total: payloads.length,
              message:
                sendErr instanceof Error ? sendErr.message : String(sendErr),
            });
          } catch {
            /* ignore */
          }
          break;
        }
      }

      if (modPartsSent === 0) {
        try {
          logger.error('spammer — aucun message mod posté (état inattendu)', {
            guild_id: interaction.guildId,
            reporter_user_id: reporterId,
            target_user_id: target.id,
          });
        } catch {
          /* ignore */
        }
        await interactReply(interaction, {
          content: MOD_FAIL_USER,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      createSpamReport(
        ctx.stmts,
        interaction.guildId ?? '',
        reporterId,
        target.id,
      );

      await interactReply(interaction, {
        content: t(locale, 'reportSpam.success'),
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      logger.error('spammer', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      try {
        if (interaction.deferred || interaction.replied) {
          await interactFollowUp(interaction, {
            content: t(locale, 'reportSpam.error'),
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interactReply(interaction, {
            content: t(locale, 'reportSpam.error'),
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (replyErr) {
        logger.error('spammer — réponse impossible —', {
          message:
            replyErr instanceof Error ? replyErr.message : String(replyErr),
        });
      }
    }
  },
};
