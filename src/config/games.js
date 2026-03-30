/**
 * Catalogue jeux : clés stables, libellés affichés, rangs et formats (listes fermées, validation stricte).
 * Source unique pour slash choices, autocomplete et validateRank / validateFormat.
 */

export const GAMES = Object.freeze({
  league_of_legends: Object.freeze({
    key: 'league_of_legends',
    label: 'League of Legends',
    ranks: Object.freeze([
      'Fer',
      'Bronze',
      'Argent',
      'Or',
      'Platine',
      'Émeraude',
      'Diamant',
      'Master',
      'Grandmaster',
      'Challenger',
      'Bronze / Argent',
      'Argent / Or',
      'Or / Platine',
      'Platine / Émeraude',
      'Émeraude / Diamant',
      'Diamant / Master',
      'Master / Grandmaster',
      'Grandmaster / Challenger',
      'Mix niveau',
    ]),
    formats: Object.freeze([
      'BO1',
      'BO2',
      'BO3',
      'BO5',
      'Scrim simple',
      'Scrim série',
    ]),
  }),
  valorant: Object.freeze({
    key: 'valorant',
    label: 'Valorant',
    ranks: Object.freeze([
      'Fer',
      'Bronze',
      'Argent',
      'Or',
      'Platine',
      'Diamant',
      'Ascendant',
      'Immortal',
      'Radiant',
    ]),
    formats: Object.freeze([
      'BO1',
      'BO3',
      'BO5',
      'Scrim simple',
      'Scrim série',
    ]),
  }),
  cs2: Object.freeze({
    key: 'cs2',
    label: 'Counter-Strike 2',
    ranks: Object.freeze([
      '0–4999',
      '5000–9999',
      '10000–14999',
      '15000–19999',
      '20k+',
      'Mix niveau',
    ]),
    formats: Object.freeze([
      'MR12',
      'BO1',
      'BO3',
      'BO5',
      'Scrim simple',
      'Scrim série',
      'Wingman',
    ]),
  }),
  rocket_league: Object.freeze({
    key: 'rocket_league',
    label: 'Rocket League',
    ranks: Object.freeze([
      'Bronze',
      'Argent',
      'Or',
      'Platine',
      'Diamant',
      'Champion',
      'Grand Champion',
      'Supersonic Legend',
      'Mix niveau',
    ]),
    formats: Object.freeze([
      'BO3',
      'BO5',
      'BO7',
      'Scrim simple',
      'Scrim série',
      '2v2',
      '3v3',
    ]),
  }),
  rainbow_six_siege: Object.freeze({
    key: 'rainbow_six_siege',
    label: 'Rainbow Six Siege',
    ranks: Object.freeze([
      'Cuivre',
      'Bronze',
      'Argent',
      'Or',
      'Platine',
      'Émeraude',
      'Diamant',
      'Champions',
      'Mix niveau',
    ]),
    formats: Object.freeze([
      'BO1',
      'BO3',
      'BO5',
      'Scrim simple',
      'Scrim série',
      'Classée',
    ]),
  }),
  overwatch_2: Object.freeze({
    key: 'overwatch_2',
    label: 'Overwatch 2',
    ranks: Object.freeze([
      'Bronze',
      'Argent',
      'Or',
      'Platine',
      'Diamant',
      'Master',
      'Grandmaster',
      'Top 500',
      'Mix niveau',
    ]),
    formats: Object.freeze([
      'BO1',
      'BO3',
      'BO5',
      'Scrim simple',
      'Scrim série',
      'Mix modes',
    ]),
  }),
  apex_legends: Object.freeze({
    key: 'apex_legends',
    label: 'Apex Legends',
    ranks: Object.freeze([
      'Rookie',
      'Bronze',
      'Argent',
      'Or',
      'Platine',
      'Diamant',
      'Master',
      'Apex Predator',
      'Mix niveau',
    ]),
    formats: Object.freeze([
      'Lobby custom',
      'Scrim simple',
      'Série de scrims',
    ]),
  }),
  fortnite: Object.freeze({
    key: 'fortnite',
    label: 'Fortnite',
    ranks: Object.freeze([
      'Bronze',
      'Argent',
      'Or',
      'Platine',
      'Diamant',
      'Élite',
      'Champion',
      'Unreal',
      'Mix niveau',
    ]),
    formats: Object.freeze([
      'Custom game',
      'Duo',
      'Trio',
      'Squad',
      'Scrim simple',
      'Série de scrims',
    ]),
  }),
  teamfight_tactics: Object.freeze({
    key: 'teamfight_tactics',
    label: 'Teamfight Tactics',
    ranks: Object.freeze([
      'Fer',
      'Bronze',
      'Argent',
      'Or',
      'Platine',
      'Diamant',
      'Master',
      'Grandmaster',
      'Challenger',
    ]),
    formats: Object.freeze([
      'Lobby custom',
      'Série de scrims',
    ]),
  }),
  dota_2: Object.freeze({
    key: 'dota_2',
    label: 'Dota 2',
    ranks: Object.freeze([
      'Héraut',
      'Guerrier',
      'Chevalier',
      'Noble',
      'Immortel',
      'Légende',
      'Divin / Singularité',
      'Top leaderboard',
      'Mix niveau',
    ]),
    formats: Object.freeze([
      'BO1',
      'BO2',
      'BO3',
      'Scrim simple',
      'Scrim série',
      'Captain Mode',
    ]),
  }),
});

