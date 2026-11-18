/**
 * The one loader for the Rust core (`rust/core`, docs/27), shared by Node and the browser. The
 * host supplies the module's bytes: Node reads `shared/core.wasm`, the browser fetches it. Both
 * instantiate once at startup, before anything that uses the core, because a browser cannot
 * import an asynchronously instantiated module synchronously.
 *
 * `shared/core.wasm` is committed, built by `npm run core:build`; CI rebuilds it and fails if
 * the bytes differ (docs/27, "The workspace").
 */

/** The adapter contract this loader speaks: `ADAPTER_VERSION` in `rust/core/src/lib.rs`. */
export const CORE_ADAPTER_VERSION = 2;

// The project's lib is ES2023 without the DOM, which is where TypeScript declares WebAssembly.
// Both hosts have it; this names only what the loader uses.
declare const WebAssembly: {
  instantiate(bytes: ArrayBuffer | ArrayBufferView, imports: object): Promise<{ instance: { exports: object } }>;
};

export interface CoreExports {
  readonly memory: { readonly buffer: ArrayBuffer };
  adapter_version(): number;
  /** The crate's port of shared/math.ts, exported for the parity check only (docs/27). */
  math_sin(x: number): number;
  math_cos(x: number): number;
  math_atan(x: number): number;
  math_atan2(y: number, x: number): number;
  math_hypot(x: number, y: number): number;
}

/** Instantiates the core and checks its adapter version before anything else is called. */
export async function loadCore(bytes: ArrayBuffer | ArrayBufferView): Promise<CoreExports> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const core = instance.exports as unknown as CoreExports;
  const version = core.adapter_version();
  if (version !== CORE_ADAPTER_VERSION)
    throw new Error(`core.wasm speaks adapter version ${version}, this loader ${CORE_ADAPTER_VERSION}; run npm run core:build`);
  return core;
}
