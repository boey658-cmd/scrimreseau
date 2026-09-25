/**
 * Phase 1 — Entitlement Core : catalog, resolver, gifts, grace, cache, concurrency, security.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import {
  listAppliedSchemaMigrations,
  runSchemaMigrations,
  SCHEMA_MIGRATIONS,
} from '../src/database/schemaMigrations.js';
import { ConfigWriteError } from '../src/services/configWriteError.js';
import {
  PLAN_CATALOG,
  PLAN_FREE,
  PLAN_P1,
  PLAN_P2,
  PLAN_P3,
  PAID_GRACE_MS,
  getPlanTier,
  bindEntitlementStore,
  clearEntitlementCache,
  invalidateEntitlementCache,
  getCachedEffectiveEntitlement,
  _entitlementCacheSize,
  getPlan,
  getLimit,
  canUseFeature,
  getEntitlementSnapshot,
  resolveEffectiveEntitlement,
  evaluateGrantAccess,
  grantPremiumGift,
  grantPremiumAccess,
  revokePremiumGrant,
  assertInternalPremiumAdmin,
  runEntitlementExpirationPass,
} from '../src/services/entitlements/index.js';
import { insertEntitlementGrant } from '../src/services/entitlements/entitlementStore.js';

const GUILD = '1484520688726311012';
const GUILD_B = '1436848619796828322';
const ADMIN = '1009269632693174422';
const T0 = 1_700_000_000_000;

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-p1-ent-'));
  const prev = process.env.SQLITE_PATH;
  const prevOwner = process.env.SCRIMRESEAU_OWNER_ID;
  const prevDev = process.env.BOT_DEV_ID;
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  process.env.SCRIMRESEAU_OWNER_ID = ADMIN;
  delete process.env.BOT_DEV_ID;
  try {
    closeDb();
    clearEntitlementCache();
    const db = getDb();
    const stmts = prepareStatements(db);
    bindEntitlementStore(stmts);
    await fn(db, stmts);
  } finally {
    clearEntitlementCache();
    bindEntitlementStore(null);
    closeDb();
    if (prev === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prev;
    if (prevOwner === undefined) delete process.env.SCRIMRESEAU_OWNER_ID;
    else process.env.SCRIMRESEAU_OWNER_ID = prevOwner;
    if (prevDev === undefined) delete process.env.BOT_DEV_ID;
    else process.env.BOT_DEV_ID = prevDev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Phase 1 — planCatalog', () => {
  it('limites reception_channels FREE/P1/P2/P3', () => {
    assert.equal(PLAN_FREE.limits.reception_channels, 1);
    assert.equal(PLAN_P1.limits.reception_channels, 2);
    assert.equal(PLAN_P2.limits.reception_channels, 4);
    assert.equal(PLAN_P3.limits.reception_channels, 10);
  });

  it('tiers ordonnés FREE < P1 < P2 < P3', () => {
    assert.ok(getPlanTier('FREE') < getPlanTier('P1'));
    assert.ok(getPlanTier('P1') < getPlanTier('P2'));
    assert.ok(getPlanTier('P2') < getPlanTier('P3'));
  });

  it('features Premium absentes de FREE', () => {
    assert.equal(PLAN_CATALOG.FREE.features.multi_reception_channels, false);
    assert.equal(PLAN_CATALOG.P1.features.multi_reception_channels, true);
    assert.equal(PLAN_CATALOG.P3.features.embed_presets, true);
  });
});

describe('Phase 1 — migrations entitlement_grants', () => {
  it('DB neuve applique migration grants', async () => {
    await withTempDb(async (db) => {
      const applied = listAppliedSchemaMigrations(db);
      assert.ok(applied.includes('20260923_02_entitlement_grants'));
      const row = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'entitlement_grants'`).get();
      assert.ok(row);
    });
  });

  it('replay runSchemaMigrations idempotent', async () => {
    await withTempDb(async (db) => {
      runSchemaMigrations(db);
      runSchemaMigrations(db);
      assert.ok(SCHEMA_MIGRATIONS.some((m) => m.id === '20260923_02_entitlement_grants'));
    });
  });
});

describe('Phase 1 — FREE implicit', () => {
  it('aucune row => FREE', async () => {
    await withTempDb(async () => {
      assert.equal(getPlan(GUILD), 'FREE');
      assert.equal(getLimit(GUILD, 'reception_channels'), 1);
      assert.equal(canUseFeature(GUILD, 'multi_reception_channels'), false);
      assert.equal(getEntitlementSnapshot(GUILD).source, 'none');
    });
  });

  it('guild inconnue / null => FREE', () => {
    assert.equal(getPlan(null), 'FREE');
    assert.equal(getPlan('not-a-guild'), 'FREE');
  });
});

describe('Phase 1 — resolver table-driven', () => {
  /** @type {Array<{ name: string, setup: (db: any, stmts: any) => void, now: number, expectPlan: string, expectSource?: string, expectStatus?: string }>} */
  const cases = [
    {
      name: 'active P1',
      now: T0 + 1000,
      expectPlan: 'P1',
      expectSource: 'paid',
      expectStatus: 'active',
      setup: (_db, stmts) => {
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P1', source: 'paid',
          startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 't', nowMs: T0,
        });
      },
    },
    {
      name: 'active P2',
      now: T0 + 1000,
      expectPlan: 'P2',
      setup: (_db, stmts) => {
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P2', source: 'paid',
          startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 't', nowMs: T0,
        });
      },
    },
    {
      name: 'expired P3 => FREE',
      now: T0 + 20_000,
      expectPlan: 'FREE',
      setup: (_db, stmts) => {
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P3', source: 'gift',
          startsAt: T0, endsAt: T0 + 5_000, grantedBy: ADMIN, reason: 't', nowMs: T0,
        });
      },
    },
    {
      name: 'scheduled P3 => FREE avant starts',
      now: T0 - 1,
      expectPlan: 'FREE',
      setup: (_db, stmts) => {
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P3', source: 'gift',
          startsAt: T0, endsAt: T0 + 5_000, grantedBy: ADMIN, reason: 't', nowMs: T0 - 100,
        });
      },
    },
    {
      name: 'exactly starts_at => active',
      now: T0,
      expectPlan: 'P1',
      expectStatus: 'active',
      setup: (_db, stmts) => {
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P1', source: 'paid',
          startsAt: T0, endsAt: T0 + 5_000, grantedBy: ADMIN, reason: 't', nowMs: T0 - 1,
        });
      },
    },
    {
      name: 'exactly ends_at => grace paid',
      now: T0 + 5_000,
      expectPlan: 'P2',
      expectStatus: 'grace',
      setup: (_db, stmts) => {
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P2', source: 'paid',
          startsAt: T0, endsAt: T0 + 5_000, grantedBy: ADMIN, reason: 't', nowMs: T0,
        });
      },
    },
    {
      name: 'gift exactly ends_at => FREE (pas de grace)',
      now: T0 + 5_000,
      expectPlan: 'FREE',
      setup: (_db, stmts) => {
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P2', source: 'gift',
          startsAt: T0, endsAt: T0 + 5_000, grantedBy: ADMIN, reason: 't', nowMs: T0,
        });
      },
    },
    {
      name: '1ms avant ends_at gift => active',
      now: T0 + 4_999,
      expectPlan: 'P1',
      setup: (_db, stmts) => {
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P1', source: 'gift',
          startsAt: T0, endsAt: T0 + 5_000, grantedBy: ADMIN, reason: 't', nowMs: T0,
        });
      },
    },
    {
      name: 'paid grace terminée => FREE',
      now: T0 + 5_000 + PAID_GRACE_MS,
      expectPlan: 'FREE',
      setup: (_db, stmts) => {
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P2', source: 'paid',
          startsAt: T0, endsAt: T0 + 5_000, grantedBy: ADMIN, reason: 't', nowMs: T0,
        });
      },
    },
    {
      name: 'paid P1 + gift P2 => P2',
      now: T0 + 1000,
      expectPlan: 'P2',
      expectSource: 'gift',
      setup: (_db, stmts) => {
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P1', source: 'paid',
          startsAt: T0, endsAt: T0 + 30_000, grantedBy: ADMIN, reason: 'paid', nowMs: T0,
        });
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P2', source: 'gift',
          startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'gift', nowMs: T0,
        });
      },
    },
    {
      name: 'paid P2 + gift P1 => P2 (gift ne dégrade pas)',
      now: T0 + 1000,
      expectPlan: 'P2',
      expectSource: 'paid',
      setup: (_db, stmts) => {
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P2', source: 'paid',
          startsAt: T0, endsAt: T0 + 30_000, grantedBy: ADMIN, reason: 'paid', nowMs: T0,
        });
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P1', source: 'gift',
          startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'gift', nowMs: T0,
        });
      },
    },
    {
      name: 'gift P2 expire + paid P1 valide => P1',
      now: T0 + 15_000,
      expectPlan: 'P1',
      expectSource: 'paid',
      setup: (_db, stmts) => {
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P1', source: 'paid',
          startsAt: T0, endsAt: T0 + 30_000, grantedBy: ADMIN, reason: 'paid', nowMs: T0,
        });
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P2', source: 'gift',
          startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'gift', nowMs: T0,
        });
      },
    },
    {
      name: 'paid P3 + gift P2 => P3',
      now: T0 + 1000,
      expectPlan: 'P3',
      expectSource: 'paid',
      setup: (_db, stmts) => {
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P3', source: 'paid',
          startsAt: T0, endsAt: T0 + 30_000, grantedBy: ADMIN, reason: 'paid', nowMs: T0,
        });
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P2', source: 'gift',
          startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'gift', nowMs: T0,
        });
      },
    },
    {
      name: '2 gifts P1+P2 => P2',
      now: T0 + 1000,
      expectPlan: 'P2',
      setup: (_db, stmts) => {
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P1', source: 'gift',
          startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'g1', nowMs: T0,
        });
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD, planKey: 'P2', source: 'gift',
          startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'g2', nowMs: T0,
        });
      },
    },
    {
      name: 'revoked gift => fallback paid',
      now: T0 + 1000,
      expectPlan: 'P1',
      expectSource: 'paid',
      setup: (db, stmts) => {
        insertEntitlementGrant({
          db, stmts, guildId: GUILD, planKey: 'P1', source: 'paid',
          startsAt: T0, endsAt: T0 + 30_000, grantedBy: ADMIN, reason: 'paid', nowMs: T0,
        });
        const g = insertEntitlementGrant({
          db, stmts, guildId: GUILD, planKey: 'P2', source: 'gift',
          startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'gift', nowMs: T0,
        });
        stmts.revokeEntitlementGrant.run({
          id: g.id, status: 'revoked', revoked_at: T0 + 500,
          revoked_by: ADMIN, revoke_reason: 'test', updated_at: T0 + 500,
        });
      },
    },
    {
      name: 'canceled paid still active until ends_at',
      now: T0 + 1000,
      expectPlan: 'P2',
      setup: (db, stmts) => {
        const g = insertEntitlementGrant({
          db, stmts, guildId: GUILD, planKey: 'P2', source: 'paid',
          startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'paid', nowMs: T0,
        });
        stmts.updateEntitlementGrantStatus.run({ id: g.id, status: 'canceled', updated_at: T0 + 100 });
      },
    },
    {
      name: 'isolation guild B',
      now: T0 + 1000,
      expectPlan: 'FREE',
      setup: (_db, stmts) => {
        insertEntitlementGrant({
          db: _db, stmts, guildId: GUILD_B, planKey: 'P3', source: 'gift',
          startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'other', nowMs: T0,
        });
      },
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      await withTempDb(async (db, stmts) => {
        c.setup(db, stmts);
        const snap = resolveEffectiveEntitlement(stmts, GUILD, c.now);
        assert.equal(snap.planKey, c.expectPlan, c.name);
        if (c.expectSource) assert.equal(snap.source, c.expectSource, c.name);
        if (c.expectStatus) assert.equal(snap.status, c.expectStatus, c.name);
      });
    });
  }
});

