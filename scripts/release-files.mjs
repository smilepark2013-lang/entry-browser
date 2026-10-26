// scripts/release-files.mjs — 릴리스에 올릴 파일을 dist/ 에 모으고 SHA-256 을 적는다
//
//   npm run release     (= build:entry → test:entry → dist → 이 스크립트)
//
// 올리는 것: 설치판 · portable 판 · 엔트리 작품(.ent) · SHA256SUMS.txt
// 받은 사람은 `Get-FileHash <파일> -Algorithm SHA256` 으로 SHA256SUMS.txt 와 견준다.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

copyFileSync(join(ROOT, 'entry/build/entry-browser.ent'), join(DIST, 'entry-browser.ent'));

const FILES = ['EntryBrowserRelay-Setup.exe', 'EntryBrowserRelay-Portable.exe', 'entry-browser.ent'];
const lines = [];
for (const f of FILES) {
    const p = join(DIST, f);
    if (!existsSync(p)) { console.error(`없는 파일: dist/${f}`); process.exit(1); }
    const buf = readFileSync(p);
    const hash = createHash('sha256').update(buf).digest('hex');
    lines.push(`${hash}  ${f}`);
    console.log(`${hash}  ${f}  (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}
writeFileSync(join(DIST, 'SHA256SUMS.txt'), `# Entry Browser Relay ${version}\n${lines.join('\n')}\n`);
console.log('✓ dist/SHA256SUMS.txt');
