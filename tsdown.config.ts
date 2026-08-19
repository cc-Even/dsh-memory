import { defineConfig } from 'tsdown'

/** Build the service, tool, and invariant entry points as independent ESM bundles. */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/tool.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
