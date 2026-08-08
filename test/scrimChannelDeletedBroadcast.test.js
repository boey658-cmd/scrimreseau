/**
 * Correctifs : Discord 10003 (salon supprimé), finalisation batch bloqué,
 * retrait admin par snowflake.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { parseDiscordSnowflakeId } from '../src/commands/scrimChannel.js';
import {
  deliverScrimToDestination,
  mapDiscordTerminalErrorCode,
} from '../src/services/scrimDelivery.js';
import {
  runScrimBroadcastDeliveryPass,
  tryFinalizeScrimBroadcastBatch,
} from '../src/services/scrimBroadcastDeliveryJob.js';
import {
  startDiscordTaskQueue,
  stopDiscordTaskQueue,
} from '../src/services/discordTaskQueue.js';
import { removeScrimReceptionDestination } from '../src/services/scrimDestinationCleanup.js';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-chdel-'));
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

const SCRIM_PAYLOAD = {
  gameKey: 'league_of_legends',
  rank: 'Platine',
  dateStr: '08/08/2026',
  timeStr: '20:00',
  format: 'BO1',
  fearless: 'non',
  contactUserId: 'user-001',
  contactDisplayName: 'Tester',
};

function insertScrim(stmts) {
  const info = stmts.insertScrimPostRow.run({
    scrim_public_id: 501,
    author_user_id: 'user-001',
    origin_guild_id: 'guild-001',
    source_guild_id: 'guild-001',
    game_key: 'league_of_legends',
    rank_key: 'Platine',
    format_key: 'BO1',
    contact_user_id: 'user-001',
    contact_display_name: 'Tester',
    scheduled_date: '08/08/2026',
    scheduled_time: '20:00',
    scheduled_at: new Date(Date.now() + 7200000).toISOString(),
    scheduled_at_end: null,
    tags: JSON.stringify({ fearless: 'non' }),
    multi_opgg_url: null,
    elo_precision: null,
    created_at: Date.now(),
    status: 'active',
    structure_guild_id: null,
    structure_name_snapshot: null,
    structure_invite_url_snapshot: null,
  });
  return Number(info.lastInsertRowid);
}

function insertActiveBatchWithDeliveries(stmts, scrimId, deliveries) {
  const now = new Date().toISOString();
  const b = stmts.insertScrimBroadcastBatch.run({
    scrim_post_db_id: scrimId,
    operation_type: 'initial',
    generation: 0,
    target_count: deliveries.length,
    created_at: now,
    updated_at: now,
  });
  const batchId = Number(b.lastInsertRowid);
  stmts.setScrimBroadcastBatchActive.run({
    id: batchId,
    started_at: now,
    updated_at: now,
  });
  for (const d of deliveries) {
    stmts.insertScrimBroadcastDelivery.run({
      batch_id: batchId,
      scrim_post_db_id: scrimId,
      guild_id: d.guild_id,
      channel_id: d.channel_id,
      game_key: 'league_of_legends',
      operation_type: 'initial',
      generation: 0,
      priority: 0,
      next_attempt_at: now,
      created_at: now,
      updated_at: now,
    });
  }
  return batchId;
}

describe('mapDiscordTerminalErrorCode', () => {
  it('mappe 10003 / 50013 / 50001', () => {
    assert.equal(mapDiscordTerminalErrorCode(10003), 'UNKNOWN_CHANNEL');
    assert.equal(mapDiscordTerminalErrorCode(RESTJSONErrorCodes.UnknownChannel), 'UNKNOWN_CHANNEL');
    assert.equal(mapDiscordTerminalErrorCode(50013), 'MISSING_PERMISSIONS');
    assert.equal(mapDiscordTerminalErrorCode(50001), 'MISSING_ACCESS');
    assert.equal(mapDiscordTerminalErrorCode('50013'), 'MISSING_PERMISSIONS');
  });
});

describe('parseDiscordSnowflakeId', () => {
  it('accepte un snowflake valide', () => {
    assert.equal(parseDiscordSnowflakeId('1533896295339655359'), '1533896295339655359');
  });
  it('refuse les valeurs invalides', () => {
    assert.equal(parseDiscordSnowflakeId('abc'), null);
    assert.equal(parseDiscordSnowflakeId('123'), null);
    assert.equal(parseDiscordSnowflakeId(''), null);
  });
});

describe('/scrim-channel — enregistrement dev-only', () => {
  it('absente de commandListWithoutDev, présente dans commandList', async () => {
    const { commandList, commandListWithoutDev } = await import('../src/commands/index.js');
    const publicNames = commandListWithoutDev.map((c) => c.data.name);
    const allNames = commandList.map((c) => c.data.name);
    assert.ok(!publicNames.includes('scrim-channel'));
    assert.ok(allNames.includes('scrim-channel'));
  });

  it('deploy-commands place scrim-channel dans le payload dev uniquement', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(
      new URL('../scripts/deploy-commands.js', import.meta.url),
      'utf8',
    );
    assert.match(source, /scrimChannel\.data\.toJSON\(\)/);
    assert.match(source, /const devOnlyBody = \[/);
    // Ne doit pas être mappé depuis commandListWithoutDev
    const publicMapLine = source.slice(
      source.indexOf('const publicBody'),
      source.indexOf('const devOnlyBody'),
    );
    assert.doesNotMatch(publicMapLine, /scrimChannel/);
  });
});

describe('Discord 10003 — salon supprimé', () => {
  before(() => startDiscordTaskQueue());
  after(async () => stopDiscordTaskQueue());

  it('fetch_channel 10003 → UNKNOWN_CHANNEL + destination retirée (pas PERMISSIONS)', async () => {
    await withTempDb(async (db, stmts) => {
      stmts.upsertGuildChannel.run({
        guild_id: 'guild-001',
        channel_id: '1533896295339655359',
        game_key: 'league_of_legends',
        created_at: Date.now(),
      });

      const unknownErr = Object.assign(new Error('Unknown Channel'), {
        code: RESTJSONErrorCodes.UnknownChannel,
      });
      const guild = {
        id: 'guild-001',
        channels: {
          cache: new Map(),
          fetch: async () => {
            throw unknownErr;
          },
        },
        members: {
          me: { id: 'bot' },
          fetchMe: async () => ({ id: 'bot' }),
        },
      };
      const client = {
        guilds: {
          cache: new Map([['guild-001', guild]]),
          fetch: async () => guild,
        },
      };

      const result = await deliverScrimToDestination({
        client,
        stmts,
        row: { guild_id: 'guild-001', channel_id: '1533896295339655359' },
        authorUserId: 'user-001',
        payload: SCRIM_PAYLOAD,
        delayMs: 0,
      });

      assert.equal(result.outcome, 'terminal_error');
      assert.equal(result.errorCode, 'UNKNOWN_CHANNEL');
      assert.notEqual(result.errorCode, 'PERMISSIONS');
      assert.equal(result.terminal, true);

      const still = stmts.getGuildGameChannelByChannelId.get(
        'guild-001',
        '1533896295339655359',
      );
      assert.equal(still, undefined, 'destination doit être retirée de guild_game_channels');
    });
  });

  it('50013 sur send reste MISSING_PERMISSIONS (distinct de 10003)', async () => {
    await withTempDb(async (db, stmts) => {
      const perms = new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ]);
      const channel = {
        id: 'chan-ok',
        type: ChannelType.GuildText,
        permissionsFor: () => perms,
        send: async () => {
          throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
        },
      };
      const guild = {
        id: 'guild-001',
        channels: {
          cache: new Map([['chan-ok', channel]]),
          fetch: async (id) => (id === 'chan-ok' ? channel : null),
        },
        members: {
          me: { id: 'bot' },
          fetchMe: async () => ({ id: 'bot' }),
        },
      };
      const client = {
        guilds: {
          cache: new Map([['guild-001', guild]]),
          fetch: async () => guild,
        },
      };

      const result = await deliverScrimToDestination({
        client,
        stmts,
        row: { guild_id: 'guild-001', channel_id: 'chan-ok' },
        authorUserId: 'user-001',
        payload: SCRIM_PAYLOAD,
        delayMs: 0,
      });

      assert.equal(result.outcome, 'terminal_error');
      assert.equal(result.errorCode, 'MISSING_PERMISSIONS');
    });
  });
});

describe('Finalisation batch bloqué (dispatched:0)', () => {
  before(() => startDiscordTaskQueue());
  after(async () => stopDiscordTaskQueue());

  it('batch active avec toutes deliveries failed_terminal → completed sans dispatch', async () => {
    await withTempDb(async (db, stmts) => {
      const scrimId = insertScrim(stmts);
      const batchId = insertActiveBatchWithDeliveries(stmts, scrimId, [
        { guild_id: 'guild-001', channel_id: 'chan-dead' },
      ]);
      const now = new Date().toISOString();
      const deliv = stmts.listDeliveriesForBatch.all(batchId)[0];
      stmts.markDeliveryTerminal.run({
        id: deliv.id,
        last_error_code: 'UNKNOWN_CHANNEL',
        last_error_message: 'Salon introuvable.',
        completed_at: now,
        updated_at: now,
      });

      const client = {
        guilds: { cache: new Map(), fetch: async () => null },
      };

      const pass = await runScrimBroadcastDeliveryPass(client, db, stmts);
      assert.equal(pass.dispatched, 0);

      const batch = stmts.getScrimBroadcastBatchById.get(batchId);
      assert.equal(batch.status, 'completed', 'batch doit être finalisé');
    });
  });

  it('batch mixte : sent + 10003 → batch completed', async () => {
    await withTempDb(async (db, stmts) => {
      const scrimId = insertScrim(stmts);
      const batchId = insertActiveBatchWithDeliveries(stmts, scrimId, [
        { guild_id: 'guild-ok', channel_id: 'chan-ok' },
        { guild_id: 'guild-dead', channel_id: 'chan-dead' },
      ]);

      const perms = new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ]);
      const okChannel = {
        id: 'chan-ok',
        type: ChannelType.GuildText,
        permissionsFor: () => perms,
        send: async () => ({
          id: 'msg-ok',
          guildId: 'guild-ok',
          channelId: 'chan-ok',
          delete: async () => {},
        }),
      };
      const okGuild = {
        id: 'guild-ok',
        channels: {
          cache: new Map([['chan-ok', okChannel]]),
          fetch: async () => okChannel,
        },
        members: { me: { id: 'bot' }, fetchMe: async () => ({ id: 'bot' }) },
      };
      const deadGuild = {
        id: 'guild-dead',
        channels: {
          cache: new Map(),
          fetch: async () => {
            throw Object.assign(new Error('Unknown Channel'), {
              code: RESTJSONErrorCodes.UnknownChannel,
            });
          },
        },
        members: { me: { id: 'bot' }, fetchMe: async () => ({ id: 'bot' }) },
      };
      const client = {
        guilds: {
          cache: new Map([
            ['guild-ok', okGuild],
            ['guild-dead', deadGuild],
          ]),
          fetch: async (id) => client.guilds.cache.get(id) ?? null,
        },
      };

      stmts.upsertGuildChannel.run({
        guild_id: 'guild-dead',
        channel_id: 'chan-dead',
        game_key: 'league_of_legends',
        created_at: Date.now(),
      });

      // Deux passes : une delivery par passe
      await runScrimBroadcastDeliveryPass(client, db, stmts);
      await runScrimBroadcastDeliveryPass(client, db, stmts);

      const statuses = stmts
        .listDeliveriesForBatch.all(batchId)
        .map((d) => d.status)
        .sort();
      assert.deepEqual(statuses, ['failed_terminal', 'sent']);

      const batch = stmts.getScrimBroadcastBatchById.get(batchId);
      assert.equal(batch.status, 'completed');

      const dest = stmts.getGuildGameChannelByChannelId.get('guild-dead', 'chan-dead');
      assert.equal(dest, undefined);
    });
  });

  it('tryFinalizeScrimBroadcastBatch est no-op s’il reste du pending', async () => {
    await withTempDb(async (db, stmts) => {
      const scrimId = insertScrim(stmts);
      const batchId = insertActiveBatchWithDeliveries(stmts, scrimId, [
        { guild_id: 'g', channel_id: 'c' },
      ]);
      assert.equal(tryFinalizeScrimBroadcastBatch(stmts, batchId), false);
      assert.equal(stmts.getScrimBroadcastBatchById.get(batchId).status, 'active');
    });
  });

  it('CRITIQUE — retry avec next_attempt_at futur : batch reste active (pas de finalisation)', async () => {
    await withTempDb(async (db, stmts) => {
      const scrimId = insertScrim(stmts);
      const batchId = insertActiveBatchWithDeliveries(stmts, scrimId, [
        { guild_id: 'guild-ok', channel_id: 'chan-ok' },
        { guild_id: 'guild-retry', channel_id: 'chan-retry' },
      ]);
      const now = new Date().toISOString();
      const deliveries = stmts.listDeliveriesForBatch.all(batchId);
      // Première : déjà sent
      stmts.markDeliverySent.run({
        id: deliveries[0].id,
        message_id: 'msg-already-sent',
        completed_at: now,
        updated_at: now,
      });
      // Seconde : retry dans 10 minutes (pas due)
      const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      stmts.markDeliveryRetry.run({
        id: deliveries[1].id,
        next_attempt_at: future,
        last_error_code: 'RATE_LIMIT',
        last_error_message: 'retry later',
        updated_at: now,
      });

      const client = {
        guilds: { cache: new Map(), fetch: async () => null },
      };

      const pass = await runScrimBroadcastDeliveryPass(client, db, stmts);
      assert.equal(pass.dispatched, 0, 'aucune delivery due maintenant');

      const batch = stmts.getScrimBroadcastBatchById.get(batchId);
      assert.equal(
        batch.status,
        'active',
        'un retry futur ne doit PAS finaliser le batch',
      );
      assert.equal(tryFinalizeScrimBroadcastBatch(stmts, batchId), false);
    });
  });

  it('processing récent (non stale) : batch non finalisé', async () => {
    await withTempDb(async (db, stmts) => {
      const scrimId = insertScrim(stmts);
      const batchId = insertActiveBatchWithDeliveries(stmts, scrimId, [
        { guild_id: 'g', channel_id: 'c' },
      ]);
      const now = new Date().toISOString();
      const d = stmts.listDeliveriesForBatch.all(batchId)[0];
      // Simule un claim récent sans passer par le worker
      db.prepare(`
        UPDATE scrim_broadcast_deliveries
        SET status = 'processing', claimed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now, now, d.id);

      assert.equal(tryFinalizeScrimBroadcastBatch(stmts, batchId), false);
      assert.equal(stmts.getScrimBroadcastBatchById.get(batchId).status, 'active');

      const client = {
        guilds: { cache: new Map(), fetch: async () => null },
      };
      const pass = await runScrimBroadcastDeliveryPass(client, db, stmts);
      assert.equal(pass.dispatched, 0);
      assert.equal(
        stmts.getScrimBroadcastBatchById.get(batchId).status,
        'active',
        'processing récent ne doit pas être marqué stale ni finaliser le batch',
      );
      assert.equal(
        stmts.listDeliveriesForBatch.all(batchId)[0].status,
        'processing',
      );
    });
  });
});

describe('removeScrimReceptionDestination / admin cleanup', () => {
  it('supprime uniquement la ligne guild+channel demandée', async () => {
    await withTempDb(async (db, stmts) => {
      stmts.upsertGuildChannel.run({
        guild_id: 'guild-A',
        channel_id: '111111111111111111',
        game_key: 'league_of_legends',
        created_at: Date.now(),
      });
      stmts.upsertGuildChannel.run({
        guild_id: 'guild-B',
        channel_id: '222222222222222222',
        game_key: 'league_of_legends',
        created_at: Date.now(),
      });

      const removed = removeScrimReceptionDestination(
        stmts,
        'guild-A',
        '111111111111111111',
        'ADMIN_REMOVE',
      );
      assert.equal(removed, true);
      assert.equal(
        stmts.getGuildGameChannelByChannelId.get('guild-A', '111111111111111111'),
        undefined,
      );
      assert.ok(
        stmts.getGuildGameChannelByChannelId.get('guild-B', '222222222222222222'),
        'autre guilde intacte',
      );
    });
  });

  it('retourne false si entrée absente (pas d’erreur)', async () => {
    await withTempDb(async (db, stmts) => {
      const removed = removeScrimReceptionDestination(
        stmts,
        'guild-A',
        '999999999999999999',
        'ADMIN_REMOVE',
      );
      assert.equal(removed, false);
    });
  });

  it('refuse guild_id / channel_id vides ou non-string (pas de DELETE large)', async () => {
    await withTempDb(async (db, stmts) => {
      stmts.upsertGuildChannel.run({
        guild_id: 'guild-A',
        channel_id: '111111111111111111',
        game_key: 'league_of_legends',
        created_at: Date.now(),
      });
      assert.equal(removeScrimReceptionDestination(stmts, '', '111111111111111111', 'x'), false);
      assert.equal(removeScrimReceptionDestination(stmts, 'guild-A', '', 'x'), false);
      assert.equal(removeScrimReceptionDestination(stmts, null, '111111111111111111', 'x'), false);
      assert.ok(stmts.getGuildGameChannelByChannelId.get('guild-A', '111111111111111111'));
    });
  });
});
