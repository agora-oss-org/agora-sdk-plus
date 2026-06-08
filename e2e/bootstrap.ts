// Bootstrap for the transport-level secure-chat e2e — seed fixtures + mint tokens + teardown.
//
// This drives the foundation-validation e2e (see e2e/secure-chat.e2e.ts): the SDK's REAL transport
// clients talking to a LOCALLY RUNNING agora-server. Two things have to be true for that to work:
//
//   1. The users the SDK authenticates as must EXIST in the same Postgres the server reads, and
//   2. the bearer tokens must verify under the SAME `ACCESS_TOKEN_SECRET` the server's auth
//      middleware uses.
//
// So we seed directly into the server's database (mirroring agora-server's own integration
// `helpers.ts` — `INSERT INTO projects`/`profiles`, `SignJWT` HS256 over the secret) rather than
// going through any signup API. project_id is the isolation boundary: one throwaway project per run,
// dropped on teardown (FK cascade wipes its profiles/devices/conversations/messages). Nothing here
// is shipped SDK code — it's test infrastructure, kept out of the unit glob and tsconfig include.

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { SignJWT } from "jose";

/** Resolved e2e environment. `databaseUrl` doubling as the run gate (see {@link readE2EEnv}). */
export interface E2EEnv {
  /** REST base URL incl. the `/v7` version prefix. */
  baseUrl: string;
  /** Socket.io origin (no namespace; the client appends `/secure`). */
  socketUrl: string;
  /** Postgres URL of the database the running server reads — we seed straight into it. */
  databaseUrl: string;
  /** The server's `ACCESS_TOKEN_SECRET`; our minted tokens must verify under it. */
  accessTokenSecret: string;
}

/**
 * Read the e2e environment, or `null` when the run gate (`AGORA_E2E_TEST_DATABASE_URL`) is unset.
 *
 * The whole suite is skipped when this returns `null`, so the default `pnpm test` (and CI) never
 * needs a server or a database.
 *
 * @returns The resolved {@link E2EEnv}, or `null` to skip the suite.
 * @throws {Error} When the DB gate is set but `AGORA_E2E_ACCESS_TOKEN_SECRET` is missing — a
 *   half-configured run would fail confusingly deep in an auth check, so fail fast here instead.
 */
export function readE2EEnv(): E2EEnv | null {
  const databaseUrl = process.env.AGORA_E2E_TEST_DATABASE_URL;
  if (!databaseUrl) return null;
  const accessTokenSecret = process.env.AGORA_E2E_ACCESS_TOKEN_SECRET;
  if (!accessTokenSecret) {
    throw new Error(
      "AGORA_E2E_TEST_DATABASE_URL is set but AGORA_E2E_ACCESS_TOKEN_SECRET is not — " +
        "tokens would not verify against the running server. Set both (match the server's .env)."
    );
  }
  return {
    databaseUrl,
    accessTokenSecret,
    baseUrl: process.env.AGORA_E2E_BASE_URL ?? "http://localhost:4000/v7",
    socketUrl: process.env.AGORA_E2E_SOCKET_URL ?? "http://localhost:4000",
  };
}

/** A seeded user: their profile id (the JWT `sub` / `userId`) and a ready bearer token. */
export interface SeededUser {
  /** The profile row id — used as `userId` everywhere in the secure-chat API. */
  id: string;
  /** A bearer token signed with the server's secret, valid for this run. */
  token: string;
}

/** A seeded scenario plus the teardown that wipes it. */
export interface Seeded {
  /** The throwaway project id scoping every request this run. */
  projectId: string;
  /** The conversation initiator. */
  alice: SeededUser;
  /** The recipient. */
  bob: SeededUser;
  /** Drop the project (FK cascade wipes profiles/devices/conversations/messages) + close the pool. */
  teardown: () => Promise<void>;
}

/**
 * Mint an Agora access token the server's auth middleware accepts.
 *
 * Byte-for-byte the same shape as agora-server's `signToken`: HS256 over `ACCESS_TOKEN_SECRET`, the
 * profile id in `sub`, and the `{ role, operator, steward }` claims the middleware reads back.
 *
 * @param secret - The HMAC secret as bytes (the server's `ACCESS_TOKEN_SECRET`).
 * @param userId - The profile id to stamp as the token subject.
 * @returns A signed JWT valid for one hour.
 */
async function signToken(secret: Uint8Array, userId: string): Promise<string> {
  return new SignJWT({ role: "visitor", operator: false, steward: false })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setExpirationTime("1h")
    .sign(secret);
}

/**
 * Seed one project and two users (alice + bob) directly into the server's database, and mint a token
 * for each.
 *
 * Direct inserts (not a signup endpoint) keep the e2e focused on the secure-chat transport while
 * still producing rows the running server will read. Column names mirror agora-server's Drizzle
 * schema (`projects.client_id`, `profiles.project_id/role/username`); usernames carry a random
 * suffix because they're unique per project.
 *
 * @param env - The resolved {@link E2EEnv}.
 * @returns The seeded {@link Seeded} scenario, including `teardown`.
 */
export async function seedScenario(env: E2EEnv): Promise<Seeded> {
  const pool = new Pool({ connectionString: env.databaseUrl });
  const secret = new TextEncoder().encode(env.accessTokenSecret);

  const { rows: projectRows } = await pool.query<{ id: string }>(
    "INSERT INTO projects (client_id, name) VALUES ($1, $2) RETURNING id",
    [`e2e-${randomUUID()}`, "secure-chat-e2e"]
  );
  const projectId = projectRows[0]!.id;

  const seedUser = async (): Promise<SeededUser> => {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO profiles (project_id, role, username) VALUES ($1, $2, $3) RETURNING id",
      [projectId, "visitor", `u_${randomUUID().slice(0, 8)}`]
    );
    const id = rows[0]!.id;
    return { id, token: await signToken(secret, id) };
  };

  const alice = await seedUser();
  const bob = await seedUser();

  const teardown = async (): Promise<void> => {
    try {
      await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
    } finally {
      await pool.end();
    }
  };

  return { projectId, alice, bob, teardown };
}
