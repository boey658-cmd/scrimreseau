/**
 * Legacy command-channel usage Discord — Phase 0.5 : redirection dashboard (0 write).
 */

import { replyConfigDashboardRedirect } from '../utils/legacyConfigDiscordRedirect.js';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeConfigScrimChannelUsageCore(interaction, ctx) {
  await replyConfigDashboardRedirect(interaction, ctx, 'config-scrim-channel-usage.redirect');
}
