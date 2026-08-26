/**
 * Phase 3J — terminal prefetch ne doit plus hot-loop
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { EmbedBuilder, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import {
  drainScrimLifecycleDispatcher,
  startScrimLifecycleDispatcher,
  stopScrimLifecycleDispatcher,
  claimNextScrimLifecycleOperation,
  runScrimLifecycleDispatcherPass,
  recoverScrimLifecycleDispatcherAtStartup,
} from '../src/services/scrimLifecycleDispatcher.js';
import {
  insertOrchestratedScrimLifecycleOperation,
  LIFECYCLE_OP_TYPE_DELETE,
  LIFECYCLE_OP_TYPE_EDIT,
} from '../src/services/scrimLifecycleOperationStore.js';
import {
  buildCloseFallbackEditEventKey,
  ensureCloseFallbackEditOperation,
} from '../src/services/scrimLifecycleOrchestrator.js';
import {
  SCRIM_LIFECYCLE_MAX_ATTEMPTS,
  terminalizeExhaustedScrimLifecycleOperations,
} from '../src/services/scrimLifecycleAttempts.js';
import {
  startDiscordTaskQueue,
  stopDiscordTaskQueue,
} from '../src/services/discordTaskQueue.js';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-lifecycle-3j-'));
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

function insertScrimPost(stmts, status = 'closed_expired') {
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
    scheduled_at: new Date(Date.now() - 3600000).toISOString(),
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

function seedClosedPost(db, stmts, status = 'closed_expired') {
  const id = insertScrimPost(stmts, status);
  db.prepare('UPDATE scrim_posts SET closed_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  return id;
}

/**
 * @param {{
 *   channelFetch?: () => Promise<unknown>,
 *   guildFetch?: () => Promise<unknown>,
 *   messageFetch?: () => Promise<unknown>,
 *   counters?: { channel: number, guild: number, message: number, edit: number, delete: number },
 * }} [opts]
 */
function buildPrefetchClient(opts = {}) {
  const counters = opts.counters ?? { channel: 0, guild: 0, message: 0, edit: 0, delete: 0 };
  const botMember = {
    id: 'bot',
    permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
  };

  const defaultChannel = {
    isTextBased: () => true,
    permissionsFor: () => new PermissionsBitField(PermissionFlagsBits.Administrator),
    messages: {
      fetch: async () => {
        counters.message += 1;
        if (opts.messageFetch) return opts.messageFetch();
        return {
          id: 'm1',
          guildId: 'g1',
          channelId: 'c1',
          edit: async () => { counters.edit += 1; },
          delete: async () => { counters.delete += 1; },
        };
      },
    },
  };

  return {
    counters,
    client: {
      guilds: {
        fetch: async () => {
          counters.guild += 1;
          if (opts.guildFetch) return opts.guildFetch();
          return {
            members: { me: botMember, fetchMe: async () => botMember },
            channels: {
              fetch: async () => {
                counters.channel += 1;
                if (opts.channelFetch) return opts.channelFetch();
                return defaultChannel;
              },
            },
          };
        },
      },
    },
  };
}

