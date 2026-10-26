// src/program.mjs — Entry Browser 조립 지점 (블록 JSON 코드젠)
//
// 배치는 src/theme.mjs, 줄 목록 형식은 src/lib/display.mjs 가 정본이다.
// 여기서는 오브젝트를 **겹치는 순서대로** 만든다. ⚠ 먼저 만든 것이 앞(위)이다.
//
//   글상자 풀 (스타일마다) · 막대 · 주소 글자 · 아이콘 · 주소창 · 상태줄 · 툴바   ← 앞
//   본문 카드 · 띠의 판 · 창 바탕
//   logic (붓 — 띠의 격자를 그린다) · keys · mouse
//   무대 바닥                                                                  ← 뒤
//
// 붓 획은 **그 블록을 실행한 오브젝트의 층**에 그려진다. logic 은 띠의 판보다 뒤라서
// 쉴 때는 판이 격자 자리를 덮고, 요청할 때 판을 숨기면 격자가 드러난다.
//
// ⚠ 인덱스는 1-based. ⚠ 함수 매개변수를 쓰지 않는다 (전역 변수로 넘긴다).

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    defineProject, num, text, forever, ifDo, breakLoop, hideSelf, penClear, ask, answer,
} from '../tools/dsl.mjs';
import {
    C, FONT, MONO, VIEW, THUMB, THUMB_TOP,
    BX, BW, TY, TOOLBAR, SY, STATUS, CARD, BTN, PILL, PILL_W, PILL_X, BROWSER, STRIP,
} from './theme.mjs';
import { ICONS, PILL_PIC, CARD_PIC, THUMB_PIC, STRIP_PIC, TRACK_PIC, KNOB_PIC, SBAR_PIC, COVER, COVER_PIC } from './icons.mjs';
import { STYLES, S as ST, C as CO, B as BG, record, wrapRuns, VIEW_W, charW } from '../../src/lib/display.mjs';
import { layoutHtml } from '../../src/lib/layout.mjs';
import { rulerPage } from './ruler.mjs';

import * as pageMod from './page.mjs';
import * as gridMod from './grid.mjs';
import * as webMod from './web.mjs';
import * as formMod from './form.mjs';
import * as layMod from './lay.mjs';
import { LAYOUT_SIZES } from '../../src/lib/pager.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES = [webMod, gridMod, pageMod, formMod, layMod];      // formMod · layMod 는 page 가 안에서 짓는다 (spec 만 합친다)
const merge = (key) => MODULES.flatMap((m) => m.spec?.[key] || []);

const p = defineProject({
    variables: ['ui_modal', ...merge('variables')],
    lists: merge('lists'),
    signals: merge('signals'),
    functions: merge('functions'),
});

const {
    V, L, get, set, inc, listAdd, listPop, listGet, listLen, listSet,
    sendSignal, onStart, onSignal, onKey, onClick, defineFunction, call, sprite, textBox,
} = p;

const until = (exitCond, body) => forever([ifDo(exitCond, [breakLoop()]), ...body]);
const icon = (name, pic, x, y, visible = true) => sprite(name, { pictures: [pic], w: pic.width, x, y, visible });

// ---------------------------------------------------------------------------
// 작품 안의 페이지 — 빌드할 때 중계 앱과 **같은 배치 엔진**으로 줄 목록을 만든다
// ---------------------------------------------------------------------------
const PAGES_DIR = resolve(HERE, '..', 'pages');
const pageList = readdirSync(PAGES_DIR).filter((f) => f.endsWith('.html')).map((name) => ({
    name,
    body: layoutHtml(readFileSync(resolve(PAGES_DIR, name), 'utf8'), `entry://local/${name}`, { mode: 'full' }).body,
}));
// 글자 폭 확인 — HTML 로는 공백 개수를 못 맞춘다 (배치 엔진이 공백을 하나로 접는다). 줄 목록을 바로 만든다
pageList.push(rulerPage());
if (!pageList.some((x) => x.name === pageMod.HOME)) throw new Error(`pages/${pageMod.HOME} 이 없습니다 (시작 페이지)`);

