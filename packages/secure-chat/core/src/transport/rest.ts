// Typed REST client for the secure-chat blind Delivery Service.
//
// Covers every endpoint in agora-server `docs/SECURE_CHAT.md` §9. Base URL and access token are
// resolved **lazily per request** via caller-supplied resolvers, so a token
// refresh or a late-set baseUrl always wins. All binary is base64 on the wire; this client never
// inspects payloads.

import axios, { AxiosInstance } from "axios";
import { createDebugLogger } from "../util/debug.js";
import {
  AddSecureMemberBody,
  CreateSecureConversationBody,
  PublishKeyPackagesBody,
  RegisterDeviceBody,
  RemoveSecureMemberBody,
  RestoreBlobModel,
  SecureConversationMemberModel,
  SecureConversationModel,
  SecureDeviceModel,
  SecureHandshakeModel,
  SecureKeyBackupModel,
  SecureKeyPackageClaim,
  SecureMessageModel,
  SendSecureMessageBody,
  UploadKeyBackupBody,
  UploadRestoreBlobBody,
  UploadRestoreBlobResponse,
} from "../contract/index.js";

/**
 * A typed error for the restore-blob endpoints, carrying the server's stable error `code` so callers
 * branch on the code (never a parsed string). Caps/quotas are per-deployment — `413
 * secure-chat/restore-blob-too-large` is the authoritative cap signal; `429 common/rate-limited` is the
 * quota signal.
 */
export class SecureRestoreError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string
  ) {
    super(message ?? code);
    this.name = "SecureRestoreError";
  }
}

/** Narrow an axios error to its `{ status, code }`, or null if it isn't one. */
function restoreErr(err: unknown): { status: number; code: string } | null {
  if (axios.isAxiosError(err) && err.response) {
    return {
      status: err.response.status,
      code: (err.response.data as { code?: string } | undefined)?.code ?? "",
    };
  }
  return null;
}

/**
 * Configuration for {@link SecureChatRestClient}. The base URL and access token are read through
 * resolver callbacks rather than captured once, so a late-set `baseUrl` or a refreshed token take
 * effect on the next request without rebuilding the client.
 */
export interface SecureChatRestConfig {
  /** Resolve the API base URL incl. the version prefix (e.g. `() => "https://host/v7"`). */
  getBaseUrl: () => string;
  /** Resolve the current access token, or undefined when signed out. */
  getAccessToken: () => string | undefined;
  /** The Agora project id (path-scoped on every endpoint). */
  projectId: string;
}

/**
 * Typed REST client for the secure-chat blind Delivery Service.
 *
 * Wraps every endpoint in agora-server `docs/SECURE_CHAT.md` §9. Each request lazily resolves the
 * base URL and bearer token via the configured resolvers, scopes the path to
 * `{baseUrl}/{projectId}/secure-chat`, and passes payloads through untouched — all binary is base64
 * on the wire and the client never inspects it.
 *
 * @remarks
 * Construct this directly only for advanced / non-React use. Inside React, prefer the
 * `SecureChatProvider` + hooks, which build and share one client for you.
 *
 * @example
 * ```typescript
 * const rest = new SecureChatRestClient({
 *   projectId,
 *   getBaseUrl: () => "https://host/v7",
 *   getAccessToken: () => session.accessToken,
 * });
 * const device = await rest.registerDevice(body);
 * ```
 */
export class SecureChatRestClient {
  private readonly http: AxiosInstance;
  private readonly log = createDebugLogger("rest");