describe('Phase 1 — gift admin + security', () => {
  it('grantPremiumGift owner OK ; non-admin FORBIDDEN', async () => {
    await withTempDb(async (db, stmts) => {
      const row = grantPremiumGift({
        db, stmts, guildId: GUILD, planKey: 'P2',
        startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'promo',
        nowMs: T0,
      });
      assert.equal(row.source, 'gift');
      assert.equal(getPlan(GUILD, { nowMs: T0 + 1, stmts, bypassCache: true }), 'P2');

      assert.throws(
        () => grantPremiumGift({
          db, stmts, guildId: GUILD, planKey: 'P1',
          startsAt: T0, endsAt: T0 + 10_000, grantedBy: '111111111111111111',
          reason: 'nope', nowMs: T0,
        }),
        (err) => err instanceof ConfigWriteError && err.code === 'FORBIDDEN',
      );
    });
  });

  it('revoke soft — row conservée', async () => {
    await withTempDb(async (db, stmts) => {
      const g = grantPremiumGift({
        db, stmts, guildId: GUILD, planKey: 'P2',
        startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'promo',
        skipAdminCheck: true, nowMs: T0,
      });
      revokePremiumGrant({
        db, stmts, grantId: g.id, revokedBy: ADMIN, revokeReason: 'done',
        skipAdminCheck: true, nowMs: T0 + 100,
      });
      const row = stmts.getEntitlementGrantById.get(g.id);
      assert.equal(row.status, 'revoked');
      assert.equal(getPlan(GUILD, { nowMs: T0 + 200, stmts, bypassCache: true }), 'FREE');
    });
  });

  it('fuzz inputs invalides', async () => {
    await withTempDb(async (db, stmts) => {
      const bad = [
        () => insertEntitlementGrant({
          db, stmts, guildId: '', planKey: 'P1', source: 'gift',
          startsAt: T0, endsAt: T0 + 1, grantedBy: ADMIN, reason: 'x',
        }),
        () => insertEntitlementGrant({
          db, stmts, guildId: GUILD, planKey: 'P999', source: 'gift',
          startsAt: T0, endsAt: T0 + 1, grantedBy: ADMIN, reason: 'x',
        }),
        () => insertEntitlementGrant({
          db, stmts, guildId: GUILD, planKey: 'P1', source: 'gift',
          startsAt: T0 + 10, endsAt: T0, grantedBy: ADMIN, reason: 'x',
        }),
        () => insertEntitlementGrant({
          db, stmts, guildId: GUILD, planKey: 'P1', source: 'gift',
          startsAt: T0, endsAt: T0 + 1, grantedBy: ADMIN, reason: '',
        }),
        () => insertEntitlementGrant({
          db, stmts, guildId: GUILD, planKey: 'P1', source: 'gift',
          startsAt: T0, endsAt: T0 + 1, grantedBy: ADMIN, reason: 'x'.repeat(501),
        }),
      ];
      for (const fn of bad) {
        assert.throws(fn, (err) => err instanceof ConfigWriteError);
      }
    });
  });

  it('idempotency_key ne duplique pas', async () => {
    await withTempDb(async (db, stmts) => {
      const a = insertEntitlementGrant({
        db, stmts, guildId: GUILD, planKey: 'P1', source: 'gift',
        startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'a',
        idempotencyKey: 'op-1', nowMs: T0,
      });
      const b = insertEntitlementGrant({
        db, stmts, guildId: GUILD, planKey: 'P1', source: 'gift',
        startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'a',
        idempotencyKey: 'op-1', nowMs: T0,
      });
      assert.equal(a.id, b.id);
      const n = db.prepare('SELECT COUNT(*) AS c FROM entitlement_grants').get().c;
      assert.equal(n, 1);
    });
  });

  it('assertInternalPremiumAdmin refuse spoof', () => {
    const prev = process.env.SCRIMRESEAU_OWNER_ID;
    process.env.SCRIMRESEAU_OWNER_ID = ADMIN;
    try {
      assert.throws(() => assertInternalPremiumAdmin('999999999999999999'), (e) => e.code === 'FORBIDDEN');
      assert.equal(assertInternalPremiumAdmin(ADMIN), ADMIN);
    } finally {
      if (prev === undefined) delete process.env.SCRIMRESEAU_OWNER_ID;
      else process.env.SCRIMRESEAU_OWNER_ID = prev;
    }
  });
});

