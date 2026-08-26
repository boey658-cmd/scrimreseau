/**
 * Phase 3E — cycles repost durables + orchestration lifecycle cohérente 3D
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import {
  buildRepostCycleEventKey,
  executeRepostCycleForScrim,
  finalizeRepostCycle,
  getNewMessagesSinceCycleSnapshot,
  parseCycleOldMessagesSnapshot,
  recoverIncompleteRepostCycles,
  reserveRepostCycle,
} from '../src/services/scrimRepostCycle.js';
import {
  drainScrimLifecycleDispatcher,
  startScrimLifecycleDispatcher,
  stopScrimLifecycleDispatcher,
} from '../src/services/scrimLifecycleDispatcher.js';
import {
  buildScrimLifecycleEventKey,
} from '../src/services/scrimLifecycleOrchestrator.js';
import {
  startDiscordTaskQueue,
  stopDiscordTaskQueue,
} from '../src/services/discordTaskQueue.js';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-lifecycle-3e-'));
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

function insertScrimPost(stmts, status = 'active', repostCount = 0) {
  const now = Date.now();
  const r = stmts.insertScrimPostRow.run({
    scrim_public_id: Math.floor(Math.random() * 9000) + 1,
    author_user_id: 'user-1',
    origin_guild_id: 'g1',
    source_guild_id: 'g1',
    game_key: 'lol',
    rank_key: 'Gold',
    format_key: 'BO1',
    contact_user_id: 'user-1',
    contact_display_name: null,
    scheduled_date: '01/08/2026',
    scheduled_time: '20:00',
    scheduled_at: new Date(now + 86400000).toISOString(),
    scheduled_at_end: null,
    tags: '[]',
    multi_opgg_url: null,
    elo_precision: null,
    structure_guild_id: null,
    structure_name_snapshot: null,
    structure_invite_url_snapshot: null,
    created_at: now - 30 * 60 * 60 * 1000,
    status,
    repost_count: repostCount,
  });
  return Number(r.lastInsertRowid);
}

function insertMessage(stmts, postId, guildId, channelId, messageId) {
  stmts.insertScrimPostMessage.run({
    scrim_post_db_id: postId,
    guild_id: guildId,
    channel_id: channelId,
    message_id: messageId,
  });
}

function setupChannel(stmts, guildId = 'g1', channelId = 'c1') {
  stmts.upsertGuildChannel.run({
    guild_id: guildId,
    channel_id: channelId,
    game_key: 'lol',
    created_at: Date.now(),
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} postId
 * @param {(guildId: string, channelId: string) => Promise<{ id: string }>} [onSend]
 */
function buildMockClient(db, postId, onSend) {
  let msgCounter = 0;
  return {
    guilds: {
      cache: new Map(),
      fetch: async (id) => ({
        id,
        channels: {
          cache: new Map(),
          fetch: async (cid) => ({
            id: cid,
            type: ChannelType.GuildText,
            permissionsFor: () =>
              new PermissionsBitField([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
              ]),
            send: async () => {
              msgCounter += 1;
              const msgId = `new-msg-${msgCounter}`;
              if (onSend) {
                return onSend(id, cid, msgId);
              }
              return { id: msgId, guildId: id, channelId: cid, delete: async () => {} };
            },
            isTextBased: () => true,
            messages: {
              fetch: async (mid) => ({
                id: mid,
                channelId: cid,
                guildId: id,
                edit: async () => {},
                delete: async () => {},
              }),
            },
          }),
        },
        members: {
          me: { id: 'bot' },
          fetchMe: async () => ({ id: 'bot' }),
        },
      }),
    },
  };
}

async function setupBroadcastPool() {
  const { resetBroadcastPoolForTests, invalidateBroadcastConcurrencyCache } = await import(
    '../src/services/scrimBroadcastExecutionPool.js'
  );
  invalidateBroadcastConcurrencyCache();
  process.env.SCRIM_BROADCAST_CONCURRENCY = '2';
  resetBroadcastPoolForTests();
}

describe('Phase 3E — migration scrim_repost_cycles', () => {
  it('table et index actif présents', async () => {
    await withTempDb(async (db) => {
      const cols = db.prepare(`PRAGMA table_info(scrim_repost_cycles)`).all().map((c) => c.name);
      assert.ok(cols.includes('generation'));
      assert.ok(cols.includes('event_key'));
      assert.ok(cols.includes('old_messages_json'));
      const idx = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_src_active_scrim'`)
        .get();
      assert.ok(idx);
    });
  });
});

