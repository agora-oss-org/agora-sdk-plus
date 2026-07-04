// Shared parsing for the emailed auth landing pages (verify-email, reset-password). Both links arrive
// as {origin}/auth/<flow>?projectId=<pid>&token=<t>. This reads the token and FAILS CLOSED when the
// link's projectId disagrees with the provider's — a token minted for another project must never be
// replayed against this one. The token is single-use recovery/confirmation material: it is never
// logged, and stripTokenFromUrl() removes it from the address bar after a successful consume.

/** Outcome of parsing an emailed auth link's query string. */
export type ParsedAuthLink =
  | { ok: true; token: string }
  | { ok: false; reason: "missing-token" | "project-mismatch" };

/**
 * Parse the `token`/`projectId` query of an emailed auth link, failing closed on a projectId mismatch.
 *
 * @param providerProjectId - the projectId from the SDK's `useProject()`; the authority for this app.
 * @param search - the query string to parse. Defaults to `window.location.search`.
 * @returns {@link ParsedAuthLink} — `ok:true` with the token, or `ok:false` with the reason.
 * @example
 * const link = parseAuthLink(projectId);
 * if (!link.ok) return showError(link.reason);
 * await verifyEmail({ token: link.token });
 */
export function parseAuthLink(
  providerProjectId: string | undefined,
  search: string = typeof window !== "undefined" ? window.location.search : ""
): ParsedAuthLink {
  const params = new URLSearchParams(search);
  const token = params.get("token")?.trim();
  const linkProjectId = params.get("projectId")?.trim();
  // A link naming a different project than this app is configured for is not ours to consume — never
  // send its token. A link that omits projectId defers to the provider's id (the server scopes by path).
  if (linkProjectId && providerProjectId && linkProjectId !== providerProjectId) {
    return { ok: false, reason: "project-mismatch" };
  }
  if (!token) {
    return { ok: false, reason: "missing-token" };
  }
  return { ok: true, token };
}

/**
 * Remove the `token` query param from the current URL via `history.replaceState`, so a single-use
 * confirmation/recovery token doesn't linger in the address bar or browser history. Best-effort and
 * never throws — guarded for environments without `window.history`.
 */
export function stripTokenFromUrl(): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("token")) return;
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch {
    // URL hygiene is best-effort and must never break the flow.
  }
}
