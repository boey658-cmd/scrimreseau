/**
 * Phase 7A — Billing Core : catalog, events, sync paid, grace, gifts, reconciliation, crash, security.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import {
  listAppliedSchemaMigrations,
  runSchemaMigrations,
  SCHEMA_MIGRATIONS,
} from '../src/database/schemaMigrations.js';
import {
  bindEntitlementStore,
  clearEntitlementCache,
  getPlan,
  getLimit,
  canUseFeature,
  grantPremiumGift,
  resolveEffectiveEntitlement,
  PAID_GRACE_MS,
} from '../src/services/entitlements/index.js';
import {
  BILLING_CATALOG,
  BILLING_PRODUCT_KEYS,
  BILLING_GRACE_MS,
  listBillingCatalogPublic,
  processNormalizedBillingEvent,
  validateNormalizedBillingEvent,
  getGuildBillingPublicView,
  mockEmitAndProcess,
  clearMockBillingProviderState,
  isMockBillingAllowed,
  assertMockBillingAllowed,
  reconcileSubscription,
  runBillingReconciliationPass,
  mockRetrieveSubscription,
  paidExternalRefForSubscription,
  syncPaidEntitlementFromSubscription,
} from '../src/services/billing/index.js';
import {
  closeInternalHttpServer,
  createInternalHttpServer,
  listenInternalHttpServer,
} from '../src/internalHttp/server.js';

const GUILD = '1484520688726311012';
const GUILD_B = '1436848619796828322';
const ADMIN = '1009269632693174422';
const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const MONTH = 30 * DAY;

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-p7a-bill-'));
  const prev = process.env.SQLITE_PATH;
  const prevOwner = process.env.SCRIMRESEAU_OWNER_ID;
  const prevNode = process.env.NODE_ENV;
  const prevLive = process.env.BILLING_LIVE_PROVIDER;
  const prevAllowMock = process.env.ALLOW_BILLING_MOCK;
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  process.env.SCRIMRESEAU_OWNER_ID = ADMIN;
  process.env.NODE_ENV = 'test';
  process.env.ALLOW_BILLING_MOCK = '1';
  delete process.env.BILLING_LIVE_PROVIDER;
  try {
    closeDb();
    clearEntitlementCache();
    clearMockBillingProviderState();
    const db = getDb();
    const stmts = prepareStatements(db);
    bindEntitlementStore(stmts);
    await fn(db, stmts);
  } finally {
    clearEntitlementCache();
    clearMockBillingProviderState();
    bindEntitlementStore(null);
    closeDb();
    if (prev === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prev;
    if (prevOwner === undefined) delete process.env.SCRIMRESEAU_OWNER_ID;
    else process.env.SCRIMRESEAU_OWNER_ID = prevOwner;
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
    if (prevLive === undefined) delete process.env.BILLING_LIVE_PROVIDER;
    else process.env.BILLING_LIVE_PROVIDER = prevLive;
    if (prevAllowMock === undefined) delete process.env.ALLOW_BILLING_MOCK;
    else process.env.ALLOW_BILLING_MOCK = prevAllowMock;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Snapshot / restore env for isolated isMockBillingAllowed matrix tests.
 * @param {Record<string, string | undefined>} overrides
 * @param {() => void} fn
 */
