/**
 * Legacy message-policy Discord — Phase 0.5 : redirection dashboard (0 write).
 * POLICY_LABEL conservé pour lectures / tests.
 */

import {
  LIFECYCLE_POLICY_DELETE,
  LIFECYCLE_POLICY_KEEP,
} from '../services/scrimMessagePolicy.js';
import { replyConfigDashboardRedirect } from '../utils/legacyConfigDiscordRedirect.js';

const POLICY_LABEL = {
  [LIFECYCLE_POLICY_KEEP]: 'Garder et marquer les messages',
  [LIFECYCLE_POLICY_DELETE]: 'Supprimer automatiquement',
};

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeConfigScrimMessagePolicySetCore(interaction, ctx) {
  await replyConfigDashboardRedirect(interaction, ctx, 'config-scrim-message-policy.set.redirect');
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeConfigScrimMessagePolicyResetCore(interaction, ctx) {
  await replyConfigDashboardRedirect(interaction, ctx, 'config-scrim-message-policy.reset.redirect');
}

export { POLICY_LABEL };
