/**
 * BOT-I18N-C — cleanup hardcodes user-facing runtime + garde-fous.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { language } from '../src/commands/language.js';
import {
  ALL_LOCALES,
  ENABLED_GUILD_LOCALES,
  createTranslator,
  de,
  en,
  es,
  fr,
  intlLocaleForBotLocale,
  it as itDict,
  pl,
  pt,
  t,
} from '../src/i18n/index.js';
import {
  FEARLESS_VALUE_OUI,
  formatFearlessLineForEmbed,
} from '../src/services/scrimEmbedBuilder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CATALOGS = { fr, en, es, de, it: itDict, pl, pt };

/** Fichiers runtime critiques à scanner (pas de regex global naïf). */
const CRITICAL_FILES = [
  'src/commands/configScrimPermissions.js',
  'src/commands/blacklist.js',
  'src/commands/unblacklist.js',
  'src/commands/dashboardAdmin.js',
  'src/commands/dashboardReseau.js',
  'src/commands/scrimChannel.js',
  'src/commands/scrimDev.js',
  'src/commands/scrimDevGuildAccess.js',
  'src/commands/scrimDevReceptionList.js',
  'src/commands/scrimDevGuildList.js',
  'src/services/networkDashboard.js',
  'src/services/scrimEmbedBuilder.js',
];

/** Chaînes FR user-facing évidentes encore hardcodées (hors logs). */
const FORBIDDEN_LITERALS = [
  "toLocaleString('fr-FR'",
  'toLocaleString("fr-FR"',
  "toLocaleDateString('fr-FR'",
  'toLocaleDateString("fr-FR"',
  "toLocaleTimeString('fr-FR'",
  'toLocaleTimeString("fr-FR"',
  '🌐 ScrimRéseau — Tableau de bord',
  '🏆 Serveurs partenaires',
  'Mise à jour le ${',
  '❌ Impossible de blacklister le bot.',
  '✅ Utilisateur blacklisté de façon permanente.',
  '❌ Cette commande est réservée au propriétaire de ScrimRéseau.',
  'SCRIM_STATUS_LINE_',
];

describe('BOT-I18N-C — activation guild (post I18N-ACTIVATION)', () => {
  it('ENABLED_GUILD_LOCALES = 7 locales', () => {
    assert.deepStrictEqual([...ENABLED_GUILD_LOCALES], ['fr', 'en', 'es', 'de', 'it', 'pl', 'pt']);
  });

  it('/language choices = 7 locales', () => {
    const opt = language.data.toJSON().options?.find((o) => o.name === 'language');
    const values = (opt?.choices ?? []).map((c) => c.value);
    assert.deepStrictEqual(values, ['fr', 'en', 'es', 'de', 'it', 'pl', 'pt']);
  });
});

describe('BOT-I18N-C — parité nouvelles clés', () => {
  it('mêmes clés sur les 7 locales', () => {
    const ref = Object.keys(fr).sort();
    assert.ok(ref.length >= 280, `attendu ≥280 clés, got ${ref.length}`);
    for (const code of ALL_LOCALES) {
      assert.deepStrictEqual(Object.keys(CATALOGS[code]).sort(), ref, code);
    }
  });

  it('clés permissions / networkDashboard / embed.fearless présentes', () => {
    for (const key of [
      'permissions.okPrefix',
      'networkDashboard.embedTitle',
      'networkDashboard.footerUpdated',
      'embed.fearlessOui',
      'dev.denied',
      'dev.blacklistPermanent',
    ]) {
      assert.equal(typeof fr[key], 'string', key);
      assert.notEqual(t('es', key), en[key], `ES doit différer d’EN pour ${key}`);
    }
  });
});

describe('BOT-I18N-C — Intl locale mapping', () => {
  it('mappe bot locale → BCP 47', () => {
    assert.equal(intlLocaleForBotLocale('fr'), 'fr-FR');
    assert.equal(intlLocaleForBotLocale('en'), 'en-GB');
    assert.equal(intlLocaleForBotLocale('es'), 'es-ES');
    assert.equal(intlLocaleForBotLocale('de'), 'de-DE');
    assert.equal(intlLocaleForBotLocale('it'), 'it-IT');
    assert.equal(intlLocaleForBotLocale('pl'), 'pl-PL');
    assert.equal(intlLocaleForBotLocale('pt'), 'pt-PT');
  });
});

