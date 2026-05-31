import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import test from 'node:test';
import {
  closeDb,
  getDb,
  preparePlayerSearchStatements,
} from '../src/database/db.js';
import {
  buildPlayerSearchClosedMessageEditOptions,
} from '../src/services/playerSearchEmbedBuilder.js';
import {
  closePlayerSearchPostByDbId,
  findExpiredActivePlayerSearchCandidates,
} from '../src/services/playerSearchLifecycle.js';
import {
  computePlayerSearchExpirationAtIso,
  isPlayerSearchExpired,
  PLAYER_SEARCH_EXPIRATION_GRACE_HOURS,
} from '../src/utils/playerSearchExpiration.js';
import { computeScheduledAtIso, SCRIM_TIMEZONE } from '../src/utils/scrimScheduledAt.js';

/**
 * @param {() => void | Promise<void>} fn
 */
async function withTempDbAsync(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-search-exp-'));
  const prev = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  try {
    const db = getDb();
    const playerSearchStmts = preparePlayerSearchStatements(db);
    await fn({ db, playerSearchStmts });
  } finally {
    closeDb();
    if (prev === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {ReturnType<typeof preparePlayerSearchStatements>} playerSearchStmts
 * @param {Partial<{
 *   player_search_public_id: string,
 *   author_user_id: string,
 *   scheduled_at: string,
 *   status: string,
 * }>} [overrides]
 */
function insertPost(playerSearchStmts, overrides = {}) {
  playerSearchStmts.insertPlayerSearchPostRow.run({
    player_search_public_id: overrides.player_search_public_id ?? 'J1',
    author_user_id: overrides.author_user_id ?? 'author-1',
    origin_guild_id: 'g1',
    source_guild_id: 'g1',
    roles_json: JSON.stringify(['top', 'adc']),
    ranks_json: JSON.stringify(['Iron / Bronze']),
    player_count: 2,
    session_type: 'Scrim BO3',
    ambiance: 'Chill',
    description: null,
    contact_user_id: 'author-1',
    scheduled_date: '30/05/2026',
    scheduled_time: '21h',
    scheduled_at: overrides.scheduled_at ?? '2026-05-30T19:00:00.000Z',
    scheduled_at_end: null,
    tags_json: '{}',
    created_at: Date.now(),
    status: overrides.status ?? 'active',
  });
}

test('PLAYER_SEARCH_EXPIRATION_GRACE_HOURS — marge 3 h', () => {
  assert.equal(PLAYER_SEARCH_EXPIRATION_GRACE_HOURS, 3);
});

test('computePlayerSearchExpirationAtIso — 21h Paris + 3h = 00h lendemain', () => {
  const scheduledAt = computeScheduledAtIso('30/05/2026', '21:00', Date.now());
  const expiresAt = computePlayerSearchExpirationAtIso(scheduledAt);
  const paris = DateTime.fromISO(expiresAt, { zone: SCRIM_TIMEZONE });
  assert.equal(paris.day, 31);
  assert.equal(paris.hour, 0);
  assert.equal(paris.minute, 0);
});

test('computePlayerSearchExpirationAtIso — demain 20h30 + 3h = 23h30', () => {
  const scheduledAt = computeScheduledAtIso('31/05/2026', '20:30', Date.now());
  const expiresAt = computePlayerSearchExpirationAtIso(scheduledAt);
  const paris = DateTime.fromISO(expiresAt, { zone: SCRIM_TIMEZONE });
  assert.equal(paris.day, 31);
  assert.equal(paris.hour, 23);
  assert.equal(paris.minute, 30);
});

test('isPlayerSearchExpired — non expirée avant +3h', () => {
  const scheduledAt = computeScheduledAtIso('30/05/2026', '21:00', Date.now());
  const base = DateTime.fromISO(scheduledAt, { zone: 'utc' });
  assert.equal(
    isPlayerSearchExpired(
      { scheduled_at: scheduledAt },
      base.plus({ hours: 2, minutes: 59 }).toUTC().toISO(),
    ),
    false,
  );
});

test('isPlayerSearchExpired — expirée à +3h01', () => {
  const scheduledAt = computeScheduledAtIso('30/05/2026', '21:00', Date.now());
  const base = DateTime.fromISO(scheduledAt, { zone: 'utc' });
  assert.equal(
    isPlayerSearchExpired(
      { scheduled_at: scheduledAt },
      base.plus({ hours: 3, minutes: 1 }).toUTC().toISO(),
    ),
    true,
  );
});

test('isPlayerSearchExpired — expirée exactement à +3h', () => {
  const scheduledAt = computeScheduledAtIso('30/05/2026', '21:00', Date.now());
  const expiresAt = computePlayerSearchExpirationAtIso(scheduledAt);
  assert.equal(isPlayerSearchExpired({ scheduled_at: scheduledAt }, expiresAt), true);
});

test('findExpiredActivePlayerSearchCandidates — active non expirée ignorée', async () => {
  await withTempDbAsync(async ({ playerSearchStmts }) => {
    const future = DateTime.now().plus({ days: 2 }).toUTC().toISO();
    insertPost(playerSearchStmts, {
      player_search_public_id: 'J1',
      scheduled_at: future,
    });
    const candidates = findExpiredActivePlayerSearchCandidates(
      playerSearchStmts,
      new Date().toISOString(),
    );
    assert.equal(candidates.length, 0);
  });
});

test('findExpiredActivePlayerSearchCandidates — active expirée détectée', async () => {
  await withTempDbAsync(async ({ playerSearchStmts }) => {
    const scheduledAt = computeScheduledAtIso('30/05/2026', '21:00', Date.now());
    insertPost(playerSearchStmts, {
      player_search_public_id: 'J9',
      scheduled_at: scheduledAt,
    });
    const nowIso = DateTime.fromISO(scheduledAt, { zone: 'utc' })
      .plus({ hours: 4 })
      .toUTC()
      .toISO();
    const candidates = findExpiredActivePlayerSearchCandidates(
      playerSearchStmts,
      nowIso,
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].publicId, 'J9');
  });
});

test('closePlayerSearchPostByDbId — active → closed_expired', async () => {
  await withTempDbAsync(async ({ db, playerSearchStmts }) => {
    insertPost(playerSearchStmts, { player_search_public_id: 'J2' });
    const row = playerSearchStmts.getPlayerSearchPostByPublicIdAny.get('J2');
    const closed = closePlayerSearchPostByDbId(
      db,
      playerSearchStmts,
      Number(row.id),
      'closed_expired',
      'expired',
    );
    assert.equal(closed, true);
    const updated = playerSearchStmts.getPlayerSearchPostById.get(row.id);
    assert.equal(updated.status, 'closed_expired');
    assert.equal(updated.closed_reason, 'expired');
  });
});

test('listActivePlayerSearchPostsByAuthor — ignore expirées fermées', async () => {
  await withTempDbAsync(async ({ db, playerSearchStmts }) => {
    insertPost(playerSearchStmts, {
      player_search_public_id: 'J3',
      author_user_id: 'user-a',
    });
    const row = playerSearchStmts.getPlayerSearchPostByPublicIdAny.get('J3');
    closePlayerSearchPostByDbId(
      db,
      playerSearchStmts,
      Number(row.id),
      'closed_expired',
      'expired',
    );
    const active = playerSearchStmts.listActivePlayerSearchPostsByAuthor.all(
      'user-a',
    );
    assert.equal(active.length, 0);
  });
});

test('embed expiré — titre, passé et contact', () => {
  const options = buildPlayerSearchClosedMessageEditOptions('closed_expired', {
    roles_json: JSON.stringify(['top', 'adc']),
    ranks_json: JSON.stringify(['Iron / Bronze']),
    player_count: 2,
    session_type: 'Scrim BO3',
    ambiance: 'Chill',
    contact_user_id: '99',
    scheduled_date: '30/05/2026',
    scheduled_time: '21h',
    scheduled_at: '2026-05-30T19:00:00.000Z',
    scheduled_at_end: null,
  });
  const embed = options.embeds[0].toJSON();
  assert.equal(String(embed.title), '⚫ Recherche expirée');
  const desc = String(embed.description);
  assert.match(desc, /Nous cherchions 2 joueurs Top \/ ADC/);
  assert.match(desc, /🎯 Chill/);
  assert.match(desc, /👤 <@99>/);
  assert.doesNotMatch(desc, /Nous cherchons/);
  assert.doesNotMatch(desc, /⚫ Recherche expirée/);
  assert.equal(embed.color, 0x4f545c);
});

test('playerSearchExpirationJob — module séparé des scrims', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const jobPath = path.join(
    __dirname,
    '..',
    'src',
    'jobs',
    'playerSearchExpirationJob.js',
  );
  const source = fs.readFileSync(jobPath, 'utf8');
  assert.doesNotMatch(source, /runScrimExpirationPass/);
  assert.doesNotMatch(source, /scrimExpirationJob/);
  assert.match(source, /runPlayerSearchExpirationPass/);
  assert.match(source, /player_search_expiration_job start/);
});
