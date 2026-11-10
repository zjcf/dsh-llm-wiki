import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';

const bundle = await build({
  entryPoints: ['src/client.tsx'], bundle: true, format: 'cjs', platform: 'browser',
  jsx: 'transform', target: 'es2022', external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
  loader: { '.css': 'text' }, write: false, legalComments: 'none',
});
await writeFile('dist/client.js',
  'window.__ModuleLoader__.load({ id: "dsh-llm-wiki", factory: (require) => {\n' +
  'const module = { exports: {} };\n' + bundle.outputFiles[0].text + '\nreturn module.exports;\n} });\n',
);
await build({
  entryPoints: ['src/word-preview.ts'], bundle: true, format: 'iife', platform: 'browser',
  target: 'es2022', outfile: 'dist/word-preview.browser.js', minify: true, legalComments: 'eof',
});
