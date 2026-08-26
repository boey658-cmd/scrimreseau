/**
 * Phase 3C — lifecycle DELETE persistants (retry job, discord_deleted_at post-succès)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { EmbedBuilder, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { syncInactiveScrimMessageByPolicy } from '../src/services/scrimMessagePolicy.js';
import {
  startDiscordTaskQueue,
  stopDiscordTaskQueue,
} from '../src/services/discordTaskQueue.js';
import {
  runDiscordDeleteRetryPass,
  startDiscordDeleteRetryJob,
  stopDiscordDeleteRetryJob,
} from '../src/services/discordDeleteRetryJob.js';
import {
  createScrimLifecycleOperation,
  LIFECYCLE_OP_TYPE_DELETE,
} from '../src/services/scrimLifecycleOperationStore.js';
import {
  recoverScrimLifecycleDeleteOperationsAtStartup,
  scheduleScrimLifecycleDeleteRetry,
  classifyDiscordDeleteError,
} from '../src/services/scrimLifecycleDeleteRetry.js';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-lifecycle-3c-'));
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

function insertScrimPost(stmts) {
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
    status: 'closed_manual',
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

function makeDeletePolicyContext(stmts, db, overrides = {}) {
  const postId = insertScrimPost(stmts);
  const guildId = overrides.guildId ?? 'g-del3c';
  const channelId = overrides.channelId ?? 'c-del3c';
  const messageId = overrides.messageId ?? 'msg-del3c';
  insertMessage(stmts, postId, guildId, channelId, messageId);
  stmts.upsertScrimMessageLifecyclePolicy.run({
    guild_id: guildId,
    policy: 'delete',
    updated_at: new Date().toISOString(),
  });

  let deleteCalls = 0;
  const message = {
    id: messageId,
    guildId,
    channelId,
    delete: overrides.deleteFn ?? (async () => {
      deleteCalls += 1;
    }),
  };
  const botMember = {
    id: 'bot',
    permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
  };
  const channel = {
    permissionsFor: () => new PermissionsBitField([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageMessages,
    ]),
  };
  const guild = {
    members: { me: botMember, fetchMe: async () => botMember },
  };

  return {
    postId,
    db,
    stmts,
    message,
    guild,
    channel,
    guildId,
    channelId,
    messageId,
    getDeleteCalls: () => deleteCalls,
  };
}

function mockDeleteRetryClient(onDelete) {
  return {
    guilds: {
      fetch: async () => ({
        channels: {
          fetch: async () => ({
            isTextBased: () => true,
            messages: {
              fetch: async () => ({
                id: 'msg-del3c',
                delete: onDelete,
              }),
            },
          }),
        },
      }),
    },
  };
}

describe('Phase 3C — migration next_attempt_at', () => {
  it('colonnes next_attempt_at et cancellation_reason idempotentes', async () => {
    await withTempDb(async (db) => {
      const cols = db
        .prepare(`PRAGMA table_info(scrim_lifecycle_operations)`)
        .all()
        .map((c) => c.name);
      assert.ok(cols.includes('next_attempt_at'));
      assert.ok(cols.includes('cancellation_reason'));
    });
  });
});

describe('Phase 3C — delete success (A)', () => {
  beforeEach(() => {
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    process.env.DISCORD_API_MAX_ATTEMPTS = '1';
    process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS = '1';
    startDiscordTaskQueue();
  });

  afterEach(async () => {
    await stopDiscordTaskQueue();
    delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    delete process.env.DISCORD_API_MAX_ATTEMPTS;
    delete process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS;
  });

  it('succès → completed, discord_deleted_at après delete, 1 seul delete', async () => {
    await withTempDb(async (db, stmts) => {
      const ctx = makeDeletePolicyContext(stmts, db);
      await syncInactiveScrimMessageByPolicy({
        client: {},
        stmts,
        messageRow: {
          guild_id: ctx.guildId,
          channel_id: ctx.channelId,
          message_id: ctx.messageId,
        },
        scrimPostDbId: ctx.postId,
        eventType: 'closed_manual',
        targetStatus: 'closed_manual',
        editOptions: { embeds: [new EmbedBuilder()] },
        guild: ctx.guild,
        channel: ctx.channel,
        message: ctx.message,
      });

      assert.strictEqual(ctx.getDeleteCalls(), 1);
      const op = db.prepare(`SELECT * FROM scrim_lifecycle_operations ORDER BY id DESC LIMIT 1`).get();
      assert.strictEqual(op.status, 'completed');
      const msgRow = db
        .prepare(`SELECT discord_deleted_at FROM scrim_post_messages WHERE message_id = ?`)
        .get(ctx.messageId);
      assert.ok(msgRow.discord_deleted_at);
    });
  });
});

describe('Phase 3C — 10008 idempotent (B)', () => {
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

  it('10008 → completed, discord_deleted_at, pas de retry persistant', async () => {
    await withTempDb(async (db, stmts) => {
      const err = new Error('Unknown Message');
      err.code = 10008;
      assert.strictEqual(classifyDiscordDeleteError(err).kind, 'already_gone');

      const ctx = makeDeletePolicyContext(stmts, db, {
        deleteFn: async () => {
          throw err;
        },
      });

      await syncInactiveScrimMessageByPolicy({
        client: {},
        stmts,
        messageRow: {
          guild_id: ctx.guildId,
          channel_id: ctx.channelId,
          message_id: ctx.messageId,
        },
        scrimPostDbId: ctx.postId,
        eventType: 'closed_expired',
        targetStatus: 'closed_expired',
        editOptions: { embeds: [new EmbedBuilder()] },
        guild: ctx.guild,
        channel: ctx.channel,
        message: ctx.message,
      });

      const op = db.prepare(`SELECT * FROM scrim_lifecycle_operations ORDER BY id DESC LIMIT 1`).get();
      assert.strictEqual(op.status, 'completed');
      assert.strictEqual(op.next_attempt_at, null);
      const msgRow = db
        .prepare(`SELECT discord_deleted_at FROM scrim_post_messages WHERE message_id = ?`)
        .get(ctx.messageId);
      assert.ok(msgRow.discord_deleted_at);
    });
  });
});

describe('Phase 3C — terminal permissions (C)', () => {
  it('permissions manquantes → failed_terminal, fallback edit, 0 delete Discord', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
      startDiscordTaskQueue();
      try {
        const postId = insertScrimPost(stmts);
        stmts.upsertScrimMessageLifecyclePolicy.run({
          guild_id: 'g-noperm3c',
          policy: 'delete',
          updated_at: new Date().toISOString(),
        });
        let deleteCalls = 0;
        let editCalls = 0;
        const message = {
          id: 'msg-noperm3c',
          guildId: 'g-noperm3c',
          channelId: 'c-noperm3c',
          delete: async () => {
            deleteCalls += 1;
          },
          edit: async () => {
            editCalls += 1;
          },
        };
        const botMember = { id: 'bot' };
        const channel = {
          permissionsFor: () => new PermissionsBitField(PermissionFlagsBits.ViewChannel),
        };
        const guild = {
          members: { me: botMember, fetchMe: async () => botMember },
        };

        await syncInactiveScrimMessageByPolicy({
          client: {},
          stmts,
          messageRow: { guild_id: 'g-noperm3c', channel_id: 'c-noperm3c', message_id: 'msg-noperm3c' },
          scrimPostDbId: postId,
          eventType: 'closed_manual',
          targetStatus: 'closed_manual',
          editOptions: { embeds: [new EmbedBuilder()] },
          guild,
          channel,
          message,
        });

        assert.strictEqual(deleteCalls, 0);
        assert.strictEqual(editCalls, 1);
        const op = db
          .prepare(`SELECT * FROM scrim_lifecycle_operations WHERE operation_type = 'lifecycle_delete' ORDER BY id DESC LIMIT 1`)
          .get();
        assert.strictEqual(op.status, 'failed_terminal');
        assert.strictEqual(op.next_attempt_at, null);
      } finally {
        await stopDiscordTaskQueue();
      }
    });
  });
});

describe('Phase 3C — transient error (D)', () => {
  it('503 → retry persistant, discord_deleted_at NULL, pas de fallback edit', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
      process.env.DISCORD_API_MAX_ATTEMPTS = '1';
      process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS = '1';
      startDiscordTaskQueue();
      try {
        const retryableErr = new Error('Service Unavailable');
        retryableErr.status = 503;

        const ctx = makeDeletePolicyContext(stmts, db, {
          deleteFn: async () => {
            throw retryableErr;
          },
        });

        let editCalls = 0;
        const messageWithEdit = {
          ...ctx.message,
          edit: async () => {
            editCalls += 1;
          },
        };

        await syncInactiveScrimMessageByPolicy({
          client: {},
          stmts,
          messageRow: {
            guild_id: ctx.guildId,
            channel_id: ctx.channelId,
            message_id: ctx.messageId,
          },
          scrimPostDbId: ctx.postId,
          eventType: 'closed_manual',
          targetStatus: 'closed_manual',
          editOptions: { embeds: [new EmbedBuilder()] },
          guild: ctx.guild,
          channel: ctx.channel,
          message: messageWithEdit,
        });

        assert.strictEqual(editCalls, 0);
        const op = db.prepare(`SELECT * FROM scrim_lifecycle_operations ORDER BY id DESC LIMIT 1`).get();
        assert.strictEqual(op.status, 'pending');
        assert.ok(op.next_attempt_at);
        // claim dispatcher = seul incrément ; schedule conserve le compteur (ici 0, pas encore claimé)
        assert.strictEqual(Number(op.attempt_count), 0);
        const nextAt = new Date(String(op.next_attempt_at)).getTime();
        assert.ok(nextAt > Date.now() + 1_000, 'retry futur (pas due-now)');
        const msgRow = db
          .prepare(`SELECT discord_deleted_at FROM scrim_post_messages WHERE message_id = ?`)
          .get(ctx.messageId);
        assert.strictEqual(msgRow.discord_deleted_at, null);
      } finally {
        await stopDiscordTaskQueue();
      }
    });
  });
});

describe('Phase 3C — restart / startup recovery (E)', () => {
  it('processing stale → recovered → delete exécuté au retry pass', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g1', 'c1', 'msg-del3c');
      const opId = createScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'msg-del3c',
        operationType: LIFECYCLE_OP_TYPE_DELETE,
        targetStatus: 'closed_manual',
        payloadJson: null,
      });
      const now = new Date().toISOString();
      db.prepare(`UPDATE scrim_lifecycle_operations SET status = 'processing', updated_at = ? WHERE id = ?`).run(now, opId);

      const recovered = recoverScrimLifecycleDeleteOperationsAtStartup(stmts);
      assert.strictEqual(recovered, 1);

      const row = stmts.getScrimLifecycleOperationById.get(opId);
      assert.strictEqual(row.status, 'pending');
      assert.ok(row.next_attempt_at);

      db.prepare(`UPDATE scrim_lifecycle_operations SET next_attempt_at = ? WHERE id = ?`).run(now, opId);

      let deletes = 0;
      await runDiscordDeleteRetryPass(
        mockDeleteRetryClient(async () => {
          deletes += 1;
        }),
        stmts,
      );

      assert.strictEqual(deletes, 1);
      const op = stmts.getScrimLifecycleOperationById.get(opId);
      assert.strictEqual(op.status, 'completed');
    });
  });

  it('retry pass sur message déjà deleted → 10008 → completed', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g1', 'c1', 'msg-del3c');
      const opId = createScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'msg-del3c',
        operationType: LIFECYCLE_OP_TYPE_DELETE,
        targetStatus: 'closed_manual',
        payloadJson: null,
      });
      scheduleScrimLifecycleDeleteRetry(stmts, opId, 'HTTP_503', 'test');
      db.prepare(`UPDATE scrim_lifecycle_operations SET next_attempt_at = ? WHERE id = ?`).run(
        new Date().toISOString(),
        opId,
      );

      const err = new Error('Unknown Message');
      err.code = 10008;
      let deletes = 0;
      await runDiscordDeleteRetryPass(
        mockDeleteRetryClient(async () => {
          deletes += 1;
          throw err;
        }),
        stmts,
      );

      assert.strictEqual(deletes, 1);
      const op = stmts.getScrimLifecycleOperationById.get(opId);
      assert.strictEqual(op.status, 'completed');
    });
  });
});

describe('Phase 3C — already discord_deleted_at (F)', () => {
  it('retry pass → skip sans delete Discord', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g1', 'c1', 'msg-del3c');
      stmts.markScrimPostMessageDiscordDeleted.run({
        discord_deleted_at: new Date().toISOString(),
        guild_id: 'g1',
        channel_id: 'c1',
        message_id: 'msg-del3c',
      });

      const opId = createScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'msg-del3c',
        operationType: LIFECYCLE_OP_TYPE_DELETE,
        targetStatus: 'closed_manual',
        payloadJson: null,
      });
      const now = new Date().toISOString();
      db.prepare(`UPDATE scrim_lifecycle_operations SET next_attempt_at = ?, status = 'pending' WHERE id = ?`).run(now, opId);

      let deletes = 0;
      const out = await runDiscordDeleteRetryPass(
        mockDeleteRetryClient(async () => {
          deletes += 1;
        }),
        stmts,
      );

      assert.strictEqual(deletes, 0);
      assert.strictEqual(out.success, 1);
      const op = stmts.getScrimLifecycleOperationById.get(opId);
      assert.strictEqual(op.status, 'completed');
    });
  });
});

describe('Phase 3C — no double delete (G)', () => {
  beforeEach(() => {
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS = '4';
    startDiscordTaskQueue();
  });

  afterEach(async () => {
    await stopDiscordTaskQueue();
    delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    delete process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS;
  });

  it('shadow completed throw après delete → max 1 delete', async () => {
    await withTempDb(async (db, stmts) => {
      const ctx = makeDeletePolicyContext(stmts, db);
      const orig = stmts.markScrimLifecycleOperationCompleted.run.bind(
        stmts.markScrimLifecycleOperationCompleted,
      );
      stmts.markScrimLifecycleOperationCompleted.run = () => {
        throw new Error('shadow mark completed simulated failure');
      };
      try {
        await syncInactiveScrimMessageByPolicy({
          client: {},
          stmts,
          messageRow: {
            guild_id: ctx.guildId,
            channel_id: ctx.channelId,
            message_id: ctx.messageId,
          },
          scrimPostDbId: ctx.postId,
          eventType: 'closed_manual',
          targetStatus: 'closed_manual',
          editOptions: { embeds: [new EmbedBuilder()] },
          guild: ctx.guild,
          channel: ctx.channel,
          message: ctx.message,
        });
        assert.strictEqual(ctx.getDeleteCalls(), 1);
        const msgRow = db
          .prepare(`SELECT discord_deleted_at FROM scrim_post_messages WHERE message_id = ?`)
          .get(ctx.messageId);
        assert.ok(msgRow.discord_deleted_at);
      } finally {
        stmts.markScrimLifecycleOperationCompleted.run = orig;
      }
    });
  });
});

describe('Phase 3C — shutdown (H)', () => {
  it('pending delete durable après stop job', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const opId = createScrimLifecycleOperation(stmts, {
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm-shutdown',
        operationType: LIFECYCLE_OP_TYPE_DELETE,
        targetStatus: 'closed_manual',
        payloadJson: null,
      });
      scheduleScrimLifecycleDeleteRetry(stmts, opId, 'HTTP_503', 'test');

      const mockClient = { guilds: { fetch: async () => ({ channels: { fetch: async () => ({}) } }) } };
      const { startScrimLifecycleDispatcher, stopScrimLifecycleDispatcher } = await import(
        '../src/services/scrimLifecycleDispatcher.js'
      );
      startScrimLifecycleDispatcher(mockClient, stmts);
      await stopScrimLifecycleDispatcher();

      const op = stmts.getScrimLifecycleOperationById.get(opId);
      assert.strictEqual(op.status, 'pending');
      assert.ok(op.next_attempt_at);
    });
  });
});

describe('Phase 3C — delete retry job startup', () => {
  it('startScrimLifecycleDispatcher enregistré dans bot.js (3F)', () => {
    const botSource = fs.readFileSync(
      new URL('../src/bot.js', import.meta.url),
      'utf8',
    );
    assert.match(botSource, /startScrimLifecycleDispatcher/);
  });

  it('stopScrimLifecycleDispatcher après producteurs, avant taskQueue (3K)', () => {
    const indexSource = fs.readFileSync(
      new URL('../index.js', import.meta.url),
      'utf8',
    );
    assert.match(indexSource, /stopScrimLifecycleDispatcher/);
    const broadcastIdx = indexSource.indexOf('persistent_broadcast_job_stop');
    const producersIdx = indexSource.indexOf('lifecycle_producers_stop');
    const consumersIdx = indexSource.indexOf('lifecycle_consumers_stop');
    const taskQueueIdx = indexSource.indexOf('discord_task_queue_stop');
    assert.ok(broadcastIdx >= 0 && producersIdx > broadcastIdx);
    assert.ok(consumersIdx > producersIdx);
    assert.ok(taskQueueIdx > consumersIdx);
    assert.match(indexSource, /stopScrimRepostJob/);
    assert.match(indexSource, /stopDiscordEditRetryJob/);
  });
});