function withMockEnv(overrides, fn) {
  const keys = ['NODE_ENV', 'ALLOW_BILLING_MOCK', 'BILLING_LIVE_PROVIDER'];
  /** @type {Record<string, string | undefined>} */
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  try {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(overrides, k)) {
        const v = overrides[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

function emit(db, stmts, overrides) {
  return mockEmitAndProcess({
    db,
    stmts,
    eventType: 'subscription.created',
    guildId: GUILD,
    providerSubscriptionId: 'sub_1',
    planKey: 'P1',
    interval: 'month',
    currentPeriodStart: T0,
    currentPeriodEnd: T0 + MONTH,
    providerEventId: `evt_${Math.random().toString(36).slice(2)}`,
    providerEventAt: T0,
    nowMs: T0,
    ...overrides,
  });
}

/** @param {any} stmts */
function optsAt(stmts, nowMs) {
  return { nowMs, stmts, bypassCache: true };
}

describe('Phase 7A — billing catalog', () => {
  it('6 produits EUR centimes exacts', () => {
    assert.deepEqual(
      listBillingCatalogPublic().map((p) => [p.productKey, p.amountMinor]),
      [
        ['P1_MONTHLY', 499],
        ['P1_YEARLY', 4999],
        ['P2_MONTHLY', 999],
        ['P2_YEARLY', 9999],
        ['P3_MONTHLY', 1499],
        ['P3_YEARLY', 14999],
      ],
    );
    assert.equal(BILLING_PRODUCT_KEYS.length, 6);
    assert.equal(BILLING_CATALOG.P2_MONTHLY.currency, 'EUR');
    assert.equal(BILLING_GRACE_MS, PAID_GRACE_MS);
    assert.equal(BILLING_GRACE_MS, 7 * DAY);
  });
});

describe('Phase 7A — migrations', () => {
  it('DB neuve applique billing_core', async () => {
    await withTempDb(async (db) => {
      const applied = listAppliedSchemaMigrations(db);
      assert.ok(applied.includes('20260923_06_billing_core'));
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
        .map((r) => r.name);
      assert.ok(tables.includes('billing_subscriptions'));
      assert.ok(tables.includes('billing_events'));
      assert.ok(tables.includes('billing_customers'));
      assert.ok(tables.includes('billing_audit'));
    });
  });

  it('replay idempotent', async () => {
    await withTempDb(async (db) => {
      runSchemaMigrations(db);
      runSchemaMigrations(db);
      assert.equal(
        listAppliedSchemaMigrations(db).filter((id) => id === '20260923_06_billing_core').length,
        1,
      );
    });
  });

  it('migration id présent dans SCHEMA_MIGRATIONS', () => {
    assert.ok(SCHEMA_MIGRATIONS.some((m) => m.id === '20260923_06_billing_core'));
  });
});

describe('Phase 7A — create / renew / sync paid', () => {
  it('subscription.created → grant paid unique + P1', async () => {
    await withTempDb(async (db, stmts) => {
      const r = emit(db, stmts, { providerEventId: 'e1' });
      assert.equal(r.ok, true);
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + 1000)), 'P1');
      const grants = stmts.listEntitlementGrantsByGuild.all(GUILD);
      assert.equal(grants.filter((g) => g.source === 'paid').length, 1);
      assert.equal(grants[0].external_ref, paidExternalRefForSubscription('mock', 'sub_1'));
    });
  });

  it('renewal prolonge ends_at sans nouveau grant', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { providerEventId: 'e1', providerEventAt: T0 });
      const r2 = emit(db, stmts, {
        eventType: 'subscription.renewed',
        providerEventId: 'e2',
        providerEventAt: T0 + MONTH,
        currentPeriodStart: T0 + MONTH,
        currentPeriodEnd: T0 + 2 * MONTH,
        nowMs: T0 + MONTH,
      });
      assert.equal(r2.ok, true);
      const paid = stmts.listEntitlementGrantsByGuild.all(GUILD).filter((g) => g.source === 'paid');
      assert.equal(paid.length, 1);
      assert.equal(paid[0].ends_at, T0 + 2 * MONTH);
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + MONTH + 1000)), 'P1');
    });
  });

  it('idempotence : même event 20×', async () => {
    await withTempDb(async (db, stmts) => {
      for (let i = 0; i < 20; i += 1) {
        const r = emit(db, stmts, {
          providerEventId: 'same_evt',
          providerEventAt: T0,
        });
        assert.equal(r.ok, true);
        if (i > 0) assert.equal(r.duplicate, true);
      }
      assert.equal(stmts.listEntitlementGrantsByGuild.all(GUILD).filter((g) => g.source === 'paid').length, 1);
      assert.equal(stmts.listBillingSubscriptionsByGuild.all(GUILD).length, 1);
    });
  });
});

describe('Phase 7A — upgrade / downgrade', () => {
  it('upgrade P1→P2 immédiat', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { providerEventId: 'e1' });
      const r = emit(db, stmts, {
        eventType: 'subscription.upgraded',
        planKey: 'P2',
        providerEventId: 'e2',
        providerEventAt: T0 + 1000,
        nowMs: T0 + 1000,
      });
      assert.equal(r.ok, true);
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + 2000)), 'P2');
      assert.equal(getLimit(GUILD, 'reception_channels', optsAt(stmts, T0 + 2000)), 4);
    });
  });

  it('downgrade scheduled conserve P3 jusqu’à effective_at', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { planKey: 'P3', providerEventId: 'e1' });
      emit(db, stmts, {
        eventType: 'subscription.downgrade_scheduled',
        planKey: 'P1',
        pendingPlanKey: 'P1',
        pendingPlanEffectiveAt: T0 + MONTH,
        providerEventId: 'e2',
        providerEventAt: T0 + 1000,
        nowMs: T0 + 1000,
      });
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + 2000)), 'P3');
      // À effective_at via renew qui applique pending
      emit(db, stmts, {
        eventType: 'subscription.renewed',
        planKey: 'P1',
        providerEventId: 'e3',
        providerEventAt: T0 + MONTH,
        currentPeriodStart: T0 + MONTH,
        currentPeriodEnd: T0 + 2 * MONTH,
        nowMs: T0 + MONTH,
      });
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + MONTH + 1)), 'P1');
    });
  });

  it('downgrade immédiat', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { planKey: 'P3', providerEventId: 'e1' });
      emit(db, stmts, {
        eventType: 'subscription.downgraded',
        planKey: 'P1',
        providerEventId: 'e2',
        providerEventAt: T0 + 1000,
        nowMs: T0 + 1000,
      });
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + 2000)), 'P1');
    });
  });
});