  constructor(private readonly config: SecureChatRestConfig) {
    this.http = axios.create();
    this.http.interceptors.request.use((req) => {
      const base = config.getBaseUrl().replace(/\/$/, "");
      req.baseURL = `${base}/${config.projectId}/secure-chat`;
      const token = config.getAccessToken();
      if (token) req.headers.set("Authorization", `Bearer ${token}`);
      // One trace site for every endpoint: line = method + path + query; body at trace level only
      // (request bodies carry base64 KeyPackages/Welcomes/ciphertext — fine for a dev-only switch).
      const where = `${req.method?.toUpperCase()} ${req.url}`;
      this.log.debug(`→ ${where}`, req.params);
      this.log.trace(`→ ${where} body`, req.data);
      return req;
    });
    this.http.interceptors.response.use(
      (res) => {
        const where = `${res.config.method?.toUpperCase()} ${res.config.url}`;
        this.log.debug(`← ${res.status} ${where}`, summarizeBody(res.data));
        this.log.trace(`← ${where} body`, res.data);
        return res;
      },
      (err) => {
        // Errors are surfaced to callers as-is; this only narrates them. 404 on getKeyBackup and the
        // 409 conflict paths are expected control flow, not bugs — the status makes that legible.
        if (axios.isAxiosError(err)) {
          const where = `${err.config?.method?.toUpperCase()} ${err.config?.url}`;
          this.log.debug(`✗ ${err.response?.status ?? "network-error"} ${where}`, {
            code: (err.response?.data as { code?: string })?.code,
            message: err.message,
          });
        }
        return Promise.reject(err);
      }
    );
  }

  // ── Devices ────────────────────────────────────────────────────────────────
  /**
   * Register (or idempotently re-assert) the caller's MLS device — its signature key + credential.
   *
   * @param body - The device identity to publish (deviceId, base64 signature key, credential, ciphersuite).
   * @returns The persisted device row; its `.id` is the uuid used as `targetDeviceId` elsewhere.
   */
  async registerDevice(body: RegisterDeviceBody): Promise<SecureDeviceModel> {
    const { data } = await this.http.post<SecureDeviceModel>("/devices", body);
    return data;
  }

  /** Public device records (signature key + credential) so peers can build a group. */
  async listDevices(userId: string): Promise<SecureDeviceModel[]> {
    const { data } = await this.http.get<{ data: SecureDeviceModel[] }>("/devices", {
      params: { userId },
    });
    return data.data;
  }

