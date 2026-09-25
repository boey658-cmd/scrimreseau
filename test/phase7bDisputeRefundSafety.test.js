/**
 * Phase 7B patch pré-E2E — dispute reverse reconcile + refund fail-safe.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { listAppliedSchemaMigrations } from '../src/database/schemaMigrations.js';
import { processNormalizedBillingEvent } from '../src/services/billing/billingCore.js';
import { createPaddleBillingProvider, parsePaddleSandboxConfig } from '../src/services/billing/index.js';
import { processPaddleWebhook } from '../src/services/billing/paddleWebhookProcessor.js';
import { bindEntitlementStore, getPlan } from '../src/services/entitlements/index.js';
import { ConfigWriteError } from '../src/services/configWriteError.js';

const GUILD = '111456789012345678';
const T0 = 1_700_000_000_000;
const MONTH = 30 * 24 * 60 * 60 * 1000;

const PADDLE_ENV = {
  PADDLE_ENVIRONMENT: 'sandbox',
  PADDLE_API_KEY: 'test_api',
  PADDLE_WEBHOOK_SECRET: 'whsec_test',
  PADDLE_CLIENT_TOKEN: 'test_client',
  PADDLE_PRICE_P1_MONTHLY: 'pri_p1m',
  PADDLE_PRICE_P1_YEARLY: 'pri_p1y',
  PADDLE_PRICE_P2_MONTHLY: 'pri_p2m',
  PADDLE_PRICE_P2_YEARLY: 'pri_p2y',
  PADDLE_PRICE_P3_MONTHLY: 'pri_p3m',
  PADDLE_PRICE_P3_YEARLY: 'pri_p3y',
};

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-pre-e2e-'));
  const prev = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  process.env.NODE_ENV = 'test';
  process.env.PADDLE_ENVIRONMENT = 'sandbox';
  try {
    const db = getDb();
    void listAppliedSchemaMigrations(db);
    const stmts = prepareStatements(db);
    bindEntitlementStore(stmts);
    await fn(db, stmts);
  } finally {
    bindEntitlementStore(null);
    closeDb();
    process.env.SQLITE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function activatePaid(db, stmts, subId = 'sub_legit') {
  processNormalizedBillingEvent({
    db,
    stmts,
    nowMs: T0,
    event: {
      provider: 'paddle',
      providerEventId: `e_create_${subId}`,
      eventType: 'subscription.created',
      providerEventAt: T0,
      guildId: GUILD,
      providerSubscriptionId: subId,
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
}

function openDispute(db, stmts, subId = 'sub_legit') {
  processNormalizedBillingEvent({
    db,
    stmts,
    nowMs: T0 + 1000,
    event: {
      provider: 'paddle',
      providerEventId: `e_cb_${subId}`,
      eventType: 'dispute.opened',
      providerEventAt: T0 + 1000,
      guildId: GUILD,
      providerSubscriptionId: subId,
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
}

describe('pré-E2E — refund fail-safe', () => {
  it('full approved explicite → revoke', async () => {
    await withTempDb(async (db, stmts) => {
      activatePaid(db, stmts);
      assert.equal(getPlan(GUILD, { nowMs: T0 + 1, stmts, bypassCache: true }), 'P2');
      processNormalizedBillingEvent({
        db,
        stmts,
        nowMs: T0 + 2000,
        event: {
          provider: 'paddle',
          providerEventId: 'e_full',
          eventType: 'refund.full_approved',
          providerEventAt: T0 + 2000,
          guildId: GUILD,
          providerSubscriptionId: 'sub_legit',
          providerCustomerId: 'ctm_1',
          planKey: 'P2',
          interval: 'month',
          status: 'expired',
          currentPeriodStart: T0,
          currentPeriodEnd: T0 + 2000,
          amountMinor: 999,
          currency: 'EUR',
        },
      });
      assert.equal(getPlan(GUILD, { nowMs: T0 + 3000, stmts, bypassCache: true }), 'FREE');
    });
  });

  it('partial / pending / rejected / ambiguous → unchanged', async () => {
    await withTempDb(async (db, stmts) => {
      activatePaid(db, stmts);
      for (const [id, type] of [
        ['e_p', 'refund.partial'],
        ['e_pend', 'refund.pending'],
        ['e_rej', 'refund.rejected'],
        ['e_amb', 'refund.ambiguous'],
      ]) {
        const r = processNormalizedBillingEvent({
          db,
          stmts,
          nowMs: T0 + 5000,
          event: {
            provider: 'paddle',
            providerEventId: id,
            eventType: type,
            providerEventAt: T0 + 5000,
            guildId: GUILD,
            providerSubscriptionId: 'sub_legit',
            providerCustomerId: 'ctm_1',
            planKey: 'P2',
            interval: 'month',
            currentPeriodStart: T0,
            currentPeriodEnd: T0 + MONTH,
            amountMinor: 999,
            currency: 'EUR',
          },
        });
        assert.equal(r.ok, true);
        assert.equal(r.noop, true);
      }
      assert.equal(getPlan(GUILD, { nowMs: T0 + 6000, stmts, bypassCache: true }), 'P2');
    });
  });

  it('full refund sans subscription locale → no revoke (doublon fail-safe)', async () => {
    await withTempDb(async (db, stmts) => {
      activatePaid(db, stmts, 'sub_legit');
      const r = processNormalizedBillingEvent({
        db,
        stmts,
        nowMs: T0 + 2000,
        event: {
          provider: 'paddle',
          providerEventId: 'e_dup',
          eventType: 'refund.full_approved',
          providerEventAt: T0 + 2000,
          guildId: GUILD,
          providerSubscriptionId: 'sub_orphan_dup',
          providerCustomerId: 'ctm_1',
          planKey: 'P2',
          interval: 'month',
          status: 'expired',
          currentPeriodStart: T0,
          currentPeriodEnd: T0 + 2000,
          amountMinor: 999,
          currency: 'EUR',
        },
      });
      assert.equal(r.ok, true);
      assert.equal(r.ambiguous, true);
      assert.equal(getPlan(GUILD, { nowMs: T0 + 3000, stmts, bypassCache: true }), 'P2');
    });
  });

  it('normalize: approved sans type → refund.ambiguous (pas full)', () => {
    const config = parsePaddleSandboxConfig(PADDLE_ENV);
    const provider = createPaddleBillingProvider(config, {
      paddleClient: {
        webhooks: { unmarshal: async () => ({}) },
      },
    });
    const out = provider.normalizeWebhookEvent({
      eventId: 'evt_amb',
      eventType: 'adjustment.updated',
      occurredAt: new Date(T0).toISOString(),
      data: {
        id: 'adj_1',
        action: 'refund',
        status: 'approved',
        subscriptionId: 'sub_1',
        customData: { scrim_guild_id: GUILD },
        items: [{ price: { id: 'pri_p2m' } }],
      },
    });
    assert.equal(out.eventType, 'refund.ambiguous');
  });

  it('normalize: type=full approved → refund.full_approved', () => {
    const config = parsePaddleSandboxConfig(PADDLE_ENV);
    const provider = createPaddleBillingProvider(config, {
      paddleClient: { webhooks: { unmarshal: async () => ({}) } },
    });
    const out = provider.normalizeWebhookEvent({
      eventId: 'evt_full',
      eventType: 'adjustment.updated',
      occurredAt: new Date(T0).toISOString(),
      data: {
        id: 'adj_2',
        action: 'refund',
        type: 'full',
        status: 'approved',
        subscriptionId: 'sub_1',
        customData: { scrim_guild_id: GUILD },
        items: [{ price: { id: 'pri_p2m' } }],
      },
    });
    assert.equal(out.eventType, 'refund.full_approved');
  });

  it('chargeback → paid suspendu', async () => {
    await withTempDb(async (db, stmts) => {
      activatePaid(db, stmts, 'sub_cb');
      const config = parsePaddleSandboxConfig(PADDLE_ENV);
      const provider = createPaddleBillingProvider(config, {
        paddleClient: {
          webhooks: {
            unmarshal: async () => ({
              eventId: 'evt_cb',
              eventType: 'adjustment.updated',
              occurredAt: new Date(T0 + 2000).toISOString(),
              data: {
                action: 'chargeback',
                status: 'approved',
                subscriptionId: 'sub_cb',
                customerId: 'ctm_1',
                customData: { scrim_guild_id: GUILD },
                items: [{ priceId: 'pri_p2m' }],
              },
            }),
          },
        },
      });
      const res = await processPaddleWebhook({
        db, stmts, provider, rawBody: '{}', signature: 'ts=1;h1=x', nowMs: T0 + 2000,
      });
      assert.equal(res.httpStatus, 200);
      assert.equal(getPlan(GUILD, { nowMs: T0 + 3000, stmts, bypassCache: true }), 'FREE');
    });
  });

  it('chargeback_warning → paid suspendu', async () => {
    await withTempDb(async (db, stmts) => {
      activatePaid(db, stmts, 'sub_warn');
      const config = parsePaddleSandboxConfig(PADDLE_ENV);
      const provider = createPaddleBillingProvider(config, {
        paddleClient: {
          webhooks: {
            unmarshal: async () => ({
              eventId: 'evt_warn',
              eventType: 'adjustment.updated',
              occurredAt: new Date(T0 + 2000).toISOString(),
              data: {
                action: 'chargeback_warning',
                status: 'approved',
                subscriptionId: 'sub_warn',
                customerId: 'ctm_1',
                customData: { scrim_guild_id: GUILD },
                items: [{ priceId: 'pri_p2m' }],
              },
            }),
          },
        },
      });
      const res = await processPaddleWebhook({
        db, stmts, provider, rawBody: '{}', signature: 'ts=1;h1=x', nowMs: T0 + 2000,
      });
      assert.equal(res.httpStatus, 200);
      assert.equal(getPlan(GUILD, { nowMs: T0 + 3000, stmts, bypassCache: true }), 'FREE');
    });
  });

  it('adjustment.created → adjustment.updated same eventId → idempotent', async () => {
    await withTempDb(async (db, stmts) => {
      activatePaid(db, stmts);
      const config = parsePaddleSandboxConfig(PADDLE_ENV);
      const makeProvider = (eventType) => createPaddleBillingProvider(config, {
        paddleClient: {
          webhooks: {
            unmarshal: async () => ({
              eventId: 'evt_refund_same',
              eventType,
              occurredAt: new Date(T0 + 2000).toISOString(),
              data: {
                id: 'adj_same',
                action: 'refund',
                type: 'full',
                status: 'approved',
                subscriptionId: 'sub_legit',
                customerId: 'ctm_1',
                customData: { scrim_guild_id: GUILD },
                items: [{ price: { id: 'pri_p2m' } }],
              },
            }),
          },
        },
      });
      const first = await processPaddleWebhook({
        db,
        stmts,
        provider: makeProvider('adjustment.created'),
        rawBody: '{}',
        signature: 'ts=1;h1=x',
        nowMs: T0 + 2000,
      });
      assert.equal(first.httpStatus, 200);
      assert.equal(getPlan(GUILD, { nowMs: T0 + 2500, stmts, bypassCache: true }), 'FREE');
      const second = await processPaddleWebhook({
        db,
        stmts,
        provider: makeProvider('adjustment.updated'),
        rawBody: '{}',
        signature: 'ts=1;h1=x',
        nowMs: T0 + 3000,
      });
      assert.equal(second.httpStatus, 200);
      assert.equal(second.duplicate, true);
      assert.equal(getPlan(GUILD, { nowMs: T0 + 3500, stmts, bypassCache: true }), 'FREE');
    });
  });
});

describe('pré-E2E — dispute reverse reconcile', () => {
  it('normalize reverse → reconcileOnly (aucune période +30j)', () => {
    const config = parsePaddleSandboxConfig(PADDLE_ENV);
    const provider = createPaddleBillingProvider(config, {
      paddleClient: { webhooks: { unmarshal: async () => ({}) } },
    });
    const out = provider.normalizeWebhookEvent({
      eventId: 'evt_rev',
      eventType: 'adjustment.updated',
      occurredAt: new Date(T0).toISOString(),
      data: {
        action: 'chargeback_reverse',
        status: 'approved',
        subscriptionId: 'sub_legit',
        customData: { scrim_guild_id: GUILD },
      },
    });
    assert.equal(out.reconcileOnly, true);
    assert.equal(out.currentPeriodEnd, undefined);
    assert.ok(!JSON.stringify(out).includes(String(30 * 24 * 60 * 60 * 1000)));
  });

  it('reverse + provider active → restore via reconcile', async () => {
    await withTempDb(async (db, stmts) => {
      activatePaid(db, stmts);
      openDispute(db, stmts);
      assert.equal(getPlan(GUILD, { nowMs: T0 + 2000, stmts, bypassCache: true }), 'FREE');

      const config = parsePaddleSandboxConfig(PADDLE_ENV);
      const eventPayload = {
        eventId: 'evt_rev_ok',
        eventType: 'adjustment.updated',
        occurredAt: new Date(T0 + 3000).toISOString(),
        data: {
          action: 'chargeback_reverse',
          status: 'approved',
          subscriptionId: 'sub_legit',
          customerId: 'ctm_1',
          customData: { scrim_guild_id: GUILD },
        },
      };

      const provider = createPaddleBillingProvider(config, {
        paddleClient: {
          webhooks: {
            unmarshal: async () => eventPayload,
          },
          subscriptions: {
            get: async () => ({
              id: 'sub_legit',
              status: 'active',
              customerId: 'ctm_1',
              customData: { scrim_guild_id: GUILD },
              items: [{ price: { id: 'pri_p2m' } }],
              currentBillingPeriod: {
                startsAt: new Date(T0).toISOString(),
                endsAt: new Date(T0 + MONTH).toISOString(),
              },
            }),
          },
        },
      });

      const res = await processPaddleWebhook({
        db,
        stmts,
        provider,
        rawBody: '{}',
        signature: 'ts=1;h1=x',
        nowMs: T0 + 3000,
      });
      assert.equal(res.httpStatus, 200);
      assert.equal(res.ok, true);
      assert.equal(getPlan(GUILD, { nowMs: T0 + 4000, stmts, bypassCache: true }), 'P2');
    });
  });

  it('reverse + provider canceled → stays inactive', async () => {
    await withTempDb(async (db, stmts) => {
      activatePaid(db, stmts);
      openDispute(db, stmts);
      const config = parsePaddleSandboxConfig(PADDLE_ENV);
      const eventPayload = {
        eventId: 'evt_rev_canceled',
        eventType: 'adjustment.updated',
        occurredAt: new Date(T0 + 3000).toISOString(),
        data: {
          action: 'chargeback_warning_reverse',
          subscriptionId: 'sub_legit',
          customerId: 'ctm_1',
          customData: { scrim_guild_id: GUILD },
        },
      };
      const provider = createPaddleBillingProvider(config, {
        paddleClient: {
          webhooks: { unmarshal: async () => eventPayload },
          subscriptions: {
            get: async () => ({
              id: 'sub_legit',
              status: 'canceled',
              customerId: 'ctm_1',
              customData: { scrim_guild_id: GUILD },
              items: [{ price: { id: 'pri_p2m' } }],
              currentBillingPeriod: {
                startsAt: new Date(T0).toISOString(),
                endsAt: new Date(T0 + 1000).toISOString(),
              },
            }),
          },
        },
      });
      const res = await processPaddleWebhook({
        db,
        stmts,
        provider,
        rawBody: '{}',
        signature: 'ts=1;h1=x',
        nowMs: T0 + 3000,
      });
      assert.equal(res.httpStatus, 200);
      assert.equal(getPlan(GUILD, { nowMs: T0 + 4000, stmts, bypassCache: true }), 'FREE');
    });
  });

  it('reverse + provider timeout → 503, paid reste suspendu', async () => {
    await withTempDb(async (db, stmts) => {
      activatePaid(db, stmts);
      openDispute(db, stmts);
      const config = parsePaddleSandboxConfig(PADDLE_ENV);
      const eventPayload = {
        eventId: 'evt_rev_timeout',
        eventType: 'adjustment.updated',
        occurredAt: new Date(T0 + 3000).toISOString(),
        data: {
          action: 'chargeback_reverse',
          subscriptionId: 'sub_legit',
          customerId: 'ctm_1',
          customData: { scrim_guild_id: GUILD },
        },
      };
      const provider = createPaddleBillingProvider(config, {
        paddleClient: {
          webhooks: { unmarshal: async () => eventPayload },
          subscriptions: {
            get: async () => {
              throw new ConfigWriteError(503, 'PADDLE_UNAVAILABLE', 'timeout');
            },
          },
        },
      });
      const res = await processPaddleWebhook({
        db,
        stmts,
        provider,
        rawBody: '{}',
        signature: 'ts=1;h1=x',
        nowMs: T0 + 3000,
      });
      assert.equal(res.httpStatus, 503);
      assert.equal(res.reconcile_pending, true);
      assert.equal(getPlan(GUILD, { nowMs: T0 + 4000, stmts, bypassCache: true }), 'FREE');
      const ev = stmts.getBillingEventByProviderIds.get('paddle', 'evt_rev_timeout');
      assert.ok(!ev || ev.processing_status !== 'processed');
    });
  });
});
