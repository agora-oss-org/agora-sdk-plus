// @agora-sdk/social-react-native — bare React Native bindings for the Agora social graph.
//
// Stub (this phase). Re-exports the platform-agnostic core, so the provider, the four feature-gated
// hooks (useSocialWeather / useSocialConstellation / useSocialNeighborhood / useSocialTransparency),
// the transport client, and the wire types all work in a bare RN app today. The native VISUAL
// components — RN Animated + react-native-svg renderings of the Weather / Constellation / Neighborhood
// lenses — land in a later phase; until then, build screens from the core hooks (the data is pure REST,
// no platform crypto involved).

export * from "@agora-sdk/social-core";
