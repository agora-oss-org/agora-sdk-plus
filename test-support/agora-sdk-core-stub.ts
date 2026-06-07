// Minimal stub of @agora-sdk/core for use in Vitest.
//
// The real @agora-sdk/core ESM build uses extensionless relative imports that
// Node's strict ESM resolver cannot find. Rather than patching a published
// package, we expose only the subset of the public API that `secure-chat-core`
// imports, with no-op implementations suitable for tests (providers under test
// always override baseUrl / socketUrl via props so these are never called).
export function getApiBaseUrl(): string {
  return "http://localhost";
}
export function getSocketUrl(): string {
  return "http://localhost";
}
