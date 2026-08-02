import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  buildScrimCommunityServerActionRows,
  getScrimCommunityServerUrlFromEnv,
} from '../src/services/scrimEmbedBuilder.js';
import {
  buildScrimReseauPublicMembershipRefusalContent,
  checkScrimReseauPublicGuildMembership,
  getScrimReseauPublicInviteUrlForMessage,
} from '../src/utils/scrimPublicGuildGate.js';

const ENV_COMMUNITY = 'SCRIM_COMMUNITY_SERVER_URL';
const ENV_LEGACY_INVITE = 'SCRIMRESEAU_PUBLIC_INVITE_URL';
const ENV_PUBLIC_GUILD = 'SCRIMRESEAU_PUBLIC_GUILD_ID';

const VALID_COMMUNITY_URL = 'https://discord.gg/scrimreseau-valid';

describe('scrimPublicGuildGate — URL d’invitation alignée sur le bouton', () => {
  const saved = {
    community: process.env[ENV_COMMUNITY],
    legacy: process.env[ENV_LEGACY_INVITE],
    guild: process.env[ENV_PUBLIC_GUILD],
  };

  afterEach(() => {
    if (saved.community === undefined) delete process.env[ENV_COMMUNITY];
    else process.env[ENV_COMMUNITY] = saved.community;
    if (saved.legacy === undefined) delete process.env[ENV_LEGACY_INVITE];
    else process.env[ENV_LEGACY_INVITE] = saved.legacy;
    if (saved.guild === undefined) delete process.env[ENV_PUBLIC_GUILD];
    else process.env[ENV_PUBLIC_GUILD] = saved.guild;
  });

  it('getScrimReseauPublicInviteUrlForMessage === getScrimCommunityServerUrlFromEnv', () => {
    process.env[ENV_COMMUNITY] = VALID_COMMUNITY_URL;
    delete process.env[ENV_LEGACY_INVITE];

    assert.equal(getScrimReseauPublicInviteUrlForMessage(), VALID_COMMUNITY_URL);
    assert.equal(getScrimCommunityServerUrlFromEnv(), VALID_COMMUNITY_URL);
    assert.equal(
      getScrimReseauPublicInviteUrlForMessage(),
      getScrimCommunityServerUrlFromEnv(),
    );
  });

  it('ignore SCRIMRESEAU_PUBLIC_INVITE_URL au profit de SCRIM_COMMUNITY_SERVER_URL', () => {
    process.env[ENV_COMMUNITY] = VALID_COMMUNITY_URL;
    process.env[ENV_LEGACY_INVITE] = 'https://discord.gg/dcjhQq5Ur9';

    assert.equal(getScrimReseauPublicInviteUrlForMessage(), VALID_COMMUNITY_URL);
    assert.notEqual(getScrimReseauPublicInviteUrlForMessage(), process.env[ENV_LEGACY_INVITE]);
  });

  it('bouton et message de refus exposent la même URL', () => {
    process.env[ENV_COMMUNITY] = VALID_COMMUNITY_URL;
    delete process.env[ENV_LEGACY_INVITE];

    const rows = buildScrimCommunityServerActionRows(null, 'fr');
    assert.equal(rows.length, 1);
    const buttonUrl = rows[0].components[0].data.url;
    assert.equal(buttonUrl, VALID_COMMUNITY_URL);

    const refusal = buildScrimReseauPublicMembershipRefusalContent(
      getScrimReseauPublicInviteUrlForMessage(),
      'fr',
    );
    assert.ok(refusal.includes(VALID_COMMUNITY_URL));
    assert.equal(buttonUrl, getScrimReseauPublicInviteUrlForMessage());
  });

  it('refus Unknown Member contient exactement l’URL commune du bouton', async () => {
    process.env[ENV_COMMUNITY] = VALID_COMMUNITY_URL;
    process.env[ENV_PUBLIC_GUILD] = 'guild-public-1';
    delete process.env[ENV_LEGACY_INVITE];

    const client = {
      guilds: {
        cache: {
          get: () => ({
            members: {
              fetch: async () => {
                const err = new Error('Unknown Member');
                err.code = 10007;
                throw err;
              },
            },
          }),
        },
        fetch: async () => {
          throw new Error('should not fetch');
        },
      },
    };

    const result = await checkScrimReseauPublicGuildMembership(
      /** @type {any} */ (client),
      'user-non-member',
      'fr',
    );

    assert.equal(result.ok, false);
    assert.ok(result.content.includes(VALID_COMMUNITY_URL));
    assert.ok(!result.content.includes('dcjhQq5Ur9'));
    assert.equal(
      getScrimReseauPublicInviteUrlForMessage(),
      getScrimCommunityServerUrlFromEnv(),
    );
  });
});
