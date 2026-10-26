// scripts/sync-codec.mjs — 격자 코덱을 entry-os 에서 다시 복사한다
//
//   npm run sync-codec [-- <entry-os 경로>]
//
// src/lib/snapcodec.mjs 는 entry-os/tools/snapcodec.mjs 와 **글자 하나까지 같아야** 한다.
// 엔트리가 그리는 격자와 이 앱이 읽는 격자가 한 정의에서 나와야 조용히 어긋나지 않는다.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const osRoot = resolve(process.argv[2] || resolve(ROOT, '..', 'entry-os'));
const from = resolve(osRoot, 'tools', 'snapcodec.mjs');
const to = resolve(ROOT, 'src', 'lib', 'snapcodec.mjs');

if (!existsSync(from)) {
    console.error(`찾을 수 없습니다: ${from}\n  npm run sync-codec -- <entry-os 경로>`);
    process.exit(1);
}
const src = readFileSync(from, 'utf8');
const old = existsSync(to) ? readFileSync(to, 'utf8') : '';
if (src === old) {
    console.log('이미 같습니다');
} else {
    writeFileSync(to, src);
    console.log(`복사했습니다: ${from} → ${to}`);
}
