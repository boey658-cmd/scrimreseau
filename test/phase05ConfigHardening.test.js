/**
 * Phase 0.5 — hardening config Discord → dashboard + language central + concurrence.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { commandListWithoutDev } from '../src/commands/index.js';
import { language } from '../src/commands/language.js';
import { scrimConfigurer } from '../src/commands/scrimConfigurer.js';
import { structureLien } from '../src/commands/structureLien.js';
import { UI_PRIMARY_GAME_KEY } from '../src/config/games.js';
import { ALL_LOCALES, ENABLED_GUILD_LOCALES, t } from '../src/i18n/index.js';
import { handleGuildConfigPatch } from '../src/internalHttp/configPatch.js';
import { SCRIM_OFFICIAL_SITE_URL } from '../src/services/scrimEmbedBuilder.js';
import {
  assertActorCanReadGuildConfig,
  assertActorCanWriteGuildConfig,
} from '../src/services/guildConfigWriteAuthz.js';
import { applyGuildConfigSectionWrite } from '../src/services/guildConfigWrites.js';
import { ConfigWriteError } from '../src/services/configWriteError.js';
import { listActiveReceptionDestinationsForGame } from '../src/services/receptionChannels.js';
import {
  buildConfigDashboardRedirectPayload,
  getScrimDashboardConfigUrl,
} from '../src/utils/configDashboardRedirect.js';
import { makeAuthzClient, TEST_ACTOR_ID } from './helpers/internalHttpAuthzMock.js';

const GUILD = '1484520688726311012';
const ACTOR = TEST_ACTOR_ID;
const GAME = UI_PRIMARY_GAME_KEY;

/**
 * @param {(db: import('better-sqlite3').Database, stmts: ReturnType<typeof prepareStatements>) => Promise<void> | void} fn
 */
async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-p05-'));
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

function snapshotLang(db, guildId) {
  return db.prepare('SELECT language FROM guild_languages WHERE guild_id = ?').get(guildId)?.language
    ?? null;
}

function makeWriteClient(opts = {}) {
  return makeAuthzClient(GUILD, ACTOR, { administrator: true, manageGuild: false, ...opts });
}

describe('Phase 0.5 — /scrim-config redirect i18n (7 locales)', () => {
  for (const locale of ALL_LOCALES) {
    it(`${locale}: titre / description / bouton / URL / pas de [missing]`, () => {
      const payload = buildConfigDashboardRedirectPayload(locale);
      const embed = payload.embeds[0].toJSON();
      const btn = payload.components[0].components[0].toJSON();
      assert.equal(embed.title, t(locale, 'scrimConfig.redirectTitle'));
      assert.equal(embed.description, t(locale, 'scrimConfig.redirectDescription'));
      assert.equal(btn.label, t(locale, 'scrimConfig.redirectButton'));
      assert.equal(btn.url, SCRIM_OFFICIAL_SITE_URL);
      assert.equal(btn.url, getScrimDashboardConfigUrl());
      assert.ok(!String(embed.title).includes('[scrimConfig'));
      assert.ok(!String(embed.description).includes('[scrimConfig'));
      assert.ok(!String(btn.label).includes('[scrimConfig'));
    });
  }

  it('locale inconnue → fallback fr, aucun crash', () => {
    const payload = buildConfigDashboardRedirectPayload('xx-unknown');
    assert.equal(payload.embeds[0].toJSON().title, t('fr', 'scrimConfig.redirectTitle'));
  });
});

