/**
 * Tests de non-régression pour les bugs de `locale` non déclaré.
 * Vérifie statiquement que `const locale = getGuildLocale(...)` est déclaré
 * dans le scope de execute() AVANT tout appel `t(locale, ...)`.
 *
 * Bug original : mesDemandes.js, spammer.js, scrimTrouve.js, rechercheScrim.js
 * utilisaient `locale` sans déclaration → ReferenceError en production.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_COMMANDS = path.join(__dirname, '..', 'src', 'commands');

/**
 * Lit un fichier de commande et retourne toutes les fonctions execute() parsées simplement.
 * Vérifie que `const locale = getGuildLocale(` apparaît avant `t(locale,` dans le même bloc execute.
 */
function checkLocaleDeclarationBeforeUse(filename) {
  const content = readFileSync(path.join(SRC_COMMANDS, filename), 'utf8');

  // Trouver la position de toutes les déclarations `const locale = getGuildLocale(`
  const declPositions = [...content.matchAll(/const\s+locale\s*=\s*getGuildLocale\s*\(/g)].map(m => m.index);

  // Trouver toutes les utilisations `t(locale,` qui ne sont PAS dans une helper function paramétrique
  // On exclut les cas où `locale` est un paramètre de fonction (pattern: `function ...(... locale ...))`)
  const allTLocale = [...content.matchAll(/\bt\s*\(\s*locale\s*,/g)].map(m => m.index);

  // Pour chaque usage de t(locale, ...) :
  // S'assurer qu'il existe au moins une déclaration DANS LE MEME SCOPE ou un scope parent avant cet usage.
  // Simplification : vérifier si le contexte local montre une déclaration de fonction avec `locale` comme param.
  const issues = [];
  for (const useIdx of allTLocale) {
    const before = content.slice(0, useIdx);
    
    // Check 1: Is this usage inside a helper function that has locale as parameter?
    // Look for `function ...(... locale ...)` or `(... locale ...) =>` before this usage
    const inHelperFunc = /(?:function\s+\w+\s*\([^)]*\blocale\b[^)]*\)|,\s*locale\s*[,)]|\(\s*locale\s*\))\s*(?:=>)?\s*\{[^}]*$/.test(before);
    
    // Check 2: Is there a `const locale = getGuildLocale(` before this use?
    const hasDecl = declPositions.some(d => d < useIdx);
    
    if (!inHelperFunc && !hasDecl) {
      const context = content.slice(Math.max(0, useIdx - 80), useIdx + 80);
      issues.push({ useIdx, context });
    }
  }

  return { issues, declCount: declPositions.length, useCount: allTLocale.length };
}

describe('locale déclaré avant usage dans execute()', () => {
  const files = [
    'mesDemandes.js',
    'spammer.js',
    'scrimTrouve.js',
    'rechercheScrim.js',
    'listeScrims.js',
    'structureLien.js',
    'scrimConfigurer.js',
    'language.js',
    'help.js',
    'helpAdmin.js',
    'scrimModeration.js',
  ];

  for (const f of files) {
    it(`${f} — locale déclaré avant t(locale, ...)`, () => {
      const { issues, declCount, useCount } = checkLocaleDeclarationBeforeUse(f);
      assert.equal(
        issues.length,
        0,
        `${f}: ${issues.length} usage(s) de t(locale, ...) sans déclaration préalable.\n` +
        issues.map(i => `  → position ${i.useIdx}: ...${i.context.replace(/\n/g, '↵')}...`).join('\n'),
      );
    });
  }

  it('blockScrimUser.js — locale reçu comme paramètre (non déclaré localement)', () => {
    const content = readFileSync(path.join(SRC_COMMANDS, 'blockScrimUser.js'), 'utf8');
    // locale doit être un paramètre de la fonction principale
    assert.ok(
      /executeBlockScrimUserCore\s*\([^)]*\blocale\b[^)]*\)/.test(content),
      'executeBlockScrimUserCore doit accepter locale comme paramètre',
    );
  });

  it('unblockScrimUser.js — locale reçu comme paramètre', () => {
    const content = readFileSync(path.join(SRC_COMMANDS, 'unblockScrimUser.js'), 'utf8');
    assert.ok(
      /executeUnblockScrimUserCore\s*\([^)]*\blocale\b[^)]*\)/.test(content),
      'executeUnblockScrimUserCore doit accepter locale comme paramètre',
    );
  });
});
