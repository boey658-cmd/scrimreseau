import {
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { assertGuildAdministrator } from '../utils/guildAdministratorGuard.js';
import { executeBlockScrimUserCore } from './blockScrimUser.js';
import { executeUnblockScrimUserCore } from './unblockScrimUser.js';

const data = new SlashCommandBuilder()
  .setName('scrim-moderation')
  .setDescription('Modération scrim locale à ce serveur')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('user')
      .setDescription(
        'Bloque ou débloque un utilisateur pour les annonces scrim dans ce serveur',
      )
      .addStringOption((opt) =>
        opt
          .setName('action')
          .setDescription('Action')
          .setRequired(true)
          .addChoices(
            { name: 'Bloquer', value: 'block' },
            { name: 'Débloquer', value: 'unblock' },
          ),
      )
      .addUserOption((opt) =>
        opt
          .setName('utilisateur')
          .setDescription('Utilisateur concerné')
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
    const ok = await assertGuildAdministrator(interaction);
    if (!ok) return;

    const sub = interaction.options.getSubcommand(true);
    if (sub !== 'user') return;

    const action = interaction.options.getString('action', true);
    if (action === 'block') {
      return executeBlockScrimUserCore(interaction, ctx);
    }
    if (action === 'unblock') {
      return executeUnblockScrimUserCore(interaction, ctx);
    }
  },
};
