// Bundles the CLI, MCP server and web app into dist/ (ADR-001). No native modules: node:sqlite is built in.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/web', { recursive: true });
const banner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" };
const node = { bundle: true, platform: 'node', format: 'esm', target: 'node22', banner, legalComments: 'none', logLevel: 'warning' };
await build({ ...node, entryPoints: ['cli/src/main.ts'], outfile: 'dist/orgworld.mjs' });
await build({ ...node, entryPoints: ['integrations/mcp/src/main.ts'], outfile: 'dist/orgworld-mcp.mjs' });
await build({ entryPoints: ['apps/web/src/main.ts'], outfile: 'dist/web/main.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, logLevel: 'warning' });
copyFileSync('apps/web/src/index.html', 'dist/web/index.html');
copyFileSync('apps/web/src/styles.css', 'dist/web/styles.css');
console.log('built dist/orgworld.mjs, dist/orgworld-mcp.mjs, dist/web/');