describe('Phase 0.5 — /scrim-config zéro write', () => {
  it('source commande sans stmts write / applyGuildConfigSectionWrite', () => {
    const src = fs.readFileSync(new URL('../src/commands/scrimConfigurer.js', import.meta.url), 'utf8');
    assert.ok(!src.includes('applyGuildConfigSectionWrite'));
    assert.ok(!src.includes('upsertGuild'));
    assert.ok(!src.includes('.run('));
    assert.ok(!src.includes('deleteGuild'));
    assert.ok(src.includes('buildConfigDashboardRedirectPayload'));
  });

  it('execute avec proxy DB qui throw sur write → OK (aucune écriture)', async () => {
    await withTempDb(async (db, stmts) => {
      const before = db.prepare('SELECT COUNT(*) AS c FROM guild_languages').get().c;
      const denied = new Proxy(stmts, {
        get(target, prop) {
          const v = target[prop];
          if (v && typeof v === 'object' && typeof v.run === 'function') {
            return new Proxy(v, {
              get(t2, p2) {
                if (p2 === 'run') {
                  return () => {
                    throw new Error('WRITE_FORBIDDEN_IN_TEST');
                  };
                }
                return t2[p2];
              },
            });
          }
          return v;
        },
      });

      /** @type {any} */
      let replied = null;
      const interaction = {
        inGuild: () => true,
        guildId: GUILD,
        guild: { id: GUILD, memberCount: 100 },
        user: { id: ACTOR },
        memberPermissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
        client: makeWriteClient(),
        replied: false,
        deferred: false,
        reply: async (payload) => {
          replied = payload;
          interaction.replied = true;
          return payload;
        },
      };

      await scrimConfigurer.execute(/** @type {any} */ (interaction), { stmts: denied, db });
      assert.ok(replied?.embeds?.length);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM guild_languages').get().c, before);
    });
  });

  it('commande enregistrée Administrator, sans options', () => {
    const json = scrimConfigurer.data.toJSON();
    assert.equal(json.name, 'scrim-config');
    assert.ok(json.default_member_permissions);
    assert.ok(!json.options?.length);
  });
});

describe('Phase 0.5 — /language service central', () => {
  it('chaque locale supportée via Discord path (= applyGuildConfigSectionWrite)', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeWriteClient();
      const ctx = {
        client: /** @type {any} */ (client),
        guild: /** @type {any} */ (client._guild),
        db,
        stmts,
        guildId: GUILD,
        actorDiscordUserId: ACTOR,
      };
      // Seed non-fr pour que le passage à fr écrive vraiment une row
      await applyGuildConfigSectionWrite(ctx, { section: 'language', language: 'en' });
      for (const loc of ENABLED_GUILD_LOCALES) {
        await applyGuildConfigSectionWrite(ctx, { section: 'language', language: loc });
        assert.equal(snapshotLang(db, GUILD), loc);
      }
    });
  });

  it('locale invalide refusée', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeWriteClient();
      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          {
            client: /** @type {any} */ (client),
            guild: /** @type {any} */ (client._guild),
            db,
            stmts,
            guildId: GUILD,
            actorDiscordUserId: ACTOR,
          },
          { section: 'language', language: 'xx' },
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
      );
      assert.equal(snapshotLang(db, GUILD), null);
    });
  });

  it('Discord handler et PATCH dashboard → même DB', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeWriteClient();
      await applyGuildConfigSectionWrite(
        {
          client: /** @type {any} */ (client),
          guild: /** @type {any} */ (client._guild),
          db,
          stmts,
          guildId: GUILD,
          actorDiscordUserId: ACTOR,
        },
        { section: 'language', language: 'en' },
      );
      assert.equal(snapshotLang(db, GUILD), 'en');

      await handleGuildConfigPatch({
        client: /** @type {any} */ (client),
        db,
        stmts,
        guildId: GUILD,
        body: {
          actor_discord_user_id: ACTOR,
          request_id: 'r1',
          source: 'web',
          section: 'language',
          language: 'es',
        },
      });
      assert.equal(snapshotLang(db, GUILD), 'es');
    });
  });

  it('/language source utilise applyGuildConfigSectionWrite (pas SQL direct)', () => {
    const src = fs.readFileSync(new URL('../src/commands/language.js', import.meta.url), 'utf8');
    assert.ok(src.includes('applyGuildConfigSectionWrite'));
    assert.ok(!src.includes('upsertGuildLanguage.run'));
    assert.equal(language.data.toJSON().name, 'language');
  });
});

