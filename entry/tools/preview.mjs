// tools/preview.mjs — 엔트리 없이 화면을 보는 미리보기 (build.mjs 가 부른다)
//
//   → entry/build/preview.html
//
// 손으로 그린 시안이 아니다. **만들어진 project.json 을 시뮬레이터로 돌려서** 오브젝트마다
// 마지막으로 쓴 글·색·자리를 그대로 옮긴다. 그래서 여기 보이는 것이 곧 블록이 하는 일이다.
// (글꼴 렌더링과 엔트리의 글상자 줄 높이까지 같지는 않다 — 배치와 색을 보는 용도다)
//
// 세 장면: 섬네일(시작 전) · 페이지(시작 페이지, 링크 줄에 마우스) · 요청 중(띠에 격자)

import { Sim } from './simulate.mjs';
import { MARKER } from '../../src/lib/snapcodec.mjs';
import { encodeResponse } from '../../src/lib/payload.mjs';
import { layoutHtml } from '../../src/lib/layout.mjs';

const cloneView = (sim) => ({
    shown: new Map(sim.shown), wrote: new Map(sim.wrote), fg: new Map(sim.fg), bg: new Map(sim.bg), pos: new Map(sim.pos),
    clones: sim.clones.map((c) => ({ ...c })), effect: new Map([...sim.effect].map(([k, v]) => [k, new Set(v)])),
});

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function snapshot(project, sim, strokes = []) {
    return { objects: project.objects, sim, strokes };
}

function renderStage({ objects, sim, strokes }, assets) {
    const svgOf = new Map(assets.map((a) => [a.path, a.data]));
    let html = '';
    // 붓 획은 그린 오브젝트의 층에 (주인 기록이 없으면 logic)
    const strokesOf = (name) => strokes.filter((s) => (s.owner || 'logic') === name);
    const textDiv = (e, x, y, text, fg, bg, bold) => {
        const align = ['center', 'left', 'right'][e.textAlign] || 'left';
        return `<div class="tb" style="left:${240 + x - e.width / 2}px;top:${135 - y - e.height / 2}px;`
            + `width:${e.width}px;height:${e.height}px;line-height:${e.height}px;background:${bg};color:${fg};`
            + `font-size:${e.fontSize}px;text-align:${align}${bold ? ';font-weight:700' : ''}">${esc(text)}</div>`;
    };
    // 뒤(배열 끝)부터 그린다 — 먼저 만든 것이 앞이다
    for (const o of [...objects].reverse()) {
        const e = o.entity;
        const name = o.name;
        // 복제본 — 원본 바로 뒤 층 (원본보다 먼저 그린다)
        for (const c of (sim?.clones || []).filter((k) => k.of === name)) {
            if (!c.shown || !c.pos) continue;
            html += textDiv(e, c.pos[0], c.pos[1], c.wrote ?? e.text, c.fg || e.colour, c.bg || e.bgColor, c.effect?.has('fontBold'));
        }
        // 표지(cover*)는 시작하면 스스로 숨는다 — 시뮬레이터는 logic 의 시작만 돌리므로 여기서 숨긴다
        const shown = sim ? (name.startsWith('cover') ? false : sim.shown.has(name) ? sim.shown.get(name) : e.visible) : e.visible;
        if (!shown) {
            html += strokeLayer(strokesOf(name));       // 숨은 오브젝트라도 붓 획은 보인다
            continue;
        }
        const [x, y] = (sim && sim.pos.get(name)) ? sim.pos.get(name) : [e.x, e.y];   // 글상자도 옮겨진다 (풀)
        if (o.objectType === 'textBox') {
            const text = sim && sim.wrote.has(name) ? sim.wrote.get(name) : e.text;
            const fg = (sim && sim.fg.get(name)) || e.colour;
            const bg = (sim && sim.bg.get(name)) || e.bgColor;
            const align = ['center', 'left', 'right'][e.textAlign] || 'left';
            html += `<div class="tb" style="left:${240 + x - e.width / 2}px;top:${135 - y - e.height / 2}px;`
                + `width:${e.width}px;height:${e.height}px;line-height:${e.height}px;background:${bg};color:${fg};`
                + `font-size:${e.fontSize}px;text-align:${align}">${esc(text)}</div>`;
        } else {
            const pic = o.sprite.pictures[0];
            const svg = svgOf.get(pic.fileurl);
            if (!svg) continue;
            const w = e.width * e.scaleX; const h = e.height * e.scaleY;
            html += `<img class="sp" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"`
                + ` style="left:${240 + x - w / 2}px;top:${135 - y - h / 2}px;width:${w}px;height:${h}px">`;
        }
        html += strokeLayer(strokesOf(name));
    }
    return html;
}

