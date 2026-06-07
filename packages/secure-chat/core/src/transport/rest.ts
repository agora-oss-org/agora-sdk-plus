// Typed REST client for the secure-chat blind Delivery Service.
//
// Covers every endpoint in agora-server `docs/SECURE_CHAT.md` §9. Base URL and access token are
// resolved **lazily per request** (matching the @agora-sdk/core base-URL runtime), so a token
// refresh or a late-set baseUrl always wins. All binary is base64 on the wire; this client never
// inspects payloads.

import axios, { AxiosInstance } from "axios";
import {
  AddSecureMemberBody,
  CreateSecureConversationBody,
  PublishKeyPackagesBody,
  RegisterDeviceBody,
  RemoveSecureMemberBody,
  SecureConversationMemberModel,
  SecureConversationModel,
  SecureDeviceModel,
  SecureHandshakeModel,
  SecureKeyBackupModel,
  SecureKeyPackageClaim,
  SecureMessageModel,
  SendSecureMessageBody,
  UploadKeyBackupBody,
} from "../contract/index.js";

/**
 * Configuration for {@link SecureChatRestClient}. The base URL and access token are read through
 * resolver callbacks rather than captured once, so a late-set `baseUrl` or a refreshed token take
 * effect on the next request without rebuilding the client.
 */
export interface SecureChatRestConfig {
  /** Resolve the API base URL (e.g. `getApiBaseUrl()` from @agora-sdk/core → `http://host/v7`). */
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
 *   getBaseUrl: () => getApiBaseUrl(),
 *   getAccessToken: () => session.accessToken,
 * });
 * const device = await rest.registerDevice(body);
 * ```
 */
export class SecureChatRestClient {
  private readonly http: AxiosInstance;

  constructor(private readonly config: SecureChatRestConfig) {
    this.http = axios.create();
    this.http.interceptors.request.use((req) => {
      const base = config.getBaseUrl().replace(/\/$/, "");
      req.baseURL = `${base}/${config.projectId}/secure-chat`;
      const token = config.getAccessToken();
      if (token) req.headers.set("Authorization", `Bearer ${token}`);
      return req;
    });
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
}