describe('Phase 3E — happy path (A)', () => {
  beforeEach(async () => {
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS = '1';
    startDiscordTaskQueue();
    await setupBroadcastPool();
  });

  afterEach(async () => {
    await stopScrimLifecycleDispatcher();
    await stopDiscordTaskQueue();
    delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    delete process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS;
  });

  it('generation réservée, broadcast, record 1x, supersede snapshot 1x', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g1', 'c-old', 'old-msg');
      setupChannel(stmts, 'g1', 'c-new');

      let supersedeEdits = 0;
      const mockClient = {
        guilds: {
          cache: new Map(),
          fetch: async (id) => ({
            id,
            channels: {
              cache: new Map(),
              fetch: async (cid) => ({
                id: cid,
                type: ChannelType.GuildText,
                permissionsFor: () =>
                  new PermissionsBitField([
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.EmbedLinks,
                  ]),
                send: async () => ({
                  id: 'new-msg-1',
                  guildId: id,
                  channelId: cid,
                  delete: async () => {},
                }),
                isTextBased: () => true,
                messages: {
                  fetch: async (mid) => ({
                    id: mid,
                    channelId: cid,
                    guildId: id,
                    edit: async () => {
                      if (mid === 'old-msg') supersedeEdits += 1;
                    },
                  }),
                },
              }),
            },
            members: {
              me: { id: 'bot' },
              fetchMe: async () => ({ id: 'bot' }),
            },
          }),
        },
      };

      startScrimLifecycleDispatcher(mockClient, stmts);
      const result = await executeRepostCycleForScrim(mockClient, db, stmts, postId);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.successCount, 1);
      await drainScrimLifecycleDispatcher(mockClient, stmts, { timeoutMs: 15_000 });

      const row = stmts.getScrimPostById.get(postId);
      assert.strictEqual(Number(row.repost_count), 1);

      const cycle = db
        .prepare(`SELECT * FROM scrim_repost_cycles WHERE scrim_post_db_id = ?`)
        .get(postId);
      assert.strictEqual(cycle.status, 'finalized');
      assert.strictEqual(Number(cycle.generation), 1);
      assert.strictEqual(cycle.event_key, buildRepostCycleEventKey(postId, 1));

      const supersedeOps = db
        .prepare(
          `SELECT * FROM scrim_lifecycle_operations WHERE scrim_post_db_id = ? AND target_status = 'superseded_repost'`,
        )
        .all(postId);
      assert.strictEqual(supersedeOps.length, 1);
      assert.strictEqual(supersedeOps[0].message_id, 'old-msg');
      assert.strictEqual(supersedeEdits, 1);

      const recordAttempts = db
        .prepare(`SELECT COUNT(*) AS n FROM scrim_repost_cycles WHERE generation = 1 AND status = 'finalized'`)
        .get();
      assert.strictEqual(Number(recordAttempts.n), 1);
    });
  });
});

describe('Phase 3E — double repost concurrent (B)', () => {
  it('deux réservations — une seule gagne', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g1', 'c1', 'm1');

      const r1 = reserveRepostCycle(db, stmts, postId);
      assert.ok(r1.reserved);
      const r2 = reserveRepostCycle(db, stmts, postId);
      assert.strictEqual(r2.reserved, false);
      assert.strictEqual(r2.reason, 'existing_cycle');

      const active = db
        .prepare(`SELECT COUNT(*) AS n FROM scrim_repost_cycles WHERE status IN ('reserved','broadcasting','broadcast_done')`)
        .get();
      assert.strictEqual(Number(active.n), 1);
    });
  });
});