describe('Phase 3J — channel 10003 terminal (hot-loop fix)', () => {
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

  it('B — 10003 channel → failed_terminal, exactement 1 fetch, pas de reclaim', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = seedClosedPost(db, stmts);
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c-gone',
        messageId: 'm1',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_expired',
        eventKey: `close:${postId}:closed_expired:m1`,
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });

      const err10003 = Object.assign(new Error('Unknown Channel'), { code: 10003 });
      const { client, counters } = buildPrefetchClient({
        channelFetch: async () => { throw err10003; },
      });

      startDiscordTaskQueue();
      startScrimLifecycleDispatcher(client, stmts);
      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 5_000 });
      for (let i = 0; i < 20; i += 1) {
        await runScrimLifecycleDispatcherPass(client, stmts);
      }
      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 2_000 });

      assert.strictEqual(counters.channel, 1, 'channel fetch exactement 1 fois');
      const op = db.prepare(`SELECT * FROM scrim_lifecycle_operations WHERE message_id = 'm1'`).get();
      assert.strictEqual(op.status, 'failed_terminal');
      assert.strictEqual(String(op.last_error_code), '10003');
      assert.strictEqual(op.next_attempt_at, null);
      assert.ok(Number(op.attempt_count) <= SCRIM_LIFECYCLE_MAX_ATTEMPTS);
      assert.ok(Number(op.attempt_count) >= 1);
    });
  });

  it('A — guild 10004 → terminal, 1 attempt', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = seedClosedPost(db, stmts);
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g-gone',
        channelId: 'c1',
        messageId: 'm-g',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_expired',
        eventKey: `close:${postId}:closed_expired:m-g`,
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });

      const err = Object.assign(new Error('Unknown Guild'), { code: 10004 });
      const { client, counters } = buildPrefetchClient({
        guildFetch: async () => { throw err; },
      });

      startDiscordTaskQueue();
      startScrimLifecycleDispatcher(client, stmts);
      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 5_000 });
      for (let i = 0; i < 10; i += 1) await runScrimLifecycleDispatcherPass(client, stmts);

      assert.strictEqual(counters.guild, 1);
      assert.strictEqual(counters.channel, 0);
      const op = db.prepare(`SELECT * FROM scrim_lifecycle_operations WHERE message_id = 'm-g'`).get();
      assert.strictEqual(op.status, 'failed_terminal');
      assert.strictEqual(String(op.last_error_code), '10004');
    });
  });

  it('C — message 10008 → completed idempotent', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = seedClosedPost(db, stmts);
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-gone',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_expired',
        eventKey: `close:${postId}:closed_expired:m-gone`,
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });

      const err = Object.assign(new Error('Unknown Message'), { code: 10008 });
      const { client, counters } = buildPrefetchClient({
        messageFetch: async () => { throw err; },
      });

      startDiscordTaskQueue();
      startScrimLifecycleDispatcher(client, stmts);
      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 5_000 });

      assert.strictEqual(counters.message, 1);
      const op = db.prepare(`SELECT * FROM scrim_lifecycle_operations WHERE message_id = 'm-gone'`).get();
      assert.strictEqual(op.status, 'completed');
    });
  });

  it('D — permissions 50013 → terminal', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = seedClosedPost(db, stmts);
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-perm',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_expired',
        eventKey: `close:${postId}:closed_expired:m-perm`,
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });

      const err = Object.assign(new Error('Missing Permissions'), { code: 50013 });
      const { client, counters } = buildPrefetchClient({
        channelFetch: async () => { throw err; },
      });

      startDiscordTaskQueue();
      startScrimLifecycleDispatcher(client, stmts);
      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 5_000 });
      for (let i = 0; i < 10; i += 1) await runScrimLifecycleDispatcherPass(client, stmts);

      assert.strictEqual(counters.channel, 1);
      const op = db.prepare(`SELECT * FROM scrim_lifecycle_operations WHERE message_id = 'm-perm'`).get();
      assert.strictEqual(op.status, 'failed_terminal');
      assert.strictEqual(String(op.last_error_code), '50013');
    });
  });

  it('E — channel 503 → retryable, next_attempt_at futur, pas de hot-loop', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = seedClosedPost(db, stmts);
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-503',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_expired',
        eventKey: `close:${postId}:closed_expired:m-503`,
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });

      const err = Object.assign(new Error('Service Unavailable'), { status: 503 });
      const { client, counters } = buildPrefetchClient({
        channelFetch: async () => { throw err; },
      });

      startDiscordTaskQueue();
      startScrimLifecycleDispatcher(client, stmts);
      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 5_000 });
      for (let i = 0; i < 20; i += 1) await runScrimLifecycleDispatcherPass(client, stmts);

      assert.strictEqual(counters.channel, 1);
      const op = db.prepare(`SELECT * FROM scrim_lifecycle_operations WHERE message_id = 'm-503'`).get();
      assert.strictEqual(op.status, 'pending');
      assert.ok(op.next_attempt_at);
      assert.ok(new Date(op.next_attempt_at).getTime() > Date.now() - 1000);

      const now = new Date().toISOString();
      db.prepare(`UPDATE scrim_lifecycle_operations SET next_attempt_at = ? WHERE id = ?`).run(now, op.id);
      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 5_000 });
      assert.strictEqual(counters.channel, 2);
    });
  });

  it('F — ECONNRESET → retryable backoff', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = seedClosedPost(db, stmts);
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-net',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_expired',
        eventKey: `close:${postId}:closed_expired:m-net`,
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });

      const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      const { client, counters } = buildPrefetchClient({
        channelFetch: async () => { throw err; },
      });

      startDiscordTaskQueue();
      startScrimLifecycleDispatcher(client, stmts);
      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 5_000 });
      for (let i = 0; i < 15; i += 1) await runScrimLifecycleDispatcherPass(client, stmts);

      assert.strictEqual(counters.channel, 1);
      const op = db.prepare(`SELECT * FROM scrim_lifecycle_operations WHERE message_id = 'm-net'`).get();
      assert.strictEqual(op.status, 'pending');
      assert.ok(op.next_attempt_at);
    });
  });
});

