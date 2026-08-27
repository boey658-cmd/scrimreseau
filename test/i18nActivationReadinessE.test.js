/**
 * BOT-I18N-E — linguistic / product QA + activation readiness (sans activation).
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
import { I18N_GLOSSARY } from '../src/i18n/glossary.js';
import {
  DISCORD_SLASH_LOCALE_CODES,
  slashMeta,
} from '../src/i18n/slashLocalizations.js';

const CATALOGS = { fr, en, es, de, it: itDict, pl, pt };
const TARGET = /** @type {const} */ (['es', 'de', 'it', 'pl', 'pt']);

/** Clés autorisées à rester identiques à EN. */
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
  'scrimConfig.permRoles',
  'dev.dashboardStatusOk',
]);

function placeholders(str) {
  return [...String(str).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe('BOT-I18N-E — activation guild (post I18N-ACTIVATION)', () => {
  it('ENABLED_GUILD_LOCALES = 7 locales', () => {
    assert.deepStrictEqual([...ENABLED_GUILD_LOCALES], ['fr', 'en', 'es', 'de', 'it', 'pl', 'pt']);
  });

  it('/language choices values = 7 locales', () => {
    const opt = language.data.toJSON().options?.find((o) => o.name === 'language');
    assert.deepStrictEqual((opt?.choices ?? []).map((c) => c.value), ['fr', 'en', 'es', 'de', 'it', 'pl', 'pt']);
  });

  it('ALL_LOCALES technique inchangé', () => {
    assert.deepStrictEqual([...ALL_LOCALES], ['fr', 'en', 'es', 'de', 'it', 'pl', 'pt']);
  });
});

describe('BOT-I18N-E — glossaire documenté', () => {
  it('glossaire présent pour ES/DE/IT/PL/PT + contrainte pt Discord', () => {
    for (const loc of TARGET) {
      assert.ok(I18N_GLOSSARY[loc], loc);
      assert.equal(typeof I18N_GLOSSARY[loc].server, 'string');
      assert.equal(typeof I18N_GLOSSARY[loc].channel, 'string');
    }
    assert.match(I18N_GLOSSARY.note.ptDiscordConstraint, /pt-BR/);
    assert.equal(I18N_GLOSSARY.pt.dialect.includes('pt-PT'), true);
  });
});

describe('BOT-I18N-E — parité + placeholders', () => {
  it('mêmes clés 7 locales', () => {
    const ref = Object.keys(fr).sort();
    for (const code of ALL_LOCALES) {
      assert.deepStrictEqual(Object.keys(CATALOGS[code]).sort(), ref, code);
    }
  });

  it('placeholders identiques à FR', () => {
    for (const code of TARGET) {
      for (const key of Object.keys(fr)) {
        assert.deepStrictEqual(
          placeholders(CATALOGS[code][key]),
          placeholders(fr[key]),
          `${code} ${key}`,
        );
      }
    }
  });

  it('pas d’égalité EN hors allowlist', () => {
    const offenders = [];
    for (const code of TARGET) {
      for (const key of Object.keys(fr)) {
        if (CATALOGS[code][key] === en[key] && !EQUAL_EN_ALLOWLIST.has(key)) {
          offenders.push(`${code}.${key}`);
        }
      }
    }
    assert.deepStrictEqual(offenders, []);
  });
});

describe('BOT-I18N-E — anti pluriel (s) cassé', () => {
  it('pas de constructions type seconde(s) / servidor(es) dans les 5 locales', () => {
    const re = /\([esEn]\)|\(s\)|\(e\)|\(n\)|\(en\)|\(i\)/i;
    const hits = [];
    for (const code of TARGET) {
      for (const [key, value] of Object.entries(CATALOGS[code])) {
        if (re.test(value)) hits.push(`${code}.${key}`);
      }
    }
    assert.deepStrictEqual(hits, []);
  });
});

describe('BOT-I18N-E — pt-PT anti-BR', () => {
  it('refuse vocabulaire / tutoiement pt-BR évident', () => {
    const brRe = /\b(você|voce|usuário)\b|Por favor, tente|\bTente novamente\b/;
    const hits = [];
    for (const [key, value] of Object.entries(pt)) {
      if (brRe.test(value)) hits.push(`${key}: ${value.slice(0, 80)}`);
    }
    assert.deepStrictEqual(hits, []);
  });

  it('utilise utilizador / cargos Discord dans zones sensibles', () => {
    assert.match(pt['generic.blacklistedUser'], /ScrimRéseau/);
    assert.match(pt['scrimConfig.permRoles'], /^Cargos:/);
    assert.match(pt['scrimModeration.blockBot'], /Não podes/);
    assert.match(pt['reportSpam.selfReport'], /Não te podes/);
  });
});

describe('BOT-I18N-E — samples critiques corrigés', () => {
  it('ES : solo / difundir / canal de denuncias', () => {
    assert.match(es['lifecycle.notAuthor'], /Solo puedes/);
    assert.match(es['scrimModeration.blockSuccess'], /difundirán/);
    assert.match(es['reportSpam.noChannel'], /Canal de denuncias/);
    assert.doesNotMatch(es['findScrim.broadcastError'], /servidor\(es\)/);
  });

  it('DE : Sekunden / Ankündigungskanal / für Scrims', () => {
    assert.match(de['findScrim.cooldown'], /Sekunden/);
    assert.match(de['scrimConfig.chanAnnSet'], /Ankündigungskanal/);
    assert.match(de['scrimModeration.alreadyBlocked'], /für Scrims/);
    assert.doesNotMatch(de['scrimModeration.blockSuccess'], /ausgestrahlt/);
  });

  it('IT : sans Per favore excessif + server configurati', () => {
    assert.doesNotMatch(itDict['findScrim.broadcastError'], /Per favore/);
    assert.match(itDict['findScrim.broadcastError'], /server configurati/);
    assert.match(itDict['reportSpam.success'], /Segnalazione/);
  });

  it('PL : limit neutre + dla scrimów', () => {
    assert.match(pl['findScrim.windowLimit'], /Osiągnięto limit/);
    assert.match(pl['scrimModeration.alreadyBlocked'], /dla scrimów/);
    assert.match(pl['reportSpam.success'], /Zgłoszenie/);
  });

  it('Fearless / scrim conservés', () => {
    for (const code of TARGET) {
      assert.match(CATALOGS[code]['embed.fearlessOui'], /Fearless/);
      assert.match(t(code, 'findScrim.lock'), /scrim/i);
    }
  });
});

describe('BOT-I18N-E — slash metadata sanity', () => {
  it('descriptions find-scrim ≤ 100 ; Discord locales sans pt-PT inventé', () => {
    for (const text of Object.values(slashMeta.findScrim.description)) {
      assert.ok(text.length <= 100, text);
    }
    assert.ok(DISCORD_SLASH_LOCALE_CODES.includes('pt-BR'));
    assert.ok(!DISCORD_SLASH_LOCALE_CODES.includes(/** @type {any} */ ('pt-PT')));
  });
});

/**
 * Divergences FR/EN documentées (pas de modification FR/EN dans E).
 * Call sites : validation calendrier Paris / messages confirmation langue.
 */
export const FR_EN_DIVERGENCES_DOCUMENTED = Object.freeze([
  {
    key: 'findScrim.scheduledAtError',
    fr: fr['findScrim.scheduledAtError'],
    en: en['findScrim.scheduledAtError'],
    note:
      'FR mentionne « calendrier français » (timezone Paris produit). EN dit « French calendar ». Comportement métier identique — conserver.',
  },
  {
    key: 'language.successFr / language.successEn',
    fr: fr['language.successFr'],
    en: en['language.successEn'],
    note:
      'Messages de confirmation volontairement monolingues selon la langue choisie (pas une paire traduite).',
  },
  {
    key: 'generic.* tutoiement',
    fr: 'FR mélange parfois tu (blacklistedUser) et vous (error/admin).',
    en: 'EN uses neutral you.',
    note: 'Divergence historique FR — hors scope E (pas de rewrite FR massif).',
  },
]);

describe('BOT-I18N-E — divergences FR/EN documentées', () => {
  it('registre des divergences non bloquantes disponible', () => {
    assert.ok(FR_EN_DIVERGENCES_DOCUMENTED.length >= 2);
    assert.match(FR_EN_DIVERGENCES_DOCUMENTED[0].key, /scheduledAt/);
  });
});
