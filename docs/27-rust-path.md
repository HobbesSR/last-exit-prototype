# 27. Rust path

If the prototype validates the game, move geometry and simulation into an engine-independent Rust crate with serializable state, fixed-tick input, and explicit randomness. Compile the same crate natively for the authoritative server and to WebAssembly for browser prediction. Keep the renderer and transport outside the crate. This avoids maintaining separate Rust and JavaScript gameplay implementations.

Rapier is a candidate if physics expands beyond kinematic collision. Its Rust and WASM ecosystem supports deterministic configurations, but determinism would still need tests covering game code, randomness, iteration order, and version changes. [Rapier determinism](https://rapier.rs/docs/user_guides/javascript/determinism/).
