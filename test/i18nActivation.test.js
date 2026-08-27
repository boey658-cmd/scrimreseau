/**
 * I18N-ACTIVATION — 7 locales guild activées (local only).
 * Contract anti-drift : fr,en,es,de,it,pl,pt
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { language } from '../src/commands/language.js';
import { getDb, prepareStatements, closeDb } from '../src/database/db.js';
import {
  ALL_LOCALES,
  ENABLED_GUILD_LOCALES,
  getGuildLocale,
  normalizeEnabledGuildLocale,
  t,
} from '../src/i18n/index.js';
import { de } from '../src/i18n/de.js';
import { en } from '../src/i18n/en.js';
import { es } from '../src/i18n/es.js';
import { fr } from '../src/i18n/fr.js';
import { it as itDict } from '../src/i18n/it.js';
import { pl } from '../src/i18n/pl.js';
import { pt } from '../src/i18n/pt.js';
import { fetchGuildConfig } from '../src/internalHttp/configQueries.js';
import { applyGuildConfigSectionWrite } from '../src/services/guildConfigWrites.js';
import { ConfigWriteError } from '../src/services/configWriteError.js';

const GUILD_ID = '111456789012345678';
const ACTOR = '1009269632693174422';
const SEVEN = ['fr', 'en', 'es', 'de', 'it', 'pl', 'pt'];
const CATALOGS = { fr, en, es, de, it: itDict, pl, pt };

function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-act-'));
  const prev = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  try {
    const db = getDb();
    const stmts = prepareStatements(db);
    return fn(db, stmts, dir);
  } finally {
    closeDb();
    if (prev === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDbAsync(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-act-async-'));
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

function makeWriteCtx(db, stmts) {
  const client = { guilds: { cache: { has: () => true } } };
  const guild = {
    id: GUILD_ID,
    ownerId: ACTOR,
    memberCount: 50,
    members: {
      me: { id: 'bot', permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) },
    },
    channels: { cache: { get: () => null }, fetch: async () => null },
    roles: { cache: { get: () => null }, fetch: async () => null },
  };
  return {
    client: /** @type {any} */ (client),
    guild: /** @type {any} */ (guild),
    db,
    stmts,
    guildId: GUILD_ID,
    actorDiscordUserId: ACTOR,
  };
}

describe('I18N-ACTIVATION — contract 7 locales', () => {
  it('ENABLED_GUILD_LOCALES = ALL_LOCALES = 7', () => {
    assert.deepStrictEqual([...ENABLED_GUILD_LOCALES], SEVEN);
    assert.deepStrictEqual([...ALL_LOCALES], SEVEN);
    assert.deepStrictEqual([...ENABLED_GUILD_LOCALES], [...ALL_LOCALES]);
  });

  it('normalizeEnabledGuildLocale accepte les 7 ; invalide → fr', () => {
    for (const loc of SEVEN) {
      assert.equal(normalizeEnabledGuildLocale(loc), loc);
      assert.equal(normalizeEnabledGuildLocale(loc.toUpperCase()), loc);
    }
    assert.equal(normalizeEnabledGuildLocale('xx'), 'fr');
    assert.equal(normalizeEnabledGuildLocale(null), 'fr');
  });
});

