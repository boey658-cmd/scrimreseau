/**
 * Mock client Discord pour tests GET/PATCH internal HTTP (authz live).
 */

import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';

/**
 * @param {string} guildId
 * @param {string} actorId
 * @param {{ manageGuild?: boolean, administrator?: boolean, owner?: boolean }} [opts]
 */
export function makeAuthzClient(guildId, actorId, opts = {}) {
  const {
    manageGuild = true,
    administrator = false,
    owner = false,
  } = opts;
  const bits = new PermissionsBitField();
  if (manageGuild) bits.add(PermissionFlagsBits.ManageGuild);
  if (administrator) bits.add(PermissionFlagsBits.Administrator);

  const member = {
    id: actorId,
    permissions: bits,
  };

  const guild = {
    id: guildId,
    ownerId: owner ? actorId : '000000000000000099',
    memberCount: 100,
    members: {
      me: { id: 'bot' },
      fetchMe: async () => ({ id: 'bot' }),
      fetch: async (id) => {
        if (String(id) !== String(actorId)) {
          const err = new Error('Unknown Member');
          /** @type {any} */ (err).code = 10007;
          throw err;
        }
        return member;
      },
    },
    channels: {
      cache: new Map(),
      fetch: async () => null,
    },
  };

  return {
    guilds: {
      cache: {
        get: (id) => (String(id) === String(guildId) ? guild : null),
        has: (id) => String(id) === String(guildId),
      },
      fetch: async (id) => {
        if (String(id) !== String(guildId)) {
          const err = new Error('Unknown Guild');
          /** @type {any} */ (err).code = 10004;
          throw err;
        }
        return guild;
      },
    },
    _guild: guild,
  };
}

export const TEST_ACTOR_ID = '1484520688726311099';
