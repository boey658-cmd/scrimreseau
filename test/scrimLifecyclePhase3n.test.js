/**
 * Phase 3N — symétrie attempt_count edit / delete (claim = seul incrément)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import {
  claimNextScrimLifecycleOperation,
  recoverScrimLifecycleDispatcherAtStartup,
} from '../src/services/scrimLifecycleDispatcher.js';
import {
  insertOrchestratedScrimLifecycleOperation,
  LIFECYCLE_OP_TYPE_DELETE,
  LIFECYCLE_OP_TYPE_EDIT,
} from '../src/services/scrimLifecycleOperationStore.js';
import { scheduleScrimLifecycleEditRetry } from '../src/services/scrimLifecycleEditRetry.js';
import {
  scheduleScrimLifecycleDeleteRetry,
  classifyDiscordDeleteError,
} from '../src/services/scrimLifecycleDeleteRetry.js';
import {
  SCRIM_LIFECYCLE_MAX_ATTEMPTS,
  terminalizeExhaustedScrimLifecycleOperations,
} from '../src/services/scrimLifecycleAttempts.js';
import { classifyDiscordEditError } from '../src/services/discordRetryPolicy.js';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-lifecycle-3n-'));
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
  const info = stmts.insertScrimPostRow.run({
    scrim_public_id: Math.floor(Math.random() * 9000) + 1,
    author_user_id: 'user-3n',
    origin_guild_id: 'g1',
    source_guild_id: 'g1',
    game_key: 'league_of_legends',
    rank_key: 'Gold',
    format_key: 'BO1',
    contact_user_id: 'user-3n',
    contact_display_name: null,
    scheduled_date: '01/09/2026',
    scheduled_time: '20:00',
    scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    scheduled_at_end: null,
    tags: '[]',
    multi_opgg_url: null,
    elo_precision: null,
    structure_guild_id: null,
    structure_name_snapshot: null,
    structure_invite_url_snapshot: null,
    created_at: Date.now(),
    status: 'closed_manual',
  });
  return Number(info.lastInsertRowid);
}

/**
 * @param {ReturnType<import('../src/database/db.js')['prepareStatements']>} stmts
 * @param {'lifecycle_edit'|'lifecycle_delete'} opType
 * @param {string} messageId
 */
function insertOp(stmts, postId, opType, messageId) {
  return insertOrchestratedScrimLifecycleOperation(stmts, {
    scrimPostDbId: postId,
    guildId: 'g1',
    channelId: 'c1',
    messageId,
    operationType: opType,
    targetStatus: 'closed_manual',
    eventKey: `${opType === LIFECYCLE_OP_TYPE_EDIT ? 'close' : 'close-del'}:${postId}:closed_manual:${messageId}`,
    payloadJson:
      opType === LIFECYCLE_OP_TYPE_EDIT
        ? JSON.stringify({ v: 2, content: null, embeds: [] })
        : null,
  });
}

/**
 * Claim → schedule retry → force next_attempt_at due for prochain claim.
 * @returns {number} attempt_count après schedule
 */