describe('Phase 0.5 — structure-link redirect', () => {
  it('sans sous-commandes set/remove ; payload redirect', () => {
    const json = structureLien.data.toJSON();
    assert.equal(json.name, 'structure-link');
    assert.ok(!json.options?.length);
    const payload = buildConfigDashboardRedirectPayload('fr', {
      titleKey: 'structureLink.redirectTitle',
      descriptionKey: 'structureLink.redirectDescription',
      buttonKey: 'structureLink.redirectButton',
    });
    assert.equal(payload.embeds[0].toJSON().title, t('fr', 'structureLink.redirectTitle'));
  });
});

describe('Phase 0.5 — authz write Administrator', () => {
  it('ManageGuild seul : GET OK, PATCH KO', async () => {
    const readClient = makeAuthzClient(GUILD, ACTOR, { manageGuild: true, administrator: false });
    await assertActorCanReadGuildConfig({
      client: /** @type {any} */ (readClient),
      guildId: GUILD,
      actorDiscordUserId: ACTOR,
    });
    await assert.rejects(
      () => assertActorCanWriteGuildConfig({
        client: /** @type {any} */ (readClient),
        guildId: GUILD,
        actorDiscordUserId: ACTOR,
      }),
      (err) => err instanceof ConfigWriteError && err.code === 'GUILD_NOT_MANAGEABLE',
    );
  });

  it('Administrator : write OK', async () => {
    const client = makeWriteClient();
    await assertActorCanWriteGuildConfig({
      client: /** @type {any} */ (client),
      guildId: GUILD,
      actorDiscordUserId: ACTOR,
    });
  });
});

