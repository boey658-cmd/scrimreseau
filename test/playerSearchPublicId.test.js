import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allocatePlayerSearchPublicId,
  formatPlayerSearchPublicId,
  normalizePlayerSearchPublicId,
  parsePlayerSearchPublicIdNumber,
  PLAYER_SEARCH_PUBLIC_ID_MAX,
} from '../src/services/playerSearchPublicId.js';

test('normalizePlayerSearchPublicId — j3 → J3', () => {
  assert.equal(normalizePlayerSearchPublicId('j3'), 'J3');
  assert.equal(normalizePlayerSearchPublicId(' J3 '), 'J3');
  assert.equal(normalizePlayerSearchPublicId('J3'), 'J3');
});

test('normalizePlayerSearchPublicId — rejette les formats invalides', () => {
  assert.equal(normalizePlayerSearchPublicId(''), null);
  assert.equal(normalizePlayerSearchPublicId('3'), null);
  assert.equal(normalizePlayerSearchPublicId('X3'), null);
  assert.equal(normalizePlayerSearchPublicId('J0'), null);
  assert.equal(
    normalizePlayerSearchPublicId(`J${PLAYER_SEARCH_PUBLIC_ID_MAX + 1}`),
    null,
  );
});

test('parsePlayerSearchPublicIdNumber — extrait le numéro', () => {
  assert.equal(parsePlayerSearchPublicIdNumber('J42'), 42);
  assert.equal(parsePlayerSearchPublicIdNumber('j42'), 42);
  assert.equal(parsePlayerSearchPublicIdNumber('bad'), null);
});

test('formatPlayerSearchPublicId — formate J{n}', () => {
  assert.equal(formatPlayerSearchPublicId(1), 'J1');
  assert.equal(formatPlayerSearchPublicId(9999), 'J9999');
  assert.throws(() => formatPlayerSearchPublicId(0));
});

test('allocatePlayerSearchPublicId — pool vide → J1', () => {
  const stmts = {
    listActivePlayerSearchPublicIds: {
      all: () => [],
    },
  };
  assert.equal(allocatePlayerSearchPublicId(stmts), 'J1');
});

test('allocatePlayerSearchPublicId — J1 actif → J2', () => {
  const stmts = {
    listActivePlayerSearchPublicIds: {
      all: () => [{ player_search_public_id: 'J1' }],
    },
  };
  assert.equal(allocatePlayerSearchPublicId(stmts), 'J2');
});

test('allocatePlayerSearchPublicId — J1 et J3 actifs → J2', () => {
  const stmts = {
    listActivePlayerSearchPublicIds: {
      all: () => [
        { player_search_public_id: 'J1' },
        { player_search_public_id: 'J3' },
      ],
    },
  };
  assert.equal(allocatePlayerSearchPublicId(stmts), 'J2');
});

test('allocatePlayerSearchPublicId — J1 fermé réutilisable → J1', () => {
  const stmts = {
    listActivePlayerSearchPublicIds: {
      all: () => [{ player_search_public_id: 'J2' }],
    },
  };
  assert.equal(allocatePlayerSearchPublicId(stmts), 'J1');
});

test('allocatePlayerSearchPublicId — pool plein → null', () => {
  const rows = [];
  for (let n = 1; n <= PLAYER_SEARCH_PUBLIC_ID_MAX; n += 1) {
    rows.push({ player_search_public_id: `J${n}` });
  }
  const stmts = {
    listActivePlayerSearchPublicIds: { all: () => rows },
  };
  assert.equal(allocatePlayerSearchPublicId(stmts), null);
});