describe('BOT-I18N-C — permissions via translator', () => {
  it('FR / EN / ES distincts pour messages permissions', () => {
    const frT = createTranslator('fr');
    const enT = createTranslator('en');
    const esT = createTranslator('es');
    assert.equal(frT('permissions.okPrefix'), fr['permissions.okPrefix']);
    assert.equal(enT('permissions.okPrefix'), en['permissions.okPrefix']);
    assert.equal(esT('permissions.okPrefix'), es['permissions.okPrefix']);
    assert.notEqual(frT('permissions.okPrefix'), enT('permissions.okPrefix'));
    assert.notEqual(esT('permissions.dbError'), enT('permissions.dbError'));
  });
});

describe('BOT-I18N-C — fearless line', () => {
  it('FR / EN non-régression + ES traduit', () => {
    const frLine = formatFearlessLineForEmbed(FEARLESS_VALUE_OUI, 'fr');
    const enLine = formatFearlessLineForEmbed(FEARLESS_VALUE_OUI, 'en');
    const esLine = formatFearlessLineForEmbed(FEARLESS_VALUE_OUI, 'es');
    const deLine = formatFearlessLineForEmbed(FEARLESS_VALUE_OUI, 'de');
    assert.match(String(frLine), /Fearless : Oui/);
    assert.match(String(enLine), /Fearless: Yes/);
    assert.ok(esLine && !esLine.includes('Fearless : Oui'));
    assert.ok(deLine && !deLine.includes('Fearless : Oui'));
    assert.ok(String(esLine).includes(es['embed.fearlessOui']));
    assert.ok(String(deLine).includes(de['embed.fearlessOui']));
  });
});

describe('BOT-I18N-C — status lines mortes', () => {
  it('SCRIM_STATUS_LINE_* absentes du builder (pas de réactivation)', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src/services/scrimEmbedBuilder.js'),
      'utf8',
    );
    assert.doesNotMatch(src, /SCRIM_STATUS_LINE_/);
    assert.match(src, /Status lines FR historiques volontairement SUPPRIMÉES/);
  });
});

describe('BOT-I18N-C — hardcode scan fichiers critiques', () => {
  it('pas de littéraux FR / fr-FR / MSG_* évidents dans zones migrées', () => {
    for (const rel of CRITICAL_FILES) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const lit of FORBIDDEN_LITERALS) {
        assert.ok(
          !src.includes(lit),
          `${rel} contient encore le littéral interdit: ${lit}`,
        );
      }
      // MSG_* FR inline (hors exports deprecated pointant vers fr['…'])
      const msgInline = [...src.matchAll(/const MSG_[A-Z0-9_]+\s*=\s*'[^']*[àéèêùûôîç]/g)];
      assert.equal(
        msgInline.length,
        0,
        `${rel} MSG_* FR inline: ${msgInline.map((m) => m[0]).join(' | ')}`,
      );
    }
  });
});

describe('BOT-I18N-C — network dashboard i18n keys', () => {
  it('footer locale-aware (placeholders date/time)', () => {
    const frFooter = t('fr', 'networkDashboard.footerUpdated', {
      date: '27/08/2026',
      time: '19:00',
    });
    const enFooter = t('en', 'networkDashboard.footerUpdated', {
      date: '27/08/2026',
      time: '19:00',
    });
    assert.match(frFooter, /Mise à jour/);
    assert.match(enFooter, /Updated/);
    assert.ok(frFooter.includes('27/08/2026'));
  });
});

describe('BOT-I18N-C — admin/dev sample', () => {
  it('dev.denied / blacklist / dashboard keys résolues EN ≠ FR', () => {
    assert.notEqual(t('fr', 'dev.denied'), t('en', 'dev.denied'));
    assert.notEqual(t('fr', 'dev.blacklistBot'), t('de', 'dev.blacklistBot'));
    assert.match(t('fr', 'dev.dashboardConfigured', { channel: '#x' }), /#x/);
  });
});
