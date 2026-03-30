import { ApplicationCommandOptionType } from 'discord.js';
import {
  getGame,
  getAllGameKeys,
  UI_PRIMARY_GAME_KEY,
} from '../config/games.js';

/** Limite API Discord pour les choix d'autocomplete. */
export const AUTOCOMPLETE_MAX = 25;

const ALLOWED_GAME_KEYS = new Set(getAllGameKeys());

/**
 * Sérialise interaction.options.data pour les logs (pas de références circulaires).
 * @param {readonly import('discord.js').CommandInteractionOption[]} data
 */
export function serializeSlashOptionsData(data) {
  return data.map((o) => {
    /** @type {Record<string, unknown>} */
    const base = { name: o.name, type: o.type };
    if ('value' in o && o.value !== undefined) base.value = o.value;
    if ('focused' in o && o.focused !== undefined) base.focused = o.focused;
    return base;
  });
}

/**
 * Lit la valeur string d’une option slash depuis le tableau `data` (fiable en autocomplete).
 * @param {readonly import('discord.js').CommandInteractionOption[]} data
 * @param {string} optionName
 * @returns {string | null}
 */
export function resolveStringOptionValueFromData(data, optionName) {
  const opt = data.find(
    (o) =>
      o.name === optionName && o.type === ApplicationCommandOptionType.String,
  );
  if (!opt || !('value' in opt) || typeof opt.value !== 'string') return null;
  return opt.value;
}

/**
 * Résout la clé de jeu stable (value du choice Discord), jamais le label affiché.
 * Priorité : `options.data` puis secours `getString('jeu')`.
 * @param {import('discord.js').AutocompleteInteraction} interaction
 * @returns {string | null}
 */
export function resolveGameKeyForAutocomplete(interaction) {
  const data = interaction.options.data;
  const fromData = resolveStringOptionValueFromData(data, 'jeu');

  if (typeof fromData === 'string' && ALLOWED_GAME_KEYS.has(fromData)) {
    return fromData;
  }

  const fromGetter = interaction.options.getString('jeu');
  if (typeof fromGetter === 'string' && ALLOWED_GAME_KEYS.has(fromGetter)) {
    return fromGetter;
  }

  /* Commande /recherche-scrim sans option « jeu » : uniquement LoL côté utilisateur. */
  return UI_PRIMARY_GAME_KEY;
}

/**
 * @param {readonly string[]} items — depuis `games.js` uniquement
 * @param {string} partialRaw
 */
function buildChoicesFromGameList(items, partialRaw) {
  if (!items.length) return [];

  const partial = String(partialRaw ?? '').trim().toLowerCase();

  if (!partial) {
    return items.slice(0, AUTOCOMPLETE_MAX).map((x) => ({ name: x, value: x }));
  }

  const starts = items.filter((x) => x.toLowerCase().startsWith(partial));
  const includesOnly = items.filter(
    (x) => !starts.includes(x) && x.toLowerCase().includes(partial),
  );
  return [...starts, ...includesOnly]
    .slice(0, AUTOCOMPLETE_MAX)
    .map((x) => ({ name: x, value: x }));
}

/**
 * @param {string} gameKey — doit être une clé valide (ex. cs2)
 * @param {string} partialRaw
 */
export function buildRankAutocompleteChoices(gameKey, partialRaw) {
  const game = getGame(gameKey);
  if (!game) return [];
  return buildChoicesFromGameList([...game.ranks], partialRaw);
}

/**
 * @param {string} gameKey
 * @param {string} partialRaw
 */
export function buildFormatAutocompleteChoices(gameKey, partialRaw) {
  const game = getGame(gameKey);
  if (!game) return [];
  return buildChoicesFromGameList([...game.formats], partialRaw);
}
