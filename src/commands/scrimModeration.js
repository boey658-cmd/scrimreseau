import {
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getGuildLocale } from '../i18n/index.js';
import { assertGuildAdministrator } from '../utils/guildAdministratorGuard.js';
import { executeBlockScrimUserCore } from './blockScrimUser.js';
import { executeUnblockScrimUserCore } from './unblockScrimUser.js';

const data = new SlashCommandBuilder()
  .setName('scrim-moderation')
  .setDescription('Manage blocked scrim users for this server.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('user')
      .setDescription("Block or unblock a user's scrim announcements on this server.")
      .addStringOption((opt) =>
        opt
          .setName('action')
          .setDescription('Action to perform.')
          .setRequired(true)
          .addChoices(
            { name: 'Block', value: 'block' },
            { name: 'Unblock', value: 'unblock' },
          ),
      )
      .addUserOption((opt) =>
        opt
          .setName('utilisateur')
          .setDescription('Select the user to moderate.')
          .setRequired(true),
      ),
  );

export const scrimModeration = {
  data,

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
   */
  async execute(interaction, ctx) {
    const locale = getGuildLocale(interaction.guildId, ctx.stmts);
    const ok = await assertGuildAdministrator(interaction, locale);
    if (!ok) return;

    const sub = interaction.options.getSubcommand(true);
    if (sub !== 'user') return;

    const action = interaction.options.getString('action', true);
    if (action === 'block') {
      return executeBlockScrimUserCore(interaction, ctx, locale);
    }
    if (action === 'unblock') {
      return executeUnblockScrimUserCore(interaction, ctx, locale);
    }
  },
};
