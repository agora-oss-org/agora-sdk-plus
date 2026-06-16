// @agora-sdk/social-expo — Expo bindings for the Agora social graph.
//
// Stub (this phase). Re-exports the platform-agnostic core, so the provider, the four feature-gated
// hooks, the transport client, and the wire types all work in an Expo app today. The Expo-specific
// visual components land in a later phase; until then, build screens from the core hooks (the data is
// pure REST — no platform crypto or native modules involved).

export * from "@agora-sdk/social-core";
