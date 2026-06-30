/**
 * Service dashboard réseau ScrimRéseau.
 *
 * Génère une image PNG montrant les statistiques du réseau (serveurs partenaires,
 * jeux, scrims actives) et publie/édite un message fixe dans un salon configuré.
 *
 * Règles de robustesse :
 * - Ne jamais lancer d'exception qui remonte au bot.
 * - Fallback embed si la génération d'image échoue.
 * - Debounce 30 s pour éviter les rafales d'updates.
 * - Concurrent-lock : un seul update à la fois.
 */

import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';

const _dir = dirname(fileURLToPath(import.meta.url));
/** Chemin absolu vers le logo ScrimRéseau (assets/logo-scrim.png). */
const LOGO_PATH = join(_dir, '..', '..', 'assets', 'logo-scrim.png');

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 30_000;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 h
const ICON_FETCH_TIMEOUT_MS = 5_000;
const MAX_ICONS = 60;
const CANVAS_W = 1200;
const CANVAS_H = 675;

// ---------------------------------------------------------------------------
// État du module
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof setTimeout> | null} */
let debounceTimer = null;
let isUpdating = false;
/** @type {ReturnType<typeof setInterval> | null} */
let refreshHandle = null;
let refreshJobStarted = false;

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/**
 * @param {import('discord.js').Client} client
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
function collectStats(client, stmts) {
  /** @type {Set<string>} */
  const partnerGuildIds = new Set();

  try {
    const rows = stmts.listDistinctPartnerGuildIds.all();
    for (const r of rows) {
      partnerGuildIds.add(/** @type {string} */ (r.guild_id));
    }
  } catch (err) {
    logger.warn('networkDashboard: erreur lecture partner guilds', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    partnerGuildIds,
    partnerCount: partnerGuildIds.size,
    totalGuilds: client.guilds.cache.size,
  };
}

// ---------------------------------------------------------------------------
// Génération image PNG
// ---------------------------------------------------------------------------

/**
 * Charge le logo ScrimRéseau via loadImage (mise en cache par session).
 * Retourne null si le fichier est absent ou illisible — jamais d'exception.
 *
 * @param {(src: Buffer | string) => Promise<import('@napi-rs/canvas').Image>} loadImageFn
 * @returns {Promise<import('@napi-rs/canvas').Image | null>}
 */
let _logoCache = /** @type {import('@napi-rs/canvas').Image | null | 'missing'} */ (null);
async function loadLogoImage(loadImageFn) {
  if (_logoCache === 'missing') return null;
  if (_logoCache !== null) return _logoCache;
  try {
    if (!existsSync(LOGO_PATH)) {
      logger.info('networkDashboard: logo absent — fallback SR', { path: LOGO_PATH });
      _logoCache = 'missing';
      return null;
    }
    _logoCache = await loadImageFn(LOGO_PATH);
    logger.info('networkDashboard: logo chargé', { path: LOGO_PATH });
    return _logoCache;
  } catch (err) {
    logger.warn('networkDashboard: échec chargement logo — fallback SR', {
      message: err instanceof Error ? err.message : String(err),
    });
    _logoCache = 'missing';
    return null;
  }
}

/**
 * Télécharge un buffer depuis une URL (timeout strict).
 * @param {string} url
 * @returns {Promise<Buffer | null>}
 */
