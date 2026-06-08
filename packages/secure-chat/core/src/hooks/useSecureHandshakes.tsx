// useSecureHandshakes — drain and process this device's MLS handshake inbox (the recipient side).
//
// The blind DS delivers each device a stream of handshakes (Welcomes targeted at it, plus broadcast
// Commits/Proposals for its groups), ordered by a monotonic `seq`. This hook is what makes a
// RECIPIENT actually join and stay current: on connect it pulls `GET .../handshakes?since=<cursor>`
// to the end, then processes live `secure:welcome` / `secure:handshake` events — all funneled through
// ONE serialized, seq-ordered, idempotent path, persisting the cursor as it goes. A processed Welcome
// joins a group (rememberGroup); a processed Commit advances its epoch. Mount it once, near
// useSecureDevice.
//
// Ordering invariant: live events that arrive WHILE catching up are buffered and replayed in `seq`
// order AFTER catch-up — otherwise a high-seq live event would advance the cursor past not-yet-fetched
// rows and the dedupe check would drop them (data loss).

import { useCallback, useEffect, useRef, useState } from "react";
import { SecureHandshakeModel } from "../contract/index.js";
import { fromBase64 } from "../util/base64.js";
import { useSecureChat } from "../context/secure-chat-context.js";

/** Compare two decimal-string `seq` cursors numerically (string compare is wrong across digit widths). */
function compareSeq(a: string, b: string): number {
  const d = BigInt(a) - BigInt(b);
  return d > 0n ? 1 : d < 0n ? -1 : 0;
}

/** Options for {@link useSecureHandshakes}. */
export interface UseSecureHandshakesOptions {
  /**
   * The device row id whose inbox to drain. Defaults to the persisted device's `.id`. Pass the id
   * from `useSecureDevice` so processing starts the moment the device registers (a persisted device
   * is picked up automatically on reload even without this).
   */
  deviceId?: string;
  /** Disable processing (e.g. before sign-in). Default true. */
  enabled?: boolean;
  /** Page size for the catch-up fetch loop. Default 100. */
  pageSize?: number;
  /** Called per handshake-processing error; the inbox skips the bad row and continues. */
  onError?: (err: unknown, handshake?: SecureHandshakeModel) => void;
}

/** The state and actions returned by {@link useSecureHandshakes}. */
export interface UseSecureHandshakesValues {
  /** True until the initial catch-up loop settles. */
  catchingUp: boolean;
  /** True once catch-up completed and live subscriptions are active. */
  ready: boolean;
  /** The last processed delivery cursor (`seq`), or `null`. */
  cursor: string | null;
  /** Count of handshakes applied this session. */
  processedCount: number;
  /** The last error surfaced (also delivered via `onError`), or `null`. */
  error: unknown;
  /**
   * Re-run the catch-up loop from the persisted cursor. The reusable primitive a future 409
   * epoch-conflict rebase (on a membership Commit) calls before rebuilding + retrying its Commit.
   */
  resync: () => Promise<void>;
}

/**
 * Process this device's MLS handshake inbox so the recipient side of secure chat works.
 *
 * On mount (once a device id is available) it catches up via `fetchHandshakes(since=cursor)`, re-joins
 * the socket rooms for groups it already holds, then processes live `secure:welcome` /
 * `secure:handshake` events — all serialized in `seq` order, deduped, and cursor-persisted. Mount it
 * exactly once near `useSecureDevice`.
 *
 * @param options - {@link UseSecureHandshakesOptions}.
 * @returns {@link UseSecureHandshakesValues}.
 *
 * @remarks
 * Single-device only (Phase 3 adds own-device fan-out + MLS generation-counter gap detection). A
 * Commit for a group whose Welcome hasn't been seen is skipped — `seq` ordering puts the Welcome
 * first, so an unknown group means this device is genuinely not a member.
 *
 * Mount it exactly once. Processing is serialized *within* a mount, and the cursor is re-read from
 * storage at the start of each run, so a serialized re-mount (or `deviceId` change) resumes without
 * reprocessing. It does NOT serialize across a *concurrent* re-mount whose prior catch-up is still
 * in flight; that case relies on `processWelcome` / `processCommit` being idempotent for a replayed
 * blob. The mock is idempotent (so dev StrictMode double-invoke is harmless); harden this when the
 * real MLS core lands (Task 1) if its handshake processing is not replay-safe.
 *
 * @example
 * ```tsx
 * const { device } = useSecureDevice();
 * useSecureHandshakes({ deviceId: device?.id });
 * ```
 */
