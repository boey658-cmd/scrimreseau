import {
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { assertGuildAdministrator } from '../utils/guildAdministratorGuard.js';
import { executeConfigJoueurViewCore } from './configJoueurView.js';
import { executeRemoveJoueurChannelCore } from './removeJoueurChannel.js';
import { executeSetupJoueurChannelCore } from './setupJoueurChannel.js';

const data = new SlashCommandBuilder()
  .setName('joueur-config')
  .setDescription('Configuration Recherche Joueur de ce serveur')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommandGroup((group) =>
    group
      .setName('channel')
      .setDescription('Salon dédié Recherche Joueur')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Définit le salon de réception Recherche Joueur')
          .addChannelOption((opt) =>
            opt
              .setName('salon')
              .setDescription('Salon où seront postées les recherches joueur')
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Supprime le salon Recherche Joueur de ce serveur'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('view')
      .setDescription('Affiche la configuration Recherche Joueur de ce serveur'),
  );

export const joueurConfig = {
  data,

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{
   *   stmts: ReturnType<import('../database/db.js')['prepareStatements']>,
   *   playerSearchStmts: ReturnType<import('../database/db.js')['preparePlayerSearchStatements']>,
   * }} ctx
   */
  async execute(interaction, ctx) {
    const ok = await assertGuildAdministrator(interaction);
    if (!ok) return;

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(true);

    if (group === 'channel') {
      if (sub === 'set') {
        return executeSetupJoueurChannelCore(interaction, ctx);
      }
      if (sub === 'remove') {
        return executeRemoveJoueurChannelCore(interaction, ctx);
      }
    }

    if (group === null && sub === 'view') {
      return executeConfigJoueurViewCore(interaction, ctx);
    }
  },
};
