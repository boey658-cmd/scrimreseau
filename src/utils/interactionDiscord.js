import { runTransientDiscord } from '../services/discordApiGuard.js';

/**
 * Accusé de réponse initial : pas de runTransientDiscord — un retry après succès API ⇒ 40060.
 * editReply / followUp : retries conservés (pas double ACK du token d’interaction).
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('discord.js').InteractionReplyOptions} options
 */
export function interactReply(interaction, options) {
  return interaction.reply(options);
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
  return interaction.deferReply(options);
}

/**
 * @param {import('discord.js').AutocompleteInteraction} interaction
 * @param {import('discord.js').ApplicationCommandOptionChoiceData[]} choices
 */
export function interactAutocompleteRespond(interaction, choices) {
  return interaction.respond(choices);
}