describe('Phase 1 — cache + expiration job', () => {
  beforeEach(() => clearEntitlementCache());
  afterEach(() => clearEntitlementCache());

  it('cache hit puis invalidation après revoke', async () => {
    await withTempDb(async (db, stmts) => {
      grantPremiumGift({
        db, stmts, guildId: GUILD, planKey: 'P2',
        startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'c',
        skipAdminCheck: true, nowMs: T0,
      });
      const s1 = getCachedEffectiveEntitlement(GUILD, { nowMs: T0 + 1, stmts });
      assert.equal(s1.planKey, 'P2');
      assert.ok(_entitlementCacheSize() >= 1);
      const g = stmts.listEntitlementGrantsByGuild.all(GUILD)[0];
      revokePremiumGrant({
        db, stmts, grantId: g.id, revokedBy: ADMIN, revokeReason: 'r',
        skipAdminCheck: true, nowMs: T0 + 2,
      });
      const s2 = getCachedEffectiveEntitlement(GUILD, { nowMs: T0 + 3, stmts });
      assert.equal(s2.planKey, 'FREE');
    });
  });

  it('expiration job idempotent + resolve hors job', async () => {
    await withTempDb(async (db, stmts) => {
      insertEntitlementGrant({
        db, stmts, guildId: GUILD, planKey: 'P1', source: 'gift',
        startsAt: T0, endsAt: T0 + 1000, grantedBy: ADMIN, reason: 'e', nowMs: T0,
      });
      assert.equal(resolveEffectiveEntitlement(stmts, GUILD, T0 + 2000).planKey, 'FREE');
      const r1 = runEntitlementExpirationPass(stmts, T0 + 2000);
      assert.ok(r1.normalized >= 1);
      const r2 = runEntitlementExpirationPass(stmts, T0 + 2000);
      assert.equal(r2.normalized, 0);
      const row = stmts.listEntitlementGrantsByGuild.all(GUILD)[0];
      assert.equal(row.status, 'expired');
    });
  });
});

