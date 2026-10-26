// tools/shot.mjs — 받은 줄 목록을 엔트리 시뮬레이터로 그린 미리보기 HTML
//
//   node --stack-size=8000 entry/tools/shot.mjs <pages.json> <out.html>
//
// pages.json = [{ "title": "...", "url": "https://...", "body": "<layoutHtml().body>" }, ...]
// 실제 사이트를 중계 앱(텍스트 모드·렌더 모드)으로 받아 엔트리에서 어떻게 보이는지 견줄 때 쓴다.

import { readFileSync, writeFileSync } from 'node:fs';
import program from '../src/program.mjs';
import { pagesPreviewHtml } from './preview.mjs';

const [src, out] = process.argv.slice(2);
if (!src || !out) {
    console.error('쓰는 법: node --stack-size=8000 entry/tools/shot.mjs <pages.json> <out.html>');
    process.exit(1);
}
const pages = JSON.parse(readFileSync(src, 'utf8'));
writeFileSync(out, pagesPreviewHtml(program.toProject(), program.assetFiles(), pages), 'utf8');
console.log(`✓ ${out} (${pages.length}쪽)`);
