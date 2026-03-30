import assert from 'node:assert/strict';
import test from 'node:test';
import { expandRankKeysForListeFilter } from '../src/services/listeScrimsQuery.js';

test('rang simple → rang + plages catalogue qui touchent ce rang', () => {
  assert.deepEqual(expandRankKeysForListeFilter('Platine'), [
    'Platine',
    'Or / Platine',
    'Platine / Émeraude',
  ]);
});

test('rang composite → libellé + deux composantes', () => {
  assert.deepEqual(
    expandRankKeysForListeFilter('Platine / Émeraude'),
    ['Platine / Émeraude', 'Platine', 'Émeraude'],
  );
});

test('Mix niveau → une clé', () => {
  assert.deepEqual(expandRankKeysForListeFilter('Mix niveau'), ['Mix niveau']);
});

test('Bronze inclut Bronze / Argent', () => {
  assert.deepEqual(expandRankKeysForListeFilter('Bronze'), [
    'Bronze',
    'Bronze / Argent',
  ]);
});

test('Argent inclut Bronze / Argent et Argent / Or', () => {
  assert.deepEqual(expandRankKeysForListeFilter('Argent'), [
    'Argent',
    'Bronze / Argent',
    'Argent / Or',
  ]);
});

test('Grandmaster inclut les plages adjacentes', () => {
  assert.deepEqual(expandRankKeysForListeFilter('Grandmaster'), [
    'Grandmaster',
    'Master / Grandmaster',
    'Grandmaster / Challenger',
  ]);
});
