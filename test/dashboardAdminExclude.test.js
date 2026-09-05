/**
 * Tests — /dashboard-admin exclude-* (exclusions publiques /network).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MessageFlags } from 'discord.js';
import { dashboardAdmin } from '../src/commands/dashboardAdmin.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import {
  EXCLUDE_AUTOCOMPLETE_MAX,
  filterAutocompleteChoices,
  normalizeExclusionReason,
  parseGuildIdOption,
  truncateAutocompleteName,
} from '../src/utils/networkPublicExclusionAdmin.js';

const OWNER_ID = '999888777666555444';
const OTHER_ID = '111222333444555666';
const GUILD_A = '1000000000000000001';
const GUILD_B = '1000000000000000002';
const GUILD_C = '1000000000000000003';

/** @type {string | undefined} */
let prevOwner;
/** @type {string | undefined} */
let prevSqlite;

beforeEach(() => {
  prevOwner = process.env.SCRIMRESEAU_OWNER_ID;
  prevSqlite = process.env.SQLITE_PATH;
  process.env.SCRIMRESEAU_OWNER_ID = OWNER_ID;
});

afterEach(() => {
  closeDb();
  if (prevOwner === undefined) delete process.env.SCRIMRESEAU_OWNER_ID;
  else process.env.SCRIMRESEAU_OWNER_ID = prevOwner;
  if (prevSqlite === undefined) delete process.env.SQLITE_PATH;
  else process.env.SQLITE_PATH = prevSqlite;
});

function withTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-dash-exclude-'));
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  const db = getDb();
  const stmts = prepareStatements(db);
  return { db, stmts, dir };
}

function mockGuild(id, name) {
  return { id, name };
}

function mockClient(guilds) {
  const map = new Map(guilds.map((g) => [g.id, g]));
  return {
    guilds: {
      cache: {
        has: (id) => map.has(String(id)),
        get: (id) => map.get(String(id)),
        values: () => map.values(),
      },
    },
  };
}

function createInteraction({
  userId = OWNER_ID,
  sub,
  options = {},
  client,
  deferred = false,
}) {
  /** @type {string | null} */
  let replyContent = null;
  /** @type {unknown} */
  let editContent = null;
  /** @type {unknown[] | null} */
  let autocompleteChoices = null;
  let deferredFlag = deferred;

  const optionBag = {
    getSubcommand(required = true) {
      if (!sub && required) throw new Error('missing sub');
      return sub ?? null;
    },
    getString(name, required = false) {
      const v = options[name];
      if ((v === undefined || v === null) && required) throw new Error(`missing ${name}`);
      return v ?? null;
    },
    getFocused() {
      return { name: 'serveur', value: options.focused ?? '' };
    },
  };

  return {
    user: { id: userId },
    guildId: GUILD_A,
    client,
    commandName: 'dashboard-admin',
    options: optionBag,
    reply: async (payload) => {
      replyContent = payload;
      return payload;
    },
    deferReply: async () => {
      deferredFlag = true;
    },
    editReply: async (payload) => {
      editContent = payload;
      return payload;
    },
    respond: async (choices) => {
      autocompleteChoices = choices;
    },
    get _reply() {
      return replyContent;
    },
    get _edit() {
      return editContent;
    },
    get _autocomplete() {
      return autocompleteChoices;
    },
    get _deferred() {
      return deferredFlag;
    },
  };
}

describe('networkPublicExclusionAdmin helpers', () => {
  it('normalizeExclusionReason trim + max + empty', () => {
    assert.equal(normalizeExclusionReason(null), null);
    assert.equal(normalizeExclusionReason('  '), null);
    assert.equal(normalizeExclusionReason('  test  '), 'test');
    assert.equal(normalizeExclusionReason('x'.repeat(120)).length, 100);
  });

  it('parseGuildIdOption', () => {
    assert.equal(parseGuildIdOption(GUILD_A), GUILD_A);
    assert.equal(parseGuildIdOption('abc'), null);
    assert.equal(parseGuildIdOption('123'), null);
  });

  it('filterAutocompleteChoices — filtre + max 25', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      name: `Guild ${String(i).padStart(2, '0')}`,
      value: `1${String(i).padStart(17, '0')}`,
    }));
    const all = filterAutocompleteChoices(entries, '');
    assert.equal(all.length, EXCLUDE_AUTOCOMPLETE_MAX);

    const filtered = filterAutocompleteChoices(entries, 'guild 3');
    assert.ok(filtered.every((c) => c.name.toLowerCase().includes('guild 3') || c.value.includes('3')));
    assert.ok(filtered.length <= EXCLUDE_AUTOCOMPLETE_MAX);
    assert.ok(filtered.some((c) => c.name === 'Guild 30'));
  });

  it('truncateAutocompleteName', () => {
    assert.equal(truncateAutocompleteName('short'), 'short');
    assert.equal(truncateAutocompleteName('a'.repeat(105)).length, 100);
    assert.ok(truncateAutocompleteName('a'.repeat(105)).endsWith('...'));
  });
});

