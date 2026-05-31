import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import test from 'node:test';
import {
  buildPlayerSearchMainPhrase,
  collectPlayerSearchRolesFromSlashValues,
  formatPlayerSearchActiveSummaryLine,
  formatPlayerSearchDatePhrase,
  parsePlayerSearchDate,
  parsePlayerSearchHoraire,
  parsePlayerSearchRoles,
  resolvePlayerSearchRankFromSlashValue,
  validatePlayerSearchRoleCountMatch,
} from '../src/utils/playerSearchValidation.js';
import { SCRIM_TIMEZONE } from '../src/utils/scrimScheduledAt.js';
import { normalizePlayerSearchPublicId } from '../src/services/playerSearchPublicId.js';
import {
  closePlayerSearchPostByDbId,
  closePlayerSearchPostByPublicIdForAuthor,
} from '../src/services/playerSearchLifecycle.js';
import {
  closeDb,
  getDb,
  preparePlayerSearchStatements,
} from '../src/database/db.js';
import { allocatePlayerSearchPublicId } from '../src/services/playerSearchPublicId.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REF_PARIS = DateTime.fromObject(
  { year: 2026, month: 5, day: 30, hour: 12 },
  { zone: SCRIM_TIMEZONE },
);

test('parsePlayerSearchDate — aujourd\'hui et aujourdhui', () => {
  for (const raw of ["aujourd'hui", 'aujourdhui', 'AUJOURD\'HUI']) {
    const res = parsePlayerSearchDate(raw, { referenceDateTime: REF_PARIS });
    assert.equal(res.ok, true, raw);
    if (!res.ok) return;
    assert.equal(res.value, '30/05/2026');
  }
});

test('parsePlayerSearchDate — demain', () => {
  const res = parsePlayerSearchDate('demain', { referenceDateTime: REF_PARIS });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value, '31/05/2026');
});

test('parsePlayerSearchDate — date future JJ/MM', () => {
  const res = parsePlayerSearchDate('15/06', { referenceDateTime: REF_PARIS });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value, '15/06/2026');
});

test('parsePlayerSearchDate — date passée refusée', () => {
  const res = parsePlayerSearchDate('29/05/2026', {
    referenceDateTime: REF_PARIS,
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /antérieure à aujourd'hui/i);
});

test('parsePlayerSearchDate — date +45 jours acceptée', () => {
  const res = parsePlayerSearchDate('14/07/2026', {
    referenceDateTime: REF_PARIS,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value, '14/07/2026');
});

test('parsePlayerSearchDate — date +46 jours refusée', () => {
  const res = parsePlayerSearchDate('15/07/2026', {
    referenceDateTime: REF_PARIS,
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /45 prochains jours/i);
});

test('formatPlayerSearchDatePhrase — aujourd\'hui', () => {
  const dt = REF_PARIS.startOf('day');
  assert.equal(
    formatPlayerSearchDatePhrase(dt, { referenceDateTime: REF_PARIS }),
    "aujourd'hui",
  );
});

test('formatPlayerSearchDatePhrase — demain', () => {
  const dt = REF_PARIS.plus({ days: 1 }).startOf('day');
  assert.equal(
    formatPlayerSearchDatePhrase(dt, { referenceDateTime: REF_PARIS }),
    'demain',
  );
});

test('formatPlayerSearchDatePhrase — le jeudi 04/07', () => {
  const dt = DateTime.fromObject(
    { year: 2024, month: 7, day: 4 },
    { zone: SCRIM_TIMEZONE },
  ).startOf('day');
  assert.equal(
    formatPlayerSearchDatePhrase(dt, { referenceDateTime: REF_PARIS }),
    'le jeudi 04/07',
  );
});

test('collectPlayerSearchRolesFromSlashValues — role_1 et role_2', () => {
  const res = collectPlayerSearchRolesFromSlashValues(['adc', 'support', null]);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.value, ['adc', 'support']);
});

test('resolvePlayerSearchRankFromSlashValue — Gold / Plat', () => {
  const res = resolvePlayerSearchRankFromSlashValue('gold_plat');
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.label, 'Gold / Plat');
  assert.deepEqual(res.value, ['Gold / Plat']);
});

test('resolvePlayerSearchRankFromSlashValue — Emerald / Diamond', () => {
  const res = resolvePlayerSearchRankFromSlashValue('emerald_diamond');
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.label, 'Emerald / Diamond');
  assert.deepEqual(res.value, ['Emerald / Diamond']);
});

test('resolvePlayerSearchRankFromSlashValue — rejette valeur inconnue', () => {
  const res = resolvePlayerSearchRankFromSlashValue('challenger');
  assert.equal(res.ok, false);
});

test('resolvePlayerSearchRankFromSlashValue — Iron / Bronze', () => {
  const res = resolvePlayerSearchRankFromSlashValue('iron_bronze');
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.label, 'Iron / Bronze');
});

