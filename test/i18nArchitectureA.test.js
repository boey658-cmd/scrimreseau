/**
 * BOT-I18N-A — architecture 7 locales techniques, guild fr/en only.
 * ES/DE/IT/PL/PT = PLACEHOLDER ONLY (copie EN), non exposés.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { language } from '../src/commands/language.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import {
  ALL_LOCALES,
  ENABLED_GUILD_LOCALES,
  createTranslator,
  de,
  en,
  es,
  fr,
  getGuildLocale,
  it as itDict,
  lookupTranslationRaw,
  normalizeEnabledGuildLocale,
  normalizeLocale,
  pl,
  pt,
  t,
} from '../src/i18n/index.js';
import { applyGuildConfigSectionWrite } from '../src/services/guildConfigWrites.js';
import { ConfigWriteError } from '../src/services/configWriteError.js';
import {
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUILD_ID = '1484520688726311012';
const ACTOR = '1009269632693174422';

const CATALOGS = { fr, en, es, de, it: itDict, pl, pt };

describe('BOT-I18N-A — ENABLED_GUILD_LOCALES (activées = 7)', () => {
  it('ENABLED_GUILD_LOCALES = exactement fr,en,es,de,it,pl,pt', () => {
    assert.deepStrictEqual([...ENABLED_GUILD_LOCALES], ['fr', 'en', 'es', 'de', 'it', 'pl', 'pt']);
  });

  it('ALL_LOCALES = 7 locales techniques', () => {
    assert.deepStrictEqual([...ALL_LOCALES], ['fr', 'en', 'es', 'de', 'it', 'pl', 'pt']);
  });

  it('les 5 locales sont dans ENABLED_GUILD_LOCALES', () => {
    for (const loc of ['es', 'de', 'it', 'pl', 'pt']) {
      assert.ok(ENABLED_GUILD_LOCALES.includes(/** @type {any} */ (loc)));
      assert.ok(ALL_LOCALES.includes(/** @type {any} */ (loc)));
    }
  });
});

describe('BOT-I18N-A — parité des clés', () => {
  it('fr/en/es/de/it/pl/pt : mêmes clés, valeurs string', () => {
    const ref = Object.keys(fr).sort();
    assert.ok(ref.length > 200, `attendu ~226 clés, got ${ref.length}`);

    for (const code of ALL_LOCALES) {
      const catalog = CATALOGS[code];
      assert.ok(catalog, `catalog ${code}`);
      const keys = Object.keys(catalog).sort();
      assert.deepStrictEqual(keys, ref, `clés orphelines/manquantes pour ${code}`);
      for (const k of keys) {
        assert.equal(typeof catalog[k], 'string', `${code}.${k} doit être string`);
      }
    }
  });
});

describe('BOT-I18N-A — fallback t()', () => {
  const sampleKey = 'generic.guildOnly';

  it('fr → FR ; en → EN', () => {
    assert.equal(t('fr', sampleKey), fr[sampleKey]);
    assert.equal(t('en', sampleKey), en[sampleKey]);
    assert.notEqual(fr[sampleKey], en[sampleKey]);
  });

  it('future locale rend une valeur propre (plus un placeholder EN brut)', () => {
    for (const loc of /** @type {const} */ (['es', 'de', 'it', 'pl', 'pt'])) {
      const value = t(loc, sampleKey);
      assert.ok(value.length > 0);
      assert.notEqual(value, `[${sampleKey}]`);
      // BOT-I18N-B : traductions réelles — ne doivent plus être des copies EN
      assert.notEqual(value, en[sampleKey], loc);
    }
  });

  it('clé absente future locale → EN (chain simulée)', () => {
    const emptyEs = Object.freeze(/** @type {Record<string, string>} */ ({}));
    assert.equal(
      lookupTranslationRaw('es', sampleKey, [emptyEs, en, fr]),
      en[sampleKey],
    );
  });

  it('absente future + EN → FR', () => {
    const emptyEs = Object.freeze(/** @type {Record<string, string>} */ ({}));
    const emptyEn = Object.freeze(/** @type {Record<string, string>} */ ({}));
    assert.equal(
      lookupTranslationRaw('es', sampleKey, [emptyEs, emptyEn, fr]),
      fr[sampleKey],
    );
  });

  it('absente partout → [key]', () => {
    assert.equal(t('es', 'no.such.key.ever'), '[no.such.key.ever]');
    assert.equal(t('fr', 'no.such.key.ever'), '[no.such.key.ever]');
  });

  it('locale inconnue passée à t → catalogue fr', () => {
    assert.equal(t(/** @type {any} */ ('zh'), sampleKey), fr[sampleKey]);
  });

  it('createTranslator(es) fonctionne techniquement', () => {
    const T = createTranslator('es');
    assert.equal(T(sampleKey), es[sampleKey]);
    assert.notEqual(T(sampleKey), en[sampleKey]);
  });
});