function claimThenSchedule(stmts, db, opType) {
  const op = claimNextScrimLifecycleOperation(stmts);
  assert.ok(op, 'claim attendu');
  assert.strictEqual(op.operation_type, opType);
  const afterClaim = Number(op.attempt_count);
  const schedule =
    opType === LIFECYCLE_OP_TYPE_EDIT
      ? scheduleScrimLifecycleEditRetry
      : scheduleScrimLifecycleDeleteRetry;
  const out = schedule(stmts, Number(op.id), 'HTTP_503', 'Service Unavailable');
  assert.strictEqual(out, 'scheduled');
  const row = stmts.getScrimLifecycleOperationById.get(op.id);
  assert.strictEqual(row.status, 'pending');
  assert.strictEqual(Number(row.attempt_count), afterClaim, 'retry conserve attempt_count post-claim');
  const nextMs = new Date(String(row.next_attempt_at)).getTime();
  assert.ok(nextMs > Date.now() + 1_000, 'F — next_attempt_at futur (pas due-now)');
  // Rendre due pour le prochain claim de test (sans hot-loop prod)
  db.prepare(`UPDATE scrim_lifecycle_operations SET next_attempt_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 1000).toISOString(),
    op.id,
  );
  return afterClaim;
}

/**
 * 5e claim : attempt_count=5 → schedule retourne terminal.
 * @returns {number}
 */
function claimThenTerminal(stmts, opType) {
  const op = claimNextScrimLifecycleOperation(stmts);
  assert.ok(op, 'claim attendu');
  assert.strictEqual(op.operation_type, opType);
  const afterClaim = Number(op.attempt_count);
  assert.strictEqual(afterClaim, SCRIM_LIFECYCLE_MAX_ATTEMPTS);
  const schedule =
    opType === LIFECYCLE_OP_TYPE_EDIT
      ? scheduleScrimLifecycleEditRetry
      : scheduleScrimLifecycleDeleteRetry;
  assert.strictEqual(schedule(stmts, Number(op.id), 'HTTP_503', 'Service Unavailable'), 'terminal');
  const row = stmts.getScrimLifecycleOperationById.get(op.id);
  assert.strictEqual(row.status, 'failed_terminal');
  assert.strictEqual(row.last_error_code, 'RETRY_EXHAUSTED');
  assert.strictEqual(Number(row.attempt_count), SCRIM_LIFECYCLE_MAX_ATTEMPTS);
  return afterClaim;
}

describe('Phase 3N — attempt_count edit/delete symmetry', () => {
  it('A. lifecycle_edit : claim 1 -> retry conserve 1', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertOp(stmts, postId, LIFECYCLE_OP_TYPE_EDIT, 'm-edit-a');
      const n = claimThenSchedule(stmts, db, LIFECYCLE_OP_TYPE_EDIT);
      assert.strictEqual(n, 1);
    });
  });

  it('B. lifecycle_delete : claim 1 -> retry conserve 1', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertOp(stmts, postId, LIFECYCLE_OP_TYPE_DELETE, 'm-del-b');
      const n = claimThenSchedule(stmts, db, LIFECYCLE_OP_TYPE_DELETE);
      assert.strictEqual(n, 1);
    });
  });

  it('C/D. claims successifs 1..5 symétriques ; delete pas exhausted avant edit', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      insertOp(stmts, postId, LIFECYCLE_OP_TYPE_EDIT, 'm-edit-cd');

      /** @type {number[]} */
      const editScheduled = [];
      for (let i = 0; i < SCRIM_LIFECYCLE_MAX_ATTEMPTS - 1; i += 1) {
        editScheduled.push(claimThenSchedule(stmts, db, LIFECYCLE_OP_TYPE_EDIT));
      }
      assert.deepStrictEqual(editScheduled, [1, 2, 3, 4]);

      // 5e claim → attempt_count=5 → schedule terminal (même sémantique edit)
      const editFifth = claimThenTerminal(stmts, LIFECYCLE_OP_TYPE_EDIT);
      assert.strictEqual(editFifth, 5);

      insertOp(stmts, postId, LIFECYCLE_OP_TYPE_DELETE, 'm-del-cd');
      /** @type {number[]} */
      const deleteScheduled = [];
      for (let i = 0; i < SCRIM_LIFECYCLE_MAX_ATTEMPTS - 1; i += 1) {
        deleteScheduled.push(claimThenSchedule(stmts, db, LIFECYCLE_OP_TYPE_DELETE));
      }
      assert.deepStrictEqual(deleteScheduled, [1, 2, 3, 4]);
      const delFifth = claimThenTerminal(stmts, LIFECYCLE_OP_TYPE_DELETE);
      assert.strictEqual(delFifth, 5);

      const editRow = db.prepare(`SELECT * FROM scrim_lifecycle_operations WHERE message_id = 'm-edit-cd'`).get();
      const delRow = db.prepare(`SELECT * FROM scrim_lifecycle_operations WHERE message_id = 'm-del-cd'`).get();
      assert.strictEqual(editRow.status, 'failed_terminal');
      assert.strictEqual(delRow.status, 'failed_terminal');
      assert.strictEqual(editRow.last_error_code, 'RETRY_EXHAUSTED');
      assert.strictEqual(delRow.last_error_code, 'RETRY_EXHAUSTED');
      assert.strictEqual(Number(editRow.attempt_count), 5);
      assert.strictEqual(Number(delRow.attempt_count), 5);

      // Non claimable ensuite
      assert.strictEqual(claimNextScrimLifecycleOperation(stmts), null);
    });
  });

  it('E. attempt_count >= 5 : schedule terminal immédiat (edit et delete)', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const e = insertOp(stmts, postId, LIFECYCLE_OP_TYPE_EDIT, 'm-edit-e');
      const d = insertOp(stmts, postId, LIFECYCLE_OP_TYPE_DELETE, 'm-del-e');
      db.prepare(`UPDATE scrim_lifecycle_operations SET attempt_count = 5, status = 'processing' WHERE id IN (?, ?)`).run(
        e.operationId,
        d.operationId,
      );
      assert.strictEqual(
        scheduleScrimLifecycleEditRetry(stmts, e.operationId, 'HTTP_503', 'x'),
        'terminal',
      );
      assert.strictEqual(
        scheduleScrimLifecycleDeleteRetry(stmts, d.operationId, 'HTTP_503', 'x'),
        'terminal',
      );
      assert.strictEqual(stmts.getScrimLifecycleOperationById.get(e.operationId).last_error_code, 'RETRY_EXHAUSTED');
      assert.strictEqual(stmts.getScrimLifecycleOperationById.get(d.operationId).last_error_code, 'RETRY_EXHAUSTED');
    });
  });

  it('F. schedule ne remet jamais due-now (délai futur)', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const d = insertOp(stmts, postId, LIFECYCLE_OP_TYPE_DELETE, 'm-del-f');
      db.prepare(`UPDATE scrim_lifecycle_operations SET attempt_count = 1, status = 'processing' WHERE id = ?`).run(
        d.operationId,
      );
      const before = Date.now();
      scheduleScrimLifecycleDeleteRetry(stmts, d.operationId, 'ECONNRESET', 'reset');
      const row = stmts.getScrimLifecycleOperationById.get(d.operationId);
      assert.strictEqual(row.status, 'pending');
      assert.strictEqual(Number(row.attempt_count), 1);
      assert.ok(new Date(String(row.next_attempt_at)).getTime() > before + 30_000);
    });
  });

  it('G. classification terminale inchangée (10008 / 10003 / 503)', () => {
    const gone = Object.assign(new Error('Unknown Message'), { code: 10008 });
    assert.strictEqual(classifyDiscordDeleteError(gone).kind, 'already_gone');

    const missChannel = Object.assign(new Error('Unknown Channel'), { code: 10003 });
    const cDel = classifyDiscordDeleteError(missChannel);
    const cEdit = classifyDiscordEditError(missChannel);
    assert.strictEqual(cDel.kind, cEdit.kind);
    assert.strictEqual(cDel.kind, 'terminal');

    const missGuild = Object.assign(new Error('Unknown Guild'), { code: 10004 });
    assert.strictEqual(classifyDiscordDeleteError(missGuild).kind, 'terminal');

    const svc = Object.assign(new Error('Service Unavailable'), { status: 503 });
    assert.strictEqual(classifyDiscordDeleteError(svc).kind, 'retryable');
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    assert.strictEqual(classifyDiscordDeleteError(reset).kind, 'retryable');
  });

  it('startup recover + exhausted sweep inchangé pour rows attempt_count explosé', async () => {
    await withTempDb(async (db, stmts) => {
      const postId = insertScrimPost(stmts);
      const d = insertOp(stmts, postId, LIFECYCLE_OP_TYPE_DELETE, 'm-del-old');
      db.prepare(
        `UPDATE scrim_lifecycle_operations SET attempt_count = 78, status = 'pending', next_attempt_at = ? WHERE id = ?`,
      ).run(new Date().toISOString(), d.operationId);
      recoverScrimLifecycleDispatcherAtStartup(stmts);
      assert.strictEqual(claimNextScrimLifecycleOperation(stmts), null);
      const row = stmts.getScrimLifecycleOperationById.get(d.operationId);
      assert.strictEqual(row.status, 'failed_terminal');
      assert.strictEqual(row.last_error_code, 'RETRY_EXHAUSTED');
    });
  });
});
