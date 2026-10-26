// src/lib/css.mjs — 렌더 모드가 적어 둔 계산된 CSS 를 줄 목록의 말(스타일·색 번호)로 옮긴다
//
// render.mjs 가 그려진 DOM 의 요소마다 **부모와 달라진 것만** data-eb 에 적는다:
//   c:#rrggbb  글자색          s:<px>   글꼴 크기       w:1|0   굵게(600 이상)
//   a:l|c|r    정렬            t:u      대문자로        f:m     고정폭 글꼴
//   b:#rrggbb  바탕 (부모의 바탕과 다를 때 — 물려받지 않는 속성이라 "가장 가까운 칠한 조상"을 쓴다)
// 페이지 바탕은 <html data-eb-page="#rrggbb">.
//
// 엔트리에 옮길 수 있는 것 — 줄마다 글자색 하나·바탕색 하나·스타일(글꼴 크기 6가지) 하나·
// 앞 공백(들여쓰기·정렬). 한 줄 안의 여러 색, 글꼴 종류, 겹친 층, 가로 배치는 못 옮긴다.

import { COLORS, BGS, CODES, S } from './display.mjs';

/** 텍스트 모드처럼 data-eb 가 없는 문서면 null */
export function baseLook(doc) {
    const page = doc.documentElement?.getAttribute('data-eb-page');
    if (!page) return null;
    return { color: '#000000', size: 16, bold: false, align: 'l', upper: false, mono: false, bg: page, page };
}

/** 요소의 data-eb 를 부모의 모양에 덧씌운다 */
export function readLook(el, parent) {
    const a = el.getAttribute('data-eb');
    if (!a) return parent;
    const o = { ...parent };
    for (const kv of a.split(';')) {
        const i = kv.indexOf(':');
        if (i < 1) continue;
        const k = kv.slice(0, i); const v = kv.slice(i + 1);
        if (k === 'c' && /^#[0-9a-f]{6}$/.test(v)) o.color = v;
        else if (k === 'b' && /^#[0-9a-f]{6}$/.test(v)) o.bg = v;
        else if (k === 's') o.size = Number(v) || o.size;
        else if (k === 'w') o.bold = v === '1';
        else if (k === 'a') o.align = v;
        else if (k === 't') o.upper = v === 'u';
        else if (k === 'f') o.mono = v === 'm';
    }
    return o;
}

/**
 * 글꼴 크기 → 스타일. 사이트의 px 와 엔트리의 px 는 다르다 — 엔트리 화면 폭(366)이 데스크톱
 * 페이지 폭의 반쯤이라 본문 16px 이 엔트리 본문(10px)이 된다. 그래서 크기를 **등급**으로 본다.
 */
export function styleOf(look, kind, chars) {
    const px = look.size;
    if (px >= 28) return S.h1;
    if (px >= 21) return S.h2;
    if (px >= 17.5) return S.h3;
    if (/^h[1-6]$/.test(kind)) return S.h3;                 // 제목 태그인데 작게 꾸민 것 (사이드바 제목)
    if (look.bold && px >= 15 && chars <= 60) return S.h3;  // 굵고 짧은 줄 = 제목 노릇 (카드 제목 등)
    if (px <= 13) return S.small;
    return S.body;
}

// ---------------------------------------------------------------- 색 계산
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')}`;
const lum = (h) => {
    const [r, g, b] = rgb(h).map((x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const dist = (a, b) => { const p = rgb(a); const q = rgb(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

/**
 * 바탕 위에서 읽히게. 사이트는 그림 위에 흰 글씨를 쓰는데 그림은 오지 않는다 — 그대로 두면
 * 흰 바탕에 흰 글이 된다. 대비가 모자라면 검정이나 흰색 쪽으로 조금씩 민다.
 */
export function readable(fg, bg, min = 3) {
    if (contrast(fg, bg) >= min) return fg;
    const to = lum(bg) > 0.4 ? [17, 24, 39] : [248, 250, 252];
    const c = rgb(fg);
    for (let t = 0.2; t <= 1.001; t += 0.2) {
        const m = toHex(c.map((x, i) => x + (to[i] - x) * t));
        if (contrast(m, bg) >= min) return m;
    }
    return toHex(to);
}

/**
 * 페이지 색표. 기본 색(COLORS·BGS) 뒤에 이 페이지의 색을 붙이고 한 글자 번호를 준다.
 * 거의 같은 색(차이 10 미만)은 하나로 — 번호는 62개뿐이다. 다 차면 가장 가까운 색.
 */
export function makePalette() {
    const fg = [...COLORS]; const bg = [...BGS];
    const pick = (list, h) => {
        let best = 0; let bd = Infinity;
        list.forEach((c, j) => { const d = dist(c, h); if (d < bd) { bd = d; best = j; } });
        if (bd < 10 || list.length >= CODES.length) return CODES[best];
        list.push(h);
        return CODES[list.length - 1];
    };
    return {
        fg: (h) => pick(fg, h),
        bg: (h) => pick(bg, h),
        /** 본문 앞에 실을 P/Q/G 줄 */
        lines: (page) => [
            ...fg.slice(COLORS.length).map((c) => `P${c}`),
            ...bg.slice(BGS.length).map((c) => `Q${c}`),
            ...(page && page !== '#ffffff' ? [`G${page}`] : []),
        ],
    };
}
