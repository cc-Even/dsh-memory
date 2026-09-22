import { defineConfig } from 'tsdown'

/** Host ESM entries and the native Harness browser ModuleLoader factory. */
export default defineConfig([{
  entry: ['lib/types/index.js', 'lib/types/tool.js', 'lib/types/invariant.js', 'lib/types/management.js'],
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
}, {
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib', format: 'cjs', platform: 'browser', target: 'es2024',
  dts: false, clean: false,
  deps: { neverBundle: ['react', 'react/jsx-runtime'], alwaysBundle: [] },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@evyn/dsh-memory", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}])