describe('Phase 0.5 — concurrence', () => {
  it('A: deux PATCH language simultanés → état final valide', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeWriteClient();
      const body = (lang) => ({
        actor_discord_user_id: ACTOR,
        request_id: `req-${lang}`,
        source: 'web',
        section: 'language',
        language: lang,
      });
      await Promise.all([
        handleGuildConfigPatch({
          client: /** @type {any} */ (client),
          db,
          stmts,
          guildId: GUILD,
          body: body('en'),
        }),
        handleGuildConfigPatch({
          client: /** @type {any} */ (client),
          db,
          stmts,
          guildId: GUILD,
          body: body('de'),
        }),
      ]);
      const final = snapshotLang(db, GUILD);
      assert.ok(final === 'en' || final === 'de');
    });
  });

  it('B/G: dashboard + language simultanés + deux langues', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeWriteClient();
      const ctx = {
        client: /** @type {any} */ (client),
        guild: /** @type {any} */ (client._guild),
        db,
        stmts,
        guildId: GUILD,
        actorDiscordUserId: ACTOR,
      };
      await Promise.all([
        applyGuildConfigSectionWrite(ctx, { section: 'language', language: 'it' }),
        handleGuildConfigPatch({
          client: /** @type {any} */ (client),
          db,
          stmts,
          guildId: GUILD,
          body: {
            actor_discord_user_id: ACTOR,
            request_id: 'req-pl',
            source: 'web',
            section: 'language',
            language: 'pl',
          },
        }),
      ]);
      const final = snapshotLang(db, GUILD);
      assert.ok(final === 'it' || final === 'pl');
    });
  });

  it('C: broadcast destinations stables pendant replace réception (txn)', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeWriteClient();
      const ch = '1070686329991602240';
      stmts.upsertGuildScrimReceptionBypass.run({
        guild_id: GUILD,
        bypass_member_minimum: 1,
        note: 'test',
        updated_at: new Date().toISOString(),
        updated_by: ACTOR,
      });
      client._guild.channels.cache.set(ch, {
        id: ch,
        type: 0,
        permissionsFor: () => new PermissionsBitField([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ]),
      });
      client._guild.channels.fetch = async (id) => client._guild.channels.cache.get(id) ?? null;

      await applyGuildConfigSectionWrite(
        {
          client: /** @type {any} */ (client),
          guild: /** @type {any} */ (client._guild),
          db,
          stmts,
          guildId: GUILD,
          actorDiscordUserId: ACTOR,
        },
        { section: 'reception_channel', channel_id: ch },
      );

      const dests = listActiveReceptionDestinationsForGame(stmts, GAME)
        .filter((d) => d.guild_id === GUILD);
      assert.equal(dests.length, 1);
      assert.equal(dests[0].channel_id, ch);
    });
  });

  it('E: SQLITE_BUSY sur language → erreur, DB inchangée', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeWriteClient();
      await applyGuildConfigSectionWrite(
        {
          client: /** @type {any} */ (client),
          guild: /** @type {any} */ (client._guild),
          db,
          stmts,
          guildId: GUILD,
          actorDiscordUserId: ACTOR,
        },
        { section: 'language', language: 'fr' },
      );
      const before = snapshotLang(db, GUILD);
      const orig = stmts.upsertGuildLanguage.run.bind(stmts.upsertGuildLanguage);
      stmts.upsertGuildLanguage.run = () => {
        const err = new Error('database is locked');
        /** @type {any} */ (err).code = 'SQLITE_BUSY';
        throw err;
      };
      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          {
            client: /** @type {any} */ (client),
            guild: /** @type {any} */ (client._guild),
            db,
            stmts,
            guildId: GUILD,
            actorDiscordUserId: ACTOR,
          },
          { section: 'language', language: 'en' },
        ),
      );
      stmts.upsertGuildLanguage.run = orig;
      assert.equal(snapshotLang(db, GUILD), before);
    });
  });

  it('F: reload DB après write', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeWriteClient();
      await applyGuildConfigSectionWrite(
        {
          client: /** @type {any} */ (client),
          guild: /** @type {any} */ (client._guild),
          db,
          stmts,
          guildId: GUILD,
          actorDiscordUserId: ACTOR,
        },
        { section: 'language', language: 'pt' },
      );
      const again = prepareStatements(db);
      assert.equal(again.getGuildLanguage.get(GUILD)?.language, 'pt');
    });
  });

  it('H: /scrim-config pendant activité DB → aucun write', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeWriteClient();
      await applyGuildConfigSectionWrite(
        {
          client: /** @type {any} */ (client),
          guild: /** @type {any} */ (client._guild),
          db,
          stmts,
          guildId: GUILD,
          actorDiscordUserId: ACTOR,
        },
        { section: 'language', language: 'en' },
      );
      const snap = snapshotLang(db, GUILD);
      /** @type {any} */
      const interaction = {
        inGuild: () => true,
        guildId: GUILD,
        guild: { id: GUILD },
        user: { id: ACTOR },
        memberPermissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
        client,
        replied: false,
        deferred: false,
        reply: async (p) => {
          interaction.replied = true;
          return p;
        },
      };
      await Promise.all([
        scrimConfigurer.execute(/** @type {any} */ (interaction), { stmts, db }),
        applyGuildConfigSectionWrite(
          {
            client: /** @type {any} */ (client),
            guild: /** @type {any} */ (client._guild),
            db,
            stmts,
            guildId: GUILD,
            actorDiscordUserId: ACTOR,
          },
          { section: 'language', language: 'de' },
        ),
      ]);
      const final = snapshotLang(db, GUILD);
      assert.ok(final === 'en' || final === 'de');
      assert.notEqual(final, null);
      // /scrim-config n'a pas forcé de régression silencieuse vers null
      assert.ok(final === snap || final === 'de');
    });
  });
});

describe('Phase 0.5 — FREE invariants smoke', () => {
  it('commandList contient language + scrim-config ; pas de Premium', () => {
    const names = commandListWithoutDev.map((c) => c.data.name);
    assert.ok(names.includes('language'));
    assert.ok(names.includes('scrim-config'));
    assert.ok(names.includes('find-scrim'));
    assert.ok(!names.some((n) => /premium/i.test(n)));
  });

  it('FREE destinations max 1 même avec 3 rows', async () => {
    await withTempDb(async (db, stmts) => {
      const now = Date.now();
      for (let i = 0; i < 3; i += 1) {
        stmts.upsertGuildChannel.run({
          guild_id: GUILD,
          channel_id: `chan-${i}`,
          game_key: GAME,
          created_at: now + i,
        });
      }
      const dests = listActiveReceptionDestinationsForGame(stmts, GAME)
        .filter((d) => d.guild_id === GUILD);
      assert.equal(dests.length, 1);
    });
  });
});
