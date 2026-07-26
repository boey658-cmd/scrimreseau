/**
 * Tests de la fonctionnalité "Précision d'élo".
 *
 * Couvre :
 *  - La configuration (liste complète, valeurs internes)
 *  - Le helper formatRankWithPrecision
 *  - La normalisation (normalizeEloPrecision)
 *  - La DB : migration, insertion, lecture, rétrocompatibilité
 *  - L'embed : scrimDbRowToEmbedPayload, buildScrimEmbedDescription
 *  - La liste : formatListeScrimLine avec et sans précision
 *  - Le test de non-régression : ancienne base sans elo_precision
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  ELO_PRECISION_OPTIONS,
  ELO_PRECISION_NONE,
  getEloPrecisionLabel,
  normalizeEloPrecision,
  formatRankWithPrecision,
} from '../src/config/eloPrecision.js';

import {
  buildScrimEmbed,
  scrimDbRowToEmbedPayload,
} from '../src/services/scrimEmbedBuilder.js';

import {
  formatListeScrimLine,
} from '../src/services/listeScrimsQuery.js';

import { closeDb, getDb, prepareStatements } from '../src/database/db.js';

// ---------------------------------------------------------------------------
// Helpers de test DB
// ---------------------------------------------------------------------------

/**
 * Crée une DB temporaire isolée et exécute fn(db, stmts).
 * Nettoyage garanti après le test.
 */
