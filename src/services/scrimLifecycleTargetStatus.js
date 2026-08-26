/**
 * Source de vérité visuelle Phase 3B — validité d'un target_status lifecycle
 * par rapport au statut métier courant du scrim (scrim_posts.status).
 *
 * Statuts scrim_posts connus : active | closed_manual | closed_expired
 * target_status lifecycle : closed_manual | closed_expired | superseded_repost
 *
 * Cas ambigus documentés :
 * - scrimPostStatus manquant/inconnu → fail-closed (current: false)
 * - target_status inconnu → fail-closed (current: false)
 * - superseded_repost n'est pas un statut scrim_posts ; valide uniquement si active
 */

/** @typedef {'active' | 'closed_manual' | 'closed_expired'} ScrimPostStatus */
/** @typedef {'closed_manual' | 'closed_expired' | 'superseded_repost'} LifecycleTargetStatus */

const KNOWN_SCRIM_POST_STATUSES = new Set(['active', 'closed_manual', 'closed_expired']);
const KNOWN_LIFECYCLE_TARGETS = new Set([
  'closed_manual',
  'closed_expired',
  'superseded_repost',
]);

/**
 * @param {string | null | undefined} scrimPostStatus
 * @param {string | null | undefined} targetStatus
 * @returns {{ current: boolean, reason?: string }}
 */
export function isScrimLifecycleTargetStatusCurrent(scrimPostStatus, targetStatus) {
  const postStatus = scrimPostStatus ?? null;
  const target = targetStatus ?? null;

  if (!postStatus || !KNOWN_SCRIM_POST_STATUSES.has(postStatus)) {
    return { current: false, reason: 'unknown_scrim_post_status' };
  }

  if (!target || !KNOWN_LIFECYCLE_TARGETS.has(target)) {
    return { current: false, reason: 'unknown_target_status' };
  }

  if (postStatus === 'closed_manual') {
    if (target === 'closed_manual') return { current: true };
    return { current: false, reason: 'stale_target_status' };
  }

  if (postStatus === 'closed_expired') {
    if (target === 'closed_expired') return { current: true };
    return { current: false, reason: 'stale_target_status' };
  }

  // postStatus === 'active'
  if (target === 'superseded_repost') return { current: true };
  // closed_manual / closed_expired ne doivent pas être rejoués tant que le scrim est actif
  return { current: false, reason: 'stale_target_status' };
}

/**
 * Indique si un target_status représente une fermeture définitive (embed fermé).
 *
 * @param {string | null | undefined} targetStatus
 * @returns {boolean}
 */
export function isDefinitiveLifecycleCloseTarget(targetStatus) {
  return targetStatus === 'closed_manual' || targetStatus === 'closed_expired';
}