describe('Phase 7A — payment failed / grace / recovery', () => {
  it('payment failed → grace 7j puis FREE', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { planKey: 'P2', providerEventId: 'e1' });
      const periodEnd = T0 + MONTH;
      emit(db, stmts, {
        eventType: 'payment.failed',
        planKey: 'P2',
        providerEventId: 'e2',
        providerEventAt: periodEnd,
        currentPeriodEnd: periodEnd,
        nowMs: periodEnd,
      });
      assert.equal(getPlan(GUILD, optsAt(stmts, periodEnd + 1000)), 'P2');
      const snap = resolveEffectiveEntitlement(stmts, GUILD, periodEnd + 1000);
      assert.equal(snap.status, 'grace');
      assert.equal(getPlan(GUILD, optsAt(stmts, periodEnd + BILLING_GRACE_MS)), 'FREE');
    });
  });

  it('recovery J+3 → active sans nouveau grant', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { planKey: 'P2', providerEventId: 'e1' });
      const periodEnd = T0 + MONTH;
      emit(db, stmts, {
        eventType: 'payment.failed',
        planKey: 'P2',
        providerEventId: 'e2',
        providerEventAt: periodEnd,
        currentPeriodEnd: periodEnd,
        nowMs: periodEnd,
      });
      emit(db, stmts, {
        eventType: 'payment.recovered',
        planKey: 'P2',
        providerEventId: 'e3',
        providerEventAt: periodEnd + 3 * DAY,
        currentPeriodStart: periodEnd,
        currentPeriodEnd: periodEnd + MONTH,
        nowMs: periodEnd + 3 * DAY,
      });
      assert.equal(getPlan(GUILD, optsAt(stmts, periodEnd + 3 * DAY + 1)), 'P2');
      assert.equal(stmts.listEntitlementGrantsByGuild.all(GUILD).filter((g) => g.source === 'paid').length, 1);
      const snap = resolveEffectiveEntitlement(stmts, GUILD, periodEnd + 3 * DAY + 1);
      assert.equal(snap.status, 'active');
    });
  });
});

describe('Phase 7A — cancellation', () => {
  it('cancel_at_period_end garde Premium jusqu’à period_end', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { providerEventId: 'e1' });
      emit(db, stmts, {
        eventType: 'subscription.canceled',
        cancelAtPeriodEnd: true,
        providerEventId: 'e2',
        providerEventAt: T0 + 1000,
        nowMs: T0 + 1000,
      });
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + MONTH - 1)), 'P1');
      const view = getGuildBillingPublicView(stmts, GUILD);
      assert.equal(view.cancel_at_period_end, true);
      assert.equal(view.billing_status, 'active');
      emit(db, stmts, {
        eventType: 'subscription.expired',
        providerEventId: 'e3',
        providerEventAt: T0 + MONTH,
        currentPeriodEnd: T0 + MONTH,
        nowMs: T0 + MONTH,
        status: 'expired',
      });
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + MONTH + 1)), 'FREE');
    });
  });
});

describe('Phase 7A — gifts × paid', () => {
  const cases = [
    { name: 'Paid P1 + Gift P2 → P2', paid: 'P1', gift: 'P2', expect: 'P2' },
    { name: 'Paid P3 + Gift P1 → P3', paid: 'P3', gift: 'P1', expect: 'P3' },
    { name: 'Paid P2 + Gift P1 → P2', paid: 'P2', gift: 'P1', expect: 'P2' },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      await withTempDb(async (db, stmts) => {
        emit(db, stmts, { planKey: c.paid, providerEventId: 'ep' });
        grantPremiumGift({
          db,
          stmts,
          guildId: GUILD,
          planKey: c.gift,
          startsAt: T0,
          endsAt: T0 + MONTH,
          grantedBy: ADMIN,
          reason: 'test gift',
          skipAdminCheck: true,
          nowMs: T0,
        });
        assert.equal(getPlan(GUILD, optsAt(stmts, T0 + 1000)), c.expect);
      });
    });
  }

  it('Gift expire → paid reste', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { planKey: 'P1', providerEventId: 'ep' });
      grantPremiumGift({
        db,
        stmts,
        guildId: GUILD,
        planKey: 'P2',
        startsAt: T0,
        endsAt: T0 + DAY,
        grantedBy: ADMIN,
        reason: 'short gift',
        skipAdminCheck: true,
        nowMs: T0,
      });
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + 1000)), 'P2');
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + DAY + 1)), 'P1');
    });
  });

  it('Paid expire + Gift P3 → P3', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { planKey: 'P1', providerEventId: 'ep', currentPeriodEnd: T0 + DAY });
      grantPremiumGift({
        db,
        stmts,
        guildId: GUILD,
        planKey: 'P3',
        startsAt: T0,
        endsAt: T0 + MONTH,
        grantedBy: ADMIN,
        reason: 'gift',
        skipAdminCheck: true,
        nowMs: T0,
      });
      emit(db, stmts, {
        eventType: 'subscription.expired',
        planKey: 'P1',
        providerEventId: 'ex',
        providerEventAt: T0 + DAY,
        currentPeriodEnd: T0 + DAY,
        nowMs: T0 + DAY,
        status: 'expired',
      });
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + DAY + 1)), 'P3');
    });
  });

  it('Paid grace P1 + Gift P2 → P2 ; gift expire → P1 grace', async () => {
    await withTempDb(async (db, stmts) => {
      const periodEnd = T0 + MONTH;
      emit(db, stmts, { planKey: 'P1', providerEventId: 'ep' });
      emit(db, stmts, {
        eventType: 'payment.failed',
        planKey: 'P1',
        providerEventId: 'ef',
        providerEventAt: periodEnd,
        currentPeriodEnd: periodEnd,
        nowMs: periodEnd,
      });
      grantPremiumGift({
        db,
        stmts,
        guildId: GUILD,
        planKey: 'P2',
        startsAt: periodEnd,
        endsAt: periodEnd + 2 * DAY,
        grantedBy: ADMIN,
        reason: 'gift during grace',
        skipAdminCheck: true,
        nowMs: periodEnd,
      });
      assert.equal(getPlan(GUILD, optsAt(stmts, periodEnd + 1000)), 'P2');
      assert.equal(getPlan(GUILD, optsAt(stmts, periodEnd + 2 * DAY + 1)), 'P1');
      const snap = resolveEffectiveEntitlement(stmts, GUILD, periodEnd + 2 * DAY + 1);
      assert.equal(snap.status, 'grace');
    });
  });
});