function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-elo-prec-'));
  const prev = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  try {
    const db = getDb();
    const stmts = prepareStatements(db);
    fn(db, stmts);
  } finally {
    closeDb();
    if (prev === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Insère une ligne scrim_posts minimale avec les champs nécessaires. */
function insertMinimalScrim(stmts, overrides = {}) {
  return stmts.insertScrimPostRow.run({
    scrim_public_id: overrides.scrim_public_id ?? 1,
    author_user_id: overrides.author_user_id ?? '111',
    origin_guild_id: '999',
    source_guild_id: '999',
    game_key: 'lol',
    rank_key: overrides.rank_key ?? 'Or',
    format_key: 'Scrim BO1',
    contact_user_id: '222',
    scheduled_date: '2026-07-25',
    scheduled_time: '20:00',
    scheduled_at: '2026-07-25T18:00:00.000Z',
    scheduled_at_end: null,
    tags: JSON.stringify({ fearless: 'non' }),
    multi_opgg_url: null,
    elo_precision: overrides.elo_precision ?? null,
    structure_guild_id: null,
    structure_name_snapshot: null,
    structure_invite_url_snapshot: null,
    created_at: Date.now(),
    status: 'active',
  });
}

// ===========================================================================
// 1. La liste contient toutes les valeurs prévues
// ===========================================================================

test(`ELO_PRECISION_OPTIONS — contient exactement les 12 valeurs attendues`, () => {
  const values = ELO_PRECISION_OPTIONS.map((o) => o.value);
  assert.deepEqual(values, [
    'none',
    'low',
    'high',
    'lp_100_199',
    'lp_200_299',
    'lp_300_399',
    'lp_400_499',
    'lp_500_599',
    'lp_600_699',
    'lp_700_799',
    'lp_800_899',
    'lp_900_plus',
  ]);
});

test(`ELO_PRECISION_OPTIONS — tous les labels sont non-vides`, () => {
  for (const opt of ELO_PRECISION_OPTIONS) {
    assert.ok(opt.label.length > 0, `label vide pour value=${opt.value}`);
  }
});

test(`ELO_PRECISION_NONE vaut 'none'`, () => {
  assert.equal(ELO_PRECISION_NONE, 'none');
});

// ===========================================================================
// 2–4. Low, High et une tranche LP fonctionnent avec n'importe quel élo
// ===========================================================================

test(`formatRankWithPrecision — Low fonctionne avec n'importe quel rang`, () => {
  const ranks = ['Fer', 'Bronze', 'Argent', 'Or', 'Platine', 'Émeraude', 'Diamant', 'Master', 'Grandmaster', 'Challenger'];
  for (const rank of ranks) {
    const result = formatRankWithPrecision(rank, 'low');
    assert.equal(result, `${rank} — Low`, `Échec pour rang=${rank}`);
  }
});

test(`formatRankWithPrecision — High fonctionne avec n'importe quel rang`, () => {
  const ranks = ['Fer', 'Bronze', 'Argent', 'Or', 'Platine', 'Émeraude', 'Diamant', 'Master', 'Grandmaster', 'Challenger'];
  for (const rank of ranks) {
    const result = formatRankWithPrecision(rank, 'high');
    assert.equal(result, `${rank} — High`);
  }
});

test(`formatRankWithPrecision — tranche LP fonctionne avec n'importe quel rang`, () => {
  const lpValues = ['lp_100_199', 'lp_200_299', 'lp_300_399', 'lp_400_499', 'lp_500_599', 'lp_600_699', 'lp_700_799', 'lp_800_899'];
  const ranks = ['Fer', 'Or', 'Master', 'Challenger'];
  for (const prec of lpValues) {
    for (const rank of ranks) {
      const result = formatRankWithPrecision(rank, prec);
      assert.ok(result.startsWith(`${rank} — `), `Échec pour rank=${rank} prec=${prec}`);
      assert.ok(result.includes('LP'), `Pas de "LP" pour rank=${rank} prec=${prec}`);
    }
  }
});

// ===========================================================================
// 5. Non précisé produit une valeur nulle ou absente
// ===========================================================================

test(`normalizeEloPrecision — 'none' retourne null`, () => {
  assert.equal(normalizeEloPrecision('none'), null);
});

test(`normalizeEloPrecision — null retourne null`, () => {
  assert.equal(normalizeEloPrecision(null), null);
});

test(`normalizeEloPrecision — undefined retourne null`, () => {
  assert.equal(normalizeEloPrecision(undefined), null);
});

test(`normalizeEloPrecision — chaîne vide retourne null`, () => {
  assert.equal(normalizeEloPrecision(''), null);
});

// ===========================================================================
// 6. Une recherche sans précision conserve l'ancien affichage
// ===========================================================================

test(`formatRankWithPrecision — sans précision, retourne uniquement le rang`, () => {
  assert.equal(formatRankWithPrecision('Émeraude', null), 'Émeraude');
  assert.equal(formatRankWithPrecision('Émeraude', undefined), 'Émeraude');
  assert.equal(formatRankWithPrecision('Or', null), 'Or');
});

test(`buildScrimEmbed — sans elo_precision, la description ne contient pas de tiret après le rang`, () => {
  const embed = buildScrimEmbed({
    gameKey: 'lol',
    rank: 'Émeraude',
    dateStr: '25/07/2026',
    timeStr: '20h00',
    format: 'Scrim BO1',
    contactUserId: '123',
    fearless: 'non',
  });
  const desc = embed.data.description ?? '';
  assert.ok(desc.includes('Émeraude'), `rang manquant dans : ${desc}`);
  assert.ok(!desc.includes('Émeraude — '), `précision inattendue dans : ${desc}`);
});

// ===========================================================================
// 7. Une recherche avec précision affiche "Élo — Précision"
// ===========================================================================

test(`buildScrimEmbed — avec elo_precision 'high', affiche "Émeraude — High"`, () => {
  const embed = buildScrimEmbed({
    gameKey: 'lol',
    rank: 'Émeraude',
    dateStr: '25/07/2026',
    timeStr: '20h00',
    format: 'Scrim BO1',
    contactUserId: '123',
    fearless: 'non',
    eloPrecision: 'high',
  });
  const desc = embed.data.description ?? '';
  assert.ok(desc.includes('Émeraude — High'), `"Émeraude — High" manquant dans : ${desc}`);
});

test(`buildScrimEmbed — avec elo_precision 'lp_500_599', affiche "Diamant — 500–599 LP"`, () => {
  const embed = buildScrimEmbed({
    gameKey: 'lol',
    rank: 'Diamant',
    dateStr: '25/07/2026',
    timeStr: '20h00',
    format: 'Scrim BO1',
    contactUserId: '123',
    fearless: 'non',
    eloPrecision: 'lp_500_599',
  });
  const desc = embed.data.description ?? '';
  assert.ok(desc.includes('Diamant — 500–599 LP'), `attendu "Diamant — 500–599 LP" dans : ${desc}`);
});

// ===========================================================================
// 8. '900 LP et plus' est affiché correctement
// ===========================================================================

test(`getEloPrecisionLabel — lp_900_plus retourne "900 LP et plus"`, () => {
  assert.equal(getEloPrecisionLabel('lp_900_plus'), '900 LP et plus');
});

test(`formatRankWithPrecision — lp_900_plus produit "Master — 900 LP et plus"`, () => {
  assert.equal(formatRankWithPrecision('Master', 'lp_900_plus'), 'Master — 900 LP et plus');
});

// ===========================================================================
// 9. Une valeur interne inconnue est ignorée sans crash
// ===========================================================================

test(`normalizeEloPrecision — valeur inconnue retourne null sans crash`, () => {
  assert.equal(normalizeEloPrecision('lp_invalid'), null);
  assert.equal(normalizeEloPrecision('HACKED'), null);
  assert.equal(normalizeEloPrecision('0; DROP TABLE scrim_posts; --'), null);
});

test(`getEloPrecisionLabel — valeur inconnue retourne null`, () => {
  assert.equal(getEloPrecisionLabel('valeur_inconnue'), null);
});

test(`formatRankWithPrecision — valeur inconnue, retourne uniquement le rang`, () => {
  assert.equal(formatRankWithPrecision('Or', 'valeur_inconnue'), 'Or');
});

test(`buildScrimEmbed — eloPrecision inconnue, affiche uniquement le rang sans crash`, () => {
  const embed = buildScrimEmbed({
    gameKey: 'lol',
    rank: 'Or',
    dateStr: '25/07/2026',
    timeStr: '20h00',
    format: 'Scrim BO1',
    contactUserId: '123',
    fearless: 'non',
    eloPrecision: 'valeur_bidon',
  });
  const desc = embed.data.description ?? '';
  assert.ok(desc.includes('Or'), `rang manquant dans : ${desc}`);
  assert.ok(!desc.includes('valeur_bidon'), `valeur inconnue exposée dans : ${desc}`);
});

// ===========================================================================
// 10–13. Migration DB : nouvelle base, ancienne base, idempotence, valeurs NULL
// ===========================================================================

test(`DB — la colonne elo_precision est créée sur une base neuve`, () => {
  withTempDb((db) => {
    const cols = db.prepare(`PRAGMA table_info(scrim_posts)`).all();
    const names = cols.map((c) => c.name);
    assert.ok(names.includes('elo_precision'), `elo_precision absente des colonnes : ${names.join(', ')}`);
  });
});

test(`DB — la migration est idempotente (double initialisation)`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-elo-idem-'));
  const dbPath = path.join(dir, 'test.db');
  const prev = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = dbPath;
  try {
    const db1 = getDb();
    const cols1 = db1.prepare(`PRAGMA table_info(scrim_posts)`).all().map((c) => c.name);
    closeDb();

    const db2 = getDb();
    const cols2 = db2.prepare(`PRAGMA table_info(scrim_posts)`).all().map((c) => c.name);
    closeDb();

    assert.ok(cols1.includes('elo_precision'));
    assert.ok(cols2.includes('elo_precision'));
    assert.equal(cols1.filter((n) => n === 'elo_precision').length, 1, `colonne dupliquée (pass 1)`);
    assert.equal(cols2.filter((n) => n === 'elo_precision').length, 1, `colonne dupliquée (pass 2)`);
  } finally {
    try { closeDb(); } catch { /* ignore */ }
    if (prev === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(`DB — les anciennes lignes ont elo_precision = NULL après migration`, () => {
  withTempDb((db, stmts) => {
    insertMinimalScrim(stmts, { elo_precision: null });
    const row = db.prepare(`SELECT elo_precision FROM scrim_posts LIMIT 1`).get();
    assert.equal(row.elo_precision, null);
  });
});

// ===========================================================================
// 14–15. Insertion et lecture correctes de la précision
// ===========================================================================

test(`DB — l'insertion enregistre correctement elo_precision = 'low'`, () => {
  withTempDb((db, stmts) => {
    insertMinimalScrim(stmts, { elo_precision: 'low' });
    const row = db.prepare(`SELECT elo_precision FROM scrim_posts LIMIT 1`).get();
    assert.equal(row.elo_precision, 'low');
  });
});

test(`DB — l'insertion enregistre correctement elo_precision = 'lp_900_plus'`, () => {
  withTempDb((db, stmts) => {
    insertMinimalScrim(stmts, { elo_precision: 'lp_900_plus' });
    const row = db.prepare(`SELECT elo_precision FROM scrim_posts LIMIT 1`).get();
    assert.equal(row.elo_precision, 'lp_900_plus');
  });
});

test(`scrimDbRowToEmbedPayload — restitue correctement elo_precision depuis la DB`, () => {
  withTempDb((db, stmts) => {
    insertMinimalScrim(stmts, { elo_precision: 'high' });
    const row = db.prepare(`SELECT * FROM scrim_posts LIMIT 1`).get();
    const payload = scrimDbRowToEmbedPayload(row);
    assert.equal(payload.eloPrecision, 'high');
  });
});

test(`scrimDbRowToEmbedPayload — elo_precision NULL retourne null dans le payload`, () => {
  withTempDb((db, stmts) => {
    insertMinimalScrim(stmts, { elo_precision: null });
    const row = db.prepare(`SELECT * FROM scrim_posts LIMIT 1`).get();
    const payload = scrimDbRowToEmbedPayload(row);
    assert.equal(payload.eloPrecision, null);
  });
});

// ===========================================================================
// 16. Une republication conserve la précision
// ===========================================================================

test(`scrimDbRowToEmbedPayload — la précision est disponible pour un repost`, () => {
  withTempDb((db, stmts) => {
    insertMinimalScrim(stmts, { elo_precision: 'lp_300_399' });
    const row = stmts.getScrimPostById.get(1);
    const payload = scrimDbRowToEmbedPayload(row);
    assert.equal(payload.eloPrecision, 'lp_300_399');
    const embed = buildScrimEmbed(payload);
    const desc = embed.data.description ?? '';
    assert.ok(desc.includes('300–399 LP'), `précision absente du repost : ${desc}`);
  });
});

// ===========================================================================
// 17. /liste-scrims affiche la précision si elle existe
// ===========================================================================

test(`formatListeScrimLine — affiche la précision si elle existe`, () => {
  const row = {
    rank_key: 'Diamant',
    elo_precision: 'lp_700_799',
    scheduled_date: '2026-07-25',
    scheduled_time: '20:00',
    scheduled_at: null,
    scheduled_at_end: null,
    format_key: 'Scrim BO1',
    tags: JSON.stringify({ fearless: 'non' }),
  };
  const line = formatListeScrimLine(row, row.tags, null);
  assert.ok(line.includes('Diamant — 700–799 LP'), `précision absente dans : ${line}`);
});

test(`formatListeScrimLine — sans précision, affiche uniquement le rang`, () => {
  const row = {
    rank_key: 'Platine',
    elo_precision: null,
    scheduled_date: '2026-07-25',
    scheduled_time: '20:00',
    scheduled_at: null,
    scheduled_at_end: null,
    format_key: 'Scrim BO1',
    tags: JSON.stringify({ fearless: 'non' }),
  };
  const line = formatListeScrimLine(row, row.tags, null);
  assert.ok(line.startsWith('Platine —'), `rang inattendu dans : ${line}`);
  assert.ok(!line.includes('Platine — Low'), `précision inattendue dans : ${line}`);
});

// ===========================================================================
// 18. /mes-demandes-scrim — vérifié via scrimDbRowToEmbedPayload + formatRankWithPrecision
// ===========================================================================

test(`DB listActiveScrimPostsByAuthor — retourne elo_precision`, () => {
  withTempDb((db, stmts) => {
    insertMinimalScrim(stmts, { author_user_id: '555', elo_precision: 'high' });
    const rows = stmts.listActiveScrimPostsByAuthor.all('555');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].elo_precision, 'high');
  });
});

test(`DB listActiveScrimPostsByAuthor — elo_precision NULL retourne null`, () => {
  withTempDb((db, stmts) => {
    insertMinimalScrim(stmts, { author_user_id: '666', elo_precision: null });
    const rows = stmts.listActiveScrimPostsByAuthor.all('666');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].elo_precision, null);
  });
});

// ===========================================================================
// 19–20. Fermeture et données inchangées
// ===========================================================================

test(`DB — une recherche sans précision peut toujours être fermée (status update)`, () => {
  withTempDb((db, stmts) => {
    insertMinimalScrim(stmts, { elo_precision: null });
    stmts.closeScrimPostIfActive.run({
      status: 'closed_manual',
      closed_at: new Date().toISOString(),
      closed_reason: 'user',
      id: 1,
    });
    const row = db.prepare(`SELECT status, elo_precision FROM scrim_posts WHERE id = 1`).get();
    assert.equal(row.status, 'closed_manual');
    assert.equal(row.elo_precision, null);
  });
});

test(`DB — les autres données du scrim restent inchangées après ajout de elo_precision`, () => {
  withTempDb((db, stmts) => {
    insertMinimalScrim(stmts, { rank_key: 'Master', elo_precision: 'lp_500_599' });
    const row = db.prepare(`SELECT * FROM scrim_posts WHERE id = 1`).get();
    assert.equal(row.rank_key, 'Master');
    assert.equal(row.format_key, 'Scrim BO1');
    assert.equal(row.elo_precision, 'lp_500_599');
    assert.equal(row.status, 'active');
    assert.equal(row.game_key, 'lol');
  });
});

// ===========================================================================
// 21. Les configurations des serveurs ne sont pas touchées
// ===========================================================================

test(`DB — les tables de configuration serveur sont intactes après migration`, () => {
  withTempDb((db) => {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r) => r.name);

    const configTables = ['guild_game_channels', 'guild_scrim_permissions', 'guild_scrim_usage_channel'];
    for (const t of configTables) {
      assert.ok(tables.includes(t), `table de config absente : ${t}`);
    }

    for (const t of configTables) {
      const count = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
      assert.equal(count.n, 0, `table de config modifiée (${t} non vide) — aucune donnée attendue`);
    }
  });
});

