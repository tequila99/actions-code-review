import { build } from 'esbuild'

await build({
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  minify: false,
  sourcemap: false,
  legalComments: 'none'
})
