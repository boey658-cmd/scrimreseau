import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildScrimEmbed,
  buildScrimSupersededMessageEditOptions,
  SCRIM_EMBED_COLOR_ACTIVE,
  SCRIM_EMBED_COLOR_CLOSED_MANUAL,
  SCRIM_EMBED_COLOR_SUPERSEDED,
} from '../src/services/scrimEmbedBuilder.js';
import {
  computeRepostCutoffIso,
  isScrimRepostEnabled,
  parseRepostIntervalHours,
} from '../src/services/scrimRepostJob.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';

/**
 * @param {() => void} fn
 */
function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-repost-test-'));
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

test('computeRepostCutoffIso — 24h avant maintenant', () => {
  const now = Date.parse('2026-05-23T12:00:00.000Z');
  const cutoff = computeRepostCutoffIso(now, 24);
  assert.equal(cutoff, '2026-05-22T12:00:00.000Z');
});

test('isScrimRepostEnabled — false pour 0/off', () => {
  assert.equal(isScrimRepostEnabled('0'), false);
  assert.equal(isScrimRepostEnabled('off'), false);
  assert.equal(isScrimRepostEnabled('true'), true);
  assert.equal(isScrimRepostEnabled(undefined), true);
});

test('parseRepostIntervalHours — bornes', () => {
  assert.equal(parseRepostIntervalHours('24'), 24);
  assert.equal(parseRepostIntervalHours('0'), 24);
  assert.equal(parseRepostIntervalHours('abc'), 24);
});

test('embed actif — Recherche en cours + vert', () => {
  const embed = buildScrimEmbed({
    gameKey: 'lol',
    rank: 'Gold',
    dateStr: '01/06/2026',
    timeStr: '20h00',
    format: 'Bo1',
    contactUserId: '1',
  });
  assert.equal(embed.data.color, SCRIM_EMBED_COLOR_ACTIVE);
  assert.match(embed.data.description ?? '', /Recherche en cours/);
});

test('embed superseded — gris foncé, pas rouge « trouvé »', () => {
  const row = {
    game_key: 'lol',
    rank_key: 'Gold',
    scheduled_date: '01/06/2026',
    scheduled_time: '20:00',
    scheduled_at: '2026-06-01T18:00:00.000Z',
    format_key: 'Bo1',
    contact_user_id: '99',
    tags: '[]',
    multi_opgg_url: null,
  };
  const opts = buildScrimSupersededMessageEditOptions(row);
  assert.equal(opts.embeds[0].data.color, SCRIM_EMBED_COLOR_SUPERSEDED);
  assert.notEqual(opts.embeds[0].data.color, SCRIM_EMBED_COLOR_CLOSED_MANUAL);
  assert.match(opts.embeds[0].data.description ?? '', /Ancienne annonce/);
});

test('findActiveScrimPostsDueForRepost — actif vieux de 25h éligible', () => {
  withTempDb((db, stmts) => {
    const now = Date.now();
    const created25hAgo = now - 25 * 60 * 60 * 1000;
    stmts.insertScrimPostRow.run({
      scrim_public_id: 42,
      author_user_id: 'u1',
      origin_guild_id: 'g1',
      source_guild_id: 'g1',
      game_key: 'lol',
      rank_key: 'Gold',
      format_key: 'Bo1',
      contact_user_id: 'u1',
      scheduled_date: '01/06/2026',
      scheduled_time: '20:00',
      scheduled_at: new Date(now + 86400000).toISOString(),
      scheduled_at_end: null,
      tags: '[]',
      multi_opgg_url: null,
      created_at: created25hAgo,
      status: 'active',
    });
    const cutoff = computeRepostCutoffIso(now, 24);
    const due = stmts.findActiveScrimPostsDueForRepost.all({
      cutoff_iso: cutoff,
      max_per_pass: 5,
    });
    assert.equal(due.length, 1);
    assert.equal(Number(due[0].scrim_public_id), 42);
  });
});

test('findActiveScrimPostsDueForRepost — repost récent exclu (< 24h)', () => {
  withTempDb((db, stmts) => {
    const now = Date.now();
    const created48hAgo = now - 48 * 60 * 60 * 1000;
    const info = stmts.insertScrimPostRow.run({
      scrim_public_id: 43,
      author_user_id: 'u1',
      origin_guild_id: 'g1',
      source_guild_id: 'g1',
      game_key: 'lol',
      rank_key: 'Gold',
      format_key: 'Bo1',
      contact_user_id: 'u1',
      scheduled_date: '01/06/2026',
      scheduled_time: '20:00',
      scheduled_at: new Date(now + 86400000).toISOString(),
      scheduled_at_end: null,
      tags: '[]',
      multi_opgg_url: null,
      created_at: created48hAgo,
      status: 'active',
    });
    const id = Number(info.lastInsertRowid);
    stmts.recordScrimPostRepostSuccess.run({
      id,
      last_repost_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    });
    const cutoff = computeRepostCutoffIso(now, 24);
    const due = stmts.findActiveScrimPostsDueForRepost.all({
      cutoff_iso: cutoff,
      max_per_pass: 5,
    });
    assert.equal(due.length, 0);
  });
});

