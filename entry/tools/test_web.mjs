// tools/test_web.mjs — 생성된 블록을 시뮬레이터로 돌려 Entry Browser 를 검사한다
//
//   node --stack-size=8000 entry/tools/test_web.mjs      (먼저 build.mjs)
//
// 시뮬레이터는 엔트리처럼 `그리고/또는` 의 **양쪽을 다 계산한다** — 리스트 범위 밖 읽기가
// 숨어 있으면 여기서 예외가 난다 (실기: 빈 줄에 마우스를 올리자 튕긴 사고).
//
// 응답은 중계 앱의 layout.mjs · payload.mjs 로 만든다. 같은 저장소라 어긋나면 바로 잡힌다.
// ⚠ 입력창의 답은 **읽히는 순간** 만든다 — 그 전에 그려진 격자에서 요청 번호를 읽어야 하고,
//   답을 읽은 직후 logic 이 붓을 지운다.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sim } from './simulate.mjs';
import * as S from '../../src/lib/snapcodec.mjs';
import * as T from '../../src/lib/stripcodec.mjs';
import { encodeResponse, parseRequest, adler32 } from '../../src/lib/payload.mjs';
import { layoutHtml } from '../../src/lib/layout.mjs';
import { parseBody, STYLES, COLORS, CODES, heightOf } from '../../src/lib/display.mjs';
import { C, VIEW } from '../src/theme.mjs';
import { SLOTS } from '../src/page.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = JSON.parse(readFileSync(resolve(ROOT, 'build', 'project.json'), 'utf8'));
const SAMPLE = readFileSync(resolve(ROOT, 'tools', 'fixtures', 'sample.html'), 'utf8');