  /** Revoke the caller's own device. */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.http.delete(`/devices/${encodeURIComponent(deviceId)}`);
  }

  /**
   * Does the server still hold this device row? Probes the cheap device-scoped key-package count
   * endpoint, which is gated by the server's `getMyDevice()` and 404s with
   * `secure-chat/device-not-found` when the row was wiped or revoked. Used to reconcile the
   * split-brain where a client persists a device locally that the server no longer has — adopting
   * such a ghost leaves every device-scoped call failing 404 with no recovery path.
   *
   * - `true`  on 200 — the server has it; safe to adopt the persisted identity.
   * - `false` on a definitive `404 secure-chat/device-not-found` — split-brain; the caller MUST clear
   *   local state and re-register rather than trust the ghost.
   * - RE-THROWS any other error (network / 5xx) so a transient failure is never mistaken for
   *   "device gone" — destroying local crypto identity over a blip would be a far worse failure.
   */
  async deviceExists(deviceId: string): Promise<boolean> {
    try {
      await this.http.get(`/devices/${encodeURIComponent(deviceId)}/key-packages/count`);
      return true;
    } catch (err) {
      if (
        axios.isAxiosError(err) &&
        err.response?.status === 404 &&
        (err.response.data as { code?: string } | undefined)?.code === "secure-chat/device-not-found"
      ) {
        return false;
      }
      throw err;
    }
  }

  // ── KeyPackages ──────────────────────────────────────────────────────────────
  /**
   * Publish a batch of fresh, single-use KeyPackages for one of the caller's devices so peers can
   * add it to groups.
   *
   * @param deviceId - The caller's device row id (`SecureDeviceModel.id`).
   * @param body - The KeyPackage bundles to upload (base64 KeyPackage + ref + ciphersuite).
   * @returns How many KeyPackages the server accepted and stored.
   */
  async publishKeyPackages(deviceId: string, body: PublishKeyPackagesBody): Promise<number> {
    const { data } = await this.http.post<{ published: number }>(
      `/devices/${encodeURIComponent(deviceId)}/key-packages`,
      body
    );
    return data.published;
  }

  /** Unconsumed + unexpired KeyPackage count for the caller's device (replenishment signal). */
  async keyPackageCount(deviceId: string): Promise<number> {
    const { data } = await this.http.get<{ available: number }>(
      `/devices/${encodeURIComponent(deviceId)}/key-packages/count`
    );
    return data.available;
  }

  /**
   * Atomically claim one KeyPackage for a TARGET device (to add it to a group).
   * Throws on `409 secure-chat/key-packages-exhausted` — caller should surface "device unavailable".
   */
  async claimKeyPackage(targetDeviceId: string): Promise<SecureKeyPackageClaim> {
    const { data } = await this.http.post<SecureKeyPackageClaim>(
      `/devices/${encodeURIComponent(targetDeviceId)}/key-packages/claim`
    );
    return data;
  }

  // ── Conversations ────────────────────────────────────────────────────────────
  /**
   * Register a new secure conversation on the blind DS, relaying the client-built Welcomes.
   *
   * @param body - The conversation type, base64 MLS group id, member user ids, and targeted Welcomes.
   * @returns The created conversation row.
   */
  async createConversation(body: CreateSecureConversationBody): Promise<SecureConversationModel> {
    const { data } = await this.http.post<SecureConversationModel>("/conversations", body);
    return data;
  }

  /**
   * List the caller's secure conversations, newest activity first.
   *
   * @param params - Optional `limit` and opaque `cursor` for keyset pagination.
   * @returns A page of conversations plus a `hasMore` flag for further paging.
   */
  async listConversations(params?: {
    limit?: number;
    cursor?: string;
  }): Promise<{ conversations: SecureConversationModel[]; hasMore: boolean }> {
    const { data } = await this.http.get<{
      conversations: SecureConversationModel[];
      hasMore: boolean;
    }>("/conversations", { params });
    return data;
  }

  /**
   * Fetch a single conversation by id (including the caller's membership + unread metadata).
   *
   * @param conversationId - The conversation's id.
   * @returns The conversation row.
   */
  async getConversation(conversationId: string): Promise<SecureConversationModel> {
    const { data } = await this.http.get<SecureConversationModel>(
      `/conversations/${encodeURIComponent(conversationId)}`
    );
    return data;
  }

  /** Mark the conversation read up to now (sets the member's `last_read_at`). */
  async markRead(conversationId: string): Promise<void> {
    await this.http.post(`/conversations/${encodeURIComponent(conversationId)}/read`);
  }

  // ── Membership (client supplies the MLS Commit + Welcomes; the DS linearizes) ──
  /**
   * Add a user to a conversation by relaying the caller-built Commit + per-device Welcomes.
   *
   * @param conversationId - The conversation to add the member to.
   * @param body - The new member's user id, the broadcast Commit, and the targeted Welcomes.
   * @returns The newly created membership row.
   */
  async addMember(
    conversationId: string,
    body: AddSecureMemberBody
  ): Promise<SecureConversationMemberModel> {
    const { data } = await this.http.post<SecureConversationMemberModel>(
      `/conversations/${encodeURIComponent(conversationId)}/members`,
      body
    );
    return data;
  }

  /** Admin remove, or self-leave. Returns the new epoch. Throws on `409 epoch-conflict` (rebase). */
  async removeMember(
    conversationId: string,
    userId: string,
    body: RemoveSecureMemberBody
  ): Promise<{ epoch: string }> {
    const { data } = await this.http.delete<{ success: boolean; epoch: string }>(
      `/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`,
      { data: body }
    );
    return { epoch: data.epoch };
  }

  // ── Messages ──────────────────────────────────────────────────────────────────
  /**
   * Send one MLS application message (opaque ciphertext) to a conversation.
   *
   * @param conversationId - The target conversation.
   * @param body - The base64 ciphertext, its epoch, the sending device id, and optional content type.
   * @returns The stored message row.
   */
  async sendMessage(
    conversationId: string,
    body: SendSecureMessageBody
  ): Promise<SecureMessageModel> {
    const { data } = await this.http.post<SecureMessageModel>(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      body
    );
    return data;
  }

  /**
   * Page through a conversation's messages, newest first (still encrypted — decrypt client-side).
   *
   * @param conversationId - The conversation to read.
   * @param params - Optional `limit` and a `before` cursor (page older than this point).
   * @returns A page of message rows plus a `hasMore` flag.
   */
  async listMessages(
    conversationId: string,
    params?: { limit?: number; before?: string }
  ): Promise<{ messages: SecureMessageModel[]; hasMore: boolean }> {
    const { data } = await this.http.get<{ messages: SecureMessageModel[]; hasMore: boolean }>(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      { params }
    );
    return data;
  }

  // ── Handshake inbox + key backup ───────────────────────────────────────────────
  /**
   * The durable catch-up path: union of targeted Welcomes + broadcast Commits/Proposals for the
   * caller's device, ordered by `seq > since`. Page by passing the last `seq` you processed.
   */
  async fetchHandshakes(
    deviceId: string,
    params?: { since?: string; limit?: number }
  ): Promise<{ handshakes: SecureHandshakeModel[]; hasMore: boolean }> {
    const { data } = await this.http.get<{ handshakes: SecureHandshakeModel[]; hasMore: boolean }>(
      `/devices/${encodeURIComponent(deviceId)}/handshakes`,
      { params }
    );
    return data;
  }

  /**
   * Upload (replace) the caller's passphrase-encrypted key backup blob. The server stores it opaquely
   * and cannot decrypt it.
   *
   * @param body - The encrypted blob, nonce, KDF + cipher descriptors, and version.
   * @returns The server's `updatedAt` timestamp for the stored backup.
   */
  async uploadKeyBackup(body: UploadKeyBackupBody): Promise<{ updatedAt: string }> {
    const { data } = await this.http.put<{ success: boolean; updatedAt: string }>(
      "/key-backup",
      body
    );
    return { updatedAt: data.updatedAt };
  }

  /** Returns the caller's passphrase-encrypted backup blob, or null on 404. */
  async getKeyBackup(deviceId?: string): Promise<SecureKeyBackupModel | null> {
    try {
      const { data } = await this.http.get<SecureKeyBackupModel>("/key-backup", {
        params: deviceId ? { deviceId } : undefined,
      });
      return data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  // ── IUC restore-blobs (ENVELOPE) ─────────────────────────────────────────────

  /**
   * Upload a sealed history blob addressed to a target device (device A). The blob is opaque
   * XChaCha20-Poly1305 ciphertext; the key `K` is NEVER sent here (it crosses MLS only).
   *
   * @param body - `{ conversationId, fromDeviceId, targetDeviceId, blob }` — `blob` is base64.
   * @returns `{ blobId, expiresAt }`.
   * @throws {SecureRestoreError} On `413 secure-chat/restore-blob-too-large` (chunk down),
   *   `429 common/rate-limited` (back off), or another typed server error.
   */
  async uploadRestoreBlob(body: UploadRestoreBlobBody): Promise<UploadRestoreBlobResponse> {
    try {
      const { data } = await this.http.post<UploadRestoreBlobResponse>("/restore-blobs", body);
      return data;
    } catch (err) {
      const e = restoreErr(err);
      if (e) throw new SecureRestoreError(e.code, e.status);
      throw err;
    }
  }

  /**
   * Fetch a sealed blob by id (device B). **Non-destructive.** Returns `null` on `404` — the server
   * returns the same 404 for missing, expired, and not-the-owner (closed existence oracle), so the
   * caller treats `null` as "nothing for me" and never branches on the reason.
   *
   * @param blobId - The blob id (learned from the MLS `restore-envelope` message).
   * @returns The blob row, or `null`.
   */
  async getRestoreBlob(blobId: string): Promise<RestoreBlobModel | null> {
    try {
      const { data } = await this.http.get<RestoreBlobModel>(
        `/restore-blobs/${encodeURIComponent(blobId)}`
      );
      return data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  /**
   * Delete a blob after the history is durably persisted (device B). Idempotent: a `404` resolves
   * (already gone / not ours), so a retry after a partial failure is safe.
   *
   * @param blobId - The blob id to remove.
   */
  async deleteRestoreBlob(blobId: string): Promise<void> {
    try {
      await this.http.delete(`/restore-blobs/${encodeURIComponent(blobId)}`);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return;
      throw err;
    }
  }
}

/**
 * Condense a response body into a greppable one-liner for the `debug`-level line — array lengths and
 * paging flags instead of the full (often base64-heavy) payload, which is left to the `trace` line.
 *
 * @param data - The axios response body.
 * @returns A small summary object (counts + `hasMore`), or the value itself when it isn't an object.
 */
function summarizeBody(data: unknown): unknown {
  if (data == null || typeof data !== "object") return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    out[k] = Array.isArray(v) ? `[${v.length}]` : v;
  }
  return out;
}