async function fetchBuffer(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ICON_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Calcule les positions en orbite autour du centre.
 * ≤ 24 icônes → un anneau. 25-60 → deux anneaux.
 * L'offset angulaire évite les alignements purement verticaux
 * (ex. 2 partenaires → gauche/droite, pas haut/bas).
 *
 * @param {number} count
 * @param {number} centerX
 * @param {number} centerY
 * @param {boolean} [hasOverflow]
 * @returns {{ x: number, y: number, r: number }[]}
 */
function computeOrbitPositions(count, centerX, centerY, hasOverflow = false) {
  const totalSlots = hasOverflow ? count + 1 : count;
  const positions = [];
  if (totalSlots === 0) return positions;

  /**
   * Renvoie l'angle de départ pour un anneau de n slots.
   * Paires → rotation d'un demi-pas pour éviter haut/bas.
   * @param {number} n
   */
  const startAngle = (n) => -Math.PI / 2 + (n % 2 === 0 ? Math.PI / n : 0);

  if (count <= 24) {
    const orbitR = 200; // D : icônes légèrement plus éloignées pour accommoder la taille accrue
    const iconR = 25;   // D : légèrement plus grand (dia 50 px)
    const sa = startAngle(totalSlots);
    for (let i = 0; i < totalSlots; i++) {
      const angle = sa + (i / totalSlots) * Math.PI * 2;
      positions.push({
        x: centerX + orbitR * Math.cos(angle),
        y: centerY + orbitR * Math.sin(angle),
        r: iconR,
      });
    }
  } else {
    // Double anneau : interne 20 max, externe le reste
    const innerCount = Math.min(20, count);
    const outerTotal = totalSlots - innerCount;
    const rInner = 128;
    const rOuter = 200;
    const innerIconR = 20;
    const outerIconR = 20;

    const saInner = startAngle(innerCount);
    for (let i = 0; i < innerCount; i++) {
      const angle = saInner + (i / innerCount) * Math.PI * 2;
      positions.push({ x: centerX + rInner * Math.cos(angle), y: centerY + rInner * Math.sin(angle), r: innerIconR });
    }
    const saOuter = startAngle(outerTotal);
    for (let i = 0; i < outerTotal; i++) {
      const angle = saOuter + (i / outerTotal) * Math.PI * 2;
      positions.push({ x: centerX + rOuter * Math.cos(angle), y: centerY + rOuter * Math.sin(angle), r: outerIconR });
    }
  }
  return positions;
}

/**
 * Dessine le nœud central — cercle +50 %, anneaux concentriques, glow fort.
 * Affiche le logo ScrimRéseau s'il est disponible, sinon le texte "SR".
 *
 * @param {import('@napi-rs/canvas').SKRSContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {import('@napi-rs/canvas').Image | null} [logo]
 */
function drawCentralNode(ctx, x, y, logo = null) {
  const R = 68; // B : +20 % (était 57)
  const PI2 = Math.PI * 2;

  // Grand glow radial (point focal visuel) — légèrement plus fort
  const outerGlow = ctx.createRadialGradient(x, y, 0, x, y, R * 4.0);
  outerGlow.addColorStop(0,   'rgba(88,101,242,0.45)');
  outerGlow.addColorStop(0.4, 'rgba(88,101,242,0.18)');
  outerGlow.addColorStop(1,   'rgba(0,0,0,0)');
  ctx.fillStyle = outerGlow;
  ctx.beginPath();
  ctx.arc(x, y, R * 4.0, 0, PI2);
  ctx.fill();

  // ── Anneaux concentriques HUD ─────────────────────────────────────────
  ctx.save();

  // Anneau 1 : lointain, très discret
  ctx.setLineDash([2, 14]);
  ctx.strokeStyle = 'rgba(88,101,242,0.11)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.arc(x, y, R * 2.5, 0, PI2);
  ctx.stroke();

  // Anneau 2 : intermédiaire
  ctx.setLineDash([3, 9]);
  ctx.strokeStyle = 'rgba(88,101,242,0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, R * 1.85, 0, PI2);
  ctx.stroke();

  // Anneau 3 : proche, visible
  ctx.setLineDash([5, 7]);
  ctx.strokeStyle = 'rgba(88,101,242,0.42)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, R + 15, 0, PI2);
  ctx.stroke();

  ctx.setLineDash([]);

  // ── Points HUD sur l'anneau intermédiaire ────────────────────────────
  const dotRing = R * 1.45;
  const dotCount = 12;
  for (let i = 0; i < dotCount; i++) {
    const a = (i / dotCount) * PI2;
    const isAccent = i % 3 === 0;
    ctx.fillStyle = isAccent ? 'rgba(88,101,242,0.65)' : 'rgba(88,101,242,0.28)';
    ctx.beginPath();
    ctx.arc(x + dotRing * Math.cos(a), y + dotRing * Math.sin(a), isAccent ? 2.5 : 1.4, 0, PI2);
    ctx.fill();
  }

  // ── Tick-marks radiaux (style cadran) ────────────────────────────────
  const tickRing = R * 1.85;
  const tickCount = 8;
  for (let i = 0; i < tickCount; i++) {
    const a = (i / tickCount) * PI2;
    const isMain = i % 2 === 0;
    const len = isMain ? 7 : 4;
    ctx.strokeStyle = isMain ? 'rgba(88,101,242,0.55)' : 'rgba(88,101,242,0.28)';
    ctx.lineWidth = isMain ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(x + (tickRing - len) * Math.cos(a), y + (tickRing - len) * Math.sin(a));
    ctx.lineTo(x + (tickRing + len) * Math.cos(a), y + (tickRing + len) * Math.sin(a));
    ctx.stroke();
  }

  // ── Arcs courts (style HUD futuriste) ────────────────────────────────
  const arcRing = R * 2.5;
  const arcSegments = 6;
  const arcStep = PI2 / arcSegments;
  for (let i = 0; i < arcSegments; i++) {
    const startA = i * arcStep + arcStep * 0.25;
    const endA   = i * arcStep + arcStep * 0.75;
    ctx.strokeStyle = 'rgba(88,101,242,0.20)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, arcRing, startA, endA);
    ctx.stroke();
  }

  ctx.restore();

  // ── Cercle principal ────────────────────────────────────────────────
  const bg = ctx.createRadialGradient(x, y - 14, 0, x, y, R);
  bg.addColorStop(0,   '#2a3490');
  bg.addColorStop(0.6, '#151c5e');
  bg.addColorStop(1,   '#080b28');
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, PI2);
  ctx.fill();

  // Contenu : logo ou texte "SR"
  if (logo) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, R - 2, 0, PI2);
    ctx.clip();
    const scale = Math.max((R * 2) / logo.width, (R * 2) / logo.height);
    const dw = logo.width * scale;
    const dh = logo.height * scale;
    ctx.drawImage(logo, x - dw / 2, y - dh / 2, dw, dh);
    ctx.restore();
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('SR', x, y);
  }

  // Bordure lumineuse (par-dessus le logo)
  ctx.strokeStyle = 'rgba(100,120,255,0.85)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, PI2);
  ctx.stroke();
}

