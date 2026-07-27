/**
 * Nest/TS compile to CommonJS and rewrite `import()` → `require()`.
 * ESM-only packages (pi-agent-core, pi-ai) only expose `exports.import`,
 * so require fails with: No "exports" main defined.
 *
 * This helper forces a real ESM dynamic import at runtime.
 */
export function importEsm<T = unknown>(specifier: string): Promise<T> {
  // new Function prevents TypeScript from downleveling to require()
  const importer = new Function(
    'specifier',
    'return import(specifier)',
  ) as (s: string) => Promise<T>;
  return importer(specifier);
}
