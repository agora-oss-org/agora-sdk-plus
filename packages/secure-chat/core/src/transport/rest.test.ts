// Unit tests for SecureChatRestClient — the wire boundary to the blind Delivery Service.
//
// Every endpoint is covered: the method + path (incl. encodeURIComponent on ids), the query params /
// request body the client emits, and how it unwraps each response shape. The cross-cutting interceptor
// behaviour (lazy baseUrl composition, lazy Bearer token) and the two error contracts that callers
// depend on (getKeyBackup → null on 404; claim / removeMember propagate 409) are asserted too.
//
// We don't mock the client's own http methods — that would test a stub. Instead we spy on
// `axios.create` and install a custom ADAPTER, so the real request/response interceptors run and we
// capture the fully-resolved request config (after baseUrl + auth are applied) and return canned
// responses. axios's default validateStatus turns a non-2xx canned status into a real AxiosError, so
// the 404/409 paths exercise the genuine error handling.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios, { type InternalAxiosRequestConfig } from "axios";
import { SecureChatRestClient, SecureRestoreError } from "./rest.js";
import type {
  SecureConversationMemberModel,
  SecureConversationModel,
  SecureDeviceModel,
  SecureHandshakeModel,
  SecureKeyBackupModel,
  SecureKeyPackageClaim,
  SecureMessageModel,
} from "../contract/index.js";

// Captured before spying so the mock impl can build a real axios instance (with our adapter) from it.
const realCreate = axios.create.bind(axios);

interface Captured {
  method?: string;
  url?: string;
  baseURL?: string;
  params?: unknown;
  data?: unknown;
  authorization?: string | null;
}

let captured: Captured;
let response: { status: number; data: unknown };
let token: string | undefined;

