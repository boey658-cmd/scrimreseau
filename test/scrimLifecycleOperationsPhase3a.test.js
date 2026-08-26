/**
 * Phase 3A — shadow persistence scrim_lifecycle_operations
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { EmbedBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType } from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { safeScrimEmbedMessageEdit } from '../src/services/safeDiscordMessageEdit.js';
import { syncInactiveScrimMessageByPolicy } from '../src/services/scrimMessagePolicy.js';
import {
  startDiscordTaskQueue,
  stopDiscordTaskQueue,
} from '../src/services/discordTaskQueue.js';
import { runDiscordEditRetryPass } from '../src/services/discordEditRetryJob.js';
import { runScrimExpirationPass } from '../src/services/scrimExpirationJob.js';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-lifecycle-3a-'));
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
    status: 'active',
  });
  return Number(r.lastInsertRowid);
}

function tableExists(db, name) {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return Boolean(row);
}

describe('Phase 3A — migration scrim_lifecycle_operations', () => {
  it('DB fraîche → table et index créés', async () => {
    await withTempDb(async (db) => {
      assert.ok(tableExists(db, 'scrim_lifecycle_operations'));
      const indexes = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'scrim_lifecycle_operations'`)
        .all()
        .map((r) => r.name);
      assert.ok(indexes.some((n) => n.includes('status')));
      assert.ok(indexes.some((n) => n.includes('scrim_post')));
      assert.ok(indexes.some((n) => n.includes('message')));
      assert.ok(indexes.some((n) => n.includes('created_at')));
    });
  });

  it('deuxième getDb sur même fichier → migration idempotente', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-lifecycle-3a-idem-'));
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = path.join(dir, 'test.db');
    try {
      getDb();
      closeDb();
      getDb();
      const db = getDb();
      assert.ok(tableExists(db, 'scrim_lifecycle_operations'));
      closeDb();
    } finally {
      closeDb();
      if (prev === undefined) delete process.env.SQLITE_PATH;
      else process.env.SQLITE_PATH = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Phase 3A — shadow lifecycle edit', () => {
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

  it('op créée pending avant enqueue, succès → completed, un seul edit', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      let editCalls = 0;
      const message = {
        id: 'msg-1',
        channelId: 'c1',
        guildId: 'g1',
        edit: async () => {
          editCalls += 1;
          return {};
        },
      };

      const result = await safeScrimEmbedMessageEdit({
        client: {},
        stmts,
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'msg-1',
        targetStatus: 'closed_manual',
        editOptions: { embeds: [new EmbedBuilder().setTitle('closed')] },
        message,
      });

      assert.strictEqual(result, 'ok');
      assert.strictEqual(editCalls, 1);

      const op = db.prepare(`SELECT * FROM scrim_lifecycle_operations ORDER BY id DESC LIMIT 1`).get();
      assert.strictEqual(op.operation_type, 'lifecycle_edit');
      assert.strictEqual(op.status, 'completed');
      assert.strictEqual(op.target_status, 'closed_manual');
      assert.ok(op.started_at);
      assert.ok(op.completed_at);
    });
  });

  it('erreur terminal → failed_terminal, pas de legacy retry', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const err = new Error('Missing Access');
      err.code = 50001;
      const message = {
        id: 'msg-2',
        channelId: 'c1',
        guildId: 'g1',
        edit: async () => {
          throw err;
        },
      };

      const result = await safeScrimEmbedMessageEdit({
        client: {},
        stmts,
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'msg-2',
        targetStatus: 'closed_expired',
        editOptions: { embeds: [new EmbedBuilder()] },
        message,
      });

      assert.strictEqual(result, 'terminal');
      const op = db.prepare(`SELECT * FROM scrim_lifecycle_operations ORDER BY id DESC LIMIT 1`).get();
      assert.strictEqual(op.status, 'failed_terminal');
      const retries = db.prepare(`SELECT COUNT(*) AS n FROM discord_message_edit_retries`).get();
      assert.strictEqual(Number(retries.n), 0);
    });
  });

  it('erreur retryable → legacy retry créé, shadow op pending', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      let editCalls = 0;
      const err = new Error('Service Unavailable');
      err.status = 503;
      const message = {
        id: 'msg-3',
        channelId: 'c1',
        guildId: 'g1',
        edit: async () => {
          editCalls += 1;
          throw err;
        },
      };

      const result = await safeScrimEmbedMessageEdit({
        client: {},
        stmts,
        scrimPostDbId: postId,
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'msg-3',
        targetStatus: 'superseded_repost',
        editOptions: { embeds: [new EmbedBuilder()] },
        message,
      });

      assert.strictEqual(result, 'queued');
      assert.strictEqual(editCalls, 1);

      const op = db.prepare(`SELECT * FROM scrim_lifecycle_operations ORDER BY id DESC LIMIT 1`).get();
      assert.strictEqual(op.status, 'pending');
      assert.strictEqual(op.last_error_code, 'HTTP_503');

      const legacy = db.prepare(`
        SELECT * FROM discord_message_edit_retries
        WHERE guild_id = 'g1' AND message_id = 'msg-3' AND target_status = 'superseded_repost'
      `).get();
      assert.ok(legacy);
      assert.strictEqual(legacy.resolved_at, null);
    });
  });

  it('M1 — edit réussit + markCompleted shadow throw → ok, exactement 1 edit', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS = '4';
      const postId = insertScrimPost(stmts);
      let editCalls = 0;
      const message = {
        id: 'msg-m1-edit',
        channelId: 'c1',
        guildId: 'g1',
        edit: async () => {
          editCalls += 1;
          return {};
        },
      };

      const origCompletedRun = stmts.markScrimLifecycleOperationCompleted.run.bind(
        stmts.markScrimLifecycleOperationCompleted,
      );
      stmts.markScrimLifecycleOperationCompleted.run = () => {
        throw new Error('shadow mark completed simulated failure');
      };

      try {
        const result = await safeScrimEmbedMessageEdit({
          client: {},
          stmts,
          scrimPostDbId: postId,
          guildId: 'g1',
          channelId: 'c1',
          messageId: 'msg-m1-edit',
          targetStatus: 'closed_manual',
          editOptions: { embeds: [new EmbedBuilder()] },
          message,
        });

        assert.strictEqual(result, 'ok');
        assert.strictEqual(editCalls, 1);
      } finally {
        stmts.markScrimLifecycleOperationCompleted.run = origCompletedRun;
        delete process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS;
      }
    });
  });

  it('M1 — create shadow throw → legacy edit continue, exactement 1 edit', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      let editCalls = 0;
      const message = {
        id: 'msg-m1-create',
        channelId: 'c1',
        guildId: 'g1',
        edit: async () => {
          editCalls += 1;
          return {};
        },
      };

      const origCreateRun = stmts.createScrimLifecycleOperation.run.bind(
        stmts.createScrimLifecycleOperation,
      );
      stmts.createScrimLifecycleOperation.run = () => {
        throw new Error('shadow create simulated failure');
      };

      try {
        const result = await safeScrimEmbedMessageEdit({
          client: {},
          stmts,
          scrimPostDbId: postId,
          guildId: 'g1',
          channelId: 'c1',
          messageId: 'msg-m1-create',
          targetStatus: 'closed_manual',
          editOptions: { embeds: [new EmbedBuilder()] },
          message,
        });

        assert.strictEqual(result, 'ok');
        assert.strictEqual(editCalls, 1);
        const opCount = db.prepare(`SELECT COUNT(*) AS n FROM scrim_lifecycle_operations`).get();
        assert.strictEqual(Number(opCount.n), 0);
      } finally {
        stmts.createScrimLifecycleOperation.run = origCreateRun;
      }
    });
  });
});

describe('Phase 3A — shadow lifecycle delete', () => {
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

  function makeDeleteContext(stmts, db, overrides = {}) {
    const postId = insertScrimPost(stmts);
    stmts.upsertScrimMessageLifecyclePolicy.run({
      guild_id: 'g-del',
      policy: 'delete',
      updated_at: new Date().toISOString(),
    });
    let deleteCalls = 0;
    const message = {
      id: 'msg-del',
      guildId: 'g-del',
      channelId: 'c-del',
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
      getDeleteCalls: () => deleteCalls,
    };
  }

  it('succès delete → completed, un seul delete', async () => {
    await withTempDb(async (db, stmts) => {
      const ctx = makeDeleteContext(stmts, db);
      await syncInactiveScrimMessageByPolicy({
        client: {},
        stmts,
        messageRow: { guild_id: 'g-del', channel_id: 'c-del', message_id: 'msg-del' },
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
      assert.strictEqual(op.operation_type, 'lifecycle_delete');
      assert.strictEqual(op.status, 'completed');
    });
  });

  it('10008 → completed idempotent', async () => {
    await withTempDb(async (db, stmts) => {
      const err = new Error('Unknown Message');
      err.code = 10008;
      const ctx = makeDeleteContext(stmts, db, {
        deleteFn: async () => {
          throw err;
        },
      });

      await syncInactiveScrimMessageByPolicy({
        client: {},
        stmts,
        messageRow: { guild_id: 'g-del', channel_id: 'c-del', message_id: 'msg-del' },
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
    });
  });

  it('terminal permissions → failed_terminal avant enqueue', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      stmts.upsertScrimMessageLifecyclePolicy.run({
        guild_id: 'g-noperm',
        policy: 'delete',
        updated_at: new Date().toISOString(),
      });
      let deleteCalls = 0;
      const message = {
        id: 'msg-noperm',
        guildId: 'g-noperm',
        channelId: 'c-noperm',
        delete: async () => {
          deleteCalls += 1;
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
        messageRow: { guild_id: 'g-noperm', channel_id: 'c-noperm', message_id: 'msg-noperm' },
        scrimPostDbId: postId,
        eventType: 'closed_manual',
        targetStatus: 'closed_manual',
        editOptions: { embeds: [new EmbedBuilder()] },
        guild,
        channel,
        message,
      });

      assert.strictEqual(deleteCalls, 0);
      const op = db
        .prepare(`SELECT * FROM scrim_lifecycle_operations WHERE operation_type = 'lifecycle_delete' ORDER BY id DESC LIMIT 1`)
        .get();
      assert.strictEqual(op.status, 'failed_terminal');
      assert.strictEqual(op.last_error_code, 'MISSING_PERMISSIONS');
    });
  });

  it('M1 — delete réussit + markCompleted shadow throw → ok, exactement 1 delete', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS = '4';
      const ctx = makeDeleteContext(stmts, db);

      const origCompletedRun = stmts.markScrimLifecycleOperationCompleted.run.bind(
        stmts.markScrimLifecycleOperationCompleted,
      );
      stmts.markScrimLifecycleOperationCompleted.run = () => {
        throw new Error('shadow mark completed simulated failure');
      };

      try {
        await syncInactiveScrimMessageByPolicy({
          client: {},
          stmts,
          messageRow: { guild_id: 'g-del', channel_id: 'c-del', message_id: 'msg-del' },
          scrimPostDbId: ctx.postId,
          eventType: 'closed_manual',
          targetStatus: 'closed_manual',
          editOptions: { embeds: [new EmbedBuilder()] },
          guild: ctx.guild,
          channel: ctx.channel,
          message: ctx.message,
        });

        assert.strictEqual(ctx.getDeleteCalls(), 1);
      } finally {
        stmts.markScrimLifecycleOperationCompleted.run = origCompletedRun;
        delete process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS;
      }
    });
  });
});

describe('Phase 3A — restart semantics', () => {
  it('row pending edit survit DB reopen ; dispatcher démarre sans replay edit (3F)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-lifecycle-3a-restart-'));
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = path.join(dir, 'test.db');
    let opId;
    try {
      const db = getDb();
      const stmts = prepareStatements(db);
      const postId = insertScrimPost(stmts);
      opId = stmts.createScrimLifecycleOperation.run({
        scrim_post_db_id: postId,
        guild_id: 'g1',
        channel_id: 'c1',
        message_id: 'm1',
        operation_type: 'lifecycle_edit',
        target_status: 'closed_manual',
        priority: 'low',
        payload_json: '{}',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).lastInsertRowid;
      closeDb();

      const db2 = getDb();
      const row = db2.prepare(`SELECT status FROM scrim_lifecycle_operations WHERE id = ?`).get(opId);
      assert.strictEqual(row.status, 'pending');

      const botSource = fs.readFileSync(
        new URL('../src/bot.js', import.meta.url),
        'utf8',
      );
      assert.match(botSource, /startScrimLifecycleDispatcher/);
      closeDb();
    } finally {
      closeDb();
      if (prev === undefined) delete process.env.SQLITE_PATH;
      else process.env.SQLITE_PATH = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Phase 3A — caractérisation legacy (sans correction)', () => {
  it('runDiscordEditRetryPass annule edit stale si scrim déjà fermé (Phase 3B)', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
      process.env.DISCORD_API_MAX_ATTEMPTS = '1';
      startDiscordTaskQueue();
      try {
        const postId = insertScrimPost(stmts);
        db.prepare(`UPDATE scrim_posts SET status = 'closed_manual' WHERE id = ?`).run(postId);

        const now = new Date().toISOString();
        stmts.insertDiscordEditRetry.run({
          scrim_post_db_id: postId,
          guild_id: 'g-stale',
          channel_id: 'c-stale',
          message_id: 'm-stale',
          target_status: 'superseded_repost',
          attempt_count: 0,
          next_attempt_at: now,
          last_error_code: 'HTTP_503',
          last_error_message: 'test',
          payload_json: JSON.stringify({ v: 2, content: null, embeds: [{ title: 'stale' }] }),
          lifecycle_operation_id: null,
          created_at: now,
          updated_at: now,
        });

        let editCalls = 0;
        const mockClient = {
          guilds: {
            fetch: async () => ({
              channels: {
                fetch: async () => ({
                  isTextBased: () => true,
                  messages: {
                    fetch: async () => ({
                      id: 'm-stale',
                      channelId: 'c-stale',
                      edit: async () => {
                        editCalls += 1;
                      },
                    }),
                  },
                }),
              },
            }),
          },
        };

        const out = await runDiscordEditRetryPass(mockClient, stmts);
        assert.strictEqual(out.success, 0);
        assert.strictEqual(out.abandoned, 1);
        assert.strictEqual(editCalls, 0);
      } finally {
        await stopDiscordTaskQueue();
      }
    });
  });

  it('runScrimExpirationPass ferme scrim expiré (mock client sans guild)', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
      startDiscordTaskQueue();
      try {
        const past = new Date(Date.now() - 3600000).toISOString();
        const r = stmts.insertScrimPostRow.run({
          scrim_public_id: 4242,
          author_user_id: 'u-exp',
          origin_guild_id: 'g-exp',
          source_guild_id: 'g-exp',
          game_key: 'lol',
          rank_key: 'Gold',
          format_key: 'BO1',
          contact_user_id: 'u-exp',
          contact_display_name: null,
          scheduled_date: '01/01/2020',
          scheduled_time: '12:00',
          scheduled_at: past,
          scheduled_at_end: past,
          tags: '[]',
          multi_opgg_url: null,
          elo_precision: null,
          structure_guild_id: null,
          structure_name_snapshot: null,
          structure_invite_url_snapshot: null,
          created_at: Date.now(),
          status: 'active',
        });
        const postId = Number(r.lastInsertRowid);

        const mockClient = { guilds: { fetch: async () => null } };
        const out = await runScrimExpirationPass(mockClient, db, stmts);
        assert.strictEqual(out.count, 1);

        const row = stmts.getScrimPostById.get(postId);
        assert.strictEqual(row.status, 'closed_expired');
      } finally {
        await stopDiscordTaskQueue();
      }
    });
  });

  it('repost vs close — close pendant broadcast sync lifecycle nouveaux messages (3E)', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
      process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS = '1';
      startDiscordTaskQueue();
      try {
        const postId = insertScrimPost(stmts);
        stmts.insertScrimPostMessage.run({
          scrim_post_db_id: postId,
          guild_id: 'g1',
          channel_id: 'c-old',
          message_id: 'old-msg',
        });
        stmts.upsertGuildChannel.run({
          guild_id: 'g1',
          channel_id: 'c-new',
          game_key: 'lol',
          created_at: Date.now(),
        });

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
                  permissionsFor: () => new PermissionsBitField([
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.EmbedLinks,
                  ]),
                  send: async () => {
                    db.prepare(`UPDATE scrim_posts SET status = 'closed_manual', closed_at = ? WHERE id = ?`)
                      .run(new Date().toISOString(), postId);
                    return { id: 'new-msg', guildId: id, channelId: cid, delete: async () => {} };
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

        const { resetBroadcastPoolForTests, invalidateBroadcastConcurrencyCache } =
          await import('../src/services/scrimBroadcastExecutionPool.js');
        invalidateBroadcastConcurrencyCache();
        process.env.SCRIM_BROADCAST_CONCURRENCY = '1';
        resetBroadcastPoolForTests();

        const { executeRepostCycleForScrim } = await import('../src/services/scrimRepostCycle.js');
        await executeRepostCycleForScrim(mockClient, db, stmts, postId);

        const row = stmts.getScrimPostById.get(postId);
        assert.strictEqual(row.status, 'closed_manual');

        const msgs = stmts.listScrimPostMessagesByPostId.all(postId);
        assert.strictEqual(msgs.length, 2);

        const closeOps = db.prepare(`
          SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE target_status = 'closed_manual'
        `).get();
        assert.ok(Number(closeOps.n) >= 1, '3E : sync close pour messages après close pendant repost');

        const supersedeOps = db.prepare(`
          SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE target_status = 'superseded_repost'
        `).get();
        assert.strictEqual(Number(supersedeOps.n), 0);
      } finally {
        await stopDiscordTaskQueue();
        delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
        delete process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS;
      }
    });
  });
});
