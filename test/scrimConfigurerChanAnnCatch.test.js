/**
 * Test de régression — bloc catch du handler chan_ann dans /scrim-config
 *
 * Bug corrigé : dans le catch de chan_ann, buildSalonsComponents(uid) était appelé
 * sans le paramètre T. Le fallback T = (k) => k retournait alors les clés brutes
 * (ex. "scrimConfig.placeholderReception") dans les composants Discord.
 *
 * Ce test :
 *  1. Appelle le vrai handler handleComponent (via _handleComponentForTest).
 *  2. Force le bloc catch en provoquant une erreur DB pendant la sauvegarde.
 *  3. Capture le payload renvoyé par i.editReply.
 *  4. Vérifie qu'aucun label/placeholder ne ressemble à une clé i18n non résolue.
 *  5. Vérifie les textes spécifiques EN et FR.
 *  6. Vérifie que l'heure de Paris est identique en FR et EN pour une même date ISO.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ChannelType } from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { createTranslator } from '../src/i18n/index.js';
import { _handleComponentForTest as handleComponent } from '../src/commands/scrimConfigurer.js';
import { formatParisDisplayFromUtcIso } from '../src/services/scrimEmbedBuilder.js';

// ---------------------------------------------------------------------------
// Pattern de clé i18n non résolue
// ---------------------------------------------------------------------------

/** Identifie une clé brute non traduite, ex. "scrimConfig.placeholderReception". */
const UNRESOLVED_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z0-9_.]+$/;

// ---------------------------------------------------------------------------
// Helpers d'extraction de texte depuis les composants Discord.js
// ---------------------------------------------------------------------------

/**
 * Parcourt récursivement les composants ActionRow retournés par les builders
 * et collecte tous les labels, placeholders et descriptions visibles.
 *
 * @param {import('discord.js').ActionRowBuilder[]} components
 * @returns {string[]}
 */
function extractVisibleTexts(components) {
  const texts = [];
  for (const row of components) {
    const rowData = row.toJSON ? row.toJSON() : row;
    const comps = rowData.components ?? [];
    for (const comp of comps) {
      if (comp.label) texts.push(comp.label);
      if (comp.placeholder) texts.push(comp.placeholder);
      if (comp.options) {
        for (const opt of comp.options) {
          if (opt.label) texts.push(opt.label);
          if (opt.description) texts.push(opt.description);
        }
      }
    }
  }
  return texts;
}

/**
 * Échoue si un texte visible ressemble à une clé i18n non résolue.
 *
 * @param {import('discord.js').ActionRowBuilder[]} components
 * @param {string} locale  – utilisé dans les messages d'erreur
 */