test('findActiveScrimPostsDueForRepost — closed_manual et closed_expired exclus', () => {
  withTempDb((db, stmts) => {
    const now = Date.now();
    const old = now - 30 * 60 * 60 * 1000;
    const base = {
      author_user_id: 'u1',
      origin_guild_id: 'g1',
      source_guild_id: 'g1',
      game_key: 'lol',
      rank_key: 'Gold',
      format_key: 'Bo1',
      contact_user_id: 'u1',
      scheduled_date: '01/06/2026',
      scheduled_time: '20:00',
      scheduled_at: new Date(now + 86400000).toISOString(),
      scheduled_at_end: null,
      tags: '[]',
      multi_opgg_url: null,
      created_at: old,
    };
    stmts.insertScrimPostRow.run({
      ...base,
      scrim_public_id: 50,
      status: 'closed_manual',
    });
    stmts.insertScrimPostRow.run({
      ...base,
      scrim_public_id: 51,
      status: 'closed_expired',
    });
    const cutoff = computeRepostCutoffIso(now, 24);
    const due = stmts.findActiveScrimPostsDueForRepost.all({
      cutoff_iso: cutoff,
      max_per_pass: 5,
    });
    assert.equal(due.length, 0);
  });
});

test('recordScrimPostRepostSuccess — conserve scrim_public_id et status active', () => {
  withTempDb((db, stmts) => {
    const now = Date.now();
    const info = stmts.insertScrimPostRow.run({
      scrim_public_id: 77,
      author_user_id: 'u1',
      origin_guild_id: 'g1',
      source_guild_id: 'g1',
      game_key: 'lol',
      rank_key: 'Gold',
      format_key: 'Bo1',
      contact_user_id: 'u1',
      scheduled_date: '01/06/2026',
      scheduled_time: '20:00',
      scheduled_at: new Date(now + 86400000).toISOString(),
      scheduled_at_end: null,
      tags: '[]',
      multi_opgg_url: null,
      created_at: now - 30 * 60 * 60 * 1000,
      status: 'active',
    });
    const id = Number(info.lastInsertRowid);
    const repostAt = new Date().toISOString();
    stmts.recordScrimPostRepostSuccess.run({ id, last_repost_at: repostAt });
    const row = stmts.getScrimPostById.get(id);
    assert.equal(row.status, 'active');
    assert.equal(Number(row.scrim_public_id), 77);
    assert.equal(row.last_repost_at, repostAt);
    assert.equal(Number(row.repost_count), 1);
    const active = stmts.getScrimPostActiveByPublicId.get(77);
    assert.ok(active);
    assert.equal(Number(active.id), id);
  });
});

test('findActiveScrimPostsDueForRepost — max 5 par passe', () => {
  withTempDb((db, stmts) => {
    const now = Date.now();
    const old = now - 30 * 60 * 60 * 1000;
    for (let i = 1; i <= 7; i += 1) {
      stmts.insertScrimPostRow.run({
        scrim_public_id: i,
        author_user_id: 'u1',
        origin_guild_id: 'g1',
        source_guild_id: 'g1',
        game_key: 'lol',
        rank_key: 'Gold',
        format_key: 'Bo1',
        contact_user_id: 'u1',
        scheduled_date: '01/06/2026',
        scheduled_time: '20:00',
        scheduled_at: new Date(now + 86400000).toISOString(),
        scheduled_at_end: null,
        tags: '[]',
        multi_opgg_url: null,
        created_at: old + i,
        status: 'active',
      });
    }
    const cutoff = computeRepostCutoffIso(now, 24);
    const due = stmts.findActiveScrimPostsDueForRepost.all({
      cutoff_iso: cutoff,
      max_per_pass: 5,
    });
    assert.equal(due.length, 5);
  });
});

test('getScrimPostMessageForGuild — dernier message (ORDER BY id DESC)', () => {
  withTempDb((db, stmts) => {
    const info = stmts.insertScrimPostRow.run({
      scrim_public_id: 88,
      author_user_id: 'u1',
      origin_guild_id: 'g1',
      source_guild_id: 'g1',
      game_key: 'lol',
      rank_key: 'Gold',
      format_key: 'Bo1',
      contact_user_id: 'u1',
      scheduled_date: '01/06/2026',
      scheduled_time: '20:00',
      scheduled_at: new Date(Date.now() + 86400000).toISOString(),
      scheduled_at_end: null,
      tags: '[]',
      multi_opgg_url: null,
      created_at: Date.now(),
      status: 'active',
    });
    const postId = Number(info.lastInsertRowid);
    stmts.insertScrimPostMessage.run({
      scrim_post_db_id: postId,
      guild_id: 'guild-a',
      channel_id: 'ch1',
      message_id: 'old-msg',
    });
    stmts.insertScrimPostMessage.run({
      scrim_post_db_id: postId,
      guild_id: 'guild-a',
      channel_id: 'ch1',
      message_id: 'new-msg',
    });
    const link = stmts.getScrimPostMessageForGuild.get(postId, 'guild-a');
    assert.equal(link.message_id, 'new-msg');
  });
});