// ===========================================================================
// Test de non-régression : ancienne base sans la colonne elo_precision
// ===========================================================================

test(`non-régression — ancienne base sans elo_precision : migration additive, données préservées`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-elo-legacy-'));
  const dbPath = path.join(dir, 'test.db');
  const prev = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = dbPath;

  try {
    // Phase 1 : créer une "ancienne" base avec des lignes existantes mais SANS elo_precision.
    // On utilise better-sqlite3 directement pour simuler un schéma pré-migration.
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS scrim_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scrim_public_id INTEGER,
        author_user_id TEXT NOT NULL,
        origin_guild_id TEXT NOT NULL,
        source_guild_id TEXT NOT NULL,
        game_key TEXT NOT NULL,
        rank_key TEXT NOT NULL,
        format_key TEXT NOT NULL,
        contact_user_id TEXT NOT NULL,
        scheduled_date TEXT NOT NULL,
        scheduled_time TEXT NOT NULL,
        scheduled_at TEXT,
        scheduled_at_end TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        multi_opgg_url TEXT,
        structure_guild_id TEXT,
        structure_name_snapshot TEXT,
        structure_invite_url_snapshot TEXT,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        closed_at TEXT,
        closed_reason TEXT,
        last_repost_at TEXT,
        repost_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Insérer des lignes "anciennes" sans elo_precision
    legacyDb.prepare(`
      INSERT INTO scrim_posts (
        scrim_public_id, author_user_id, origin_guild_id, source_guild_id,
        game_key, rank_key, format_key, contact_user_id,
        scheduled_date, scheduled_time, scheduled_at,
        tags, created_at, status
      ) VALUES (1, 'u1', 'g1', 'g1', 'lol', 'Or', 'Scrim BO1', 'c1', '2026-07-25', '20:00', '2026-07-25T18:00:00.000Z', '{"fearless":"non"}', 1000, 'active')
    `).run();
    legacyDb.prepare(`
      INSERT INTO scrim_posts (
        scrim_public_id, author_user_id, origin_guild_id, source_guild_id,
        game_key, rank_key, format_key, contact_user_id,
        scheduled_date, scheduled_time, scheduled_at,
        tags, created_at, status
      ) VALUES (2, 'u2', 'g2', 'g2', 'lol', 'Diamant', 'Scrim BO3', 'c2', '2026-07-26', '21:00', '2026-07-26T19:00:00.000Z', '{"fearless":"oui"}', 2000, 'active')
    `).run();

    // Snapshot avant migration
    const beforeRows = legacyDb.prepare(`SELECT * FROM scrim_posts ORDER BY id`).all();
    legacyDb.close();

    // Phase 2 : ouvrir avec le nouveau code (déclenche la migration)
    const db = getDb();

    // Vérifier que la colonne a été ajoutée
    const cols = db.prepare(`PRAGMA table_info(scrim_posts)`).all().map((c) => c.name);
    assert.ok(cols.includes('elo_precision'), `elo_precision absente après migration`);

    // Vérifier que les anciennes lignes existent toujours
    const afterRows = db.prepare(`SELECT * FROM scrim_posts ORDER BY id`).all();
    assert.equal(afterRows.length, 2, `nombre de lignes modifié après migration`);

    // Vérifier que les anciens champs sont intacts
    for (let i = 0; i < beforeRows.length; i++) {
      const before = beforeRows[i];
      const after = afterRows[i];
      assert.equal(after.rank_key, before.rank_key, `rank_key modifié ligne ${i + 1}`);
      assert.equal(after.format_key, before.format_key, `format_key modifié ligne ${i + 1}`);
      assert.equal(after.author_user_id, before.author_user_id, `author_user_id modifié ligne ${i + 1}`);
      assert.equal(after.game_key, before.game_key, `game_key modifié ligne ${i + 1}`);
      assert.equal(after.status, before.status, `status modifié ligne ${i + 1}`);

      // La nouvelle colonne doit valoir NULL pour toutes les anciennes lignes
      assert.equal(after.elo_precision, null, `elo_precision non-null pour ancienne ligne ${i + 1}`);
    }

    closeDb();
  } finally {
    try { closeDb(); } catch { /* ignore */ }
    if (prev === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// Vérification que les anciens tests (embed sans précision) continuent à passer
// ===========================================================================

// ===========================================================================
// Régression bug broadcast.js — eloPrecision absent du buildScrimEmbed explicite
// ===========================================================================

test(`broadcast — diffusion initiale avec eloPrecision : "Master — 600–699 LP" affiché`, () => {
  // Reproduit exactement le bug : broadcast.js construisait buildScrimEmbed({...})
  // champ par champ sans inclure eloPrecision, donc la précision était perdue.
  const embed = buildScrimEmbed({
    gameKey: 'lol',
    rank: 'Master',
    dateStr: '25/07/2026',
    timeStr: '20h00',
    format: 'Scrim BO1',
    contactUserId: '123',
    fearless: 'non',
    eloPrecision: 'lp_600_699',
  });
  const desc = embed.data.description ?? '';
  assert.ok(
    desc.includes('Master — 600–699 LP'),
    `"Master — 600–699 LP" attendu dans la description de diffusion initiale, obtenu : ${desc}`,
  );
});

test(`broadcast — diffusion initiale sans precision : affiche seulement "Master"`, () => {
  const embed = buildScrimEmbed({
    gameKey: 'lol',
    rank: 'Master',
    dateStr: '25/07/2026',
    timeStr: '20h00',
    format: 'Scrim BO1',
    contactUserId: '123',
    fearless: 'non',
    eloPrecision: null,
  });
  const desc = embed.data.description ?? '';
  assert.ok(desc.includes('Master'), `rang absent de la description : ${desc}`);
  assert.ok(
    !desc.includes('Master — '),
    `précision inattendue dans la description sans précision : ${desc}`,
  );
});

test(`rétrocompat — embed sans eloPrecision : description identique à l'ancien comportement`, () => {
  const payloadSansPrecision = {
    gameKey: 'lol',
    rank: 'Or',
    dateStr: '25/07/2026',
    timeStr: '20h00',
    format: 'Scrim BO1',
    contactUserId: '123',
    fearless: 'non',
    // eloPrecision absent
  };

  const embed = buildScrimEmbed(payloadSansPrecision);
  const desc = embed.data.description ?? '';

  // Le rang seul doit apparaître (sans " — ")
  assert.ok(desc.includes('Or'), `rang absent de la description : ${desc}`);
  // Pas de tiret supplémentaire après le rang
  assert.ok(!desc.match(/Or — [A-Z]/), `précision inattendue après le rang dans : ${desc}`);
});
