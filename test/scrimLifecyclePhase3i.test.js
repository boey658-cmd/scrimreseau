/**
 * Phase 3I — fallback edit durable + shutdown parallèle + close sans drain bloquant
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { EmbedBuilder, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import {
  claimNextScrimLifecycleOperation,
  drainScrimLifecycleDispatcher,
  startScrimLifecycleDispatcher,
  stopScrimLifecycleDispatcher,
} from '../src/services/scrimLifecycleDispatcher.js';
import {
  insertOrchestratedScrimLifecycleOperation,
  LIFECYCLE_OP_TYPE_DELETE,
  LIFECYCLE_OP_TYPE_EDIT,
} from '../src/services/scrimLifecycleOperationStore.js';
import {
  buildCloseFallbackEditEventKey,
  ensureCloseFallbackEditOperation,
  executeOrchestratedLifecycleOperation,
  executeOrchestratedLifecycleOperations,
  orchestrateScrimCloseInTransaction,
  closeScrimPostByDbIdAndExecuteLifecycle,
} from '../src/services/scrimLifecycleOrchestrator.js';
import {
  startDiscordTaskQueue,
  stopDiscordTaskQueue,
} from '../src/services/discordTaskQueue.js';
import { createGracefulShutdown } from '../src/services/shutdownOrchestrator.js';
import { runScrimExpirationPass } from '../src/services/scrimExpirationJob.js';
import {
  startScrimExpirationJob,
  stopScrimExpirationJob,
} from '../src/services/scrimExpirationJob.js';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-lifecycle-3i-'));
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

function buildDeleteFallbackMockClient(options = {}) {
  let deleteCalls = 0;
  let editCalls = 0;
  const deleteErr = options.deleteErr ?? Object.assign(new Error('Missing Permissions'), { code: 50013 });
  const editFn = options.editFn ?? (async () => {});

  const messageObj = {
    id: options.messageId ?? 'm-fb',
    guildId: options.guildId ?? 'g1',
    channelId: options.channelId ?? 'c1',
    delete: async () => {
      deleteCalls += 1;
      if (deleteErr) throw deleteErr;
    },
    edit: async (...args) => {
      editCalls += 1;
      return editFn(...args);
    },
  };

  const botMember = {
    id: 'bot',
    permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
  };

  const client = {
    guilds: {
      fetch: async () => ({
        members: { me: botMember, fetchMe: async () => botMember },
        channels: {
          fetch: async () => ({
            isTextBased: () => true,
            permissionsFor: () => new PermissionsBitField(PermissionFlagsBits.Administrator),
            messages: { fetch: async () => messageObj },
          }),
        },
      }),
    },
  };

  return {
    client,
    counters: {
      get deleteCalls() { return deleteCalls; },
      get editCalls() { return editCalls; },
    },
    messageObj,
  };
}

describe('Phase 3I — HIGH-NEW-1 fallback lifecycle_edit', () => {
  beforeEach(() => {
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    process.env.DISCORD_API_MAX_ATTEMPTS = '1';
  });

  afterEach(async () => {
    await stopScrimLifecycleDispatcher();
    await stopDiscordTaskQueue();
    delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    delete process.env.DISCORD_API_MAX_ATTEMPTS;
  });

  it('A — delete terminal 50013 → fallback edit success (ops distinctes)', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const now = new Date().toISOString();
      db.prepare('UPDATE scrim_posts SET closed_at = ? WHERE id = ?').run(now, postId);

      const inserted = insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-a',
        operationType: LIFECYCLE_OP_TYPE_DELETE,
        targetStatus: 'closed_manual',
        eventKey: `close:${postId}:closed_manual:m-a`,
      });

      const { client, counters } = buildDeleteFallbackMockClient({ messageId: 'm-a' });

      startDiscordTaskQueue();
      startScrimLifecycleDispatcher(client, stmts);

      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 15_000 });

      assert.strictEqual(counters.deleteCalls, 1);
      assert.strictEqual(counters.editCalls, 1);

      const deleteFresh = stmts.getScrimLifecycleOperationById.get(inserted.operationId);
      assert.strictEqual(deleteFresh.status, 'failed_terminal');

      const fbKey = buildCloseFallbackEditEventKey(postId, 'closed_manual', 'm-a');
      const fbFresh = stmts.getScrimLifecycleOperationByEventKey.get(fbKey);
      assert.strictEqual(fbFresh.status, 'completed');
    });
  });

  it('B — delete terminal → fallback edit 503 → retry dispatcher → success', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const now = new Date().toISOString();
      db.prepare('UPDATE scrim_posts SET closed_at = ? WHERE id = ?').run(now, postId);

      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-b',
        operationType: LIFECYCLE_OP_TYPE_DELETE,
        targetStatus: 'closed_manual',
        eventKey: `close:${postId}:closed_manual:m-b`,
      });

      let editAttempts = 0;
      const err503 = Object.assign(new Error('Service Unavailable'), { status: 503 });
      const { client, counters } = buildDeleteFallbackMockClient({
        messageId: 'm-b',
        editFn: async () => {
          editAttempts += 1;
          if (editAttempts === 1) throw err503;
        },
      });

      startDiscordTaskQueue();
      startScrimLifecycleDispatcher(client, stmts);
      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 15_000 });

      const fbKey = buildCloseFallbackEditEventKey(postId, 'closed_manual', 'm-b');
      let fbOp = stmts.getScrimLifecycleOperationByEventKey.get(fbKey);
      assert.ok(fbOp.next_attempt_at, 'retry planifié après 503');
      assert.strictEqual(counters.editCalls, 1);

      db.prepare(`
        UPDATE scrim_lifecycle_operations
        SET next_attempt_at = ?, status = 'pending', updated_at = ?
        WHERE id = ?
      `).run(now, now, fbOp.id);

      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 15_000 });

      fbOp = stmts.getScrimLifecycleOperationByEventKey.get(fbKey);
      assert.strictEqual(fbOp.status, 'completed');
      assert.strictEqual(counters.editCalls, 2);
    });
  });

  it('C — restart : fallback edit pending reprise au startup dispatcher', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const now = new Date().toISOString();
      db.prepare('UPDATE scrim_posts SET closed_at = ? WHERE id = ?').run(now, postId);

      ensureCloseFallbackEditOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-c',
        targetStatus: 'closed_manual',
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });

      const { client, counters } = buildDeleteFallbackMockClient({ messageId: 'm-c' });

      startDiscordTaskQueue();
      startScrimLifecycleDispatcher(client, stmts);
      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 15_000 });

      assert.strictEqual(counters.editCalls, 1);
      const fbKey = buildCloseFallbackEditEventKey(postId, 'closed_manual', 'm-c');
      assert.strictEqual(
        stmts.getScrimLifecycleOperationByEventKey.get(fbKey).status,
        'completed',
      );
    });
  });

  it('D — event_key dedupe : une seule op fallback', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const payload = JSON.stringify({ v: 2, content: null, embeds: [] });
      const p = {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-d',
        targetStatus: /** @type {'closed_manual'} */ ('closed_manual'),
        payloadJson: payload,
      };
      const a = ensureCloseFallbackEditOperation(stmts, p);
      const b = ensureCloseFallbackEditOperation(stmts, p);
      assert.ok(a.operationId);
      assert.strictEqual(b.deduplicated, true);
      assert.strictEqual(b.operationId, a.operationId);

      const count = db.prepare(
        `SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE event_key LIKE 'close-fallback-edit:%'`,
      ).get();
      assert.strictEqual(Number(count.n), 1);
    });
  });

  it('E — fallback edit stale si scrim redevient incompatible (cancelled)', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts, 'active');
      const inserted = insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-e',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_manual',
        eventKey: buildCloseFallbackEditEventKey(postId, 'closed_manual', 'm-e'),
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });

      stmts.claimScrimLifecycleOperationForDispatcher.run({
        id: inserted.operationId,
        started_at: new Date().toISOString(),
        last_dispatched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      const op = stmts.getScrimLifecycleOperationById.get(inserted.operationId);

      let edits = 0;
      const client = {
        guilds: {
          fetch: async () => ({
            channels: {
              fetch: async () => ({
                isTextBased: () => true,
                messages: {
                  fetch: async () => ({
                    edit: async () => { edits += 1; },
                  }),
                },
              }),
            },
          }),
        },
      };

      const out = await executeOrchestratedLifecycleOperation(client, stmts, op, {
        fromDispatcher: true,
      });
      assert.strictEqual(out, 'skipped');
      assert.strictEqual(edits, 0);
      assert.strictEqual(
        stmts.getScrimLifecycleOperationById.get(inserted.operationId).status,
        'cancelled',
      );
    });
  });

  it('F — fallback edit terminal 50013 → failed_terminal, pas de boucle', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const now = new Date().toISOString();
      db.prepare('UPDATE scrim_posts SET closed_at = ? WHERE id = ?').run(now, postId);

      ensureCloseFallbackEditOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-f',
        targetStatus: 'closed_manual',
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [new EmbedBuilder().toJSON()] }),
      });

      const err50013 = Object.assign(new Error('Missing Permissions'), { code: 50013 });
      const { client, counters } = buildDeleteFallbackMockClient({
        messageId: 'm-f',
        deleteErr: null,
        editFn: async () => { throw err50013; },
      });

      startDiscordTaskQueue();
      startScrimLifecycleDispatcher(client, stmts);
      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 15_000 });
      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 5_000 });

      assert.strictEqual(counters.editCalls, 1);
      const fbKey = buildCloseFallbackEditEventKey(postId, 'closed_manual', 'm-f');
      const fbOp = stmts.getScrimLifecycleOperationByEventKey.get(fbKey);
      assert.strictEqual(fbOp.status, 'failed_terminal');
      assert.strictEqual(fbOp.next_attempt_at, null);
    });
  });
});