describe('Phase 3J — retry exhaustion + old rows', () => {
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

  it('MAX_ATTEMPTS : exactement MAX claims Discord puis RETRY_EXHAUSTED', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = seedClosedPost(db, stmts);
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-max',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_expired',
        eventKey: `close:${postId}:closed_expired:m-max`,
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });

      const err = Object.assign(new Error('Service Unavailable'), { status: 503 });
      const { client, counters } = buildPrefetchClient({
        channelFetch: async () => { throw err; },
      });

      startDiscordTaskQueue();
      startScrimLifecycleDispatcher(client, stmts);

      for (let round = 0; round < SCRIM_LIFECYCLE_MAX_ATTEMPTS + 5; round += 1) {
        const now = new Date().toISOString();
        db.prepare(`
          UPDATE scrim_lifecycle_operations
          SET next_attempt_at = ?, status = CASE WHEN status = 'failed_terminal' THEN status ELSE 'pending' END
          WHERE message_id = 'm-max' AND status != 'failed_terminal'
        `).run(now);
        await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 3_000 });
      }

      assert.strictEqual(counters.channel, SCRIM_LIFECYCLE_MAX_ATTEMPTS);
      const op = db.prepare(`SELECT * FROM scrim_lifecycle_operations WHERE message_id = 'm-max'`).get();
      assert.strictEqual(op.status, 'failed_terminal');
      assert.strictEqual(op.last_error_code, 'RETRY_EXHAUSTED');

      const before = counters.channel;
      for (let i = 0; i < 20; i += 1) await runScrimLifecycleDispatcherPass(client, stmts);
      assert.strictEqual(counters.channel, before);
    });
  });

  it('old row attempt_count=78 → terminalisé SANS Discord', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = seedClosedPost(db, stmts);
      const inserted = insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-old',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_expired',
        eventKey: `close:${postId}:closed_expired:m-old`,
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });
      db.prepare(`UPDATE scrim_lifecycle_operations SET attempt_count = 78 WHERE id = ?`).run(inserted.operationId);

      const { client, counters } = buildPrefetchClient();
      startDiscordTaskQueue();
      const n = recoverScrimLifecycleDispatcherAtStartup(stmts);
      assert.ok(n >= 1);
      startScrimLifecycleDispatcher(client, stmts);
      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 3_000 });
      for (let i = 0; i < 10; i += 1) await runScrimLifecycleDispatcherPass(client, stmts);

      assert.strictEqual(counters.guild, 0);
      assert.strictEqual(counters.channel, 0);
      const op = stmts.getScrimLifecycleOperationById.get(inserted.operationId);
      assert.strictEqual(op.status, 'failed_terminal');
      assert.strictEqual(op.last_error_code, 'RETRY_EXHAUSTED');
    });
  });
});

