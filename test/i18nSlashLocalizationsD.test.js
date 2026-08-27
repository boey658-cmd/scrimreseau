/**
 * BOT-I18N-D — Discord slash command localizations (structure + limites + non-activation).
 *
 * Slash localization ≠ guild language :
 *  - description_localizations → locale client Discord
 *  - réponses bot → getGuildLocale / ENABLED_GUILD_LOCALES
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Locale } from 'discord.js';
import { commandList, commandListWithoutDev } from '../src/commands/index.js';
import { language } from '../src/commands/language.js';
import { ENABLED_GUILD_LOCALES } from '../src/i18n/index.js';
import {
  DISCORD_SLASH_LOCALE_CODES,
  discordLocalizations,
  L,
  slashMeta,
} from '../src/i18n/slashLocalizations.js';

const DESC_MAX = 100;
const NAME_MAX = 32;
/** Discord CHAT_INPUT localized names. */
const NAME_RE = /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

const PUBLIC_EXPECTED = [
  'find-scrim',
  'help-scrim',
  'helpadmin-scrim',
  'list-scrims',
  'my-scrims',
  'scrim-close',
  'scrim-config',
  'scrim-moderation',
  'report-spam',
  'language',
  'structure-link',
];

/**
 * @param {unknown} node
 * @param {(n: Record<string, any>) => void} visit
 */
function walkCommandTree(node, visit) {
  if (!node || typeof node !== 'object') return;
  const n = /** @type {Record<string, any>} */ (node);
  visit(n);
  for (const child of n.options ?? []) {
    walkCommandTree(child, visit);
  }
}

describe('BOT-I18N-D — activation guild (post I18N-ACTIVATION)', () => {
  it('ENABLED_GUILD_LOCALES = 7 locales', () => {
    assert.deepStrictEqual([...ENABLED_GUILD_LOCALES], ['fr', 'en', 'es', 'de', 'it', 'pl', 'pt']);
  });

  it('/language choices values = 7 locales', () => {
    const opt = language.data.toJSON().options?.find((o) => o.name === 'language');
    assert.deepStrictEqual(
      (opt?.choices ?? []).map((c) => c.value),
      ['fr', 'en', 'es', 'de', 'it', 'pl', 'pt'],
    );
  });
});

describe('BOT-I18N-D — codes Discord', () => {
  it('utilise uniquement des Locale discord.js valides (pas de pt-PT inventé)', () => {
    assert.ok(DISCORD_SLASH_LOCALE_CODES.includes(Locale.PortugueseBR));
    assert.ok(!DISCORD_SLASH_LOCALE_CODES.includes(/** @type {any} */ ('pt-PT')));
    const sample = discordLocalizations(L(['a', 'b', 'c', 'd', 'e', 'f', 'g']));
    assert.deepStrictEqual(
      Object.keys(sample).sort(),
      [...DISCORD_SLASH_LOCALE_CODES].sort(),
    );
    assert.equal(sample['pt-BR'], 'g');
    assert.equal(sample['pt-PT'], undefined);
  });
});