let pass = true;
const chk = (label, ok, detail = '') => {
    pass = pass && ok;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail && !ok ? `\n       ${detail}` : ''}`);
};
const eq = (label, got, want) => chk(label, String(got) === String(want), `got  ${got}\n       want ${want}`);
const safe = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
// visit() 이 answer 를 getter 로 바꿔 두므로, 값을 넣을 때는 다시 정의한다
const setAnswer = (sim, v) => Object.defineProperty(sim, 'answer', { configurable: true, writable: true, value: v });

// ---------------------------------------------------------------- 도우미
function rasterize(strokes) {
    const grid = Array.from({ length: T.ROWS }, () => Array.from({ length: T.COLS }, () => null));
    for (const st of strokes) {
        const row = Math.round((T.Y0 - st.y0 - T.CELL / 2) / T.CELL);
        const c0 = Math.round((Math.min(st.x0, st.x1) - T.X0) / T.CELL);
        const c1 = Math.round((Math.max(st.x0, st.x1) - T.X0) / T.CELL) - 1;
        if (row < 0 || row >= T.ROWS) continue;
        for (let c = c0; c <= c1; c++) if (c >= 0 && c < T.COLS) grid[row][c] = st.color;
    }
    return grid;
}
const toLevels = (grid) => grid.map((r) => r.map((hex) => (hex && hex !== S.MARKER
    ? [1, 3, 5].map((i) => S.byteToLevel(parseInt(hex.slice(i, i + 2), 16))) : [0, 0, 0])));

const sigs = (sim, fn) => { sim.log.signal = []; fn(); return [...sim.log.signal]; };
const slotObjects = project.objects.filter((o) => /^t(h1|h2|h3|body|small|mono)\d+$|^rule\d+$/.test(o.name)).map((o) => o.name);

/** 화면 오브젝트가 sig_paint / sig_hover 를 전부 받게 한다 (엔트리는 신호를 모두에게 보낸다) */
function broadcast(sim, sig) {
    for (const o of project.objects) {
        if (!JSON.parse(o.script).some((t) => t[0].type === 'when_message_cast' && t[0].params[1] === sim.msg.get(sig))) continue;
        if (o.name === 'logic') continue;
        sim.runSignal(o.name, sig);
    }
}
function boot() {
    const sim = new Sim(project);
    sim.runStart('logic');
    sim.runSignal('logic', 'sig_go');
    return sim;
}
const answerWith = (finalUrl, body) => (raw) => {
    const req = parseRequest(raw || '');
    return encodeResponse(req ? req.seq : 0, finalUrl, body, 2);
};
function visit(sim, url, reply, kind = 1) {
    const seen = { asked: false, raw: null, err: '' };
    Object.defineProperty(sim, 'answer', {
        configurable: true,
        get() {
            seen.asked = true;
            seen.strokes = [...sim.log.pen];
            try { seen.raw = T.readGrid(toLevels(rasterize(sim.log.pen))); } catch (e) { seen.err = e.message; }
            return reply(seen.raw);
        },
    });
    sim.log.pen = [];
    sim.setVar('nv_kind', kind);
    sim.setVar('nv_to', url);
    sim.frames = 0;
    sim.runSignal('logic', 'sig_go');
    seen.frames = sim.frames;
    return seen;
}
const pageLines = (sim) => {
    const n = Number(sim.getVar('pg_n'));
    const g = (name) => sim.getList(name).slice(0, n);
    return g('ln_t').map((t, i) => ({
        text: String(t), style: Number(g('ln_s')[i]), x: Number(g('ln_x')[i]), link: Number(g('ln_l')[i]),
        color: Number(g('ln_c')[i]), bg: Number(g('ln_b')[i]), y: Number(g('ln_y')[i]), k: String(g('ln_k')[i] ?? ''),
    }));
};
/** 지금 그려진 칸들 — {name, text, x, y, shown} */
// 칸 번호 → 오브젝트 이름 (page.SLOTS · page.OVL 과 같은 순서)
const SLOT_NAMES = []; const OVL_NAMES = [];
for (const s of Object.keys(STYLES).map(Number).filter((x) => x > 0)) {
    for (let i = 0; i < STYLES[s].pool; i++) SLOT_NAMES.push(s === 7 ? `rule${i}` : s === 8 ? `track${i}` : `t${STYLES[s].name}${i}`);
    for (let i = 0; i < (STYLES[s].ovl || 0); i++) OVL_NAMES.push(`o${STYLES[s].name}${i}`);
}
/** 줄 li(1부터)를 그리는 줄 글상자 이름 (배정되지 않았으면 null) */
const boxOfLine = (sim, li) => { const k = sim.getList('rd_line').map(Number).indexOf(li); return k < 0 ? null : SLOT_NAMES[k]; };
/** 줄 li 의 조각을 그리는 여분 글상자들 — {name, text, fg, pos} */
const segBoxes = (sim, li) => sim.getList('rd_ov').map(Number).map((g, k) => ({ g, name: OVL_NAMES[k] }))
    .filter(({ g }) => g > 0 && Number(sim.getList('sg_l')[g - 1]) === li)
    .map(({ name }) => ({ name, text: sim.wrote.get(name) ?? '', fg: sim.fg.get(name), pos: sim.pos.get(name), shown: sim.shown.get(name) }));
const painted = (sim) => slotObjects.filter((n) => sim.shown.get(n)).map((n) => ({
    name: n, text: sim.wrote.get(n) ?? '', fg: sim.fg.get(n), bg: sim.bg.get(n), pos: sim.pos.get(n),
}));

// ---------------------------------------------------------------------------
console.log('\n1. 시작 페이지');
// ---------------------------------------------------------------------------
const sim = boot();
eq('주소', sim.getVar('br_url'), 'index.html');
eq('제목', sim.getVar('pg_title'), '시작 페이지');
{
    const ls = pageLines(sim);
    chk(`줄 ${ls.length}개`, ls.length > 5);
    chk('h1 줄이 있다', ls.some((l) => l.style === 1 && l.text === 'Entry Browser'));
    chk('링크 줄은 링크 색', ls.filter((l) => l.link && l.text.trim().startsWith('•')).every((l) => l.color === 2));
    eq('링크 수', sim.getVar('pg_nl'), 4);
    eq('일이 끝났다', sim.getVar('ui_busy'), 0);
}

// 그리기 — 칸들이 줄을 제자리에 그리는가
// (시작 페이지에 검색창이 있어서 링크 목록은 첫 화면 아래에 있다 — 거기까지 내린다)
{
    {
        const ls0 = pageLines(sim);
        const li0 = ls0.findIndex((l) => l.text.trim().startsWith('• 위키백과'));
        sim.setVar('sc', Math.max(0, Math.min(Number(sim.getVar('sc_max')), ls0[li0].y - 60)));
        sim.runFunc('rd_lay', 'logic');
    }
    broadcast(sim, 'sig_paint');
    const ls = pageLines(sim);
    const ps = painted(sim);
    chk(`칸 ${ps.length}개가 보인다`, ps.length > 5);
    let bad = [];
    for (const p of ps) {
        const st = Object.values(STYLES).find((s) => s.name && p.name.startsWith(s.name === 'rule' ? 'rule' : `t${s.name}`));
        const top = VIEW.top - (p.pos[1] + st.lh / 2);
        if (top < -0.01 || top + st.lh > VIEW.h + 0.01) bad.push(`${p.name} 위 ${top}`);
    }
    chk('보이는 칸은 전부 본문 안', bad.length === 0, bad.slice(0, 3).join(', '));
    const h1 = ps.find((p) => p.name.startsWith('th1'));
    chk('제목은 h1·h2 칸에 그려진다', !!ps.find((p) => /^th[12]/.test(p.name)), JSON.stringify(h1));
    const link = ps.find((p) => p.text.trim().startsWith('• 위키백과'));
    eq('링크 줄 글자색', link?.fg, COLORS[2]);
    // 겹치지 않는가
    const ys = ps.filter((p) => !p.name.startsWith('rule')).map((p) => [p.pos[1], p.name]).sort((a, b) => b[0] - a[0]);
    const overlaps = ys.filter((y, i) => i && Math.abs(y[0] - ys[i - 1][0]) < 8);
    chk('칸끼리 겹치지 않는다', overlaps.length === 0, JSON.stringify(overlaps.slice(0, 3)));
    eq('주소창', sim.wrote.get('url'), 'index.html');
}

// 🔴 마우스 — 빈 자리·마지막 줄 아래·본문 밖 어디에 올려도 죽지 않는다 (실기 사고)
{
    const errs = [];
    for (let my = VIEW.top + 5; my >= VIEW.bottom - 5; my -= 3) {
        for (const mx of [VIEW.left - 3, VIEW.left + 10, VIEW.right - 5, VIEW.right + 4]) {
            sim.mouse = { x: mx, y: my };
            const e = safe(() => { sim.runFunc('ms_tick', 'mouse'); broadcast(sim, 'sig_hover'); });
            if (e) errs.push(`(${mx},${my}) ${e}`);
        }
    }
    chk('본문 어디에 마우스를 올려도 예외가 없다 (짧은 페이지)', errs.length === 0, errs.slice(0, 3).join('\n       '));
    // 링크 줄 위
    const ls = pageLines(sim);
    const li = ls.findIndex((l) => l.text.trim().startsWith('• 위키백과'));
    sim.mouse = { x: VIEW.left + 20, y: VIEW.top - (ls[li].y - Number(sim.getVar('sc'))) - 5 };
    sim.runFunc('ms_tick', 'mouse');
    eq('링크 줄 위 → ui_hov', sim.getVar('ui_hov'), li + 1);
    broadcast(sim, 'sig_hover');
    const p = painted(sim).find((x) => x.text.trim().startsWith('• 위키백과'));
    eq('  바탕이 밝아진다', p?.bg, C.hover);
    sim.mouse = { x: 0, y: 0 };
}

// 누르기 — 링크 줄 칸을 누르면 이동
{
    const p = painted(sim).find((x) => x.text.trim().startsWith('• 사용법'));
    sim.mouse = { x: VIEW.left + 15, y: p.pos[1] };
    const s = sigs(sim, () => sim.runClick(p.name));
    chk('링크 줄을 누르면 이동', s.includes('sig_go'), s.join(','));
    eq('  가는 곳', sim.getVar('nv_to'), 'help.html');
    // 링크도 칸도 없는 보이는 줄 하나
    const plainLines = new Set(pageLines(sim).filter((l) => !l.link && l.text.trim() && l.style !== 7).map((l) => l.text));
    const plain = painted(sim).find((x) => plainLines.has(x.text) && !x.name.startsWith('rule'));
    const s2 = sigs(sim, () => sim.runClick(plain.name));
    chk('링크 없는 줄은 아무 일 없음', !s2.includes('sig_go'));
    // 빈 칸(숨은 칸)을 눌러도 죽지 않는다
    const hidden = slotObjects.find((n) => !sim.shown.get(n) && !n.startsWith('rule'));
    chk('숨은 칸을 눌러도 예외 없음', !safe(() => sim.runClick(hidden)), hidden);
}

// ---------------------------------------------------------------------------
console.log('\n2. 웹 페이지 — 띠 격자 → 입력창 → 줄 목록');
// ---------------------------------------------------------------------------
const URL1 = 'https://example.com/intro';
const BODY = layoutHtml(SAMPLE, URL1, { mode: 'full' }).body;
{
    const r = visit(sim, URL1, answerWith(URL1, BODY));
    chk('입력창이 열렸다', r.asked);
    eq('띠의 격자 → WEB2|1|주소', r.raw, `WEB2|1|${URL1}`);
    chk('  체크섬 통과', !r.err, r.err);
    const right = Math.max(...r.strokes.map((s) => Math.max(s.x0, s.x1)));
    const bottom = Math.min(...r.strokes.map((s) => s.y0 - s.size / 2));
    chk(`  격자는 띠 안 (오른쪽 ${right} ≤ ${T.X0 + T.WIDTH}, 아래 ${bottom} ≥ ${T.Y0 - T.HEIGHT})`,
        right <= T.X0 + T.WIDTH && bottom >= T.Y0 - T.HEIGHT);
    eq('오류 없음', sim.getVar('wb_err'), 0);
    eq('주소', sim.getVar('br_url'), URL1);
    eq('기록에 앞 페이지', sim.getList('br_hist').at(-1), 'index.html');

    // 받은 줄이 중계 앱이 보낸 것과 **같은가**
    const want = parseBody(BODY, URL1);   // 같은 출처 링크는 경로만 온다 — 엔트리처럼 출처를 붙여 견준다
    const got = pageLines(sim);
    eq('줄 수', got.length, want.lines.filter((l) => l.style !== 0).length);
    const diff = [];
    let y = 0; let gi = 0;
    for (const l of want.lines) {
        if (l.style === 0) { y += l.gap; continue; }
        const g = got[gi++];
        const ks = l.spans.map((s) => `${s.x0},${s.x1},${s.link}`).join(';');
        if (g.text !== l.text || g.style !== l.style || g.x !== l.indent || g.link !== l.link || g.color !== l.color
            || g.bg !== l.bg || g.y !== y || g.k !== ks) diff.push(`${gi}: ${JSON.stringify(g)} != ${JSON.stringify({ ...l, y })}`);
        y += heightOf(l);
    }
    chk('줄마다 글·스타일·들여쓰기·링크·색·바탕·y·링크구간 일치', diff.length === 0, diff.slice(0, 2).join('\n       '));
    eq('페이지 높이', sim.getVar('pg_h'), y);
    eq('링크', sim.getList('ln_href').slice(0, Number(sim.getVar('pg_nl'))).join(' '), want.links.join(' '));
    eq('띠의 판이 돌아왔다', sim.getVar('ui_strip'), 1);
    eq('붓을 지웠다', sim.log.pen.length, 0);
    console.log(`       (시뮬레이터 프레임 ${r.frames} — 실제 엔트리에서는 프레임당 1/60초)`);
}

// 링크 구간 — 한 줄에 링크가 둘이면 누른 x 로 고른다
{
    broadcast(sim, 'sig_paint');
    const ls = pageLines(sim);
    const two = ls.findIndex((l) => l.k.split(';').filter(Boolean).length >= 2);
    if (two < 0) chk('링크 둘인 줄이 있다', false);
    else {
        // 그 줄이 보이게 스크롤
        sim.setVar('sc', Math.min(Number(sim.getVar('sc_max')), ls[two].y));
        sim.runFunc('rd_lay', 'logic');
        broadcast(sim, 'sig_paint');
        const name = boxOfLine(sim, two + 1);
        const p = { name, pos: sim.pos.get(name) };
        const spans = ls[two].k.split(';').map((t) => t.split(',').map(Number));
        for (const [x0, x1, link] of spans) {
            sim.mouse = { x: VIEW.left + ls[two].x + (x0 + x1) / 2, y: p.pos[1] };
            sigs(sim, () => sim.runClick(p.name));
            eq(`  구간 ${x0}-${x1} 을 누르면 링크 ${link}`, sim.getVar('nv_to'), sim.getList('ln_href')[link - 1]);
        }

        // 조각 — 문단 속 링크에 색을 입힌다
        const full = ls[two].text;
        const segs = segBoxes(sim, two + 1);
        const base = sim.wrote.get(name);
        chk('조각: 줄 글상자는 첫 링크 앞까지만', full.startsWith(base) && base.length < full.length, `${base} / ${full}`);
        chk('  조각이 그려진다', segs.length >= 2 && segs.every((x) => x.shown), JSON.stringify(segs));
        eq('  줄 글상자 + 조각을 이으면 원래 줄 (공백 빼고)', (base + segs.map((x) => x.text).join('')).replace(/\s/g, ''), full.replace(/\s/g, ''));
        chk('  링크 조각은 링크 색, 나머지는 줄 색', segs.some((x) => x.fg === COLORS[2]) && segs.every((x) => x.fg === COLORS[2] || x.fg === COLORS[0]),
            segs.map((x) => `${x.text}:${x.fg}`).join(' '));
        chk('  조각은 그 줄의 y', segs.every((x) => x.pos[1] === p.pos[1]));
        chk('  조각의 x 는 왼쪽에서 오른쪽으로', segs.every((x, i) => !i || x.pos[0] > segs[i - 1].pos[0]));
        // 링크 조각을 누르면 그 링크로
        for (const [x0, x1, link] of spans) {
            const box = segs.find((x) => x.fg === COLORS[2] && Math.abs((x.pos[0] - VIEW.w / 2 - VIEW.left) - x0) < 4);
            if (!box) { chk(`  링크 ${link} 조각이 있다`, false, JSON.stringify(segs)); continue; }
            sim.setVar('nv_to', '');
            sim.mouse = { x: VIEW.left + (x0 + x1) / 2, y: p.pos[1] };
            sigs(sim, () => sim.runClick(box.name));
            eq(`  링크 조각 '${box.text}' 을 누르면 링크 ${link}`, sim.getVar('nv_to'), sim.getList('ln_href')[link - 1]);
        }
    }
}

// 조각이 모자라면 — 그 줄은 한 색으로 통째 (글이 비지 않는다)
{
    // 링크가 글의 45% 를 넘으면 "링크마다 한 줄" 로 나뉘어 조각이 안 생긴다 — 설명 글을 섞는다
    const many = Array.from({ length: 40 }, (_, i) => `<a href="/l${i}">ㄱ${i}</a> 와 그리고 긴 설명 글`).join(' ');
    const URLM = 'https://example.com/many';
    const tm = boot();
    visit(tm, URLM, answerWith(URLM, layoutHtml(`<p>${many}</p>`, URLM, { mode: 'full' }).body));
    broadcast(tm, 'sig_paint');
    const ls = pageLines(tm);
    const shownLines = ls.map((l, i) => i + 1).filter((li) => boxOfLine(tm, li));
    const used = Number(tm.getList('ov_cnt')[3]);
    chk(`조각 상한: 여분 글상자를 넘지 않는다 (${used}/${STYLES[4].ovl})`, used <= STYLES[4].ovl);
    const whole = shownLines.filter((li) => Number(tm.getList('ln_ov')[li - 1]) === 0 && Number(tm.getList('ln_sn')[li - 1]) > 0);
    chk('  모자란 줄은 통째로 그린다', whole.every((li) => tm.wrote.get(boxOfLine(tm, li)) === ls[li - 1].text), whole.join(','));
    chk('  (모자란 줄이 실제로 생겼다)', whole.length > 0, `${shownLines.length}줄`);
}

// 스크롤
{
    sim.setVar('sc', 0);
    sim.runFunc('rd_lay', 'logic');
    const max = Number(sim.getVar('sc_max'));
    chk(`스크롤 끝 ${max}px (페이지 ${sim.getVar('pg_h')} - 본문 ${VIEW.h})`, max === Number(sim.getVar('pg_h')) - VIEW.h);
    sim.runKey('keys', 35);                  // End
    eq('End → 맨 아래', sim.getVar('sc'), max);
    broadcast(sim, 'sig_paint');
    const ls = pageLines(sim);
    const last = ls.at(-1);
    chk('맨 아래에서 마지막 줄이 보인다', painted(sim).some((p) => p.text === last.text), last.text);
    sim.runKey('keys', 36);                  // Home
    eq('Home → 맨 위', sim.getVar('sc'), 0);
    sim.runKey('keys', 40);
    eq('↓ → 45px', sim.getVar('sc'), Math.min(45, max));
    // 배정이 풀 크기를 넘지 않는가
    const cnt = sim.getList('rd_cnt').map(Number);
    const caps = Object.keys(STYLES).map(Number).filter((s) => s > 0).map((s) => STYLES[s].pool);
    chk('풀 배정 ≤ 풀 크기', cnt.every((c, i) => c <= caps[i]), `${cnt} / ${caps}`);
    eq('칸 목록 길이', sim.getList('rd_line').length, SLOTS.total);
}

// ---------------------------------------------------------------------------
console.log('\n3. 뒤로 · 앞으로 · 다시 받기 · 취소');
// ---------------------------------------------------------------------------
{
    sim.setVar('nv_kind', 2); sim.setVar('nv_to', sim.getList('br_hist').at(-1));
    sim.runSignal('logic', 'sig_go');
    eq('뒤로 → 시작 페이지', sim.getVar('br_url'), 'index.html');
    eq('  리스트를 덮어썼다 (줄 수가 줄었다)', pageLines(sim).some((l) => l.text === 'Entry Browser'), true);
    const r = visit(sim, URL1, () => 'SHOULD NOT ASK', 3);
    chk('앞으로 — 캐시에서 (입력창 안 열림)', !r.asked);
    eq('  주소', sim.getVar('br_url'), URL1);
    sim.setVar('wb_nocache', 1);
    const r2 = visit(sim, URL1, answerWith(URL1, BODY), 4);
    chk('다시 받기는 캐시를 건너뛴다', r2.asked);
    eq('  번호가 올랐다', r2.raw, `WEB2|2|${URL1}`);

    const t = boot();
    const r3 = visit(t, 'https://example.com/x', () => '');
    chk('취소 — 입력창은 열렸다', r3.asked);
    eq('  주소 그대로', t.getVar('br_url'), 'index.html');
    eq('  기록 그대로', t.getList('br_hist').length, 0);
    eq('  일이 끝났다', t.getVar('ui_busy'), 0);
}

// ---------------------------------------------------------------------------
console.log('\n4. 잘못된 응답 · 너무 긴 주소 · 없는 페이지');
// ---------------------------------------------------------------------------
{
    const t = boot();
    visit(t, URL1, (raw) => {
        const b = S.textToBytes(`${URL1}\nThello`);
        return `EBR2|${parseRequest(raw).seq}|${b.length}|${adler32(b) + 1}|${Buffer.from(b).toString('base64')}`;
    });
    eq('체크섬 오류 → 4', t.getVar('wb_err'), 4);
    chk('  오류 페이지를 그린다', pageLines(t).some((l) => l.text === '응답을 읽지 못했습니다'));
    eq('  링크 1 = 다시 요청', t.getList('ln_href')[0], URL1);

    const t2 = boot();
    visit(t2, URL1, () => 'EBR1|1|1|1|AA');
    eq('엔트리 OS 판(EBR1) → 1', t2.getVar('wb_err'), 1);

    const t3 = boot();
    const r = visit(t3, `https://example.com/${'a'.repeat(T.CAPACITY)}`, () => 'SHOULD NOT ASK');
    chk('너무 긴 주소는 입력창을 열지 않는다', !r.asked);
    chk('  이유를 페이지로', pageLines(t3).some((l) => l.text === '주소가 너무 깁니다'));

    // 검색 엔진 경유 링크는 실제 주소로 풀린다 (덕덕고 결과가 빈 페이지였던 사고)
    {
        const wrapped = layoutHtml('<p><a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx%3Fa%3D1&rut=abc">덕덕고 결과</a> '
            + '<a href="https://www.google.com/url?q=https://example.org/y&sa=U">구글 결과</a></p>', 'https://html.duckduckgo.com/html/', { mode: 'full' });
        eq('경유 링크 풀기 (덕덕고 · 구글)', parseBody(wrapped.body).links.join(' '), 'https://example.com/x?a=1 https://example.org/y');
    }

    // 링크 줄이기 — 한글 주소는 글자 그대로, 같은 출처는 경로만 (엔트리가 출처를 붙인다)
    {
        const KO = 'https://ko.wikipedia.org/wiki/%EB%8C%80%ED%95%9C%EB%AF%BC%EA%B5%AD';
        const html = '<p><a href="/wiki/%EC%97%94%ED%8A%B8%EB%A6%AC_(%EB%AC%B8%EC%84%9C)">엔트리</a> · '
            + '<a href="https://en.wikipedia.org/wiki/Entry">영어판</a> · <a href="/w/index.php?title=%ED%8A%B9&amp;q=a%20b">특수</a></p>';
        const body = layoutHtml(html, KO, { mode: 'full' }).body;
        const raw = body.split('\n').filter((l) => l[0] === 'U').map((l) => l.slice(1));
        eq('링크 줄이기: 같은 출처는 경로만 · 한글은 글자로', raw.join(' '),
            '/wiki/엔트리_(문서) https://en.wikipedia.org/wiki/Entry /w/index.php?title=특&q=a%20b');
        const tk = boot();
        visit(tk, KO, answerWith(KO, body));
        const hrefs = tk.getList('ln_href').slice(0, Number(tk.getVar('pg_nl')));
        eq('  엔트리가 출처를 붙여 원래 주소로', hrefs.join(' '),
            'https://ko.wikipedia.org/wiki/엔트리_(문서) https://en.wikipedia.org/wiki/Entry https://ko.wikipedia.org/w/index.php?title=특&q=a%20b');
        chk('  다시 인코딩하면 원래 요청과 같은 주소', new URL(hrefs[0]).href === new URL('https://ko.wikipedia.org/wiki/%EC%97%94%ED%8A%B8%EB%A6%AC_(%EB%AC%B8%EC%84%9C)').href);
        eq('  주소창에는 읽을 수 있는 주소', tk.getVar('br_url'), 'https://ko.wikipedia.org/wiki/대한민국');
        // 그 링크로 요청하면 색 격자에 한글이 그대로 실린다 (퍼센트 9바이트 대신 3바이트)
        const r2 = visit(tk, hrefs[0], answerWith(hrefs[0], body));
        eq('  한글 주소 요청이 격자로 그대로', r2.raw, `WEB2|${tk.getVar('wb_seq')}|${hrefs[0]}`);
    }

    // 레이아웃 모드 — 쪽 넘김 · 글 조각은 복제본 · 상자·그림은 붓
    {
        const { pageLayout, LAYOUT_SIZES } = await import('../../src/lib/pager.mjs');
        const LURL = 'https://news.example.com/';
        const list = {
            width: 600, height: 900, page: '#ffffff',
            boxes: [{ x: 0, y: 0, w: 600, h: 60, c: '#ff6600' }, { x: 20, y: 100, w: 200, h: 120, c: '#2563eb' }],
            texts: [
                { x: 20, y: 20, w: 150, h: 20, t: 'Hacker News', s: 16, c: '#000000', b: 1, href: 'https://news.example.com/' },
                { x: 30, y: 110, w: 120, h: 20, t: '버튼 글', s: 15, c: '#ffffff', b: 0 },
                ...Array.from({ length: 30 }, (_, i) => ({ x: 20, y: 240 + i * 24, w: 300, h: 20, t: `본문 줄 ${i}`, s: 15, c: '#333333', b: 0,
                    href: i % 5 === 0 ? `https://news.example.com/item?id=${i}` : '' })),
            ],
            images: [{ x: 300, y: 100, w: 120, h: 80, px: { cols: 6, rows: 4, cells: Array.from({ length: 24 }, (_, i) => (i % 2 ? '#112233' : '#eeddcc')) } }],
        };
        // 그림 대체 글 모드 — 칸 대신 회색 상자 + "[그림] 대체 글"
        {
            const alt = { ...list, images: [{ ...list.images[0], alt: '고양이 사진' }] };
            const A = pageLayout(alt, LURL, { title: 'HN', images: 'alt' });
            const ab = A.body.split('\n');
            chk('레이아웃 그림 대체 글: 그림 칸(J)이 없다', !ab.some((l) => l[0] === 'J') && A.images === 0);
            chk('  [그림] 대체 글 조각', ab.some((l) => l[0] === 'Z' && l.slice(20).startsWith('[그림] 고양')), ab.filter((l) => l[0] === 'Z').map((l) => l.slice(20)).join(' / '));
            chk('  회색 상자', ab.some((l) => l[0] === 'X' && l.slice(16, 17) !== '' && parseBody(A.body).colors[CODES.indexOf(l[16])] === '#e2e8f0'));
        }
        const P = pageLayout(list, LURL, { title: 'HN' });
        const pb = parseBody(P.body);
        const tl = boot();
        visit(tl, LURL, answerWith(LURL, P.body));
        eq('레이아웃: 쪽 수', tl.getVar('ly_n'), P.screens);
        eq('  글 조각 · 상자 · 그림 수', `${tl.getVar('ly_nz')} ${tl.getVar('ly_nx')} ${tl.getVar('ly_nj')}`, `${P.texts} ${P.boxes} ${P.images}`);
        eq('  줄 목록은 비어 있다 (줄 글상자를 쓰지 않는다)', tl.getVar('pg_n'), 0);
        broadcast(tl, 'sig_lay');
        const z1 = P.body.split('\n').filter((l) => l.startsWith('Z001'));
        const shownClones = () => tl.clones.filter((c) => c.shown);
        eq('  1쪽 글 조각이 복제본으로', shownClones().length, z1.length);
        chk('  복제본 글이 조각 글', z1.every((l) => shownClones().some((c) => c.wrote === l.slice(20))), shownClones().map((c) => c.wrote).join(' / '));
        const big = shownClones().find((c) => c.wrote === 'Hacker News');
        chk('  굵은 조각은 굵게', big?.effect.has('fontBold'));
        chk('  원본은 숨는다', LAYOUT_SIZES.every((s) => !tl.shown.get(`lt${s}`)));
        const strokes = tl.log.pen.filter((s) => s.owner === 'painter');
        chk('  상자·그림은 화가의 붓으로', strokes.length >= 3 && strokes.some((s) => s.color === '#ff6600'), `${strokes.length}획`);
        const orange = strokes.find((s) => s.color === '#ff6600');
        chk('  상자 = 가로 획 (굵기 = 높이)', orange && orange.y0 === orange.y1 && Math.round(orange.size) === Math.round(60 * 366 / 600), JSON.stringify(orange));
        eq('  상태줄에 쪽', String(tl.getVar('ui_msg')).trim(), `HN   ·   1 / ${P.screens}쪽`);
        // ↓ → 다음 쪽
        tl.runKey('keys', 40);
        eq('  ↓ 는 한 쪽', tl.getVar('sc'), 1);
        broadcast(tl, 'sig_lay');
        const z2 = P.body.split('\n').filter((l) => l.startsWith('Z002'));
        eq('  2쪽 복제본으로 바뀐다 (1쪽 것은 지운다)', shownClones().length, z2.length);
        // 링크 조각 누르기 — 복제본의 클릭 스레드는 원본 것 (마우스 자리로 링크를 고른다)
        // Z<SSS><XXX><YYY><WWW><K><C><B><LLLL><글> — 링크는 16..19 번째 글자
        const zl = z2.find((l) => Number(l.slice(16, 20)) > 0);
        const [x, y] = [Number(zl.slice(4, 7)), Number(zl.slice(7, 10))];
        tl.mouse = { x: VIEW.left + x + 3, y: VIEW.top - y - 4 };
        tl.setVar('nv_to', '');
        sigs(tl, () => tl.runClick(`lt${LAYOUT_SIZES[CODES.indexOf(zl[13])]}`));
        eq('  링크 조각을 누르면 그 링크로', tl.getVar('nv_to'), pb.links[Number(zl.slice(16, 20)) - 1].replace(/^\//, 'https://news.example.com/'));
        // 일반 페이지로 가면 복제본·붓을 지운다
        const plain = 'https://example.com/after-layout';
        visit(tl, plain, answerWith(plain, layoutHtml('<p>평범한 페이지</p>', plain, { mode: 'full' }).body));
        broadcast(tl, 'sig_lay');
        eq('  레이아웃 아닌 페이지: 복제본 없음', tl.clones.length, 0);
        eq('  붓 획 없음', tl.log.pen.filter((s) => s.owner === 'painter').length, 0);
        eq('  줄 목록으로 돌아온다', pageLines(tl).some((l) => l.text === '평범한 페이지'), true);
    }

    // 렌더 모드의 CSS (data-eb) — 크기 → 스타일, 사이트 색 · 바탕 · 정렬 · 대문자, 페이지 바탕
    {
        const css = '<html data-eb-page="#0d1117"><body data-eb="c:#c9d1d9;s:16;w:0;a:l;t:;f:;">'
            + '<div data-eb="c:#ffffff;s:32;w:1;">큰 제목</div>'
            + '<p><a href="/x" data-eb="c:#58a6ff;">링크</a></p>'
            + '<div data-eb="c:#111111;b:#ff6600;"><p>주황 띠 첫째</p><p>주황 띠 둘째</p></div>'
            + '<p data-eb="a:c;t:u;">center me</p>'
            + '<p data-eb="c:#0e1218;">안 보이는 글</p></body></html>';
        const p = parseBody(layoutHtml(css, URL1, { mode: 'full' }).body);
        const at = (t) => p.lines.find((l) => l.text.trim() === t);
        eq('CSS: 페이지 바탕 (G 줄)', p.page, '#0d1117');
        eq('CSS: 32px 굵은 글 → h1', at('큰 제목')?.style, 1);
        eq('CSS: 제목 글자색', p.colors[at('큰 제목')?.color], '#ffffff');
        eq('CSS: 링크 색은 사이트의 링크 색', p.colors[at('링크')?.color], '#58a6ff');
        eq('CSS: 칠한 블록의 바탕', p.bgs[at('주황 띠 첫째')?.bg], '#ff6600');
        const i1 = p.lines.indexOf(at('주황 띠 첫째'));
        chk('CSS: 같은 색 띠 안에서는 간격 줄이 없다', p.lines[i1 + 1] === at('주황 띠 둘째'), JSON.stringify(p.lines[i1 + 1]));
        chk('CSS: 가운데 정렬은 앞 공백 · 대문자', /^ {10,}CENTER ME$/.test(at('CENTER ME')?.text || ''), at('CENTER ME')?.text);
        chk('CSS: 바탕과 거의 같은 글자색은 읽히게 고친다', p.colors[at('안 보이는 글')?.color] !== '#0e1218', p.colors[at('안 보이는 글')?.color]);

        const tc = boot();
        visit(tc, URL1, answerWith(URL1, layoutHtml(css, URL1, { mode: 'full' }).body));
        broadcast(tc, 'sig_paint');
        const box = painted(tc).find((b) => b.text === '큰 제목');
        eq('CSS 왕복: 엔트리가 그린 제목 글자색', box?.fg, '#ffffff');
        eq('CSS 왕복: 제목 줄 바탕 = 페이지 바탕', box?.bg, '#0d1117');
        eq('CSS 왕복: 주황 띠', painted(tc).find((b) => b.text.trim() === '주황 띠 첫째')?.bg, '#ff6600');
        eq('CSS 왕복: 페이지 바탕 상자', tc.bg.get('pagebg'), '#0d1117');
        const plain = 'https://example.com/plain';
        visit(tc, plain, answerWith(plain, layoutHtml('<p>평범한 페이지</p>', plain, { mode: 'full' }).body));
        broadcast(tc, 'sig_paint');
        eq('CSS 없는 페이지로 가면 바탕이 흰색으로', tc.bg.get('pagebg'), '#ffffff');
        eq('  기본 색 번호는 그대로', painted(tc).find((b) => b.text === '평범한 페이지')?.fg, COLORS[0]);
    }

    // 펼치기 (<details>/<summary>) — 그 자리에서 접고 편다
    {
        const inner = Array.from({ length: 30 }, (_, i) => `<p>숨은 ${i + 1}</p>`).join('');
        const html = `<h2>위</h2><details><summary>더 보기</summary>${inner}`
            + '<details open><summary>안쪽</summary><p>안쪽 내용</p></details></details><p>맨 아래 글</p>';
        const fold = 'https://example.com/fold';
        const tf = boot();
        visit(tf, fold, answerWith(fold, layoutHtml(html, fold, { mode: 'full' }).body));
        broadcast(tf, 'sig_paint');
        const lines = () => pageLines(tf).map((l, i) => ({ ...l, h: Number(tf.getList('ln_h')[i]) }));
        const L0 = lines();
        const sumLine = L0.find((l) => l.text.endsWith('더 보기'));
        eq('펼치기: 접힌 요약 줄은 ▶', sumLine?.text, '▶ 더 보기');
        chk('  접힌 묶음의 줄은 숨는다 (안쪽 묶음까지)', L0.filter((l) => /^숨은|안쪽/.test(l.text.trim())).every((l) => l.h === 1));
        chk('  숨은 줄은 그려지지 않는다', !painted(tf).some((b) => /숨은|안쪽 내용/.test(b.text)), painted(tf).map((b) => b.text).join(' / '));
        const bottomY = L0.find((l) => l.text === '맨 아래 글').y;
        chk('  아래 글이 요약 줄 바로 밑으로 당겨진다', bottomY < sumLine.y + 40, `${sumLine.y} → ${bottomY}`);
        const before = Number(tf.getVar('pg_h'));

        const box = painted(tf).find((b) => b.text === '▶ 더 보기');
        tf.mouse = { x: VIEW.left + 20, y: box.pos[1] };
        const s = sigs(tf, () => tf.runClick(box.name));
        chk('  요약 줄을 누르면 sig_fold', s.includes('sig_fold'), s.join(','));
        chk('  다시 요청하지 않는다', !s.includes('sig_go'));
        tf.runSignal('logic', 'sig_fold');             // 시뮬레이터는 신호를 받는 쪽을 따로 돌린다
        const L1 = lines();
        eq('  펼치면 ▼', L1.find((l) => l.text.endsWith('더 보기'))?.text, '▼ 더 보기');
        chk('  펼치면 속 줄이 보인다', L1.filter((l) => /^숨은/.test(l.text.trim())).every((l) => l.h === 0));
        chk('  안쪽 묶음은 원래대로 펼쳐져 있다', L1.find((l) => l.text === '안쪽 내용')?.h === 0);
        chk('  페이지가 길어진다', Number(tf.getVar('pg_h')) > before + 300, `${before} → ${tf.getVar('pg_h')}`);
        chk('  y 가 늘 커지는 순서 (이진 탐색이 된다)', L1.every((l, i) => !i || l.y >= L1[i - 1].y));
        broadcast(tf, 'sig_paint');
        chk('  펼친 줄이 그려진다', painted(tf).some((b) => b.text.trim() === '숨은 1'), painted(tf).map((b) => b.text).join(' / '));

        // 다시 접기 — 스크롤이 줄어든 페이지 끝을 넘지 않는다
        tf.setVar('sc', 0); tf.runFunc('rd_lay', 'logic'); broadcast(tf, 'sig_paint');
        tf.runClick(painted(tf).find((b) => /더 보기$/.test(b.text)).name);
        tf.setVar('sc', 500);                          // 펼친 채 내려가 있었다고 치고 접는다
        tf.runSignal('logic', 'sig_fold');
        eq('  다시 접으면 ▶', lines().find((l) => l.text.endsWith('더 보기'))?.text, '▶ 더 보기');
        eq('  페이지 높이가 돌아온다', tf.getVar('pg_h'), before);
        chk('  스크롤이 끝을 넘지 않는다', Number(tf.getVar('sc')) <= Number(tf.getVar('sc_max')));
        // 숨은 줄 자리에 마우스를 올려도 아무 줄도 고르지 않는다 (예외 없이)
        for (let y = VIEW.top; y >= VIEW.top - VIEW.h; y -= 3) {
            tf.mouse = { x: VIEW.left + 20, y };
            const e = safe(() => tf.runFunc('ms_tick', 'mouse'));
            if (e) { chk('  마우스 훑기', false, e); break; }
            const h = Number(tf.getVar('ms_h'));
            if (h && Number(tf.getList('ln_h')[h - 1]) === 1) { chk('  숨은 줄은 마우스에 안 걸린다', false, `줄 ${h}`); break; }
        }
    }

    // 글 수준 태그 — 엔트리는 한 줄에 한 모양이라 글자로 나타낸다
    {
        const h = '<base href="https://cdn.example.org/docs/"><picture><source srcset="a.webp"><img src="a.png" alt="고양이 사진"></picture>'
            + '<p><del>옛 값</del> 새 값 <q>인용</q> H<sub>2</sub>O x<sup>2</sup> 각주<sup><a href="/r">[1]</a></sup> <sup>note</sup></p>'
            + '<p><progress value="0.6"></progress> <meter value="30" min="0" max="40"></meter> <progress></progress></p>'
            + '<dialog open><p>열린 대화상자</p></dialog><dialog><p>닫힌 대화상자</p></dialog>'
            + '<p><a href="guide.html">상대 링크</a></p><img src="x" title="제목만 있는 그림">';
        const p = parseBody(layoutHtml(h, URL1, { mode: 'full' }).body);
        const all = p.lines.map((l) => l.text || '').join(' / ');
        chk('<picture> 속 그림의 대체 글', all.includes('[그림] 고양이 사진'), all);
        chk('대체 글이 없으면 title', all.includes('[그림] 제목만 있는 그림'));
        chk('<del> → ~~ ~~ · <q> → “ ”', all.includes('~~옛 값~~ 새 값 “인용”'));
        chk('<sub>·<sup> → 첨자 글자 (각주 링크·바꿀 수 없는 글자는 그대로)', all.includes('H₂O x² 각주 [1] note'), all);
        chk('<progress>·<meter> → 막대', all.includes('[■■■■■■□□□□] 60% [■■■■■■■■□□] 75% [진행 중]'));
        chk('열린 <dialog> 만 보인다', all.includes('열린 대화상자') && !all.includes('닫힌 대화상자'));
        chk('<base href> 기준으로 상대 링크', p.links.includes('https://cdn.example.org/docs/guide.html'), p.links.join(' '));
    }

    // 넓힌 글자 표 — 구두점·화살표·도형·자모·라틴-1 이 그대로 오는가
    const RICH = '• · — … “따옴표” → ▶ ■ ㄱㅏ é © 한글 ABC H₂O x² ⁿ 《책》 「인용」 Tōkyō λπ Жук € ₩ − ≤ ① ㈜ ㎡ の ✓ ★ 大韓民國 東京 樂';
    const t5 = boot();
    visit(t5, URL1, answerWith(URL1, layoutHtml(`<p>${RICH}</p>`, URL1, { mode: 'full' }).body));
    // 길어서 두 줄로 접힌다 — 공백에서 접히므로 이어 붙이면 원래 글
    chk(`넓힌 글자 표 왕복: ${RICH}`, pageLines(t5).map((l) => l.text).join(' ').includes(RICH),
        pageLines(t5).map((l) => l.text).join(' / '));
    {
        const wire = encodeResponse(1, URL1, layoutHtml('<p>大韓民國</p>', URL1, { mode: 'full' }).body, 2);
        chk('  한자는 번호 자리(U+E000~)로 보낸다', !Buffer.from(wire.split('|')[4], 'base64').toString('utf8').includes('大'));
        const fw = parseBody(layoutHtml('<p>（전각）～ ￦100 ﬁle</p>', URL1, { mode: 'full' }).body).lines.map((l) => l.text).join(' / ');
        chk('  전각·호환 글자는 바꿔 보낸다 (（）～ → ()~ · ￦ → ₩ · ﬁ → fi)', fw.includes('(전각)~ ₩100 file'), fw);
    }

    const t4 = boot();
    t4.setVar('nv_kind', 1); t4.setVar('nv_to', 'nope.html');
    t4.runSignal('logic', 'sig_go');
    chk('없는 로컬 페이지', pageLines(t4).some((l) => l.text === '찾을 수 없는 페이지'));
    chk('  그 이름을 보여 준다', pageLines(t4).some((l) => l.text.includes('nope.html')));

    for (const [typed, want] of [['example.org/x', 'https://example.org/x'], ['help.html', 'help.html'],
        ['http://a.test/', 'http://a.test/'], ['ko.wikipedia.org', 'https://ko.wikipedia.org']]) {
        t4.answer = typed;
        t4.runSignal('logic', 'sig_addr');
        eq(`주소 입력 '${typed}'`, t4.getVar('nv_to'), want);
    }
}

// ---------------------------------------------------------------------------
console.log('\n4-1. 양식 — 글 칸 · 체크박스 · 라디오 · 선택 상자 · 슬라이더 · 보내기');
// ---------------------------------------------------------------------------
{
    // 칸 번호 → 오브젝트 이름 (page.SLOTS 와 같은 순서)
    const slotName = [];
    for (const s of Object.keys(STYLES).map(Number).filter((x) => x > 0)) {
        for (let i = 0; i < STYLES[s].pool; i++) {
            slotName.push(s === 7 ? `rule${i}` : s === 8 ? `track${i}` : `t${STYLES[s].name}${i}`);
        }
    }
    /** 줄 li(1부터)가 보이게 스크롤하고, 그 줄을 그리는 오브젝트 이름 */
    const show = (t, li) => {
        const y = Number(t.getList('ln_y')[li - 1]);
        t.setVar('sc', Math.max(0, Math.min(Number(t.getVar('sc_max')), y - 40)));
        t.runFunc('rd_lay', 'logic');
        broadcast(t, 'sig_paint');
        const k = t.getList('rd_line').map(Number).indexOf(li);
        return k < 0 ? null : slotName[k];
    };
    const lineOfField = (t, f) => Number(t.getList('fm_line')[f - 1]);
    const click = (t, li) => { const n = show(t, li); t.mouse = { x: VIEW.left + 30, y: 0 }; return sigs(t, () => t.runClick(n)); };

    const t = boot();
    visit(t, URL1, answerWith(URL1, BODY));
    const want = parseBody(BODY, URL1);
    eq('양식 수', t.getVar('pg_nf'), want.forms.length);
    eq('칸 수', t.getVar('pg_ni'), want.fields.length);
    eq('선택지 수', t.getVar('pg_no'), want.options.length);
    const F = (name, type) => want.fields.findIndex((f) => f.name === name && (!type || f.type === type)) + 1;

    // 글 칸 — 누르면 sig_field, 값을 넣으면 그 줄에 보이고, 글 칸이 하나뿐이라 바로 보낸다
    const q = F('q');
    const s1 = click(t, lineOfField(t, q));
    chk('글 칸을 누르면 sig_field', s1.includes('sig_field'), s1.join(','));
    eq('  ui_field', t.getVar('ui_field'), q);
    setAnswer(t, 'hello 엔트리 & co');
    const s2 = sigs(t, () => t.runSignal('logic', 'sig_field'));
    eq('  값', t.getList('fm_val')[q - 1], 'hello 엔트리 & co');
    eq('  칸 줄에 보인다', t.getList('ln_t')[lineOfField(t, q) - 1], '  hello 엔트리 & co');
    chk('  글 칸 하나뿐인 양식 → 바로 보낸다', s2.includes('sig_go'), s2.join(','));
    eq('  보내는 주소', t.getVar('nv_to'),
        'https://example.com/search?q=hello+엔트리+%26+co&src=sample&sort=new&lang=ko&size=12');

    // 체크박스
    const ex = F('exact');
    click(t, lineOfField(t, ex));
    t.runSignal('logic', 'sig_field');
    eq('체크박스 켜짐', t.getList('fm_on')[ex - 1], 1);
    eq('  ■ 로 바뀐다', t.getList('ln_t')[lineOfField(t, ex) - 1], '  ■ 정확히 일치');
    // 라디오 — 오래된순을 켜면 최신순이 꺼진다
    const oldR = want.fields.findIndex((f) => f.name === 'sort' && f.value === 'old') + 1;
    const newR = want.fields.findIndex((f) => f.name === 'sort' && f.value === 'new') + 1;
    click(t, lineOfField(t, oldR));
    t.runSignal('logic', 'sig_field');
    eq('라디오: 오래된순 ●', t.getList('ln_t')[lineOfField(t, oldR) - 1], '  ● 오래된순');
    eq('  최신순 ○', t.getList('ln_t')[lineOfField(t, newR) - 1], '  ○ 최신순');
    // 선택 상자 — 누를 때마다 다음 선택지, 끝에서 처음으로
    const lang = F('lang');
    const labels = [];
    for (let i = 0; i < 3; i++) {
        click(t, lineOfField(t, lang));
        t.runSignal('logic', 'sig_field');
        labels.push(`${t.getList('fm_val')[lang - 1]}:${t.getList('ln_t')[lineOfField(t, lang) - 1].trim()}`);
    }
    eq('선택 상자 한 바퀴', labels.join(' / '), 'en:▾ English / ja:▾ 日本語 / ko:▾ 한국어');

    // 슬라이더 — 막대의 3/4 지점을 누른 채 끈다 → 8 + 0.75*(24-8) = 20
    const size = F('size');
    const rl = lineOfField(t, size);
    show(t, rl);
    const k = t.getList('rd_line').map(Number).indexOf(rl);
    chk('슬라이더 줄이 막대 칸에 배정됐다', slotName[k]?.startsWith('track'), slotName[k]);
    let n = 0;
    Object.defineProperty(t, 'mouseDown', { configurable: true, get: () => (n++ < 1) });
    t.mouse = { x: VIEW.left + 12 + 220 * 0.75, y: 0 };
    t.runClick(slotName[k]);
    eq('  끌면 값 = 20', t.getList('fm_val')[size - 1], 20);
    eq('  이름표 줄', t.getList('ln_t')[rl - 2], '글자 크기: 20');
    broadcast(t, 'sig_paint');
    const knob = `knob${slotName[k].slice(5)}`;
    eq('  손잡이 x', t.pos.get(knob)?.[0], VIEW.left + 12 + 220 * (20 - 8) / 16);
    t.mouse = { x: VIEW.left - 50, y: 0 };
    n = 0; t.runClick(knob);
    eq('  왼쪽 끝 밖으로 끌면 최소', t.getList('fm_val')[size - 1], 8);

    // 보내기 단추 — 체크박스·라디오·선택·슬라이더가 실린다
    const btn = want.fields.findIndex((f) => f.type === 's' && f.form === 1) + 1;
    click(t, lineOfField(t, btn));
    const s3 = sigs(t, () => t.runSignal('logic', 'sig_field'));
    chk('보내기 단추 → 이동', s3.includes('sig_go'));
    eq('  주소', t.getVar('nv_to'),
        'https://example.com/search?q=hello+엔트리+%26+co&src=sample&exact=1&sort=old&lang=ko&size=8');

    // POST 양식 — 칸은 쳐도 보내지 않는다 (단추는 모양 줄만 있고 칸이 아니다)
    const id = F('id');
    click(t, lineOfField(t, id));
    setAnswer(t, 'me');
    const s4 = sigs(t, () => t.runSignal('logic', 'sig_field'));
    chk('POST 양식은 보내지 않는다', !s4.includes('sig_go'), s4.join(','));
    chk('비밀번호 칸은 안내 줄', pageLines(t).some((l) => l.text.startsWith('(비밀번호 칸은 받지 않습니다')));

    // 마우스 — 칸 줄 위에서도 죽지 않고, 바탕이 밝아진다
    show(t, lineOfField(t, q));
    const errs = [];
    for (let my = VIEW.top; my >= VIEW.bottom; my -= 4) {
        t.mouse = { x: VIEW.left + 30, y: my };
        const e = safe(() => { t.runFunc('ms_tick', 'mouse'); broadcast(t, 'sig_hover'); });
        if (e) errs.push(`${my}: ${e}`);
    }
    chk('양식이 보이는 화면에서 마우스를 훑어도 예외 없음', errs.length === 0, errs.slice(0, 2).join('\n       '));

    // 스크롤 막대 — 아래 끝을 누른 채 → 맨 아래
    n = 0;
    t.mouse = { x: 0, y: -200 };
    t.runClick('sbar');
    eq('스크롤 막대 길 아래를 누르면 맨 아래', t.getVar('sc'), t.getVar('sc_max'));
    n = 0;
    t.mouse = { x: 0, y: 500 };
    t.runClick('thumb');
    eq('손잡이를 위로 끌면 맨 위', t.getVar('sc'), 0);
}

// ---------------------------------------------------------------------------
console.log('\n5. 큰 페이지 — 속도 (목표: 엔트리 쪽 처리 20초 안)');
// ---------------------------------------------------------------------------
{
    const para = '엔트리 블록 코딩 브라우저 시험 문단이다. Lorem ipsum dolor sit amet, 가나다라마바사 아자차카타파하. ';
    const html = `<h1>큰 페이지</h1>${Array.from({ length: 220 }, (_, i) => `<h3>절 ${i}</h3><p>${para.repeat(2)}<a href="https://example.com/${i}">링크 ${i}</a></p>`).join('')}`;
    const L2 = layoutHtml(html, 'https://example.com/big', { mode: 'full' });
    const t = boot();
    const t0 = Date.now();
    const r = visit(t, 'https://example.com/big', answerWith('https://example.com/big', L2.body));
    const ms = Date.now() - t0;
    eq('오류 없음', t.getVar('wb_err'), 0);
    eq(`줄 ${L2.lines}개 그대로`, pageLines(t).length, parseBody(L2.body).lines.filter((l) => l.style).length);
    const payload = encodeResponse(1, 'https://example.com/big', L2.body, 2).length;
    const sec = r.frames / 60;
    console.log(`       붙여넣기 ${payload.toLocaleString()}자, 반복 ${r.frames}프레임 ≈ ${sec.toFixed(1)}초 (재귀는 프레임 안에서 끝난다), 시뮬레이터 ${ms}ms, 최대 재귀 깊이 ${t.maxDepth}`);
    chk(`엔트리 쪽 처리 ≈ ${sec.toFixed(1)}초 < 20초`, sec < 20);
    chk('재귀 깊이가 한계(≈900) 아래', t.maxDepth < 800, `깊이 ${t.maxDepth}`);
}

console.log(pass ? '\n전체 통과' : '\n실패');
process.exit(pass ? 0 : 1);