describe('Phase 7A — out-of-order events', () => {
  const matrix = [
    {
      name: 'renew puis late payment_failed n’écrase pas',
      steps: (db, stmts) => {
        emit(db, stmts, { providerEventId: 'e1', providerEventAt: T0 });
        emit(db, stmts, {
          eventType: 'subscription.renewed',
          providerEventId: 'e2',
          providerEventAt: T0 + MONTH,
          currentPeriodStart: T0 + MONTH,
          currentPeriodEnd: T0 + 2 * MONTH,
          nowMs: T0 + MONTH,
        });
        const late = emit(db, stmts, {
          eventType: 'payment.failed',
          providerEventId: 'e_late',
          providerEventAt: T0 + MONTH - 1000,
          currentPeriodEnd: T0 + MONTH,
          nowMs: T0 + MONTH + 1000,
        });
        assert.equal(late.processingStatus, 'ignored_stale');
        assert.equal(getPlan(GUILD, optsAt(stmts, T0 + MONTH + 2000)), 'P1');
        const sub = stmts.getLiveBillingSubscriptionByGuild.get(GUILD);
        assert.equal(sub.status, 'active');
        assert.equal(sub.current_period_end, T0 + 2 * MONTH);
      },
    },
    {
      name: 'duplicate renew',
      steps: (db, stmts) => {
        emit(db, stmts, { providerEventId: 'e1' });
        emit(db, stmts, {
          eventType: 'subscription.renewed',
          providerEventId: 'e2',
          providerEventAt: T0 + MONTH,
          currentPeriodStart: T0 + MONTH,
          currentPeriodEnd: T0 + 2 * MONTH,
          nowMs: T0 + MONTH,
        });
        const dup = emit(db, stmts, {
          eventType: 'subscription.renewed',
          providerEventId: 'e2',
          providerEventAt: T0 + MONTH,
          currentPeriodStart: T0 + MONTH,
          currentPeriodEnd: T0 + 2 * MONTH,
          nowMs: T0 + MONTH,
        });
        assert.equal(dup.duplicate, true);
      },
    },
    {
      name: 'upgrade puis old failure ignoré',
      steps: (db, stmts) => {
        emit(db, stmts, { planKey: 'P1', providerEventId: 'e1', providerEventAt: T0 });
        emit(db, stmts, {
          eventType: 'subscription.upgraded',
          planKey: 'P3',
          providerEventId: 'e2',
          providerEventAt: T0 + 5000,
          nowMs: T0 + 5000,
        });
        const late = emit(db, stmts, {
          eventType: 'payment.failed',
          planKey: 'P1',
          providerEventId: 'e_old',
          providerEventAt: T0 + 1000,
          nowMs: T0 + 6000,
        });
        assert.equal(late.processingStatus, 'ignored_stale');
        assert.equal(getPlan(GUILD, optsAt(stmts, T0 + 7000)), 'P3');
      },
    },
    {
      name: 'expired puis late active → stale',
      steps: (db, stmts) => {
        emit(db, stmts, { providerEventId: 'e1', providerEventAt: T0 });
        emit(db, stmts, {
          eventType: 'subscription.expired',
          providerEventId: 'e2',
          providerEventAt: T0 + MONTH,
          nowMs: T0 + MONTH,
          status: 'expired',
        });
        const late = emit(db, stmts, {
          eventType: 'subscription.renewed',
          providerEventId: 'e_old_active',
          providerEventAt: T0 + 100,
          currentPeriodEnd: T0 + MONTH,
          nowMs: T0 + MONTH + 1000,
        });
        assert.equal(late.processingStatus, 'ignored_stale');
        assert.equal(getPlan(GUILD, optsAt(stmts, T0 + MONTH + 2000)), 'FREE');
      },
    },
  ];

  for (const row of matrix) {
    it(row.name, async () => {
      await withTempDb(async (db, stmts) => {
        row.steps(db, stmts);
      });
    });
  }
});

