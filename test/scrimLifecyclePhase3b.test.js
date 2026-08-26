/**
 * Phase 3B — fiabilisation lifecycle edits persistants (stale detection, coalescing, retry ↔ shadow op)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { EmbedBuilder } from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { runDiscordEditRetryPass } from '../src/services/discordEditRetryJob.js';
import { safeScrimEmbedMessageEdit } from '../src/services/safeDiscordMessageEdit.js';
import {
  startDiscordTaskQueue,
  stopDiscordTaskQueue,
} from '../src/services/discordTaskQueue.js';
import {
  isScrimLifecycleTargetStatusCurrent,
} from '../src/services/scrimLifecycleTargetStatus.js';
import { closeScrimPostByDbId } from '../src/services/scrimLifecycle.js';
import {
  createScrimLifecycleOperation,
  LIFECYCLE_OP_TYPE_EDIT,
} from '../src/services/scrimLifecycleOperationStore.js';
import { classifyDiscordEditError } from '../src/services/discordRetryPolicy.js';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-lifecycle-3b-'));
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

function mockRetryClient(onEdit) {
  return {
    guilds: {
      fetch: async () => ({
        channels: {
          fetch: async () => ({
            isTextBased: () => true,
            messages: {
              fetch: async () => ({
                id: 'm1',
                channelId: 'c1',
                edit: onEdit,
              }),
            },
          }),
        },
      }),
    },
  };
}

function insertPendingRetry(stmts, postId, targetStatus, lifecycleOpId = null) {
  const now = new Date().toISOString();
  stmts.insertDiscordEditRetry.run({
    scrim_post_db_id: postId,
    guild_id: 'g1',
    channel_id: 'c1',
    message_id: 'm1',
    target_status: targetStatus,
    attempt_count: 0,
    next_attempt_at: now,
    last_error_code: 'HTTP_503',
    last_error_message: 'test',
    payload_json: JSON.stringify({ v: 2, content: null, embeds: [{ title: targetStatus }] }),
    lifecycle_operation_id: lifecycleOpId,
    created_at: now,
    updated_at: now,
  });
}

describe('Phase 3B — migration lifecycle_operation_id', () => {
  it('colonne lifecycle_operation_id idempotente', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-3b-mig-'));
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = path.join(dir, 'test.db');
    try {
      getDb();
      closeDb();
      getDb();
      const db = getDb();
      const cols = db
        .prepare(`PRAGMA table_info(discord_message_edit_retries)`)
        .all()
        .map((c) => c.name);
      assert.ok(cols.includes('lifecycle_operation_id'));
      closeDb();
      getDb();
      const cols2 = getDb()
        .prepare(`PRAGMA table_info(discord_message_edit_retries)`)
        .all()
        .map((c) => c.name);
      assert.ok(cols2.includes('lifecycle_operation_id'));
      closeDb();
    } finally {
      closeDb();
      if (prev === undefined) delete process.env.SQLITE_PATH;
      else process.env.SQLITE_PATH = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Phase 3B — isScrimLifecycleTargetStatusCurrent', () => {
  it('closed_manual : seul closed_manual valide', () => {
    assert.strictEqual(
      isScrimLifecycleTargetStatusCurrent('closed_manual', 'closed_manual').current,
      true,
    );
    assert.strictEqual(
      isScrimLifecycleTargetStatusCurrent('closed_manual', 'superseded_repost').current,
      false,
    );
    assert.strictEqual(
      isScrimLifecycleTargetStatusCurrent('closed_manual', 'closed_expired').current,
      false,
    );
  });

  it('closed_expired : seul closed_expired valide', () => {
    assert.strictEqual(
      isScrimLifecycleTargetStatusCurrent('closed_expired', 'closed_expired').current,
      true,
    );
    assert.strictEqual(
      isScrimLifecycleTargetStatusCurrent('closed_expired', 'superseded_repost').current,
      false,
    );
  });

  it('active : superseded_repost valide ; closed_* obsolètes', () => {
    assert.strictEqual(
      isScrimLifecycleTargetStatusCurrent('active', 'superseded_repost').current,
      true,
    );
    assert.strictEqual(
      isScrimLifecycleTargetStatusCurrent('active', 'closed_manual').current,
      false,
    );
    assert.strictEqual(
      isScrimLifecycleTargetStatusCurrent('active', 'closed_expired').current,
      false,
    );
  });
});

describe('Phase 3B — stale retry (race A/B/C)', () => {
  it('stale superseded_repost after closed_manual → 0 edit', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
      startDiscordTaskQueue();
      try {
        const postId = insertScrimPost(stmts, 'closed_manual');
        insertPendingRetry(stmts, postId, 'superseded_repost');
        let edits = 0;
        const out = await runDiscordEditRetryPass(
          mockRetryClient(async () => {
            edits += 1;
          }),
          stmts,
        );
        assert.strictEqual(edits, 0);
        assert.strictEqual(out.abandoned, 1);
      } finally {
        await stopDiscordTaskQueue();
      }
    });
  });

  it('stale superseded_repost after closed_expired → 0 edit', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
      startDiscordTaskQueue();
      try {
        const postId = insertScrimPost(stmts, 'closed_expired');
        insertPendingRetry(stmts, postId, 'superseded_repost');
        let edits = 0;
        await runDiscordEditRetryPass(
          mockRetryClient(async () => {
            edits += 1;
          }),
          stmts,
        );
        assert.strictEqual(edits, 0);
      } finally {
        await stopDiscordTaskQueue();
      }
    });
  });

  it('stale closed_manual while active → 0 edit', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
      startDiscordTaskQueue();
      try {
        const postId = insertScrimPost(stmts, 'active');
        insertPendingRetry(stmts, postId, 'closed_manual');
        let edits = 0;
        await runDiscordEditRetryPass(
          mockRetryClient(async () => {
            edits += 1;
          }),
          stmts,
        );
        assert.strictEqual(edits, 0);
      } finally {
        await stopDiscordTaskQueue();
      }
    });
  });
});

describe('Phase 3B — cross-status conflict (race D)', () => {
  it('deux target_status : état métier courant gagne à l exécution', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
      startDiscordTaskQueue();
      try {
        const postId = insertScrimPost(stmts, 'closed_manual');
        insertPendingRetry(stmts, postId, 'superseded_repost');
        insertPendingRetry(stmts, postId, 'closed_manual');

        const applied = [];
        await runDiscordEditRetryPass(
          mockRetryClient(async () => {
            applied.push(1);
          }),
          stmts,
        );

        assert.strictEqual(applied.length, 1);
      } finally {
        await stopDiscordTaskQueue();
      }
    });
  });

  it('closeScrimPostByDbId annule superseded_repost pending (coalescing)', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts, 'active');
      insertPendingRetry(stmts, postId, 'superseded_repost');

      const closed = closeScrimPostByDbId(db, stmts, postId, 'closed_manual', 'manual');
      assert.ok(closed);

      const pending = stmts.countPendingDiscordEditRetries.get().n;
      assert.strictEqual(pending, 0);
    });
  });
});

describe('Phase 3B — retry ↔ lifecycle op (race E/F/G)', () => {
  it('retry success → lifecycle op completed', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
      startDiscordTaskQueue();
      try {
        const postId = insertScrimPost(stmts, 'closed_manual');
        const opId = createScrimLifecycleOperation(stmts, {
          scrimPostDbId: postId,
          guildId: 'g1',
          channelId: 'c1',
          messageId: 'm1',
          operationType: LIFECYCLE_OP_TYPE_EDIT,
          targetStatus: 'closed_manual',
          payloadJson: '{}',
        });
        insertPendingRetry(stmts, postId, 'closed_manual', opId);

        await runDiscordEditRetryPass(mockRetryClient(async () => {}), stmts);

        const op = stmts.getScrimLifecycleOperationById.get(opId);
        assert.strictEqual(op.status, 'completed');
      } finally {
        await stopDiscordTaskQueue();
      }
    });
  });

  it('terminal retry → lifecycle op failed_terminal', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
      process.env.DISCORD_API_MAX_ATTEMPTS = '1';
      startDiscordTaskQueue();
      try {
        const postId = insertScrimPost(stmts, 'closed_manual');
        const opId = createScrimLifecycleOperation(stmts, {
          scrimPostDbId: postId,
          guildId: 'g1',
          channelId: 'c1',
          messageId: 'm1',
          operationType: LIFECYCLE_OP_TYPE_EDIT,
          targetStatus: 'closed_manual',
          payloadJson: '{}',
        });
        insertPendingRetry(stmts, postId, 'closed_manual', opId);

        const terminalErr = new Error('Missing Permissions');
        terminalErr.code = 50013;
        assert.strictEqual(classifyDiscordEditError(terminalErr).kind, 'terminal');

        await runDiscordEditRetryPass(
          mockRetryClient(async () => {
            throw terminalErr;
          }),
          stmts,
        );

        const op = stmts.getScrimLifecycleOperationById.get(opId);
        assert.strictEqual(op.status, 'failed_terminal');
      } finally {
        await stopDiscordTaskQueue();
      }
    });
  });

  it('retryable retry → lifecycle op reste pending', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
      process.env.DISCORD_API_MAX_ATTEMPTS = '1';
      startDiscordTaskQueue();
      try {
        const postId = insertScrimPost(stmts, 'closed_manual');
        const opId = createScrimLifecycleOperation(stmts, {
          scrimPostDbId: postId,
          guildId: 'g1',
          channelId: 'c1',
          messageId: 'm1',
          operationType: LIFECYCLE_OP_TYPE_EDIT,
          targetStatus: 'closed_manual',
          payloadJson: '{}',
        });
        insertPendingRetry(stmts, postId, 'closed_manual', opId);

        const retryableErr = new Error('Service Unavailable');
        retryableErr.status = 503;

        await runDiscordEditRetryPass(
          mockRetryClient(async () => {
            throw retryableErr;
          }),
          stmts,
        );

        const op = stmts.getScrimLifecycleOperationById.get(opId);
        assert.strictEqual(op.status, 'pending');
        const pending = stmts.countPendingDiscordEditRetries.get().n;
        assert.strictEqual(pending, 1);
      } finally {
        await stopDiscordTaskQueue();
      }
    });
  });

  it('legacy retry NULL lifecycle_operation_id fonctionne sans crash', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
      startDiscordTaskQueue();
      try {
        const postId = insertScrimPost(stmts, 'closed_manual');
        insertPendingRetry(stmts, postId, 'closed_manual', null);
        let edits = 0;
        const out = await runDiscordEditRetryPass(
          mockRetryClient(async () => {
            edits += 1;
          }),
          stmts,
        );
        assert.strictEqual(edits, 1);
        assert.strictEqual(out.success, 1);
      } finally {
        await stopDiscordTaskQueue();
      }
    });
  });
});

describe('Phase 3B — exactly-once applicatif edit', () => {
  it('stale → exactement 0 message.edit', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
      startDiscordTaskQueue();
      try {
        const postId = insertScrimPost(stmts, 'closed_expired');
        insertPendingRetry(stmts, postId, 'superseded_repost');
        let edits = 0;
        await runDiscordEditRetryPass(
          mockRetryClient(async () => {
            edits += 1;
          }),
          stmts,
        );
        assert.strictEqual(edits, 0);
      } finally {
        await stopDiscordTaskQueue();
      }
    });
  });

  it('retry valide → max 1 message.edit', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
      startDiscordTaskQueue();
      try {
        const postId = insertScrimPost(stmts, 'active');
        insertPendingRetry(stmts, postId, 'superseded_repost');
        let edits = 0;
        await runDiscordEditRetryPass(
          mockRetryClient(async () => {
            edits += 1;
          }),
          stmts,
        );
        assert.strictEqual(edits, 1);
      } finally {
        await stopDiscordTaskQueue();
      }
    });
  });
});

describe('Phase 3B — safeScrimEmbedMessageEdit lie lifecycle_operation_id au retry', () => {
  it('échec retryable enqueue avec lifecycle_operation_id', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
      process.env.DISCORD_API_MAX_ATTEMPTS = '1';
      startDiscordTaskQueue();
      try {
        const postId = insertScrimPost(stmts, 'active');
        const retryableErr = new Error('Service Unavailable');
        retryableErr.status = 503;

        const mockMessage = {
          id: 'm-enq',
          channelId: 'c-enq',
          guildId: 'g-enq',
          edit: async () => {
            throw retryableErr;
          },
        };

        const result = await safeScrimEmbedMessageEdit({
          client: {},
          stmts,
          scrimPostDbId: postId,
          guildId: 'g-enq',
          channelId: 'c-enq',
          messageId: 'm-enq',
          targetStatus: 'superseded_repost',
          editOptions: { embeds: [new EmbedBuilder().setTitle('repost')] },
          message: mockMessage,
        });

        assert.strictEqual(result, 'queued');
        const retry = stmts.getPendingDiscordEditRetry.get(
          'g-enq',
          'c-enq',
          'm-enq',
          'superseded_repost',
        );
        assert.ok(retry);
        assert.ok(retry.lifecycle_operation_id != null);
        const op = stmts.getScrimLifecycleOperationById.get(retry.lifecycle_operation_id);
        assert.strictEqual(op.status, 'pending');
      } finally {
        await stopDiscordTaskQueue();
      }
    });
  });
});

describe('Phase 3B — no startup replay', () => {
  it('bot.js ne démarre pas de worker lifecycle op', () => {
    const botSource = fs.readFileSync(
      new URL('../src/bot.js', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(botSource, /scrim_lifecycle_operations/);
  });
});
