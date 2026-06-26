import {
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { assertGuildAdministrator } from '../utils/guildAdministratorGuard.js';
import { executeConfigScrimChannelResetCore } from './configScrimChannelReset.js';
import { executeConfigScrimChannelUsageCore } from './configScrimChannelUsage.js';
import {
  executeConfigScrimMessagePolicyResetCore,
  executeConfigScrimMessagePolicySetCore,
} from './configScrimMessagePolicy.js';
import {
  executeConfigScrimPermissionsCore,
  executeConfigScrimPermissionsRemoveCore,
} from './configScrimPermissions.js';
import { executeConfigScrimViewCore } from './configScrimView.js';
import { executeRemoveScrimChannelCore } from './removeScrimChannel.js';
import { executeSetupScrimChannelCore } from './setupScrimChannel.js';

const data = new SlashCommandBuilder()
  .setName('scrim-config')
  .setDescription('Configuration scrim de ce serveur')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommandGroup((group) =>
    group
      .setName('channel')
      .setDescription('Salon de diffusion des scrims League of Legends')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription(
            'Définit le salon de diffusion des scrims League of Legends',
          )
          .addChannelOption((opt) =>
            opt
              .setName('salon')
              .setDescription('Salon où seront postés les scrims')
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription(
            'Supprime le salon de diffusion des scrims League of Legends',
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('command-channel')
      .setDescription('Salon autorisé pour la commande /recherche-scrim')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription(
            'Définit le salon autorisé pour utiliser /recherche-scrim',
          )
          .addChannelOption((opt) =>
            opt
              .setName('salon')
              .setDescription('Salon où /recherche-scrim sera utilisable')
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('reset')
          .setDescription(
            'Supprime la restriction de salon pour /recherche-scrim',
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('permissions')
      .setDescription('Qui peut utiliser /recherche-scrim sur ce serveur')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription(
            'Définit qui peut utiliser /recherche-scrim sur ce serveur',
          )
          .addStringOption((opt) =>
            opt
              .setName('mode')
              .setDescription('Qui peut utiliser /recherche-scrim')
              .setRequired(true)
              .addChoices(
                { name: 'Tout le monde', value: 'everyone' },
                { name: 'Rôles spécifiques', value: 'roles' },
              ),
          )
          .addRoleOption((opt) =>
            opt
              .setName('roles')
              .setDescription(
                'Ajoute un rôle autorisé (max 5, requis si mode = rôles spécifiques)',
              )
              .setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription(
            'Supprime la restriction de permissions spécifique pour /recherche-scrim',
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('messages')
      .setDescription('Comportement des messages de scrims terminés ou remplacés dans ce serveur')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription(
            'Définit le comportement des messages de scrims terminés / remplacés',
          )
          .addStringOption((opt) =>
            opt
              .setName('mode')
              .setDescription('Messages des scrims terminés / remplacés')
              .setRequired(true)
              .addChoices(
                { name: 'Garder et marquer les messages', value: 'keep' },
                { name: 'Supprimer automatiquement', value: 'delete' },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('reset')
          .setDescription(
            'Réinitialise le comportement par défaut (garder et marquer)',
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('view')
      .setDescription('Affiche la configuration scrim de ce serveur'),
  );

export const scrimConfig = {
  data,

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
   */
  async execute(interaction, ctx) {
    const ok = await assertGuildAdministrator(interaction);
    if (!ok) return;

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(true);

    if (group === 'channel') {
      if (sub === 'set') {
        return executeSetupScrimChannelCore(interaction, ctx);
      }
      if (sub === 'remove') {
        return executeRemoveScrimChannelCore(interaction, ctx);
      }
    }

    if (group === 'command-channel') {
      if (sub === 'set') {
        return executeConfigScrimChannelUsageCore(interaction, ctx);
      }
      if (sub === 'reset') {
        return executeConfigScrimChannelResetCore(interaction, ctx);
      }
    }

    if (group === 'permissions') {
      if (sub === 'set') {
        return executeConfigScrimPermissionsCore(interaction, ctx);
      }
      if (sub === 'remove') {
        return executeConfigScrimPermissionsRemoveCore(interaction, ctx);
      }
    }

    if (group === 'messages') {
      if (sub === 'set') {
        return executeConfigScrimMessagePolicySetCore(interaction, ctx);
      }
      if (sub === 'reset') {
        return executeConfigScrimMessagePolicyResetCore(interaction, ctx);
      }
    }

    if (group === null && sub === 'view') {
      return executeConfigScrimViewCore(interaction, ctx);
    }
  },
};
