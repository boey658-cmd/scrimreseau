import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPlayerSearchSuccessReplyContent,
  formatPlayerSearchDiffusionLine,
} from '../src/utils/playerSearchSuccessReply.js';

test('formatPlayerSearchDiffusionLine — singulier et pluriel', () => {
  assert.equal(
    formatPlayerSearchDiffusionLine(1),
    '📡 Diffusée dans 1 serveur',
  );
  assert.equal(
    formatPlayerSearchDiffusionLine(3),
    '📡 Diffusée dans 3 serveurs',
  );
});

test('buildPlayerSearchSuccessReplyContent — message réseau avec ID éphémère', () => {
  const content = buildPlayerSearchSuccessReplyContent('J1', 2);
  assert.match(content, /✅ Ta recherche de joueur est en ligne sur le réseau !/);
  assert.match(content, /📡 Diffusée dans 2 serveurs/);
  assert.match(content, /🔴 Quand tu as trouvé tes joueurs :/);
  assert.match(content, /\/joueur-trouve id:J1/);
  assert.match(content, /discord\.gg/);
  assert.match(content, /Discord commun entre les joueurs/);
  assert.doesNotMatch(content, /^ID :/m);
});

test('buildPlayerSearchSuccessReplyContent — 1 serveur', () => {
  const content = buildPlayerSearchSuccessReplyContent('J5', 1);
  assert.match(content, /📡 Diffusée dans 1 serveur/);
  assert.doesNotMatch(content, /1 serveurs/);
});
