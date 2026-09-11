/**
 * Expérimentation locale officiel : send sans contact puis edit content.
 * Partenaires inchangés (contact embed + hints longs + invite, aucun edit).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { broadcastScrimRequest } from '../src/services/broadcast.js';
import {
  startDiscordTaskQueue,
  stopDiscordTaskQueue,
} from '../src/services/discordTaskQueue.js';
import {
  applyOfficialContactEditAfterSend,
  deliverScrimToDestination,
} from '../src/services/scrimDelivery.js';
import {
  buildScrimClosedMessageEditOptions,
  buildScrimCommunityServerActionRows,
  buildScrimEmbed,
  buildScrimOfficialContactContent,
  buildScrimSupersededMessageEditOptions,
  SCRIM_OFFICIAL_SITE_URL,
} from '../src/services/scrimEmbedBuilder.js';
import {
  applyScrimEmbedEditFromPayload,
  serializeScrimEditPayload,
} from '../src/services/safeDiscordMessageEdit.js';
import { ALL_LOCALES, t } from '../src/i18n/index.js';

const CONTACT_ID = '555444333222111000';
const OPGG_URL = 'https://www.op.gg/multisearch/euw?summoners=a,b';
const JOIN_URL = 'https://discord.gg/testhint';

function buttonLabels(payload) {
  const rows = payload.components ?? [];
  /** @type {string[]} */
  const labels = [];
  for (const row of rows) {
    const json = typeof row.toJSON === 'function' ? row.toJSON() : row;
    for (const c of json.components ?? []) {
      if (typeof c.label === 'string') labels.push(c.label);
    }
  }
  return labels;
}

function buttonUrls(payload) {
  const rows = payload.components ?? [];
  /** @type {string[]} */
  const urls = [];
  for (const row of rows) {
    const json = typeof row.toJSON === 'function' ? row.toJSON() : row;
    for (const c of json.components ?? []) {
      if (typeof c.url === 'string') urls.push(c.url);
    }
  }
  return urls;
}

const BASE_PAYLOAD = {
  gameKey: 'lol',
  rank: 'Diamant',
  dateStr: '23/07/2026',
  timeStr: '20h00',
  format: 'BO3',
  contactUserId: CONTACT_ID,
  contactDisplayName: 'TestPlayer',
  multiOpggUrl: null,
  scheduledAtIso: null,
  scheduledAtEndIso: null,
  nombreDeGames: null,
  fearless: 'oui',
  eloPrecision: null,
  structureNameSnapshot: null,
  structureInviteUrl: null,
};

const BASE_DB_ROW = {
  id: 42,
  game_key: 'lol',
  rank_key: 'Diamant',
  scheduled_date: '23/07/2026',
  scheduled_time: '20h00',
  format_key: 'BO3',
  contact_user_id: CONTACT_ID,
  contact_display_name: 'TestPlayer',
  multi_opgg_url: null,
  scheduled_at: null,
  scheduled_at_end: null,
  tags: '{"fearless":"oui"}',
  elo_precision: null,
  structure_name_snapshot: null,
  structure_invite_url_snapshot: null,
  status: 'closed_manual',
};

function desc(embed) {
  return embed.toJSON().description ?? '';
}

const HINT_FR = [
  "⚠️ Si la mention du contact ci-dessus n'est pas cliquable",
  '👉 Rejoignez le serveur ScrimRéseau avec le bouton ci-dessous',
  '👉 Cela permet généralement de rendre la mention cliquable',
];

