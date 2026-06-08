// The crypto implementations the e2e runs against. The same transport round-trip is proven twice:
// with the deterministic mock (fast smoke) and with the real ts-mls core (the real proof — genuine
// MLS blobs relayed by the blind server, recipient joining from the Welcome alone).
import type { SecureChatCrypto } from "../packages/secure-chat/core/src/index.js";
import { MockSecureChatCrypto } from "../packages/secure-chat/crypto/src/testing.js";
import { createTsMlsSecureChatCrypto } from "../packages/secure-chat/crypto/src/ts-mls/index.js";

/** A named crypto factory: a label for the test name + a constructor for a fresh per-device instance. */
export interface CryptoVariant {
  /** Display label, used in the describe-block title. */
  name: string;
  /** Construct a fresh `SecureChatCrypto` for one simulated device. */
  make: () => SecureChatCrypto;
}

/** The crypto cores the e2e exercises: the deterministic mock, then the real ts-mls core. */
export const CRYPTO_VARIANTS: CryptoVariant[] = [
  { name: "MockSecureChatCrypto", make: () => new MockSecureChatCrypto() },
  { name: "ts-mls", make: () => createTsMlsSecureChatCrypto() },
];
