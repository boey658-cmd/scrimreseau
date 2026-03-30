import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime } from 'luxon';
import {
  parseListeScrimDateFilter,
  parseScrimSearchDate,
} from '../src/utils/validation.js';

const PARIS = 'Europe/Paris';

function ref(y, m, d) {
  return DateTime.fromObject({ year: y, month: m, day: d }, { zone: PARIS });
}

test('22/03/2026 — 23/03 → 23/03/2026 (année courante)', () => {
  const r = parseScrimSearchDate('23/03', { referenceDateTime: ref(2026, 3, 22) });
  assert.equal(r.ok, true);
  assert.equal(/** @type {{ ok: true, value: string }} */ (r).value, '23/03/2026');
});

test('22/03/2026 — 22/03 → 22/03/2026 (aujourd’hui inclus)', () => {
  const r = parseScrimSearchDate('22/03', { referenceDateTime: ref(2026, 3, 22) });
  assert.equal(r.ok, true);
  assert.equal(/** @type {{ ok: true, value: string }} */ (r).value, '22/03/2026');
});

test('22/03/2026 — 21/03 → refus (saut 2027 hors fenêtre)', () => {
  const r = parseScrimSearchDate('21/03', { referenceDateTime: ref(2026, 3, 22) });
  assert.equal(r.ok, false);
  assert.match(/** @type {{ ok: false, error: string }} */ (r).error, /30 prochains jours/);
});

test('20/12/2026 — 05/01 → 05/01/2027 (passage année)', () => {
  const r = parseScrimSearchDate('05/01', { referenceDateTime: ref(2026, 12, 20) });
  assert.equal(r.ok, true);
  assert.equal(/** @type {{ ok: true, value: string }} */ (r).value, '05/01/2027');
});

test('date explicite dans le passé → refus', () => {
  const r = parseScrimSearchDate('10/01/2025', {
    referenceDateTime: ref(2026, 3, 22),
  });
  assert.equal(r.ok, false);
  assert.match(/** @type {{ ok: false, error: string }} */ (r).error, /antérieure/);
});

test('trop loin dans le futur (même année) → refus fenêtre', () => {
  const r = parseScrimSearchDate('25/04/2026', {
    referenceDateTime: ref(2026, 3, 22),
  });
  assert.equal(r.ok, false);
  assert.match(/** @type {{ ok: false, error: string }} */ (r).error, /30 prochains jours/);
});

test('format invalide inchangé', () => {
  const r = parseScrimSearchDate('99/99', { referenceDateTime: ref(2026, 3, 22) });
  assert.equal(r.ok, false);
});

test('liste-scrims : filtre date sans fenêtre 30 j — 15/06 accepté', () => {
  const r = parseListeScrimDateFilter('15/06', { referenceDateTime: ref(2026, 3, 22) });
  assert.equal(r.ok, true);
  assert.equal(/** @type {{ ok: true, value: string }} */ (r).value, '15/06/2026');
});