describe('Phase 3J — lifecycle_delete prefetch + fallback 3I', () => {
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

  it('delete op channel 10003 → failed_terminal (même path prefetch)', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = seedClosedPost(db, stmts, 'closed_manual');
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c-del',
        messageId: 'm-del',
        operationType: LIFECYCLE_OP_TYPE_DELETE,
        targetStatus: 'closed_manual',
        eventKey: `close:${postId}:closed_manual:m-del`,
      });

      const err = Object.assign(new Error('Unknown Channel'), { code: 10003 });
      const { client, counters } = buildPrefetchClient({
        channelFetch: async () => { throw err; },
      });

      startDiscordTaskQueue();
      startScrimLifecycleDispatcher(client, stmts);
      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 5_000 });
      for (let i = 0; i < 10; i += 1) await runScrimLifecycleDispatcherPass(client, stmts);

      assert.strictEqual(counters.channel, 1);
      const op = db.prepare(`SELECT * FROM scrim_lifecycle_operations WHERE message_id = 'm-del'`).get();
      assert.strictEqual(op.status, 'failed_terminal');
      assert.strictEqual(String(op.last_error_code), '10003');
      const fb = db.prepare(
        `SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE event_key LIKE 'close-fallback-edit:%'`,
      ).get();
      assert.strictEqual(Number(fb.n), 0, 'pas de fallback si prefetch channel impossible');
    });
  });

  it('fallback 3I : delete 50013 → fallback edit ; fallback 10003 → terminal propre', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = seedClosedPost(db, stmts, 'closed_manual');
      insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-fb',
        operationType: LIFECYCLE_OP_TYPE_DELETE,
        targetStatus: 'closed_manual',
        eventKey: `close:${postId}:closed_manual:m-fb`,
      });

      let channelFetches = 0;
      const errDelete = Object.assign(new Error('Missing Permissions'), { code: 50013 });
      const errChannel = Object.assign(new Error('Unknown Channel'), { code: 10003 });
      const botMember = {
        id: 'bot',
        permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
      };

      const messageObj = {
        id: 'm-fb',
        guildId: 'g1',
        channelId: 'c1',
        delete: async () => { throw errDelete; },
        edit: async () => {},
      };

      const client = {
        guilds: {
          fetch: async () => ({
            members: { me: botMember, fetchMe: async () => botMember },
            channels: {
              fetch: async () => {
                channelFetches += 1;
                if (channelFetches === 1) {
                  return {
                    isTextBased: () => true,
                    permissionsFor: () => new PermissionsBitField(PermissionFlagsBits.Administrator),
                    messages: { fetch: async () => messageObj },
                  };
                }
                throw errChannel;
              },
            },
          }),
        },
      };

      startDiscordTaskQueue();
      startScrimLifecycleDispatcher(client, stmts);
      await drainScrimLifecycleDispatcher(client, stmts, { timeoutMs: 10_000 });
      for (let i = 0; i < 10; i += 1) await runScrimLifecycleDispatcherPass(client, stmts);

      const deleteOp = db.prepare(
        `SELECT * FROM scrim_lifecycle_operations WHERE operation_type = 'lifecycle_delete'`,
      ).get();
      assert.strictEqual(deleteOp.status, 'failed_terminal');

      const fbKey = buildCloseFallbackEditEventKey(postId, 'closed_manual', 'm-fb');
      const fbOp = stmts.getScrimLifecycleOperationByEventKey.get(fbKey);
      assert.ok(fbOp);
      assert.strictEqual(fbOp.status, 'failed_terminal');
      assert.strictEqual(String(fbOp.last_error_code), '10003');
    });
  });
});

describe('Phase 3J — helpers', () => {
  it('terminalizeExhausted sans Discord', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = seedClosedPost(db, stmts);
      const inserted = insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-ex',
        operationType: LIFECYCLE_OP_TYPE_EDIT,
        targetStatus: 'closed_expired',
        eventKey: `close:${postId}:closed_expired:m-ex`,
        payloadJson: JSON.stringify({ v: 2, content: null, embeds: [] }),
      });
      db.prepare(`UPDATE scrim_lifecycle_operations SET attempt_count = 78 WHERE id = ?`).run(inserted.operationId);
      const n = terminalizeExhaustedScrimLifecycleOperations(stmts);
      assert.strictEqual(n, 1);
      assert.strictEqual(
        stmts.getScrimLifecycleOperationById.get(inserted.operationId).status,
        'failed_terminal',
      );
      assert.strictEqual(claimNextScrimLifecycleOperation(stmts), null);
    });
  });

  it('ensureCloseFallbackEditOperation toujours exporté (3I)', () => {
    assert.equal(typeof ensureCloseFallbackEditOperation, 'function');
    assert.equal(typeof EmbedBuilder, 'function');
  });
});
