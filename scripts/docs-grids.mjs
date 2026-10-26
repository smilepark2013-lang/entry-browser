// scripts/docs-grids.mjs — 소개 페이지 미니 브라우저의 **진짜** 요청 격자를 만든다 → docs/grids.js
//
//   node scripts/docs-grids.mjs
//
// 미니 브라우저에서 링크를 누르면 왼쪽 띠에 뜨는 격자는 장식이 아니다. Entry Browser 가 그리는 것과
// 같은 코덱(src/lib/stripcodec.mjs)으로 만든 실제 요청이다 — 중계 앱으로 그 화면을 비추면 읽힌다.
// 격자에 담긴 주소를 바꾸면(아래 REQUESTS) 다시 돌린다.

import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutText, COLS, ROWS } from '../src/lib/stripcodec.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 미니 브라우저의 페이지 이름 → 그 페이지를 여는 요청
const REQUESTS = {
    entry: 'WEB2|1|https://ko.wikipedia.org/wiki/엔트리_(프로그래밍_언어)',
    scratch: 'WEB2|2|https://ko.wikipedia.org/wiki/스크래치_(프로그래밍_언어)',
};

const out = {};
for (const [name, req] of Object.entries(REQUESTS)) {
    const cells = Array(COLS * ROWS).fill(null);
    for (const { col, row, color } of layoutText(req)) cells[row * COLS + col] = color;
    out[name] = { req, cells };
}
const js = `// docs/grids.js — 만든 파일 (scripts/docs-grids.mjs). 손으로 고치지 말 것
// 미니 브라우저의 요청 격자: 14×28칸, 왼쪽 위부터 줄 순서. null 은 빈 칸
window.GRIDS = ${JSON.stringify({ cols: COLS, rows: ROWS, pages: out })};
`;
writeFileSync(join(ROOT, 'docs/grids.js'), js);
console.log(`✓ docs/grids.js (${Object.keys(out).join(', ')})`);
