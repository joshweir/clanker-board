// Pure node, no per-package overrides needed - the shared base (test glob,
// node env, e2e exclusion) already fits this package exactly (mirrors
// apps/api's setup, minus its coverage gate, which nothing here mandates).
export { default } from '../../vitest.config';
