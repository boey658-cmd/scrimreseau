/**
 * Phase 3H — M1 anti-starvation burst + H2 final recheck avant Discord
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
  resetScrimLifecycleDispatcherBurstStateForTests,
  getScrimLifecycleDispatcherBurstStateForTests,
  startScrimLifecycleDispatcher,
  stopScrimLifecycleDispatcher,
  wakeScrimLifecycleDispatcher,
} from '../src/services/scrimLifecycleDispatcher.js';
import {
  insertOrchestratedScrimLifecycleOperation,
  LIFECYCLE_OP_TYPE_EDIT,
} from '../src/services/scrimLifecycleOperationStore.js';
import {
  orchestrateScrimCloseInTransaction,
  executeOrchestratedLifecycleOperation,
  orchestratedLifecycleTestHooks,
  resetOrchestratedLifecycleTestHooksForTests,
} from '../src/services/scrimLifecycleOrchestrator.js';
import {
  SCRIM_LIFECYCLE_STARVATION_BURST_AFTER_HIGH,
  SCRIM_LIFECYCLE_STARVATION_THRESHOLD_MS,
} from '../src/services/scrimLifecyclePriority.js';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-lifecycle-3h-'));
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

function buildCloseDuringSendLifecycleChannel(options = {}) {
  const lifecycle = { edit: 0, delete: 0 };
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

function markOpCompleted(stmts, op) {
  stmts.markScrimLifecycleOperationCompleted.run({
    id: op.id,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

function insertHighClose(stmts, postId, messageId) {
  return insertOrchestratedScrimLifecycleOperation(stmts, {
    scrimPostDbId: postId,
    guildId: 'g1',
    channelId: 'c-high',
    messageId,
    operationType: LIFECYCLE_OP_TYPE_EDIT,
    targetStatus: 'closed_manual',
    eventKey: `close:${postId}:closed_manual:${messageId}`,
  });
}

describe('Phase 3H — M1 burst anti-starvation', () => {
  beforeEach(() => {
    resetScrimLifecycleDispatcherBurstStateForTests();
  });

  it('HIGH continu + NORMAL starved — starved finit servie (burst borné)', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const starvedCreated = new Date(
        Date.now() - SCRIM_LIFECYCLE_STARVATION_THRESHOLD_MS - 120_000,
      ).toISOString();

      db.prepare(`
        INSERT INTO scrim_lifecycle_operations (
          scrim_post_db_id, guild_id, channel_id, message_id,
          operation_type, target_status, priority, status,
          attempt_count, event_key, created_at, updated_at
        ) VALUES (?, 'g1', 'c-starved', 'm-starved', 'lifecycle_edit', 'superseded_repost', 'low', 'pending', 0, ?, ?, ?)
      `).run(postId, `supersede:${postId}:1:m-starved`, starvedCreated, starvedCreated);

      const highCount = SCRIM_LIFECYCLE_STARVATION_BURST_AFTER_HIGH + 4;
      for (let i = 0; i < highCount; i += 1) {
        insertHighClose(stmts, postId, `m-high-${i}`);
      }

      const claimedIds = [];
      let starvedClaimed = false;
      const maxClaims = highCount + 3;

      for (let i = 0; i < maxClaims; i += 1) {
        const op = claimNextScrimLifecycleOperation(stmts);
        if (!op) break;
        claimedIds.push(op.message_id);
        if (op.message_id === 'm-starved') {
          starvedClaimed = true;
          break;
        }
        markOpCompleted(stmts, op);
        insertHighClose(stmts, postId, `m-high-repl-${i}`);
      }

      assert.ok(starvedClaimed, `starved jamais claimée — ids=${claimedIds.join(',')}`);
      assert.strictEqual(claimedIds[0].startsWith('m-high'), true, 'premier claim = HIGH');
      assert.ok(
        claimedIds.length <= SCRIM_LIFECYCLE_STARVATION_BURST_AFTER_HIGH + 2,
        `starved servie dans une fenêtre bornée (${claimedIds.length} claims)`,
      );
    });
  });

  it('HIGH récent reste prioritaire sur NORMAL non-starved', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c-super',
        messageId: 'm-fresh-super',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'superseded_repost',
        eventKey: `supersede:${postId}:1:m-fresh-super`,
      });
      insertHighClose(stmts, postId, 'm-high-recent');

      const first = claimNextScrimLifecycleOperation(stmts);
      assert.strictEqual(first.message_id, 'm-high-recent');
    });
  });

  it('après slot starved burst — retour immédiat à HIGH (close non retardé systématiquement)', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const starvedCreated = new Date(
        Date.now() - SCRIM_LIFECYCLE_STARVATION_THRESHOLD_MS - 60_000,
      ).toISOString();

      db.prepare(`
        INSERT INTO scrim_lifecycle_operations (
          scrim_post_db_id, guild_id, channel_id, message_id,
          operation_type, target_status, priority, status,
          attempt_count, event_key, created_at, updated_at
        ) VALUES (?, 'g1', 'c-starved', 'm-starved', 'lifecycle_edit', 'superseded_repost', 'low', 'pending', 0, ?, ?, ?)
      `).run(postId, `supersede:${postId}:1:m-starved`, starvedCreated, starvedCreated);

      for (let i = 0; i < SCRIM_LIFECYCLE_STARVATION_BURST_AFTER_HIGH; i += 1) {
        insertHighClose(stmts, postId, `m-high-${i}`);
      }

      /** @type {Record<string, unknown> | null} */
      let starvedOp = null;
      for (let i = 0; i < SCRIM_LIFECYCLE_STARVATION_BURST_AFTER_HIGH + 2; i += 1) {
        const op = claimNextScrimLifecycleOperation(stmts);
        assert.ok(op);
        if (op.message_id === 'm-starved') {
          starvedOp = op;
          markOpCompleted(stmts, op);
          break;
        }
        markOpCompleted(stmts, op);
      }
      assert.ok(starvedOp, 'burst starved attendu');

      insertHighClose(stmts, postId, 'm-high-after-burst');
      const afterBurst = claimNextScrimLifecycleOperation(stmts);
      assert.strictEqual(afterBurst.message_id, 'm-high-after-burst');
      assert.strictEqual(getScrimLifecycleDispatcherBurstStateForTests().consecutiveHighTierClaims, 1);
    });
  });
});