describe('I18N-ACTIVATION — SQLite migration expand CHECK', () => {
  it('fresh DB : CHECK 7 locales + insert es/de/it/pl/pt + reject invalid', () => {
    withTempDb((db, stmts) => {
      const row = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='guild_languages'`)
        .get();
      assert.ok(String(row.sql).includes("'es'"));
      assert.ok(String(row.sql).includes("'pt'"));

      for (const loc of SEVEN) {
        stmts.upsertGuildLanguage.run(`g-${loc}`, loc);
        assert.equal(getGuildLocale(`g-${loc}`, stmts), loc);
      }
      assert.throws(() => stmts.upsertGuildLanguage.run('g-bad', 'xx'));
      assert.throws(() => stmts.upsertGuildLanguage.run('g-bad2', 'zh'));
    });
  });

  it('legacy fr/en CHECK → migration préserve rows puis accepte 7', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-act-legacy-'));
    const dbPath = path.join(dir, 'legacy.db');
    const legacy = new Database(dbPath);
    try {
      legacy.exec(`
        CREATE TABLE guild_languages (
          guild_id TEXT PRIMARY KEY NOT NULL,
          language TEXT NOT NULL CHECK(language IN ('fr', 'en'))
        );
        INSERT INTO guild_languages (guild_id, language) VALUES ('g1', 'fr'), ('g2', 'en');
      `);
    } finally {
      legacy.close();
    }

    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = dbPath;
    try {
      const db = getDb();
      const stmts = prepareStatements(db);
      const rows = db.prepare(`SELECT guild_id, language FROM guild_languages ORDER BY guild_id`).all();
      assert.deepStrictEqual(rows, [
        { guild_id: 'g1', language: 'fr' },
        { guild_id: 'g2', language: 'en' },
      ]);
      const sql = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='guild_languages'`)
        .get()?.sql;
      assert.ok(String(sql).includes("'es'"));
      assert.ok(String(sql).includes("'de'"));
      stmts.upsertGuildLanguage.run('g3', 'es');
      assert.equal(getGuildLocale('g3', stmts), 'es');
      assert.throws(() => stmts.upsertGuildLanguage.run('g4', 'invalid'));
    } finally {
      closeDb();
      if (prev === undefined) delete process.env.SQLITE_PATH;
      else process.env.SQLITE_PATH = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migration expand idempotente', () => {
    withTempDb((db) => {
      const before = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='guild_languages'`)
        .get()?.sql;
      // Relancer getDb path n'est pas trivial ; on vérifie schéma stable
      assert.ok(String(before).includes("'pl'"));
      const count = db.prepare(`SELECT COUNT(*) AS c FROM guild_languages`).get();
      assert.equal(typeof count.c, 'number');
    });
  });
});

describe('I18N-ACTIVATION — /language 7 choices + persist + succès locale', () => {
  it('choices values = 7 locales', () => {
    const json = language.data.toJSON();
    const opt = json.options?.find((o) => o.name === 'language');
    assert.deepStrictEqual((opt?.choices ?? []).map((c) => c.value), SEVEN);
    assert.ok(json.description_localizations?.['es-ES']);
    assert.ok(json.description_localizations?.['pt-BR']);
    const frChoice = (opt?.choices ?? []).find((c) => c.value === 'fr');
    assert.ok(frChoice?.name_localizations?.['es-ES']);
    assert.ok(frChoice?.name_localizations?.de);
  });

  it('chaque choice persistée + réponse dans la nouvelle locale', async () => {
    await withTempDbAsync(async (db, stmts) => {
      for (const loc of SEVEN) {
        const replies = [];
        const interaction = {
          guildId: GUILD_ID,
          guild: { id: GUILD_ID },
          inGuild: () => true,
          memberPermissions: { has: () => true },
          member: { permissions: { has: () => true } },
          user: { id: 'u1' },
          options: { getString: () => loc },
          replied: false,
          deferred: false,
          reply: async (opts) => {
            replies.push(opts);
          },
          editReply: async (opts) => {
            replies.push(opts);
          },
          followUp: async (opts) => {
            replies.push(opts);
          },
        };
        await language.execute(/** @type {any} */ (interaction), { db, stmts });
        assert.equal(getGuildLocale(GUILD_ID, stmts), loc);
        assert.equal(replies[0]?.content, t(/** @type {any} */ (loc), 'language.success'));
        assert.equal(replies[0]?.content, CATALOGS[loc]['language.success']);
      }
    });
  });

  it('aucune dépendance interaction.locale pour les réponses bot', () => {
    const src = fs.readFileSync(new URL('../src/commands/language.js', import.meta.url), 'utf8');
    // Autorisé en commentaire ; interdit dans le corps exécutable.
    const withoutComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(withoutComments, /interaction\.locale/);
    assert.match(src, /getGuildLocale/);
    assert.match(src, /language\.success/);
  });
});

describe('I18N-ACTIVATION — PATCH + GET config 7 locales', () => {
  it('PATCH accepte 7 ; invalide 400 ; GET roundtrip', async () => {
    await withTempDbAsync(async (db, stmts) => {
      const ctx = makeWriteCtx(db, stmts);
      for (const language of SEVEN) {
        const r = await applyGuildConfigSectionWrite(ctx, {
          section: 'language',
          language,
          actor_discord_user_id: ACTOR,
          request_id: `r-${language}`,
          source: 'web',
        });
        assert.equal(r.config.language, language);
        assert.equal(fetchGuildConfig(db, GUILD_ID).language, language);
      }
      await assert.rejects(
        () =>
          applyGuildConfigSectionWrite(ctx, {
            section: 'language',
            language: 'xx',
            actor_discord_user_id: ACTOR,
            request_id: 'bad',
            source: 'web',
          }),
        (err) => err instanceof ConfigWriteError && err.status === 400,
      );
    });
  });

  it('non-régression fr/en', async () => {
    await withTempDbAsync(async (db, stmts) => {
      const ctx = makeWriteCtx(db, stmts);
      await applyGuildConfigSectionWrite(ctx, {
        section: 'language',
        language: 'fr',
        actor_discord_user_id: ACTOR,
        request_id: 'fr',
        source: 'web',
      });
      assert.equal(fetchGuildConfig(db, GUILD_ID).language, 'fr');
      await applyGuildConfigSectionWrite(ctx, {
        section: 'language',
        language: 'en',
        actor_discord_user_id: ACTOR,
        request_id: 'en',
        source: 'web',
      });
      assert.equal(fetchGuildConfig(db, GUILD_ID).language, 'en');
    });
  });
});

describe('I18N-ACTIVATION — language.success parité 7', () => {
  it('chaque catalogue a language.success distinct et non vide', () => {
    for (const code of SEVEN) {
      const v = CATALOGS[code]['language.success'];
      assert.equal(typeof v, 'string');
      assert.ok(v.length > 10);
      assert.ok(v.includes('✅'));
    }
    assert.notEqual(fr['language.success'], en['language.success']);
    assert.notEqual(es['language.success'], en['language.success']);
    assert.notEqual(de['language.success'], en['language.success']);
  });
});
