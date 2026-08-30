// Ambient (no imports in this file, deliberately — a wildcard module
// declaration is only ambient in a non-module file).
// Vite raw imports: the worker sandbox has no filesystem, so fixture SQL is
// inlined at bundle time.
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