test('validatePlayerSearchRoleCountMatch — cohérent et incohérent', () => {
  assert.equal(validatePlayerSearchRoleCountMatch(2, 2).ok, true);
  assert.equal(validatePlayerSearchRoleCountMatch(2, 1).ok, false);
  assert.equal(validatePlayerSearchRoleCountMatch(3, 2).ok, false);
});

test('parsePlayerSearchRoles — adc/support (legacy parsing)', () => {
  const res = parsePlayerSearchRoles('adc/support');
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.value, ['adc', 'support']);
  assert.deepEqual(res.labels, ['ADC', 'Support']);
});

test('parsePlayerSearchRoles — ADC Support', () => {
  const res = parsePlayerSearchRoles('ADC Support');
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.value, ['adc', 'support']);
});

test('parsePlayerSearchHoraire — 21h et 21h-23h', () => {
  const fixed = parsePlayerSearchHoraire('21h');
  assert.equal(fixed.ok, true);
  if (fixed.ok) assert.equal(fixed.displayTime, '21h');

  const range = parsePlayerSearchHoraire('21h-23h');
  assert.equal(range.ok, true);
  if (range.ok) assert.equal(range.displayTime, '21h-23h');
});

test('buildPlayerSearchMainPhrase — phrase naturelle compacte', () => {
  const phrase = buildPlayerSearchMainPhrase({
    roles: ['adc'],
    ranks: ['Plat'],
    playerCount: 2,
    sessionType: 'Quelques games',
    datePhrase: "aujourd'hui",
    timePhrase: '21h',
  });
  assert.equal(
    phrase,
    'Nous cherchons 2 joueurs ADC de niveau Plat pour quelques games aujourd\'hui à 21h.',
  );
});

test('buildPlayerSearchMainPhrase — rang entre-deux Emerald / Diamond', () => {
  const phrase = buildPlayerSearchMainPhrase({
    roles: ['adc'],
    ranks: ['Emerald / Diamond'],
    playerCount: 1,
    sessionType: 'Scrim BO3',
    datePhrase: 'demain',
    timePhrase: '21h',
  });
  assert.equal(
    phrase,
    'Nous cherchons 1 joueur ADC de niveau Emerald / Diamond pour un scrim BO3 demain à 21h.',
  );
});

test('buildPlayerSearchMainPhrase — plusieurs rôles', () => {
  const phrase = buildPlayerSearchMainPhrase({
    roles: ['top', 'adc'],
    ranks: ['Iron / Bronze'],
    playerCount: 2,
    sessionType: 'Scrim BO3',
    datePhrase: 'demain',
    timePhrase: '22h',
  });
  assert.equal(
    phrase,
    'Nous cherchons 2 joueurs Top / ADC de niveau Iron / Bronze pour un scrim BO3 demain à 22h.',
  );
});

test('formatPlayerSearchActiveSummaryLine — résumé liste', () => {
  const line = formatPlayerSearchActiveSummaryLine(
    {
      player_search_public_id: 'J1',
      roles_json: JSON.stringify(['adc', 'support']),
      ranks_json: JSON.stringify(['Emerald / Diamond']),
      scheduled_date: '31/05/2026',
      scheduled_time: '21h',
      session_type: 'Scrim BO3',
    },
    { referenceDateTime: REF_PARIS },
  );
  assert.equal(
    line,
    'J1 — ADC / Support — Emerald / Diamond — demain 21h — Scrim BO3',
  );
});

