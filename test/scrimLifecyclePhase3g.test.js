/**
 * Phase 3G — durcissement final (B1, H1, H2, H3, M1)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import {
  runScrimBroadcastDeliveryPass,
} from '../src/services/scrimBroadcastDeliveryJob.js';
import {
  claimNextScrimLifecycleOperation,
  drainScrimLifecycleDispatcher,
  getScrimLifecycleDispatcherHealthSnapshot,
  runScrimLifecycleDispatcherPass,
  startScrimLifecycleDispatcher,
  stopScrimLifecycleDispatcher,
  wakeScrimLifecycleDispatcher,
} from '../src/services/scrimLifecycleDispatcher.js';
import {
  insertOrchestratedScrimLifecycleOperation,
  LIFECYCLE_OP_TYPE_DELETE,
  LIFECYCLE_OP_TYPE_EDIT,
} from '../src/services/scrimLifecycleOperationStore.js';
import {
  orchestrateScrimCloseInTransaction,
  orchestrateScrimCloseIntentionsForMessages,
  executeOrchestratedLifecycleOperation,
} from '../src/services/scrimLifecycleOrchestrator.js';
import { SCRIM_LIFECYCLE_STARVATION_THRESHOLD_MS } from '../src/services/scrimLifecyclePriority.js';
import {
  startDiscordTaskQueue,
  stopDiscordTaskQueue,
} from '../src/services/discordTaskQueue.js';
import { createGracefulShutdown } from '../src/services/shutdownOrchestrator.js';
import {
  resetBroadcastPoolForTests,
  invalidateBroadcastConcurrencyCache,
} from '../src/services/scrimBroadcastExecutionPool.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-lifecycle-3g-'));
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
  const info = stmts.insertScrimPostRow.run({
    scrim_public_id: Math.floor(Math.random() * 9000) + 1,
    author_user_id: 'user-001',
    origin_guild_id: 'guild-001',
    source_guild_id: 'guild-001',
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

function insertTestBatch(stmts, scrimPostDbId) {
  const now = new Date().toISOString();
  const info = stmts.insertScrimBroadcastBatch.run({
    scrim_post_db_id: scrimPostDbId,
    operation_type: 'initial',
    generation: 0,
    target_count: 1,
    created_at: now,
    updated_at: now,
  });
  const batchId = Number(info.lastInsertRowid);
  stmts.setScrimBroadcastBatchActive.run({ id: batchId, started_at: now, updated_at: now });
  return batchId;
}

function insertTestDelivery(stmts, batchId, scrimPostDbId) {
  const now = new Date().toISOString();
  const info = stmts.insertScrimBroadcastDelivery.run({
    batch_id: batchId,
    scrim_post_db_id: scrimPostDbId,
    guild_id: 'guild-001',
    channel_id: 'chan-001',
    game_key: 'lol',
    operation_type: 'initial',
    generation: 0,
    priority: 0,
    next_attempt_at: now,
    created_at: now,
    updated_at: now,
  });
  return Number(info.lastInsertRowid);
}

function buildMockGuild(guildId, channelMap = {}) {
  const botMember = {
    id: 'bot-scrim',
    permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
  };
  return {
    id: guildId,
    channels: {
      cache: new Map(Object.entries(channelMap)),
      fetch: async (id) => channelMap[id] ?? null,
    },
    members: {
      me: botMember,
      fetchMe: async () => botMember,
    },
  };
}

function buildMockClient(guildMap = {}) {
  return {
    guilds: {
      cache: new Map(Object.entries(guildMap)),
      fetch: async (id) => guildMap[id] ?? null,
    },
  };
}

function buildCloseDuringSendLifecycleChannel(options = {}) {
  const lifecycle = { edit: 0, delete: 0, phase2Edit: 0, phase2Delete: 0 };
  const messageId = options.messageId ?? 'msg-close-during-send';
  const messageObj = {
    id: messageId,
    guildId: 'guild-001',
    channelId: 'chan-001',
    edit: async () => {
      lifecycle.edit += 1;
      if (options.editThrows) throw options.editThrows;
      return {};
    },
    delete: async () => {
      lifecycle.delete += 1;
      if (options.deleteThrows) throw options.deleteThrows;
    },
  };
  const channel = {
    id: 'chan-001',
    type: ChannelType.GuildText,
    isTextBased: () => true,
    permissionsFor: () => new PermissionsBitField([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageMessages,
    ]),
    send: async () => {
      if (options.onSend) options.onSend();
      return messageObj;
    },
    messages: {
      fetch: async () => messageObj,
    },
  };
  return { channel, lifecycle, messageId };
}

function buildLifecycleMockClient(options = {}) {
  const sendCount = { n: 0 };
  const lifecycleEditCount = { n: 0 };
  const lifecycleDeleteCount = { n: 0 };
  const phase2DirectEditCount = { n: 0 };
  const phase2DirectDeleteCount = { n: 0 };
  let activeLifecycleCalls = 0;
  let maxActiveLifecycleCalls = 0;

  const messageId = options.messageId ?? 'msg-close-during-send';
  const messageObj = {
    id: messageId,
    guildId: 'guild-001',
    channelId: 'chan-001',
    edit: async () => {
      activeLifecycleCalls += 1;
      maxActiveLifecycleCalls = Math.max(maxActiveLifecycleCalls, activeLifecycleCalls);
      lifecycleEditCount.n += 1;
      if (options.editDelayMs) await sleep(options.editDelayMs);
      activeLifecycleCalls -= 1;
      if (options.editThrows) throw options.editThrows;
      return {};
    },
    delete: async () => {
      activeLifecycleCalls += 1;
      maxActiveLifecycleCalls = Math.max(maxActiveLifecycleCalls, activeLifecycleCalls);
      lifecycleDeleteCount.n += 1;
      if (options.deleteDelayMs) await sleep(options.deleteDelayMs);
      activeLifecycleCalls -= 1;
      if (options.deleteThrows) throw options.deleteThrows;
    },
  };

  const channel = {
    id: 'chan-001',
    type: ChannelType.GuildText,
    isTextBased: () => true,
    permissionsFor: () => new PermissionsBitField([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageMessages,
    ]),
    send: async () => {
      sendCount.n += 1;
      if (options.onSend) options.onSend();
      return {
        ...messageObj,
        edit: async () => {
          phase2DirectEditCount.n += 1;
          return messageObj.edit();
        },
        delete: async () => {
          phase2DirectDeleteCount.n += 1;
          return messageObj.delete();
        },
      };
    },
    messages: {
      fetch: async () => messageObj,
    },
  };

  const guild = {
    id: 'guild-001',
    channels: {
      fetch: async () => channel,
    },
    members: {
      me: { id: 'bot-scrim', permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) },
      fetchMe: async () => ({ id: 'bot-scrim' }),
    },
  };

  const client = {
    guilds: {
      fetch: async () => guild,
    },
  };

  return {
    client,
    counters: {
      sendCount,
      lifecycleEditCount,
      lifecycleDeleteCount,
      phase2DirectEditCount,
      phase2DirectDeleteCount,
      get maxActiveLifecycleCalls() {
        return maxActiveLifecycleCalls;
      },
    },
  };
}

async function runDeliveryWithLifecycle(client, db, stmts) {
  process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
  process.env.DISCORD_API_MAX_ATTEMPTS = '1';
  process.env.SCRIM_BROADCAST_CONCURRENCY = '1';
  invalidateBroadcastConcurrencyCache();
  resetBroadcastPoolForTests();
  startDiscordTaskQueue();
  startScrimLifecycleDispatcher(client, stmts);
  try {
    await runScrimBroadcastDeliveryPass(client, db, stmts);
    await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 15_000 });
    await sleep(30);
  } finally {
    await stopScrimLifecycleDispatcher();
    await stopDiscordTaskQueue();
  }
}

describe('Phase 3G — B1 close-during-send KEEP', () => {
  it('exactement 1 lifecycle edit, 0 appel Phase 2 direct', async () => {
    await withTempDb(async (db, stmts) => {
      const scrimId = insertScrimPost(stmts);
      const batchId = insertTestBatch(stmts, scrimId);
      const delivId = insertTestDelivery(stmts, batchId, scrimId);
      const now = new Date().toISOString();
      const { channel, lifecycle } = buildCloseDuringSendLifecycleChannel({
        onSend: () => {
          db.prepare("UPDATE scrim_posts SET status = 'closed_manual', closed_at = ? WHERE id = ?").run(now, scrimId);
        },
      });
      const mockClient = buildMockClient({ 'guild-001': buildMockGuild('guild-001', { 'chan-001': channel }) });

      await runDeliveryWithLifecycle(mockClient, db, stmts);

      const ops = db.prepare(
        `SELECT * FROM scrim_lifecycle_operations WHERE message_id = ? AND event_key IS NOT NULL`,
      ).all('msg-close-during-send');
      assert.strictEqual(ops.length, 1, 'exactement 1 op orchestrée');
      assert.strictEqual(lifecycle.edit, 1);
      assert.strictEqual(lifecycle.delete, 0);

      const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
      assert.strictEqual(d.status, 'sent');

      const shadow = db.prepare(
        `SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE message_id = ? AND event_key IS NULL`,
      ).get('msg-close-during-send');
      assert.strictEqual(Number(shadow.n), 0);
    });
  });
});

describe('Phase 3G — B1 close-during-send DELETE', () => {
  it('exactement 1 lifecycle delete, 0 appel Phase 2 direct', async () => {
    await withTempDb(async (db, stmts) => {
      const scrimId = insertScrimPost(stmts);
      const batchId = insertTestBatch(stmts, scrimId);
      insertTestDelivery(stmts, batchId, scrimId);
      const now = new Date().toISOString();
      stmts.upsertScrimMessageLifecyclePolicy.run({
        guild_id: 'guild-001',
        policy: 'delete',
        updated_at: now,
      });

      const { channel, lifecycle } = buildCloseDuringSendLifecycleChannel({
        onSend: () => {
          db.prepare("UPDATE scrim_posts SET status = 'closed_manual', closed_at = ? WHERE id = ?").run(now, scrimId);
        },
      });
      const mockClient = buildMockClient({ 'guild-001': buildMockGuild('guild-001', { 'chan-001': channel }) });

      await runDeliveryWithLifecycle(mockClient, db, stmts);

      assert.strictEqual(lifecycle.delete, 1);
      assert.strictEqual(lifecycle.edit, 0);

      const msgRow = db.prepare(
        'SELECT discord_deleted_at FROM scrim_post_messages WHERE message_id = ?',
      ).get('msg-close-during-send');
      assert.ok(msgRow?.discord_deleted_at);
    });
  });
});

describe('Phase 3G — B1 dedupe event_key existante', () => {
  it('op close déjà présente → 1 seul Discord edit', async () => {
    await withTempDb(async (db, stmts) => {
      const scrimId = insertScrimPost(stmts, 'closed_manual');
      const now = new Date().toISOString();
      db.prepare('UPDATE scrim_posts SET closed_at = ? WHERE id = ?').run(now, scrimId);

      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: scrimId,
        guildId: 'guild-001',
        channelId: 'chan-001',
        messageId: 'msg-dedupe',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_manual',
        eventKey: `close:${scrimId}:closed_manual:msg-dedupe`,
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });

      db.prepare(`
        INSERT INTO scrim_post_messages (scrim_post_db_id, guild_id, channel_id, message_id)
        VALUES (?, 'guild-001', 'chan-001', 'msg-dedupe')
      `).run(scrimId);

      const editCount = { n: 0 };
      const messageObj = {
        id: 'msg-dedupe',
        edit: async () => { editCount.n += 1; },
      };
      const channel = {
        isTextBased: () => true,
        messages: { fetch: async () => messageObj },
      };
      const client = {
        guilds: {
          fetch: async () => ({
            channels: { fetch: async () => channel },
          }),
        },
      };

      const { operations } = orchestrateScrimCloseIntentionsForMessages(db, stmts, scrimId, [{
        guild_id: 'guild-001',
        channel_id: 'chan-001',
        message_id: 'msg-dedupe',
      }]);
      const opCount = db.prepare(
        `SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE event_key = ?`,
      ).get(`close:${scrimId}:closed_manual:msg-dedupe`);
      assert.strictEqual(Number(opCount.n), 1, 'dedupe — une seule op en DB');
      assert.ok(operations.length <= 1);

      startDiscordTaskQueue();
      startScrimLifecycleDispatcher(client, stmts);
      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 15_000 });
      await stopScrimLifecycleDispatcher();
      await stopDiscordTaskQueue();

      assert.strictEqual(editCount.n, 1);
      const ops = db.prepare(
        `SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE event_key = ?`,
      ).get(`close:${scrimId}:closed_manual:msg-dedupe`);
      assert.strictEqual(Number(ops.n), 1);
    });
  });
});

describe('Phase 3G — H1 concurrency cap', () => {
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

  async function runConcurrencyTimingTest(concurrency, opCount, editDelayMs) {
    delete process.env.SCRIM_LIFECYCLE_CONCURRENCY;
    process.env.SCRIM_LIFECYCLE_CONCURRENCY = String(concurrency);

    let elapsedMs = 0;

    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      for (let i = 0; i < opCount; i += 1) {
        insertOrchestratedScrimLifecycleOperation(stmts, {
          scrimPostDbId: postId,
          guildId: 'g1',
          channelId: 'c1',
          messageId: `m-${i}`,
          operationType: LIFECYCLE_OP_TYPE_EDIT,
          targetStatus: 'superseded_repost',
          eventKey: `supersede:${postId}:1:m-${i}`,
        });
      }

      const mockClient = {
        guilds: {
          fetch: async () => ({
            channels: {
              fetch: async () => ({
                isTextBased: () => true,
                messages: {
                  fetch: async () => ({
                    edit: async () => {
                      await sleep(editDelayMs);
                    },
                  }),
                },
              }),
            },
          }),
        },
      };

      startDiscordTaskQueue();
      startScrimLifecycleDispatcher(mockClient, stmts);

      const started = Date.now();
      wakeScrimLifecycleDispatcher();
      await drainScrimLifecycleDispatcher(mockClient, stmts, { timeoutMs: 30_000 });
      elapsedMs = Date.now() - started;

      const snap = getScrimLifecycleDispatcherHealthSnapshot();
      assert.strictEqual(snap.activeWorkers, 0);
      assert.strictEqual(snap.concurrency, concurrency);

      const pending = db.prepare(
        `SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE status = 'pending'`,
      ).get();
      assert.strictEqual(Number(pending.n), 0);
    });

    await stopScrimLifecycleDispatcher();
    await stopDiscordTaskQueue();
    delete process.env.SCRIM_LIFECYCLE_CONCURRENCY;
    return elapsedMs;
  }

  it('N=1 — exécution séquentielle (timing) avec wake+drain+loop', async () => {
    const opCount = 4;
    const editDelayMs = 50;
    const elapsed = await runConcurrencyTimingTest(1, opCount, editDelayMs);
    const minSequential = opCount * editDelayMs * 0.85;
    assert.ok(elapsed >= minSequential, `elapsed=${elapsed}ms trop court pour N=1`);
  });

  it('N=2 — parallélisme limité (timing) avec wake+drain+loop', async () => {
    const opCount = 4;
    const editDelayMs = 50;
    const elapsed = await runConcurrencyTimingTest(2, opCount, editDelayMs);
    const minParallel2 = Math.ceil(opCount / 2) * editDelayMs * 0.85;
    const maxMostlySequential = opCount * editDelayMs * 0.95;
    assert.ok(elapsed >= minParallel2, `elapsed=${elapsed}ms — pas assez parallèle pour N=2`);
    assert.ok(elapsed <= maxMostlySequential, `elapsed=${elapsed}ms — trop lent, overserialisé`);
  });
});

describe('Phase 3G — H2 supersede processing puis close', () => {
  it('0 supersede edit après close manual — op cancelled stale', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const inserted = insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-super',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'superseded_repost',
        eventKey: `supersede:${postId}:1:m-super`,
      });
      const opId = inserted.operationId;
      assert.ok(opId);

      stmts.claimScrimLifecycleOperationForDispatcher.run({
        id: opId,
        started_at: new Date().toISOString(),
        last_dispatched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      const op = stmts.getScrimLifecycleOperationById.get(opId);

      orchestrateScrimCloseInTransaction(db, stmts, postId, 'closed_manual', 'test');

      let supersedeEdits = 0;
      let closeEdits = 0;

      const mockClient = {
        guilds: {
          fetch: async () => ({
            channels: {
              fetch: async () => ({
                isTextBased: () => true,
                messages: {
                  fetch: async (mid) => ({
                    id: mid,
                    edit: async () => {
                      if (mid === 'm-super') supersedeEdits += 1;
                      else closeEdits += 1;
                    },
                  }),
                },
              }),
            },
          }),
        },
      };

      const out = await executeOrchestratedLifecycleOperation(mockClient, stmts, op, {
        fromDispatcher: true,
      });
      assert.strictEqual(out, 'skipped');
      assert.strictEqual(supersedeEdits, 0);

      const fresh = stmts.getScrimLifecycleOperationById.get(opId);
      assert.strictEqual(fresh.status, 'cancelled');
    });
  });

  it('closed_expired — même comportement stale', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const inserted = insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-exp',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'superseded_repost',
        eventKey: `supersede:${postId}:1:m-exp`,
      });
      stmts.claimScrimLifecycleOperationForDispatcher.run({
        id: inserted.operationId,
        started_at: new Date().toISOString(),
        last_dispatched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      const op = stmts.getScrimLifecycleOperationById.get(inserted.operationId);

      orchestrateScrimCloseInTransaction(db, stmts, postId, 'closed_expired', 'expire');

      let edits = 0;
      const mockClient = {
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

      const out = await executeOrchestratedLifecycleOperation(mockClient, stmts, op, {
        fromDispatcher: true,
      });
      assert.strictEqual(out, 'skipped');
      assert.strictEqual(edits, 0);
    });
  });
});

describe('Phase 3G — H3 shutdown ordering', () => {
  it('broadcast first puis producers puis consumers (index.js 3K)', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const broadcastIdx = index.indexOf('persistent_broadcast_job_stop');
    const producersIdx = index.indexOf('lifecycle_producers_stop');
    const consumersIdx = index.indexOf('lifecycle_consumers_stop');
    const taskQueueIdx = index.indexOf('discord_task_queue_stop');
    assert.ok(broadcastIdx >= 0 && producersIdx > broadcastIdx);
    assert.ok(consumersIdx > producersIdx);
    assert.ok(taskQueueIdx > consumersIdx);
    assert.match(index, /stopScrimLifecycleDispatcher/);
    assert.match(index, /stopScrimRepostJob/);
    assert.match(index, /stopScrimExpirationJob/);
  });

  it('producteur mid-pass puis stop ordonné — op durable ou traitée', async () => {
    const calls = [];
    const gracefulShutdown = createGracefulShutdown({
      steps: [
        { name: 'broadcast', phase: 'persistent_broadcast_job_stop', stop: async () => { calls.push('broadcast'); } },
        {
          name: 'producers',
          phase: 'lifecycle_producers_stop',
          stop: async () => {
            await Promise.all([
              (async () => { calls.push('repost'); })(),
              (async () => { calls.push('expiration'); })(),
            ]);
          },
        },
        {
          name: 'consumers',
          phase: 'lifecycle_consumers_stop',
          stop: async () => { calls.push('dispatcher'); },
        },
      ],
      getClient: () => null,
      closeDb: () => { calls.push('db'); },
      onExit: () => {},
    });

    await gracefulShutdown('SIGINT');
    assert.ok(calls[0] === 'broadcast');
    assert.ok(calls.includes('repost'));
    assert.ok(calls.includes('expiration'));
    assert.ok(calls.includes('dispatcher'));
    assert.ok(calls.indexOf('dispatcher') > calls.indexOf('repost'));
    assert.ok(calls[calls.length - 1] === 'db');
  });
});

describe('Phase 3G — M1 starvation guard', () => {
  it('A — HIGH avant NORMAL non-starved', async () => {
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
    });
  });

  it('B — NORMAL starved finit par être claimée', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const starvedCreated = new Date(Date.now() - SCRIM_LIFECYCLE_STARVATION_THRESHOLD_MS - 60_000).toISOString();
      const recentCreated = new Date().toISOString();

      db.prepare(`
        INSERT INTO scrim_lifecycle_operations (
          scrim_post_db_id, guild_id, channel_id, message_id,
          operation_type, target_status, priority, status,
          attempt_count, event_key, created_at, updated_at
        ) VALUES (?, 'g1', 'c-old', 'm-starved', 'lifecycle_edit', 'superseded_repost', 'low', 'pending', 0, ?, ?, ?)
      `).run(postId, `supersede:${postId}:1:m-starved`, starvedCreated, starvedCreated);

      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c-new',
        messageId: 'm-fresh-super',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'superseded_repost',
        eventKey: `supersede:${postId}:1:m-fresh-super`,
      });

      db.prepare(`
        UPDATE scrim_lifecycle_operations SET created_at = ?, updated_at = ?
        WHERE message_id = 'm-fresh-super'
      `).run(recentCreated, recentCreated);

      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c-high',
        messageId: 'm-high',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_manual',
        eventKey: `close:${postId}:closed_manual:m-high`,
      });

      const first = claimNextScrimLifecycleOperation(stmts);
      assert.strictEqual(first.message_id, 'm-high');

      stmts.markScrimLifecycleOperationCompleted.run({
        id: first.id,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const second = claimNextScrimLifecycleOperation(stmts);
      assert.strictEqual(second.message_id, 'm-starved', 'starved NORMAL servie avant fresh supersede');
    });
  });
});
