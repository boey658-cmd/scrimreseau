/**
 * Phase 7B — Paddle Sandbox adapter (sans secrets réels).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { listAppliedSchemaMigrations } from '../src/database/schemaMigrations.js';
import {
  bindEntitlementStore,
  clearEntitlementCache,
  getPlan,
} from '../src/services/entitlements/index.js';
import {
  assertPaddleSandboxOnly,
  parsePaddleSandboxConfig,
  createPaddleBillingProvider,
  processNormalizedBillingEvent,
  createOrReuseCheckoutIntent,
  hashBinding,
  generateCheckoutIntentId,
  CHECKOUT_INTENT_TTL_MS,
} from '../src/services/billing/index.js';
import { ConfigWriteError } from '../src/services/configWriteError.js';

const GUILD = '1484520688726311012';
const ADMIN = '1009269632693174422';
const T0 = 1_700_000_000_000;
const MONTH = 30 * 24 * 60 * 60 * 1000;

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-p7b-'));
  const prev = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  process.env.NODE_ENV = 'test';
  process.env.PADDLE_ENVIRONMENT = 'sandbox';
  delete process.env.PADDLE_API_KEY;
  delete process.env.PADDLE_WEBHOOK_SECRET;
  delete process.env.PADDLE_CLIENT_TOKEN;
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
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Phase 7B — sandbox wall', () => {
  it('refuse PADDLE_ENVIRONMENT=production', () => {
    const prev = process.env.PADDLE_ENVIRONMENT;
    process.env.PADDLE_ENVIRONMENT = 'production';
    try {
      assert.throws(() => assertPaddleSandboxOnly(), (e) => e instanceof ConfigWriteError && e.code === 'PADDLE_LIVE_FORBIDDEN');
    } finally {
      process.env.PADDLE_ENVIRONMENT = prev;
    }
  });

  it('refuse live_ client token', () => {
    const prevEnv = process.env.PADDLE_ENVIRONMENT;
    const prevTok = process.env.PADDLE_CLIENT_TOKEN;
    process.env.PADDLE_ENVIRONMENT = 'sandbox';
    process.env.PADDLE_CLIENT_TOKEN = 'live_fake_token';
    try {
      assert.throws(() => assertPaddleSandboxOnly(), (e) => e.code === 'PADDLE_LIVE_TOKEN_FORBIDDEN');
    } finally {
      process.env.PADDLE_ENVIRONMENT = prevEnv;
      if (prevTok === undefined) delete process.env.PADDLE_CLIENT_TOKEN;
      else process.env.PADDLE_CLIENT_TOKEN = prevTok;
    }
  });

  it('config absente → configured=false (pas de crash)', () => {
    const cfg = parsePaddleSandboxConfig({
      PADDLE_ENVIRONMENT: 'sandbox',
      NODE_ENV: 'test',
    });
    assert.equal(cfg.configured, false);
    assert.equal(cfg.environment, 'sandbox');
  });
});

describe('Phase 7B — migrations checkout intents', () => {
  it('applique 20260924_01', async () => {
    await withTempDb(async (db) => {
      const ids = listAppliedSchemaMigrations(db);
      assert.ok(ids.includes('20260924_01_billing_paddle_sandbox'));
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
      assert.ok(tables.includes('billing_checkout_intents'));
      assert.ok(tables.includes('billing_adjustments'));
    });
  });
});

describe('Phase 7B — checkout intents', () => {
  it('crée intent + refuse produit concurrent', async () => {
    await withTempDb(async (db, stmts) => {
      const a = createOrReuseCheckoutIntent({
        db,
        stmts,
        guildId: GUILD,
        actorUserId: ADMIN,
        productKey: 'P1_MONTHLY',
        expectedPriceId: 'pri_01testp1monthly00000000001',
        nowMs: T0,
      });
      assert.ok(a.id.startsWith('bci_'));
      assert.equal(a.binding_hash, hashBinding(a.id, GUILD, 'P1_MONTHLY'));

      assert.throws(() => createOrReuseCheckoutIntent({
        db,
        stmts,
        guildId: GUILD,
        actorUserId: ADMIN,
        productKey: 'P2_MONTHLY',
        expectedPriceId: 'pri_01testp2monthly00000000001',
        nowMs: T0 + 1000,
      }), (e) => e.code === 'CHECKOUT_CONFLICT');

      // Même produit → réutilise
      const b = createOrReuseCheckoutIntent({
        db,
        stmts,
        guildId: GUILD,
        actorUserId: ADMIN,
        productKey: 'P1_MONTHLY',
        expectedPriceId: 'pri_01testp1monthly00000000001',
        nowMs: T0 + 2000,
      });
      assert.equal(b.id, a.id);
    });
  });
});

describe('Phase 7B — paddle normalize fixtures', () => {
  it('subscription.activated → NormalizedBillingEvent', () => {
    process.env.PADDLE_ENVIRONMENT = 'sandbox';
    process.env.PADDLE_PRICE_P1_MONTHLY = 'pri_01testp1monthly00000000001';
    process.env.PADDLE_PRICE_P1_YEARLY = 'pri_01testp1yearly000000000001';
    process.env.PADDLE_PRICE_P2_MONTHLY = 'pri_01testp2monthly00000000001';
    process.env.PADDLE_PRICE_P2_YEARLY = 'pri_01testp2yearly000000000001';
    process.env.PADDLE_PRICE_P3_MONTHLY = 'pri_01testp3monthly00000000001';
    process.env.PADDLE_PRICE_P3_YEARLY = 'pri_01testp3yearly000000000001';
    // configured=false sans api key — provider createCheckout needs client; normalize uses price map only
    process.env.PADDLE_API_KEY = 'pdl_sdbx_test_key_not_real';
    process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test_secret_not_real';
    process.env.PADDLE_CLIENT_TOKEN = 'test_client_token_not_real';

    const config = parsePaddleSandboxConfig();
    const provider = createPaddleBillingProvider(config, { paddleClient: null });

    const normalized = provider.normalizeWebhookEvent({
      eventId: 'evt_01subactivated',
      eventType: 'subscription.activated',
      occurredAt: new Date(T0).toISOString(),
      data: {
        id: 'sub_01testsub000000000000001',
        status: 'active',
        customerId: 'ctm_01testcustomer0000000001',
        customData: { scrim_guild_id: GUILD, scrim_intent_id: 'bci_test', scrim_product_key: 'P1_MONTHLY', scrim_binding: 'x' },
        items: [{ price: { id: 'pri_01testp1monthly00000000001' }, quantity: 1 }],
        currentBillingPeriod: {
          startsAt: new Date(T0).toISOString(),
          endsAt: new Date(T0 + MONTH).toISOString(),
        },
      },
    }, { nowMs: T0 });

    assert.equal(/** @type {any} */ (normalized).skip, undefined);
    assert.equal(/** @type {any} */ (normalized).provider, 'paddle');
    assert.equal(/** @type {any} */ (normalized).planKey, 'P1');
    assert.equal(/** @type {any} */ (normalized).guildId, GUILD);
  });

  it('transaction.paid → skip', () => {
    const config = parsePaddleSandboxConfig();
    const provider = createPaddleBillingProvider(config, { paddleClient: null });
    const out = provider.normalizeWebhookEvent({
      eventId: 'evt_paid',
      eventType: 'transaction.paid',
      occurredAt: new Date(T0).toISOString(),
      data: {},
    });
    assert.equal(/** @type {any} */ (out).skip, true);
  });

  it('unknown price → UNKNOWN_PRODUCT', () => {
    const config = parsePaddleSandboxConfig();
    const provider = createPaddleBillingProvider(config, { paddleClient: null });
    assert.throws(() => provider.normalizeWebhookEvent({
      eventId: 'evt_badprice',
      eventType: 'subscription.activated',
      occurredAt: new Date(T0).toISOString(),
      data: {
        id: 'sub_01',
        status: 'active',
        customerId: 'ctm_01',
        customData: { scrim_guild_id: GUILD },
        items: [{ price: { id: 'pri_unknown' }, quantity: 1 }],
        currentBillingPeriod: {
          startsAt: new Date(T0).toISOString(),
          endsAt: new Date(T0 + MONTH).toISOString(),
        },
      },
    }), (e) => e.code === 'UNKNOWN_PRODUCT');
  });
});