describe('partenaire — contact embed + hints longs (inchangé)', () => {
  it('format contact embed + 3 hints FR', () => {
    const d = desc(buildScrimEmbed(BASE_PAYLOAD, 'fr'));
    assert.match(d, new RegExp(`👤 <@${CONTACT_ID}> • TestPlayer`));
    for (const line of HINT_FR) assert.ok(d.includes(line), line);
    assert.equal((d.match(/👉/g) ?? []).length, 2);
  });

  it('hints longs + officialSiteButton + officialContactContent dans 7 locales', () => {
    for (const locale of ALL_LOCALES) {
      const h1 = t(locale, 'embed.contactHint1');
      const h2 = t(locale, 'embed.contactHint2');
      const h3 = t(locale, 'embed.contactHint3');
      assert.doesNotMatch(h1, /\[embed\.contactHint1\]/);
      assert.ok(h1.includes('⚠️') && h2.includes('👉') && h3.includes('👉'), locale);
      assert.doesNotMatch(t(locale, 'embed.officialSiteButton'), /\[embed\.officialSiteButton\]/);
      const contactLine = t(locale, 'embed.officialContactContent', {
        mention: `<@${CONTACT_ID}>`,
      });
      assert.ok(contactLine.includes(`<@${CONTACT_ID}>`), locale);
      assert.doesNotMatch(contactLine, /\[embed\.officialContactContent\]/);
    }
  });
});

describe('officiel — builder send initial (sans contact embed)', () => {
  it('embed sans contact ni hints', () => {
    const d = desc(
      buildScrimEmbed(BASE_PAYLOAD, 'fr', {
        includeContactInEmbed: false,
        includeContactHints: false,
      }),
    );
    assert.doesNotMatch(d, new RegExp(`<@${CONTACT_ID}>`));
    assert.doesNotMatch(d, /cliquable|👉/);
  });

  it('content officiel i18n', () => {
    assert.equal(
      buildScrimOfficialContactContent(CONTACT_ID, 'fr'),
      `👤 Contact : <@${CONTACT_ID}>`,
    );
  });
});

describe('lifecycle officiel vs partenaire', () => {
  it('officiel close : content null + embed sans contact', () => {
    const opts = buildScrimClosedMessageEditOptions('closed_manual', BASE_DB_ROW, 'fr', {
      includeContactInEmbed: false,
    });
    assert.equal(opts.content, null);
    assert.deepEqual(opts.components, []);
    assert.doesNotMatch(desc(opts.embeds[0]), new RegExp(`<@${CONTACT_ID}>`));
  });

  it('officiel expire / superseded : content null + sans contact', () => {
    for (const opts of [
      buildScrimClosedMessageEditOptions('closed_expired', BASE_DB_ROW, 'fr', {
        includeContactInEmbed: false,
      }),
      buildScrimSupersededMessageEditOptions(BASE_DB_ROW, 'fr', {
        includeContactInEmbed: false,
      }),
    ]) {
      assert.equal(opts.content, null);
      assert.doesNotMatch(desc(opts.embeds[0]), new RegExp(`<@${CONTACT_ID}>`));
    }
  });

  it('partenaire fermé : contact reste dans embed', () => {
    const opts = buildScrimClosedMessageEditOptions('closed_manual', BASE_DB_ROW, 'fr');
    assert.match(desc(opts.embeds[0]), new RegExp(`👤 <@${CONTACT_ID}> • TestPlayer`));
  });
});

describe('serializeScrimEditPayload — sémantique content', () => {
  it('content null → clear conservé', () => {
    const json = serializeScrimEditPayload(
      buildScrimClosedMessageEditOptions('closed_manual', BASE_DB_ROW, 'fr', {
        includeContactInEmbed: false,
      }),
    );
    const data = JSON.parse(json);
    assert.equal(data.content, null);
  });

  it('replay applique content null', async () => {
    const json = serializeScrimEditPayload({
      content: null,
      embeds: [
        buildScrimEmbed(BASE_PAYLOAD, 'fr', {
          includeContactInEmbed: false,
          includeContactHints: false,
        }),
      ],
      components: [],
    });
    /** @type {Record<string, unknown>[]} */
    const edits = [];
    const message = {
      id: 'm1',
      channelId: 'c1',
      edit: async (opts) => {
        edits.push(opts);
      },
    };
    const prevDelay = process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    startDiscordTaskQueue();
    try {
      await applyScrimEmbedEditFromPayload(/** @type {any} */ (message), json);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(edits.length, 1);
      assert.equal(edits[0].content, null);
    } finally {
      await stopDiscordTaskQueue();
      if (prevDelay === undefined) delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
      else process.env.DISCORD_TASK_QUEUE_DELAY_MS = prevDelay;
    }
  });
});

