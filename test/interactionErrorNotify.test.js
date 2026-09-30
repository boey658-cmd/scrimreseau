/**
 * Catch global — ne pas retenter reply/followUp sur 10062.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MessageFlags } from 'discord.js';
import {
  isUnknownInteractionError,
  notifyCommandErrorToUser,
} from '../src/utils/interactionDiscord.js';

describe('isUnknownInteractionError', () => {
  it('détecte code 10062', () => {
    assert.equal(isUnknownInteractionError({ code: 10062 }), true);
    assert.equal(isUnknownInteractionError({ code: '10062' }), true);
  });

  it('ignore les autres erreurs', () => {
    assert.equal(isUnknownInteractionError({ code: 50013 }), false);
    assert.equal(isUnknownInteractionError(new Error('x')), false);
    assert.equal(isUnknownInteractionError(null), false);
  });
});

describe('notifyCommandErrorToUser', () => {
  it('10062 initial → aucun reply/followUp', async () => {
    let replyCalls = 0;
    let followUpCalls = 0;
    const logs = [];
    const interaction = {
      commandName: 'find-scrim',
      user: { id: 'u1' },
      guildId: 'g1',
      deferred: false,
      replied: false,
      reply: async () => {
        replyCalls += 1;
      },
      followUp: async () => {
        followUpCalls += 1;
      },
    };
    const out = await notifyCommandErrorToUser(
      interaction,
      { code: 10062, message: 'Unknown interaction' },
      { content: 'err', flags: MessageFlags.Ephemeral },
      {
        warn: (msg) => logs.push(msg),
        error: (msg) => logs.push(msg),
      },
    );
    assert.equal(out.notified, false);
    assert.equal(out.reason, 'unknown_interaction');
    assert.equal(replyCalls, 0);
    assert.equal(followUpCalls, 0);
    assert.ok(logs.some((m) => /10062/.test(String(m))));
  });

  it('erreur avant reply → interactReply', async () => {
    let replyCalls = 0;
    const interaction = {
      commandName: 'x',
      user: { id: 'u1' },
      guildId: 'g1',
      deferred: false,
      replied: false,
      reply: async () => {
        replyCalls += 1;
        interaction.replied = true;
      },
      followUp: async () => {
        throw new Error('followUp should not be called');
      },
    };
    const out = await notifyCommandErrorToUser(
      interaction,
      new Error('boom'),
      { content: 'err', flags: MessageFlags.Ephemeral },
    );
    assert.equal(out.notified, true);
    assert.equal(replyCalls, 1);
  });

  it('erreur après defer → followUp', async () => {
    let followUpCalls = 0;
    const interaction = {
      commandName: 'x',
      user: { id: 'u1' },
      guildId: 'g1',
      deferred: true,
      replied: false,
      reply: async () => {
        throw new Error('reply should not be called');
      },
      followUp: async () => {
        followUpCalls += 1;
      },
    };
    const out = await notifyCommandErrorToUser(
      interaction,
      new Error('boom'),
      { content: 'err', flags: MessageFlags.Ephemeral },
    );
    assert.equal(out.notified, true);
    assert.equal(followUpCalls, 1);
  });

  it('followUp qui renvoie 10062 → pas de seconde erreur fatale', async () => {
    const logs = [];
    const interaction = {
      commandName: 'x',
      user: { id: 'u1' },
      guildId: 'g1',
      deferred: true,
      replied: false,
      reply: async () => {},
      followUp: async () => {
        throw Object.assign(new Error('Unknown interaction'), { code: 10062 });
      },
    };
    const out = await notifyCommandErrorToUser(
      interaction,
      new Error('original'),
      { content: 'err', flags: MessageFlags.Ephemeral },
      {
        warn: (msg) => logs.push(['warn', msg]),
        error: (msg) => logs.push(['error', msg]),
      },
    );
    assert.equal(out.notified, false);
    assert.equal(out.reason, 'unknown_interaction_on_notify');
    assert.ok(logs.some(([level, msg]) => level === 'warn' && /10062/.test(String(msg))));
    assert.ok(!logs.some(([level]) => level === 'error'));
  });
});
