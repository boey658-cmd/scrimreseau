import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import test from 'node:test';
import {
  closeDb,
  getDb,
  preparePlayerSearchStatements,
  prepareStatements,
} from '../src/database/db.js';
import { allocatePlayerSearchPublicId } from '../src/services/playerSearchPublicId.js';
import {
  buildPlayerSearchContactLine,
  buildPlayerSearchEmbed,
} from '../src/services/playerSearchEmbedBuilder.js';
import { findExpiredActivePlayerSearchCandidates } from '../src/services/playerSearchLifecycle.js';
import { SCRIM_TIMEZONE } from '../src/utils/scrimScheduledAt.js';

const PLAYER_SEARCH_TABLES = [
  'player_search_posts',
  'player_search_post_messages',
  'guild_player_search_channels',
  'guild_player_search_usage_channel',
  'guild_player_search_permissions',
  'guild_player_search_allowed_roles',
  'player_search_message_edit_retries',
];

const SCRIM_TABLES = [
  'scrim_posts',
  'scrim_post_messages',
  'guild_game_channels',
  'guild_scrim_permissions',
];

/**
 * @param {() => void} fn
 */
function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-search-db-test-'));
  const prev = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  try {
    const db = getDb();
    const stmts = prepareStatements(db);
    const playerSearchStmts = preparePlayerSearchStatements(db);
    fn({ db, stmts, playerSearchStmts });
  } finally {
    closeDb();
    if (prev === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 */
function tableExists(db, table) {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(table);
  return row != null;
}

/**
 * @param {ReturnType<typeof preparePlayerSearchStatements>} playerSearchStmts
 * @param {Partial<{
 *   player_search_public_id: string,
 *   author_user_id: string,
 *   scheduled_at: string,
 *   status: string,
 * }>} [overrides]
 */
function insertSamplePost(playerSearchStmts, overrides = {}) {
  const now = Date.now();
  const publicId =
    overrides.player_search_public_id ?? allocatePlayerSearchPublicId(playerSearchStmts);
  playerSearchStmts.insertPlayerSearchPostRow.run({
    player_search_public_id: publicId,
    author_user_id: overrides.author_user_id ?? 'author-1',
    origin_guild_id: 'guild-origin',
    source_guild_id: 'guild-origin',
    roles_json: JSON.stringify(['adc', 'support']),
    ranks_json: JSON.stringify(['Émeraude', 'Diamant']),
    player_count: 2,
    session_type: 'Scrim BO3',
    ambiance: 'Chill + Tryhard',
    description: null,
    contact_user_id: 'contact-1',
    scheduled_date: '30/05/2026',
    scheduled_time: '21h',
    scheduled_at: overrides.scheduled_at ?? '2026-05-30T19:00:00.000Z',
    scheduled_at_end: null,
    tags_json: '{}',
    created_at: now,
    status: overrides.status ?? 'active',
  });
  const row = playerSearchStmts.getPlayerSearchPostByPublicIdAny.get(publicId);
  return row;
}

test('schéma init — tables player_search_* créées', () => {
  withTempDb(({ db }) => {
    for (const table of PLAYER_SEARCH_TABLES) {
      assert.equal(tableExists(db, table), true, `table manquante: ${table}`);
    }
    for (const table of SCRIM_TABLES) {
      assert.equal(tableExists(db, table), true, `table scrim manquante: ${table}`);
    }
  });
});

test('insert/read post — cohérence des champs', () => {
  withTempDb(({ playerSearchStmts }) => {
    const row = insertSamplePost(playerSearchStmts);
    assert.ok(row);
    const byId = playerSearchStmts.getPlayerSearchPostById.get(row.id);
    assert.equal(byId.player_search_public_id, row.player_search_public_id);
    assert.equal(byId.session_type, 'Scrim BO3');
    assert.equal(byId.status, 'active');
    assert.equal(JSON.parse(String(byId.roles_json)).length, 2);
  });
});

test('allocation J1/J2/J3 — plus petit ID libre', () => {
  withTempDb(({ playerSearchStmts }) => {
    assert.equal(allocatePlayerSearchPublicId(playerSearchStmts), 'J1');
    insertSamplePost(playerSearchStmts, { player_search_public_id: 'J1' });
    assert.equal(allocatePlayerSearchPublicId(playerSearchStmts), 'J2');
    insertSamplePost(playerSearchStmts, {
      player_search_public_id: 'J2',
      author_user_id: 'author-2',
    });
    assert.equal(allocatePlayerSearchPublicId(playerSearchStmts), 'J3');
  });
});

test('unicité active — deux J1 actifs interdits', () => {
  withTempDb(({ playerSearchStmts }) => {
    insertSamplePost(playerSearchStmts, { player_search_public_id: 'J1' });
    assert.throws(() => {
      insertSamplePost(playerSearchStmts, {
        player_search_public_id: 'J1',
        author_user_id: 'author-2',
      });
    });
  });
});

test('fermeture manual — closePlayerSearchPostIfActive', () => {
  withTempDb(({ playerSearchStmts }) => {
    const row = insertSamplePost(playerSearchStmts, { player_search_public_id: 'J5' });
    const closedAt = new Date().toISOString();
    const result = playerSearchStmts.closePlayerSearchPostIfActive.run({
      id: row.id,
      status: 'closed_manual',
      closed_at: closedAt,
      closed_reason: 'manual',
    });
    assert.equal(result.changes, 1);
    const updated = playerSearchStmts.getPlayerSearchPostById.get(row.id);
    assert.equal(updated.status, 'closed_manual');
    assert.equal(updated.closed_reason, 'manual');
    const second = playerSearchStmts.closePlayerSearchPostIfActive.run({
      id: row.id,
      status: 'closed_manual',
      closed_at: closedAt,
      closed_reason: 'manual',
    });
    assert.equal(second.changes, 0);
    assert.equal(
      playerSearchStmts.getPlayerSearchPostActiveByPublicId.get('J5'),
      undefined,
    );
  });
});

test('expiration query — marge 3 h après scheduled_at', () => {
  withTempDb(({ playerSearchStmts }) => {
    const scheduledAt = '2026-05-30T19:00:00.000Z';
    insertSamplePost(playerSearchStmts, {
      player_search_public_id: 'J10',
      scheduled_at: scheduledAt,
    });
    insertSamplePost(playerSearchStmts, {
      player_search_public_id: 'J11',
      author_user_id: 'author-futur',
      scheduled_at: '2099-12-31T12:00:00.000Z',
    });
    const nowBeforeGrace = '2026-05-30T21:59:00.000Z';
    const notExpired = playerSearchStmts.findExpiredActivePlayerSearchPosts.all();
    assert.equal(notExpired.length, 2);

    const candidatesBefore = findExpiredActivePlayerSearchCandidates(
      playerSearchStmts,
      nowBeforeGrace,
    );
    assert.equal(candidatesBefore.length, 0);

    const candidatesAfter = findExpiredActivePlayerSearchCandidates(
      playerSearchStmts,
      '2026-05-30T22:01:00.000Z',
    );
    const ids = candidatesAfter.map((r) => r.publicId);
    assert.ok(ids.includes('J10'));
    assert.equal(ids.length, 1);
  });
});

test('messages liés — insert, list, delete rollback', () => {
  withTempDb(({ playerSearchStmts }) => {
    const row = insertSamplePost(playerSearchStmts, { player_search_public_id: 'J20' });
    playerSearchStmts.insertPlayerSearchPostMessage.run({
      player_search_post_db_id: row.id,
      guild_id: 'g1',
      channel_id: 'c1',
      message_id: 'm1',
    });
    playerSearchStmts.insertPlayerSearchPostMessage.run({
      player_search_post_db_id: row.id,
      guild_id: 'g2',
      channel_id: 'c2',
      message_id: 'm2',
    });
    const messages = playerSearchStmts.listPlayerSearchPostMessagesByPostId.all(
      row.id,
    );
    assert.equal(messages.length, 2);
    playerSearchStmts.deletePlayerSearchPostMessagesForPost.run(row.id);
    assert.equal(
      playerSearchStmts.listPlayerSearchPostMessagesByPostId.all(row.id).length,
      0,
    );
  });
});

test('channels dédiés — upsert, list, delete', () => {
  withTempDb(({ playerSearchStmts }) => {
    assert.equal(playerSearchStmts.countGuildPlayerSearchChannels.get().n, 0);
    playerSearchStmts.upsertGuildPlayerSearchChannel.run({
      guild_id: 'guild-a',
      channel_id: 'chan-1',
      created_at: Date.now(),
    });
    playerSearchStmts.upsertGuildPlayerSearchChannel.run({
      guild_id: 'guild-b',
      channel_id: 'chan-2',
      created_at: Date.now(),
    });
    assert.equal(playerSearchStmts.countGuildPlayerSearchChannels.get().n, 2);
    const channels = playerSearchStmts.listPlayerSearchChannels.all();
    assert.equal(channels.length, 2);
    playerSearchStmts.deleteGuildPlayerSearchChannel.run('guild-a');
    assert.equal(playerSearchStmts.countGuildPlayerSearchChannels.get().n, 1);
  });
});

test('listActivePlayerSearchPostsByAuthor — filtre actifs', () => {
  withTempDb(({ playerSearchStmts }) => {
    insertSamplePost(playerSearchStmts, {
      player_search_public_id: 'J30',
      author_user_id: 'user-a',
    });
    const closed = insertSamplePost(playerSearchStmts, {
      player_search_public_id: 'J31',
      author_user_id: 'user-a',
    });
    playerSearchStmts.closePlayerSearchPostIfActive.run({
      id: closed.id,
      status: 'closed_manual',
      closed_at: new Date().toISOString(),
      closed_reason: 'manual',
    });
    const active = playerSearchStmts.listActivePlayerSearchPostsByAuthor.all(
      'user-a',
    );
    assert.equal(active.length, 1);
    assert.equal(active[0].player_search_public_id, 'J30');
  });
});

test('isolation scrim — prepareStatements inchangé', () => {
  withTempDb(({ stmts }) => {
    assert.equal(typeof stmts.insertScrimPostRow.run, 'function');
    assert.equal(typeof stmts.findExpiredActiveScrimPosts.all, 'function');
    assert.equal(stmts.countActiveScrimPosts.get().n, 0);
  });
});

test('embed builder — annonce courte sans ID public', () => {
  const ref = DateTime.fromObject(
    { year: 2026, month: 5, day: 30, hour: 12 },
    { zone: SCRIM_TIMEZONE },
  );
  const origNow = DateTime.now;
  DateTime.now = () => ref;

  try {
    const embed = buildPlayerSearchEmbed({
      roles: ['adc'],
      ranks: ['Plat'],
      playerCount: 2,
      sessionType: 'Quelques games',
      ambiance: 'Chill',
      contactUserId: '123',
      contactDisplayName: 'bml',
      scheduledDate: '30/05/2026',
      scheduledTime: '21h',
      scheduledAtIso: '2026-05-30T19:00:00.000Z',
    });
    const data = embed.toJSON();
    assert.equal(String(data.title), '🔎 Recherche ADC');
    const desc = String(data.description);
    assert.match(
      desc,
      /Nous cherchons 2 joueurs ADC de niveau Plat pour quelques games aujourd'hui à 21h\./,
    );
    assert.match(desc, /🎯 Chill/);
    assert.match(desc, /👤 <@123> · bml/);
    assert.doesNotMatch(desc, /📞/);
    assert.doesNotMatch(desc, /ID J/i);
    assert.doesNotMatch(desc, /Recherche en cours/i);
    assert.doesNotMatch(desc, /📝/);
  } finally {
    DateTime.now = origNow;
  }
});

test('embed builder — plusieurs rôles en slash', () => {
  const ref = DateTime.fromObject(
    { year: 2026, month: 5, day: 29, hour: 12 },
    { zone: SCRIM_TIMEZONE },
  );
  const origNow = DateTime.now;
  DateTime.now = () => ref;

  try {
    const embed = buildPlayerSearchEmbed({
      roles: ['adc', 'support'],
      ranks: ['Emerald / Diamond'],
      playerCount: 2,
      sessionType: 'Scrim BO3',
      ambiance: 'Chill + Tryhard',
      contactUserId: '123',
      scheduledDate: '30/05/2026',
      scheduledTime: '21h',
      scheduledAtIso: '2026-05-30T19:00:00.000Z',
    });
    const data = embed.toJSON();
    assert.equal(String(data.title), '🔎 Recherche ADC / Support');
    const desc = String(data.description);
    assert.match(
      desc,
      /Nous cherchons 2 joueurs ADC \/ Support de niveau Emerald \/ Diamond pour un scrim BO3 demain à 21h\./,
    );
    assert.match(desc, /🎯 Chill \+ Tryhard/);
    assert.match(desc, /👤 <@123>/);
    assert.doesNotMatch(desc, /📞/);
    assert.doesNotMatch(desc, /📝/);
  } finally {
    DateTime.now = origNow;
  }
});

test('buildPlayerSearchContactLine — avec et sans displayName', () => {
  assert.equal(
    buildPlayerSearchContactLine('42', 'bml'),
    '👤 <@42> · bml',
  );
  assert.equal(buildPlayerSearchContactLine('42', ''), '👤 <@42>');
  assert.equal(buildPlayerSearchContactLine('42', null), '👤 <@42>');
});
