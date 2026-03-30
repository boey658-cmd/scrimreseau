import { runTransientDiscord } from '../services/discordApiGuard.js';

/**
 * Wrappers interactions : retry / 429 sans passer par la file globale (réponses sous contrainte de temps).
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('discord.js').InteractionReplyOptions} options
 */
export function interactReply(interaction, options) {
  return runTransientDiscord(() => interaction.reply(options), {
    kind: 'interaction.reply',
    metadata: { command: interaction.commandName },
  });
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string | import('discord.js').MessagePayload | import('discord.js').InteractionEditReplyOptions} options
 */
export function interactEditReply(interaction, options) {
  return runTransientDiscord(() => interaction.editReply(options), {
    kind: 'interaction.editReply',
    metadata: { command: interaction.commandName },
  });
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string | import('discord.js').MessagePayload | import('discord.js').InteractionReplyOptions} options
 */
export function interactFollowUp(interaction, options) {
  return runTransientDiscord(() => interaction.followUp(options), {
    kind: 'interaction.followUp',
    metadata: { command: interaction.commandName },
  });
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('discord.js').InteractionDeferReplyOptions} [options]
 */
export function interactDeferReply(interaction, options) {
  return runTransientDiscord(() => interaction.deferReply(options), {
    kind: 'interaction.deferReply',
    metadata: { command: interaction.commandName },
    maxAttempts: 2,
  });
}

/**
 * @param {import('discord.js').AutocompleteInteraction} interaction
 * @param {import('discord.js').ApplicationCommandOptionChoiceData[]} choices
 */
export function interactAutocompleteRespond(interaction, choices) {
  return runTransientDiscord(() => interaction.respond(choices), {
    kind: 'autocomplete.respond',
    metadata: { command: interaction.commandName },
    maxAttempts: 2,
  });
}
