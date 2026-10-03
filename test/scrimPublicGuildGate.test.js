import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  buildScrimCommunityServerActionRows,
  getScrimCommunityServerUrlFromEnv,
} from '../src/services/scrimEmbedBuilder.js';
import {
  buildScrimReseauPublicContactMembershipRefusalContent,
  buildScrimReseauPublicMembershipRefusalContent,
  checkScrimReseauPublicGuildMembership,
  getScrimReseauPublicInviteUrlForMessage,
} from '../src/utils/scrimPublicGuildGate.js';
import { t } from '../src/i18n/index.js';

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

describe('scrimPublicGuildGate — fail-open historique vs fail-closed', () => {
  const saved = {
    community: process.env[ENV_COMMUNITY],
    guild: process.env[ENV_PUBLIC_GUILD],
  };

  afterEach(() => {
    if (saved.community === undefined) delete process.env[ENV_COMMUNITY];
    else process.env[ENV_COMMUNITY] = saved.community;
    if (saved.guild === undefined) delete process.env[ENV_PUBLIC_GUILD];
    else process.env[ENV_PUBLIC_GUILD] = saved.guild;
  });

  function clientWithMemberFetch(fetchImpl) {
    return {
      guilds: {
        cache: {
          get: () => ({
            members: { fetch: fetchImpl },
          }),
        },
        fetch: async () => {
          throw new Error('should not fetch');
        },
      },
    };
  }

  it('F: erreur non-10007 sans option → fail-open (ok: true)', async () => {
    process.env[ENV_COMMUNITY] = VALID_COMMUNITY_URL;
    process.env[ENV_PUBLIC_GUILD] = 'guild-public-1';
    const err = Object.assign(new Error('Missing Access'), { code: 50001 });
    const result = await checkScrimReseauPublicGuildMembership(
      /** @type {any} */ (clientWithMemberFetch(async () => { throw err; })),
      'user-1',
      'fr',
    );
    assert.equal(result.ok, true);
  });

  it('erreur non-10007 avec failClosedOnError → refus', async () => {
    process.env[ENV_COMMUNITY] = VALID_COMMUNITY_URL;
    process.env[ENV_PUBLIC_GUILD] = 'guild-public-1';
    const err = Object.assign(new Error('Missing Access'), { code: 50001 });
    const result = await checkScrimReseauPublicGuildMembership(
      /** @type {any} */ (clientWithMemberFetch(async () => { throw err; })),
      'user-1',
      'fr',
      { failClosedOnError: true, refusalKey: 'publicGate.contactRefusal' },
    );
    assert.equal(result.ok, false);
    assert.equal(
      result.content,
      t('fr', 'publicGate.contactRefusal', { url: VALID_COMMUNITY_URL }),
    );
    assert.ok(result.content.includes(VALID_COMMUNITY_URL));
  });

  it('10007 avec refusalKey contact → message contactRefusal', async () => {
    process.env[ENV_COMMUNITY] = VALID_COMMUNITY_URL;
    process.env[ENV_PUBLIC_GUILD] = 'guild-public-1';
    const err = Object.assign(new Error('Unknown Member'), { code: 10007 });
    const result = await checkScrimReseauPublicGuildMembership(
      /** @type {any} */ (clientWithMemberFetch(async () => { throw err; })),
      'contact-1',
      'fr',
      { failClosedOnError: true, refusalKey: 'publicGate.contactRefusal' },
    );
    assert.equal(result.ok, false);
    assert.equal(
      result.content,
      buildScrimReseauPublicContactMembershipRefusalContent(VALID_COMMUNITY_URL, 'fr'),
    );
    assert.notEqual(
      result.content,
      buildScrimReseauPublicMembershipRefusalContent(VALID_COMMUNITY_URL, 'fr'),
    );
  });

  it('défaut sans 4e arg = fail-open historique (réseau / 5xx)', async () => {
    process.env[ENV_COMMUNITY] = VALID_COMMUNITY_URL;
    process.env[ENV_PUBLIC_GUILD] = 'guild-public-1';
    const result = await checkScrimReseauPublicGuildMembership(
      /** @type {any} */ (
        clientWithMemberFetch(async () => {
          throw new Error('ECONNRESET');
        })
      ),
      'user-1',
      'fr',
    );
    assert.equal(result.ok, true);
  });
});
