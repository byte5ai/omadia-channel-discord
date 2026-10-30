// esbuild inlines these via the `binary` loader (see scripts/build-spike.mjs).
declare module '*.woff' {
  const data: Uint8Array;
  export default data;
}

declare module '*.wasm' {
  const data: Uint8Array;
  export default data;
}
