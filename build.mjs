// Bundle the app into dist/: one script, one stylesheet, one page.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
cpSync('src/index.html', 'dist/index.html');
cpSync('src/app.css', 'dist/app.css');
await build({
  entryPoints: ['src/app.js'],
  outfile: 'dist/app.js',
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  logLevel: 'warning',
});
console.log('app built');