describe('Phase 7A — reconciliation', () => {
  it('répare DB P1 / provider P2 / entitlement P1 → P2', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { planKey: 'P1', providerEventId: 'e1', providerEventAt: T0 });
      const out = reconcileSubscription({
        db,
        stmts,
        provider: 'mock',
        providerSubscriptionId: 'sub_1',
        nowMs: T0 + 1000,
        providerState: {
          guildId: GUILD,
          planKey: 'P2',
          interval: 'month',
          status: 'active',
          currentPeriodStart: T0,
          currentPeriodEnd: T0 + MONTH,
          providerEventAt: T0 + 2000,
        },
      });
      assert.equal(out.repaired, true);
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + 3000)), 'P2');
    });
  });

  it('provider expired → FREE', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { planKey: 'P2', providerEventId: 'e1', providerEventAt: T0 });
      reconcileSubscription({
        db,
        stmts,
        provider: 'mock',
        providerSubscriptionId: 'sub_1',
        nowMs: T0 + MONTH,
        providerState: {
          guildId: GUILD,
          planKey: 'P2',
          interval: 'month',
          status: 'expired',
          currentPeriodStart: T0,
          currentPeriodEnd: T0 + MONTH,
          providerEventAt: T0 + MONTH,
        },
      });
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + MONTH + 1)), 'FREE');
    });
  });

  it('pass batch avec mock retrieve', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { planKey: 'P1', providerEventId: 'e1', providerEventAt: T0 });
      // Divergence volontaire côté mock store
      const remote = mockRetrieveSubscription('sub_1');
      remote.planKey = 'P3';
      remote.providerEventAt = T0 + 5000;
      const pass = runBillingReconciliationPass({
        db,
        stmts,
        nowMs: T0 + 6000,
        retrieve: (provider, id) => (provider === 'mock' ? mockRetrieveSubscription(id) : null),
      });
      assert.equal(pass.checked, 1);
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + 7000)), 'P3');
    });
  });
});

describe('Phase 7A — crash recovery', () => {
  for (const point of ['claim', 'subscription', 'entitlement', 'before_processed']) {
    it(`crash after ${point} puis retry OK`, async () => {
      await withTempDb(async (db, stmts) => {
        const fail = emit(db, stmts, {
          providerEventId: `crash_${point}`,
          crashAfter: /** @type {any} */ (point),
        });
        assert.equal(fail.ok, false);
        assert.equal(fail.retryable, true);
        const retry = emit(db, stmts, {
          providerEventId: `crash_${point}`,
        });
        assert.equal(retry.ok, true);
        assert.equal(getPlan(GUILD, optsAt(stmts, T0 + 1000)), 'P1');
      });
    });
  }
});

describe('Phase 7A — concurrency / duplicate race', () => {
  it('events simultanés même id → un seul grant', async () => {
    await withTempDb(async (db, stmts) => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => Promise.resolve(emit(db, stmts, {
          providerEventId: 'race_evt',
          providerEventAt: T0,
        }))),
      );
      assert.ok(results.every((r) => r.ok));
      assert.equal(stmts.listEntitlementGrantsByGuild.all(GUILD).filter((g) => g.source === 'paid').length, 1);
    });
  });

  it('deux subscriptions live même guild → refus', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { providerEventId: 'e1', providerSubscriptionId: 'sub_a' });
      const r = emit(db, stmts, {
        providerEventId: 'e2',
        providerSubscriptionId: 'sub_b',
        providerEventAt: T0 + 1,
      });
      assert.equal(r.ok, false);
      assert.equal(r.errorCode, 'DUPLICATE_LIVE_SUBSCRIPTION');
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + 1000)), 'P1');
    });
  });
});