export function useSecureHandshakes(
  options: UseSecureHandshakesOptions = {}
): UseSecureHandshakesValues {
  const { rest, crypto, socket, repo, resolveGroup, rememberGroup } = useSecureChat();
  const { deviceId: deviceIdOption, pageSize = 100 } = options;
  const enabled = options.enabled ?? true;

  const [catchingUp, setCatchingUp] = useState(true);
  const [ready, setReady] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [processedCount, setProcessedCount] = useState(0);
  const [error, setError] = useState<unknown>(null);

  // onError read through a ref so passing an inline callback doesn't re-run the effect.
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;

  // The catch-up routine, published from the effect so `resync()` (stable) can invoke it.
  const runCatchUpRef = useRef<(() => Promise<void>) | null>(null);

  const resync = useCallback(async (): Promise<void> => {
    await runCatchUpRef.current?.();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const offFns: Array<() => void> = [];

    // Async state shared across the catch-up loop, live handlers, and the serial apply queue.
    const cursorRef = { current: null as string | null };
    const catchingUpRef = { current: true };
    const liveBuffer: SecureHandshakeModel[] = [];
    let queue: Promise<void> = Promise.resolve();
    let deviceId: string | undefined;

    const report = (err: unknown, h?: SecureHandshakeModel) => {
      if (alive) setError(err);
      onErrorRef.current?.(err, h);
    };

    const dispatchByKind = async (h: SecureHandshakeModel): Promise<void> => {
      const payload = fromBase64(h.payload);
      if (h.kind === "welcome") {
        // Targeted at us → join the group, then join its room for future broadcast Commits.
        if (h.targetDeviceId && h.targetDeviceId !== deviceId) return;
        const handle = await crypto.processWelcome(payload);
        await rememberGroup(h.conversationId, handle);
        socket.joinConversation(h.conversationId);
      } else if (h.kind === "commit") {
        const group = await resolveGroup(h.conversationId);
        if (!group) {
          // Unknown group at a Commit: with seq ordering the Welcome precedes it, so we're not a
          // member of this conversation. Skip (the cursor still advances so we don't re-fetch it).
          report(new Error(`secure-chat: commit for unknown group ${h.conversationId}`), h);
          return;
        }
        const advanced = await crypto.processCommit(group, payload);
        await rememberGroup(h.conversationId, advanced);
      } else if (h.kind === "proposal") {
        const group = await resolveGroup(h.conversationId);
        if (group) await crypto.processProposal(group, payload);
      }
    };

    // The ONE place that mutates the cursor + crypto state. Dedupes by seq; advances the cursor even
    // when a row is skipped or its dispatch throws, so a poison blob can never wedge the inbox. A hard
    // crash mid-dispatch leaves the cursor unsaved, so the row replays on restart (no loss).
    const applyOrdered = async (h: SecureHandshakeModel): Promise<void> => {
      if (cursorRef.current !== null && compareSeq(h.seq, cursorRef.current) <= 0) return;
      try {
        await dispatchByKind(h);
      } catch (err) {
        report(err, h);
      }
      cursorRef.current = h.seq;
      await repo.saveHandshakeCursor(h.seq);
      if (alive) {
        setCursor(h.seq);
        setProcessedCount((n) => n + 1);
      }
    };

    const schedule = (h: SecureHandshakeModel): Promise<void> => {
      queue = queue.then(() => applyOrdered(h));
      return queue;
    };

    const enqueueLive = (h: SecureHandshakeModel) => {
      // Buffer while catching up so a high-seq live event can't advance the cursor past rows the
      // catch-up loop hasn't fetched yet (which the dedupe check would then drop).
      if (catchingUpRef.current) liveBuffer.push(h);
      else schedule(h);
    };

    // Coalesce overlapping invocations: a `resync()` fired while a catch-up is still draining returns
    // the in-flight promise instead of starting a second drain (two drains would race the
    // `catchingUpRef` gate + `liveBuffer` and could break seq ordering).
    let catchUpInFlight: Promise<void> | null = null;
    const runCatchUp = (): Promise<void> => {
      if (catchUpInFlight) return catchUpInFlight;
      catchUpInFlight = (async () => {
        catchingUpRef.current = true;
        try {
          for (;;) {
            const page = await rest.fetchHandshakes(deviceId!, {
              since: cursorRef.current ?? undefined,
              limit: pageSize,
            });
            for (const h of page.handshakes) await schedule(h);
            if (!page.hasMore) break;
          }
        } finally {
          catchingUpRef.current = false;
          // Replay anything that landed live during catch-up, in seq order, through the same queue.
          const buffered = liveBuffer.splice(0).sort((a, b) => compareSeq(a.seq, b.seq));
          for (const h of buffered) schedule(h);
        }
      })().finally(() => {
        catchUpInFlight = null;
      });
      return catchUpInFlight;
    };

    (async () => {
      // Resolve the device row id (option wins; else the persisted device). Without one, there is no
      // inbox to drain yet — the effect re-runs when `deviceId` is later supplied.
      deviceId = deviceIdOption ?? (await repo.loadDevice())?.device?.id;
      if (!alive || !deviceId) return;

      cursorRef.current = await repo.loadHandshakeCursor();
      if (alive) setCursor(cursorRef.current);

      // Subscribe to live events BEFORE catch-up (buffered until catch-up completes).
      offFns.push(socket.on("secure:welcome", enqueueLive));
      offFns.push(socket.on("secure:handshake", enqueueLive));

      runCatchUpRef.current = runCatchUp;
      await runCatchUp();

      // After a reload we hold group state but haven't joined the socket rooms, so broadcast Commits
      // wouldn't arrive — re-join every known conversation.
      try {
        const convIds = await repo.listGroupConversationIds();
        for (const c of convIds) socket.joinConversation(c);
      } catch (err) {
        report(err);
      }

      if (alive) {
        setCatchingUp(false);
        setReady(true);
      }
    })().catch((err) => report(err));

    return () => {
      alive = false;
      offFns.forEach((off) => off());
      runCatchUpRef.current = null;
    };
  }, [enabled, deviceIdOption, pageSize, rest, socket, repo, crypto, resolveGroup, rememberGroup]);

  return { catchingUp, ready, cursor, processedCount, error, resync };
}
