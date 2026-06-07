// Minimal stub of @agora-sdk/core for use in Vitest.
//
// The real @agora-sdk/core ESM build uses extensionless relative imports that
// Node's strict ESM resolver cannot find. Rather than patching a published
// package, we expose only the subset of the public API that `secure-chat-core`
// imports. The placeholder return values are safe because URL resolution is
// LAZY: `getApiBaseUrl` / `getSocketUrl` are only invoked inside the axios
// request interceptor and socket.io `connect()`, neither of which runs in these
// unit tests (no request is made and no socket is opened).
export function getApiBaseUrl(): string {
  return "http://localhost";
}
export function getSocketUrl(): string {
  return "http://localhost";
}