describe('Phase 1 — concurrence', () => {
  it('A/B: gifts + revoke simultanés', async () => {
    await withTempDb(async (db, stmts) => {
      const results = await Promise.all([
        Promise.resolve(grantPremiumGift({
          db, stmts, guildId: GUILD, planKey: 'P1',
          startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'a',
          skipAdminCheck: true, nowMs: T0, idempotencyKey: 'c-a',
        })),
        Promise.resolve(grantPremiumGift({
          db, stmts, guildId: GUILD, planKey: 'P2',
          startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'b',
          skipAdminCheck: true, nowMs: T0, idempotencyKey: 'c-b',
        })),
      ]);
      assert.equal(results.length, 2);
      const snap = resolveEffectiveEntitlement(stmts, GUILD, T0 + 1);
      assert.equal(snap.planKey, 'P2');
      await Promise.all(results.map((g) => Promise.resolve(revokePremiumGrant({
        db, stmts, grantId: g.id, revokedBy: ADMIN, revokeReason: 'x',
        skipAdminCheck: true, nowMs: T0 + 50,
      }))));
      assert.equal(resolveEffectiveEntitlement(stmts, GUILD, T0 + 100).planKey, 'FREE');
    });
  });

  it('H: paid + gift simultanés', async () => {
    await withTempDb(async (db, stmts) => {
      await Promise.all([
        Promise.resolve(grantPremiumAccess({
          db, stmts, guildId: GUILD, planKey: 'P1', source: 'paid',
          startsAt: T0, endsAt: T0 + 30_000, grantedBy: ADMIN, reason: 'paid',
          skipAdminCheck: true, nowMs: T0,
        })),
        Promise.resolve(grantPremiumGift({
          db, stmts, guildId: GUILD, planKey: 'P2',
          startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'gift',
          skipAdminCheck: true, nowMs: T0,
        })),
      ]);
      assert.equal(resolveEffectiveEntitlement(stmts, GUILD, T0 + 1).planKey, 'P2');
      assert.equal(resolveEffectiveEntitlement(stmts, GUILD, T0 + 15_000).planKey, 'P1');
    });
  });
});

