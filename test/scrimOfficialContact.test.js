/**
 * Partenaire (hints longs + invite) vs officiel (contact embed, sans hints, bouton site).
 * Pas de content / allowedMentions / SuppressNotifications.
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
  buildScrimClosedMessageEditOptions,
  buildScrimCommunityServerActionRows,
  buildScrimEmbed,
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

const HINT_EN = [
  '⚠️ If the contact mention above is not clickable',
  '👉 Join the ScrimRéseau server using the button below',
  '👉 This usually makes the mention clickable',
];

describe('partenaire actif — contact embed + hints longs historiques', () => {
  it('garde le format 👤 <@id> • username', () => {
    const d = desc(buildScrimEmbed(BASE_PAYLOAD, 'fr'));
    assert.match(d, new RegExp(`👤 <@${CONTACT_ID}> • TestPlayer`));
    assert.doesNotMatch(d, /👤 Contact\s*:/);
  });

  it('inclut les 3 hints FR historiques', () => {
    const d = desc(buildScrimEmbed(BASE_PAYLOAD, 'fr'));
    for (const line of HINT_FR) assert.ok(d.includes(line), line);
    assert.equal((d.match(/👉/g) ?? []).length, 2);
  });

  it('inclut les 3 hints EN historiques', () => {
    const d = desc(buildScrimEmbed(BASE_PAYLOAD, 'en'));
    for (const line of HINT_EN) assert.ok(d.includes(line), line);
    assert.equal((d.match(/👉/g) ?? []).length, 2);
  });

  it('hints longs + officialSiteButton dans les 7 locales', () => {
    for (const locale of ALL_LOCALES) {
      const h1 = t(locale, 'embed.contactHint1');
      const h2 = t(locale, 'embed.contactHint2');
      const h3 = t(locale, 'embed.contactHint3');
      assert.doesNotMatch(h1, /\[embed\.contactHint1\]/, locale);
      assert.doesNotMatch(h2, /\[embed\.contactHint2\]/, locale);
      assert.doesNotMatch(h3, /\[embed\.contactHint3\]/, locale);
      assert.ok(h1.includes('⚠️'), locale);
      assert.ok(h2.includes('👉'), locale);
      assert.ok(h3.includes('👉'), locale);
      assert.notEqual(h1, h2, locale);
      const site = t(locale, 'embed.officialSiteButton');
      assert.ok(site.includes('ScrimRéseau') || site.includes('ScrimReseau'), locale);
      assert.doesNotMatch(site, /\[embed\.officialSiteButton\]/);
      assert.match(t(locale, 'embed.officialContactContent'), /\[embed\.officialContactContent\]/);
      const d = desc(buildScrimEmbed(BASE_PAYLOAD, locale));
      assert.ok(d.includes(h1) && d.includes(h2) && d.includes(h3), locale);
    }
  });
});

describe('officiel actif — options builder', () => {
  it('contact dans embed, sans hints', () => {
    const d = desc(
      buildScrimEmbed(BASE_PAYLOAD, 'fr', { includeContactHints: false }),
    );
    assert.match(d, new RegExp(`👤 <@${CONTACT_ID}> • TestPlayer`));
    assert.doesNotMatch(d, /cliquable/);
    assert.doesNotMatch(d, /👉/);
  });
});

describe('lifecycle — close / expire / superseded', () => {
  it('close manuel : content null + contact dans embed + sans hints', () => {
    const opts = buildScrimClosedMessageEditOptions('closed_manual', BASE_DB_ROW, 'fr');
    assert.equal(opts.content, null);
    assert.deepEqual(opts.components, []);
    assert.match(desc(opts.embeds[0]), new RegExp(`👤 <@${CONTACT_ID}> • TestPlayer`));
    assert.doesNotMatch(desc(opts.embeds[0]), /cliquable/);
  });

  it('expire : content null + contact dans embed', () => {
    const opts = buildScrimClosedMessageEditOptions('closed_expired', BASE_DB_ROW, 'fr');
    assert.equal(opts.content, null);
    assert.match(desc(opts.embeds[0]), new RegExp(`👤 <@${CONTACT_ID}> • TestPlayer`));
  });

  it('superseded : content null + contact dans embed', () => {
    const opts = buildScrimSupersededMessageEditOptions(BASE_DB_ROW, 'fr');
    assert.equal(opts.content, null);
    assert.match(desc(opts.embeds[0]), new RegExp(`👤 <@${CONTACT_ID}> • TestPlayer`));
  });
});

describe('serializeScrimEditPayload — sémantique content', () => {
  it('omission de content → clé absente', () => {
    const json = serializeScrimEditPayload({
      embeds: [buildScrimEmbed(BASE_PAYLOAD, 'fr')],
    });
    const data = JSON.parse(json);
    assert.equal(Object.prototype.hasOwnProperty.call(data, 'content'), false);
  });

  it('content string → set', () => {
    const json = serializeScrimEditPayload({
      content: 'hello',
      embeds: [buildScrimEmbed(BASE_PAYLOAD, 'fr')],
    });
    const data = JSON.parse(json);
    assert.equal(data.content, 'hello');
  });

  it('content null → clear conservé après sérialisation', () => {
    const json = serializeScrimEditPayload(
      buildScrimClosedMessageEditOptions('closed_manual', BASE_DB_ROW, 'fr'),
    );
    const data = JSON.parse(json);
    assert.equal(Object.prototype.hasOwnProperty.call(data, 'content'), true);
    assert.equal(data.content, null);
  });

  it('replay applique content null (clear)', async () => {
    const json = serializeScrimEditPayload({
      content: null,
      embeds: [buildScrimEmbed(BASE_PAYLOAD, 'fr', { includeContactHints: false })],
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
      assert.equal(Object.prototype.hasOwnProperty.call(edits[0], 'content'), true);
      assert.equal(edits[0].content, null);
    } finally {
      await stopDiscordTaskQueue();
      if (prevDelay === undefined) delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
      else process.env.DISCORD_TASK_QUEUE_DELAY_MS = prevDelay;
    }
  });

  it('replay sans clé content → ne modifie pas content', async () => {
    const json = serializeScrimEditPayload({
      embeds: [buildScrimEmbed(BASE_PAYLOAD, 'fr')],
    });
    /** @type {Record<string, unknown>[]} */
    const edits = [];
    const message = {
      id: 'm2',
      channelId: 'c2',
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
      assert.equal(Object.prototype.hasOwnProperty.call(edits[0], 'content'), false);
    } finally {
      await stopDiscordTaskQueue();
      if (prevDelay === undefined) delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
      else process.env.DISCORD_TASK_QUEUE_DELAY_MS = prevDelay;
    }
  });
});