describe('Phase 7A — security / fuzz', () => {
  it('mock deny-by-default matrix (ALLOW_BILLING_MOCK opt-in)', () => {
    withMockEnv({ NODE_ENV: undefined, ALLOW_BILLING_MOCK: undefined, BILLING_LIVE_PROVIDER: undefined }, () => {
      assert.equal(isMockBillingAllowed(), false);
    });
    withMockEnv({ NODE_ENV: 'development', ALLOW_BILLING_MOCK: undefined, BILLING_LIVE_PROVIDER: undefined }, () => {
      assert.equal(isMockBillingAllowed(), false);
    });
    withMockEnv({ NODE_ENV: 'development', ALLOW_BILLING_MOCK: '0', BILLING_LIVE_PROVIDER: undefined }, () => {
      assert.equal(isMockBillingAllowed(), false);
    });
    withMockEnv({ NODE_ENV: 'development', ALLOW_BILLING_MOCK: '1', BILLING_LIVE_PROVIDER: undefined }, () => {
      assert.equal(isMockBillingAllowed(), true);
    });
    withMockEnv({ NODE_ENV: 'test', ALLOW_BILLING_MOCK: '1', BILLING_LIVE_PROVIDER: undefined }, () => {
      assert.equal(isMockBillingAllowed(), true);
    });
    withMockEnv({ NODE_ENV: 'production', ALLOW_BILLING_MOCK: '1', BILLING_LIVE_PROVIDER: undefined }, () => {
      assert.equal(isMockBillingAllowed(), false);
      assert.throws(() => assertMockBillingAllowed());
    });
    withMockEnv({ NODE_ENV: 'prod', ALLOW_BILLING_MOCK: undefined, BILLING_LIVE_PROVIDER: undefined }, () => {
      assert.equal(isMockBillingAllowed(), false);
    });
    withMockEnv({ NODE_ENV: 'Production', ALLOW_BILLING_MOCK: undefined, BILLING_LIVE_PROVIDER: undefined }, () => {
      assert.equal(isMockBillingAllowed(), false);
    });
    withMockEnv({ NODE_ENV: 'development', ALLOW_BILLING_MOCK: '1', BILLING_LIVE_PROVIDER: 'paddle' }, () => {
      assert.equal(isMockBillingAllowed(), false);
    });
    withMockEnv({ NODE_ENV: 'development', ALLOW_BILLING_MOCK: ' true ', BILLING_LIVE_PROVIDER: undefined }, () => {
      assert.equal(isMockBillingAllowed(), false);
    });
    withMockEnv({ NODE_ENV: 'development', ALLOW_BILLING_MOCK: ' 1 ', BILLING_LIVE_PROVIDER: undefined }, () => {
      assert.equal(isMockBillingAllowed(), true);
    });
  });

  it('mass-assignment amount/plan invalide refusé', async () => {
    await withTempDb(async (db, stmts) => {
      const bad = processNormalizedBillingEvent({
        db,
        stmts,
        nowMs: T0,
        event: {
          provider: 'mock',
          providerEventId: 'bad1',
          eventType: 'subscription.created',
          providerEventAt: T0,
          guildId: GUILD,
          providerSubscriptionId: 'sub_x',
          planKey: 'P3',
          interval: 'month',
          currentPeriodStart: T0,
          currentPeriodEnd: T0 + MONTH,
          amountMinor: 0,
          currency: 'EUR',
        },
      });
      assert.equal(bad.ok, false);
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + 1)), 'FREE');
    });
  });

  it('plan P999 / FREE / interval week / currency USD', async () => {
    await withTempDb(async (db, stmts) => {
      for (const event of [
        { planKey: 'P999', interval: 'month' },
        { planKey: 'FREE', interval: 'month' },
        { planKey: 'P1', interval: 'week' },
        { planKey: 'P1', interval: 'month', currency: 'USD', amountMinor: 499 },
      ]) {
        const r = processNormalizedBillingEvent({
          db,
          stmts,
          nowMs: T0,
          event: {
            provider: 'mock',
            providerEventId: `fuzz_${JSON.stringify(event)}`,
            eventType: 'subscription.created',
            providerEventAt: T0,
            guildId: GUILD,
            providerSubscriptionId: 'sub_fuzz',
            currentPeriodStart: T0,
            currentPeriodEnd: T0 + MONTH,
            ...event,
          },
        });
        assert.equal(r.ok, false);
      }
    });
  });

  it('provider_event_id vide / énorme', () => {
    assert.throws(() => validateNormalizedBillingEvent({
      provider: 'mock',
      providerEventId: '',
      eventType: 'subscription.created',
      providerEventAt: T0,
      guildId: GUILD,
      providerSubscriptionId: 'sub',
      planKey: 'P1',
      interval: 'month',
      currentPeriodStart: T0,
      currentPeriodEnd: T0 + MONTH,
    }));
    assert.throws(() => validateNormalizedBillingEvent({
      provider: 'mock',
      providerEventId: 'x'.repeat(300),
      eventType: 'subscription.created',
      providerEventAt: T0,
      guildId: GUILD,
      providerSubscriptionId: 'sub',
      planKey: 'P1',
      interval: 'month',
      currentPeriodStart: T0,
      currentPeriodEnd: T0 + MONTH,
    }));
  });

  it('vue publique n’expose pas d’IDs provider', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { providerEventId: 'e1' });
      const view = getGuildBillingPublicView(stmts, GUILD);
      const json = JSON.stringify(view);
      assert.ok(!json.includes('sub_1'));
      assert.ok(!json.includes('provider'));
      assert.equal(view.plan, 'P1');
    });
  });

  it('PATCH-like body ne crée pas Premium via sync direct hors billing', async () => {
    await withTempDb(async (_db, stmts) => {
      // Simule tentative frontend : pas d’appel process → FREE
      assert.equal(getPlan(GUILD, optsAt(stmts, T0)), 'FREE');
      assert.equal(stmts.listBillingSubscriptionsByGuild.all(GUILD).length, 0);
    });
  });
});

