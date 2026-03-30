import assert from 'node:assert/strict';
import test from 'node:test';
import { formatParisDisplayFromUtcIso } from '../src/services/scrimEmbedBuilder.js';
import { computeScheduledAtIso } from '../src/utils/scrimScheduledAt.js';

test('CET — 20/01/2026 20:30 interprété comme Paris → 19:30 UTC', () => {
  const iso = computeScheduledAtIso('20/01/2026', '20:30', Date.now());
  assert.match(iso, /^2026-01-20T19:30:00\.?\d*Z$/);
});

test('CEST — 20/07/2026 20:30 interprété comme Paris → 18:30 UTC', () => {
  const iso = computeScheduledAtIso('20/07/2026', '20:30', Date.now());
  assert.match(iso, /^2026-07-20T18:30:00\.?\d*Z$/);
});

test('affichage Intl : ISO UTC → date FR + 20h30 (heure française)', () => {
  const fmt = formatParisDisplayFromUtcIso('2026-01-20T19:30:00.000Z');
  assert.equal(fmt?.dateStr, '20/01/2026');
  assert.equal(fmt?.timeStr, '20h30 (heure française)');
});

test('affichage avec minutes et zéro', () => {
  const fmt = formatParisDisplayFromUtcIso('2026-01-20T08:05:00.000Z');
  assert.equal(fmt?.timeStr, '09h05 (heure française)');
});

test('scheduled_at invalide → null', () => {
  assert.equal(formatParisDisplayFromUtcIso('pas-une-date'), null);
  assert.equal(formatParisDisplayFromUtcIso(''), null);
});