describe('broadcast multi-guild — officiel vs partenaire', () => {
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

  const sentOfficial = [];
  const sentPartner = [];
  let msgSeq = 0;

  function mockChannel(channelId, capture) {
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
        capture.push(payload);
        msgSeq += 1;
        return { id: `msg-${channelId}-${msgSeq}`, delete: async () => {} };
      },
    };
  }

  function mockGuild(guildId, channelId, capture) {
    const channel = mockChannel(channelId, capture);
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-official-contact-'));
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

  it('partenaire : contact + 3 hints + invite ; officiel : contact sans hints + site ; pas de content/flags', async () => {
    sentOfficial.length = 0;
    sentPartner.length = 0;
    const stmts = prepareStatements(getDb());
    const guildCache = new Map([
      [GUILD_OFFICIAL, mockGuild(GUILD_OFFICIAL, CHAN_OFFICIAL, sentOfficial)],
      [GUILD_PARTNER, mockGuild(GUILD_PARTNER, CHAN_PARTNER, sentPartner)],
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

    const off = sentOfficial[0];
    const part = sentPartner[0];

    assert.equal(off.content, undefined);
    assert.equal(off.allowedMentions, undefined);
    assert.equal(off.flags, undefined);
    const offDesc = off.embeds[0].toJSON().description ?? '';
    assert.match(offDesc, new RegExp(`👤 <@${CONTACT_ID}> • TestPlayer`));
    assert.doesNotMatch(offDesc, /cliquable/);
    assert.doesNotMatch(offDesc, /👉/);
    assert.deepEqual(buttonUrls(off), [SCRIM_OFFICIAL_SITE_URL]);
    assert.ok(buttonLabels(off).some((l) => /Site ScrimRéseau|ScrimRéseau Website/i.test(l)));
    assert.ok(!buttonUrls(off).includes(JOIN_URL));

    assert.equal(part.content, undefined);
    assert.equal(part.allowedMentions, undefined);
    assert.equal(part.flags, undefined);
    const partDesc = part.embeds[0].toJSON().description ?? '';
    assert.match(partDesc, new RegExp(`👤 <@${CONTACT_ID}> • TestPlayer`));
    for (const line of HINT_FR) assert.ok(partDesc.includes(line), line);
    assert.equal((partDesc.match(/👉/g) ?? []).length, 2);
    assert.deepEqual(buttonUrls(part), [JOIN_URL]);
    assert.ok(!buttonUrls(part).includes(SCRIM_OFFICIAL_SITE_URL));

    assert.equal(sharedPayload.contactUserId, CONTACT_ID);
  });

  it('officiel + OP.GG : site + OP.GG ; partenaire : invite + OP.GG', async () => {
    sentOfficial.length = 0;
    sentPartner.length = 0;
    const stmts = prepareStatements(getDb());
    const guildCache = new Map([
      [GUILD_OFFICIAL, mockGuild(GUILD_OFFICIAL, CHAN_OFFICIAL, sentOfficial)],
      [GUILD_PARTNER, mockGuild(GUILD_PARTNER, CHAN_PARTNER, sentPartner)],
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

    assert.equal(sentOfficial.length, 1);
    assert.equal(sentPartner.length, 1);

    const off = sentOfficial[0];
    const part = sentPartner[0];

    assert.equal(off.content, undefined);
    assert.equal(off.flags, undefined);
    assert.deepEqual(buttonUrls(off), [SCRIM_OFFICIAL_SITE_URL, OPGG_URL]);
    assert.ok(buttonLabels(off).includes('Multi OP.GG'));
    assert.ok(!buttonUrls(off).includes(JOIN_URL));

    assert.deepEqual(buttonUrls(part), [JOIN_URL, OPGG_URL]);
    assert.ok(buttonLabels(part).includes('Multi OP.GG'));
    assert.ok(!buttonUrls(part).includes(SCRIM_OFFICIAL_SITE_URL));
  });
});

describe('buildScrimCommunityServerActionRows — invite / site / OP.GG', () => {
  const originalUrl = process.env.SCRIM_COMMUNITY_SERVER_URL;

  after(() => {
    if (originalUrl !== undefined) process.env.SCRIM_COMMUNITY_SERVER_URL = originalUrl;
    else delete process.env.SCRIM_COMMUNITY_SERVER_URL;
  });

  it('partenaire défaut → invite + OP.GG', () => {
    process.env.SCRIM_COMMUNITY_SERVER_URL = JOIN_URL;
    const rows = buildScrimCommunityServerActionRows(OPGG_URL, 'fr');
    assert.equal(rows.length, 1);
    const comps = rows[0].toJSON().components ?? [];
    assert.equal(comps.length, 2);
    assert.equal(comps[0].url, JOIN_URL);
    assert.equal(comps[1].url, OPGG_URL);
  });

  it('officiel + OP.GG → site + OP.GG, pas d’invite', () => {
    process.env.SCRIM_COMMUNITY_SERVER_URL = JOIN_URL;
    const rows = buildScrimCommunityServerActionRows(OPGG_URL, 'fr', {
      includeCommunityInviteButton: false,
      includeOfficialSiteButton: true,
    });
    assert.equal(rows.length, 1);
    const comps = rows[0].toJSON().components ?? [];
    assert.equal(comps.length, 2);
    assert.equal(comps[0].url, SCRIM_OFFICIAL_SITE_URL);
    assert.equal(comps[1].url, OPGG_URL);
  });

  it('officiel sans OP.GG → site seul (pas de row vide)', () => {
    process.env.SCRIM_COMMUNITY_SERVER_URL = JOIN_URL;
    const rows = buildScrimCommunityServerActionRows(null, 'fr', {
      includeCommunityInviteButton: false,
      includeOfficialSiteButton: true,
    });
    assert.equal(rows.length, 1);
    const comps = rows[0].toJSON().components ?? [];
    assert.equal(comps.length, 1);
    assert.equal(comps[0].url, SCRIM_OFFICIAL_SITE_URL);
  });
});