// 없는 페이지 — 주소만 런타임에 끼운다 (머리 + 주소 + 꼬리)
const notFound = (() => {
    const head = ['T찾을 수 없는 페이지', 'Uindex.html',
        record(ST.h1, 0, 0, CO.head, BG.none, '찾을 수 없는 페이지'), record(ST.gap, 6, 0, 0, 0, ''),
        record(ST.mono, 0, 0, CO.code, BG.code, ' ')].join('\n');
    const tail = ['', record(ST.gap, 6, 0, 0, 0, ''),
        ...wrapRuns([{ text: '이 작품 안에 없는 페이지입니다. 웹 주소는 https:// 로 시작합니다.', link: 0 }], ST.body, VIEW_W)
            .map((l) => record(ST.body, 0, 0, CO.text, BG.none, l.text)),
        record(ST.gap, 8, 0, 0, 0, ''), record(ST.body, 0, 1, CO.link, BG.none, '시작 페이지로')].join('\n');
    return { head, tail };
})();

// ---------------------------------------------------------------------------
// 화면 (앞 → 뒤)
// ---------------------------------------------------------------------------
// 스타일마다 글상자 풀. 처음에는 숨어 있다 — 섬네일 몇 줄만 보인다.
// 섬네일은 글상자의 **처음 글자**라서 코드가 돌기 전에도 보인다.
const SPLASH = {
    [ST.h1]: [['Entry Browser', 30]],
    [ST.body]: [['엔트리 블록으로 만든 브라우저입니다.', 66], ['중계 앱과 함께 쓰면 진짜 웹 페이지를 봅니다.', 82],
        ['▶  시작하기를 누르세요', 118]],
    [ST.small]: [['실험용 · 중계 앱은 화면을 캡처하고 클립보드를 씁니다', 170]],
};
const SPLASH_COLOR = { [ST.h1]: C.head, [ST.body]: C.text, [ST.small]: C.dim };

// 표지 — 작품 섬네일. **맨 앞**에서 무대를 덮고, 시작하면 숨는다 (아래 onStart).
// 엔트리는 작품을 저장할 때 무대를 찍어 섬네일로 쓴다. 그림(COVER_PIC)은 도형만, 글은 글상자가 얹는다.
// 자리는 표지 SVG 좌표(왼쪽 위 0,0)로 적고 무대 좌표(가운데 0,0)로 바꾼다.
const coverText = (name, text, { x, y, size, color, align = 1, w }) => {
    // 폭은 실측 글자 폭(맑은 고딕)으로 재서 넉넉히 — 넘치면 줄이 바뀌어 사라진다
    const need = [...text].reduce((a, ch) => a + charW(ch, false, 'malgun'), 0) * size * 1.12 + 6;
    const width = Math.max(w || 0, Math.ceil(need));
    const left = align === 0 ? x - width / 2 : x;
    return textBox(name, {
        x: left + width / 2 - COVER.W / 2, y: COVER.H / 2 - y, w: width, h: Math.round(size * 1.7),
        size, font: FONT, align, color, bgColor: 'transparent', text,
    });
};
const cover = [
    coverText('cover_badge', '실험용 프로젝트', { x: COVER.badge.x + COVER.badge.w / 2, y: COVER.badge.y + COVER.badge.h / 2, size: 9, color: '#fcd34d', align: 0 }),
    coverText('cover_title', 'Entry Browser', { x: 56, y: 84, size: 27, color: '#f8fafc' }),
    coverText('cover_sub1', '엔트리 블록으로 만든', { x: 58, y: 117, size: 12, color: '#cbd5e1' }),
    coverText('cover_sub2', '진짜 웹을 읽는 텍스트 브라우저', { x: 58, y: 135, size: 12, color: '#cbd5e1' }),
    coverText('cover_feat', '링크 · 양식 · 펼치기 · 한자 · 렌더 모드', { x: 58, y: 163, size: 9, color: '#94a3b8' }),
    coverText('cover_cta', '시작하기', { x: COVER.cta.x + COVER.cta.w / 2 + 8, y: COVER.cta.y + COVER.cta.h / 2, size: 12, color: '#052e16', align: 0 }),
    coverText('cover_foot', '중계 앱이 필요합니다  ·  smilepark2013-lang.github.io/entry-browser', { x: 58, y: 252, size: 8, color: '#64748b' }),
    icon('cover', COVER_PIC, 0, 0),
];

