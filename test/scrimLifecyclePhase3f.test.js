/**
 * Phase 3F — dispatcher lifecycle unifié
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { EmbedBuilder } from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import {
  parseScrimLifecycleConcurrency,
  SCRIM_LIFECYCLE_CONCURRENCY_MAX,
} from '../src/services/scrimLifecycleConcurrency.js';
import {
  claimNextScrimLifecycleOperation,
  drainScrimLifecycleDispatcher,
  getScrimLifecycleDispatcherHealthSnapshot,
  recoverScrimLifecycleDispatcherAtStartup,
  runScrimLifecycleDispatcherPass,
  startScrimLifecycleDispatcher,
  stopScrimLifecycleDispatcher,
} from '../src/services/scrimLifecycleDispatcher.js';
import {
  insertOrchestratedScrimLifecycleOperation,
  LIFECYCLE_OP_TYPE_EDIT,
} from '../src/services/scrimLifecycleOperationStore.js';
import { lifecycleDispatchPriorityScore } from '../src/services/scrimLifecyclePriority.js';
import {
  orchestrateScrimCloseInTransaction,
} from '../src/services/scrimLifecycleOrchestrator.js';
import {
  startDiscordTaskQueue,
  stopDiscordTaskQueue,
} from '../src/services/discordTaskQueue.js';
import { runDiscordEditRetryPass } from '../src/services/discordEditRetryJob.js';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-lifecycle-3f-'));
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

function insertScrimPost(stmts, status = 'active') {
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
    created_at: now,
    status,
  });
  return Number(r.lastInsertRowid);
}

describe('Phase 3F — SCRIM_LIFECYCLE_CONCURRENCY parser', () => {
  it('default 1, invalid → 1, cap 10', () => {
    delete process.env.SCRIM_LIFECYCLE_CONCURRENCY;
    assert.strictEqual(parseScrimLifecycleConcurrency(undefined), 1);
    assert.strictEqual(parseScrimLifecycleConcurrency('0'), 1);
    assert.strictEqual(parseScrimLifecycleConcurrency('abc'), 1);
    assert.strictEqual(parseScrimLifecycleConcurrency('2.9'), 2);
    assert.strictEqual(parseScrimLifecycleConcurrency('99'), SCRIM_LIFECYCLE_CONCURRENCY_MAX);
  });
});

describe('Phase 3F — claim atomique (A)', () => {
  it('deux claims concurrents — une seule exécution', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm1',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_manual',
        eventKey: `close:${postId}:closed_manual:m1`,
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });

      const c1 = claimNextScrimLifecycleOperation(stmts);
      const c2 = claimNextScrimLifecycleOperation(stmts);
      assert.ok(c1);
      assert.strictEqual(c2, null);
      assert.strictEqual(c1.status, 'processing');
    });
  });
});

describe('Phase 3F — priority (D) et fairness (E)', () => {
  it('close high avant supersede normal', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c-super',
        messageId: 'm-super',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'superseded_repost',
        eventKey: `supersede:${postId}:1:m-super`,
      });
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c-close',
        messageId: 'm-close',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_manual',
        eventKey: `close:${postId}:closed_manual:m-close`,
      });

      const next = claimNextScrimLifecycleOperation(stmts);
      assert.strictEqual(next.message_id, 'm-close');
      assert.strictEqual(lifecycleDispatchPriorityScore(next), 0);
    });
  });

  it('fairness — rotation last_dispatched_at', async () => {
    await withTempDb(async (db, stmts) => {
      const p1 = insertScrimPost(stmts);
      const p2 = insertScrimPost(stmts);
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: p1,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm1',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'superseded_repost',
        eventKey: `supersede:${p1}:1:m1`,
      });
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: p2,
        guildId: 'g2',
        channelId: 'c2',
        messageId: 'm2',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'superseded_repost',
        eventKey: `supersede:${p2}:1:m2`,
      });

      const first = claimNextScrimLifecycleOperation(stmts);
      assert.ok(first);
      const second = claimNextScrimLifecycleOperation(stmts);
      assert.ok(second);
      assert.notStrictEqual(first.scrim_post_db_id, second.scrim_post_db_id);
    });
  });
});

describe('Phase 3F — stale edit (F)', () => {
  beforeEach(() => {
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    startDiscordTaskQueue();
  });

  afterEach(async () => {
    await stopDiscordTaskQueue();
    delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
  });

  it('scrim fermé — supersede stale, 0 edit', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      db.prepare(`UPDATE scrim_posts SET status = 'closed_manual' WHERE id = ?`).run(postId);
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-stale',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'superseded_repost',
        eventKey: `supersede:${postId}:1:m-stale`,
      });

      let edits = 0;
      const mockClient = {
        guilds: {
          fetch: async () => ({
            channels: {
              fetch: async () => ({
                isTextBased: () => true,
                messages: {
                  fetch: async () => ({
                    id: 'm-stale',
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

      await drainScrimLifecycleDispatcher(mockClient, stmts);
      assert.strictEqual(edits, 0);
    });
  });
});

describe('Phase 3F — no double retry (K)', () => {
  beforeEach(() => {
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    process.env.DISCORD_API_MAX_ATTEMPTS = '1';
    startDiscordTaskQueue();
  });

  afterEach(async () => {
    await stopDiscordTaskQueue();
    delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    delete process.env.DISCORD_API_MAX_ATTEMPTS;
  });

  it('op orchestrée exclue du edit retry legacy', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const inserted = insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-legacy',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_manual',
        eventKey: `close:${postId}:closed_manual:m-legacy`,
      });
      const opId = inserted.operationId;
      assert.ok(opId);

      const now = new Date().toISOString();
      stmts.insertDiscordEditRetry.run({
        scrim_post_db_id: postId,
        guild_id: 'g1',
        channel_id: 'c1',
        message_id: 'm-legacy',
        target_status: 'closed_manual',
        attempt_count: 0,
        next_attempt_at: now,
        last_error_code: 'HTTP_503',
        last_error_message: 'test',
        payload_json: JSON.stringify({ v: 2, embeds: [new EmbedBuilder().setTitle('x').toJSON()] }),
        lifecycle_operation_id: opId,
        created_at: now,
        updated_at: now,
      });

      const due = stmts.listDueDiscordEditRetries.all({ now_iso: now });
      assert.strictEqual(due.length, 0);
    });
  });
});

describe('Phase 3F — startup recovery (I) et shutdown (J)', () => {
  it('processing reset pending', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO scrim_lifecycle_operations (
          scrim_post_db_id, guild_id, channel_id, message_id,
          operation_type, target_status, priority, status,
          attempt_count, event_key, created_at, updated_at
        ) VALUES (?, 'g1', 'c1', 'm-rec', 'lifecycle_edit', 'closed_manual', 'high', 'processing', 1, ?, ?, ?)
      `).run(postId, `close:${postId}:closed_manual:m-rec`, now, now);

      recoverScrimLifecycleDispatcherAtStartup(stmts);
      const row = db.prepare(`SELECT status FROM scrim_lifecycle_operations`).get();
      assert.strictEqual(row.status, 'pending');
    });
  });

  it('shutdown stop claims, pending durable', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-pend',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_manual',
        eventKey: `close:${postId}:closed_manual:m-pend`,
      });

      const mockClient = { guilds: { fetch: async () => ({ channels: { fetch: async () => ({}) } }) } };
      startScrimLifecycleDispatcher(mockClient, stmts);
      await stopScrimLifecycleDispatcher();

      const snap = getScrimLifecycleDispatcherHealthSnapshot();
      assert.strictEqual(snap.started, false);
      assert.strictEqual(snap.activeWorkers, 0);

      const row = db.prepare(`SELECT status FROM scrim_lifecycle_operations`).get();
      assert.ok(row, 'op toujours en DB');
    });
  });
});

describe('Phase 3F — close priority under load (M)', () => {
  it('flood supersede — close claim first', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      for (let i = 0; i < 5; i += 1) {
        insertOrchestratedScrimLifecycleOperation(stmts, {
          scrimPostDbId: postId,
          guildId: 'g1',
          channelId: `c-s${i}`,
          messageId: `m-s${i}`,
          operationType: LIFECYCLE_OP_TYPE_EDIT,
          targetStatus: 'superseded_repost',
          eventKey: `supersede:${postId}:1:m-s${i}`,
        });
      }
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c-close',
        messageId: 'm-close-priority',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_manual',
        eventKey: `close:${postId}:closed_manual:m-close-priority`,
      });

      const first = claimNextScrimLifecycleOperation(stmts);
      assert.strictEqual(first.message_id, 'm-close-priority');
    });
  });
});

describe('Phase 3F — migration last_dispatched_at', () => {
  it('colonne présente', async () => {
    await withTempDb(async (db) => {
      const cols = db
        .prepare(`PRAGMA table_info(scrim_lifecycle_operations)`)
        .all()
        .map((c) => c.name);
      assert.ok(cols.includes('last_dispatched_at'));
    });
  });
});

describe('Phase 3F — concurrency snapshot (B,C)', () => {
  it('N=1 default', () => {
    delete process.env.SCRIM_LIFECYCLE_CONCURRENCY;
    const snap = getScrimLifecycleDispatcherHealthSnapshot();
    assert.strictEqual(snap.concurrency, 1);
  });
});
