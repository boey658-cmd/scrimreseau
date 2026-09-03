/**
 * Tests — rotation / sélection des logos du dashboard réseau.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import {
  advanceRotationOffset,
  MAX_VISIBLE_PARTNERS,
  selectVisiblePartnerIds,
} from '../src/services/networkDashboardRotation.js';

describe('networkDashboardRotation — selectVisiblePartnerIds', () => {
  it('0 partenaires → []', () => {
    assert.deepEqual(selectVisiblePartnerIds([], 0), []);
  });

  it('1 partenaire → cet id', () => {
    assert.deepEqual(selectVisiblePartnerIds(['g1'], 0), ['g1']);
  });

  it('5 partenaires → les 5, sans duplication', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const visible = selectVisiblePartnerIds(ids, 0);
    assert.equal(visible.length, 5);
    assert.deepEqual(visible, ids);
    assert.equal(new Set(visible).size, 5);
  });

  it('14 partenaires → les 14', () => {
    const ids = Array.from({ length: 14 }, (_, i) => `g${i}`);
    const visible = selectVisiblePartnerIds(ids, 0);
    assert.equal(visible.length, 14);
    assert.deepEqual(visible, ids);
  });

  it('15 partenaires → fenêtre de 14', () => {
    const ids = Array.from({ length: 15 }, (_, i) => `g${i}`);
    const visible = selectVisiblePartnerIds(ids, 0);
    assert.equal(visible.length, MAX_VISIBLE_PARTNERS);
    assert.deepEqual(visible, ids.slice(0, 14));
    assert.equal(new Set(visible).size, 14);
  });

  it('20 partenaires offset 0 → 0..13', () => {
    const ids = Array.from({ length: 20 }, (_, i) => String(i));
    assert.deepEqual(
      selectVisiblePartnerIds(ids, 0, 14),
      ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'],
    );
  });

  it('20 partenaires offset 14 → wrap-around', () => {
    const ids = Array.from({ length: 20 }, (_, i) => String(i));
    assert.deepEqual(
      selectVisiblePartnerIds(ids, 14, 14),
      ['14', '15', '16', '17', '18', '19', '0', '1', '2', '3', '4', '5', '6', '7'],
    );
  });

  it('50 / 100 partenaires → toujours 14 distincts', () => {
    for (const n of [50, 100]) {
      const ids = Array.from({ length: n }, (_, i) => `g${i}`);
      const visible = selectVisiblePartnerIds(ids, 7, 14);
      assert.equal(visible.length, 14, `n=${n}`);
      assert.equal(new Set(visible).size, 14, `n=${n}`);
    }
  });

  it('N < 14 : aucun id répété même avec gros offset', () => {
    const ids = ['a', 'b', 'c'];
    const visible = selectVisiblePartnerIds(ids, 99, 14);
    assert.deepEqual(visible, ids);
    assert.equal(new Set(visible).size, 3);
  });
});

describe('networkDashboardRotation — advanceRotationOffset', () => {
  it('avance de 14 modulo N', () => {
    assert.equal(advanceRotationOffset(0, 50, 14), 14);
    assert.equal(advanceRotationOffset(14, 50, 14), 28);
    assert.equal(advanceRotationOffset(42, 50, 14), 6);
  });

  it('partnerCount 0 → 0', () => {
    assert.equal(advanceRotationOffset(10, 0, 14), 0);
  });

  it('cycle sur N=20', () => {
    let offset = 0;
    offset = advanceRotationOffset(offset, 20, 14);
    assert.equal(offset, 14);
    offset = advanceRotationOffset(offset, 20, 14);
    assert.equal(offset, 8);
    offset = advanceRotationOffset(offset, 20, 14);
    assert.equal(offset, 2);
  });
});

describe('networkDashboardRotation — SQLite offset persistence', () => {
  it('migration : défaut 0, lecture / écriture, idempotence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-dash-rot-'));
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = path.join(dir, 'test.db');
    try {
      closeDb();
      const db = getDb();
      const stmts = prepareStatements(db);

      const row = stmts.getNetworkDashboardPartnerOffset.get();
      assert.ok(row);
      assert.equal(Number(row.partner_rotation_offset), 0);

      stmts.setNetworkDashboardPartnerOffset.run({
        partner_rotation_offset: 28,
        updated_at: new Date().toISOString(),
      });
      assert.equal(Number(stmts.getNetworkDashboardPartnerOffset.get().partner_rotation_offset), 28);

      closeDb();
      const db2 = getDb();
      const stmts2 = prepareStatements(db2);
      assert.equal(Number(stmts2.getNetworkDashboardPartnerOffset.get().partner_rotation_offset), 28);
      closeDb();
    } finally {
      if (prev === undefined) delete process.env.SQLITE_PATH;
      else process.env.SQLITE_PATH = prev;
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('networkDashboardRotation — invariants compteur / limite', () => {
  it('MAX_VISIBLE_PARTNERS === 14', () => {
    assert.equal(MAX_VISIBLE_PARTNERS, 14);
  });

  it('compteur total indépendant de la fenêtre visible', () => {
    const partnerIds = Array.from({ length: 100 }, (_, i) => `g${i}`);
    const visible = selectVisiblePartnerIds(partnerIds, 42, MAX_VISIBLE_PARTNERS);
    assert.equal(partnerIds.length, 100);
    assert.equal(visible.length, 14);
    assert.notEqual(visible.length, partnerIds.length);
  });
});