/**
 * Dessine un nœud partenaire avec glow visible et contour lumineux.
 * @param {import('@napi-rs/canvas').SKRSContext2D} ctx
 * @param {import('@napi-rs/canvas').Image | null} img
 * @param {string} initial
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 */
function drawPartnerNode(ctx, img, initial, cx, cy, r) {
  // Glow autour du nœud
  const glow = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 2.8);
  glow.addColorStop(0, 'rgba(88,101,242,0.20)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 2.8, 0, Math.PI * 2);
  ctx.fill();

  // Clip + dessin de l'icône
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  if (img) {
    ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = '#1e2260';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(r * 0.85)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial.toUpperCase(), cx, cy + 1);
  }
  ctx.restore();

  // Contour lumineux (bleu→violet)
  const borderGrad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  borderGrad.addColorStop(0, 'rgba(124,58,237,0.75)');
  borderGrad.addColorStop(1, 'rgba(88,101,242,0.75)');
  ctx.strokeStyle = borderGrad;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
}

/**
 * Génère l'image dashboard — vue "carte du réseau".
 * @param {import('discord.js').Client} client
 * @param {ReturnType<collectStats>} stats
 * @returns {Promise<Buffer | null>} null si la génération échoue
 */
async function generateDashboardImage(client, stats) {
  let createCanvas, loadImage;
  try {
    ({ createCanvas, loadImage } = await import('@napi-rs/canvas'));
  } catch {
    logger.warn('networkDashboard: @napi-rs/canvas indisponible — fallback embed');
    return null;
  }

  try {
    const canvas = createCanvas(CANVAS_W, CANVAS_H);
    const ctx = canvas.getContext('2d');

    // ── Fond premium ─────────────────────────────────────────────────────
    ctx.fillStyle = '#040810';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // 4 halos radiaux pour plus de profondeur
    const CX = 600;
    const CY = 308; // E : légèrement remonté pour rapprocher le compteur du réseau

    const halos = /** @type {[number,number,number,string][]} */ ([
      [CANVAS_W / 2, 0,       480, 'rgba(88,101,242,0.16)'],  // halo haut (titre)
      [CX,          CY,       340, 'rgba(88,101,242,0.22)'],  // halo nœud central
      [0,           CANVAS_H, 380, 'rgba(80,20,140,0.12)'],   // coin bas-gauche
      [CANVAS_W,    CANVAS_H, 400, 'rgba(40,10,90,0.10)'],    // coin bas-droit
    ]);
    for (const [hcx, hcy, hr, hcol] of halos) {
      const g = ctx.createRadialGradient(hcx, hcy, 0, hcx, hcy, hr);
      g.addColorStop(0, hcol);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    }

    // Particules déterministes (golden angle, 120 points)
    for (let i = 0; i < 120; i++) {
      const px = (i * 137.508 + 30) % CANVAS_W;
      const py = (i * 97.31 + 15) % CANVAS_H;
      const pr = (i % 4) * 0.45 + 0.3;
      const pa = ((i % 10) * 0.018 + 0.025).toFixed(3);
      ctx.fillStyle = `rgba(170,195,255,${pa})`;
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, Math.PI * 2);
      ctx.fill();
    }

    // Lignes réseau légères en arrière-plan (nœuds déterministes)
    {
      const nodes = [];
      for (let i = 0; i < 22; i++) {
        nodes.push([(i * 173.13 + 55) % CANVAS_W, (i * 211.71 + 75) % CANVAS_H]);
      }
      ctx.lineWidth = 0.6;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i][0] - nodes[j][0];
          const dy = nodes[i][1] - nodes[j][1];
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 260) {
            ctx.strokeStyle = `rgba(88,101,242,${((1 - dist / 260) * 0.07).toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(nodes[i][0], nodes[i][1]);
            ctx.lineTo(nodes[j][0], nodes[j][1]);
            ctx.stroke();
          }
        }
      }
    }

    // ── Header ──────────────────────────────────────────────────────────
    ctx.textAlign = 'center';

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 48px sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('SCRIMRÉSEAU', CANVAS_W / 2, 56);

    ctx.fillStyle = 'rgba(255,255,255,0.36)';
    ctx.font = '14px sans-serif';
    ctx.fillText('Le réseau ScrimRéseau', CANVAS_W / 2, 78);

    // Séparateur dégradé centré
    {
      const sw = CANVAS_W * 0.36;
      const sx = (CANVAS_W - sw) / 2;
      const g = ctx.createLinearGradient(sx, 0, sx + sw, 0);
      g.addColorStop(0, 'rgba(88,101,242,0)');
      g.addColorStop(0.5, 'rgba(88,101,242,0.45)');
      g.addColorStop(1, 'rgba(88,101,242,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, 90);
      ctx.lineTo(sx + sw, 90);
      ctx.stroke();
    }

    // ── Carte réseau ─────────────────────────────────────────────────────
    // Données partenaires — même source que stats.partnerCount
    const allPartnerIds = [...stats.partnerGuildIds];
    const totalPartner = allPartnerIds.length;
    const toShowIds = allPartnerIds.slice(0, MAX_ICONS);
    const overflow = totalPartner - toShowIds.length;
    const count = toShowIds.length;

    const toShowEntries = toShowIds.map((id) => ({
      guild: client.guilds.cache.get(id) ?? null,
      id,
    }));

    const hasOverflow = overflow > 0;
    const positions = computeOrbitPositions(count, CX, CY, hasOverflow);

    // Téléchargement parallèle des icônes
    const iconBuffers = await Promise.allSettled(
      toShowEntries.map(async ({ guild }) => {
        if (!guild) return null;
        const url = guild.iconURL({ extension: 'png', size: 64 });
        if (!url) return null;
        return fetchBuffer(url);
      }),
    );

    // ── Lignes de connexion (double passe : glow + ligne) ────────────────
    const allConnectedSlots = count + (hasOverflow && positions[count] ? 1 : 0);
    for (let i = 0; i < allConnectedSlots; i++) {
      if (!positions[i]) continue;
      const { x: px, y: py } = positions[i];

      // C — Passe 1 : glow plus large et plus lumineux
      const g1 = ctx.createLinearGradient(CX, CY, px, py);
      g1.addColorStop(0, 'rgba(88,101,242,0.22)');
      g1.addColorStop(1, 'rgba(124,58,237,0.05)');
      ctx.strokeStyle = g1;
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.lineTo(px, py);
      ctx.stroke();

      // C — Passe 2 : ligne précise, légèrement plus épaisse
      const g2 = ctx.createLinearGradient(CX, CY, px, py);
      g2.addColorStop(0, 'rgba(88,101,242,0.65)');
      g2.addColorStop(1, 'rgba(124,58,237,0.14)');
      ctx.strokeStyle = g2;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.lineTo(px, py);
      ctx.stroke();
    }

    // Nœud central (dessiné après les lignes pour apparaître au-dessus)
    const logoImg = await loadLogoImage(loadImage);
    drawCentralNode(ctx, CX, CY, logoImg);

    // Nœuds partenaires
    for (let i = 0; i < count; i++) {
      if (!positions[i]) continue;
      const { x, y, r: iconR } = positions[i];
      const { guild } = toShowEntries[i];
      const bufResult = iconBuffers[i];
      let img = null;
      if (bufResult.status === 'fulfilled' && bufResult.value) {
        try { img = await loadImage(bufResult.value); } catch { /* fallback */ }
      }
      const initial = guild ? (guild.name ?? '?').charAt(0) : '?';
      drawPartnerNode(ctx, img, initial, x, y, iconR);
    }

    // Nœud overflow "+X"
    if (hasOverflow && positions[count]) {
      const { x: ox, y: oy, r: or_ } = positions[count];
      const gf = ctx.createRadialGradient(ox, oy, 0, ox, oy, or_);
      gf.addColorStop(0, 'rgba(100,80,220,0.80)');
      gf.addColorStop(1, 'rgba(60,40,140,0.60)');
      ctx.fillStyle = gf;
      ctx.beginPath();
      ctx.arc(ox, oy, or_, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ox, oy, or_, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.max(10, or_ - 4)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`+${overflow}`, ox, oy);
    }

    // ── Compteur principal — E : remonté pour réduire le vide ─────────────
    ctx.textAlign = 'center';

    // Glow derrière le chiffre
    {
      const cg = ctx.createRadialGradient(CANVAS_W / 2, 580, 0, CANVAS_W / 2, 580, 130);
      cg.addColorStop(0, 'rgba(88,101,242,0.20)');
      cg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = cg;
      ctx.fillRect(CANVAS_W / 2 - 130, 526, 260, 96);
    }

    ctx.fillStyle = '#5c6ef0';
    ctx.font = 'bold 76px sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(String(stats.partnerCount), CANVAS_W / 2, 582);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('COMMUNAUTÉS CONNECTÉES', CANVAS_W / 2, 602);

    // ── Footer ──────────────────────────────────────────────────────────
    const now = new Date();
    const dateStr = now.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`Mise à jour le ${dateStr} à ${timeStr}`, CANVAS_W / 2, CANVAS_H - 11);

    return canvas.toBuffer('image/png');
  } catch (err) {
    logger.error('networkDashboard: erreur génération image', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Embed de fallback
// ---------------------------------------------------------------------------

/**
 * @param {ReturnType<collectStats>} stats
 * @returns {EmbedBuilder}
 */
function buildFallbackEmbed(stats) {
  const now = new Date();
  return new EmbedBuilder()
    .setTitle('🌐 ScrimRéseau — Tableau de bord')
    .setColor(0x5865f2)
    .addFields(
      { name: '🏆 Serveurs partenaires', value: String(stats.partnerCount), inline: true },
      { name: '🌍 Discord total', value: String(stats.totalGuilds), inline: true },
    )
    .setFooter({ text: `Mise à jour le ${now.toLocaleDateString('fr-FR')} à ${now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` })
    .setTimestamp(now);
}

// ---------------------------------------------------------------------------
// Assemblage du contenu à envoyer/éditer
// ---------------------------------------------------------------------------

/**
 * @param {import('discord.js').Client} client
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @returns {Promise<{ content: string, files: AttachmentBuilder[], embeds: EmbedBuilder[] }>}
 */
async function buildDashboardPayload(client, stmts) {
  const stats = collectStats(client, stmts);
  const imgBuffer = await generateDashboardImage(client, stats);

  if (imgBuffer) {
    return {
      content: '',
      files: [new AttachmentBuilder(imgBuffer, { name: 'scrimreseau-dashboard.png' })],
      embeds: [],
    };
  }

  return {
    content: '',
    files: [],
    embeds: [buildFallbackEmbed(stats)],
  };
}

// ---------------------------------------------------------------------------
// Création / édition d'un message dashboard
// ---------------------------------------------------------------------------

/**
 * Édite ou crée le message dashboard pour une ligne de config DB.
 *
 * @param {import('discord.js').Client} client
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {{ guild_id: string, channel_id: string, message_id: string | null }} row
 * @returns {Promise<void>}
 */
async function syncOneDashboard(client, stmts, row) {
  const { guild_id, channel_id, message_id } = row;

  let guild;
  try {
    guild = client.guilds.cache.get(guild_id) ?? await client.guilds.fetch(guild_id).catch(() => null);
  } catch {
    guild = null;
  }

  if (!guild) {
    logger.warn('networkDashboard: guilde introuvable — dashboard ignoré', { guild_id });
    return;
  }

  let channel;
  try {
    channel = guild.channels.cache.get(channel_id) ?? await guild.channels.fetch(channel_id).catch(() => null);
  } catch {
    channel = null;
  }

  if (!channel?.isTextBased()) {
    logger.warn('networkDashboard: salon introuvable ou non texte — dashboard ignoré', { guild_id, channel_id });
    return;
  }

  const payload = await buildDashboardPayload(client, stmts);
  const nowIso = new Date().toISOString();

  // Tentative d'édition du message existant
  if (message_id) {
    let existingMsg = null;
    try {
      existingMsg = await channel.messages.fetch(message_id).catch(() => null);
    } catch {
      existingMsg = null;
    }

    if (existingMsg) {
      try {
        await existingMsg.edit({ ...payload, attachments: [] });
        stmts.updateNetworkDashboardMessageId.run({
          message_id,
          updated_at: nowIso,
          guild_id,
          channel_id,
        });
        logger.info('networkDashboard: message édité', { guild_id, channel_id, message_id });
        return;
      } catch (err) {
        logger.warn('networkDashboard: édition impossible — recréation', {
          guild_id,
          channel_id,
          message_id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Création d'un nouveau message
  try {
    const sent = await channel.send(payload);
    stmts.updateNetworkDashboardMessageId.run({
      message_id: sent.id,
      updated_at: nowIso,
      guild_id,
      channel_id,
    });
    logger.info('networkDashboard: nouveau message créé', { guild_id, channel_id, message_id: sent.id });
  } catch (err) {
    logger.error(`networkDashboard: impossible d'envoyer le message`, {
      guild_id,
      channel_id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------

/**
 * Met à jour tous les dashboards configurés en DB.
 *
 * @param {import('discord.js').Client} client
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
export async function updateNetworkDashboard(client, stmts) {
  if (isUpdating) {
    logger.info('networkDashboard: update déjà en cours — ignoré');
    return;
  }

  isUpdating = true;
  try {
    let rows = [];
    try {
      rows = stmts.getAllNetworkDashboards.all();
    } catch (err) {
      logger.error('networkDashboard: erreur lecture dashboards DB', {
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (rows.length === 0) return;

    for (const row of rows) {
      await syncOneDashboard(client, stmts, {
        guild_id: String(row.guild_id),
        channel_id: String(row.channel_id),
        message_id: row.message_id ? String(row.message_id) : null,
      });
    }
  } finally {
    isUpdating = false;
  }
}

/**
 * Planifie une mise à jour avec debounce de 30 s.
 * Idempotent : appels multiples = un seul update déclenché.
 *
 * @param {import('discord.js').Client} client
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
export function scheduleNetworkDashboardUpdate(client, stmts) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void updateNetworkDashboard(client, stmts).catch((err) => {
      logger.error('networkDashboard: erreur update debounced', {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }, DEBOUNCE_MS);
}

/**
 * Crée ou édite le dashboard dans un salon spécifique via une commande.
 * Enregistre la configuration en DB.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').TextBasedChannel & { guild: import('discord.js').Guild }} channel
 * @param {string} userId
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function createOrUpdateNetworkDashboardMessage(client, channel, userId, stmts) {
  const guildId = channel.guild.id;
  const channelId = channel.id;
  const nowIso = new Date().toISOString();

  // Lire le message_id AVANT l'upsert pour ne pas l'écraser avec null.
  // Sans cette lecture préalable, ON CONFLICT écrase l'ID existant → nouveau message créé.
  let existingMessageId = null;
  try {
    const existing = stmts.getAllNetworkDashboards.all()
      .find((r) => String(r.guild_id) === guildId && String(r.channel_id) === channelId);
    existingMessageId = existing?.message_id ? String(existing.message_id) : null;
  } catch {
    /* on continue sans message_id existant */
  }

  // Upsert de la config — message_id préservé (null uniquement si aucun message connu)
  try {
    stmts.upsertNetworkDashboard.run({
      guild_id: guildId,
      channel_id: channelId,
      message_id: existingMessageId,
      created_by: userId,
      updated_at: nowIso,
    });
  } catch (err) {
    logger.error('networkDashboard: erreur upsert config', {
      guild_id: guildId,
      channel_id: channelId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: 'Erreur base de données lors de la configuration.' };
  }

  await syncOneDashboard(client, stmts, {
    guild_id: guildId,
    channel_id: channelId,
    message_id: existingMessageId,
  });

  logger.event('networkDashboard: dashboard configuré', {
    guild_id: guildId,
    channel_id: channelId,
    user_id: userId,
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Job de rafraîchissement automatique (1 h)
// ---------------------------------------------------------------------------

/**
 * @param {import('discord.js').Client} client
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
export function startDashboardRefreshJob(client, stmts) {
  if (refreshJobStarted) return;
  refreshJobStarted = true;

  const tick = () => {
    void updateNetworkDashboard(client, stmts).catch((err) => {
      logger.error('networkDashboard: erreur refresh job', {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  };

  refreshHandle = setInterval(tick, REFRESH_INTERVAL_MS);
  if (refreshHandle.unref) refreshHandle.unref();
  logger.info('networkDashboard: job refresh 1h démarré');
}

export function stopDashboardRefreshJob() {
  if (refreshHandle) {
    clearInterval(refreshHandle);
    refreshHandle = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  refreshJobStarted = false;
  logger.info('networkDashboard: job refresh arrêté');
}
