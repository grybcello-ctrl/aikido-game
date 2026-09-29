// 단일 HTML 프로토타입 빌드: src/prototype/main.ts → prototype/aikido-prototype.html
// Phaser 는 CDN(전역), 엔진·데이터·씬은 인라인 스크립트로 번들.
// 사용: npm run build:prototype
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const phaserVersion = pkg.dependencies.phaser;

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/prototype/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  charset: 'utf8',
  legalComments: 'none',
  write: false,
  alias: { phaser: './scripts/phaser-global.js' },
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Aikido Timing Prototype — ${pkg.name} ${pkg.version}</title>
<!-- 자동 생성 파일: npm run build:prototype (직접 수정하지 말 것) -->
<style>
  html, body { margin: 0; height: 100%; background: #0a0a0a; overflow: hidden; }
  #game { width: 100vw; height: 100vh; }
  canvas { image-rendering: pixelated; }
</style>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nanum+Gothic+Coding:wght@400;700&display=swap" />
<script src="https://cdn.jsdelivr.net/npm/phaser@${phaserVersion}/dist/phaser.min.js"></script>
</head>
<body>
<div id="game"></div>
<script>
${js}
</script>
</body>
</html>
`;

const out = join(root, 'prototype', 'aikido-prototype.html');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`✓ ${out} (${(html.length / 1024).toFixed(1)} KB, phaser@${phaserVersion} via CDN)`);