test('mes-demandes-joueur — liste actives auteur uniquement', async () => {
  await withTempDbAsync(async ({ playerSearchStmts }) => {
    const insert = (overrides) => {
      playerSearchStmts.insertPlayerSearchPostRow.run({
        player_search_public_id: overrides.publicId,
        author_user_id: overrides.author,
        origin_guild_id: 'g1',
        source_guild_id: 'g1',
        roles_json: JSON.stringify(overrides.roles ?? ['top']),
        ranks_json: JSON.stringify(overrides.ranks ?? ['Gold / Plat']),
        player_count: 1,
        session_type: overrides.session ?? 'Flex',
        ambiance: 'Chill',
        description: null,
        contact_user_id: overrides.author,
        scheduled_date: overrides.date ?? '04/07/2024',
        scheduled_time: overrides.time ?? '20h30',
        scheduled_at: '2024-07-04T18:30:00.000Z',
        scheduled_at_end: null,
        tags_json: '{}',
        created_at: Date.now(),
        status: overrides.status ?? 'active',
      });
    };

    insert({ publicId: 'J1', author: 'user-a', roles: ['adc', 'support'] });
    insert({
      publicId: 'J2',
      author: 'user-a',
      roles: ['top'],
      session: 'Flex',
    });
    insert({ publicId: 'J3', author: 'user-b', roles: ['mid'] });
    insert({
      publicId: 'J4',
      author: 'user-a',
      status: 'closed_manual',
      roles: ['jungle'],
    });

    const rows = playerSearchStmts.listActivePlayerSearchPostsByAuthor.all(
      'user-a',
    );
    assert.equal(rows.length, 2);
    const ids = rows.map((r) => r.player_search_public_id).sort();
    assert.deepEqual(ids, ['J1', 'J2']);
  });
});

test('mes-demandes-scrim — renommage slash uniquement', () => {
  const cmdPath = path.join(
    __dirname,
    '..',
    'src',
    'commands',
    'mesDemandes.js',
  );
  const source = fs.readFileSync(cmdPath, 'utf8');
  assert.match(source, /\.setName\('mes-demandes-scrim'\)/);
  assert.match(source, /listActiveScrimPostsByAuthor/);
  assert.match(source, /Tes demandes de scrim actives/);
});

test('mes-demandes-joueur — commande publique enregistrée', () => {
  const indexPath = path.join(__dirname, '..', 'src', 'commands', 'index.js');
  const source = fs.readFileSync(indexPath, 'utf8');
  assert.match(source, /mesDemandesJoueur/);
  assert.match(source, /commandListWithoutDev/);
  assert.doesNotMatch(source, /playerSearchDevCommandList/);
  const publicBlock = source.slice(
    source.indexOf('commandListWithoutDev'),
    source.indexOf('export { scrimDev }'),
  );
  assert.match(publicBlock, /mesDemandesJoueur/);
  const cmdPath = path.join(
    __dirname,
    '..',
    'src',
    'commands',
    'mesDemandesJoueur.js',
  );
  const cmdSource = fs.readFileSync(cmdPath, 'utf8');
  assert.match(cmdSource, /\.setName\('mes-demandes-joueur'\)/);
  assert.match(cmdSource, /listActivePlayerSearchPostsByAuthor/);
  assert.match(cmdSource, /Tu n’as aucune recherche joueur active/);
  assert.match(cmdSource, /Pour fermer une recherche : \/joueur-trouve id:J1/);
  assert.doesNotMatch(cmdSource, /\[DEV\]/);
});

test('normalizePlayerSearchPublicId — j1 → J1', () => {
  assert.equal(normalizePlayerSearchPublicId('j1'), 'J1');
});

/**
 * @param {() => void | Promise<void>} fn
 */
