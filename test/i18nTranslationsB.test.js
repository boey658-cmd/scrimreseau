/**
 * BOT-I18N-B — vraies traductions ES/DE/IT/PL/PT + garde-fous non-activation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { language } from '../src/commands/language.js';
import {
  ALL_LOCALES,
  ENABLED_GUILD_LOCALES,
  de,
  en,
  es,
  fr,
  it as itDict,
  pl,
  pt,
  t,
} from '../src/i18n/index.js';

const CATALOGS = { fr, en, es, de, it: itDict, pl, pt };
const TARGET = /** @type {const} */ (['es', 'de', 'it', 'pl', 'pt']);

/** Clés autorisées à rester identiques à EN (noms propres / slash / rangs EN). */
const EQUAL_EN_ALLOWLIST = new Set([
  'language.successFr',
  'language.successEn',
  'helpAdmin.scrimConfigTitle',
  'helpAdmin.moderationTitle',
  'helpAdmin.reportSpamTitle',
  'rank.bronze',
  'rank.or',
  'rank.master',
  'rank.grandmaster',
  'rank.challenger',
  'embed.fearlessOui',
  'embed.fearlessNon',
  'embed.fearlessNimporte',
  'listScrims.fearlessYes',
  'listScrims.fearlessNo',
  'listeQuery.fearlessYes',
  'listeQuery.fearlessNo',
  'scrimConfig.permRoles', // "Roles: {list}" — Roles = même mot ES/EN
  'dev.dashboardStatusOk', // "✅ OK" volontairement identique
]);

function placeholders(str) {
  return [...String(str).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe('BOT-I18N-B — activation guild (post I18N-ACTIVATION)', () => {
  it('ENABLED_GUILD_LOCALES = 7 locales', () => {
    assert.deepStrictEqual([...ENABLED_GUILD_LOCALES], ['fr', 'en', 'es', 'de', 'it', 'pl', 'pt']);
  });

  it('/language choices = 7 locales', () => {
    const opt = language.data.toJSON().options?.find((o) => o.name === 'language');
    const values = (opt?.choices ?? []).map((c) => c.value);
    assert.deepStrictEqual(values, ['fr', 'en', 'es', 'de', 'it', 'pl', 'pt']);
  });
});

describe('BOT-I18N-B — parité + placeholders', () => {
  it('mêmes clés que FR pour les 7 locales', () => {
    const ref = Object.keys(fr).sort();
    for (const code of ALL_LOCALES) {
      assert.deepStrictEqual(Object.keys(CATALOGS[code]).sort(), ref, code);
    }
  });

  it('placeholders identiques à FR pour chaque clé/locale', () => {
    for (const code of TARGET) {
      const catalog = CATALOGS[code];
      for (const key of Object.keys(fr)) {
        assert.deepStrictEqual(
          placeholders(catalog[key]),
          placeholders(fr[key]),
          `${code} ${key}`,
        );
      }
    }
  });

  it('pas de string vide', () => {
    for (const code of TARGET) {
      for (const [key, value] of Object.entries(CATALOGS[code])) {
        assert.ok(typeof value === 'string' && value.length > 0, `${code}.${key}`);
      }
    }
  });

  it('égalité EN limitée à allowlist explicite', () => {
    const offenders = [];
    for (const code of TARGET) {
      const catalog = CATALOGS[code];
      for (const key of Object.keys(fr)) {
        if (catalog[key] === en[key] && !EQUAL_EN_ALLOWLIST.has(key)) {
          offenders.push(`${code}.${key}`);
        }
      }
    }
    assert.deepStrictEqual(offenders, [], `traductions manquantes: ${offenders.join(', ')}`);
  });
});

describe('BOT-I18N-B — longueurs Discord critiques', () => {
  it('labels boutons scrimConfig ≤ 80', () => {
    const buttonKeys = Object.keys(fr).filter(
      (k) => k.startsWith('scrimConfig.btn') || k.startsWith('scrimConfig.resetBtn')
        || k === 'scrimConfig.resetConfirmOk' || k === 'scrimConfig.resetConfirmCancel'
        || k === 'embed.joinServerButton',
    );
    for (const code of TARGET) {
      for (const key of buttonKeys) {
        const v = CATALOGS[code][key];
        assert.ok(v.length <= 80, `${code}.${key} len=${v.length}`);
      }
    }
  });

  it('placeholders select ≤ 150', () => {
    const keys = Object.keys(fr).filter((k) => k.includes('placeholder') || k.includes('Placeholder'));
    for (const code of TARGET) {
      for (const key of keys) {
        assert.ok(CATALOGS[code][key].length <= 150, `${code}.${key}`);
      }
    }
  });

  it('titres embed principaux ≤ 256', () => {
    const titleKeys = [
      'help.title',
      'helpAdmin.title',
      'myScrims.embedTitle',
      'scrimConfig.mainTitle',
      'scrimConfig.salonsTitle',
      'scrimConfig.permsTitle',
      'scrimConfig.msgsTitle',
      'scrimConfig.resetTitle',
      'scrimConfig.resetConfirmTitle',
    ];
    for (const code of TARGET) {
      for (const key of titleKeys) {
        assert.ok(CATALOGS[code][key].length <= 256, `${code}.${key}`);
      }
    }
  });
});

describe('BOT-I18N-B — samples par locale', () => {
  const cases = [
    ['es', 'generic.error', /error|Error|error/i],
    ['es', 'findScrim.cooldown', /\{seconds\}/],
    ['es', 'embed.joinServerButton', /ScrimRéseau/],
    ['de', 'generic.error', /Fehler/],
    ['de', 'findScrim.cooldown', /\{seconds\}/],
    ['de', 'embed.joinServerButton', /ScrimRéseau/],
    ['it', 'generic.error', /errore/i],
    ['it', 'findScrim.cooldown', /\{seconds\}/],
    ['it', 'embed.joinServerButton', /ScrimRéseau/],
    ['pl', 'generic.error', /błąd|Blad|Błąd/i],
    ['pl', 'findScrim.cooldown', /\{seconds\}/],
    ['pl', 'embed.joinServerButton', /ScrimRéseau/],
    ['pt', 'generic.error', /erro/i],
    ['pt', 'findScrim.cooldown', /\{seconds\}/],
    ['pt', 'embed.joinServerButton', /ScrimRéseau/],
  ];

  for (const [locale, key, re] of cases) {
    it(`${locale} ${key}`, () => {
      const value = t(/** @type {any} */ (locale), key);
      assert.notEqual(value, en[key], 'ne doit pas être un placeholder EN brut (sauf allowlist)');
      if (!EQUAL_EN_ALLOWLIST.has(key)) {
        assert.notEqual(value, `[${key}]`);
      }
      assert.match(value, re);
    });
  }

  it('pt-PT : pas de usuário brésilien dans validation.contact', () => {
    assert.ok(!/usuário/i.test(pt['validation.contact.missing']));
    assert.match(pt['validation.contact.missing'], /utilizador/i);
  });
});

describe('BOT-I18N-B — markdown slash préservés (spot)', () => {
  it('commandes slash présentes dans findScrim.success', () => {
    for (const code of TARGET) {
      assert.match(CATALOGS[code]['findScrim.success'], /\/scrim-close/);
    }
  });

  it('bold ** conservés quand présents en FR', () => {
    for (const code of TARGET) {
      const frBold = (fr['listScrims.dateRequiredForTime'].match(/\*\*/g) || []).length;
      const locBold = (CATALOGS[code]['listScrims.dateRequiredForTime'].match(/\*\*/g) || []).length;
      assert.equal(locBold, frBold, code);
    }
  });
});