describe('Phase 3E — close during repost (C)', () => {
  beforeEach(async () => {
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS = '1';
    startDiscordTaskQueue();
    await setupBroadcastPool();
  });

  afterEach(async () => {
    await stopDiscordTaskQueue();
    delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    delete process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS;
  });

  it('nouveaux + anciens messages → close ops, 0 supersede_repost', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g1', 'c-old', 'old-msg');
      setupChannel(stmts, 'g1', 'c-new');

      const mockClient = buildMockClient(db, postId, async () => {
        db.prepare(`UPDATE scrim_posts SET status = 'closed_manual', closed_at = ? WHERE id = ?`).run(
          new Date().toISOString(),
          postId,
        );
        return { id: 'new-msg-close', guildId: 'g1', channelId: 'c-new', delete: async () => {} };
      });

      const result = await executeRepostCycleForScrim(mockClient, db, stmts, postId);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'closed_during_repost');

      const supersedeOps = db
        .prepare(
          `SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE target_status = 'superseded_repost'`,
        )
        .get();
      assert.strictEqual(Number(supersedeOps.n), 0);

      const closeOps = db
        .prepare(
          `SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE target_status = 'closed_manual'`,
        )
        .get();
      assert.strictEqual(Number(closeOps.n), 2);

      const row = stmts.getScrimPostById.get(postId);
      assert.strictEqual(Number(row.repost_count), 0);

      const cycle = db.prepare(`SELECT status FROM scrim_repost_cycles WHERE scrim_post_db_id = ?`).get(postId);
      assert.strictEqual(cycle.status, 'cancelled');
    });
  });
});

describe('Phase 3E — expiration during repost (D)', () => {
  beforeEach(async () => {
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS = '1';
    startDiscordTaskQueue();
    await setupBroadcastPool();
  });

  afterEach(async () => {
    await stopDiscordTaskQueue();
    delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    delete process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS;
  });

  it('closed_expired — sync close, 0 supersede stale', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g1', 'c-old', 'old-msg');
      setupChannel(stmts, 'g1', 'c-new');

      const mockClient = buildMockClient(db, postId, async () => {
        db.prepare(`UPDATE scrim_posts SET status = 'closed_expired', closed_at = ? WHERE id = ?`).run(
          new Date().toISOString(),
          postId,
        );
        return { id: 'new-msg-exp', guildId: 'g1', channelId: 'c-new', delete: async () => {} };
      });

      const result = await executeRepostCycleForScrim(mockClient, db, stmts, postId);
      assert.strictEqual(result.reason, 'closed_during_repost');

      const supersedeOps = db
        .prepare(
          `SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE target_status = 'superseded_repost'`,
        )
        .get();
      assert.strictEqual(Number(supersedeOps.n), 0);

      const expiredOps = db
        .prepare(
          `SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE target_status = 'closed_expired'`,
        )
        .get();
      assert.strictEqual(Number(expiredOps.n), 2);
    });
  });
});

describe('Phase 3E — partial broadcast (E) et zero success (F)', () => {
  beforeEach(async () => {
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS = '1';
    startDiscordTaskQueue();
    await setupBroadcastPool();
  });

  afterEach(async () => {
    await stopDiscordTaskQueue();
    delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    delete process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS;
  });

  it('partial success — finalize 1x, supersede 1x', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g1', 'c-old', 'old-msg');
      setupChannel(stmts, 'g1', 'c-ok');
      setupChannel(stmts, 'g2', 'c-fail');

      let sendCount = 0;
      const mockClient = {
        guilds: {
          cache: new Map(),
          fetch: async (id) => ({
            id,
            channels: {
              cache: new Map(),
              fetch: async (cid) => ({
                id: cid,
                type: ChannelType.GuildText,
                permissionsFor: () =>
                  cid === 'c-fail'
                    ? new PermissionsBitField([])
                    : new PermissionsBitField([
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.EmbedLinks,
                      ]),
                send: async () => {
                  sendCount += 1;
                  return { id: `msg-${sendCount}`, guildId: id, channelId: cid, delete: async () => {} };
                },
                isTextBased: () => true,
                messages: {
                  fetch: async (mid) => ({
                    id: mid,
                    channelId: cid,
                    guildId: id,
                    edit: async () => {},
                  }),
                },
              }),
            },
            members: {
              me: { id: 'bot' },
              fetchMe: async () => ({ id: 'bot' }),
            },
          }),
        },
      };

      const result = await executeRepostCycleForScrim(mockClient, db, stmts, postId);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.successCount, 1);

      const supersedeOps = db
        .prepare(
          `SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE target_status = 'superseded_repost'`,
        )
        .get();
      assert.strictEqual(Number(supersedeOps.n), 1);

      const cycles = db.prepare(`SELECT COUNT(*) AS n FROM scrim_repost_cycles WHERE status = 'finalized'`).get();
      assert.strictEqual(Number(cycles.n), 1);
    });
  });

  it('zero success — no record, no supersede, cycle failed', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g1', 'c-old', 'old-msg');
      setupChannel(stmts, 'g1', 'c-deny');

      const mockClient = {
        guilds: {
          cache: new Map(),
          fetch: async (id) => ({
            id,
            channels: {
              cache: new Map(),
              fetch: async (cid) => ({
                id: cid,
                type: ChannelType.GuildText,
                permissionsFor: () => new PermissionsBitField([]),
                send: async () => {
                  throw new Error('denied');
                },
              }),
            },
            members: {
              me: { id: 'bot' },
              fetchMe: async () => ({ id: 'bot' }),
            },
          }),
        },
      };

      const result = await executeRepostCycleForScrim(mockClient, db, stmts, postId);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.successCount, 0);

      const row = stmts.getScrimPostById.get(postId);
      assert.strictEqual(Number(row.repost_count), 0);

      const supersedeOps = db
        .prepare(
          `SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE target_status = 'superseded_repost'`,
        )
        .get();
      assert.strictEqual(Number(supersedeOps.n), 0);

      const cycle = db.prepare(`SELECT status FROM scrim_repost_cycles WHERE scrim_post_db_id = ?`).get(postId);
      assert.strictEqual(cycle.status, 'failed');
    });
  });
});