describe('BOT-I18N-D — commandes publiques localisées', () => {
  it('toutes les commandes publiques attendues sont enregistrées', () => {
    const names = commandListWithoutDev.map((c) => c.data.name);
    assert.deepStrictEqual(names.sort(), [...PUBLIC_EXPECTED].sort());
  });

  it('noms globaux stables (pas de name_localizations commande)', () => {
    for (const cmd of commandListWithoutDev) {
      const json = cmd.data.toJSON();
      assert.equal(json.name_localizations, undefined, json.name);
      assert.ok(PUBLIC_EXPECTED.includes(json.name), json.name);
    }
  });

  it('chaque commande publique a description + localizations complètes', () => {
    for (const cmd of commandListWithoutDev) {
      const json = cmd.data.toJSON();
      assert.ok(json.description, json.name);
      assert.ok(json.description.length <= DESC_MAX, `${json.name} desc len`);
      const locs = json.description_localizations;
      assert.ok(locs, `${json.name} missing description_localizations`);
      for (const code of DISCORD_SLASH_LOCALE_CODES) {
        assert.equal(typeof locs[code], 'string', `${json.name} ${code}`);
        assert.ok(locs[code].length > 0, `${json.name} ${code} empty`);
        assert.ok(locs[code].length <= DESC_MAX, `${json.name} ${code} >100`);
      }
    }
  });

  it('options user-facing : descriptions localisées + nameLocalizations valides', () => {
    for (const cmd of commandListWithoutDev) {
      const json = cmd.data.toJSON();
      walkCommandTree(json, (node) => {
        // Skip root command (already checked) and subcommand groups without needing name locs
        if (!node.type || node.type === 1 && node.name === json.name) return;
        // Options / subcommands with description
        if (node.description) {
          assert.ok(node.description.length <= DESC_MAX, `${json.name}.${node.name}`);
          if (node.description_localizations) {
            for (const code of DISCORD_SLASH_LOCALE_CODES) {
              const d = node.description_localizations[code];
              assert.equal(typeof d, 'string', `${json.name}.${node.name} ${code}`);
              assert.ok(d.length <= DESC_MAX, `${json.name}.${node.name} ${code} len`);
            }
          }
        }
        if (node.name_localizations) {
          for (const [code, name] of Object.entries(node.name_localizations)) {
            assert.ok(
              DISCORD_SLASH_LOCALE_CODES.includes(/** @type {any} */ (code)),
              `locale invalide ${code}`,
            );
            assert.ok(String(name).length <= NAME_MAX, `${node.name} ${code}`);
            assert.match(String(name), NAME_RE, `${node.name} ${code}=${name}`);
          }
        }
      });
    }
  });

  it('choices : values inchangées (samples métier)', () => {
    const find = commandListWithoutDev.find((c) => c.data.name === 'find-scrim');
    const fearless = find?.data
      .toJSON()
      .options?.find((o) => o.name === 'fearless');
    assert.deepStrictEqual(
      (fearless?.choices ?? []).map((c) => c.value),
      ['oui', 'non', 'nimporte'],
    );
    assert.ok(fearless?.choices?.[0]?.name_localizations?.fr);

    const lang = language.data.toJSON().options?.find((o) => o.name === 'language');
    assert.deepStrictEqual(
      (lang?.choices ?? []).map((c) => c.value),
      ['fr', 'en', 'es', 'de', 'it', 'pl', 'pt'],
    );
    assert.equal(lang?.choices?.[0]?.name_localizations?.['es-ES'], 'Francés');
    assert.equal(lang?.choices?.find((c) => c.value === 'es')?.name_localizations?.de, 'Spanisch');

    const mod = commandListWithoutDev.find((c) => c.data.name === 'scrim-moderation');
    const action = mod?.data
      .toJSON()
      .options?.[0]?.options?.find((o) => o.name === 'action');
    assert.deepStrictEqual(
      (action?.choices ?? []).map((c) => c.value),
      ['block', 'unblock'],
    );
  });
});

describe('BOT-I18N-D — payload buildable (pas d’API Discord)', () => {
  it('toutes les commandes (publiques + dev) produisent un toJSON() valide', () => {
    for (const cmd of commandList) {
      const json = cmd.data.toJSON();
      assert.equal(typeof json.name, 'string');
      assert.equal(typeof json.description, 'string');
      assert.ok(json.description.length <= DESC_MAX, cmd.data.name);
      // Sérialisable
      assert.ok(JSON.stringify(json).length > 10);
    }
  });

  it('dev commands ont au moins description_localizations commande', () => {
    for (const name of ['scrim-dev', 'dashboard-reseau', 'dashboard-admin', 'scrim-channel']) {
      const cmd = commandList.find((c) => c.data.name === name);
      assert.ok(cmd, name);
      const locs = cmd.data.toJSON().description_localizations;
      assert.ok(locs?.fr && locs?.['es-ES'] && locs?.['pt-BR'], name);
    }
  });
});

describe('BOT-I18N-D — meta slashText7 cohérence', () => {
  it('find-scrim meta descriptions ≤ 100', () => {
    for (const [key, text] of Object.entries(slashMeta.findScrim.description)) {
      assert.ok(text.length <= DESC_MAX, `findScrim.description.${key}`);
    }
    for (const [optName, opt] of Object.entries(slashMeta.findScrim.options)) {
      for (const [loc, text] of Object.entries(opt.description)) {
        assert.ok(text.length <= DESC_MAX, `${optName}.description.${loc}`);
      }
      if (opt.name) {
        for (const [loc, text] of Object.entries(opt.name)) {
          assert.match(text, NAME_RE, `${optName}.name.${loc}`);
        }
      }
    }
  });
});

describe('BOT-I18N-D — séparation interaction.locale', () => {
  it('handlers publics n’utilisent pas interaction.locale pour la langue bot', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/commands');
    const files = [
      'rechercheScrim.js',
      'language.js',
      'listeScrims.js',
      'help.js',
      'scrimTrouve.js',
      'mesDemandes.js',
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      const withoutComments = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      assert.doesNotMatch(
        withoutComments,
        /interaction\.locale/,
        `${f} ne doit pas lire interaction.locale pour i18n bot`,
      );
      assert.match(src, /getGuildLocale/, f);
    }
  });
});