describe('Phase 7A — feature integrations', () => {
  it('P2 multi-salons grace puis FREE', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { planKey: 'P2', providerEventId: 'e1' });
      assert.equal(getLimit(GUILD, 'reception_channels', optsAt(stmts, T0 + 1)), 4);
      const periodEnd = T0 + MONTH;
      emit(db, stmts, {
        eventType: 'payment.failed',
        planKey: 'P2',
        providerEventId: 'e2',
        providerEventAt: periodEnd,
        currentPeriodEnd: periodEnd,
        nowMs: periodEnd,
      });
      assert.equal(getLimit(GUILD, 'reception_channels', optsAt(stmts, periodEnd + 1000)), 4);
      assert.equal(getLimit(GUILD, 'reception_channels', optsAt(stmts, periodEnd + BILLING_GRACE_MS)), 1);
    });
  });

  it('P2 embed custom grace puis locked', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { planKey: 'P2', providerEventId: 'e1' });
      assert.equal(canUseFeature(GUILD, 'local_embed_customization', optsAt(stmts, T0 + 1)), true);
      const periodEnd = T0 + MONTH;
      emit(db, stmts, {
        eventType: 'payment.failed',
        planKey: 'P2',
        providerEventId: 'e2',
        providerEventAt: periodEnd,
        currentPeriodEnd: periodEnd,
        nowMs: periodEnd,
      });
      assert.equal(canUseFeature(GUILD, 'local_embed_customization', optsAt(stmts, periodEnd + 1)), true);
      assert.equal(canUseFeature(GUILD, 'local_embed_customization', optsAt(stmts, periodEnd + BILLING_GRACE_MS)), false);
    });
  });

  it('badge directory grace puis FREE', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { planKey: 'P1', providerEventId: 'e1' });
      assert.equal(canUseFeature(GUILD, 'premium_badge', optsAt(stmts, T0 + 1)), true);
      const periodEnd = T0 + MONTH;
      emit(db, stmts, {
        eventType: 'payment.failed',
        planKey: 'P1',
        providerEventId: 'e2',
        providerEventAt: periodEnd,
        currentPeriodEnd: periodEnd,
        nowMs: periodEnd,
      });
      assert.equal(canUseFeature(GUILD, 'premium_badge', optsAt(stmts, periodEnd + 1)), true);
      assert.equal(canUseFeature(GUILD, 'premium_badge', optsAt(stmts, periodEnd + BILLING_GRACE_MS)), false);
    });
  });

  it('hot path : pas d’appel provider (entitlement local)', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { planKey: 'P2', providerEventId: 'e1' });
      clearMockBillingProviderState();
      // Après clear du miroir mock, getPlan doit toujours marcher
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + 1)), 'P2');
      assert.equal(mockRetrieveSubscription('sub_1'), null);
    });
  });
});

describe('Phase 7A — refund / dispute préparés sans coupure', () => {
  it('refund.partial → no-op Premium reste', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { planKey: 'P2', providerEventId: 'e1' });
      const r = emit(db, stmts, {
        eventType: 'refund.partial',
        planKey: 'P2',
        providerEventId: 'ref1',
        providerEventAt: T0 + 1000,
        nowMs: T0 + 1000,
      });
      assert.equal(r.ok, true);
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + 2000)), 'P2');
    });
  });

  it('refund.full_approved → coupe paid', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { planKey: 'P2', providerEventId: 'e1' });
      const r = emit(db, stmts, {
        eventType: 'refund.full_approved',
        planKey: 'P2',
        providerEventId: 'ref2',
        providerEventAt: T0 + 1000,
        nowMs: T0 + 1000,
        status: 'expired',
      });
      assert.equal(r.ok, true);
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + 2000)), 'FREE');
    });
  });
});

describe('Phase 7A — syncPaidEntitlement porte unique', () => {
  it('sync depuis subscription row', async () => {
    await withTempDb(async (db, stmts) => {
      emit(db, stmts, { planKey: 'P1', providerEventId: 'e1' });
      const sub = stmts.getLiveBillingSubscriptionByGuild.get(GUILD);
      sub.plan_key = 'P3';
      syncPaidEntitlementFromSubscription({
        db,
        stmts,
        subscription: sub,
        nowMs: T0 + 1000,
      });
      assert.equal(getPlan(GUILD, optsAt(stmts, T0 + 2000)), 'P3');
    });
  });
});

