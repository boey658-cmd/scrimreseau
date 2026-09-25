/**
 * Phase 0.5 — /scrim-config n'a plus de panneau interactif ni de handler chan_ann.
 * Ancien test de régression catch i18n → remplacé par garde redirect-only.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { scrimConfigurer } from '../src/commands/scrimConfigurer.js';
import { ALL_LOCALES, t } from '../src/i18n/index.js';
import { buildConfigDashboardRedirectPayload } from '../src/utils/configDashboardRedirect.js';

describe('scrimConfigurer — Phase 0.5 redirect (ex-chan_ann catch)', () => {
  it('n’exporte plus _handleComponentForTest (panneau retiré)', async () => {
    const mod = await import('../src/commands/scrimConfigurer.js');
    assert.equal(mod._handleComponentForTest, undefined);
  });

  it('source sans handlers write / chan_ann / placeholders bruts', () => {
    const src = fs.readFileSync(new URL('../src/commands/scrimConfigurer.js', import.meta.url), 'utf8');
    assert.ok(!src.includes('chan_ann'));
    assert.ok(!src.includes('buildSalonsComponents'));
    assert.ok(!src.includes('applyGuildConfigSectionWrite'));
    assert.ok(src.includes('buildConfigDashboardRedirectPayload'));
  });

  it('payload redirect : 7 locales sans clé brute', () => {
    for (const locale of ALL_LOCALES) {
      const payload = buildConfigDashboardRedirectPayload(locale);
      const texts = [
        payload.embeds[0].toJSON().title,
        payload.embeds[0].toJSON().description,
        payload.components[0].components[0].toJSON().label,
      ];
      for (const text of texts) {
        assert.ok(text && !/^[a-zA-Z]+\.[a-zA-Z0-9_.]+$/.test(text), `${locale}: ${text}`);
        assert.ok(!String(text).startsWith('scrimConfig.'), `${locale}: unresolved ${text}`);
      }
      assert.equal(texts[0], t(locale, 'scrimConfig.redirectTitle'));
    }
  });

  it('commande scrape-safe : nom + admin', () => {
    const json = scrimConfigurer.data.toJSON();
    assert.equal(json.name, 'scrim-config');
    assert.ok(json.default_member_permissions);
  });
});