function strokeLayer(strokes) {
    return strokes.map((s) => {
        const x0 = Math.min(s.x0, s.x1); const x1 = Math.max(s.x0, s.x1);
        return `<div class="tb" style="left:${240 + x0}px;top:${135 - s.y0 - s.size / 2}px;width:${x1 - x0}px;`
            + `height:${s.size}px;background:${s.color}"></div>`;
    }).join('');
}

const display = (project) => project.objects.filter((o) => {
    const t = JSON.parse(o.script);
    return t.some((th) => th[0].type === 'when_message_cast');
}).map((o) => o.name);

function runDisplays(project, sim, signals) {
    for (const name of display(project)) {
        for (const s of signals) {
            try { sim.runSignal(name, s); } catch (e) { if (!/스레드 없음/.test(e.message)) throw e; }
        }
    }
}

export function previewHtml(project, assets, sample = null) {
    const scenes = [];

    // 1. 섬네일 — 아무 블록도 안 돈 상태
    scenes.push(['시작 전 (섬네일)', snapshot(project, null)]);

    // 2. 시작 페이지 + 링크 줄에 마우스
    const sim = new Sim(project);
    sim.runStart('logic');
    sim.runSignal('logic', 'sig_go');
    const n = Number(sim.getVar('pg_n'));
    const k = sim.getList('ln_l').slice(0, n).map(Number).findIndex((x) => x > 0);
    sim.setVar('ui_hov', k + 1);
    runDisplays(project, sim, ['sig_paint', 'sig_status', 'sig_strip']);
    scenes.push(['페이지 (링크 줄에 마우스)', snapshot(project, sim)]);

    // 3. 요청 중 — 입력창이 열리는 순간을 잡는다
    const sim2 = new Sim(project);
    sim2.runStart('logic');
    sim2.runSignal('logic', 'sig_go');
    runDisplays(project, sim2, ['sig_paint', 'sig_status', 'sig_strip']);
    let frozen = null;
    Object.defineProperty(sim2, 'answer', {
        configurable: true,
        get() {
            runDisplays(project, sim2, ['sig_status', 'sig_strip']);
            frozen = snapshot(project, {
                shown: new Map(sim2.shown), wrote: new Map(sim2.wrote), fg: new Map(sim2.fg),
                bg: new Map(sim2.bg), pos: new Map(sim2.pos),
            }, [...sim2.log.pen]);
            return '';
        },
    });
    sim2.setVar('nv_kind', 1);
    sim2.setVar('nv_to', 'https://ko.wikipedia.org/wiki/엔트리');
    sim2.runSignal('logic', 'sig_go');
    if (frozen) scenes.push(['요청 중 (왼쪽 띠에 격자 · 아래에 입력창)', frozen]);

    // 4·5. 웹 페이지 예시 — 중계 앱의 배치 엔진이 만든 줄 목록을 붙여넣은 결과 (fixtures/sample.html)
    if (sample) {
        const url = 'https://example.com/intro';
        const sim3 = new Sim(project);
        sim3.runStart('logic');
        sim3.runSignal('logic', 'sig_go');
        Object.defineProperty(sim3, 'answer', {
            configurable: true,
            get() { return encodeResponse(Number(sim3.getVar('wb_seq')), url, layoutHtml(sample, url, { mode: 'full' }).body, 2); },
        });
        sim3.setVar('nv_kind', 1);
        sim3.setVar('nv_to', url);
        sim3.runSignal('logic', 'sig_go');
        runDisplays(project, sim3, ['sig_paint', 'sig_status', 'sig_strip']);
        scenes.push(['웹 페이지 예시 (제목 · 문단 · 목록)', snapshot(project, cloneView(sim3))]);
        sim3.setVar('sc', Math.min(Number(sim3.getVar('sc_max')), 300));
        sim3.runFunc('rd_lay', 'logic');
        runDisplays(project, sim3, ['sig_paint']);
        scenes.push(['웹 페이지 예시 — 아래로 (표 · 인용 · 코드)', snapshot(project, cloneView(sim3))]);
        // 양식 — 검색칸 · 체크박스 · 라디오 · 선택 상자 · 슬라이더 · 단추
        const n3 = Number(sim3.getVar('pg_n'));
        const fi = sim3.getList('ln_t').slice(0, n3).findIndex((t) => String(t) === '검색해 보기');
        if (fi >= 0) {
            sim3.setVar('sc', Math.min(Number(sim3.getVar('sc_max')), Number(sim3.getList('ln_y')[fi]) - 6));
            sim3.runFunc('rd_lay', 'logic');
            runDisplays(project, sim3, ['sig_paint']);
            scenes.push(['웹 페이지 예시 — 양식 (검색칸 · 체크박스 · 라디오 · 선택 · 슬라이더 · 단추)', snapshot(project, cloneView(sim3))]);
        }
    }

    return wrap(scenes.map(([title, snap], i) => `
<section>
  <h2>${esc(title)}</h2>
  <div class="frame"><div class="stage">${renderStage(snap, assets)}${i === 2 ? askBar() : ''}</div></div>
</section>`).join(''));
}