describe('Phase 3I — delete transient 3C inchangé', () => {
  it('503 delete → lifecycle_delete pending retry, pas de fallback op', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const now = new Date().toISOString();
      db.prepare('UPDATE scrim_posts SET closed_at = ? WHERE id = ?').run(now, postId);

      const inserted = insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-503',
        operationType: LIFECYCLE_OP_TYPE_DELETE,
        targetStatus: 'closed_manual',
        eventKey: `close:${postId}:closed_manual:m-503`,
      });
      stmts.claimScrimLifecycleOperationForDispatcher.run({
        id: inserted.operationId,
        started_at: now,
        last_dispatched_at: now,
        updated_at: now,
      });
      const deleteOp = stmts.getScrimLifecycleOperationById.get(inserted.operationId);

      const err503 = Object.assign(new Error('Service Unavailable'), { status: 503 });
      const { client, counters } = buildDeleteFallbackMockClient({
        messageId: 'm-503',
        deleteErr: err503,
      });

      process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
      startDiscordTaskQueue();
      const out = await executeOrchestratedLifecycleOperation(client, stmts, deleteOp, {
        fromDispatcher: true,
      });
      await stopDiscordTaskQueue();

      assert.strictEqual(out, 'queued');
      assert.strictEqual(counters.deleteCalls, 1);
      assert.strictEqual(counters.editCalls, 0);

      const fresh = stmts.getScrimLifecycleOperationById.get(inserted.operationId);
      assert.strictEqual(fresh.status, 'pending');
      assert.ok(fresh.next_attempt_at);

      const fbCount = db.prepare(
        `SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE event_key LIKE 'close-fallback-edit:%'`,
      ).get();
      assert.strictEqual(Number(fbCount.n), 0);
    });
  });
});

