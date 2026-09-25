/**
 * Phase 0 — non-régression FREE + entitlements stub + multi-salon prep + migrations.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import {
  listAppliedSchemaMigrations,
  runSchemaMigrations,
  SCHEMA_MIGRATIONS,
} from '../src/database/schemaMigrations.js';
import {
  canUseFeature,
  getLimit,
  getPlan,
} from '../src/services/entitlements/index.js';
import {
  applyReceptionChannelLimit,
  listActiveReceptionDestinationsForGame,
  listActiveReceptionChannelsForGuild,
} from '../src/services/receptionChannels.js';
import { resolvePreferredScrimPostMessageLink } from '../src/services/scrimPostMessageLink.js';
import { UI_PRIMARY_GAME_KEY } from '../src/config/games.js';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-phase0-'));
  const prev = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  try {
    closeDb();
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

describe('Phase 0 — entitlement FREE stub', () => {
  it('guild inconnue = FREE', () => {
    assert.equal(getPlan('999888777666555444'), 'FREE');
    assert.equal(getPlan(null), 'FREE');
    assert.equal(getPlan(undefined), 'FREE');
  });

  it('reception_channels limit = 1', () => {
    assert.equal(getLimit('g1', 'reception_channels'), 1);
  });

  it('features Premium = false (fail-closed)', () => {
    assert.equal(canUseFeature('g1', 'multi_reception_channels'), false);
    assert.equal(canUseFeature('g1', 'elo_channel_filters'), false);
    assert.equal(canUseFeature('g1', 'local_embed_customization'), false);
    assert.equal(canUseFeature('g1', 'premium_badge'), false);
    assert.equal(canUseFeature('g1', 'unknown_feature'), false);
  });

  it('limite inconnue = 0', () => {
    assert.equal(getLimit('g1', 'not_a_real_limit'), 0);
  });
});

describe('Phase 0 — schema migrations', () => {
  it('DB vide : migration enregistrée, colonnes multi-salon présentes', async () => {
    await withTempDb(async (db) => {
      const applied = listAppliedSchemaMigrations(db);
      assert.ok(applied.includes('20260923_01_guild_game_channels_multi_salon'));
      const cols = db.prepare(`PRAGMA table_info(guild_game_channels)`).all().map((c) => c.name);
      assert.ok(cols.includes('enabled'));
      assert.ok(cols.includes('sort_order'));
    });
  });

  it('rejouer runSchemaMigrations : idempotent', async () => {
    await withTempDb(async (db) => {
      const before = listAppliedSchemaMigrations(db);
      runSchemaMigrations(db);
      assert.deepEqual(listAppliedSchemaMigrations(db), before);
    });
  });

  it('migration ancienne table sans enabled → conserve les rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-phase0-old-'));
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = path.join(dir, 'old.db');
    try {
      closeDb();
      // Simule ancienne DB : créer table legacy manuellement puis migrer
      const Database = (await import('better-sqlite3')).default;
      const raw = new Database(process.env.SQLITE_PATH);
      raw.exec(`
        CREATE TABLE guild_game_channels (
          guild_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          game_key TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (guild_id, game_key)
        );
      `);
      raw.prepare(
        `INSERT INTO guild_game_channels (guild_id, channel_id, game_key, created_at) VALUES (?, ?, ?, ?)`,
      ).run('111111111111111111', '222222222222222222', 'league_of_legends', 42);
      raw.close();

      // getDb exécute INIT (IF NOT EXISTS → garde ancienne) + migrations versionnées
      const db = getDb();
      const row = db
        .prepare(`SELECT * FROM guild_game_channels WHERE guild_id = ?`)
        .get('111111111111111111');
      assert.ok(row);
      assert.equal(row.channel_id, '222222222222222222');
      assert.equal(row.enabled, 1);
      assert.equal(row.sort_order, 0);
      assert.equal(row.created_at, 42);
      closeDb();
    } finally {
      if (prev === undefined) delete process.env.SQLITE_PATH;
      else process.env.SQLITE_PATH = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migration dirty : NULL created_at préservé + collision multi-game + language/link/scrim', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-phase0-dirty-'));
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = path.join(dir, 'dirty.db');
    try {
      closeDb();
      const Database = (await import('better-sqlite3')).default;
      const raw = new Database(process.env.SQLITE_PATH);
      raw.pragma('journal_mode = WAL');
      raw.exec(`
        CREATE TABLE guild_game_channels (
          guild_id TEXT NOT NULL,
          game_key TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          created_at INTEGER,
          PRIMARY KEY (guild_id, game_key)
        );
        CREATE TABLE guild_languages (
          guild_id TEXT PRIMARY KEY NOT NULL,
          language TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE structure_discord_links (
          guild_id TEXT PRIMARY KEY NOT NULL,
          discord_invite_url TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          updated_by TEXT
        );
        CREATE TABLE scrim_posts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scrim_public_id INTEGER,
          author_user_id TEXT,
          origin_guild_id TEXT,
          source_guild_id TEXT,
          game_key TEXT,
          rank_key TEXT,
          format_key TEXT,
          contact_user_id TEXT,
          contact_display_name TEXT,
          scheduled_date TEXT,
          scheduled_time TEXT,
          tags TEXT,
          created_at INTEGER,
          status TEXT
        );
      `);
      const now = 1_700_000_000_000;
      const ins = raw.prepare(
        `INSERT INTO guild_game_channels (guild_id, game_key, channel_id, created_at) VALUES (?,?,?,?)`,
      );
      // Guild normale
      ins.run('111111111111111111', 'lol', '222222222222222222', now);
      // Collision même channel multi-game (plus ancien = valorant)
      ins.run('111111111111111111', 'valorant', '222222222222222222', now - 5000);
      // created_at NULL — ne doit PAS être perdu
      ins.run('333333333333333333', 'lol', '444444444444444444', null);
      // Autre guild normale
      ins.run('555555555555555555', 'lol', '666666666666666666', now - 86400000);

      raw.prepare(
        `INSERT INTO guild_languages (guild_id, language, updated_at) VALUES (?,?,?)`,
      ).run('111111111111111111', 'fr', now);
      raw.prepare(
        `INSERT INTO structure_discord_links (guild_id, discord_invite_url, updated_at, updated_by) VALUES (?,?,?,?)`,
      ).run('111111111111111111', 'https://discord.gg/audit-sim', now, '777777777777777777');
      raw.prepare(
        `INSERT INTO scrim_posts (
          scrim_public_id, author_user_id, origin_guild_id, source_guild_id,
          game_key, rank_key, format_key, contact_user_id, contact_display_name,
          scheduled_date, scheduled_time, tags, created_at, status
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        42,
        '777777777777777777',
        '111111111111111111',
        '111111111111111111',
        'lol',
        'gold',
        'bo1',
        '777777777777777777',
        'AuditUser',
        '2026-09-25',
        '20:00',
        '[]',
        now,
        'active',
      );
      raw.close();

      const db = getDb();
      const rows = db
        .prepare(`SELECT * FROM guild_game_channels ORDER BY guild_id, channel_id`)
        .all();

      const g1 = rows.filter((r) => r.guild_id === '111111111111111111');
      assert.equal(g1.length, 1, 'collision → une seule row');
      assert.equal(g1[0].channel_id, '222222222222222222');
      assert.equal(g1[0].game_key, 'valorant', 'garde la plus ancienne (created_at plus petit)');

      const nullRow = rows.find((r) => r.guild_id === '333333333333333333');
      assert.ok(nullRow, 'row created_at NULL préservée');
      assert.equal(nullRow.channel_id, '444444444444444444');
      assert.equal(nullRow.created_at, 0, 'fallback COALESCE → 0');
      assert.equal(nullRow.enabled, 1);

      assert.ok(rows.some((r) => r.guild_id === '555555555555555555'));

      assert.equal(
        db.prepare(`SELECT language FROM guild_languages WHERE guild_id=?`).get('111111111111111111')
          ?.language,
        'fr',
      );
      assert.equal(
        db
          .prepare(`SELECT discord_invite_url FROM structure_discord_links WHERE guild_id=?`)
          .get('111111111111111111')?.discord_invite_url,
        'https://discord.gg/audit-sim',
      );
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM scrim_posts WHERE status='active'`).get().n,
        1,
      );

      const applied = listAppliedSchemaMigrations(db);
      assert.equal(
        applied.filter((id) => id === '20260923_01_guild_game_channels_multi_salon').length,
        1,
      );
      const before = [...applied];
      runSchemaMigrations(db);
      assert.deepEqual(listAppliedSchemaMigrations(db), before);
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM guild_game_channels`).get().n,
        rows.length,
      );
      closeDb();
    } finally {
      if (prev === undefined) delete process.env.SQLITE_PATH;
      else process.env.SQLITE_PATH = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SCHEMA_MIGRATIONS a des ids stables uniques', () => {
    const ids = SCHEMA_MIGRATIONS.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('Phase 0 — reception channels FREE=1', () => {
  it('1 row enabled → 1 destination', async () => {
    await withTempDb(async (db, stmts) => {
      const g = '333333333333333333';
      const c = '444444444444444444';
      stmts.upsertGuildChannel.run({
        guild_id: g,
        channel_id: c,
        game_key: UI_PRIMARY_GAME_KEY,
        created_at: Date.now(),
      });
      const dest = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY);
      assert.equal(dest.length, 1);
      assert.deepEqual(dest[0], { guild_id: g, channel_id: c });
    });
  });

  it('3 rows enabled + FREE → 1 seule destination (ordre déterministe)', async () => {
    await withTempDb(async (db, stmts) => {
      const g = '555555555555555555';
      const now = Date.now();
      // Insert direct pour simuler rows multi (UI FREE n'en crée qu'une)
      db.prepare(`
        INSERT INTO guild_game_channels (guild_id, channel_id, game_key, enabled, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?)
      `).run(g, '100000000000000001', UI_PRIMARY_GAME_KEY, 2, now + 2, now);
      db.prepare(`
        INSERT INTO guild_game_channels (guild_id, channel_id, game_key, enabled, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?)
      `).run(g, '100000000000000000', UI_PRIMARY_GAME_KEY, 0, now, now);
      db.prepare(`
        INSERT INTO guild_game_channels (guild_id, channel_id, game_key, enabled, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?)
      `).run(g, '100000000000000002', UI_PRIMARY_GAME_KEY, 1, now + 1, now);

      const dest = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY);
      const forGuild = dest.filter((d) => d.guild_id === g);
      assert.equal(forGuild.length, 1);
      assert.equal(forGuild[0].channel_id, '100000000000000000'); // sort_order 0
    });
  });

  it('row disabled ignorée', async () => {
    await withTempDb(async (db, stmts) => {
      const g = '666666666666666666';
      db.prepare(`
        INSERT INTO guild_game_channels (guild_id, channel_id, game_key, enabled, sort_order, created_at)
        VALUES (?, ?, ?, 0, 0, ?)
      `).run(g, '100000000000000099', UI_PRIMARY_GAME_KEY, Date.now());
      const dest = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY);
      assert.equal(dest.filter((d) => d.guild_id === g).length, 0);
      assert.equal(listActiveReceptionChannelsForGuild(stmts, g, UI_PRIMARY_GAME_KEY).length, 0);
    });
  });

  it('applyReceptionChannelLimit tronque', () => {
    const rows = [
      { guild_id: 'g', channel_id: 'a' },
      { guild_id: 'g', channel_id: 'b' },
    ];
    assert.equal(applyReceptionChannelLimit('g', rows).length, 1);
    assert.equal(applyReceptionChannelLimit('g', rows)[0].channel_id, 'a');
  });
});

describe('Phase 0 — message link multi-salon', () => {
  it('1 message = comportement actuel', async () => {
    await withTempDb(async (db, stmts) => {
      const info = stmts.insertScrimPostRow.run({
        scrim_public_id: 1,
        author_user_id: 'u1',
        origin_guild_id: 'g1',
        source_guild_id: 'g1',
        game_key: UI_PRIMARY_GAME_KEY,
        rank_key: 'Gold',
        format_key: 'BO1',
        contact_user_id: 'u1',
        contact_display_name: null,
        scheduled_date: '01/01/2027',
        scheduled_time: '20:00',
        scheduled_at: new Date(Date.now() + 86400000).toISOString(),
        scheduled_at_end: null,
        tags: '[]',
        multi_opgg_url: null,
        elo_precision: null,
        structure_guild_id: null,
        structure_name_snapshot: null,
        structure_invite_url_snapshot: null,
        created_at: Date.now(),
        status: 'active',
      });
      const postId = Number(info.lastInsertRowid);
      stmts.insertScrimPostMessage.run({
        scrim_post_db_id: postId,
        guild_id: 'g1',
        channel_id: 'c1',
        message_id: 'm1',
      });
      const link = resolvePreferredScrimPostMessageLink(stmts, postId, 'g1');
      assert.deepEqual(link, { channel_id: 'c1', message_id: 'm1' });
    });
  });

  it('plusieurs messages même guild = aucun crash, préfère salon actif', async () => {
    await withTempDb(async (db, stmts) => {
      const g = '777777777777777777';
      stmts.upsertGuildChannel.run({
        guild_id: g,
        channel_id: 'c-active',
        game_key: UI_PRIMARY_GAME_KEY,
        created_at: Date.now(),
      });
      const info = stmts.insertScrimPostRow.run({
        scrim_public_id: 2,
        author_user_id: 'u1',
        origin_guild_id: g,
        source_guild_id: g,
        game_key: UI_PRIMARY_GAME_KEY,
        rank_key: 'Gold',
        format_key: 'BO1',
        contact_user_id: 'u1',
        contact_display_name: null,
        scheduled_date: '01/01/2027',
        scheduled_time: '20:00',
        scheduled_at: new Date(Date.now() + 86400000).toISOString(),
        scheduled_at_end: null,
        tags: '[]',
        multi_opgg_url: null,
        elo_precision: null,
        structure_guild_id: null,
        structure_name_snapshot: null,
        structure_invite_url_snapshot: null,
        created_at: Date.now(),
        status: 'active',
      });
      const postId = Number(info.lastInsertRowid);
      stmts.insertScrimPostMessage.run({
        scrim_post_db_id: postId,
        guild_id: g,
        channel_id: 'c-old',
        message_id: 'm-old',
      });
      stmts.insertScrimPostMessage.run({
        scrim_post_db_id: postId,
        guild_id: g,
        channel_id: 'c-active',
        message_id: 'm-active',
      });
      const link = resolvePreferredScrimPostMessageLink(stmts, postId, g);
      assert.equal(link?.channel_id, 'c-active');
      assert.equal(link?.message_id, 'm-active');
      const all = stmts.listScrimPostMessagesByPostId.all(postId);
      assert.equal(all.length, 2);
    });
  });
});

describe('Phase 0 — FREE write remplace les salons du jeu', () => {
  it('upsert FREE via deleteGuildChannelsByGuildGame → une seule row', async () => {
    await withTempDb(async (db, stmts) => {
      const g = '888888888888888888';
      db.prepare(`
        INSERT INTO guild_game_channels (guild_id, channel_id, game_key, enabled, sort_order, created_at)
        VALUES (?, '100000000000000010', ?, 1, 0, ?)
      `).run(g, UI_PRIMARY_GAME_KEY, Date.now());
      db.prepare(`
        INSERT INTO guild_game_channels (guild_id, channel_id, game_key, enabled, sort_order, created_at)
        VALUES (?, '100000000000000011', ?, 1, 1, ?)
      `).run(g, UI_PRIMARY_GAME_KEY, Date.now());

      const replace = db.transaction(() => {
        stmts.deleteGuildChannelsByGuildGame.run(g, UI_PRIMARY_GAME_KEY);
        stmts.upsertGuildChannel.run({
          guild_id: g,
          channel_id: '100000000000000012',
          game_key: UI_PRIMARY_GAME_KEY,
          created_at: Date.now(),
        });
      });
      replace();

      const rows = db
        .prepare(`SELECT channel_id FROM guild_game_channels WHERE guild_id = ?`)
        .all(g);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].channel_id, '100000000000000012');
    });
  });
});
