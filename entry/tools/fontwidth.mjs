// tools/fontwidth.mjs — 나눔고딕(과 맑은 고딕)의 실제 글자 폭을 재서 src/lib/fontwidth.mjs 를 만든다
//
//   node entry/tools/fontwidth.mjs            (Chrome 과 인터넷이 필요하다 — Google Fonts 의 Nanum Gothic)
//
// 맑은 고딕은 엔트리가 '나눔고딕' 이라는 이름을 못 찾았을 때 Windows 에서 떨어지는 글꼴이다
// (실기 확인 2026-10-24: 확인 페이지의 폭이 맑은 고딕과 2% 안에서 맞았다). Windows 에서만 잰다.
//
// 엔트리 글상자는 캔버스(fillText)로 글을 그린다. 그래서 같은 글꼴을 Chrome 캔버스로 재면
// (measureText) 엔트리가 그릴 폭과 같아야 한다. 정말 같은지는 엔트리 안의 확인 페이지
// (ruler.html — 글자 폭 확인)로 본다.
//
// 재는 글자: ASCII · 운반 구간(display.RICH_RANGES) · 한글 음절 11172자 · KS X 1001 한자 (display.HANJA)
// 표 모양: { ascii: [32..126], ranges: [[처음, 끝, [폭…]]], hangul, hangulOdd, hanja, hanjaOdd }
//   음절·한자는 거의 모두 같은 폭이라 가장 흔한 값 하나와, 그와 다른 글자만 따로 적는다
// 단위: 1/1000 em. 1000px 로 재서 반올림한다.

import { writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RICH_RANGES, HANGUL, HANJA } from '../../src/lib/display.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));
if (!CHROME) { console.error('Chrome 을 찾지 못했습니다. CHROME=<경로> 로 알려 주세요.'); process.exit(1); }

const chars = [];
for (let c = 32; c <= 126; c++) chars.push(c);
for (const [a, b] of RICH_RANGES) for (let c = a; c <= b; c++) chars.push(c);
const hanja = [...new Set(HANJA)].map((ch) => ch.codePointAt(0));
// 이름: [굵기, CSS 글꼴]
const FAMILIES = { regular: [400, '"Nanum Gothic"'], bold: [700, '"Nanum Gothic"'] };
if (process.platform === 'win32') FAMILIES.malgun = [400, '"Malgun Gothic"'];

const page = `<!doctype html><meta charset=utf-8>
<link rel=stylesheet href="https://fonts.googleapis.com/css2?family=Nanum+Gothic:wght@400;700&display=block">
<pre id=o>wait</pre><span style="font-family:'Nanum Gothic'">가A</span><b style="font-family:'Nanum Gothic'">가A</b>
<script>
const CH = ${JSON.stringify(chars)}, H = ${JSON.stringify(HANGUL)}, W = ${JSON.stringify(FAMILIES)}, HJ = ${JSON.stringify(hanja)};
// ⚠ Google Fonts 는 글꼴을 글자 구간별 조각(unicode-range)으로 나눠 보낸다. 잴 글자를 **모두** 넘겨
//   조각을 다 받아야 한다 — '가A' 만 넘겼더니 그 조각의 13자만 나눔고딕, 나머지는 대체 글꼴로 쟀다.
let ALL = CH.concat(HJ).map((k) => String.fromCodePoint(k)).join('');
for (let k = H[0]; k <= H[1]; k++) ALL += String.fromCodePoint(k);
Promise.all(Object.values(W).map(([w, f]) => document.fonts.load(w + ' 100px ' + f, ALL))).then(() => {
  const c = document.createElement('canvas').getContext('2d');
  const out = { ok: document.fonts.check('100px "Nanum Gothic"') };
  for (const [name, [w, f]] of Object.entries(W)) {
    c.font = w + ' 1000px ' + f;
    const m = (s) => Math.round(c.measureText(s).width);
    const t = { chars: {}, hangul: {} };
    for (const k of CH) t.chars[String.fromCodePoint(k)] = m(String.fromCodePoint(k));
    // 음절 폭 — 가장 흔한 값 하나와, 그와 다른 음절만 따로
    const seen = {}, all = [];
    for (let k = H[0]; k <= H[1]; k++) { const v = m(String.fromCodePoint(k)); all.push(v); seen[v] = (seen[v] || 0) + 1; }
    const common = Number(Object.entries(seen).sort((a, b) => b[1] - a[1])[0][0]);
    all.forEach((v, i) => { if (v !== common) t.hangul[String.fromCodePoint(H[0] + i)] = v; });
    t.hangulCounts = seen;
    // 한자도 같은 방법으로
    const hs = {}, hw = HJ.map((k) => m(String.fromCodePoint(k)));
    hw.forEach((v) => { hs[v] = (hs[v] || 0) + 1; });
    const hc = Number(Object.entries(hs).sort((a, b) => b[1] - a[1])[0][0]);
    t.hanja = hc; t.hanjaOdd = {};
    hw.forEach((v, i) => { if (v !== hc) t.hanjaOdd[String.fromCodePoint(HJ[i])] = v; });
    // 글자 폭을 더한 값과 문자열을 통째로 잰 값 (커닝이 있으면 다르다)
    const S = ['엔트리 브라우저는 실험용입니다.', 'AVA Type Wave To. LT', 'The quick brown fox jumps over the lazy dog.'];
    t.kerning = S.map((s) => [s, m(s), [...s].reduce((a, ch) => a + m(ch), 0)]);
    out[name] = t;
  }
  document.getElementById('o').textContent = JSON.stringify(out);
});
</script>`;