async function withTempDbAsync(fn) {
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-search-life-'));
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

test('lifecycle — ferme un post actif (manual)', async () => {
  await withTempDbAsync(async ({ db, playerSearchStmts }) => {
    const publicId = allocatePlayerSearchPublicId(playerSearchStmts);
    assert.ok(publicId);
    const info = playerSearchStmts.insertPlayerSearchPostRow.run({
      player_search_public_id: publicId,
      author_user_id: 'author-1',
      origin_guild_id: 'g1',
      source_guild_id: 'g1',
      roles_json: JSON.stringify(['adc']),
      ranks_json: JSON.stringify(['Diamond']),
      player_count: 1,
      session_type: 'Scrim BO3',
      ambiance: 'Chill',
      description: null,
      contact_user_id: 'author-1',
      scheduled_date: '30/05/2026',
      scheduled_time: '21h',
      scheduled_at: '2026-05-30T19:00:00.000Z',
      scheduled_at_end: null,
      tags_json: '{}',
      created_at: Date.now(),
      status: 'active',
    });
    const dbId = Number(info.lastInsertRowid);
    const closed = closePlayerSearchPostByDbId(
      db,
      playerSearchStmts,
      dbId,
      'closed_manual',
      'manual',
    );
    assert.equal(closed, true);
    const row = playerSearchStmts.getPlayerSearchPostById.get(dbId);
    assert.equal(row.status, 'closed_manual');
    assert.equal(row.closed_reason, 'manual');
  });
});

test('closePlayerSearchPostByPublicIdForAuthor — normalise j1', async () => {
  await withTempDbAsync(async ({ db, playerSearchStmts }) => {
    playerSearchStmts.insertPlayerSearchPostRow.run({
      player_search_public_id: 'J1',
      author_user_id: 'author-42',
      origin_guild_id: 'g1',
      source_guild_id: 'g1',
      roles_json: JSON.stringify(['mid']),
      ranks_json: JSON.stringify(['Plat']),
      player_count: 1,
      session_type: 'Flex',
      ambiance: 'Fun',
      description: null,
      contact_user_id: 'author-42',
      scheduled_date: '30/05/2026',
      scheduled_time: '20h',
      scheduled_at: '2026-05-30T18:00:00.000Z',
      scheduled_at_end: null,
      tags_json: '{}',
      created_at: Date.now(),
      status: 'active',
    });

    const mockClient = {
      guilds: { fetch: async () => null },
    };

    const result = await closePlayerSearchPostByPublicIdForAuthor(
      /** @type {import('discord.js').Client} */ (mockClient),
      db,
      playerSearchStmts,
      'j1',
      'author-42',
    );
    assert.equal(result.ok, true);
    const row = playerSearchStmts.getPlayerSearchPostByPublicIdAny.get('J1');
    assert.equal(row.status, 'closed_manual');
  });
});

test('broadcast — module isolé des scrims', () => {
  const broadcastPath = path.join(
    __dirname,
    '..',
    'src',
    'services',
    'playerSearchBroadcast.js',
  );
  const source = fs.readFileSync(broadcastPath, 'utf8');
  assert.doesNotMatch(source, /broadcastScrimRequest/);
  assert.doesNotMatch(source, /guild_game_channels/);
  assert.doesNotMatch(source, /listChannelsByGame/);
  assert.match(source, /insertPlayerSearchPostMessage/);
});

test('recherche-joueur — choices role_1 et rang unique', () => {
  const cmdPath = path.join(
    __dirname,
    '..',
    'src',
    'commands',
    'rechercheJoueur.js',
  );
  const source = fs.readFileSync(cmdPath, 'utf8');
  assert.match(source, /role_1/);
  assert.match(source, /\.setName\('nombre'\)/);
  assert.match(source, /\.setName\('rang'\)/);
  assert.match(source, /\.setName\('date'\)/);
  assert.doesNotMatch(source, /rang_1/);
  assert.doesNotMatch(source, /\.setName\('description'\)/);
  assert.match(source, /validatePlayerSearchRoleCountMatch/);
  assert.doesNotMatch(source, /mayConfigurePlayerSearchReceptionChannel/);
  assert.doesNotMatch(source, /getGuildScrimReceptionBypass/);
  assert.match(source, /Recherche joueur publiée/);
  assert.match(source, /Pour fermer : \/joueur-trouve id:/);
});

test('recherche-joueur — diffusion via salons dédiés uniquement', () => {
  const cmdPath = path.join(
    __dirname,
    '..',
    'src',
    'commands',
    'rechercheJoueur.js',
  );
  const source = fs.readFileSync(cmdPath, 'utf8');
  assert.match(source, /listPlayerSearchChannels/);
  assert.doesNotMatch(source, /listChannelsByGame/);
  assert.match(source, /rollbackPlayerSearchPostCreation/);
});

test('deploy-commands — Recherche Joueur incluse en public, scrim-dev seul en dev', () => {
  const deployPath = path.join(
    __dirname,
    '..',
    'scripts',
    'deploy-commands.js',
  );
  const source = fs.readFileSync(deployPath, 'utf8');
  assert.match(source, /commandListWithoutDev/);
  assert.match(source, /devOnlyBody/);
  assert.doesNotMatch(source, /playerSearchDevCommandList/);
  assert.doesNotMatch(source, /playerSearchDevBody/);
  const devOnlyLine = source.slice(
    source.indexOf('const devOnlyBody'),
    source.indexOf('const devGuildId'),
  );
  assert.match(devOnlyLine, /scrimDev\.data\.toJSON/);
});