// 스크롤 막대가 맨 앞 — 여분 글상자(조각)는 카드 오른쪽 밖까지 뻗는 투명 상자라, 막대보다 앞에 오면 끌기를 가로챈다
const thumb = icon('thumb', THUMB_PIC, THUMB.x, THUMB_TOP, false);
const sbar = icon('sbar', SBAR_PIC, THUMB.x, VIEW.top - VIEW.h / 2, false);   // 손잡이 뒤

// 여분 글상자 — 줄 글상자보다 앞 (문단 속 링크 조각을 그 줄 위에 얹는다). 바탕은 투명
const ovl = {};
for (const s of Object.keys(STYLES).map(Number)) {
    const st = STYLES[s];
    if (!st.ovl) continue;
    ovl[s] = Array.from({ length: st.ovl }, (_, i) => textBox(`o${st.name}${i}`, {
        x: VIEW.left + VIEW.w / 2, y: VIEW.top - st.lh / 2, w: VIEW.w, h: st.lh, visible: false,
        size: st.size, font: st.font === 'mono' ? MONO : FONT, align: 1, color: C.text, bgColor: 'transparent', text: '',
    }));
}

const pools = {};
let knobs = [];
for (const s of Object.keys(STYLES).map(Number).filter((n) => n > 0)) {
    const st = STYLES[s];
    if (s === ST.range) {
        // 슬라이더 — 손잡이를 먼저 만들어야 막대보다 앞에 온다
        knobs = Array.from({ length: st.pool }, (_, i) => icon(`knob${i}`, KNOB_PIC, VIEW.left, VIEW.top, false));
        pools[s] = Array.from({ length: st.pool }, (_, i) => icon(`track${i}`, TRACK_PIC, VIEW.left, VIEW.top, false));
        continue;
    }
    pools[s] = Array.from({ length: st.pool }, (_, i) => {
        const splash = SPLASH[s]?.[i];
        const y = splash ? VIEW.top - splash[1] - st.lh / 2 : VIEW.top - st.lh / 2;
        if (s === ST.rule) {
            return textBox(`rule${i}`, {
                x: VIEW.left + VIEW.w / 2, y, w: VIEW.w, h: 1, visible: false,
                size: 1, font: FONT, color: C.line, bgColor: C.line, text: '',
            });
        }
        return textBox(`t${st.name}${i}`, {
            x: VIEW.left + VIEW.w / 2, y, w: VIEW.w, h: st.lh, visible: !!splash,
            size: st.size, font: st.font === 'mono' ? MONO : FONT, align: 1,
            color: (splash && SPLASH_COLOR[s]) || C.text, bgColor: C.card,
            text: splash ? splash[0] : '',
        });
    });
}

// 레이아웃 모드 — 글 크기 단계마다 원본 글상자 하나 (자신을 복제해 조각을 찍는다). 그 뒤에 화가(붓)
// 화가는 카드·페이지 바탕보다 앞, 글 원본보다 뒤 — 그래서 상자·그림이 글 밑에 깔린다
const layText = LAYOUT_SIZES.map((size, k) => textBox(`lt${size}`, {
    x: VIEW.left + VIEW.w / 2, y: VIEW.top - layMod.LAY_LINE_H[k] / 2, w: VIEW.w, h: layMod.LAY_LINE_H[k], visible: false,
    size, font: FONT, align: 1, color: C.text, bgColor: 'transparent', text: '',
}));
const painter = sprite('painter', { visible: false });