/**
 * 받은 줄 목록을 그대로 붙여넣은 화면 — 실제 사이트를 중계 앱으로 받아 비교할 때 (tools/shot.mjs)
 * @param pages [{ title, url, body }]  body 는 중계 앱이 만든 줄 목록 (layoutHtml().body)
 */
export function pagesPreviewHtml(project, assets, pages, { scrolls = [0, 200], bare = false } = {}) {
    const scenes = [];
    for (const pg of pages) {
        const sim = new Sim(project);
        sim.runStart('logic');
        sim.runSignal('logic', 'sig_go');
        Object.defineProperty(sim, 'answer', {
            configurable: true,
            get() { return encodeResponse(Number(sim.getVar('wb_seq')), pg.url, pg.body, 2); },
        });
        sim.setVar('nv_kind', 1);
        sim.setVar('nv_to', pg.url);
        sim.runSignal('logic', 'sig_go');
        const lay = Number(sim.getVar('pg_lay')) === 1;
        for (const y of (lay ? (pg.screens || [0, 1]) : scrolls)) {
            sim.setVar('sc', Math.min(Number(sim.getVar('sc_max')), y));
            sim.runFunc('rd_lay', 'logic');
            // 레이아웃 모드면 쪽을 그린다 (화가의 붓 + 글 원본의 복제본)
            runDisplays(project, sim, ['sig_paint', 'sig_status', 'sig_strip', 'sig_lay']);
            const label = lay ? ` — ${y + 1} / ${sim.getVar('ly_n')}쪽` : (y ? ` — 아래로 ${y}px` : '');
            scenes.push([`${pg.title}${label}`, snapshot(project, cloneView(sim), [...sim.log.pen])]);
        }
    }
    return wrap(scenes.map(([title, snap]) => `
<section>
  <h2>${esc(title)}</h2>
  <div class="frame"><div class="stage">${renderStage(snap, assets)}</div></div>
</section>`).join(''), bare);
}

/** bare: 머리말·여백 없이 화면만 (스크린샷용 — 창 폭 960 에 한 장씩) */
function wrap(body, bare = false) {
    return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Entry Browser 미리보기</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nanum+Gothic&display=swap">
<style>
:root { --bg: #f1f5f9; --fg: #0f172a; --dim: #64748b; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #0b1120; --fg: #e2e8f0; --dim: #94a3b8; } }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, "Nanum Gothic", sans-serif; }
h1 { font-size: 18px; margin: 0 0 4px; } p { color: var(--dim); margin: 0 0 24px; }
h2 { font-size: 13px; font-weight: 600; color: var(--dim); margin: 0 0 8px; }
section { margin-bottom: 28px; }
.frame { width: 100%; max-width: 960px; aspect-ratio: 16 / 9; position: relative; overflow: hidden; border-radius: 10px; box-shadow: 0 10px 30px rgba(15,23,42,.18); }
.stage { position: absolute; left: 0; top: 0; width: 480px; height: 270px; transform-origin: 0 0; background: #fff; overflow: hidden; font-family: "Malgun Gothic", "Nanum Gothic", sans-serif; }   /* 엔트리는 '나눔고딕' 을 못 찾아 맑은 고딕으로 그린다 (실기) */
.tb, .sp { position: absolute; white-space: pre; overflow: hidden; box-sizing: border-box; }
.ask { position: absolute; left: 6px; right: 6px; bottom: 6px; height: 22px; border-radius: 4px; background: rgba(255,255,255,.95); border: 1px solid #94a3b8; font-size: 9px; color: #64748b; padding: 0 8px; line-height: 20px; }
</style></head><body>
${bare ? '<style>body{padding:0!important}section{margin:0!important}h1,p,h2{display:none!important}.frame{border-radius:0!important;box-shadow:none!important}</style>' : ''}
<h1>Entry Browser 미리보기</h1>
<p>빌드한 블록을 시뮬레이터로 돌려 얻은 화면입니다. 배치와 색을 보는 용도이며, 글꼴과 줄 높이는 엔트리와 조금 다를 수 있습니다.</p>
${body}
<script>
const fit = () => document.querySelectorAll('.frame').forEach((f) => {
  f.firstElementChild.style.transform = 'scale(' + (f.clientWidth / 480) + ')';
});
addEventListener('resize', fit); fit();
</script>
</body></html>`;
}

// 입력창 자리 (엔트리가 그리는 것이라 블록에는 없다 — 대략의 모양만)
const askBar = () => '<div class="ask">중계 앱이 복사한 응답을 붙여넣고 Enter (빈 칸 = 취소)</div>';