beforeEach(() => {
  captured = {};
  response = { status: 200, data: {} };
  token = "tok-123";
  vi.spyOn(axios, "create").mockImplementation(() =>
    realCreate({
      // The adapter receives the config AFTER the request interceptor applied baseURL + auth, so what
      // we capture here is exactly what the client would put on the wire.
      adapter: async (config: InternalAxiosRequestConfig) => {
        captured = {
          method: config.method,
          url: config.url,
          baseURL: config.baseURL,
          params: config.params,
          data: config.data,
          authorization:
            (config.headers as { get?: (k: string) => unknown })?.get?.("Authorization") as
              | string
              | null
              | undefined ?? null,
        };
        const res = {
          data: response.data,
          status: response.status,
          statusText: "",
          headers: {},
          config,
          request: {},
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        // A custom adapter must enforce validateStatus itself (the stock xhr/http adapters call
        // `settle` internally) — otherwise a non-2xx status resolves and the client's 404/409 error
        // handling never runs. Reject with a real AxiosError so `axios.isAxiosError` + `.response`
        // behave exactly as in production.
        if (response.status >= 200 && response.status < 300) return res;
        throw new axios.AxiosError(
          `Request failed with status code ${response.status}`,
          response.status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST",
          config,
          {},
          res
        );
      },
    })
  );
});

afterEach(() => vi.restoreAllMocks());

function makeClient(): SecureChatRestClient {
  return new SecureChatRestClient({
    projectId: "proj1",
    getBaseUrl: () => "https://api.example.com/v7",
    getAccessToken: () => token,
  });
}

/** axios JSON-stringifies the request body before the adapter sees it; parse it back for assertions. */
function sentBody(): unknown {
  return typeof captured.data === "string" ? JSON.parse(captured.data) : captured.data;
}

// ── fixtures (minimal, type-correct rows the server would return) ──────────────
function deviceModel(over: Partial<SecureDeviceModel> = {}): SecureDeviceModel {
  return {
    id: "dev-row-1",
    projectId: "proj1",
    userId: "user-1",
    deviceId: "device-aaa",
    displayName: null,
    signaturePublicKey: "c2ln",
    credential: "Y3JlZA==",
    ciphersuite: 1,
    revokedAt: null,
    lastSeenAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function conversationModel(over: Partial<SecureConversationModel> = {}): SecureConversationModel {
  return {
    id: "conv-1",
    projectId: "proj1",
    type: "dm",
    mlsGroupId: "Z2lk",
    spaceId: null,
    currentEpoch: "3",
    name: null,
    createdById: "user-1",
    lastMessageAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function memberModel(over: Partial<SecureConversationMemberModel> = {}): SecureConversationMemberModel {
  return {
    id: "mem-1",
    projectId: "proj1",
    conversationId: "conv-1",
    userId: "user-2",
    role: "member",
    isActive: true,
    joinedAtEpoch: "4",
    lastReadAt: null,
    leftAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function messageModel(over: Partial<SecureMessageModel> = {}): SecureMessageModel {
  return {
    id: "msg-1",
    projectId: "proj1",
    conversationId: "conv-1",
    senderUserId: "user-1",
    senderDeviceId: "dev-row-1",
    epoch: "3",
    ciphertext: "Y2lwaGVy",
    contentType: "application/x-mls",
    createdAt: "2026-01-02T00:00:00Z",
    ...over,
  };
}

function handshakeModel(over: Partial<SecureHandshakeModel> = {}): SecureHandshakeModel {
  return {
    id: "hs-1",
    seq: "10",
    kind: "welcome",
    conversationId: "conv-1",
    epoch: "1",
    payload: "d2VsY29tZQ==",
    senderDeviceId: null,
    targetDeviceId: "dev-row-1",
    ...over,
  };
}

function keyBackupModel(over: Partial<SecureKeyBackupModel> = {}): SecureKeyBackupModel {
  return {
    id: "kb-1",
    projectId: "proj1",
    userId: "user-1",
    deviceId: null,
    blob: "YmxvYg==",
    nonce: "bm9uY2U=",
    kdf: "argon2id",
    kdfParams: { m: 65536, t: 3, p: 1 },
    cipher: "xchacha20poly1305",
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-03T00:00:00Z",
    ...over,
  };
}

describe("SecureChatRestClient — request wiring (interceptors)", () => {
  it("composes baseURL as {base}/{projectId}/secure-chat and strips a trailing slash", async () => {
    const client = new SecureChatRestClient({
      projectId: "proj1",
      getBaseUrl: () => "https://api.example.com/v7/", // note the trailing slash
      getAccessToken: () => "tok",
    });
    response.data = deviceModel();
    await client.registerDevice({
      deviceId: "device-aaa",
      signaturePublicKey: "c2ln",
      credential: "Y3JlZA==",
      ciphersuite: 1,
    });
    expect(captured.baseURL).toBe("https://api.example.com/v7/proj1/secure-chat");
  });

  it("sets the Authorization header from the lazily-resolved token", async () => {
    response.data = deviceModel();
    await makeClient().registerDevice({
      deviceId: "device-aaa",
      signaturePublicKey: "c2ln",
      credential: "Y3JlZA==",
      ciphersuite: 1,
    });
    expect(captured.authorization).toBe("Bearer tok-123");
  });

  it("omits the Authorization header when signed out (no token)", async () => {
    token = undefined;
    response.data = { available: 0 };
    await makeClient().keyPackageCount("dev-row-1");
    expect(captured.authorization).toBeNull();
  });

  it("resolves the token per request, so a refresh takes effect without rebuilding", async () => {
    const client = makeClient();
    response.data = { available: 1 };
    await client.keyPackageCount("dev-row-1");
    expect(captured.authorization).toBe("Bearer tok-123");
    token = "tok-refreshed"; // simulate a refresh between calls
    await client.keyPackageCount("dev-row-1");
    expect(captured.authorization).toBe("Bearer tok-refreshed");
  });
});

describe("SecureChatRestClient — devices", () => {
  it("registerDevice POSTs /devices with the body and returns the device row", async () => {
    response.data = deviceModel({ id: "dev-row-9" });
    const body = {
      deviceId: "device-aaa",
      signaturePublicKey: "c2ln",
      credential: "Y3JlZA==",
      ciphersuite: 1,
    };
    const result = await makeClient().registerDevice(body);
    expect(captured.method).toBe("post");
    expect(captured.url).toBe("/devices");
    expect(sentBody()).toEqual(body);
    expect(result).toEqual(deviceModel({ id: "dev-row-9" }));
  });

  it("listDevices GETs /devices?userId and unwraps data.data", async () => {
    response.data = { data: [deviceModel(), deviceModel({ id: "dev-row-2" })] };
    const result = await makeClient().listDevices("user-7");
    expect(captured.method).toBe("get");
    expect(captured.url).toBe("/devices");
    expect(captured.params).toEqual({ userId: "user-7" });
    expect(result).toHaveLength(2);
    expect(result[1].id).toBe("dev-row-2");
  });

  it("revokeDevice DELETEs /devices/{id} with the id percent-encoded", async () => {
    await makeClient().revokeDevice("a/b c");
    expect(captured.method).toBe("delete");
    expect(captured.url).toBe("/devices/a%2Fb%20c");
  });

  it("deviceExists returns true and probes the count endpoint when the server has the device", async () => {
    response = { status: 200, data: { available: 7 } };
    const exists = await makeClient().deviceExists("dev-row-1");
    expect(captured.method).toBe("get");
    expect(captured.url).toBe("/devices/dev-row-1/key-packages/count");
    expect(exists).toBe(true);
  });

  it("deviceExists returns false on a definitive 404 device-not-found (split-brain signal)", async () => {
    response = { status: 404, data: { code: "secure-chat/device-not-found" } };
    const exists = await makeClient().deviceExists("dev-row-gone");
    expect(exists).toBe(false);
  });

  it("deviceExists re-throws a 404 that is NOT device-not-found (don't misread an unrelated 404)", async () => {
    response = { status: 404, data: { code: "secure-chat/something-else" } };
    await expect(makeClient().deviceExists("dev-row-1")).rejects.toMatchObject({
      response: { status: 404 },
    });
  });

  it("deviceExists re-throws a 5xx (transient — must never be mistaken for 'device gone')", async () => {
    response = { status: 503, data: { code: "internal" } };
    await expect(makeClient().deviceExists("dev-row-1")).rejects.toMatchObject({
      response: { status: 503 },
    });
  });
});

describe("SecureChatRestClient — key packages", () => {
  it("publishKeyPackages POSTs the bundle and returns data.published", async () => {
    response.data = { published: 5 };
    const body = {
      keyPackages: [{ keyPackageRef: "cmVm", keyPackage: "a3A=", ciphersuite: 1 }],
    };
    const published = await makeClient().publishKeyPackages("dev-row-1", body);
    expect(captured.method).toBe("post");
    expect(captured.url).toBe("/devices/dev-row-1/key-packages");
    expect(sentBody()).toEqual(body);
    expect(published).toBe(5);
  });

  it("keyPackageCount GETs the count endpoint and returns data.available", async () => {
    response.data = { available: 12 };
    const count = await makeClient().keyPackageCount("dev-row-1");
    expect(captured.method).toBe("get");
    expect(captured.url).toBe("/devices/dev-row-1/key-packages/count");
    expect(count).toBe(12);
  });

  it("claimKeyPackage POSTs the claim endpoint and returns the claim", async () => {
    const claim: SecureKeyPackageClaim = {
      deviceId: "device-bbb",
      keyPackageRef: "cmVm",
      keyPackage: "a3A=",
      ciphersuite: 1,
    };
    response.data = claim;
    const result = await makeClient().claimKeyPackage("dev-row-2");
    expect(captured.method).toBe("post");
    expect(captured.url).toBe("/devices/dev-row-2/key-packages/claim");
    expect(result).toEqual(claim);
  });

  it("claimKeyPackage propagates a 409 (key-packages-exhausted), never swallows it", async () => {
    response = { status: 409, data: { code: "secure-chat/key-packages-exhausted" } };
    await expect(makeClient().claimKeyPackage("dev-row-2")).rejects.toMatchObject({
      response: { status: 409 },
    });
  });
});

describe("SecureChatRestClient — conversations", () => {
  it("createConversation POSTs /conversations and returns the row", async () => {
    response.data = conversationModel();
    const body = {
      type: "dm" as const,
      mlsGroupId: "Z2lk",
      memberUserIds: ["user-2"],
      welcomes: [{ targetDeviceId: "dev-row-2", payload: "dw==", epoch: "1" }],
    };
    const result = await makeClient().createConversation(body);
    expect(captured.method).toBe("post");
    expect(captured.url).toBe("/conversations");
    expect(sentBody()).toEqual(body);
    expect(result.id).toBe("conv-1");
  });

  it("listConversations GETs /conversations with paging params and returns {conversations, hasMore}", async () => {
    response.data = { conversations: [conversationModel()], hasMore: true };
    const result = await makeClient().listConversations({ limit: 20, cursor: "cur-1" });
    expect(captured.method).toBe("get");
    expect(captured.url).toBe("/conversations");
    expect(captured.params).toEqual({ limit: 20, cursor: "cur-1" });
    expect(result.hasMore).toBe(true);
    expect(result.conversations).toHaveLength(1);
  });

  it("listConversations works with no params", async () => {
    response.data = { conversations: [], hasMore: false };
    const result = await makeClient().listConversations();
    expect(captured.params).toBeUndefined();
    expect(result).toEqual({ conversations: [], hasMore: false });
  });

  it("getConversation GETs /conversations/{id} (encoded) and returns the row", async () => {
    response.data = conversationModel({ id: "conv x" });
    const result = await makeClient().getConversation("conv x");
    expect(captured.method).toBe("get");
    expect(captured.url).toBe("/conversations/conv%20x");
    expect(result.id).toBe("conv x");
  });

  it("markRead POSTs the read endpoint", async () => {
    await makeClient().markRead("conv-1");
    expect(captured.method).toBe("post");
    expect(captured.url).toBe("/conversations/conv-1/read");
  });
});

describe("SecureChatRestClient — membership", () => {
  it("addMember POSTs the Commit + Welcomes and returns the membership row", async () => {
    response.data = memberModel();
    const body = {
      userId: "user-2",
      commit: { payload: "Y29tbWl0", epoch: "4" },
      welcomes: [{ targetDeviceId: "dev-row-2", payload: "dw==", epoch: "4" }],
    };
    const result = await makeClient().addMember("conv-1", body);
    expect(captured.method).toBe("post");
    expect(captured.url).toBe("/conversations/conv-1/members");
    expect(sentBody()).toEqual(body);
    expect(result.id).toBe("mem-1");
  });

  it("removeMember DELETEs /members/{userId} with the Commit body and returns the new epoch", async () => {
    response.data = { success: true, epoch: "5" };
    const body = { commit: { payload: "Y29tbWl0", epoch: "5" } };
    const result = await makeClient().removeMember("conv-1", "user 2", body);
    expect(captured.method).toBe("delete");
    expect(captured.url).toBe("/conversations/conv-1/members/user%202");
    expect(sentBody()).toEqual(body); // body rides on the DELETE
    expect(result).toEqual({ epoch: "5" });
  });

  it("removeMember propagates a 409 epoch-conflict for the caller to rebase", async () => {
    response = { status: 409, data: { code: "secure-chat/epoch-conflict" } };
    await expect(
      makeClient().removeMember("conv-1", "user-2", { commit: { payload: "Yw==", epoch: "5" } })
    ).rejects.toMatchObject({ response: { status: 409 } });
  });
});

describe("SecureChatRestClient — messages", () => {
  it("sendMessage POSTs the ciphertext body and returns the stored row", async () => {
    response.data = messageModel();
    const body = { ciphertext: "Y2lwaGVy", epoch: "3", senderDeviceId: "dev-row-1" };
    const result = await makeClient().sendMessage("conv-1", body);
    expect(captured.method).toBe("post");
    expect(captured.url).toBe("/conversations/conv-1/messages");
    expect(sentBody()).toEqual(body);
    expect(result.id).toBe("msg-1");
  });

  it("listMessages GETs with {limit, before} and returns {messages, hasMore}", async () => {
    response.data = { messages: [messageModel(), messageModel({ id: "msg-2" })], hasMore: false };
    const result = await makeClient().listMessages("conv-1", { limit: 40, before: "2026-01-02T00:00:00Z" });
    expect(captured.method).toBe("get");
    expect(captured.url).toBe("/conversations/conv-1/messages");
    expect(captured.params).toEqual({ limit: 40, before: "2026-01-02T00:00:00Z" });
    expect(result.messages).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });
});

describe("SecureChatRestClient — handshakes + key backup", () => {
  it("fetchHandshakes GETs the inbox with {since, limit} and returns {handshakes, hasMore}", async () => {
    response.data = { handshakes: [handshakeModel()], hasMore: true };
    const result = await makeClient().fetchHandshakes("dev-row-1", { since: "9", limit: 100 });
    expect(captured.method).toBe("get");
    expect(captured.url).toBe("/devices/dev-row-1/handshakes");
    expect(captured.params).toEqual({ since: "9", limit: 100 });
    expect(result.hasMore).toBe(true);
    expect(result.handshakes[0].seq).toBe("10");
  });

  it("uploadKeyBackup PUTs the encrypted envelope and returns {updatedAt}", async () => {
    response.data = { success: true, updatedAt: "2026-01-03T00:00:00Z" };
    const body = {
      blob: "YmxvYg==",
      nonce: "bm9uY2U=",
      kdf: "argon2id" as const,
      kdfParams: { m: 65536, t: 3, p: 1 },
      cipher: "xchacha20poly1305" as const,
      version: 1,
    };
    const result = await makeClient().uploadKeyBackup(body);
    expect(captured.method).toBe("put");
    expect(captured.url).toBe("/key-backup");
    expect(sentBody()).toEqual(body);
    expect(result).toEqual({ updatedAt: "2026-01-03T00:00:00Z" });
  });

  it("getKeyBackup GETs /key-backup with {deviceId} and returns the blob", async () => {
    response.data = keyBackupModel();
    const result = await makeClient().getKeyBackup("dev-row-1");
    expect(captured.method).toBe("get");
    expect(captured.url).toBe("/key-backup");
    expect(captured.params).toEqual({ deviceId: "dev-row-1" });
    expect(result?.id).toBe("kb-1");
  });

  it("getKeyBackup sends no params when no deviceId is given", async () => {
    response.data = keyBackupModel();
    await makeClient().getKeyBackup();
    expect(captured.params).toBeUndefined();
  });

  it("getKeyBackup returns null on 404 (no backup exists yet) instead of throwing", async () => {
    response = { status: 404, data: { code: "secure-chat/key-backup-not-found" } };
    const result = await makeClient().getKeyBackup("dev-row-1");
    expect(result).toBeNull();
  });

  it("getKeyBackup re-throws non-404 errors (a 500 is a real failure, not 'absent')", async () => {
    response = { status: 500, data: { code: "internal" } };
    await expect(makeClient().getKeyBackup("dev-row-1")).rejects.toMatchObject({
      response: { status: 500 },
    });
  });
});

describe("SecureChatRestClient — restore-blobs", () => {
  it("uploadRestoreBlob POSTs /restore-blobs with the full body incl. fromDeviceId and returns the response", async () => {
    response = { status: 200, data: { blobId: "blob-1", expiresAt: "2026-07-01T00:00:00Z" } };
    const body = {
      conversationId: "conv-1",
      fromDeviceId: "dev-A",
      targetDeviceId: "dev-B",
      blob: "QUJDREVG",
    };
    const result = await makeClient().uploadRestoreBlob(body);
    expect(captured.method).toBe("post");
    expect(captured.url).toBe("/restore-blobs");
    // K, nonce, descriptor — nothing key-material — must not appear in the body; only ciphertext (blob)
    expect(sentBody()).toEqual(body);
    expect(result).toEqual({ blobId: "blob-1", expiresAt: "2026-07-01T00:00:00Z" });
  });

  it("uploadRestoreBlob maps 413 restore-blob-too-large to a typed SecureRestoreError", async () => {
    response = { status: 413, data: { code: "secure-chat/restore-blob-too-large" } };
    await expect(
      makeClient().uploadRestoreBlob({
        conversationId: "conv-1",
        fromDeviceId: "dev-A",
        targetDeviceId: "dev-B",
        blob: "QUJD",
      })
    ).rejects.toMatchObject({
      name: "SecureRestoreError",
      code: "secure-chat/restore-blob-too-large",
      status: 413,
    });
  });

  it("uploadRestoreBlob maps 429 rate-limited to a SecureRestoreError (instanceof)", async () => {
    response = { status: 429, data: { code: "common/rate-limited" } };
    await expect(
      makeClient().uploadRestoreBlob({
        conversationId: "conv-1",
        fromDeviceId: "dev-A",
        targetDeviceId: "dev-B",
        blob: "QUJD",
      })
    ).rejects.toBeInstanceOf(SecureRestoreError);
  });

  it("getRestoreBlob GETs /restore-blobs/{id} and returns the row on 200", async () => {
    const row = {
      blobId: "blob-1",
      conversationId: "conv-1",
      fromDeviceId: "dev-A",
      targetDeviceId: "dev-B",
      blob: "QUJD",
      createdAt: "2026-06-20T00:00:00Z",
      expiresAt: "2026-07-01T00:00:00Z",
    };
    response = { status: 200, data: row };
    const result = await makeClient().getRestoreBlob("blob-1");
    expect(captured.method).toBe("get");
    expect(captured.url).toBe("/restore-blobs/blob-1");
    expect(result).toEqual(row);
  });

  it("getRestoreBlob returns null on 404 (closed existence oracle — missing/expired/not-owner all look the same)", async () => {
    response = { status: 404, data: { code: "secure-chat/restore-blob-not-found" } };
    const result = await makeClient().getRestoreBlob("blob-gone");
    expect(captured.url).toBe("/restore-blobs/blob-gone");
    expect(result).toBeNull();
  });

  it("getRestoreBlob percent-encodes the blobId in the path", async () => {
    response = { status: 404, data: { code: "secure-chat/restore-blob-not-found" } };
    await makeClient().getRestoreBlob("a b/c");
    expect(captured.url).toBe("/restore-blobs/a%20b%2Fc");
  });

  it("deleteRestoreBlob DELETEs /restore-blobs/{id} and resolves on 204", async () => {
    response = { status: 204, data: {} };
    await expect(makeClient().deleteRestoreBlob("blob-1")).resolves.toBeUndefined();
    expect(captured.method).toBe("delete");
    expect(captured.url).toBe("/restore-blobs/blob-1");
  });

  it("deleteRestoreBlob resolves on 404 (idempotent — already gone is success)", async () => {
    response = { status: 404, data: { code: "secure-chat/restore-blob-not-found" } };
    await expect(makeClient().deleteRestoreBlob("blob-gone")).resolves.toBeUndefined();
  });

  it("deleteRestoreBlob re-throws non-404 errors (a 500 is a real failure)", async () => {
    response = { status: 500, data: { code: "internal" } };
    await expect(makeClient().deleteRestoreBlob("blob-1")).rejects.toMatchObject({
      response: { status: 500 },
    });
  });
});