describe('Phase 3I — MED-NEW-2 close/expiration sans drain bloquant', () => {
  it('closeScrimPostByDbIdAndExecuteLifecycle wake-only (pas await drain)', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts, 'active');
      db.prepare(`
        INSERT INTO scrim_post_messages (scrim_post_db_id, guild_id, channel_id, message_id)
        VALUES (?, 'g1', 'c1', 'm-close')
      `).run(postId);

      const client = { guilds: { fetch: async () => null } };
      const started = Date.now();
      const closed = await closeScrimPostByDbIdAndExecuteLifecycle(
        client,
        db,
        stmts,
        postId,
        'closed_manual',
        'test',
      );
      const elapsed = Date.now() - started;

      assert.strictEqual(closed, true);
      assert.ok(elapsed < 500, `close ne doit pas bloquer sur drain (${elapsed}ms)`);

      const pending = db.prepare(
        `SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE status = 'pending' AND event_key IS NOT NULL`,
      ).get();
      assert.ok(Number(pending.n) >= 1);
    });
  });

  it('executeOrchestratedLifecycleOperations ne draine pas', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts, 'active');
      const { operations } = orchestrateScrimCloseInTransaction(
        db,
        stmts,
        postId,
        'closed_manual',
        'test',
      );
      assert.ok(operations.length >= 0);

      const client = { guilds: { fetch: async () => null } };
      const t0 = Date.now();
      executeOrchestratedLifecycleOperations(client, stmts, operations);
      assert.ok(Date.now() - t0 < 50);
    });
  });
});