describe('applyOfficialContactEditAfterSend', () => {
  it('edit content natif sans allowedMentions / flags', async () => {
    /** @type {Record<string, unknown>[]} */
    const edits = [];
    const msg = {
      id: 'msg-edit',
      edit: async (opts) => {
        edits.push(opts);
      },
    };
    await applyOfficialContactEditAfterSend(
      /** @type {any} */ (msg),
      BASE_PAYLOAD,
      'fr',
      { guild_id: 'g', channel_id: 'c' },
    );
    assert.equal(edits.length, 1);
    assert.equal(edits[0].content, `👤 Contact : <@${CONTACT_ID}>`);
    assert.equal(Object.prototype.hasOwnProperty.call(edits[0], 'allowedMentions'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(edits[0], 'flags'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(edits[0], 'embeds'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(edits[0], 'components'), false);
  });

  it('échec edit : ne lève pas', async () => {
    const msg = {
      id: 'msg-fail',
      edit: async () => {
        throw new Error('edit failed');
      },
    };
    await applyOfficialContactEditAfterSend(
      /** @type {any} */ (msg),
      BASE_PAYLOAD,
      'fr',
      { guild_id: 'g', channel_id: 'c' },
    );
  });
});

describe('broadcast / delivery — officiel send+edit vs partenaire send seul', () => {
  const GUILD_OFFICIAL = '777000000000000001';
  const GUILD_PARTNER = '777000000000000002';
  const CHAN_OFFICIAL = '888000000000000001';
  const CHAN_PARTNER = '888000000000000002';
  const AUTHOR_ID = '999888777666555444';

  let tempDir;
  let prevSqlite;
  let prevPublic;
  let prevQueueDelay;
  let prevUrl;
  let fs;
  let path;
  let msgSeq = 0;

  const sentOfficial = [];
  const sentPartner = [];
  const editsOfficial = [];
  const editsPartner = [];

  function mockChannel(channelId, captureSend, captureEdit) {
    const perms = new PermissionsBitField([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ]);
    return {
      id: channelId,
      type: ChannelType.GuildText,
      permissionsFor: () => perms,
      send: async (payload) => {
        captureSend.push(payload);
        msgSeq += 1;
        const id = `msg-${channelId}-${msgSeq}`;
        return {
          id,
          edit: async (opts) => {
            captureEdit.push(opts);
          },
          delete: async () => {},
        };
      },
    };
  }

  function mockGuild(guildId, channelId, captureSend, captureEdit) {
    const channel = mockChannel(channelId, captureSend, captureEdit);
    const botMember = { id: 'bot-1' };
    return {
      id: guildId,
      channels: { cache: new Map([[channelId, channel]]) },
      members: { me: botMember, fetchMe: async () => botMember },
    };
  }

  before(async () => {
    fs = await import('node:fs');
    const os = await import('node:os');
    path = await import('node:path');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-official-send-edit-'));
    prevSqlite = process.env.SQLITE_PATH;
    prevPublic = process.env.SCRIMRESEAU_PUBLIC_GUILD_ID;
    prevQueueDelay = process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    prevUrl = process.env.SCRIM_COMMUNITY_SERVER_URL;
    process.env.SQLITE_PATH = path.join(tempDir, 'test.db');
    process.env.SCRIMRESEAU_PUBLIC_GUILD_ID = GUILD_OFFICIAL;
    process.env.SCRIM_COMMUNITY_SERVER_URL = JOIN_URL;
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    closeDb();
    const db = getDb();
    const stmts = prepareStatements(db);
    stmts.upsertGuildLanguage.run(GUILD_OFFICIAL, 'fr');
    stmts.upsertGuildLanguage.run(GUILD_PARTNER, 'fr');
    startDiscordTaskQueue();
  });

  after(async () => {
    await stopDiscordTaskQueue();
    closeDb();
    if (prevSqlite === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prevSqlite;
    if (prevPublic === undefined) delete process.env.SCRIMRESEAU_PUBLIC_GUILD_ID;
    else process.env.SCRIMRESEAU_PUBLIC_GUILD_ID = prevPublic;
    if (prevUrl === undefined) delete process.env.SCRIM_COMMUNITY_SERVER_URL;
    else process.env.SCRIM_COMMUNITY_SERVER_URL = prevUrl;
    if (prevQueueDelay === undefined) delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    else process.env.DISCORD_TASK_QUEUE_DELAY_MS = prevQueueDelay;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('officiel : send sans content + edit contact ; partenaire : send seul', async () => {
    sentOfficial.length = 0;
    sentPartner.length = 0;
    editsOfficial.length = 0;
    editsPartner.length = 0;
    const stmts = prepareStatements(getDb());
    const guildCache = new Map([
      [GUILD_OFFICIAL, mockGuild(GUILD_OFFICIAL, CHAN_OFFICIAL, sentOfficial, editsOfficial)],
      [GUILD_PARTNER, mockGuild(GUILD_PARTNER, CHAN_PARTNER, sentPartner, editsPartner)],
    ]);
    const client = {
      guilds: { cache: { get: (id) => guildCache.get(id) ?? null } },
    };

    const sharedPayload = { ...BASE_PAYLOAD };
    await broadcastScrimRequest({
      client: /** @type {any} */ (client),
      stmts,
      authorUserId: AUTHOR_ID,
      payload: sharedPayload,
      rows: [
        { guild_id: GUILD_OFFICIAL, channel_id: CHAN_OFFICIAL },
        { guild_id: GUILD_PARTNER, channel_id: CHAN_PARTNER },
      ],
      scrimPostDbId: 1,
    });

    assert.equal(sentOfficial.length, 1);
    assert.equal(sentPartner.length, 1);

    const offSend = sentOfficial[0];
    assert.equal(offSend.content, undefined);
    assert.equal(offSend.allowedMentions, undefined);
    assert.equal(offSend.flags, undefined);
    const offDesc = offSend.embeds[0].toJSON().description ?? '';
    assert.doesNotMatch(offDesc, new RegExp(`<@${CONTACT_ID}>`));
    assert.doesNotMatch(offDesc, /👉|cliquable/);
    assert.deepEqual(buttonUrls(offSend), [SCRIM_OFFICIAL_SITE_URL]);
    assert.ok(!buttonUrls(offSend).includes(JOIN_URL));

    assert.equal(editsOfficial.length, 1, 'officiel doit éditer une fois');
    assert.equal(editsOfficial[0].content, `👤 Contact : <@${CONTACT_ID}>`);
    assert.equal(Object.prototype.hasOwnProperty.call(editsOfficial[0], 'allowedMentions'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(editsOfficial[0], 'flags'), false);

    const partSend = sentPartner[0];
    assert.equal(partSend.content, undefined);
    const partDesc = partSend.embeds[0].toJSON().description ?? '';
    assert.match(partDesc, new RegExp(`👤 <@${CONTACT_ID}> • TestPlayer`));
    for (const line of HINT_FR) assert.ok(partDesc.includes(line), line);
    assert.deepEqual(buttonUrls(partSend), [JOIN_URL]);
    assert.equal(editsPartner.length, 0, 'partenaire ne doit jamais appeler message.edit');

    assert.equal(sharedPayload.contactUserId, CONTACT_ID);
  });

  it('officiel + OP.GG : site+OP.GG au send ; partenaire invite+OP.GG ; edit officiel seul', async () => {
    sentOfficial.length = 0;
    sentPartner.length = 0;
    editsOfficial.length = 0;
    editsPartner.length = 0;
    const stmts = prepareStatements(getDb());
    const guildCache = new Map([
      [GUILD_OFFICIAL, mockGuild(GUILD_OFFICIAL, CHAN_OFFICIAL, sentOfficial, editsOfficial)],
      [GUILD_PARTNER, mockGuild(GUILD_PARTNER, CHAN_PARTNER, sentPartner, editsPartner)],
    ]);
    const client = {
      guilds: { cache: { get: (id) => guildCache.get(id) ?? null } },
    };

    await broadcastScrimRequest({
      client: /** @type {any} */ (client),
      stmts,
      authorUserId: AUTHOR_ID,
      payload: { ...BASE_PAYLOAD, multiOpggUrl: OPGG_URL },
      rows: [
        { guild_id: GUILD_OFFICIAL, channel_id: CHAN_OFFICIAL },
        { guild_id: GUILD_PARTNER, channel_id: CHAN_PARTNER },
      ],
      scrimPostDbId: 2,
    });

    assert.deepEqual(buttonUrls(sentOfficial[0]), [SCRIM_OFFICIAL_SITE_URL, OPGG_URL]);
    assert.equal(editsOfficial.length, 1);
    assert.deepEqual(buttonUrls(sentPartner[0]), [JOIN_URL, OPGG_URL]);
    assert.equal(editsPartner.length, 0);
  });

  it('send réussi + edit échoué → outcome sent, un seul send (pas de doublon)', async () => {
    const stmts = prepareStatements(getDb());
    /** @type {unknown[]} */
    const sends = [];
    let editCalls = 0;
    const perms = new PermissionsBitField([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ]);
    const channel = {
      id: CHAN_OFFICIAL,
      type: ChannelType.GuildText,
      permissionsFor: () => perms,
      send: async (payload) => {
        sends.push(payload);
        return {
          id: `msg-fail-edit-${sends.length}`,
          edit: async () => {
            editCalls += 1;
            throw new Error('edit boom');
          },
        };
      },
    };
    const botMember = { id: 'bot-1' };
    const guild = {
      id: GUILD_OFFICIAL,
      channels: { cache: new Map([[CHAN_OFFICIAL, channel]]) },
      members: { me: botMember, fetchMe: async () => botMember },
    };
    const client = {
      guilds: { cache: { get: (id) => (id === GUILD_OFFICIAL ? guild : null) } },
    };

    const result = await deliverScrimToDestination({
      client: /** @type {any} */ (client),
      stmts,
      row: { guild_id: GUILD_OFFICIAL, channel_id: CHAN_OFFICIAL },
      authorUserId: AUTHOR_ID,
      payload: BASE_PAYLOAD,
      delayMs: 0,
    });

    assert.equal(result.outcome, 'sent');
    assert.equal(sends.length, 1);
    assert.equal(editCalls, 1);
    assert.ok(result.message?.id);
  });
});

describe('buildScrimCommunityServerActionRows — site / invite', () => {
  const originalUrl = process.env.SCRIM_COMMUNITY_SERVER_URL;

  after(() => {
    if (originalUrl !== undefined) process.env.SCRIM_COMMUNITY_SERVER_URL = originalUrl;
    else delete process.env.SCRIM_COMMUNITY_SERVER_URL;
  });

  it('officiel sans OP.GG → site seul', () => {
    process.env.SCRIM_COMMUNITY_SERVER_URL = JOIN_URL;
    const rows = buildScrimCommunityServerActionRows(null, 'fr', {
      includeCommunityInviteButton: false,
      includeOfficialSiteButton: true,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].toJSON().components?.length, 1);
    assert.equal(rows[0].toJSON().components?.[0].url, SCRIM_OFFICIAL_SITE_URL);
  });
});
