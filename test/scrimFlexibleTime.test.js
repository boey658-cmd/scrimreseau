import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { buildScrimEmbed, formatParisFlexibleTimeRange } from '../src/services/scrimEmbedBuilder.js';
import { computeScheduledAtIso } from '../src/utils/scrimScheduledAt.js';
import { validateOptionalFlexibleEndTime } from '../src/utils/validation.js';

test('heure fixe : pas d’heure max → validation value null', () => {
  const r = validateOptionalFlexibleEndTime('19:00', '');
  assert.equal(r.ok, true);
  assert.equal(r.value, null);
});

test('horaire flexible valide', () => {
  const r = validateOptionalFlexibleEndTime('19:00', '21:00');
  assert.equal(r.ok, true);
  assert.equal(r.value, '21:00');
});

test('heure max avant ou égale heure début → refus', () => {
  const r = validateOptionalFlexibleEndTime('21:00', '19:00');
  assert.equal(r.ok, false);
  const r2 = validateOptionalFlexibleEndTime('19:00', '19:00');
  assert.equal(r2.ok, false);
});

test('plage > 12 h → refus', () => {
  const r = validateOptionalFlexibleEndTime('08:00', '21:01');
  assert.equal(r.ok, false);
});

test('expiration : COALESCE(scheduled_at_end, scheduled_at) garde la scrim active si fin future', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE scrim_posts (
      id INTEGER PRIMARY KEY,
      status TEXT,
      scheduled_at TEXT,
      scheduled_at_end TEXT
    );
    INSERT INTO scrim_posts (id, status, scheduled_at, scheduled_at_end) VALUES
      (1, 'active', '2020-01-01T00:00:00.000Z', '2035-01-01T12:00:00.000Z');
  `);
  const row = db
    .prepare(
      `
      SELECT id FROM scrim_posts
      WHERE status = 'active'
        AND (
          scheduled_at IS NULL
          OR scheduled_at = ''
          OR COALESCE(NULLIF(trim(scheduled_at_end), ''), scheduled_at) < @now_iso
        )
    `,
    )
    .get({ now_iso: new Date().toISOString() });
  assert.equal(row, undefined);
  db.close();
});

test('expiration : priorité à scheduled_at_end quand présent', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE scrim_posts (
      id INTEGER PRIMARY KEY,
      status TEXT,
      scheduled_at TEXT,
      scheduled_at_end TEXT
    );
    INSERT INTO scrim_posts (id, status, scheduled_at, scheduled_at_end) VALUES
      (1, 'active', '2030-01-01T12:00:00.000Z', '2020-01-01T12:00:00.000Z');
  `);
  const row = db
    .prepare(
      `
      SELECT id FROM scrim_posts
      WHERE status = 'active'
        AND (
          scheduled_at IS NULL
          OR scheduled_at = ''
          OR COALESCE(NULLIF(trim(scheduled_at_end), ''), scheduled_at) < @now_iso
        )
    `,
    )
    .get({ now_iso: new Date().toISOString() });
  assert.equal(row?.id, 1);
  db.close();
});

test('affichage embed : plage compacte Paris', () => {
  const start = computeScheduledAtIso('20/01/2026', '19:00', Date.now());
  const end = computeScheduledAtIso('20/01/2026', '21:00', Date.now());
  const range = formatParisFlexibleTimeRange(start, end);
  assert.equal(range, '19h–21h');
  const embed = buildScrimEmbed({
    gameKey: 'league_of_legends',
    rank: 'Or',
    dateStr: '20/01/2026',
    timeStr: '19:00',
    format: 'BO1',
    contactUserId: '123',
    scheduledAtIso: start,
    scheduledAtEndIso: end,
  });
  const desc = embed.data.description ?? '';
  assert.match(desc, /19h–21h/);
});

test('affichage embed : heure seule inchangée (sans fin)', () => {
  const start = computeScheduledAtIso('20/01/2026', '19:30', Date.now());
  const embed = buildScrimEmbed({
    gameKey: 'league_of_legends',
    rank: 'Or',
    dateStr: '20/01/2026',
    timeStr: '19:00',
    format: 'BO1',
    contactUserId: '123',
    scheduledAtIso: start,
    scheduledAtEndIso: null,
  });
  const desc = embed.data.description ?? '';
  assert.match(desc, /19h30 \(heure française\)/);
});