/**
 * Choix slash « jeu » : `name` = libellé Discord, `value` = clé stable.
 * (Toujours défini pour les usages internes ; côté utilisateur, préférer
 * `GAME_SLASH_CHOICES_UI_PRIMARY` tant que le bot est présenté LoL-only.)
 */
export const GAME_SLASH_CHOICES = Object.freeze(
  Object.values(GAMES).map((g) => ({ name: `${g.label}`, value: g.key })),
);

/**
 * Clé stable du jeu affiché seul côté utilisateur (League of Legends).
 * Le catalogue `GAMES` reste multi-jeu pour compatibilité données / embeds existants.
 */
export const UI_PRIMARY_GAME_KEY = 'league_of_legends';

/** Un seul choix slash visible : LoL (même `value` qu’en base pour `guild_game_channels.game_key`). */
export const GAME_SLASH_CHOICES_UI_PRIMARY = Object.freeze([
  {
    name: GAMES[UI_PRIMARY_GAME_KEY].label,
    value: UI_PRIMARY_GAME_KEY,
  },
]);

/**
 * Rangs LoL pour options slash à choix fermés (même liste que l’autocomplete /recherche-scrim `rang`).
 * Discord limite à 25 choix ; le catalogue LoL actuel tient dans cette limite.
 * @returns {{ name: string, value: string }[]}
 */
export function getPrimaryGameRankChoicesForSlash() {
  const g = GAMES[UI_PRIMARY_GAME_KEY];
  return g.ranks.map((r) => ({ name: r, value: r }));
}

export function getGame(gameKey) {
  if (typeof gameKey !== 'string') return null;
  const g = GAMES[gameKey];
  return g ?? null;
}

export function getAllGameKeys() {
  return Object.keys(GAMES);
}

/**
 * Tous les libellés de rang du catalogue (pour validation stricte, ex. /liste-scrims).
 * @returns {readonly string[]}
 */
export function getAllRankKeysFromCatalog() {
  /** @type {Set<string>} */
  const set = new Set();
  for (const g of Object.values(GAMES)) {
    for (const r of g.ranks) {
      set.add(r);
    }
  }
  return Object.freeze([...set]);
}

/**
 * Correspondance insensible à la casse vers la valeur canonique du catalogue.
 * @param {string} raw
 * @returns {string | null}
 */
export function matchRankKeyCanonical(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const t = raw.trim().toLowerCase();
  for (const r of getAllRankKeysFromCatalog()) {
    if (r.toLowerCase() === t) return r;
  }
  return null;
}