describe('Phase 1 — limits via API', () => {
  it('getLimit suit le plan effectif', async () => {
    await withTempDb(async (db, stmts) => {
      assert.equal(getLimit(GUILD, 'reception_channels', { stmts, bypassCache: true }), 1);
      grantPremiumAccess({
        db, stmts, guildId: GUILD, planKey: 'P3', source: 'paid',
        startsAt: T0, endsAt: T0 + 10_000, grantedBy: ADMIN, reason: 'p3',
        skipAdminCheck: true, nowMs: T0,
      });
      clearEntitlementCache();
      bindEntitlementStore(stmts);
      assert.equal(getLimit(GUILD, 'reception_channels', { nowMs: T0 + 1, stmts, bypassCache: true }), 10);
      assert.equal(canUseFeature(GUILD, 'elo_channel_filters', { nowMs: T0 + 1, stmts, bypassCache: true }), true);
      assert.equal(getLimit(GUILD, 'unknown', { stmts, bypassCache: true }), 0);
    });
  });
});

describe('Phase 1 — evaluateGrantAccess boundaries', () => {
  it('1ms avant starts invalid ; grace exclusive end', () => {
    const grant = {
      id: 1, guild_id: GUILD, plan_key: 'P1', source: 'paid', status: 'active',
      starts_at: T0, ends_at: T0 + 1000, grace_ends_at: T0 + 1000 + PAID_GRACE_MS,
      granted_by: ADMIN, reason: 't', external_ref: null, idempotency_key: null,
      provider: null, revoked_at: null, revoked_by: null, revoke_reason: null,
      created_at: T0, updated_at: T0,
    };
    assert.equal(evaluateGrantAccess(grant, T0 - 1).valid, false);
    assert.equal(evaluateGrantAccess(grant, T0).accessStatus, 'active');
    assert.equal(evaluateGrantAccess(grant, T0 + 1000).accessStatus, 'grace');
    assert.equal(evaluateGrantAccess(grant, T0 + 1000 + PAID_GRACE_MS).valid, false);
  });
});

describe('Phase 1 — no HTTP admin fragile', () => {
  it('pas de route /internal/admin/premium dans server', () => {
    const src = fs.readFileSync(new URL('../src/internalHttp/server.js', import.meta.url), 'utf8');
    assert.ok(!src.includes('/admin/premium'));
  });
});
