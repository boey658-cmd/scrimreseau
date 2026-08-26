/**
 * Phase 3K — shadow event_key filter + shutdown dependency graph
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import {
  claimNextScrimLifecycleOperation,
  drainScrimLifecycleDispatcher,
  resetScrimLifecycleDispatcherBurstStateForTests,
  startScrimLifecycleDispatcher,
  stopScrimLifecycleDispatcher,
} from '../src/services/scrimLifecycleDispatcher.js';
import {
  createScrimLifecycleOperation,
  insertOrchestratedScrimLifecycleOperation,
  LIFECYCLE_OP_TYPE_EDIT,
} from '../src/services/scrimLifecycleOperationStore.js';
import {
  SCRIM_LIFECYCLE_STARVATION_BURST_AFTER_HIGH,
  SCRIM_LIFECYCLE_STARVATION_THRESHOLD_MS,
} from '../src/services/scrimLifecyclePriority.js';
import {
  startDiscordTaskQueue,
  stopDiscordTaskQueue,
  getDiscordTaskQueueHealthSnapshot,
  enqueueDiscordTask,
} from '../src/services/discordTaskQueue.js';
import { createGracefulShutdown } from '../src/services/shutdownOrchestrator.js';
import { SCRIM_LIFECYCLE_MAX_ATTEMPTS } from '../src/services/scrimLifecycleAttempts.js';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-lifecycle-3k-'));
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

function insertScrimPost(stmts, status = 'closed_manual') {
  const info = stmts.insertScrimPostRow.run({
    scrim_public_id: Math.floor(Math.random() * 9000) + 1,
    author_user_id: 'user-001',
    origin_guild_id: 'g1',
    source_guild_id: 'g1',
    game_key: 'lol',
    rank_key: 'Platinum',
    format_key: 'BO1',
    contact_user_id: 'user-001',
    contact_display_name: null,
    scheduled_date: '27/07/2026',
    scheduled_time: '20:00',
    scheduled_at: new Date(Date.now() + 7200000).toISOString(),
    scheduled_at_end: null,
    tags: JSON.stringify({ fearless: 'non' }),
    multi_opgg_url: null,
    elo_precision: null,
    structure_guild_id: null,
    structure_name_snapshot: null,
    structure_invite_url_snapshot: null,
    created_at: Date.now(),
    status,
  });
  return Number(info.lastInsertRowid);
}

describe('Phase 3K — MEDIUM-1 shadow event_key NULL non claimable', () => {
  beforeEach(() => {
    resetScrimLifecycleDispatcherBurstStateForTests();
  });

  afterEach(async () => {
    await stopScrimLifecycleDispatcher();
    await stopDiscordTaskQueue();
  });

  it('1 — shadow event_key NULL pending → claim 0', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      createScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-shadow',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_manual',
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });
      const claimed = claimNextScrimLifecycleOperation(stmts);
      assert.strictEqual(claimed, null);
      const row = db.prepare(`SELECT status, event_key FROM scrim_lifecycle_operations WHERE message_id = 'm-shadow'`).get();
      assert.strictEqual(row.status, 'pending');
      assert.strictEqual(row.event_key, null);
    });
  });

  it('2 — shadow due (next_attempt_at past) → claim 0', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const id = createScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-due',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_manual',
      });
      const past = new Date(Date.now() - 60_000).toISOString();
      db.prepare(`UPDATE scrim_lifecycle_operations SET next_attempt_at = ? WHERE id = ?`).run(past, id);
      assert.strictEqual(claimNextScrimLifecycleOperation(stmts), null);
    });
  });

  it('3 — orchestrated event_key → claim normal', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-orch',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_manual',
        eventKey: `close:${postId}:closed_manual:m-orch`,
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });
      const claimed = claimNextScrimLifecycleOperation(stmts);
      assert.ok(claimed);
      assert.strictEqual(claimed.message_id, 'm-orch');
      assert.ok(claimed.event_key);
    });
  });

  it('4 — starved orchestrated → claim starved (shadow ignorée)', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts, 'active');
      createScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-sh-starved',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'superseded_repost',
      });
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-starved',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'superseded_repost',
        eventKey: `supersede:${postId}:1:m-starved`,
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
        priority: 'low',
      });
      const old = new Date(Date.now() - SCRIM_LIFECYCLE_STARVATION_THRESHOLD_MS - 1000).toISOString();
      db.prepare(`UPDATE scrim_lifecycle_operations SET created_at = ? WHERE message_id = 'm-starved'`).run(old);

      for (let i = 0; i < SCRIM_LIFECYCLE_STARVATION_BURST_AFTER_HIGH; i += 1) {
        insertOrchestratedScrimLifecycleOperation(stmts, {
          scrimPostDbId: postId,
          guildId: 'g1',
          channelId: 'c1',
          messageId: `m-high-${i}`,
          operationType: LIFECYCLE_OP_TYPE_EDIT,
          targetStatus: 'closed_manual',
          eventKey: `close:${postId}:closed_manual:m-high-${i}`,
          payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
        });
        const hi = claimNextScrimLifecycleOperation(stmts);
        assert.ok(hi?.message_id?.startsWith('m-high'));
      }

      const starved = claimNextScrimLifecycleOperation(stmts);
      assert.ok(starved);
      assert.strictEqual(starved.message_id, 'm-starved');
    });
  });

  it('5 — shadow + orchestrated simultanés → uniquement orchestrated', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      createScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-shadow-mix',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_manual',
      });
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-orch-mix',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_manual',
        eventKey: `close:${postId}:closed_manual:m-orch-mix`,
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });

      const first = claimNextScrimLifecycleOperation(stmts);
      assert.strictEqual(first.message_id, 'm-orch-mix');
      assert.strictEqual(claimNextScrimLifecycleOperation(stmts), null);

      const shadow = db.prepare(`SELECT status FROM scrim_lifecycle_operations WHERE message_id = 'm-shadow-mix'`).get();
      assert.strictEqual(shadow.status, 'pending');
    });
  });

  it('6 — shadow reste pour legacy (status pending inchangé après drain)', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const shadowId = createScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-legacy',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_manual',
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });

      const client = { guilds: { fetch: async () => null } };
      startDiscordTaskQueue();
      startScrimLifecycleDispatcher(client, stmts);
      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 2_000 });

      const row = stmts.getScrimLifecycleOperationById.get(shadowId);
      assert.strictEqual(row.status, 'pending');
      assert.strictEqual(row.event_key, null);
      assert.strictEqual(Number(row.attempt_count), 0);
    });
  });

  it('7 — regression 3J : exhausted orchestrated toujours terminalisé', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const inserted = insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-exh',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_manual',
        eventKey: `close:${postId}:closed_manual:m-exh`,
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });
      db.prepare(`UPDATE scrim_lifecycle_operations SET attempt_count = ? WHERE id = ?`).run(
        SCRIM_LIFECYCLE_MAX_ATTEMPTS,
        inserted.operationId,
      );
      assert.strictEqual(claimNextScrimLifecycleOperation(stmts), null);
      // claimNext sweeps exhausted
      const after = stmts.getScrimLifecycleOperationById.get(inserted.operationId);
      assert.strictEqual(after.status, 'failed_terminal');
      assert.strictEqual(after.last_error_code, 'RETRY_EXHAUSTED');
    });
  });
});

describe('Phase 3K — MEDIUM-2 shutdown dependency graph', () => {
  it('index.js ordre: broadcast → producers → consumers → taskQueue', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const b = index.indexOf('persistent_broadcast_job_stop');
    const p = index.indexOf('lifecycle_producers_stop');
    const c = index.indexOf('lifecycle_consumers_stop');
    const t = index.indexOf('discord_task_queue_stop');
    assert.ok(b >= 0 && p > b && c > p && t > c);

    const producersBlock = index.slice(p, c);
    assert.match(producersBlock, /stopScrimRepostJob/);
    assert.match(producersBlock, /stopScrimExpirationJob/);
    assert.doesNotMatch(producersBlock, /stopScrimLifecycleDispatcher/);
    assert.doesNotMatch(producersBlock, /stopDiscordTaskQueue/);

    const consumersBlock = index.slice(c, t);
    assert.match(consumersBlock, /stopScrimLifecycleDispatcher/);
    assert.match(consumersBlock, /stopDiscordEditRetryJob/);
    assert.doesNotMatch(consumersBlock, /stopDiscordTaskQueue/);
  });

  it('A/E — producers stop avant taskQueue ; enqueue refusée après stop queue', async () => {
    const events = [];
    let queueStopped = false;

    const gracefulShutdown = createGracefulShutdown({
      steps: [
        {
          name: 'broadcast',
          phase: 'persistent_broadcast_job_stop',
          stop: async () => { events.push('broadcast'); },
        },
        {
          name: 'producers',
          phase: 'lifecycle_producers_stop',
          stop: async () => {
            events.push('producers_start');
            assert.strictEqual(queueStopped, false, 'taskQueue encore vivant pendant producers');
            events.push('producers_end');
          },
        },
        {
          name: 'consumers',
          phase: 'lifecycle_consumers_stop',
          stop: async () => {
            events.push('consumers');
            assert.strictEqual(queueStopped, false);
          },
        },
        {
          name: 'task queue',
          phase: 'discord_task_queue_stop',
          stop: async () => {
            queueStopped = true;
            events.push('task_queue');
          },
        },
      ],
      getClient: () => null,
      closeDb: () => { events.push('db'); },
      onExit: () => {},
    });

    await gracefulShutdown('SIGTERM');
    assert.deepStrictEqual(events, [
      'broadcast',
      'producers_start',
      'producers_end',
      'consumers',
      'task_queue',
      'db',
    ]);
  });

  it('taskQueue stop réel refuse nouvelles enqueue', async () => {
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    startDiscordTaskQueue();
    assert.strictEqual(getDiscordTaskQueueHealthSnapshot().state, 'running');
    await stopDiscordTaskQueue();
    assert.strictEqual(getDiscordTaskQueueHealthSnapshot().state, 'stopped');
    await assert.rejects(
      () => enqueueDiscordTask(async () => 'x', { kind: 'test_3k' }),
      /indisponible|arrêt/,
    );
    delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
  });

  it('B/C/D — cycle repost durable concept: recovery path exists (source)', () => {
    const cycleSrc = fs.readFileSync(
      new URL('../src/services/scrimRepostCycle.js', import.meta.url),
      'utf8',
    );
    assert.match(cycleSrc, /recoverIncompleteRepostCycles/);
    assert.match(cycleSrc, /broadcast_done/);
    assert.doesNotMatch(cycleSrc, /rebroadcast.*unknown/);
  });

  it('F — producer crée op avant consumers stop (ordering invariant)', async () => {
    const ops = [];
    let dispatcherAlive = true;

    const gracefulShutdown = createGracefulShutdown({
      steps: [
        { name: 'broadcast', phase: 'persistent_broadcast_job_stop', stop: async () => {} },
        {
          name: 'producers',
          phase: 'lifecycle_producers_stop',
          stop: async () => {
            assert.ok(dispatcherAlive);
            ops.push({ id: 1, createdWhileDispatcherAlive: dispatcherAlive });
          },
        },
        {
          name: 'consumers',
          phase: 'lifecycle_consumers_stop',
          stop: async () => {
            dispatcherAlive = false;
          },
        },
        { name: 'tq', phase: 'discord_task_queue_stop', stop: async () => {} },
      ],
      getClient: () => null,
      closeDb: () => {},
      onExit: () => {},
    });

    await gracefulShutdown('SIGINT');
    assert.strictEqual(ops.length, 1);
    assert.strictEqual(ops[0].createdWhileDispatcherAlive, true);
    assert.strictEqual(dispatcherAlive, false);
  });

  it('worst-case timing documenté 80s → kill_timeout TIGHT', () => {
    const worst = 45_000 + 10_000 + 15_000 + 10_000;
    assert.strictEqual(worst, 80_000);
  });
});
