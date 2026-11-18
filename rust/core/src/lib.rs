//! The simulation core (docs/27). A placeholder until the math port (#1173): it proves the
//! workspace builds natively for tests and to `wasm32-unknown-unknown` for Node and the browser.
//!
//! The WASM module uses plain exports, not wasm-bindgen: the adapter passes flat typed buffers in
//! WASM memory (docs/27, rule 1), so there is no generated JavaScript glue to keep in step.

/// The version of the contract between this module and its JavaScript adapter. A loader checks it
/// before calling anything else, and it changes whenever an export's meaning or layout does.
pub const ADAPTER_VERSION: u32 = 1;

/// Exported to JavaScript as `adapter_version`.
#[unsafe(no_mangle)]
pub extern "C" fn adapter_version() -> u32 {
    ADAPTER_VERSION
}

#[cfg(test)]
mod tests {
    #[test]
    fn exports_the_adapter_version() {
        assert_eq!(super::adapter_version(), super::ADAPTER_VERSION);
    }
}