const url = textBox('url', {
    x: PILL_X + 10, y: TY, w: PILL_W - 36, h: 14,
    size: 9, font: FONT, align: 1, color: C.url, bgColor: 'transparent', text: '시작 페이지',
});

const btn = {
    globe: icon('ic_globe', ICONS.globe, PILL.left + 13, TY),
    back: icon('ic_back', ICONS.back, BTN.back, TY),
    fwd: icon('ic_fwd', ICONS.fwd, BTN.fwd, TY),
    reload: icon('ic_reload', ICONS.reload, BTN.reload, TY),
    home: icon('ic_home', ICONS.home, BTN.home, TY),
    up: icon('ic_up', ICONS.up, BROWSER.right - 34, SY),
    down: icon('ic_down', ICONS.down, BROWSER.right - 14, SY),
};

const pill = icon('omnibox', PILL_PIC, PILL_X, TY);

const status = textBox('status', {
    x: BX, y: SY, w: BW, h: STATUS.h,
    size: 9, font: FONT, align: 1, color: C.dim, bgColor: C.status, text: '  준비',
});

textBox('toolbar', { x: BX, y: TY, w: BW, h: TOOLBAR.h, size: 9, font: FONT, color: C.bar, bgColor: C.bar, text: '' });
textBox('tb_line', { x: BX, y: TOOLBAR.top - TOOLBAR.h, w: BW, h: 1, size: 1, font: FONT, color: C.line, bgColor: C.line, text: '' });

// 페이지 바탕 — 카드 위, 글상자 뒤. 렌더 모드가 사이트의 바탕색(G 줄)을 보내면 이 상자를 칠한다.
// 글상자는 런타임에 크기를 못 바꾸므로 처음부터 카드만 하게 만든다 (둥근 모서리만큼 안쪽으로).
const pagebg = textBox('pagebg', {
    x: (CARD.left + CARD.right) / 2, y: (CARD.top + CARD.bottom) / 2, w: CARD.right - CARD.left - 8, h: CARD.top - CARD.bottom - 8,
    size: 9, font: FONT, color: C.card, bgColor: C.card, text: '',
});
icon('card', CARD_PIC, (CARD.left + CARD.right) / 2, (CARD.top + CARD.bottom) / 2);
const strip = icon('strip', STRIP_PIC, STRIP.X0 + STRIP.WIDTH / 2, 0);

textBox('frame', { x: BX, y: 0, w: BW, h: 270, size: 9, font: FONT, color: C.frame, bgColor: C.frame, text: '' });

const logic = sprite('logic', { visible: false });
const keys = sprite('keys', { visible: false });
const mouse = sprite('mouse', { visible: false });

textBox('stage', { x: 0, y: 0, w: 480, h: 270, size: 9, font: FONT, color: C.stage, bgColor: C.stage, text: '' });

// ---------------------------------------------------------------------------
// 모듈
// ---------------------------------------------------------------------------
const ui = { pools, ovl, knobs, thumb, sbar, url, btn, pill, status, strip, keys, mouse, pagebg, layText, painter };

const ctx = {
    V, L, get, set, inc, listAdd, listPop, listGet, listLen, listSet,
    until, defineFunction, call, onSignal, onKey, onClick, onStart, sendSignal, ask, answer,
    status: (msg) => [set(V.ui_msg, typeof msg === 'string' ? text(msg) : msg), sendSignal('sig_status')],
    logic, ui,
    pages: { list: pageList, notFoundHead: notFound.head, notFoundTail: notFound.tail },
};
const web = webMod.build(ctx);
const grid = gridMod.build(ctx);
const page = pageMod.build({ ...ctx, web });

onStart(logic, [
    hideSelf(),
    penClear(),
    set(V.ui_modal, num(0)),
    ...web.init, ...grid.init, ...page.init,
    ...page.start,
]);
onStart(keys, [hideSelf()]);
for (const o of cover) onStart(o, [hideSelf()]);       // 표지는 시작하면 바로 숨는다

export default p;
export const SLOTS = pageMod.SLOTS;