describe('dashboard-admin slash definition', () => {
  it('inclut exclude-add / exclude-remove / exclude-list avec autocomplete', () => {
    const json = dashboardAdmin.data.toJSON();
    const subs = json.options ?? [];
    const names = subs.map((o) => o.name);
    assert.ok(names.includes('exclude-add'));
    assert.ok(names.includes('exclude-remove'));
    assert.ok(names.includes('exclude-list'));

    const add = subs.find((o) => o.name === 'exclude-add');
    const serveur = add.options?.find((o) => o.name === 'serveur');
    assert.equal(serveur?.autocomplete, true);
    assert.ok(add.options?.some((o) => o.name === 'raison' && o.required === false));

    const remove = subs.find((o) => o.name === 'exclude-remove');
    assert.equal(remove.options?.find((o) => o.name === 'serveur')?.autocomplete, true);
  });

  it('conserve list / remove / refresh existants', () => {
    const names = (dashboardAdmin.data.toJSON().options ?? []).map((o) => o.name);
    assert.ok(names.includes('list'));
    assert.ok(names.includes('remove'));
    assert.ok(names.includes('refresh'));
    assert.equal(typeof dashboardAdmin.execute, 'function');
    assert.equal(typeof dashboardAdmin.autocomplete, 'function');
  });
});

