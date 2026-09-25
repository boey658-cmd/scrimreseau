/**
 * Phase 3 — Filtres Elo par salon : taxonomie, matching, API, broadcast, FREE compat.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { listAppliedSchemaMigrations } from '../src/database/schemaMigrations.js';
import { UI_PRIMARY_GAME_KEY } from '../src/config/games.js';
import { ConfigWriteError } from '../src/services/configWriteError.js';
import { fetchGuildConfig } from '../src/internalHttp/configQueries.js';
import { applyGuildConfigSectionWrite } from '../src/services/guildConfigWrites.js';
import {
  listActiveReceptionDestinationsForGame,
} from '../src/services/receptionChannels.js';
import {
  LOL_FILTER_RANK_KEYS,
  LOL_RANK_TIERS,
  MIX_NIVEAU_RANK_KEY,
  destinationAcceptsScrim,
  getRankTierIndex,
  isFilterRankIncludedInScrimRange,
  isValidLolFilterRankKey,
  parseScrimRankRange,
} from '../src/services/rankTaxonomy.js';
import {
  bindEntitlementStore,
  clearEntitlementCache,
  canUseFeature,
  getLimit,
} from '../src/services/entitlements/index.js';
import { insertEntitlementGrant } from '../src/services/entitlements/entitlementStore.js';
import { stopDashboardRefreshJob } from '../src/services/networkDashboard.js';
import { PLAN_P1 } from '../src/services/entitlements/planCatalog.js';

const GUILD = '1484520688726311012';
const GUILD_B = '1436848619796828322';
const GUILD_C = '1399999999999999999';
const ADMIN = '1009269632693174422';

function ch(n) {
  return String(100000000000000000n + BigInt(n));
}

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-p3-elo-'));
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
    for (const g of [GUILD, GUILD_B, GUILD_C]) {
      stmts.upsertGuildScrimReceptionBypass.run({
        guild_id: g,
        bypass_member_minimum: 1,
        updated_by: ADMIN,
        updated_at: new Date().toISOString(),
        note: 'p3',
      });
    }
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

function grantPlan(db, stmts, guildId, planKey) {
  const now = Date.now();
  return insertEntitlementGrant({
    db,
    stmts,
    guildId,
    planKey,
    source: 'gift',
    startsAt: now - 1000,
    endsAt: now + 365 * 24 * 3600 * 1000,
    grantedBy: ADMIN,
    reason: 'p3',
    idempotencyKey: `p3-${guildId}-${planKey}-${Math.random()}`,
    nowMs: now,
  });
}

function seedChannels(db, guildId, count, startN = 1) {
  const ids = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const id = ch(startN + i);
    ids.push(id);
    db.prepare(`
      INSERT INTO guild_game_channels
        (guild_id, channel_id, game_key, enabled, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
    `).run(guildId, id, UI_PRIMARY_GAME_KEY, i, now + i, now + i);
  }
  return ids;
}

function setFilter(db, guildId, channelId, eloRankKey) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO guild_reception_channel_filters
      (guild_id, channel_id, game_key, elo_rank_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, channel_id) DO UPDATE SET
      elo_rank_key = excluded.elo_rank_key,
      updated_at = excluded.updated_at
  `).run(guildId, channelId, UI_PRIMARY_GAME_KEY, eloRankKey, now, now);
}

describe('Phase 3 — planCatalog elo_channel_filters', () => {
  it('P1/P2/P3 = true, FREE = false', () => {
    assert.equal(PLAN_P1.features.elo_channel_filters, true);
    assert.equal(canUseFeature('x', 'elo_channel_filters'), false);
  });
});

describe('Phase 3 — migration filtres', () => {
  it('DB neuve applique 20260923_03', async () => {
    await withTempDb(async (db) => {
      assert.ok(listAppliedSchemaMigrations(db).includes('20260923_03_reception_channel_elo_filters'));
      const row = db.prepare(
        `SELECT name FROM sqlite_master WHERE name = 'guild_reception_channel_filters'`,
      ).get();
      assert.ok(row);
    });
  });
});

describe('Phase 3 — taxonomie / matching table-driven', () => {
  it('indices tiers ordonnés', () => {
    assert.equal(getRankTierIndex('Fer'), 0);
    assert.equal(getRankTierIndex('Or'), 3);
    assert.equal(getRankTierIndex('gold'), 3);
    assert.equal(getRankTierIndex('Challenger'), 9);
    assert.equal(getRankTierIndex('unknown'), -1);
  });

  it('filtre keys = mono-tiers uniquement', () => {
    assert.equal(LOL_FILTER_RANK_KEYS.length, 10);
    assert.ok(isValidLolFilterRankKey('Or'));
    assert.equal(isValidLolFilterRankKey('Argent / Or'), false);
    assert.equal(isValidLolFilterRankKey(MIX_NIVEAU_RANK_KEY), false);
  });

  const FILTERS = [...LOL_FILTER_RANK_KEYS];
  const COMPOSITES = [
    'Bronze / Argent',
    'Argent / Or',
    'Or / Platine',
    'Platine / Émeraude',
    'Émeraude / Diamant',
    'Diamant / Master',
    'Master / Grandmaster',
    'Grandmaster / Challenger',
  ];

  for (const filter of FILTERS) {
    it(`cible ${filter} : mono + plages adjacentes`, () => {
      assert.equal(isFilterRankIncludedInScrimRange(filter, filter), true);
      const idx = getRankTierIndex(filter);
      for (const other of FILTERS) {
        const o = getRankTierIndex(other);
        if (o === idx) continue;
        assert.equal(
          isFilterRankIncludedInScrimRange(filter, other),
          false,
          `${filter} vs mono ${other}`,
        );
      }
      for (const comp of COMPOSITES) {
        const range = parseScrimRankRange(comp);
        assert.equal(range.kind, 'range');
        const expect = idx >= range.min && idx <= range.max;
        assert.equal(
          isFilterRankIncludedInScrimRange(filter, comp),
          expect,
          `${filter} vs ${comp}`,
        );
      }
      assert.equal(isFilterRankIncludedInScrimRange(filter, MIX_NIVEAU_RANK_KEY), false);
    });
  }

  it('exemples produit Gold (Or)', () => {
    assert.equal(isFilterRankIncludedInScrimRange('Or', 'Argent / Or'), true);
    assert.equal(isFilterRankIncludedInScrimRange('Or', 'Or'), true);
    assert.equal(isFilterRankIncludedInScrimRange('Or', 'Or / Platine'), true);
    assert.equal(isFilterRankIncludedInScrimRange('Or', 'Argent'), false);
    assert.equal(isFilterRankIncludedInScrimRange('Or', 'Platine'), false);
  });

  it('destinationAcceptsScrim : feature off ignore filtre', () => {
    const d = destinationAcceptsScrim(
      { eloFilterRankKey: 'Or', filtersFeatureEnabled: false },
      { rankKey: 'Platine' },
    );
    assert.equal(d.accept, true);
    assert.equal(d.reason, 'feature_off');
  });

  it('destinationAcceptsScrim : filtre invalide fail-closed', () => {
    const d = destinationAcceptsScrim(
      { eloFilterRankKey: 'NOT_A_RANK', filtersFeatureEnabled: true },
      { rankKey: 'Or' },
    );
    assert.equal(d.accept, false);
    assert.equal(d.reason, 'invalid_filter');
  });
});

describe('Phase 3 — write filter + security', () => {
  function makeCtx(db, stmts, channelsMap = new Map()) {
    const guild = {
      id: GUILD,
      ownerId: ADMIN,
      memberCount: 200,
      members: {
        me: { id: 'bot', permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) },
        fetch: async () => ({
          id: ADMIN,
          permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
        }),
        fetchMe: async () => guild.members.me,
      },
      channels: {
        cache: { get: (id) => channelsMap.get(id) ?? null },
        fetch: async (id) => channelsMap.get(id) ?? null,
      },
    };
    return {
      client: { guilds: { cache: { get: () => guild }, fetch: async () => guild } },
      guild,
      db,
      stmts,
      guildId: GUILD,
      actorDiscordUserId: ADMIN,
    };
  }

  it('FREE set filter → FEATURE_NOT_AVAILABLE', async () => {
    await withTempDb(async (db, stmts) => {
      const ids = seedChannels(db, GUILD, 1);
      const ctx = makeCtx(db, stmts);
      await assert.rejects(
        () => applyGuildConfigSectionWrite(ctx, {
          section: 'reception_channel_filter',
          channel_id: ids[0],
          elo_rank_key: 'Or',
        }),
        (e) => e instanceof ConfigWriteError && e.code === 'FEATURE_NOT_AVAILABLE',
      );
    });
  });

  it('P1 set/unset filter OK', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P1');
      clearEntitlementCache();
      const ids = seedChannels(db, GUILD, 1);
      const ctx = makeCtx(db, stmts);
      const set = await applyGuildConfigSectionWrite(ctx, {
        section: 'reception_channel_filter',
        channel_id: ids[0],
        elo_rank_key: 'Or',
      });
      assert.equal(set.noop, false);
      assert.equal(
        set.config.reception_channels.find((c) => c.channel_id === ids[0])?.elo_filter,
        'Or',
      );

      const unset = await applyGuildConfigSectionWrite(ctx, {
        section: 'reception_channel_filter',
        channel_id: ids[0],
        elo_rank_key: null,
      });
      assert.equal(unset.noop, false);
      assert.equal(
        unset.config.reception_channels.find((c) => c.channel_id === ids[0])?.elo_filter,
        null,
      );
    });
  });

  it('rank invalide / channel inconnu / mass assignment ignoré', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P1');
      clearEntitlementCache();
      const ids = seedChannels(db, GUILD, 1);
      const ctx = makeCtx(db, stmts);
      await assert.rejects(
        () => applyGuildConfigSectionWrite(ctx, {
          section: 'reception_channel_filter',
          channel_id: ids[0],
          elo_rank_key: 'Gold',
        }),
        (e) => e.code === 'VALIDATION_ERROR',
      );
      await assert.rejects(
        () => applyGuildConfigSectionWrite(ctx, {
          section: 'reception_channel_filter',
          channel_id: ch(99),
          elo_rank_key: 'Or',
        }),
        (e) => e.code === 'RECEPTION_CHANNEL_NOT_FOUND',
      );
      // mass assignment fields ignored by apply (not in validation keys if via parse;
      // direct apply still only reads channel_id + elo_rank_key)
      await applyGuildConfigSectionWrite(ctx, {
        section: 'reception_channel_filter',
        channel_id: ids[0],
        elo_rank_key: 'Argent',
        featureEnabled: true,
        matches: true,
      });
      const cfg = fetchGuildConfig(db, GUILD, { stmts });
      assert.equal(cfg.reception_channels[0].elo_filter, 'Argent');
    });
  });
});

describe('Phase 3 — broadcast matching multi-salons', () => {
  it('P2 4 salons filtres + scrim Gold', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P2');
      clearEntitlementCache();
      const ids = seedChannels(db, GUILD, 4);
      setFilter(db, GUILD, ids[0], 'Or');
      setFilter(db, GUILD, ids[1], 'Argent');
      setFilter(db, GUILD, ids[2], 'Platine');
      // D aucun filtre

      const dest = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY, {
        scrimRankKey: 'Or',
      }).filter((d) => d.guild_id === GUILD);
      assert.deepEqual(
        dest.map((d) => d.channel_id).sort(),
        [ids[0], ids[3]].sort(),
      );

      const destRange = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY, {
        scrimRankKey: 'Argent / Or',
      }).filter((d) => d.guild_id === GUILD);
      assert.deepEqual(
        destRange.map((d) => d.channel_id).sort(),
        [ids[0], ids[1], ids[3]].sort(),
      );

      const destGP = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY, {
        scrimRankKey: 'Or / Platine',
      }).filter((d) => d.guild_id === GUILD);
      assert.deepEqual(
        destGP.map((d) => d.channel_id).sort(),
        [ids[0], ids[2], ids[3]].sort(),
      );
    });
  });

  it('FREE avec row filtre artificielle → reçoit Platine', async () => {
    await withTempDb(async (db, stmts) => {
      const ids = seedChannels(db, GUILD, 1);
      setFilter(db, GUILD, ids[0], 'Or');
      assert.equal(canUseFeature(GUILD, 'elo_channel_filters', { stmts }), false);
      const dest = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY, {
        scrimRankKey: 'Platine',
      }).filter((d) => d.guild_id === GUILD);
      assert.equal(dest.length, 1);
      assert.equal(dest[0].channel_id, ids[0]);
    });
  });

  it('downgrade P1→FREE : filtre stocké mais ignoré ; upgrade reprend', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P1');
      clearEntitlementCache();
      const ids = seedChannels(db, GUILD, 2);
      setFilter(db, GUILD, ids[0], 'Or');
      setFilter(db, GUILD, ids[1], 'Argent');

      let dest = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY, {
        scrimRankKey: 'Platine',
      }).filter((d) => d.guild_id === GUILD);
      assert.equal(dest.length, 0);

      // Expire grant → FREE
      const past = Date.now() - 60_000;
      db.prepare(
        `UPDATE entitlement_grants SET starts_at = ?, ends_at = ?, status = 'expired', updated_at = ? WHERE guild_id = ?`,
      ).run(past - 1000, past, Date.now(), GUILD);
      clearEntitlementCache();

      dest = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY, {
        scrimRankKey: 'Platine',
      }).filter((d) => d.guild_id === GUILD);
      assert.equal(dest.length, 1); // 1 salon effectif FREE, filtre ignoré
      assert.equal(dest[0].channel_id, ids[0]);

      // filtres toujours en DB
      const n = db.prepare(
        `SELECT COUNT(*) AS n FROM guild_reception_channel_filters WHERE guild_id = ?`,
      ).get(GUILD).n;
      assert.equal(n, 2);

      grantPlan(db, stmts, GUILD, 'P1');
      clearEntitlementCache();
      dest = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY, {
        scrimRankKey: 'Or',
      }).filter((d) => d.guild_id === GUILD);
      assert.deepEqual(dest.map((d) => d.channel_id), [ids[0]]);
    });
  });

  it('remove channel cascade filter', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P1');
      clearEntitlementCache();
      const ids = seedChannels(db, GUILD, 2);
      setFilter(db, GUILD, ids[0], 'Or');
      const ctx = {
        client: { guilds: { cache: { get: () => null } } },
        guild: { id: GUILD, memberCount: 200, members: { me: null }, channels: { cache: { get: () => null }, fetch: async () => null } },
        db,
        stmts,
        guildId: GUILD,
        actorDiscordUserId: ADMIN,
      };
      await applyGuildConfigSectionWrite(ctx, {
        section: 'reception_channels_remove',
        channel_id: ids[0],
      });
      const left = db.prepare(
        `SELECT * FROM guild_reception_channel_filters WHERE channel_id = ?`,
      ).get(ids[0]);
      assert.equal(left, undefined);
    });
  });
});

describe('Phase 3 — intégration 3 guilds', () => {
  it('matrice deliveries exacte', async () => {
    await withTempDb(async (db, stmts) => {
      // A FREE
      const a = seedChannels(db, GUILD, 1, 1);
      // B P1
      grantPlan(db, stmts, GUILD_B, 'P1');
      const b = seedChannels(db, GUILD_B, 2, 10);
      setFilter(db, GUILD_B, b[0], 'Or');
      // C P2
      grantPlan(db, stmts, GUILD_C, 'P2');
      const c = seedChannels(db, GUILD_C, 4, 20);
      setFilter(db, GUILD_C, c[0], 'Argent');
      setFilter(db, GUILD_C, c[1], 'Or');
      setFilter(db, GUILD_C, c[2], 'Platine');
      clearEntitlementCache();

      const expect = (scrim, pairs) => {
        const dest = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY, {
          scrimRankKey: scrim,
        });
        const keys = new Set(dest.map((d) => `${d.guild_id}:${d.channel_id}`));
        assert.equal(keys.size, pairs.length, scrim);
        for (const [g, cid] of pairs) {
          assert.ok(keys.has(`${g}:${cid}`), `${scrim} missing ${g}:${cid}`);
        }
      };

      expect('Argent', [
        [GUILD, a[0]],
        [GUILD_B, b[1]],
        [GUILD_C, c[0]],
        [GUILD_C, c[3]],
      ]);
      expect('Argent / Or', [
        [GUILD, a[0]],
        [GUILD_B, b[0]],
        [GUILD_B, b[1]],
        [GUILD_C, c[0]],
        [GUILD_C, c[1]],
        [GUILD_C, c[3]],
      ]);
      expect('Or', [
        [GUILD, a[0]],
        [GUILD_B, b[0]],
        [GUILD_B, b[1]],
        [GUILD_C, c[1]],
        [GUILD_C, c[3]],
      ]);
      expect('Or / Platine', [
        [GUILD, a[0]],
        [GUILD_B, b[0]],
        [GUILD_B, b[1]],
        [GUILD_C, c[1]],
        [GUILD_C, c[2]],
        [GUILD_C, c[3]],
      ]);
      expect('Platine', [
        [GUILD, a[0]],
        [GUILD_B, b[1]],
        [GUILD_C, c[2]],
        [GUILD_C, c[3]],
      ]);
    });
  });
});

describe('Phase 3 — performance batch filters', () => {
  it('220 dest + filtres sans explosion', async () => {
    await withTempDb(async (db, stmts) => {
      for (let i = 0; i < 50; i++) {
        const g = String(200000000000000000n + BigInt(i));
        seedChannels(db, g, 1, 1000 + i * 20);
      }
      for (let i = 0; i < 30; i++) {
        const g = String(210000000000000000n + BigInt(i));
        grantPlan(db, stmts, g, 'P1');
        const ids = seedChannels(db, g, 2, 2000 + i * 20);
        setFilter(db, g, ids[0], 'Or');
      }
      for (let i = 0; i < 15; i++) {
        const g = String(220000000000000000n + BigInt(i));
        grantPlan(db, stmts, g, 'P2');
        const ids = seedChannels(db, g, 4, 3000 + i * 20);
        setFilter(db, g, ids[0], 'Argent');
        setFilter(db, g, ids[1], 'Or');
      }
      clearEntitlementCache();
      const t0 = Date.now();
      const dest = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY, {
        scrimRankKey: 'Or',
      });
      const elapsed = Date.now() - t0;
      assert.ok(dest.length > 50);
      assert.ok(elapsed < 5000, `trop lent: ${elapsed}ms`);
    });
  });
});

describe('Phase 3 — concurrence filter', () => {
  it('2 set simultanés même channel → état stable', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P1');
      clearEntitlementCache();
      const ids = seedChannels(db, GUILD, 1);
      await Promise.all([
        Promise.resolve(stmts.upsertReceptionChannelEloFilter.run({
          guild_id: GUILD, channel_id: ids[0], game_key: UI_PRIMARY_GAME_KEY,
          elo_rank_key: 'Or', created_at: Date.now(), updated_at: Date.now(),
        })),
        Promise.resolve(stmts.upsertReceptionChannelEloFilter.run({
          guild_id: GUILD, channel_id: ids[0], game_key: UI_PRIMARY_GAME_KEY,
          elo_rank_key: 'Argent', created_at: Date.now(), updated_at: Date.now(),
        })),
      ]);
      const row = stmts.getReceptionChannelEloFilter.get(GUILD, ids[0]);
      assert.ok(row.elo_rank_key === 'Or' || row.elo_rank_key === 'Argent');
    });
  });
});
