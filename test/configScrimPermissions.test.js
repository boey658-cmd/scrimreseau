import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  SCRIM_ALLOWED_ROLES_MAX,
  transactionAppendScrimAllowedRole,
  transactionSetEveryoneMode,
  validateScrimAllowedRoleAppend,
} from '../src/commands/configScrimPermissions.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';

/**
 * @param {() => void} fn
 */
function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-perms-test-'));
  const prev = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  try {
    const db = getDb();
    const stmts = prepareStatements(db);
    const ctx = { db, stmts };
    fn(ctx);
  } finally {
    closeDb();
    if (prev === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('validateScrimAllowedRoleAppend — accepte un nouveau rôle', () => {
  assert.deepEqual(validateScrimAllowedRoleAppend(['1'], '2'), { ok: true });
});

test('validateScrimAllowedRoleAppend — déduplication', () => {
  assert.deepEqual(validateScrimAllowedRoleAppend(['1', '2'], '2'), {
    ok: false,
    reason: 'duplicate',
  });
});

test('validateScrimAllowedRoleAppend — max 5', () => {
  const five = ['1', '2', '3', '4', '5'];
  assert.equal(five.length, SCRIM_ALLOWED_ROLES_MAX);
  assert.deepEqual(validateScrimAllowedRoleAppend(five, '6'), {
    ok: false,
    reason: 'max',
  });
});

test('DB — ajout A puis B conserve les deux rôles', () => {
  withTempDb((ctx) => {
    const guildId = 'guild-merge-test';
    transactionAppendScrimAllowedRole(ctx, guildId, 'role-a');
    transactionAppendScrimAllowedRole(ctx, guildId, 'role-b');
    const rows = ctx.stmts.listScrimAllowedRoles.all(guildId);
    const ids = rows.map((r) => r.role_id).sort();
    assert.deepEqual(ids, ['role-a', 'role-b']);
    const mode = ctx.stmts.getScrimPermissionMode.get(guildId);
    assert.equal(mode?.mode, 'roles');
  });
});

test('DB — pas d’écrasement au second ajout', () => {
  withTempDb((ctx) => {
    const guildId = 'guild-no-wipe';
    for (const id of ['r1', 'r2', 'r3']) {
      transactionAppendScrimAllowedRole(ctx, guildId, id);
    }
    assert.equal(
      ctx.stmts.listScrimAllowedRoles.all(guildId).length,
      3,
    );
  });
});

test('DB — compatibilité : rôle préexistant + nouvel ajout', () => {
  withTempDb((ctx) => {
    const guildId = 'guild-existing';
    ctx.stmts.insertScrimAllowedRole.run(guildId, 'legacy-role');
    ctx.stmts.upsertScrimPermissionMode.run({
      guild_id: guildId,
      mode: 'roles',
    });
    transactionAppendScrimAllowedRole(ctx, guildId, 'new-role');
    const ids = ctx.stmts.listScrimAllowedRoles
      .all(guildId)
      .map((r) => r.role_id)
      .sort();
    assert.deepEqual(ids, ['legacy-role', 'new-role']);
  });
});

test('DB — mode everyone supprime tous les rôles', () => {
  withTempDb((ctx) => {
    const guildId = 'guild-everyone';
    transactionAppendScrimAllowedRole(ctx, guildId, 'role-x');
    transactionAppendScrimAllowedRole(ctx, guildId, 'role-y');
    transactionSetEveryoneMode(ctx, guildId);
    assert.equal(ctx.stmts.listScrimAllowedRoles.all(guildId).length, 0);
    assert.equal(
      ctx.stmts.getScrimPermissionMode.get(guildId)?.mode,
      'everyone',
    );
  });
});
