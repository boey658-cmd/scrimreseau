/**
 * Phase 3D — orchestration lifecycle persistante (close, expiration, supersede)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { EmbedBuilder, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import {
  buildScrimLifecycleEventKey,
  closeScrimPostByDbIdAndExecuteLifecycle,
  orchestrateScrimCloseInTransaction,
  orchestrateScrimSupersedeInTransaction,
} from '../src/services/scrimLifecycleOrchestrator.js';
import {
  drainScrimLifecycleDispatcher,
  startScrimLifecycleDispatcher,
  stopScrimLifecycleDispatcher,
} from '../src/services/scrimLifecycleDispatcher.js';
import {
  runScrimLifecycleRecoveryPass,
} from '../src/services/scrimLifecycleRecoveryJob.js';
import {
  startDiscordTaskQueue,
  stopDiscordTaskQueue,
} from '../src/services/discordTaskQueue.js';
import { closeScrimPostByDbId } from '../src/services/scrimLifecycle.js';
import { getScrimLifecycleOperationById } from '../src/services/scrimLifecycleOperationStore.js';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-lifecycle-3d-'));
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

function insertMessage(stmts, postId, guildId, channelId, messageId) {
  stmts.insertScrimPostMessage.run({
    scrim_post_db_id: postId,
    guild_id: guildId,
    channel_id: channelId,
    message_id: messageId,
  });
}

describe('Phase 3D — migration event_key', () => {
  it('colonne event_key idempotente', async () => {
    await withTempDb(async (db) => {
      const cols = db
        .prepare(`PRAGMA table_info(scrim_lifecycle_operations)`)
        .all()
        .map((c) => c.name);
      assert.ok(cols.includes('event_key'));
    });
  });
});

describe('Phase 3D — event_key / dedupe', () => {
  it('buildScrimLifecycleEventKey close vs supersede generation', () => {
    assert.strictEqual(
      buildScrimLifecycleEventKey(1, 'closed_manual', 'm1'),
      'close:1:closed_manual:m1',
    );
    assert.strictEqual(
      buildScrimLifecycleEventKey(1, 'superseded_repost', 'm1', 2),
      'supersede:1:2:m1',
    );
    assert.notStrictEqual(
      buildScrimLifecycleEventKey(1, 'superseded_repost', 'm1', 1),
      buildScrimLifecycleEventKey(1, 'superseded_repost', 'm1', 2),
    );
  });

  it('duplicate orchestration close → pas de duplication ops', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g1', 'c1', 'm1');

      const r1 = orchestrateScrimCloseInTransaction(
        db,
        stmts,
        postId,
        'closed_manual',
        'manual',
      );
      assert.ok(r1.closed);
      assert.strictEqual(r1.operations.length, 1);

      const r2 = orchestrateScrimCloseInTransaction(
        db,
        stmts,
        postId,
        'closed_manual',
        'manual',
      );
      assert.strictEqual(r2.closed, false);
      assert.strictEqual(r2.operations.length, 0);

      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE scrim_post_db_id = ?`)
        .get(postId);
      assert.strictEqual(Number(count.n), 1);
    });
  });
});

describe('Phase 3D — manual close orchestration (A)', () => {
  beforeEach(() => {
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    process.env.DISCORD_API_MAX_ATTEMPTS = '1';
    process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS = '1';
    startDiscordTaskQueue();
  });

  afterEach(async () => {
    await stopScrimLifecycleDispatcher();
    await stopDiscordTaskQueue();
    delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    delete process.env.DISCORD_API_MAX_ATTEMPTS;
    delete process.env.DISCORD_TASK_QUEUE_MAX_ATTEMPTS;
  });

  it('close edit policy → op lifecycle_edit + payload + exécution', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g-close', 'c-close', 'm-close');

      let editCalls = 0;
      const mockClient = {
        guilds: {
          fetch: async () => ({
            channels: {
              fetch: async () => ({
                isTextBased: () => true,
                messages: {
                  fetch: async () => ({
                    id: 'm-close',
                    channelId: 'c-close',
                    guildId: 'g-close',
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

      startScrimLifecycleDispatcher(mockClient, stmts);
      const ok = await closeScrimPostByDbIdAndExecuteLifecycle(
        mockClient,
        db,
        stmts,
        postId,
        'closed_manual',
        'manual',
      );
      assert.ok(ok);
      await drainScrimLifecycleDispatcher(mockClient, stmts, { timeoutMs: 15_000 });
      assert.strictEqual(editCalls, 1);

      const op = db
        .prepare(`SELECT * FROM scrim_lifecycle_operations WHERE scrim_post_db_id = ?`)
        .get(postId);
      assert.strictEqual(op.operation_type, 'lifecycle_edit');
      assert.ok(op.payload_json);
      assert.ok(op.event_key.includes('closed_manual'));
      assert.strictEqual(op.status, 'completed');
    });
  });

  it('close delete policy → op lifecycle_delete snapshot', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g-del', 'c-del', 'm-del');
      stmts.upsertScrimMessageLifecyclePolicy.run({
        guild_id: 'g-del',
        policy: 'delete',
        updated_at: new Date().toISOString(),
      });

      const result = orchestrateScrimCloseInTransaction(
        db,
        stmts,
        postId,
        'closed_expired',
        'expired',
      );
      assert.ok(result.closed);
      assert.strictEqual(result.operations.length, 1);
      assert.strictEqual(result.operations[0].operation_type, 'lifecycle_delete');
      assert.strictEqual(result.operations[0].target_status, 'closed_expired');
    });
  });
});

describe('Phase 3D — expiration (B)', () => {
  it('orchestration closed_expired même chemin que manual', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g-exp', 'c-exp', 'm-exp');

      const result = orchestrateScrimCloseInTransaction(
        db,
        stmts,
        postId,
        'closed_expired',
        'expired',
      );
      assert.ok(result.closed);
      const op = result.operations[0];
      assert.strictEqual(op.target_status, 'closed_expired');
      assert.ok(String(op.event_key).includes('closed_expired'));
    });
  });
});

describe('Phase 3D — supersede (C)', () => {
  it('scrim reste active + generation distincte', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const row = stmts.getScrimPostById.get(postId);
      const messages = [{ guild_id: 'g1', channel_id: 'c1', message_id: 'm-old' }];
      insertMessage(stmts, postId, 'g1', 'c1', 'm-old');

      const r1 = orchestrateScrimSupersedeInTransaction(db, stmts, row, messages, 1);
      const r2 = orchestrateScrimSupersedeInTransaction(db, stmts, row, messages, 2);

      assert.strictEqual(r1.operations.length, 1);
      assert.strictEqual(r2.operations.length, 1);
      assert.notStrictEqual(r1.operations[0].event_key, r2.operations[0].event_key);

      const status = stmts.getScrimPostById.get(postId).status;
      assert.strictEqual(status, 'active');
    });
  });
});

describe('Phase 3D — crash window / recovery (E)', () => {
  beforeEach(() => {
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    startDiscordTaskQueue();
  });

  afterEach(async () => {
    await stopScrimLifecycleDispatcher();
    await stopDiscordTaskQueue();
    delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
  });

  it('ops créées en TX puis recovery exécute sans re-close', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g-rec', 'c-rec', 'm-rec');

      const result = orchestrateScrimCloseInTransaction(
        db,
        stmts,
        postId,
        'closed_manual',
        'manual',
      );
      assert.ok(result.closed);
      assert.strictEqual(result.operations[0].status, 'pending');

      let edits = 0;
      const mockClient = {
        guilds: {
          fetch: async () => ({
            channels: {
              fetch: async () => ({
                isTextBased: () => true,
                messages: {
                  fetch: async () => ({
                    id: 'm-rec',
                    channelId: 'c-rec',
                    guildId: 'g-rec',
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
      const out = await runScrimLifecycleRecoveryPass(mockClient, stmts);
      assert.strictEqual(out.completed, 1);
      assert.strictEqual(edits, 1);

      const reClose = closeScrimPostByDbId(db, stmts, postId, 'closed_manual', 'manual');
      assert.strictEqual(reClose, false);
    });
  });
});

describe('Phase 3D — stale supersede after close (F)', () => {
  it('supersede op cancelled si scrim fermé', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g1', 'c1', 'm1');
      const row = stmts.getScrimPostById.get(postId);

      orchestrateScrimSupersedeInTransaction(
        db,
        stmts,
        row,
        [{ guild_id: 'g1', channel_id: 'c1', message_id: 'm1' }],
        1,
      );

      orchestrateScrimCloseInTransaction(db, stmts, postId, 'closed_manual', 'manual');

      const supersedeOp = db
        .prepare(`SELECT * FROM scrim_lifecycle_operations WHERE event_key LIKE 'supersede:%'`)
        .get();

      const supersedeAfterClose = getScrimLifecycleOperationById(stmts, Number(supersedeOp.id));
      assert.strictEqual(supersedeAfterClose.status, 'cancelled');

      const mockClient = {
        guilds: {
          fetch: async () => {
            throw new Error('should not fetch');
          },
        },
      };

      let edits = 0;
      mockClient.guilds.fetch = async () => ({
        channels: {
          fetch: async () => ({
            isTextBased: () => true,
            messages: {
              fetch: async () => ({
                id: 'm1',
                edit: async () => {
                  edits += 1;
                },
              }),
            },
          }),
        },
      });

      await runScrimLifecycleRecoveryPass(mockClient, stmts);
      assert.ok(edits <= 1, 'supersede jamais exécuté ; close op au plus 1 edit');

      const opAfter = getScrimLifecycleOperationById(stmts, Number(supersedeOp.id));
      assert.strictEqual(opAfter.status, 'cancelled');
    });
  });
});

describe('Phase 3D — existing operation id (G)', () => {
  beforeEach(() => {
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    startDiscordTaskQueue();
  });

  afterEach(async () => {
    await stopScrimLifecycleDispatcher();
    await stopDiscordTaskQueue();
    delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
  });

  it('exécution orchestrée ne crée pas seconde op shadow', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g1', 'c1', 'm1');

      const result = orchestrateScrimCloseInTransaction(
        db,
        stmts,
        postId,
        'closed_manual',
        'manual',
      );
      assert.strictEqual(result.operations.length, 1);

      let edits = 0;
      const mockClient = {
        guilds: {
          fetch: async () => ({
            channels: {
              fetch: async () => ({
                isTextBased: () => true,
                messages: {
                  fetch: async () => ({
                    id: 'm1',
                    channelId: 'c1',
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
      await runScrimLifecycleRecoveryPass(mockClient, stmts);
      const count = db.prepare(`SELECT COUNT(*) AS n FROM scrim_lifecycle_operations`).get();
      assert.strictEqual(Number(count.n), 1);
      assert.strictEqual(edits, 1);
    });
  });
});

describe('Phase 3D — policy snapshot (H)', () => {
  it('policy delete figée même si changée après orchestration', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertMessage(stmts, postId, 'g-pol', 'c-pol', 'm-pol');
      stmts.upsertScrimMessageLifecyclePolicy.run({
        guild_id: 'g-pol',
        policy: 'delete',
        updated_at: new Date().toISOString(),
      });

      const result = orchestrateScrimCloseInTransaction(
        db,
        stmts,
        postId,
        'closed_manual',
        'manual',
      );
      assert.strictEqual(result.operations[0].operation_type, 'lifecycle_delete');

      stmts.upsertScrimMessageLifecyclePolicy.run({
        guild_id: 'g-pol',
        policy: 'keep',
        updated_at: new Date().toISOString(),
      });

      const op = getScrimLifecycleOperationById(
        stmts,
        Number(result.operations[0].id),
      );
      assert.strictEqual(op.operation_type, 'lifecycle_delete');
    });
  });
});

describe('Phase 3D — wiring shutdown', () => {
  it('dispatcher lifecycle registered in bot/index (3F/3K)', () => {
    const bot = fs.readFileSync(new URL('../src/bot.js', import.meta.url), 'utf8');
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(bot, /startScrimLifecycleDispatcher/);
    assert.match(index, /stopScrimLifecycleDispatcher/);
    const broadcastIdx = index.indexOf('persistent_broadcast_job_stop');
    const producersIdx = index.indexOf('lifecycle_producers_stop');
    const consumersIdx = index.indexOf('lifecycle_consumers_stop');
    assert.ok(broadcastIdx >= 0 && producersIdx > broadcastIdx);
    assert.ok(consumersIdx > producersIdx);
  });
});
