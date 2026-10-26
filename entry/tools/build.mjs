#!/usr/bin/env node
// tools/build.mjs — src/program.mjs → build/project.json + build/entry-browser.ent
//
//   node entry/tools/build.mjs        (저장소 루트에서 npm run build:entry)
//
// 만들어진 .ent 를 엔트리에서 [작품 불러오기] 로 열면 코드가 이미 들어 있다.
// 검증은 엔트리 OS 의 빌드에서 가져왔다 — 엔트리는 잘못된 블록을 **조용히** 무시하거나,
// 작품을 아예 못 열면서도 이유를 알려주지 않는다. 그래서 여기서 막는다.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTar } from './tar.mjs';
import program from '../src/program.mjs';
import { previewHtml } from './preview.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = program.toProject();

const DEFS = JSON.parse(readFileSync(resolve(ROOT, 'tools/blockdefs.json'), 'utf8')).blocks;
const knownIds = new Set([
    ...project.variables.map((v) => v.id),
    ...project.messages.map((m) => m.id),
    ...project.functions.flatMap((f) => [f.id, ...(f.localVariables || []).map((l) => l.id)]),
]);
const funcCallTypes = new Set(project.functions.map((f) => `func_${f.id}`));
const problems = [];

// 🔴 스레드/본문에는 **블록 객체만** 들어갈 수 있다. 문자열이 섞이면 글자 단위로 펼쳐지고
//   엔트리는 오브젝트 목록조차 못 띄운다 (엔트리 OS, 2026-07-31).
function checkBody(body, where) {
    if (!Array.isArray(body)) {
        problems.push(`${where}: 본문이 배열이 아닙니다 (${typeof body})`);
        return;
    }
    body.forEach((b, i) => {
        if (!b || typeof b !== 'object' || Array.isArray(b) || !b.type) {
            problems.push(`${where}[${i}]: 블록이 아닙니다 — ${JSON.stringify(b).slice(0, 40)}`);
            return;
        }
        checkBlock(b, where);
        (b.statements || []).forEach((st, si) => checkBody(st, `${where}[${i}].statements[${si}]`));
    });
}

function checkBlock(b, where) {
    if (!b || typeof b !== 'object' || !b.type) return;
    if (funcCallTypes.has(b.type)) return;
    const def = DEFS[b.type];
    if (!def) { problems.push(`${where}: 모르는 블록 ${b.type}`); return; }
    if ((b.params || []).length !== def.p.length) {
        problems.push(`${where}: ${b.type} 파라미터 개수 ${b.params.length} != 스키마 ${def.p.length}`);
    }
    def.p.forEach((ptype, i) => {
        const v = (b.params || [])[i];
        // DropdownDynamic 이 늘 변수 id 인 것은 아니다 (복제본 'self', 글꼴 이름 …)
        const notAnId = b.type === 'create_clone' || b.type === 'text_change_font';
        if (ptype === 'DropdownDynamic' && typeof v === 'string' && !notAnId && !knownIds.has(v)) {
            problems.push(`${where}: ${b.type} 가 모르는 id 를 참조 (${v})`);
        }
        if (v && typeof v === 'object' && v.type) checkBlock(v, where);
    });
    for (const s of b.statements || []) for (const c of s) checkBlock(c, where);
}

// 블록 id 는 프로젝트 안에서 유일해야 한다. 겹치면 불러오기가 깨진다.
const seenIds = new Map();
function collectIds(node, where) {
    if (Array.isArray(node)) return node.forEach((n) => collectIds(n, where));
    if (!node || typeof node !== 'object') return;
    if (node.type && typeof node.id === 'string') {
        if (seenIds.has(node.id)) problems.push(`${where}: 블록 id 중복 ${node.id}`);
        seenIds.set(node.id, where);
    }
    (node.params || []).forEach((p) => collectIds(p, where));
    (node.statements || []).forEach((s) => collectIds(s, where));
}

project.objects.forEach((o) => JSON.parse(o.script).forEach((t, i) => {
    checkBody(t, `${o.name}#${i}`);
    collectIds(t, `${o.name}#${i}`);
}));
project.functions.forEach((f) => JSON.parse(f.content).forEach((t, i) => {
    checkBody(t, `func ${f.id}#${i}`);
    collectIds(t, `func ${f.id}#${i}`);
}));

if (problems.length) {
    console.error('✗ 검증 실패:');
    problems.slice(0, 20).forEach((p) => console.error('  ' + p));
    process.exit(1);
}

const json = JSON.stringify(project);
mkdirSync(resolve(ROOT, 'build'), { recursive: true });
writeFileSync(resolve(ROOT, 'build/project.json'), json, 'utf8');
// 그림 애셋(SVG)을 함께 담는다. 경로는 temp/<2>/<2>/image/<filename>.svg 이고 project.json 의
// fileurl 이 같은 문자열을 가리킨다 (entry-ppt 에서 실기 확인).
const assets = program.assetFiles();
const ent = gzipSync(createTar([
    { name: 'temp/project.json', data: json },
    ...assets.map((a) => ({ name: a.path, data: a.data })),
]), { level: 9, memLevel: 6 });
writeFileSync(resolve(ROOT, 'build/entry-browser.ent'), ent);

function countBlocks(blocks) {
    let n = 0;
    for (const b of blocks || []) {
        n++;
        for (const s of b.statements || []) n += countBlocks(s);
        for (const p of b.params || []) if (p && typeof p === 'object' && p.type) n += countBlocks([p]);
    }
    return n;
}
const threads = project.objects.flatMap((o) => JSON.parse(o.script));
const funcBlocks = project.functions.reduce(
    (a, f) => a + JSON.parse(f.content).reduce((b, t) => b + countBlocks(t), 0), 0);

console.log(`✓ entry/build/project.json      (${(json.length / 1024).toFixed(1)} KB)`);
console.log(`✓ entry/build/entry-browser.ent (${(ent.length / 1024).toFixed(1)} KB)`);
console.log(`  오브젝트 ${project.objects.length}개 · 스레드 ${threads.length}개 · 블록 ${threads.reduce((a, t) => a + countBlocks(t), 0)}개`);
console.log(`  함수 ${project.functions.length}개 · 블록 ${funcBlocks}개`);
console.log(`  변수 ${project.variables.filter((v) => v.variableType === 'variable').length}개`
    + ` · 리스트 ${project.variables.filter((v) => v.variableType === 'list').length}개`
    + ` · 신호 ${project.messages.length}개`);
console.log(`  그림 ${assets.filter((a) => a.path.includes('/image/')).length}개 (SVG)`);

// 미리보기 — 엔트리 없이 배치와 색을 본다 (블록을 시뮬레이터로 돌린 결과)
writeFileSync(resolve(ROOT, 'build/preview.html'), previewHtml(project, assets, readFileSync(resolve(ROOT, 'tools/fixtures/sample.html'), 'utf8')), 'utf8');
console.log('✓ entry/build/preview.html');
