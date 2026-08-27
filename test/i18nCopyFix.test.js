/**
 * FINAL COPY FIX — garde-fous sur les corrections user-facing critiques.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALL_LOCALES,
  de,
  en,
  es,
  fr,
  it as itDict,
  pl,
  pt,
} from '../src/i18n/index.js';

const CATALOGS = { fr, en, es, de, it: itDict, pl, pt };

function placeholders(str) {
  return [...String(str).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe('FINAL COPY FIX — validation.time', () => {
  it('ES not_string never contains cuerda', () => {
    assert.ok(!es['validation.time.not_string'].toLowerCase().includes('cuerda'));
    assert.match(es['validation.time.not_string'], /cadena/i);
  });

  it('required speaks of clock time, not duration, in ES/IT/PT/DE/PL', () => {
    assert.match(es['validation.time.required'], /hora/i);
    assert.ok(!/\btiempo\b/i.test(es['validation.time.required']));

    assert.match(itDict['validation.time.required'], /orario/i);
    assert.ok(!/ci vuole tempo/i.test(itDict['validation.time.required']));

    assert.match(pt['validation.time.required'], /hora/i);
    assert.ok(!/necessário tempo/i.test(pt['validation.time.required']));

    assert.match(de['validation.time.required'], /Uhrzeit/i);
    assert.match(pl['validation.time.required'], /Godzina|godzina/);
  });

  it('invalid_format keeps exact input examples on all 7 locales', () => {
    for (const code of ALL_LOCALES) {
      const msg = CATALOGS[code]['validation.time.invalid_format'];
      assert.ok(msg.includes('20:30'), `${code} missing 20:30`);
      assert.ok(msg.includes('20h30'), `${code} missing 20h30`);
      assert.ok(msg.includes('20h'), `${code} missing 20h`);
      assert.ok(!msg.includes('20:00'), `${code} must not localize 20h to 20:00`);
    }
  });
});

describe('FINAL COPY FIX — findScrim', () => {
  const keys = [
    'findScrim.cooldown',
    'findScrim.scheduledAtError',
    'findScrim.scheduledAtEndError',
    'findScrim.broadcastError',
    'findScrim.zeroDelivery',
    'findScrim.successPersistent',
    'findScrim.bootstrapZeroDelivery',
  ];

  it('scheduledAt errors no longer mention French calendar', () => {
    for (const code of ALL_LOCALES) {
      for (const key of ['findScrim.scheduledAtError', 'findScrim.scheduledAtEndError']) {
        const msg = CATALOGS[code][key].toLowerCase();
        assert.ok(!msg.includes('french calendar'), `${code} ${key}`);
        assert.ok(!msg.includes('calendrier français'), `${code} ${key}`);
        assert.ok(!msg.includes('calendario francés'), `${code} ${key}`);
        assert.ok(!msg.includes('calendario francese'), `${code} ${key}`);
        assert.ok(!msg.includes('französischen kalender'), `${code} ${key}`);
        assert.ok(!msg.includes('kalendarzu francuskim'), `${code} ${key}`);
        assert.ok(!msg.includes('calendário francês'), `${code} ${key}`);
      }
    }
  });

  it('corrected findScrim keys have no (s) plural hack in FR/EN', () => {
    for (const key of keys) {
      assert.ok(!fr[key].includes('(s)'), `fr ${key}`);
      assert.ok(!en[key].includes('(s)'), `en ${key}`);
    }
  });

  it('placeholders unchanged vs FR on corrected keys', () => {
    for (const code of ALL_LOCALES) {
      if (code === 'fr') continue;
      for (const key of keys) {
        assert.deepStrictEqual(
          placeholders(CATALOGS[code][key]),
          placeholders(fr[key]),
          `${code} ${key}`,
        );
      }
    }
  });
});
