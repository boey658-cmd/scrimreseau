/** @typedef {'high' | 'low'} ScrimLifecycleDbPriority */

/**
 * Seuil d'attente (ms) au-delà duquel une op NORMAL (supersede / low) devient « starved »
 * et est promue au tier 1 du tri SQL (après HIGH tier 0, avant NORMAL non-starved).
 */
export const SCRIM_LIFECYCLE_STARVATION_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Nombre de dispatchs HIGH consécutifs après lequel une NORMAL starved (≥ seuil)
 * obtient ponctuellement un slot, même si des HIGH restent en file.
 */
export const SCRIM_LIFECYCLE_STARVATION_BURST_AFTER_HIGH = 8;

/**
 * @param {Record<string, unknown>} op
 * @returns {boolean}
 */
export function isHighTierLifecycleOp(op) {
  if (op.target_status === 'closed_manual' || op.target_status === 'closed_expired') return true;
  if (op.operation_type === 'lifecycle_delete') return true;
  return false;
}

/**
 * @param {Record<string, unknown>} op
 * @param {string} [nowIso]
 * @param {number} [thresholdMs]
 * @returns {boolean}
 */
export function isStarvedLifecycleOp(
  op,
  nowIso = new Date().toISOString(),
  thresholdMs = SCRIM_LIFECYCLE_STARVATION_THRESHOLD_MS,
) {
  if (isHighTierLifecycleOp(op)) return false;
  if (op.target_status !== 'superseded_repost' && op.priority !== 'low') return false;
  const createdAt = /** @type {string} */ (op.created_at ?? '1970-01-01T00:00:00.000Z');
  const ageMs = new Date(nowIso).getTime() - new Date(createdAt).getTime();
  return ageMs >= thresholdMs;
}

/**
 * Priorité DB pour une op orchestrée.
 * HIGH : close + delete final
 * LOW  : supersede / edit normal (NORMAL mappé sur low — tri dispatcher via CASE target_status)
 *
 * @param {string} targetStatus
 * @param {'lifecycle_edit' | 'lifecycle_delete'} operationType
 * @returns {ScrimLifecycleDbPriority}
 */
export function resolveOrchestratedLifecyclePriority(targetStatus, operationType) {
  if (operationType === 'lifecycle_delete') return 'high';
  if (targetStatus === 'closed_manual' || targetStatus === 'closed_expired') return 'high';
  return 'low';
}

/**
 * Score numérique pour tests / observabilité (0 = highest).
 *
 * @param {Record<string, unknown>} op
 * @returns {number}
 */
export function lifecycleDispatchPriorityScore(op) {
  if (op.target_status === 'closed_manual' || op.target_status === 'closed_expired') return 0;
  if (op.operation_type === 'lifecycle_delete') return 0;
  if (op.target_status === 'superseded_repost') return 2;
  return 3;
}
