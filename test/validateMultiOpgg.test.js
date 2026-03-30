import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMultiOpggEmbedFieldValue,
  LEAGUE_GAME_KEY,
  MSG_MULTI_OPGG_INVALID,
  MSG_MULTI_OPGG_WRONG_GAME,
  MULTI_OPGG_MAX_LEN,
  validateMultiOpggUrl,
} from '../src/utils/validateMultiOpgg.js';

test('absent ou vide → null (LoL)', () => {
  assert.deepEqual(validateMultiOpggUrl(undefined, LEAGUE_GAME_KEY), {
    ok: true,
    value: null,
  });
  assert.deepEqual(validateMultiOpggUrl('', LEAGUE_GAME_KEY), {
    ok: true,
    value: null,
  });
  assert.deepEqual(validateMultiOpggUrl('  ', LEAGUE_GAME_KEY), {
    ok: true,
    value: null,
  });
});

test('autre jeu sans saisie → null', () => {
  assert.deepEqual(validateMultiOpggUrl(null, 'valorant'), {
    ok: true,
    value: null,
  });
});

test('autre jeu avec saisie → refus', () => {
  const r = validateMultiOpggUrl('https://www.op.gg/x', 'valorant');
  assert.equal(r.ok, false);
  assert.equal(r.error, MSG_MULTI_OPGG_WRONG_GAME);
});

test('URL HTTPS www.op.gg valide', () => {
  const r = validateMultiOpggUrl(
    'https://www.op.gg/multisearch/euw/s1-s2',
    LEAGUE_GAME_KEY,
  );
  assert.equal(r.ok, true);
  assert.equal(r.value, 'https://www.op.gg/multisearch/euw/s1-s2');
});

test('URL HTTPS op.gg (sans www) valide', () => {
  const r = validateMultiOpggUrl('https://op.gg/summoners/euw/a', LEAGUE_GAME_KEY);
  assert.equal(r.ok, true);
  assert.equal(r.value, 'https://op.gg/summoners/euw/a');
});

test('HTTP interdit', () => {
  const r = validateMultiOpggUrl('http://www.op.gg/x', LEAGUE_GAME_KEY);
  assert.equal(r.ok, false);
  assert.equal(r.error, MSG_MULTI_OPGG_INVALID);
});

test('sous-domaine autre que www interdit', () => {
  const r = validateMultiOpggUrl('https://euw.op.gg/x', LEAGUE_GAME_KEY);
  assert.equal(r.ok, false);
  assert.equal(r.error, MSG_MULTI_OPGG_INVALID);
});

test('hôte trompeur interdit', () => {
  const r = validateMultiOpggUrl('https://op.gg.malice.test/x', LEAGUE_GAME_KEY);
  assert.equal(r.ok, false);
});

test('espaces / multi-lien interdits', () => {
  assert.equal(
    validateMultiOpggUrl('https://op.gg/a https://op.gg/b', LEAGUE_GAME_KEY).ok,
    false,
  );
  assert.equal(
    validateMultiOpggUrl('https://op.gg/foo bar', LEAGUE_GAME_KEY).ok,
    false,
  );
});

test('texte hors URL interdit', () => {
  assert.equal(
    validateMultiOpggUrl('voir https://www.op.gg/x', LEAGUE_GAME_KEY).ok,
    false,
  );
});

test('userinfo interdit', () => {
  const r = validateMultiOpggUrl('https://x@www.op.gg/', LEAGUE_GAME_KEY);
  assert.equal(r.ok, false);
});

test('caractères markdown dangereux dans href interdits', () => {
  assert.equal(
    validateMultiOpggUrl('https://www.op.gg/x)', LEAGUE_GAME_KEY).ok,
    false,
  );
});

test('buildMultiOpggEmbedFieldValue : label fixe + URL validée', () => {
  assert.equal(
    buildMultiOpggEmbedFieldValue('https://www.op.gg/foo'),
    '[Ouvrir le multi OP.GG](https://www.op.gg/foo)',
  );
});

test('entrée trop longue interdite', () => {
  const long = `${'https://op.gg/'}${'x'.repeat(MULTI_OPGG_MAX_LEN)}`;
  assert.ok(long.length > MULTI_OPGG_MAX_LEN);
  const r = validateMultiOpggUrl(long, LEAGUE_GAME_KEY);
  assert.equal(r.ok, false);
});
