import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { executeBlacklistCore } from './blacklist.js';
import { executeScrimDevGuildAccessCore } from './scrimDevGuildAccess.js';
import { executeScrimDevHealthCore } from './scrimDevHealth.js';
import { executeUnblacklistCore } from './unblacklist.js';

const MSG_DURATION_REQUISE =
  '❌ Indique une **durée** pour ajouter à la blacklist.';

const data = new SlashCommandBuilder()
  .setName('scrim-dev')
  .setDescription('Outils de modération globale du bot')
  .addSubcommand((sub) =>
    sub
      .setName('health')
      .setDescription('État de santé du bot (dev uniquement)'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('blacklist')
      .setDescription('Gestion de la blacklist globale')
      .addStringOption((opt) =>
        opt
          .setName('action')
          .setDescription('Action')
          .setRequired(true)
          .addChoices(
            { name: 'Ajouter', value: 'add' },
            { name: 'Retirer', value: 'remove' },
          ),
      )
      .addUserOption((opt) =>
        opt
          .setName('user')
          .setDescription('Utilisateur')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('duration')
          .setDescription('Durée (requis si action = ajouter)')
          .setRequired(false)
          .addChoices(
            { name: '1 jour', value: '1d' },
            { name: '7 jours', value: '7d' },
            { name: '30 jours', value: '30d' },
            { name: '3 mois', value: '3mo' },
            { name: 'Permanent', value: 'permanent' },
          ),
      )
      .addStringOption((opt) =>
        opt
          .setName('reason')
          .setDescription('Motif (optionnel, si action = ajouter)')
          .setRequired(false),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('guild-access')
      .setDescription(
        'Exceptions réception scrim (contournement du seuil membres, dev uniquement)',
      )
      .addSubcommand((sub) =>
        sub
          .setName('allow')
          .setDescription('Autoriser la config salon réception malgré le seuil')
          .addStringOption((opt) =>
            opt
              .setName('guild_id')
              .setDescription('ID du serveur Discord')
              .setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('note')
              .setDescription('Note interne (optionnel)')
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('revoke')
          .setDescription('Retirer l’exception pour un serveur')
          .addStringOption((opt) =>
            opt
              .setName('guild_id')
              .setDescription('ID du serveur Discord')
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('view')
          .setDescription('Lister les exceptions (ou détail d’une guilde)')
          .addStringOption((opt) =>
            opt
              .setName('guild_id')
              .setDescription('Filtrer sur une guilde (optionnel)')
              .setRequired(false),
          ),
      ),
  );

export const scrimDev = {
  data,

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
   */
  async execute(interaction, ctx) {
    const group = interaction.options.getSubcommandGroup(false);
    if (group === 'guild-access') {
      return executeScrimDevGuildAccessCore(interaction, ctx);
    }

    const sub = interaction.options.getSubcommand(true);
    if (sub === 'health') {
      return executeScrimDevHealthCore(interaction, ctx);
    }
    if (sub === 'blacklist') {
      const action = interaction.options.getString('action', true);
      if (action === 'add') {
        const duration = interaction.options.getString('duration');
        if (!duration?.trim()) {
          await interactReply(interaction, {
            content: MSG_DURATION_REQUISE,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        return executeBlacklistCore(interaction, ctx);
      }
      if (action === 'remove') {
        return executeUnblacklistCore(interaction, ctx);
      }
    }
  },
};