describe('Phase 3H — H2 race contrôlée après fetch', () => {
  afterEach(() => {
    resetOrchestratedLifecycleTestHooksForTests();
  });

  it('close manual pendant hook final recheck — 0 supersede edit', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const inserted = insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-race',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'superseded_repost',
        eventKey: `supersede:${postId}:1:m-race`,
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

      /** @type {(() => void) | null} */
      let resumeFinalRecheck = null;
      const finalRecheckGate = new Promise((resolve) => {
        resumeFinalRecheck = () => resolve(undefined);
      });

      /** @type {(() => void) | null} */
      let signalHookEntered = null;
      const hookEntered = new Promise((resolve) => {
        signalHookEntered = () => resolve(undefined);
      });

      orchestratedLifecycleTestHooks.beforeFinalDiscordRecheck = async () => {
        signalHookEntered?.();
        await finalRecheckGate;
      };

      let supersedeEdits = 0;
      const mockClient = {
        guilds: {
          fetch: async () => ({
            channels: {
              fetch: async () => ({
                isTextBased: () => true,
                messages: {
                  fetch: async () => ({
                    id: 'm-race',
                    edit: async () => {
                      supersedeEdits += 1;
                    },
                  }),
                },
              }),
            },
          }),
        },
      };

      const execPromise = executeOrchestratedLifecycleOperation(mockClient, stmts, op, {
        fromDispatcher: true,
      });

      await hookEntered;
      orchestrateScrimCloseInTransaction(db, stmts, postId, 'closed_manual', 'race-h2');
      resumeFinalRecheck?.();

      const out = await execPromise;
      assert.strictEqual(out, 'skipped');
      assert.strictEqual(supersedeEdits, 0);

      const fresh = stmts.getScrimLifecycleOperationById.get(opId);
      assert.strictEqual(fresh.status, 'cancelled');
    });
  });
});

describe('Phase 3H — régressions B1 / H1 / H3', () => {
  it('B1 close-during-send — 1 lifecycle edit, 0 Phase 2 direct', async () => {
    await withTempDb(async (db, stmts) => {
      const scrimId = insertScrimPost(stmts);
      const batchId = insertTestBatch(stmts, scrimId);
      insertTestDelivery(stmts, batchId, scrimId);
      const now = new Date().toISOString();
      const { channel, lifecycle } = buildCloseDuringSendLifecycleChannel({
        onSend: () => {
          db.prepare("UPDATE scrim_posts SET status = 'closed_manual', closed_at = ? WHERE id = ?").run(now, scrimId);
        },
      });
      const mockClient = buildMockClient({ 'guild-001': buildMockGuild('guild-001', { 'chan-001': channel }) });

      await runDeliveryWithLifecycle(mockClient, db, stmts);

      assert.strictEqual(lifecycle.edit, 1);
      assert.strictEqual(lifecycle.delete, 0);
    });
  });

  it('H1 concurrency N=1 / N=2 bornée', async () => {
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
        wakeScrimLifecycleDispatcher();
        const started = Date.now();
        await drainScrimLifecycleDispatcher(mockClient, stmts, { timeoutMs: 30_000 });
        elapsedMs = Date.now() - started;

        const snap = getScrimLifecycleDispatcherHealthSnapshot();
        assert.strictEqual(snap.activeWorkers, 0);
        assert.strictEqual(snap.concurrency, concurrency);
      });

      await stopScrimLifecycleDispatcher();
      await stopDiscordTaskQueue();
      delete process.env.SCRIM_LIFECYCLE_CONCURRENCY;
      return elapsedMs;
    }

    const opCount = 4;
    const editDelayMs = 50;
    const elapsedN1 = await runConcurrencyTimingTest(1, opCount, editDelayMs);
    assert.ok(elapsedN1 >= opCount * editDelayMs * 0.85);

    const elapsedN2 = await runConcurrencyTimingTest(2, opCount, editDelayMs);
    const minParallel2 = Math.ceil(opCount / 2) * editDelayMs * 0.85;
    const maxMostlySequential = opCount * editDelayMs * 0.95;
    assert.ok(elapsedN2 >= minParallel2);
    assert.ok(elapsedN2 <= maxMostlySequential);
  });

  it('H3 shutdown — broadcast first puis producers/consumers (3K)', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const broadcastIdx = index.indexOf('persistent_broadcast_job_stop');
    const producersIdx = index.indexOf('lifecycle_producers_stop');
    const consumersIdx = index.indexOf('lifecycle_consumers_stop');
    assert.ok(broadcastIdx >= 0 && producersIdx > broadcastIdx);
    assert.ok(consumersIdx > producersIdx);
    assert.match(index, /stopScrimLifecycleDispatcher/);
    assert.match(index, /stopDiscordEditRetryJob/);
  });

  it('H3 shutdown orchestrator — broadcast puis producers puis consumers', async () => {
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
    assert.strictEqual(calls[0], 'broadcast');
    assert.ok(calls.includes('dispatcher'));
    assert.ok(calls.indexOf('dispatcher') > calls.indexOf('repost'));
    assert.strictEqual(calls[calls.length - 1], 'db');
  });
});