describe('dashboard-admin exclude execute', () => {
  it('non-owner refusé', async () => {
    const { stmts, dir } = withTempDb();
    try {
      const client = mockClient([mockGuild(GUILD_A, 'Alpha')]);
      const interaction = createInteraction({
        userId: OTHER_ID,
        sub: 'exclude-add',
        options: { serveur: GUILD_A },
        client,
      });
      await dashboardAdmin.execute(interaction, { stmts });
      assert.equal(interaction._deferred, false);
      assert.match(String(interaction._reply?.content ?? ''), /propriétaire|owner|Eigentümer|propietario|proprietário|właściciela|proprietario/i);
      assert.equal(interaction._reply?.flags, MessageFlags.Ephemeral);
      assert.equal(stmts.listNetworkPublicExclusions.all().length, 0);
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exclude-add normal + raison optionnelle', async () => {
    const { stmts, dir } = withTempDb();
    try {
      const client = mockClient([mockGuild(GUILD_A, 'Serveur test bot2')]);
      const interaction = createInteraction({
        sub: 'exclude-add',
        options: { serveur: GUILD_A, raison: '  serveur de test  ' },
        client,
      });
      await dashboardAdmin.execute(interaction, { stmts });
      assert.match(String(interaction._edit?.content ?? ''), /masqué|hidden|oculto|ausgeblendet|nascosto|ukryty/i);
      assert.match(String(interaction._edit?.content ?? ''), /Serveur test bot2/);
      assert.match(String(interaction._edit?.content ?? ''), /serveur de test/);

      const rows = stmts.listNetworkPublicExclusions.all();
      assert.equal(rows.length, 1);
      assert.equal(String(rows[0].guild_id), GUILD_A);
      assert.equal(rows[0].reason, 'serveur de test');
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exclude-add déjà existant', async () => {
    const { stmts, dir } = withTempDb();
    try {
      stmts.upsertNetworkPublicExclusion.run({
        guild_id: GUILD_A,
        created_at: new Date().toISOString(),
        reason: 'old',
      });
      const client = mockClient([mockGuild(GUILD_A, 'Alpha')]);
      const interaction = createInteraction({
        sub: 'exclude-add',
        options: { serveur: GUILD_A, raison: 'new' },
        client,
      });
      await dashboardAdmin.execute(interaction, { stmts });
      assert.match(String(interaction._edit?.content ?? ''), /déjà|already|ya está|bereits|già|już|já está/i);
      assert.equal(stmts.listNetworkPublicExclusions.all().length, 1);
      assert.equal(stmts.listNetworkPublicExclusions.all()[0].reason, 'old');
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exclude-add refuse guild absente du cache', async () => {
    const { stmts, dir } = withTempDb();
    try {
      const client = mockClient([]);
      const interaction = createInteraction({
        sub: 'exclude-add',
        options: { serveur: GUILD_A },
        client,
      });
      await dashboardAdmin.execute(interaction, { stmts });
      assert.match(String(interaction._edit?.content ?? ''), /invalide|Invalid|válido|Ungültig|valido|Nieprawidłowy|inválido/i);
      assert.equal(stmts.listNetworkPublicExclusions.all().length, 0);
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exclude-remove normal + remove inexistant', async () => {
    const { stmts, dir } = withTempDb();
    try {
      stmts.upsertNetworkPublicExclusion.run({
        guild_id: GUILD_B,
        created_at: new Date().toISOString(),
        reason: null,
      });
      const client = mockClient([mockGuild(GUILD_B, 'Beta')]);

      const ok = createInteraction({
        sub: 'exclude-remove',
        options: { serveur: GUILD_B },
        client,
      });
      await dashboardAdmin.execute(ok, { stmts });
      assert.match(String(ok._edit?.content ?? ''), /visible|sichtbar|visibile|widoczny/i);
      assert.equal(stmts.listNetworkPublicExclusions.all().length, 0);

      const missing = createInteraction({
        sub: 'exclude-remove',
        options: { serveur: GUILD_B },
        client,
      });
      await dashboardAdmin.execute(missing, { stmts });
      assert.match(String(missing._edit?.content ?? ''), /pas actuellement|not currently|no está|nicht|non è|nie jest|não está/i);
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exclude-remove fonctionne si guild absente du cache', async () => {
    const { stmts, dir } = withTempDb();
    try {
      stmts.upsertNetworkPublicExclusion.run({
        guild_id: GUILD_C,
        created_at: new Date().toISOString(),
        reason: 'ghost',
      });
      const client = mockClient([]);
      const interaction = createInteraction({
        sub: 'exclude-remove',
        options: { serveur: GUILD_C },
        client,
      });
      await dashboardAdmin.execute(interaction, { stmts });
      assert.match(String(interaction._edit?.content ?? ''), new RegExp(GUILD_C));
      assert.equal(stmts.listNetworkPublicExclusions.all().length, 0);
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exclude-list vide / plusieurs / nom ou id', async () => {
    const { stmts, dir } = withTempDb();
    try {
      const client = mockClient([mockGuild(GUILD_A, 'Alpha Known')]);

      const empty = createInteraction({ sub: 'exclude-list', client });
      await dashboardAdmin.execute(empty, { stmts });
      assert.match(String(empty._edit?.content ?? ''), /Aucun|No servers|Ningún|kein Server|Nessun|Żaden|Nenhum/i);

      stmts.upsertNetworkPublicExclusion.run({
        guild_id: GUILD_A,
        created_at: new Date().toISOString(),
        reason: 'dev',
      });
      stmts.upsertNetworkPublicExclusion.run({
        guild_id: GUILD_B,
        created_at: new Date().toISOString(),
        reason: null,
      });

      const list = createInteraction({ sub: 'exclude-list', client });
      await dashboardAdmin.execute(list, { stmts });
      const content = String(list._edit?.content ?? '');
      assert.match(content, /Alpha Known/);
      assert.match(content, new RegExp(GUILD_B));
      assert.match(content, /dev/);
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dashboard-admin exclude autocomplete', () => {
  it('autocomplete add — filtre cache guilds, max 25', async () => {
    const { stmts, dir } = withTempDb();
    try {
      const guilds = Array.from({ length: 30 }, (_, i) =>
        mockGuild(`2${String(i).padStart(17, '0')}`, `Server ${String(i).padStart(2, '0')}`),
      );
      const client = mockClient(guilds);
      const interaction = createInteraction({
        sub: 'exclude-add',
        options: { focused: 'Server 1' },
        client,
      });
      await dashboardAdmin.autocomplete(interaction, { stmts });
      const choices = interaction._autocomplete ?? [];
      assert.ok(choices.length <= 25);
      assert.ok(choices.every((c) => String(c.name).includes('Server 1') || String(c.value).includes('1')));
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('autocomplete remove — basé sur exclusions DB (même absentes du cache)', async () => {
    const { stmts, dir } = withTempDb();
    try {
      stmts.upsertNetworkPublicExclusion.run({
        guild_id: GUILD_A,
        created_at: new Date().toISOString(),
        reason: 'x',
      });
      stmts.upsertNetworkPublicExclusion.run({
        guild_id: GUILD_B,
        created_at: new Date().toISOString(),
        reason: 'y',
      });
      const client = mockClient([mockGuild(GUILD_A, 'Alpha')]);
      const interaction = createInteraction({
        sub: 'exclude-remove',
        options: { focused: '' },
        client,
      });
      await dashboardAdmin.autocomplete(interaction, { stmts });
      const choices = interaction._autocomplete ?? [];
      assert.equal(choices.length, 2);
      assert.ok(choices.some((c) => c.name === 'Alpha' && c.value === GUILD_A));
      assert.ok(choices.some((c) => c.value === GUILD_B && c.name === GUILD_B));
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('autocomplete non-owner → []', async () => {
    const { stmts, dir } = withTempDb();
    try {
      const client = mockClient([mockGuild(GUILD_A, 'Alpha')]);
      const interaction = createInteraction({
        userId: OTHER_ID,
        sub: 'exclude-add',
        options: { focused: '' },
        client,
      });
      await dashboardAdmin.autocomplete(interaction, { stmts });
      assert.deepEqual(interaction._autocomplete, []);
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
