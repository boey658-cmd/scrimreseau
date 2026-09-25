/**
 * Phase 5 — Profil structure, badge Premium, mise en avant annuaire.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { fetchGuildConfig } from '../src/internalHttp/configQueries.js';
import { buildPublicNetworkPartners } from '../src/services/publicNetworkPartners.js';
import {
  bindEntitlementStore,
  canUseFeature,
  clearEntitlementCache,
} from '../src/services/entitlements/index.js';
import { insertEntitlementGrant } from '../src/services/entitlements/entitlementStore.js';
import { applyGuildConfigSectionWrite } from '../src/services/guildConfigWrites.js';
import { ConfigWriteError } from '../src/services/configWriteError.js';
import {
  deleteStructureProfile,
  getStructureProfile,
  upsertStructureProfile,
} from '../src/services/structureProfileStore.js';
import { parseStructureProfilePatchBody } from '../src/services/structureProfileValidation.js';
import {
  buildDashboardStructureProfileView,
  resolvePublicStructurePartner,
  sortPublicNetworkPartners,
  toPublicNetworkPartnerPayload,
} from '../src/services/structureProfileResolver.js';
import { stopDashboardRefreshJob } from '../src/services/networkDashboard.js';

const GUILD = '1484520688726311012';
const GUILD_B = '1484520688726311013';
const GUILD_C = '1484520688726311014';
const GUILD_D = '1484520688726311015';
const ADMIN = '1009269632693174422';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-p5-profile-'));
  const prev = process.env.SQLITE_PATH;
  const prevOwner = process.env.SCRIMRESEAU_OWNER_ID;
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  process.env.SCRIMRESEAU_OWNER_ID = ADMIN;
  try {
    closeDb();
    clearEntitlementCache();
    const db = getDb();
    const stmts = prepareStatements(db);
    bindEntitlementStore(stmts);
    await fn(db, stmts);
  } finally {
    stopDashboardRefreshJob();
    clearEntitlementCache();
    bindEntitlementStore(null);
    closeDb();
    if (prev === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prev;
    if (prevOwner === undefined) delete process.env.SCRIMRESEAU_OWNER_ID;
    else process.env.SCRIMRESEAU_OWNER_ID = prevOwner;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function grantGift(db, stmts, guildId, planKey, nowMs, endsAt = nowMs + 86_400_000) {
  return insertEntitlementGrant({
    db,
    stmts,
    guildId,
    planKey,
    source: 'gift',
    startsAt: nowMs - 1000,
    endsAt,
    grantedBy: ADMIN,
    reason: 'phase5-test',
    idempotencyKey: `p5-${guildId}-${planKey}-${nowMs}-${Math.random()}`,
    nowMs,
  });
}

function mockWriteCtx(db, stmts, guildId = GUILD) {
  return {
    client: {},
    guild: { id: guildId, name: 'Test' },
    db,
    stmts,
    guildId,
    actorDiscordUserId: ADMIN,
  };
}

describe('Phase 5 — validation profil', () => {
  it('rejette javascript: / data: / http / localhost', () => {
    assert.throws(
      () => parseStructureProfilePatchBody({ logo_url: 'javascript:alert(1)' }),
      (e) => e instanceof ConfigWriteError && e.status === 400,
    );
    assert.throws(
      () => parseStructureProfilePatchBody({ website_url: 'data:text/html,x' }),
      (e) => e instanceof ConfigWriteError && e.status === 400,
    );
    assert.throws(
      () => parseStructureProfilePatchBody({ logo_url: 'http://example.com/a.png' }),
      (e) => e instanceof ConfigWriteError && e.status === 400,
    );
    assert.throws(
      () => parseStructureProfilePatchBody({ logo_url: 'https://localhost/x.png' }),
      (e) => e instanceof ConfigWriteError && e.status === 400,
    );
  });

  it('rejette mass assignment featured/plan_key + provider invalide', () => {
    assert.throws(
      () => parseStructureProfilePatchBody({ premium_featured: true }),
      (e) => e instanceof ConfigWriteError && e.status === 400,
    );
    assert.throws(
      () => parseStructureProfilePatchBody({ plan_key: 'P3' }),
      (e) => e instanceof ConfigWriteError && e.status === 400,
    );
    assert.throws(
      () =>
        parseStructureProfilePatchBody({
          socials: [{ provider: 'facebook', url: 'https://facebook.com/x' }],
        }),
      (e) => e instanceof ConfigWriteError && e.status === 400,
    );
  });

  it('accepte description avec balises comme texte (pas d’exécution)', () => {
    const parsed = parseStructureProfilePatchBody({
      description: '<script>alert(1)</script>',
    });
    assert.equal(parsed.description, '<script>alert(1)</script>');
  });
});

describe('Phase 5 — store + dashboard view', () => {
  it('migration structure_profiles + CRUD + downgrade conserve stored', async () => {
    await withTempDb(async (db, stmts) => {
      const t0 = Date.now();
      grantGift(db, stmts, GUILD, 'P1', t0);
      clearEntitlementCache();

      upsertStructureProfile(db, GUILD, {
        display_name: 'Alpha Squad',
        description: 'Desc',
        logo_url: 'https://cdn.example.com/logo.png',
        website_url: 'https://example.com',
        country_code: 'FR',
        languages: ['fr', 'en'],
        socials: [{ provider: 'twitch', url: 'https://twitch.tv/alpha' }],
      }, t0);

      const viewP1 = buildDashboardStructureProfileView(db, GUILD, { stmts, nowMs: t0 });
      assert.equal(viewP1.feature_available, true);
      assert.equal(viewP1.premium_badge, true);
      assert.equal(viewP1.directory_featured, true);
      assert.equal(viewP1.effective.display_name, 'Alpha Squad');
      assert.equal(viewP1.stored.display_name, 'Alpha Squad');

      // expire → FREE
      const tExpired = t0 + 86_400_000 + 1;
      clearEntitlementCache();
      assert.equal(
        canUseFeature(GUILD, 'enhanced_structure_profile', { stmts, nowMs: tExpired }),
        false,
      );
      const viewFree = buildDashboardStructureProfileView(db, GUILD, {
        stmts,
        nowMs: tExpired,
      });
      assert.equal(viewFree.feature_available, false);
      assert.equal(viewFree.premium_badge, false);
      assert.equal(viewFree.directory_featured, false);
      assert.equal(viewFree.stored.display_name, 'Alpha Squad');
      assert.equal(viewFree.effective.display_name, null);

      const cfg = fetchGuildConfig(db, GUILD, { stmts, nowMs: tExpired });
      assert.ok(cfg.structure_profile);
      assert.equal(cfg.structure_profile.stored.display_name, 'Alpha Squad');
      assert.equal(cfg.structure_profile.feature_available, false);
    });
  });

  it('write FREE → FEATURE_NOT_AVAILABLE ; P1 OK ; reset explicite', async () => {
    await withTempDb(async (db, stmts) => {
      const t0 = Date.now();
      clearEntitlementCache();
      await assert.rejects(
        () =>
          applyGuildConfigSectionWrite(mockWriteCtx(db, stmts), {
            section: 'structure_profile',
            display_name: 'Nope',
            description: null,
            logo_url: null,
            website_url: null,
            country_code: null,
            languages: null,
            socials: null,
          }),
        (e) => e instanceof ConfigWriteError && e.status === 403 && e.code === 'FEATURE_NOT_AVAILABLE',
      );

      grantGift(db, stmts, GUILD, 'P2', t0);
      clearEntitlementCache();
      const written = await applyGuildConfigSectionWrite(mockWriteCtx(db, stmts), {
        section: 'structure_profile',
        display_name: 'Beta',
        description: 'Hello',
        logo_url: 'https://cdn.example.com/b.png',
        website_url: null,
        country_code: 'ES',
        languages: ['es'],
        socials: [{ provider: 'x', url: 'https://x.com/beta' }],
      });
      assert.equal(written.noop, false);
      assert.equal(written.config.structure_profile.stored.display_name, 'Beta');

      const reset = await applyGuildConfigSectionWrite(mockWriteCtx(db, stmts), {
        section: 'structure_profile',
        reset: true,
      });
      assert.equal(reset.noop, false);
      assert.equal(getStructureProfile(db, GUILD), null);
    });
  });
});

describe('Phase 5 — public Network sort + privacy + expiration', () => {
  it('Premium avant Free, alpha dans chaque groupe, pas de guild_id', () => {
    const flagsPremium = {
      enriched_profile: true,
      premium_badge: true,
      directory_featured: true,
    };
    const flagsFree = {
      enriched_profile: false,
      premium_badge: false,
      directory_featured: false,
    };

    const resolved = [
      resolvePublicStructurePartner({
        guildId: GUILD_D,
        discordName: 'Zeta',
        discordIconUrl: null,
        inviteUrl: null,
        stored: null,
        flags: flagsFree,
      }),
      resolvePublicStructurePartner({
        guildId: GUILD,
        discordName: 'Zebra Guild',
        discordIconUrl: null,
        inviteUrl: null,
        stored: { display_name: 'Zebra', description: null, logo_url: null, website_url: null, country_code: null, languages: null, socials: null },
        flags: flagsPremium,
      }),
      resolvePublicStructurePartner({
        guildId: GUILD_B,
        discordName: 'Alpha Free',
        discordIconUrl: null,
        inviteUrl: null,
        stored: null,
        flags: flagsFree,
      }),
      resolvePublicStructurePartner({
        guildId: GUILD_C,
        discordName: 'Beta Guild',
        discordIconUrl: null,
        inviteUrl: null,
        stored: { display_name: 'Beta', description: 'x', logo_url: null, website_url: null, country_code: null, languages: null, socials: null },
        flags: flagsPremium,
      }),
    ];

    const sorted = sortPublicNetworkPartners(resolved).map(toPublicNetworkPartnerPayload);
    assert.deepStrictEqual(
      sorted.map((p) => p.name),
      ['Beta', 'Zebra', 'Alpha Free', 'Zeta'],
    );
    assert.ok(sorted[0].premium_featured);
    assert.ok(sorted[0].premium_badge);
    assert.ok(!sorted[2].premium_featured);
    const json = JSON.stringify(sorted);
    assert.ok(!json.includes('guild_id'));
    assert.ok(!json.includes(GUILD));
    assert.ok(!json.includes('_sort_guild_id'));
  });

  it('expiration T exacte : featured disparaît immédiatement', async () => {
    await withTempDb(async (db, stmts) => {
      const t0 = 1_700_000_000_000;
      const endsAt = t0 + 10_000;
      grantGift(db, stmts, GUILD, 'P1', t0, endsAt);
      clearEntitlementCache();
      upsertStructureProfile(db, GUILD, {
        display_name: 'Premium Now',
        description: 'enriched',
        logo_url: 'https://cdn.example.com/p.png',
        website_url: null,
        country_code: null,
        languages: null,
        socials: null,
      }, t0);

      const before = buildPublicNetworkPartners(
        [GUILD, GUILD_B],
        new Set(),
        (id) =>
          id === GUILD
            ? { name: 'Discord Name', icon_url: null }
            : { name: 'Free Alpha', icon_url: null },
        {
          stmts,
          nowMs: endsAt - 1,
          getStoredProfile: (id) => {
            const row = getStructureProfile(db, id);
            return row
              ? {
                  display_name: row.display_name,
                  description: row.description,
                  logo_url: row.logo_url,
                  website_url: row.website_url,
                  country_code: row.country_code,
                  languages: row.languages,
                  socials: row.socials,
                }
              : null;
          },
        },
      );
      assert.equal(before.partners[0].name, 'Premium Now');
      assert.equal(before.partners[0].premium_featured, true);
      assert.equal(before.partners[0].description, 'enriched');

      clearEntitlementCache();
      const after = buildPublicNetworkPartners(
        [GUILD, GUILD_B],
        new Set(),
        (id) =>
          id === GUILD
            ? { name: 'Discord Name', icon_url: null }
            : { name: 'Free Alpha', icon_url: null },
        {
          stmts,
          nowMs: endsAt,
          getStoredProfile: (id) => {
            const row = getStructureProfile(db, id);
            return row
              ? {
                  display_name: row.display_name,
                  description: row.description,
                  logo_url: row.logo_url,
                  website_url: row.website_url,
                  country_code: row.country_code,
                  languages: row.languages,
                  socials: row.socials,
                }
              : null;
          },
        },
      );
      assert.deepStrictEqual(
        after.partners.map((p) => p.name),
        ['Discord Name', 'Free Alpha'],
      );
      assert.equal(after.partners[0].premium_featured, false);
      assert.equal(after.partners[0].description, null);
      assert.ok(getStructureProfile(db, GUILD)); // stored kept
    });
  });

  it('fail-safe entitlement → FREE mais structure visible', () => {
    const out = buildPublicNetworkPartners(
      [GUILD],
      new Set(),
      () => ({ name: 'Still Visible', icon_url: null }),
      {
        getFlags: () => {
          throw new Error('entitlement boom');
        },
      },
    );
    assert.equal(out.count, 1);
    assert.equal(out.partners[0].name, 'Still Visible');
    assert.equal(out.partners[0].premium_featured, false);
    assert.equal(out.partners[0].premium_badge, false);
    assert.equal(out.partners[0].description, null);
  });
});

describe('Phase 5 — concurrency soft', () => {
  it('last-write-wins + reset pendant update', async () => {
    await withTempDb(async (db, stmts) => {
      const t0 = Date.now();
      grantGift(db, stmts, GUILD, 'P3', t0);
      clearEntitlementCache();

      await Promise.all([
        applyGuildConfigSectionWrite(mockWriteCtx(db, stmts), {
          section: 'structure_profile',
          display_name: 'A',
          description: null,
          logo_url: null,
          website_url: null,
          country_code: null,
          languages: null,
          socials: null,
        }),
        applyGuildConfigSectionWrite(mockWriteCtx(db, stmts), {
          section: 'structure_profile',
          display_name: 'B',
          description: null,
          logo_url: null,
          website_url: null,
          country_code: null,
          languages: null,
          socials: null,
        }),
      ]);
      const row = getStructureProfile(db, GUILD);
      assert.ok(row);
      assert.ok(row.display_name === 'A' || row.display_name === 'B');

      await applyGuildConfigSectionWrite(mockWriteCtx(db, stmts), {
        section: 'structure_profile',
        reset: true,
      });
      assert.equal(getStructureProfile(db, GUILD), null);
      deleteStructureProfile(db, GUILD); // idempotent
    });
  });
});