describe('Phase 3I — MED-NEW-1 shutdown', () => {
  it('A — index.js : broadcast stop en premier (3K graph)', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const broadcastIdx = index.indexOf('persistent_broadcast_job_stop');
    const producersIdx = index.indexOf('lifecycle_producers_stop');
    assert.ok(broadcastIdx >= 0);
    assert.ok(producersIdx > broadcastIdx);
  });

  it('B/C — shutdown producers puis consumers (ordering)', async () => {
    const order = [];
    const mkStop = (name, ms = 5) => async () => {
      order.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end:${name}`);
    };

    const gracefulShutdown = createGracefulShutdown({
      steps: [
        { name: 'broadcast', phase: 'persistent_broadcast_job_stop', stop: mkStop('broadcast', 20) },
        {
          name: 'producers',
          phase: 'lifecycle_producers_stop',
          stop: async () => {
            await Promise.all([
              mkStop('repost', 30)(),
              mkStop('expiration', 25)(),
            ]);
          },
        },
        {
          name: 'consumers',
          phase: 'lifecycle_consumers_stop',
          stop: async () => {
            await Promise.all([
              mkStop('dispatcher', 35)(),
              mkStop('edit_retry', 28)(),
            ]);
          },
        },
        {
          name: 'task queue',
          phase: 'discord_task_queue_stop',
          stop: mkStop('task_queue', 10),
        },
      ],
      getClient: () => null,
      closeDb: () => { order.push('closeDb'); },
      onExit: () => {},
    });

    const started = Date.now();
    await gracefulShutdown('SIGTERM');
    const elapsed = Date.now() - started;

    assert.ok(order.indexOf('start:broadcast') < order.indexOf('start:repost'));
    assert.ok(order.indexOf('end:repost') < order.indexOf('start:dispatcher'));
    assert.ok(order.indexOf('end:dispatcher') < order.indexOf('start:task_queue'));
    assert.ok(elapsed < 200, `ordered shutdown trop lent (${elapsed}ms)`);
  });

  it('G — worst-case théorique code-side documenté (45+10+15+10=80s, TIGHT vs 60)', () => {
    const BROADCAST_MS = 45_000;
    const PRODUCERS_MS = 10_000;
    const CONSUMERS_MS = 15_000;
    const TASK_QUEUE_MS = 10_000;
    const total = BROADCAST_MS + PRODUCERS_MS + CONSUMERS_MS + TASK_QUEUE_MS;
    assert.strictEqual(total, 80_000);
    assert.ok(total > 60_000, 'ordre dépendances force >60s — kill_timeout 75–90s recommandé');
  });
});

describe('Phase 3I — expiration stop sans drain long', () => {
  it('expiration pass + stop : pas de blocage 30s drain', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts, 'active');
      const past = new Date(Date.now() - 3600000).toISOString();
      db.prepare('UPDATE scrim_posts SET scheduled_at = ? WHERE id = ?').run(past, postId);

      const client = { guilds: { fetch: async () => null } };

      startScrimExpirationJob(client, db, stmts);
      const passPromise = runScrimExpirationPass(client, db, stmts);

      const stopPromise = stopScrimExpirationJob();
      const started = Date.now();
      await Promise.all([passPromise, stopPromise]);
      const elapsed = Date.now() - started;

      assert.ok(elapsed < 5000, `expiration stop/pass trop lent (${elapsed}ms)`);
      const row = stmts.getScrimPostById.get(postId);
      assert.ok(row.status === 'closed_expired' || row.status === 'active');
    });
  });
});
