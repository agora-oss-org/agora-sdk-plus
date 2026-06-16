// @agora-sdk/social-expo — Expo bindings for the Agora social graph.
//
// The social visual components have ZERO platform difference between bare RN and Expo — they render on
// the same React Native primitives + react-native-svg, both of which resolve identically under Expo
// (unlike secure-chat, whose RN/Expo split is real: Keychain vs SecureStore native crypto). So this
// package is a thin re-export of @agora-sdk/social-react-native, which transitively re-exports the core
// provider, hooks, transport, and wire types. One source of truth, no drift.

export * from "@agora-sdk/social-react-native";
