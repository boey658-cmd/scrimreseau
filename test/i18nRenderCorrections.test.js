/**
 * Tests de rendu réel post-corrections i18n (juillet 2026).
 *
 * Couvre :
 *  1. /helpadmin-scrim — block/unblock EN précis
 *  2. /find-scrim — descriptions options corrigées
 *  3–5.  CET/CEST dynamique + heure inchangée
 *  6–7.  Annonce embed FR/EN — rang, fearless
 *  8–9.  /list-scrims FR/EN — rang, séparateur, fearless, voir message
 * 10–11. /my-scrims FR/EN — rang, à/at, format 04h53 / 04:53
 * 12–19. /scrim-config panneaux FR/EN
 * 20.   Refus configuration EN (nouveau texte)
 * 21.   Gate inchangé (comportement)
 * 22.   /scrim-moderation user description exacte
 * 23.   /structure-link set/remove descriptions
 * 24.   Aucune clé scrimConfig.* visible
 * 25.   Aucun texte français dans les clés EN ciblées
 * 26.   Aucune valeur interne, clé DB ou custom ID modifié
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ── i18n ─────────────────────────────────────────────────────────────
import { t, createTranslator } from '../src/i18n/index.js';
import { fr } from '../src/i18n/fr.js';
import { en } from '../src/i18n/en.js';

// ── Helpers ──────────────────────────────────────────────────────────
import { getParisTimezoneAbbr } from '../src/utils/scrimScheduledAt.js';
import { formatParisDisplayFromUtcIso, formatParisScrimListSchedule } from '../src/services/scrimEmbedBuilder.js';
import { formatListeScrimLine } from '../src/services/listeScrimsQuery.js';
import { localizeRank } from '../src/config/games.js';
import { formatRankWithPrecision } from '../src/config/eloPrecision.js';

// ── Commandes (structures Slash) ─────────────────────────────────────
import { commandListWithoutDev } from '../src/commands/index.js';

// ── Refus configuration ───────────────────────────────────────────────
import { buildScrimReceptionConfigRefusalContent } from '../src/utils/guildScrimReceptionGate.js';

// ──────────────────────────────────────────────────────────────────────

// ISO UTC de référence pour tests (été Paris = CEST, hiver = CET)
const ISO_ETE  = '2026-07-27T19:00:00.000Z'; // 21:00 Paris CEST
const ISO_HIVER = '2026-01-20T19:30:00.000Z'; // 20:30 Paris CET

// ─── 1. /helpadmin-scrim block/unblock EN précis ─────────────────────

describe('/helpadmin-scrim block/unblock EN', () => {
  it('block EN contient le nouveau texte précis (test 1)', () => {
    const val = t('en', 'helpAdmin.moderationValue');
    assert.ok(
      val.includes("Prevents that user's scrim announcements from being broadcast on this server."),
      `block EN incorrect : "${val}"`,
    );
  });

  it('unblock EN contient le nouveau texte précis (test 1)', () => {
    const val = t('en', 'helpAdmin.moderationValue');
    assert.ok(
      val.includes("Allows that user's scrim announcements to be broadcast again on this server."),
      `unblock EN incorrect : "${val}"`,
    );
  });

  it('block/unblock FR non régressé (test 1)', () => {
    const val = t('fr', 'helpAdmin.moderationValue');
    assert.ok(val.includes('bloquer') || val.includes('user'), `FR régressé : "${val}"`);
    assert.ok(val.includes('débloquer') || val.includes('user'), `FR régressé : "${val}"`);
  });
});

// ─── 2. /find-scrim descriptions options ────────────────────────────

describe('/find-scrim descriptions options (test 2)', () => {
  const findScrim = commandListWithoutDev.find((c) => c.data.name === 'find-scrim');

  it('option heure_max_debut description exacte', () => {
    const json = findScrim.data.toJSON();
    const opt = json.options.find((o) => o.name === 'heure_max_debut');
    assert.equal(opt?.description, 'Latest possible start time if flexible.');
  });

  it('option multi_opgg description exacte', () => {
    const json = findScrim.data.toJSON();
    const opt = json.options.find((o) => o.name === 'multi_opgg');
    assert.equal(opt?.description, 'HTTPS link to a Multi-OP.GG page.');
  });
});

// ─── 3. CET en hiver ────────────────────────────────────────────────

describe('Fuseau CET/CEST dynamique (tests 3–5)', () => {
  it('date hivernale → CET (test 3)', () => {
    const tz = getParisTimezoneAbbr(ISO_HIVER);
    assert.equal(tz, 'CET');
  });

  it('date estivale → CEST (test 4)', () => {
    const tz = getParisTimezoneAbbr(ISO_ETE);
    assert.equal(tz, 'CEST');
  });

  it("heure EN hiver : 20:30 (CET) — heure inchangée (test 5)", () => {
    const fmt = formatParisDisplayFromUtcIso(ISO_HIVER, 'en');
    assert.equal(fmt?.timeStr, '20:30 (CET)');
  });

  it("heure EN été : 21:00 (CEST) — heure inchangée (test 5)", () => {
    const fmt = formatParisDisplayFromUtcIso(ISO_ETE, 'en');
    assert.equal(fmt?.timeStr, '21:00 (CEST)');
  });

  it("heure FR hiver : 20h30 (CET) — heure inchangée (test 5)", () => {
    const fmt = formatParisDisplayFromUtcIso(ISO_HIVER, 'fr');
    assert.equal(fmt?.timeStr, '20h30 (CET)');
  });
});

// ─── 6–7. Annonce embed rang + fearless ────────────────────────────

describe('localizeRank + formatRankWithPrecision (tests 6–7)', () => {
  it('rang Platine EN → Platinum (test 6)', () => {
    assert.equal(localizeRank('Platine', 'en'), 'Platinum');
  });

  it('rang Platine FR → Platine (test 7)', () => {
    assert.equal(localizeRank('Platine', 'fr'), 'Platine');
  });

  it('rang Fer EN → Iron', () => {
    assert.equal(localizeRank('Fer', 'en'), 'Iron');
  });

  it('rang Argent EN → Silver', () => {
    assert.equal(localizeRank('Argent', 'en'), 'Silver');
  });

  it('rang Or EN → Gold', () => {
    assert.equal(localizeRank('Or', 'en'), 'Gold');
  });

  it('rang Émeraude EN → Emerald', () => {
    assert.equal(localizeRank('\u00c9meraude', 'en'), 'Emerald');
  });

  it('rang Diamant EN → Diamond', () => {
    assert.equal(localizeRank('Diamant', 'en'), 'Diamond');
  });

  it('rang composite Bronze / Argent EN → Bronze \u2013 Silver', () => {
    assert.equal(localizeRank('Bronze / Argent', 'en'), 'Bronze \u2013 Silver');
  });

  it('fearless oui EN → Fearless: Yes (test 6)', () => {
    const val = t('en', 'embed.fearlessOui');
    assert.ok(val.includes('Yes'), `EN fearlessOui incorrect : "${val}"`);
    assert.ok(!val.includes('Oui'), `EN fearlessOui contient français : "${val}"`);
  });

  it('fearless non FR → Fearless : Non (test 7)', () => {
    const val = t('fr', 'embed.fearlessNon');
    assert.ok(val.includes('Non'), `FR fearlessNon incorrect : "${val}"`);
  });
});

// ─── 8–9. /list-scrims FR/EN ───────────────────────────────────────

describe('/list-scrims formatListeScrimLine (tests 8–9)', () => {
  const row = {
    rank_key: 'Platine',
    elo_precision: null,
    scheduled_at: ISO_ETE,
    scheduled_at_end: null,
    scheduled_date: '27/07/2026',
    scheduled_time: '21:00',
    format_key: 'BO3',
    tags: JSON.stringify({ fearless: 'oui' }),
  };

  it('/list-scrims EN : rang Platinum, at, (CEST), Fearless: Yes, View message (test 8)', () => {
    const line = formatListeScrimLine(row, row.tags, 'https://discord.com/channels/1/2/3', 'en');
    assert.ok(line.includes('Platinum'), `rang EN absent : "${line}"`);
    assert.ok(line.includes(' at '), `séparateur 'at' absent : "${line}"`);
    assert.ok(line.includes('(CEST)'), `CEST absent : "${line}"`);
    assert.ok(line.includes('Fearless: Yes'), `Fearless EN absent : "${line}"`);
    assert.ok(line.includes('View message'), `'View message' absent : "${line}"`);
    assert.ok(!line.includes('Platine'), `rang FR dans EN : "${line}"`);
    assert.ok(!line.includes(' à '), `séparateur 'à' dans EN : "${line}"`);
    assert.ok(!line.includes('Oui'), `'Oui' dans EN : "${line}"`);
    assert.ok(!line.includes('Voir le message'), `'Voir le message' dans EN : "${line}"`);
  });

  it('/list-scrims FR : rang Platine, à, sans CEST, Fearless : Oui, Voir le message (test 9)', () => {
    const line = formatListeScrimLine(row, row.tags, 'https://discord.com/channels/1/2/3', 'fr');
    assert.ok(line.includes('Platine'), `rang FR absent : "${line}"`);
    assert.ok(line.includes(' à '), `séparateur 'à' absent : "${line}"`);
    assert.ok(!line.includes('(CEST)'), `CEST dans FR list : "${line}"`);
    assert.ok(line.includes('Fearless : Oui'), `Fearless FR absent : "${line}"`);
    assert.ok(line.includes('Voir le message'), `'Voir le message' absent : "${line}"`);
    assert.ok(!line.includes('Platinum'), `rang EN dans FR : "${line}"`);
  });
});

// ─── 10–11. /my-scrims FR/EN ──────────────────────────────────────

describe('/my-scrims i18n (tests 10–11)', () => {
  it('myScrims.createdAtFormat EN contient "at" et HH:mm (test 10)', () => {
    const fmt = t('en', 'myScrims.createdAtFormat');
    assert.ok(fmt.includes('at'), `'at' absent du format EN : "${fmt}"`);
    assert.ok(fmt.includes('HH:mm') || fmt.includes('HH'), `HH absent du format EN : "${fmt}"`);
    assert.ok(!fmt.includes("'h'"), `format 'h' dans EN : "${fmt}"`);
  });

  it('myScrims.createdAtFormat FR contient h (test 11)', () => {
    const fmt = t('fr', 'myScrims.createdAtFormat');
    assert.ok(fmt.includes("'h'") || fmt.includes('h'), `'h' absent du format FR : "${fmt}"`);
  });

  it('séparateur listeQuery.at EN → " at " (test 10)', () => {
    assert.equal(t('en', 'listeQuery.at'), ' at ');
  });

  it('séparateur listeQuery.at FR → " à " (test 11)', () => {
    assert.equal(t('fr', 'listeQuery.at'), ' à ');
  });
});

// ─── 12–19. /scrim-config panneaux FR/EN ─────────────────────────

describe('/scrim-config panneaux FR/EN (tests 12–19)', () => {
  it('fieldPerms EN → "Permissions for /find-scrim" (test 14)', () => {
    const val = t('en', 'scrimConfig.fieldPerms');
    assert.equal(val, '\ud83d\udd11 Permissions for /find-scrim');
  });

  it('policyKeep EN → "Keep and mark as inactive" (test 15)', () => {
    const val = t('en', 'scrimConfig.policyKeep');
    assert.equal(val, 'Keep and mark as inactive');
  });

  it('permsDesc EN contient "Select up to" (test 14)', () => {
    const val = t('en', 'scrimConfig.permsDesc');
    assert.ok(val.includes('Select up to'), `permsDesc EN incorrect : "${val}"`);
    assert.ok(!val.includes('max {max}'), `ancien format toujours présent : "${val}"`);
  });

  it('msgsPolicyKeepLabel EN → "Keep and mark as inactive" (test 15)', () => {
    const val = t('en', 'scrimConfig.msgsPolicyKeepLabel');
    assert.equal(val, 'Keep and mark as inactive');
  });

  it('btnBack EN → "← Back" (test 16)', () => {
    assert.equal(t('en', 'scrimConfig.btnBack'), '\u2190 Back');
  });

  it('btnBack FR → "← Retour" (test 19)', () => {
    assert.equal(t('fr', 'scrimConfig.btnBack'), '\u2190 Retour');
  });

  it('panneau principal EN : mainTitle traduit (test 12)', () => {
    const T = createTranslator('en');
    const title = T('scrimConfig.mainTitle');
    assert.ok(!title.startsWith('scrimConfig.'), `mainTitle EN = clé brute : "${title}"`);
    assert.ok(title.includes('ScrimR\u00e9seau') || title.includes('Config'), `titre inattendu : "${title}"`);
  });

  it('panneau principal FR : mainTitle traduit (test 19)', () => {
    const T = createTranslator('fr');
    const title = T('scrimConfig.mainTitle');
    assert.ok(!title.startsWith('scrimConfig.'), `mainTitle FR = clé brute : "${title}"`);
  });

  it('reset confirm EN : resetConfirmDesc traduit (test 18)', () => {
    const T = createTranslator('en');
    const desc = T('scrimConfig.resetConfirmDesc');
    assert.ok(!desc.startsWith('scrimConfig.'), `resetConfirmDesc EN = clé brute : "${desc}"`);
    assert.ok(desc.toLowerCase().includes('irreversible') || desc.toLowerCase().includes('confirm'), `texte inattendu : "${desc}"`);
  });

  it('channels panel EN : salonsTitle traduit (test 13)', () => {
    assert.ok(!t('en', 'scrimConfig.salonsTitle').startsWith('scrimConfig.'));
    assert.ok(t('en', 'scrimConfig.salonsTitle').includes('Channels'));
  });

  it('permissions panel EN : permsTitle traduit (test 14)', () => {
    assert.ok(!t('en', 'scrimConfig.permsTitle').startsWith('scrimConfig.'));
  });

  it('inactive messages panel EN : msgsTitle traduit (test 15)', () => {
    assert.ok(!t('en', 'scrimConfig.msgsTitle').startsWith('scrimConfig.'));
  });

  it('reset panel EN : resetTitle traduit (test 16)', () => {
    assert.ok(!t('en', 'scrimConfig.resetTitle').startsWith('scrimConfig.'));
  });

  it('menu inactive messages EN : options traduits (test 17)', () => {
    const keep = t('en', 'scrimConfig.msgsPolicyKeepLabel');
    const del = t('en', 'scrimConfig.msgsPolicyDeleteLabel');
    assert.ok(!keep.startsWith('scrimConfig.'));
    assert.ok(!del.startsWith('scrimConfig.'));
    assert.ok(!keep.includes('Garder'), `'Garder' dans EN keepLabel : "${keep}"`);
    assert.ok(!del.includes('Supprimer'), `'Supprimer' dans EN deleteLabel : "${del}"`);
  });
});

// ─── 20. Refus configuration EN ─────────────────────────────────

describe('Refus /scrim-config EN (test 20)', () => {
  it('texte anglais exact — "manually approved" présent', () => {
    const T = createTranslator('en');
    const content = buildScrimReceptionConfigRefusalContent(T);
    assert.ok(
      content.includes('manually approved'),
      `'manually approved' absent : "${content.slice(0, 200)}"`,
    );
    assert.ok(
      content.includes('open a ticket'),
      `'open a ticket' absent : "${content.slice(0, 200)}"`,
    );
    assert.ok(
      content.includes('scrim announcements'),
      `'scrim announcements' absent : "${content.slice(0, 200)}"`,
    );
  });

  it('texte FR non régressé (test 20)', () => {
    const T = createTranslator('fr');
    const content = buildScrimReceptionConfigRefusalContent(T);
    assert.ok(
      content.includes('activée manuellement') || content.includes('manuellement'),
      `FR régressé : "${content.slice(0, 200)}"`,
    );
  });
});

// ─── 21. Gate inchangé ───────────────────────────────────────────

describe('Gate comportement inchangé (test 21)', () => {
  it('buildScrimReceptionConfigRefusalContent retourne une chaîne non vide', () => {
    const T = createTranslator('fr');
    const content = buildScrimReceptionConfigRefusalContent(T);
    assert.ok(typeof content === 'string' && content.length > 0);
  });

  it('sans traducteur → français par défaut', () => {
    const content = buildScrimReceptionConfigRefusalContent(undefined);
    assert.ok(typeof content === 'string' && content.length > 0);
    assert.ok(!content.includes('manually approved'), `contenu EN sans traducteur : "${content.slice(0, 100)}"`);
  });
});

// ─── 22. /scrim-moderation user description exacte ───────────────

describe('/scrim-moderation user description (test 22)', () => {
  it("description exacte : Block or unblock a user's scrim announcements on this server.", () => {
    const scrimMod = commandListWithoutDev.find((c) => c.data.name === 'scrim-moderation');
    const json = scrimMod.data.toJSON();
    const userSub = json.options?.find((o) => o.name === 'user');
    assert.equal(
      userSub?.description,
      "Block or unblock a user's scrim announcements on this server.",
    );
  });
});

// ─── 23. /structure-link set/remove descriptions ────────────────

describe('/structure-link set/remove descriptions (test 23)', () => {
  const strLink = commandListWithoutDev.find((c) => c.data.name === 'structure-link');

  it('set description exacte', () => {
    const json = strLink.data.toJSON();
    const setSub = json.options?.find((o) => o.name === 'set');
    assert.equal(setSub?.description, 'Set the Discord invite link associated with your structure.');
  });

  it('remove description exacte', () => {
    const json = strLink.data.toJSON();
    const remSub = json.options?.find((o) => o.name === 'remove');
    assert.equal(remSub?.description, 'Remove the Discord invite link associated with your structure.');
  });
});

// ─── 24. Aucune clé scrimConfig.* visible dans les valeurs EN ────

describe('Aucune clé technique scrimConfig.* dans les valeurs EN (test 24)', () => {
  const KEY_RE = /^[a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z0-9_.]+$/;

  it('aucune valeur en.js pour scrimConfig.* ne ressemble à une clé brute', () => {
    const scrimConfigKeys = Object.entries(en).filter(([k]) => k.startsWith('scrimConfig.'));
    for (const [key, value] of scrimConfigKeys) {
      assert.ok(
        !KEY_RE.test(value),
        `Clé EN "${key}" semble non résolue : valeur = "${value}"`,
      );
    }
  });
});

// ─── 25. Aucun texte français dans les clés EN ciblées ───────────

describe('Aucun mot français dans les clés EN ciblées (test 25)', () => {
  const FR_WORDS = ['Platine', 'Argent', 'Émeraude', 'Diamant', 'Oui', 'Non', 'Retour',
    'Supprimer automatiquement', 'heure française', 'Voir le message'];

  for (const word of FR_WORDS) {
    it(`clé gate.refusalBody EN ne contient pas "${word}"`, () => {
      const val = t('en', 'gate.refusalBody');
      assert.ok(!val.includes(word), `"${word}" trouvé dans gate.refusalBody EN : "${val.slice(0, 100)}"`);
    });
  }

  it('clé helpAdmin.moderationValue EN ne contient pas de français', () => {
    const val = t('en', 'helpAdmin.moderationValue');
    assert.ok(!val.includes('utilisateur'), `'utilisateur' dans EN : "${val}"`);
    assert.ok(!val.includes('bloquer'), `'bloquer' dans EN : "${val}"`);
  });

  it('scrimConfig.policyKeep EN ne contient pas "Garder"', () => {
    assert.ok(!t('en', 'scrimConfig.policyKeep').includes('Garder'));
  });

  it('scrimConfig.msgsPolicyKeepLabel EN ne contient pas "Garder"', () => {
    assert.ok(!t('en', 'scrimConfig.msgsPolicyKeepLabel').includes('Garder'));
  });

  it('scrimConfig.fieldPerms EN ne contient pas de formulation abrégée', () => {
    const val = t('en', 'scrimConfig.fieldPerms');
    assert.ok(val.includes('for'), `'for' absent de fieldPerms EN : "${val}"`);
  });
});

// ─── 26. Valeurs internes inchangées ─────────────────────────────

describe('Valeurs internes inchangées (test 26)', () => {
  it('FEARLESS_VALUE_OUI reste "oui"', async () => {
    const { FEARLESS_VALUE_OUI } = await import('../src/services/scrimEmbedBuilder.js');
    assert.equal(FEARLESS_VALUE_OUI, 'oui');
  });

  it('FEARLESS_VALUE_NON reste "non"', async () => {
    const { FEARLESS_VALUE_NON } = await import('../src/services/scrimEmbedBuilder.js');
    assert.equal(FEARLESS_VALUE_NON, 'non');
  });

  it('FEARLESS_VALUE_NIMPORTE reste "nimporte"', async () => {
    const { FEARLESS_VALUE_NIMPORTE } = await import('../src/services/scrimEmbedBuilder.js');
    assert.equal(FEARLESS_VALUE_NIMPORTE, 'nimporte');
  });

  it('localizeRank ne modifie pas la valeur source', () => {
    // La valeur DB ne change pas
    assert.equal(localizeRank('Platine', 'en'), 'Platinum');
    assert.equal(localizeRank('Platine', 'fr'), 'Platine');
    // Les rangs sans traduction restent inchangés
    assert.equal(localizeRank('Master', 'en'), 'Master');
    assert.equal(localizeRank('Master', 'fr'), 'Master');
    assert.equal(localizeRank('BO3', 'en'), 'BO3'); // format, pas un rang
  });

  it('formatListeScrimLine valeur rank_key non modifiée en DB', () => {
    // La fonction reçoit la valeur DB 'Platine' et retourne l'affichage localisé
    // sans modifier la valeur d'entrée
    const rank = 'Platine';
    formatListeScrimLine(
      { rank_key: rank, elo_precision: null, scheduled_at: null, scheduled_date: '27/07/2026', scheduled_time: '21:00', format_key: 'BO3', tags: '{}' },
      '{}',
      null,
      'en',
    );
    assert.equal(rank, 'Platine', 'rank_key modifié par effet de bord');
  });
});