const dir = mkdtempSync(join(tmpdir(), 'fontwidth-'));
const html = join(dir, 'measure.html');
writeFileSync(html, page);
const dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--virtual-time-budget=20000', '--dump-dom',
    `file:///${html.replace(/\\/g, '/')}`], { maxBuffer: 64 * 1024 * 1024 }).toString();
const raw = /<pre id="o">([^<]*)<\/pre>/.exec(dom)?.[1];
if (!raw || raw === 'wait') { console.error('재지 못했습니다 (글꼴을 못 받았나요?)'); process.exit(1); }
const data = JSON.parse(raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));
if (!data.ok) { console.error('Nanum Gothic 을 불러오지 못했습니다'); process.exit(1); }

const tables = {};
for (const name of Object.keys(FAMILIES)) {
    const t = data[name];
    const counts = Object.entries(t.hangulCounts).sort((a, b) => b[1] - a[1]);
    // 가장 흔한 음절 폭 하나 + 다른 것만 따로
    const common = Number(counts[0][0]);
    const w = (c) => t.chars[String.fromCodePoint(c)];
    tables[name] = {
        ascii: Array.from({ length: 95 }, (_, i) => w(32 + i)),
        ranges: RICH_RANGES.map(([a, b]) => [a, b, Array.from({ length: b - a + 1 }, (_, i) => w(a + i))]),
        hangul: common, hangulOdd: t.hangul, hanja: t.hanja, hanjaOdd: t.hanjaOdd,
    };
    if (Object.keys(t.hanjaOdd).length) console.log(`  ${name}: 한자 ${t.hanja} 과 다른 폭 ${Object.keys(t.hanjaOdd).length}자`);
    if (counts.length > 1) console.log(`  ${name}: 한글 음절 ${counts[0][1]}자는 ${common}, 다른 폭 ${Object.keys(t.hangul).join('')}`);
    for (const [s, whole, sum] of t.kerning) {
        if (whole !== sum) console.warn(`${name}: 커닝 있음 — "${s}" 통째 ${whole} / 더하면 ${sum}`);
    }
}

// Windows 가 아니면 맑은 고딕은 예전 표를 그대로 둔다
const malgun = tables.malgun ?? (await import('../../src/lib/fontwidth.mjs').catch(() => ({}))).MALGUN ?? null;
const out = `// src/lib/fontwidth.mjs — 글자 폭 (1/1000 em). ⚠ 만든 파일이다 — 손으로 고치지 말 것
// 만든 곳: entry/tools/fontwidth.mjs (Chrome 캔버스 measureText)
// 만든 날: ${new Date().toISOString().slice(0, 10)}
// NANUM  Google Fonts Nanum Gothic (보통 · 굵게)
// MALGUN 맑은 고딕 — 엔트리가 글꼴 이름을 못 찾았을 때 Windows 에서 떨어지는 글꼴
export const NANUM = ${JSON.stringify({ regular: tables.regular, bold: tables.bold })};
export const MALGUN = ${JSON.stringify(malgun)};
`;
writeFileSync(join(ROOT, 'src/lib/fontwidth.mjs'), out);
const r = tables.regular;
console.log(`✓ src/lib/fontwidth.mjs  (구간 ${r.ranges.length}개 · 한글 음절 ${r.hangul}/1000 em · 굵게 ${tables.bold.hangul}/1000 em`
    + `${malgun ? ` · 맑은 고딕 음절 ${malgun.hangul} 공백 ${malgun.ascii[0]}` : ''})`);
console.log(`  공백 ${r.ascii[0]} · a ${r.ascii[65]} · 한자 ${r.hanja}${malgun ? ` · 맑은 고딕 한자 ${malgun.hanja}` : ''}`);
for (const [s, whole, sum] of data.regular.kerning) console.log(`  "${s}" 통째 ${whole} / 더하면 ${sum}`);