describe('Phase 3E — crash recovery (G, H)', () => {
  beforeEach(async () => {
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS = '1';
    startDiscordTaskQueue();
    await setupBroadcastPool();
  });

  afterEach(async () => {
    await stopScrimLifecycleDispatcher();
    await stopDiscordTaskQueue();
    delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    delete process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS;
  });

  it('G — broadcast_done sans supersede → recovery reprend sans rebroadcast', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g1', 'c-old', 'old-msg');
      insertMessage(stmts, postId, 'g1', 'c-new', 'new-msg-recovery');
      const oldSnapshot = JSON.stringify([{ guild_id: 'g1', channel_id: 'c-old', message_id: 'old-msg' }]);
      const now = new Date().toISOString();
      stmts.insertScrimRepostCycle.run({
        scrim_post_db_id: postId,
        generation: 1,
        event_key: buildRepostCycleEventKey(postId, 1),
        status: 'broadcast_done',
        old_messages_json: oldSnapshot,
        success_count: 1,
        started_at: now,
        updated_at: now,
      });

      let edits = 0;
      const mockClient = {
        guilds: {
          fetch: async () => ({
            channels: {
              fetch: async () => ({
                isTextBased: () => true,
                messages: {
                  fetch: async (mid) => ({
                    id: mid,
                    channelId: 'c-old',
                    guildId: 'g1',
                    edit: async () => {
                      edits += 1;
                    },
                  }),
                },
              }),
            },
          }),
        },
      };

      startScrimLifecycleDispatcher(mockClient, stmts);
      const msgsBefore = stmts.listScrimPostMessagesByPostId.all(postId).length;
      await recoverIncompleteRepostCycles(mockClient, db, stmts);
      await drainScrimLifecycleDispatcher(mockClient, stmts, { timeoutMs: 15_000 });
      const msgsAfter = stmts.listScrimPostMessagesByPostId.all(postId).length;
      assert.strictEqual(msgsBefore, msgsAfter, 'pas de rebroadcast');

      const cycle = db.prepare(`SELECT status FROM scrim_repost_cycles WHERE scrim_post_db_id = ?`).get(postId);
      assert.strictEqual(cycle.status, 'finalized');
      assert.strictEqual(edits, 1);
      assert.strictEqual(Number(stmts.getScrimPostById.get(postId).repost_count), 1);
    });
  });

  it('H — broadcasting + nouveaux msgs en DB → recovery finalize sans double send', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g1', 'c-old', 'old-msg');
      insertMessage(stmts, postId, 'g1', 'c-new', 'partial-new');
      const oldSnapshot = JSON.stringify([{ guild_id: 'g1', channel_id: 'c-old', message_id: 'old-msg' }]);
      const now = new Date().toISOString();
      stmts.insertScrimRepostCycle.run({
        scrim_post_db_id: postId,
        generation: 1,
        event_key: buildRepostCycleEventKey(postId, 1),
        status: 'broadcasting',
        old_messages_json: oldSnapshot,
        success_count: 0,
        started_at: now,
        updated_at: now,
      });

      const mockClient = {
        guilds: {
          fetch: async () => ({
            channels: {
              fetch: async () => ({
                isTextBased: () => true,
                messages: {
                  fetch: async (mid) => ({
                    id: mid,
                    channelId: 'c-old',
                    guildId: 'g1',
                    edit: async () => {},
                  }),
                },
              }),
            },
          }),
        },
      };

      await recoverIncompleteRepostCycles(mockClient, db, stmts);

      const cycle = db.prepare(`SELECT status, success_count FROM scrim_repost_cycles WHERE scrim_post_db_id = ?`).get(
        postId,
      );
      assert.strictEqual(cycle.status, 'finalized');
      assert.ok(Number(cycle.success_count) >= 1);

      const msgs = stmts.listScrimPostMessagesByPostId.all(postId);
      assert.strictEqual(msgs.length, 2, 'aucun message supplémentaire créé par recovery');
    });
  });
});