describe('Phase 7A — HTTP POST /internal/dev/billing/mock guards', () => {
  const TOKEN = 'test-billing-mock-token';
  const MONTH_MS = MONTH;

  /**
   * @param {{
   *   allowMock?: string | undefined,
   *   nodeEnv?: string,
   *   liveProvider?: string | undefined,
   * }} env
   * @param {(ctx: { port: number, post: Function }) => Promise<void>} fn
   */
  async function withMockHttp(env, fn) {
    await withTempDb(async (db, stmts) => {
      const prevAllow = process.env.ALLOW_BILLING_MOCK;
      const prevNode = process.env.NODE_ENV;
      const prevLive = process.env.BILLING_LIVE_PROVIDER;
      if (Object.prototype.hasOwnProperty.call(env, 'allowMock')) {
        if (env.allowMock === undefined) delete process.env.ALLOW_BILLING_MOCK;
        else process.env.ALLOW_BILLING_MOCK = env.allowMock;
      }
      if (env.nodeEnv !== undefined) process.env.NODE_ENV = env.nodeEnv;
      if (Object.prototype.hasOwnProperty.call(env, 'liveProvider')) {
        if (env.liveProvider === undefined) delete process.env.BILLING_LIVE_PROVIDER;
        else process.env.BILLING_LIVE_PROVIDER = env.liveProvider;
      }
      const { server, listener, host } = createInternalHttpServer({
        db,
        client: null,
        stmts,
        config: { enabled: true, port: 0, token: TOKEN },
        port: 0,
      });
      const bound = await listenInternalHttpServer(server, host, 0);
      /**
       * @param {{ token?: string | null, body?: object }} opts
       */
      function post(opts = {}) {
        const body = opts.body ?? {
          actor_discord_user_id: ADMIN,
          event_type: 'subscription.created',
          guild_id: GUILD,
          provider_subscription_id: 'sub_http_1',
          plan_key: 'P1',
          interval: 'month',
          current_period_start: T0,
          current_period_end: T0 + MONTH_MS,
          provider_event_id: `evt_http_${Math.random().toString(36).slice(2)}`,
          provider_event_at: T0,
          now_ms: T0,
        };
        const payload = Buffer.from(JSON.stringify(body), 'utf8');
        const headers = {
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
        };
        if (opts.token !== null) {
          headers.Authorization = `Bearer ${opts.token ?? TOKEN}`;
        }
        return new Promise((resolve, reject) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: bound.port,
              path: '/internal/dev/billing/mock',
              method: 'POST',
              headers,
            },
            (res) => {
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let parsed = null;
                try {
                  parsed = JSON.parse(raw);
                } catch {
                  parsed = raw;
                }
                resolve({ status: res.statusCode, body: parsed });
              });
            },
          );
          req.on('error', reject);
          req.write(payload);
          req.end();
        });
      }
      try {
        await fn({ port: bound.port, post });
      } finally {
        if (listener?.stopAccepting) listener.stopAccepting();
        await closeInternalHttpServer(server);
        if (prevAllow === undefined) delete process.env.ALLOW_BILLING_MOCK;
        else process.env.ALLOW_BILLING_MOCK = prevAllow;
        if (prevNode === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prevNode;
        if (prevLive === undefined) delete process.env.BILLING_LIVE_PROVIDER;
        else process.env.BILLING_LIVE_PROVIDER = prevLive;
      }
    });
  }

  it('ALLOW absent → 403 même en NODE_ENV=test', async () => {
    await withMockHttp({ allowMock: undefined, nodeEnv: 'test' }, async ({ post }) => {
      const res = await post();
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'FORBIDDEN');
    });
  });

  it('ALLOW=1 + test → 200 pour owner', async () => {
    await withMockHttp({ allowMock: '1', nodeEnv: 'test' }, async ({ post }) => {
      const res = await post();
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });
  });

  it('bearer invalide → 401', async () => {
    await withMockHttp({ allowMock: '1', nodeEnv: 'test' }, async ({ post }) => {
      const res = await post({ token: 'wrong-token' });
      assert.equal(res.status, 401);
    });
  });

  it('actor non owner/dev → 403', async () => {
    await withMockHttp({ allowMock: '1', nodeEnv: 'test' }, async ({ post }) => {
      const res = await post({
        body: {
          actor_discord_user_id: '999999999999999999',
          event_type: 'subscription.created',
          guild_id: GUILD,
          provider_subscription_id: 'sub_http_x',
          plan_key: 'P1',
          interval: 'month',
          current_period_start: T0,
          current_period_end: T0 + MONTH_MS,
          provider_event_id: 'evt_http_non_admin',
          provider_event_at: T0,
          now_ms: T0,
        },
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'FORBIDDEN');
    });
  });
});