describe('Phase 7B — refund / dispute via Billing Core', () => {
  it('full refund approved coupe paid ; settings path intact (grant only)', async () => {
    await withTempDb(async (db, stmts) => {
      processNormalizedBillingEvent({
        db,
        stmts,
        nowMs: T0,
        event: {
          provider: 'paddle',
          providerEventId: 'e1',
          eventType: 'subscription.created',
          providerEventAt: T0,
          guildId: GUILD,
          providerSubscriptionId: 'sub_1',
          providerCustomerId: 'ctm_1',
          planKey: 'P2',
          interval: 'month',
          productKey: 'P2_MONTHLY',
          status: 'active',
          currentPeriodStart: T0,
          currentPeriodEnd: T0 + MONTH,
          amountMinor: 999,
          currency: 'EUR',
        },
      });
      assert.equal(getPlan(GUILD, { nowMs: T0 + 1, stmts, bypassCache: true }), 'P2');

      processNormalizedBillingEvent({
        db,
        stmts,
        nowMs: T0 + 1000,
        event: {
          provider: 'paddle',
          providerEventId: 'e_ref',
          eventType: 'refund.full_approved',
          providerEventAt: T0 + 1000,
          guildId: GUILD,
          providerSubscriptionId: 'sub_1',
          providerCustomerId: 'ctm_1',
          planKey: 'P2',
          interval: 'month',
          status: 'expired',
          currentPeriodStart: T0,
          currentPeriodEnd: T0 + 1000,
          amountMinor: 999,
          currency: 'EUR',
        },
      });
      assert.equal(getPlan(GUILD, { nowMs: T0 + 2000, stmts, bypassCache: true }), 'FREE');
    });
  });

  it('dispute.opened coupe paid', async () => {
    await withTempDb(async (db, stmts) => {
      processNormalizedBillingEvent({
        db,
        stmts,
        nowMs: T0,
        event: {
          provider: 'paddle',
          providerEventId: 'e1',
          eventType: 'subscription.created',
          providerEventAt: T0,
          guildId: GUILD,
          providerSubscriptionId: 'sub_1',
          providerCustomerId: 'ctm_1',
          planKey: 'P1',
          interval: 'month',
          status: 'active',
          currentPeriodStart: T0,
          currentPeriodEnd: T0 + MONTH,
          amountMinor: 499,
          currency: 'EUR',
        },
      });
      processNormalizedBillingEvent({
        db,
        stmts,
        nowMs: T0 + 500,
        event: {
          provider: 'paddle',
          providerEventId: 'e_cb',
          eventType: 'dispute.opened',
          providerEventAt: T0 + 500,
          guildId: GUILD,
          providerSubscriptionId: 'sub_1',
          providerCustomerId: 'ctm_1',
          planKey: 'P1',
          interval: 'month',
          status: 'expired',
          currentPeriodStart: T0,
          currentPeriodEnd: T0 + 500,
          amountMinor: 499,
          currency: 'EUR',
        },
      });
      assert.equal(getPlan(GUILD, { nowMs: T0 + 600, stmts, bypassCache: true }), 'FREE');
    });
  });

  it('idempotence event paddle ×20', async () => {
    await withTempDb(async (db, stmts) => {
      for (let i = 0; i < 20; i += 1) {
        const r = processNormalizedBillingEvent({
          db,
          stmts,
          nowMs: T0,
          event: {
            provider: 'paddle',
            providerEventId: 'evt_same',
            eventType: 'subscription.created',
            providerEventAt: T0,
            guildId: GUILD,
            providerSubscriptionId: 'sub_1',
            providerCustomerId: 'ctm_1',
            planKey: 'P1',
            interval: 'month',
            status: 'active',
            currentPeriodStart: T0,
            currentPeriodEnd: T0 + MONTH,
            amountMinor: 499,
            currency: 'EUR',
          },
        });
        assert.equal(r.ok, true);
        if (i > 0) assert.equal(r.duplicate, true);
      }
      assert.equal(stmts.listEntitlementGrantsByGuild.all(GUILD).filter((g) => g.source === 'paid').length, 1);
    });
  });
});

describe('Phase 7B — intent id format', () => {
  it('generateCheckoutIntentId opaque', () => {
    const id = generateCheckoutIntentId();
    assert.match(id, /^bci_[a-f0-9]{32}$/);
    assert.ok(CHECKOUT_INTENT_TTL_MS >= 10 * 60 * 1000);
  });
});