describe('BOT-I18N-A — guild locale 7 locales', () => {
  it('normalizeEnabledGuildLocale accepte es (activé)', () => {
    assert.equal(normalizeEnabledGuildLocale('es'), 'es');
    assert.equal(normalizeLocale('es'), 'es');
  });

  it('getGuildLocale accepte es après upsert', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-a-'));
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = path.join(dir, 'test.db');
    try {
      const db = getDb();
      const stmts = prepareStatements(db);
      assert.equal(getGuildLocale('no-row', stmts), 'fr');
      stmts.upsertGuildLanguage.run(GUILD_ID, 'en');
      assert.equal(getGuildLocale(GUILD_ID, stmts), 'en');
      stmts.upsertGuildLanguage.run(GUILD_ID, 'es');
      assert.equal(getGuildLocale(GUILD_ID, stmts), 'es');
      assert.throws(() => stmts.upsertGuildLanguage.run(GUILD_ID, 'xx'));
      assert.equal(getGuildLocale(GUILD_ID, stmts), 'es');
    } finally {
      closeDb();
      if (prev === undefined) delete process.env.SQLITE_PATH;
      else process.env.SQLITE_PATH = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('BOT-I18N-A — /language choices 7 locales', () => {
  it('choices = 7 values fr…pt', () => {
    const json = language.data.toJSON();
    const opt = json.options?.find((o) => o.name === 'language');
    assert.ok(opt);
    const choices = /** @type {{ name: string, value: string }[]} */ (opt.choices ?? []);
    assert.deepStrictEqual(
      choices.map((c) => c.value),
      ['fr', 'en', 'es', 'de', 'it', 'pl', 'pt'],
    );
  });
});

describe('BOT-I18N-A — PATCH language accepte 7 locales', () => {
  it('fr/en/es/de/it/pl/pt ok ; invalide 400', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-a-patch-'));
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = path.join(dir, 'test.db');
    try {
      const db = getDb();
      const stmts = prepareStatements(db);
      const client = {
        guilds: { cache: { has: () => true } },
      };
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
      const ctx = {
        client: /** @type {any} */ (client),
        guild: /** @type {any} */ (guild),
        db,
        stmts,
        guildId: GUILD_ID,
        actorDiscordUserId: ACTOR,
      };

      for (const language of ['fr', 'en', 'es', 'de', 'it', 'pl', 'pt']) {
        const ok = await applyGuildConfigSectionWrite(ctx, {
          section: 'language',
          language,
          actor_discord_user_id: ACTOR,
          request_id: `r-${language}`,
          source: 'web',
        });
        assert.equal(ok.config.language, language);
      }

      await assert.rejects(
        () => applyGuildConfigSectionWrite(ctx, {
          section: 'language',
          language: 'xx',
          actor_discord_user_id: ACTOR,
          request_id: 'r-bad',
          source: 'web',
        }),
        (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
      );
      assert.equal(getGuildLocale(GUILD_ID, stmts), 'pt');
    } finally {
      closeDb();
      if (prev === undefined) delete process.env.SQLITE_PATH;
      else process.env.SQLITE_PATH = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('BOT-I18N-A — DB CHECK 7 locales + slash localizations', () => {
  it('CHECK language IN (7 locales) dans le schéma runtime', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-a-check-'));
    const prev = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = path.join(dir, 'test.db');
    try {
      const db = getDb();
      const row = db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='guild_languages'`,
      ).get();
      assert.ok(row?.sql);
      const sql = String(row.sql);
      for (const loc of ['fr', 'en', 'es', 'de', 'it', 'pl', 'pt']) {
        assert.ok(sql.includes(`'${loc}'`), `missing ${loc}`);
      }
    } finally {
      closeDb();
      if (prev === undefined) delete process.env.SQLITE_PATH;
      else process.env.SQLITE_PATH = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('slash language a des description_localizations ; choices values = 7', () => {
    const json = language.data.toJSON();
    assert.ok(json.description_localizations);
    assert.equal(json.description_localizations.fr?.length > 0, true);
    assert.equal(json.description_localizations['es-ES']?.length > 0, true);
    assert.equal(json.description_localizations['pt-BR']?.length > 0, true);
    // Discord n’a pas pt-PT
    assert.equal(json.description_localizations['pt-PT'], undefined);

    const langOpt = json.options?.find((o) => o.name === 'language');
    assert.ok(langOpt);
    const values = (langOpt.choices ?? []).map((c) => c.value);
    assert.deepStrictEqual(values, ['fr', 'en', 'es', 'de', 'it', 'pl', 'pt']);
  });
});