function assertNoRawI18nKeys(components, locale) {
  const texts = extractVisibleTexts(components);
  for (const text of texts) {
    assert.ok(
      !UNRESOLVED_KEY_PATTERN.test(text),
      `[${locale}] Texte ressemble à une clé non résolue : "${text}"`,
    );
    assert.ok(
      text !== undefined && text !== null && text !== '',
      `[${locale}] Texte vide ou null dans les composants`,
    );
    assert.ok(
      text !== '[object Object]',
      `[${locale}] "[object Object]" dans les composants`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helper : base SQLite temporaire
// ---------------------------------------------------------------------------

/**
 * Crée une DB temporaire pour la durée du test, nettoie à la fin.
 *
 * @param {(db: import('better-sqlite3').Database, stmts: ReturnType<typeof prepareStatements>) => void | Promise<void>} fn
 */
async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-chan-ann-test-'));
  const prev = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  try {
    const db = getDb();
    const stmts = prepareStatements(db);
    await fn(db, stmts);
  } finally {
    closeDb();
    if (prev === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Helpers de mocks Discord
// ---------------------------------------------------------------------------

/**
 * Crée un mock de guilde autorisé à configurer la réception scrim.
 * Met à jour la DB pour que le bypass soit actif.
 *
 * @param {string} guildId
 * @param {string} channelId – ID du salon de test mis dans le cache
 * @param {ReturnType<typeof prepareStatements>} stmts
 */
function buildAuthorizedGuild(guildId, channelId, stmts) {
  // Activer le bypass pour que mayConfigureScrimReceptionChannel passe
  stmts.upsertGuildScrimReceptionBypass.run({
    guild_id: guildId,
    bypass_member_minimum: 1,
    updated_by: 'test-runner',
    updated_at: new Date().toISOString(),
    note: 'test',
  });

  const mockBotMember = { id: 'bot-000' };
  const mockChannel = {
    id: channelId,
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
  };

  return {
    id: guildId,
    memberCount: 500,
    channels: {
      cache: new Map([[channelId, mockChannel]]),
      fetch: async () => mockChannel,
    },
    members: {
      me: mockBotMember,
      fetchMe: async () => mockBotMember,
    },
    roles: { cache: new Map() },
  };
}

/**
 * Construit un faux objet interaction pour un composant chan_ann.
 *
 * @param {string} uid
 * @param {string} channelId
 * @returns {{ interaction: object, captureEditReply: () => object | null }}
 */
function buildChanAnnInteraction(uid, channelId) {
  let captured = null;
  const interaction = {
    customId: `scrimcfg:${uid}:chan_ann`,
    values: [channelId],
    user: { id: uid },
    deferred: false,
    replied: false,
    deferUpdate: async function () { this.deferred = true; },
    editReply: async function (payload) { captured = payload; },
    update: async function () {},
    reply: async function () {},
    memberPermissions: { has: () => true },
    client: { guilds: { cache: new Map() } },
  };
  return { interaction, getCapture: () => captured };
}

// ---------------------------------------------------------------------------
// Tests de régression — catch de chan_ann
// ---------------------------------------------------------------------------

describe('scrimConfigurer — chan_ann catch : T transmis, aucune clé brute (régression)', () => {

  // ── EN ──────────────────────────────────────────────────────────────────

  it('EN : le catch produit des composants anglais sans clés brutes', async () => {
    await withTempDb(async (db, stmts) => {
      const guildId = 'guild-catch-en-001';
      const channelId = 'chan-catch-001';
      const uid = 'user-catch-en-001';

      const guild = buildAuthorizedGuild(guildId, channelId, stmts);
      const { interaction, getCapture } = buildChanAnnInteraction(uid, channelId);
      const collector = { stop: () => {} };
      const T = createTranslator('en');

      // Forcer le catch : upsertGuildChannel.run() lève une erreur simulée
      const origUpsert = stmts.upsertGuildChannel;
      stmts.upsertGuildChannel = { run: () => { throw new Error('Simulated DB error (catch test EN)'); } };

      try {
        await handleComponent(interaction, guild, guildId, { db, stmts }, uid, collector, T);
      } finally {
        stmts.upsertGuildChannel = origUpsert;
      }

      const payload = getCapture();
      assert.ok(payload, 'i.editReply doit être appelé dans le catch');
      assert.ok(Array.isArray(payload.embeds) && payload.embeds.length > 0, 'Au moins un embed dans la réponse d\'erreur EN');
      assert.ok(Array.isArray(payload.components) && payload.components.length > 0, 'Au moins un composant dans la réponse d\'erreur EN');

      // Aucune clé i18n brute dans les composants
      assertNoRawI18nKeys(payload.components, 'en');

      const texts = extractVisibleTexts(payload.components);

      // Le bouton Back doit être en anglais
      const hasBack = texts.some((t) => t.includes('Back'));
      assert.ok(hasBack, `Bouton "Back" attendu en EN, textes trouvés : ${texts.join(' | ')}`);

      // "Retour" ne doit pas apparaître
      const noRetour = !texts.some((t) => t.toLowerCase() === 'retour' || t.includes('← retour'));
      assert.ok(noRetour, `"Retour" ne doit pas apparaître dans les labels EN, textes : ${texts.join(' | ')}`);

      // Les placeholders ne doivent pas être des clés brutes
      const noBrokenPlaceholder = !texts.some((t) => UNRESOLVED_KEY_PATTERN.test(t));
      assert.ok(noBrokenPlaceholder, `Un placeholder ressemble à une clé brute : ${texts.join(' | ')}`);

      // Le titre de l'embed d'erreur doit exister et ne pas être une clé brute
      const embedData = payload.embeds[0].data ?? payload.embeds[0].toJSON?.() ?? {};
      const embedTitle = embedData.title ?? '';
      assert.ok(embedTitle.length > 0, 'L\'embed d\'erreur doit avoir un titre');
      assert.ok(!UNRESOLVED_KEY_PATTERN.test(embedTitle), `Titre embed EN ressemble à une clé : "${embedTitle}"`);

      // Vérifier que le genericError est en anglais (pas une clé)
      const embedDesc = embedData.description ?? '';
      assert.ok(!UNRESOLVED_KEY_PATTERN.test(embedDesc), `Description embed EN ressemble à une clé : "${embedDesc}"`);
    });
  });

  // ── FR ──────────────────────────────────────────────────────────────────

  it('FR : le catch produit des composants français sans clés brutes (non-régression)', async () => {
    await withTempDb(async (db, stmts) => {
      const guildId = 'guild-catch-fr-002';
      const channelId = 'chan-catch-002';
      const uid = 'user-catch-fr-002';

      const guild = buildAuthorizedGuild(guildId, channelId, stmts);
      const { interaction, getCapture } = buildChanAnnInteraction(uid, channelId);
      const collector = { stop: () => {} };
      const T = createTranslator('fr');

      const origUpsert = stmts.upsertGuildChannel;
      stmts.upsertGuildChannel = { run: () => { throw new Error('Simulated DB error (catch test FR)'); } };

      try {
        await handleComponent(interaction, guild, guildId, { db, stmts }, uid, collector, T);
      } finally {
        stmts.upsertGuildChannel = origUpsert;
      }

      const payload = getCapture();
      assert.ok(payload, 'i.editReply doit être appelé dans le catch FR');
      assert.ok(Array.isArray(payload.components) && payload.components.length > 0, 'Composants présents en FR');

      assertNoRawI18nKeys(payload.components, 'fr');

      const texts = extractVisibleTexts(payload.components);

      // Le bouton Retour doit être en français
      const hasRetour = texts.some((t) => t.includes('Retour'));
      assert.ok(hasRetour, `Bouton "Retour" attendu en FR, textes : ${texts.join(' | ')}`);

      // "Back" ne doit pas apparaître (cas d'un oubli de locale)
      const noBack = !texts.some((t) => t === '← Back');
      assert.ok(noBack, `"← Back" ne doit pas apparaître dans les labels FR, textes : ${texts.join(' | ')}`);
    });
  });

  // ── Vérification croisée EN vs FR : textes différents, clés absentes ───

  it('EN vs FR : les composants du catch diffèrent selon la locale', async () => {
    // On construit les deux ensembles de composants et on vérifie qu'ils sont distincts
    let textsEN = [];
    let textsFR = [];

    await withTempDb(async (db, stmts) => {
      const guildId = 'guild-compare-en';
      const channelId = 'chan-compare';
      const uid = 'user-compare-en';
      const guild = buildAuthorizedGuild(guildId, channelId, stmts);
      const { interaction, getCapture } = buildChanAnnInteraction(uid, channelId);
      const collector = { stop: () => {} };
      const T = createTranslator('en');

      const origUpsert = stmts.upsertGuildChannel;
      stmts.upsertGuildChannel = { run: () => { throw new Error('test'); } };
      try {
        await handleComponent(interaction, guild, guildId, { db, stmts }, uid, collector, T);
      } finally {
        stmts.upsertGuildChannel = origUpsert;
      }
      textsEN = extractVisibleTexts(getCapture().components);
    });

    await withTempDb(async (db, stmts) => {
      const guildId = 'guild-compare-fr';
      const channelId = 'chan-compare';
      const uid = 'user-compare-fr';
      const guild = buildAuthorizedGuild(guildId, channelId, stmts);
      const { interaction, getCapture } = buildChanAnnInteraction(uid, channelId);
      const collector = { stop: () => {} };
      const T = createTranslator('fr');

      const origUpsert = stmts.upsertGuildChannel;
      stmts.upsertGuildChannel = { run: () => { throw new Error('test'); } };
      try {
        await handleComponent(interaction, guild, guildId, { db, stmts }, uid, collector, T);
      } finally {
        stmts.upsertGuildChannel = origUpsert;
      }
      textsFR = extractVisibleTexts(getCapture().components);
    });

    // Les deux ensembles doivent être non vides
    assert.ok(textsEN.length > 0, 'Aucun texte EN extrait');
    assert.ok(textsFR.length > 0, 'Aucun texte FR extrait');

    // Ils doivent différer (Back vs Retour)
    assert.notDeepEqual(textsEN, textsFR, 'Les textes EN et FR doivent être différents');

    // Aucune clé brute dans l'un ou l'autre
    for (const text of textsEN) {
      assert.ok(!UNRESOLVED_KEY_PATTERN.test(text), `EN : clé brute "${text}"`);
    }
    for (const text of textsFR) {
      assert.ok(!UNRESOLVED_KEY_PATTERN.test(text), `FR : clé brute "${text}"`);
    }
  });

  // ── Régression identité T ────────────────────────────────────────────

  it('buildSalonsComponents avec T = identité produit des clés brutes (démontre le bug original)', async () => {
    // Ce test documente que le bug AURAIT produit des clés brutes.
    // Il sert de filet de sécurité pour détecter un futur oubli du T.
    await withTempDb(async (db, stmts) => {
      const guildId = 'guild-identity-003';
      const channelId = 'chan-identity-003';
      const uid = 'user-identity-003';
      const guild = buildAuthorizedGuild(guildId, channelId, stmts);
      const { interaction, getCapture } = buildChanAnnInteraction(uid, channelId);
      const collector = { stop: () => {} };

      // T identité = comportement du bug (T non transmis → T = (k) => k)
      const T_broken = (k) => k;

      const origUpsert = stmts.upsertGuildChannel;
      stmts.upsertGuildChannel = { run: () => { throw new Error('test identity'); } };
      try {
        await handleComponent(interaction, guild, guildId, { db, stmts }, uid, collector, T_broken);
      } finally {
        stmts.upsertGuildChannel = origUpsert;
      }

      const payload = getCapture();
      assert.ok(payload, 'editReply doit être appelé même avec T brisé');

      // Avec T brisé, les textes DOIVENT être des clés brutes
      const texts = extractVisibleTexts(payload.components);
      const brokenCount = texts.filter((t) => UNRESOLVED_KEY_PATTERN.test(t)).length;
      assert.ok(
        brokenCount > 0,
        `Avec T = identité, au moins un texte devrait être une clé brute — textes : ${texts.join(' | ')}`,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Test de parité horaire : même ISO → même heure Paris, locale change seulement le suffixe
// ---------------------------------------------------------------------------

describe('scrimConfigurer — CET/CEST : heure de Paris identique en FR et EN', () => {
  // formatParisDisplayFromUtcIso retourne { dateStr, timeStr } | null

  it('date hivernale : heure identique en FR et EN, suffixe (CET)', () => {
    const winterIso = '2026-01-20T19:30:00.000Z'; // Paris = 20:30 CET

    const enResult = formatParisDisplayFromUtcIso(winterIso, 'en');
    const frResult = formatParisDisplayFromUtcIso(winterIso, 'fr');

    assert.ok(enResult !== null, `EN hiver : formatParisDisplayFromUtcIso ne doit pas retourner null`);
    assert.ok(frResult !== null, `FR hiver : formatParisDisplayFromUtcIso ne doit pas retourner null`);

    // EN : timeStr = "20:30 (CET)"
    assert.ok(enResult.timeStr.includes('20:30'), `EN hiver : heure "20:30" attendue, obtenu "${enResult.timeStr}"`);
    assert.ok(enResult.timeStr.includes('CET'), `EN hiver : suffixe CET attendu, obtenu "${enResult.timeStr}"`);

    // FR : timeStr = "20h30 (CET)"
    assert.ok(frResult.timeStr.includes('20'), `FR hiver : heure "20" attendue, obtenu "${frResult.timeStr}"`);
    assert.ok(frResult.timeStr.includes('CET'), `FR hiver : suffixe CET attendu, obtenu "${frResult.timeStr}"`);

    // Aucun des deux ne doit contenir "heure française"
    assert.ok(!enResult.timeStr.includes('heure française'), `EN : "heure française" ne doit pas apparaître dans "${enResult.timeStr}"`);
    assert.ok(!frResult.timeStr.includes('heure française'), `FR : "heure française" ne doit pas apparaître dans "${frResult.timeStr}"`);

    // Les dateStr doivent être identiques (même date)
    assert.equal(enResult.dateStr, frResult.dateStr, `dateStr doit être identique en EN et FR`);
  });

  it('date estivale : heure identique en FR et EN, suffixe (CEST)', () => {
    const summerIso = '2026-07-27T19:00:00.000Z'; // Paris = 21:00 CEST

    const enResult = formatParisDisplayFromUtcIso(summerIso, 'en');
    const frResult = formatParisDisplayFromUtcIso(summerIso, 'fr');

    assert.ok(enResult !== null, `EN été : ne doit pas retourner null`);
    assert.ok(frResult !== null, `FR été : ne doit pas retourner null`);

    assert.ok(enResult.timeStr.includes('21:00'), `EN été : "21:00" attendu, obtenu "${enResult.timeStr}"`);
    assert.ok(enResult.timeStr.includes('CEST'), `EN été : suffixe CEST attendu, obtenu "${enResult.timeStr}"`);

    assert.ok(frResult.timeStr.includes('21'), `FR été : "21" attendu, obtenu "${frResult.timeStr}"`);
    assert.ok(frResult.timeStr.includes('CEST'), `FR été : suffixe CEST attendu, obtenu "${frResult.timeStr}"`);
  });

  it('seule la locale change le format, pas l\'heure Paris (aucun décalage)', () => {
    const iso = '2026-07-27T19:00:00.000Z'; // Paris = 21:00

    const enResult = formatParisDisplayFromUtcIso(iso, 'en');
    const frResult = formatParisDisplayFromUtcIso(iso, 'fr');

    assert.ok(enResult !== null && frResult !== null, 'Les deux résultats doivent être non nuls');

    // EN : "21:00 (CEST)", FR : "21h00 (CEST)" — même heure, formats différents
    assert.ok(enResult.timeStr.includes('21'), `EN : l'heure doit contenir 21, obtenu "${enResult.timeStr}"`);
    assert.ok(frResult.timeStr.includes('21'), `FR : l'heure doit contenir 21, obtenu "${frResult.timeStr}"`);

    // Extraire l'heure numérique de chaque chaîne
    const enHour = enResult.timeStr.match(/(\d{2})[:h](\d{2})/)?.[1];
    const frHour = frResult.timeStr.match(/(\d{2})[:h](\d{2})/)?.[1];
    assert.equal(enHour, frHour, `L'heure Paris doit être identique en EN (${enHour}) et FR (${frHour})`);

    // Les deux doivent partager le même suffixe fuseau
    assert.ok(enResult.timeStr.includes('CEST'), `EN : CEST attendu dans "${enResult.timeStr}"`);
    assert.ok(frResult.timeStr.includes('CEST'), `FR : CEST attendu dans "${frResult.timeStr}"`);
  });
});
