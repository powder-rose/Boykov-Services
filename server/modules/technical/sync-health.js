// Status of the Google accounting feed, derived from server-side SQLite metadata.
// Page refreshes and edits to unrelated technical worksheets are NOT heartbeats.
export const ACCOUNTING_STALE_AFTER_MINUTES = 20;
const STALE_MS = ACCOUNTING_STALE_AFTER_MINUTES * 60_000;
const validTime = (value) => {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : null;
};

export function technicalSyncHealth(store, mode, now = Date.now()) {
  const lastReconcileAt = store.meta('accountingLastReconcileAt');
  const lastChangeAt = store.meta('accountingLastSuccessAt');
  const lastError = store.meta('accountingLastError');
  const lastErrorAt = store.meta('accountingLastErrorAt');
  // Existing deployments have one old updatedAt value until the first new
  // successful reconciliation. It is a fallback, not proof of reconciliation.
  const legacyAt = store.meta('updatedAt');
  const checkTime = validTime(lastReconcileAt) ?? validTime(lastChangeAt) ?? validTime(legacyAt);
  const ageMinutes = checkTime === null ? null : Math.max(0, Math.floor((now - checkTime) / 60_000));
  const overdue = checkTime !== null && now - checkTime >= STALE_MS;
  const level = mode === 'none' ? 'disabled' : lastError ? 'error'
    : overdue ? 'stale' : lastReconcileAt ? 'ok' : 'pending';
  return {
    level, lastReconcileAt: lastReconcileAt || null,
    lastChangeAt: lastChangeAt || null,
    lastError: lastError || null, lastErrorAt: lastErrorAt || null,
    ageMinutes, staleAfterMinutes: ACCOUNTING_STALE_AFTER_MINUTES,
    checkedAt: new Date(now).toISOString(),
  };
}
