// The ONLY module that knows the Agora SDK's account-storage contract: the
// `replyke-accounts:<projectId>` key prefix and the multi-account map shape persisted by the SDK's
// `useAccountSync`. Quarantining it here means an upstream contract change touches one file, not every
// integrator's callback page. We read PRESENCE of a refresh token, never log its value.

/** One stored account's user summary (mirrors the SDK's persisted shape). */
export type AccountSummary = {
  id: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
};

/** One stored account: its current refresh token, expiry, and user summary. */
export type AccountEntry = {
  refreshToken: string;
  tokenExpiresAt: number;
  user: AccountSummary;
};

/** The full multi-account map the SDK persists per project. */
export type AccountMap = {
  activeAccountId: string | null;
  accounts: Record<string, AccountEntry>;
};

/** The localStorage key the SDK persists the account map under, for a given project. */
export function accountsStorageKey(projectId: string): string {
  return `replyke-accounts:${projectId}`;
}

/** Read + parse the persisted account map, or null if absent/corrupt. Never throws. */
export function readAccountMap(projectId: string): AccountMap | null {
  try {
    const raw = localStorage.getItem(accountsStorageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AccountMap;
    if (!parsed || typeof parsed !== "object" || !parsed.accounts) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** True when the persisted map has a refresh token for this user — the exact state the next document reads on boot. */
export function hasPersistedRefreshToken(projectId: string, userId: string): boolean {
  const map = readAccountMap(projectId);
  return Boolean(map?.accounts?.[userId]?.refreshToken);
}

/**
 * The active account's id + token expiry, or null when there is no active account with a refresh
 * token (no map, no `activeAccountId`, or the active entry is missing/tokenless). `tokenExpiresAt` is
 * read straight from the persisted entry — it advances on every fresh login, so it doubles as a cheap
 * "is this a newer session than before?" signal without ever touching the raw token value.
 */
export function readActiveAccount(
  projectId: string
): { id: string; tokenExpiresAt: number } | null {
  const map = readAccountMap(projectId);
  const id = map?.activeAccountId;
  if (!id) return null;
  const entry = map.accounts[id];
  if (!entry?.refreshToken) return null;
  return { id, tokenExpiresAt: entry.tokenExpiresAt ?? 0 };
}

/**
 * Remove **every** stored account for a project. Used to clear pre-existing (and possibly stale)
 * state before a fresh login so no stale boot-refresh competes with the new session. Each removal
 * dispatches a synthetic `storage` event via {@link pruneAccount}.
 */
export function pruneAllAccounts(projectId: string): void {
  const map = readAccountMap(projectId);
  if (!map) return;
  for (const id of Object.keys(map.accounts)) pruneAccount(projectId, id);
}

/**
 * Remove an account from the persisted map and write it back. Returns the new map, or null if the
 * user wasn't present (no-op). After writing, dispatches a synthetic `storage` event for the same
 * key so the SDK's `useAccountSync` Phase D listener adopts the pruned map IN THIS TAB (native
 * `storage` events fire only in OTHER tabs), letting the SDK re-evaluate remaining accounts without
 * reaching into its Redux store.
 */
export function pruneAccount(projectId: string, userId: string): AccountMap | null {
  const map = readAccountMap(projectId);
  if (!map || !map.accounts[userId]) return null;

  const accounts = { ...map.accounts };
  delete accounts[userId];
  const nextActive = map.activeAccountId === userId ? null : map.activeAccountId;
  const next: AccountMap = { activeAccountId: nextActive, accounts };

  const key = accountsStorageKey(projectId);
  const oldValue = localStorage.getItem(key);
  const newValue = JSON.stringify(next);
  localStorage.setItem(key, newValue);
  window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue }));
  return next;
}
