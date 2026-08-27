import {
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getGuildLocale } from '../i18n/index.js';
import {
  applyDescriptionLocalizations,
  applyOptionLocalizations,
  localizedChoice,
  slashMeta,
} from '../i18n/slashLocalizations.js';
import { assertGuildAdministrator } from '../utils/guildAdministratorGuard.js';
import { executeBlockScrimUserCore } from './blockScrimUser.js';
import { executeUnblockScrimUserCore } from './unblockScrimUser.js';

const meta = slashMeta.scrimModeration;

const data = applyDescriptionLocalizations(
  new SlashCommandBuilder()
    .setName('scrim-moderation')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      applyDescriptionLocalizations(
        sub
          .setName('user')
          .addStringOption((opt) =>
            applyOptionLocalizations(
              opt
                .setName('action')
                .setRequired(true)
                .addChoices(
                  localizedChoice('block', meta.choices.block),
                  localizedChoice('unblock', meta.choices.unblock),
                ),
              meta.options.action,
            ),
          )
          .addUserOption((opt) =>
            applyOptionLocalizations(
              opt.setName('utilisateur').setRequired(true),
              meta.options.utilisateur,
            ),
          ),
        meta.subUser.description,
      ),
    ),
  meta.description,
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
