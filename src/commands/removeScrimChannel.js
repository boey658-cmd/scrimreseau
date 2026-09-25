/**
 * Legacy : remove channel Discord — Phase 0.5 = redirection dashboard uniquement.
 */

import { replyConfigDashboardRedirect } from '../utils/legacyConfigDiscordRedirect.js';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeRemoveScrimChannelCore(interaction, ctx) {
  await replyConfigDashboardRedirect(interaction, ctx, 'remove-scrim-channel.redirect');
}