describe('Phase 3E — generations distinctes (I) et snapshot (J)', () => {
  it('deux générations → event_keys distinctes', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts, 'active', 1);
      const key1 = buildRepostCycleEventKey(postId, 2);
      const key2 = buildRepostCycleEventKey(postId, 3);
      assert.notStrictEqual(key1, key2);
      assert.strictEqual(
        buildScrimLifecycleEventKey(postId, 'superseded_repost', 'm1', 2),
        `supersede:${postId}:2:m1`,
      );
      assert.notStrictEqual(
        buildScrimLifecycleEventKey(postId, 'superseded_repost', 'm1', 2),
        buildScrimLifecycleEventKey(postId, 'superseded_repost', 'm1', 3),
      );
    });
  });

  it('J — nouveaux messages exclus du snapshot old', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g1', 'c-old', 'old-msg');
      const oldSnapshot = JSON.stringify([
        { guild_id: 'g1', channel_id: 'c-old', message_id: 'old-msg' },
      ]);
      const newMsgs = getNewMessagesSinceCycleSnapshot(oldSnapshot, stmts, postId);
      assert.strictEqual(newMsgs.length, 0);

      insertMessage(stmts, postId, 'g1', 'c-new', 'new-msg');
      const newMsgs2 = getNewMessagesSinceCycleSnapshot(oldSnapshot, stmts, postId);
      assert.strictEqual(newMsgs2.length, 1);
      assert.strictEqual(newMsgs2[0].message_id, 'new-msg');

      const cycle = {
        old_messages_json: oldSnapshot,
      };
      const parsed = parseCycleOldMessagesSnapshot(cycle);
      assert.strictEqual(parsed.length, 1);
      assert.strictEqual(parsed[0].message_id, 'old-msg');
      assert.ok(!parsed.some((m) => m.message_id === 'new-msg'));
    });
  });
});

describe('Phase 3E — stale supersede after close (K)', () => {
  beforeEach(async () => {
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS = '1';
    startDiscordTaskQueue();
  });

  afterEach(async () => {
    await stopDiscordTaskQueue();
    delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    delete process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS;
  });

  it('supersede pending annulé si close pendant cycle', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const now = new Date().toISOString();
      const eventKey = buildScrimLifecycleEventKey(postId, 'superseded_repost', 'old-msg', 1);
      db.prepare(`
        INSERT INTO scrim_lifecycle_operations (
          scrim_post_db_id, guild_id, channel_id, message_id,
          operation_type, target_status, status, event_key, created_at, updated_at
        ) VALUES (?, 'g1', 'c-old', 'old-msg', 'lifecycle_edit', 'superseded_repost', 'pending', ?, ?, ?)
      `).run(postId, eventKey, now, now);

      db.prepare(`UPDATE scrim_posts SET status = 'closed_manual', closed_at = ? WHERE id = ?`).run(now, postId);

      const cycle = {
        id: 1,
        scrim_post_db_id: postId,
        generation: 1,
        old_messages_json: '[]',
        success_count: 1,
      };
      const { cancelSupersedeOpsForGeneration } = await import(
        '../src/services/scrimLifecycleOrchestrator.js'
      );
      cancelSupersedeOpsForGeneration(stmts, postId, 1);

      const op = db.prepare(`SELECT status FROM scrim_lifecycle_operations WHERE event_key = ?`).get(eventKey);
      assert.strictEqual(op.status, 'cancelled');
    });
  });
});
