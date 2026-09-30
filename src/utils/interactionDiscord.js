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
 * DiscordAPIError[10062] Unknown interaction — token expiré / déjà consommé.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isUnknownInteractionError(err) {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  return Number(/** @type {{ code: unknown }} */ (err).code) === 10062;
}

/**
 * Notifie l’utilisateur après une erreur de commande.
 * Ne tente aucune réponse Discord si l’erreur (ou la notif) est 10062.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {unknown} commandErr
 * @param {import('discord.js').InteractionReplyOptions} payload
 * @param {{ warn?: Function, error?: Function }} [log]
 * @returns {Promise<{ notified: boolean, reason?: string }>}
 */
export async function notifyCommandErrorToUser(interaction, commandErr, payload, log = {}) {
  const warn = typeof log.warn === 'function' ? log.warn.bind(log) : () => {};
  const error = typeof log.error === 'function' ? log.error.bind(log) : () => {};

  if (isUnknownInteractionError(commandErr)) {
    warn('Interaction expirée (10062) — pas de message d’erreur utilisateur', {
      command: interaction.commandName,
      user_id: interaction.user?.id,
      guild_id: interaction.guildId,
    });
    return { notified: false, reason: 'unknown_interaction' };
  }

  try {
    if (interaction.replied || interaction.deferred) {
      await interactFollowUp(interaction, payload);
    } else {
      await interactReply(interaction, payload);
    }
    return { notified: true };
  } catch (replyErr) {
    if (isUnknownInteractionError(replyErr)) {
      warn('Interaction expirée (10062) lors de la notification d’erreur', {
        command: interaction.commandName,
        user_id: interaction.user?.id,
        guild_id: interaction.guildId,
      });
      return { notified: false, reason: 'unknown_interaction_on_notify' };
    }
    error('Impossible d’envoyer le message d’erreur à l’utilisateur', {
      message: replyErr instanceof Error ? replyErr.message : String(replyErr),
    });
    return { notified: false, reason: 'notify_failed' };
  }
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
