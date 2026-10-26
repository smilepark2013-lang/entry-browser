// src/lib/pager.mjs — 레이아웃 모드: Chromium 이 배치한 그리기 목록 → 쪽별 줄 (EBR2 본문)
//
// 줄 목록(layout.mjs)은 페이지를 위에서 아래로 흐르는 문서로 **다시 짠다**. 레이아웃 모드는 다시 짜지 않는다 —
// 렌더 모드의 Chromium 이 실제로 놓은 자리(상자·글 조각·그림)를 그대로 엔트리 좌표로 옮긴다.
// 그래서 가로 메뉴, 여러 열, 버튼, 카드가 원래 자리에 나온다.
//
// 엔트리는 스크롤하지 않고 **쪽을 넘긴다** (화면 한 장 = 본문 366×206). 쪽을 넘길 때만 복제본을 지우고
// 다시 찍고 붓으로 다시 그린다 — 스크롤마다 수백 개를 다시 그리면 너무 느리다.
//
// 입력 (render.mjs 의 LAYOUT 이 만든다. 단위는 CSS px, 페이지 왼쪽 위가 0,0):
//   { width, height, page: '#rrggbb', boxes: [{x,y,w,h,c}], texts: [{x,y,w,h,t,s,c,b,href}],
//     images: [{x,y,w,h, px?: {cols, rows, cells: ['#rrggbb', ...]}}] }
//
// 출력 줄 (display.mjs 머리말에도 적었다):
//   M<쪽 수>
//   X<SSS><XXX><YYY><WWW><HHH><C>                 상자 — 쪽 · x · y(쪽 안) · 폭 · 높이 · 색 번호
//   Z<SSS><XXX><YYY><WWW><K><C><B><LLLL><글>       글 조각 — … · 크기 단계(LAYOUT_SIZES 의 자리) · 색 · 굵게(0/1) · 링크
//   J<SSS><XXX><YYY><N><CC><색·길이 쌍…>            그림 — … · 칸 크기 px(1~9) · 열 수 · 같은 색이 이어지는 칸 (색 번호, 길이 1~61)

import { VIEW_W, VIEW_H, CODES, COLORS, MAX_LINKS, richText, charW } from './display.mjs';
import { makePalette, readable, contrast } from './css.mjs';
import { makeLinker } from './layout.mjs';
import { entryChars as entryCharsBase } from './simplify.mjs';

/** 글 크기 단계 (엔트리 px). 엔트리 쪽은 단계마다 원본 글상자 하나를 두고 복제한다 */
export const LAYOUT_SIZES = [7, 8, 9, 10, 11, 12, 14, 17, 20, 24, 28];
/** 원본 글상자 높이 (엔트리 쪽 lay.mjs 가 같은 값을 쓴다). 조각의 세로 가운데를 이 상자 가운데에 맞춘다 */
export const LAY_LINE_H = LAYOUT_SIZES.map((s) => Math.round(s * 1.5));
export const LAYOUT_LIMITS = {
    texts: 4000, boxes: 4000, images: 60,        // 엔트리 리스트 5000항목 안쪽
    textsPerScreen: 300,                          // 원본 하나당 복제본 360개 한도 안쪽 (여유)
    boxesPerScreen: 400,
    cellsPerScreen: 6000,                         // 그림 칸 (붓 획 수의 위쪽 한도)
    screens: 40,
};
const MAX_BODY = 120_000;

const entryChars = (s) => entryCharsBase(s, { rich: true });
/** 맑은 고딕으로 그릴 때의 폭 (엔트리 px) */
const widthAt = (s, size) => [...s].reduce((a, ch) => a + charW(ch, false, 'malgun'), 0) * size;
const p = (n, w) => String(Math.max(0, Math.min(10 ** w - 1, Math.round(n)))).padStart(w, '0');

/** 크기 → 단계 번호 (내림 — 맑은 고딕으로 그리므로 크면 넘친다) */
export function sizeCode(px) {
    let best = 0;
    LAYOUT_SIZES.forEach((s, i) => { if (s <= px + 0.25) best = i; });
    return best;
}

/**
 * 쪽 나누기 — 화면 높이 단위로 자르되 글줄을 가르지 않는 자리에서 끊는다.
 * @returns 쪽 경계 y 목록 [0, y1, y2, ..., total]
 */
export function screenBreaks(texts, total, H = VIEW_H) {
    const breaks = [0];
    let s = 0;
    while (s < total - 1 && breaks.length <= LAYOUT_LIMITS.screens) {
        let y = s + H;
        if (y >= total) { breaks.push(total); break; }
        for (let guard = 0; guard < 50; guard++) {
            const cut = texts.filter((t) => t.y < y - 0.5 && t.y + t.h > y + 0.5);
            if (!cut.length) break;
            const top = Math.min(...cut.map((t) => t.y));
            if (top <= s + H * 0.5) { y = s + H; break; }     // 너무 거슬러 올라가면 그냥 자른다
            y = top;
        }
        breaks.push(y);
        s = y;
    }
    return breaks;
}

/** 몇 가지 색으로 줄이기 (median cut) */
function quantize(colors, n) {
    const rgb = colors.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
    let boxes = [rgb];
    while (boxes.length < n) {
        let bi = -1; let range = -1; let ch = 0;
        boxes.forEach((b, i) => {
            if (b.length < 2) return;
            for (let c = 0; c < 3; c++) {
                const vs = b.map((v) => v[c]);
                const r = Math.max(...vs) - Math.min(...vs);
                if (r > range) { range = r; bi = i; ch = c; }
            }
        });
        if (bi < 0 || range < 8) break;
        const b = boxes[bi].sort((a, z) => a[ch] - z[ch]);
        boxes.splice(bi, 1, b.slice(0, b.length >> 1), b.slice(b.length >> 1));
    }
    const centers = boxes.map((b) => [0, 1, 2].map((c) => b.reduce((a, v) => a + v[c], 0) / b.length));
    const toHex = (v) => `#${v.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
    return rgb.map((v) => {
        let best = 0; let bd = Infinity;
        centers.forEach((c, i) => { const d = (c[0] - v[0]) ** 2 + (c[1] - v[1]) ** 2 + (c[2] - v[2]) ** 2; if (d < bd) { bd = d; best = i; } });
        return toHex(centers[best]);
    });
}

/**
 * @param list   render.mjs LAYOUT 의 결과 (CSS px)
 * @param url    최종 주소 (링크 기준)
 * @returns {{ body, screens, texts, boxes, images, truncated }}
 */
export function pageLayout(list, url, { title = '', images: imageMode = 'pixel' } = {}) {
    const k = VIEW_W / list.width;
    const pal = makePalette();
    const page = list.page || '#ffffff';
    const { links, linkOf } = makeLinker(url);

    // ---- 엔트리 px 로
    const S = (v) => v * k;
    // 1px 테두리는 0.61배로 줄면 사라졌다 (덕덕고 검색창) — 원래 0.5px 이상이면 최소 1px 로 남긴다
    const boxes = list.boxes.map((b) => ({ x: S(b.x), y: S(b.y), w: b.w >= 0.5 ? Math.max(1, S(b.w)) : 0, h: b.h >= 0.5 ? Math.max(1, S(b.h)) : 0, c: b.c }))
        .filter((b) => b.w >= 0.8 && b.h >= 0.8 && b.x < VIEW_W);
    // 그리는 순서 — 큰 상자가 뒤 (붓은 나중 획이 위에 온다). 문서 순서대로 그렸더니 음수 z-index 로 뒤에 깔린
    // 거대한 배경(깃허브의 검은 바탕)이 앞의 흰 띠를 덮었다. 넓은 배경은 대개 작은 카드·띠 뒤에 있다.
    boxes.sort((a, b) => b.w * b.h - a.w * a.h);
    const texts = [];
    for (const t of list.texts) {
        const text = richText(entryChars(String(t.t))).replace(/[\t\r\n]+/g, ' ').trim();
        if (!text) continue;
        if (t.x < -2 || t.x > list.width - 4) continue;              // 화면 밖
        const s = sizeCode(S(t.s));
        // 오른쪽으로 넘치는 글은 자른다 (맑은 고딕 실측 폭) — 글상자는 카드 밖까지 그려진다
        let shown = text; const room = VIEW_W - Math.max(0, S(t.x));
        while (shown.length > 1 && widthAt(shown, LAYOUT_SIZES[s]) > room) shown = shown.slice(0, -1);
        texts.push({ x: Math.max(0, S(t.x)), y: S(t.y), w: Math.min(S(t.w), room), h: S(t.h), t: shown.trimEnd(), s, c: t.c, b: t.b ? 1 : 0, href: t.href });
    }
    // 그림 — 'pixel' 이면 칸으로 줄인 그림, 'alt' 이거나 칸이 없으면 회색 상자 + "[그림] 대체 글"
    const images = []; const altImages = [];
    for (const im of list.images) {
        const e = { x: S(im.x), y: S(im.y), w: S(im.w), h: S(im.h), px: im.px, alt: im.alt };
        if (imageMode === 'pixel' && im.px) images.push(e);
        else if (e.w >= 16 && e.h >= 10) altImages.push(e);
    }
    for (const a of altImages) {
        boxes.push({ x: a.x, y: a.y, w: a.w, h: a.h, c: '#e2e8f0' });
        const label = richText(entryChars(`[그림]${a.alt ? ` ${a.alt}` : ''}`)).replace(/\s+/g, ' ').trim();
        // 상자 폭 안에 들어가는 만큼만 (작은 글 9px 기준 어림)
        const fit = label.slice(0, Math.max(4, Math.floor((a.w - 6) / 7)));
        if (a.h >= 12) texts.push({ x: a.x + 3, y: a.y + 2, w: Math.max(4, a.w - 6), h: 13, t: fit, s: sizeCode(9), c: '#64748b', b: 0, href: '' });
    }
    if (altImages.length) boxes.sort((a, b) => b.w * b.h - a.w * a.h);
    const total = Math.max(S(list.height), ...texts.map((t) => t.y + t.h), 1);

    // ---- 쪽 나누기
    const breaks = screenBreaks(texts, total);
    const screens = breaks.length - 1;
    const screenOf = (y) => { for (let i = 0; i < screens; i++) if (y < breaks[i + 1]) return i; return screens - 1; };

    // ---- 글자 밑의 바탕 (읽히게 고치는 기준) — 글 가운데를 덮는 상자 중 가장 작은 것
    const under = (t) => {
        const cx = t.x + Math.min(t.w, 8) / 2; const cy = t.y + t.h / 2;
        let best = null; let area = Infinity;
        for (const b of boxes) {
            if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h && b.w * b.h < area) { best = b; area = b.w * b.h; }
        }
        return best ? best.c : page;
    };

    // ---- 줄로
    const out = { X: [], Z: [], J: [] };
    const count = { X: new Array(screens).fill(0), Z: new Array(screens).fill(0), J: new Array(screens).fill(0) };
    for (const b of boxes) {
        // 페이지 바탕과 같은 상자는 그릴 필요가 없다
        if (b.c === page) continue;
        const s0 = screenOf(b.y); const s1 = screenOf(b.y + b.h - 0.01);
        for (let s = s0; s <= s1; s++) {
            const top = Math.max(b.y, breaks[s]) - breaks[s];
            const bot = Math.min(b.y + b.h, breaks[s + 1]) - breaks[s];
            const x0 = Math.max(0, b.x); const x1 = Math.min(VIEW_W, b.x + b.w);
            if (bot - top < 0.8 || x1 - x0 < 0.8) continue;
            if (count.X[s] >= LAYOUT_LIMITS.boxesPerScreen || out.X.length >= LAYOUT_LIMITS.boxes) continue;
            count.X[s]++;
            out.X.push(`X${p(s + 1, 3)}${p(x0, 3)}${p(top, 3)}${p(Math.max(1, x1 - x0), 3)}${p(Math.max(1, bot - top), 3)}${pal.fg(b.c)}`);
        }
    }
    for (const t of texts) {
        const s = screenOf(t.y);
        if (count.Z[s] >= LAYOUT_LIMITS.textsPerScreen || out.Z.length >= LAYOUT_LIMITS.texts) continue;
        count.Z[s]++;
        const color = pal.fg(readable(t.c || COLORS[0], under(t)));
        const link = t.href ? linkOf(t.href) : 0;
        // 조각의 세로 가운데 = 원본 글상자(LAY_LINE_H) 가운데 — 엔트리는 y + 상자높이/2 에 놓는다
        const y = Math.max(0, t.y + t.h / 2 - LAY_LINE_H[t.s] / 2 - breaks[s]);
        out.Z.push(`Z${p(s + 1, 3)}${p(t.x, 3)}${p(y, 3)}${p(t.w, 3)}${CODES[t.s]}${color}${t.b}${p(link, 4)}${t.t}`);
    }
    let cells = new Array(screens).fill(0);
    for (const im of images) {
        if (out.J.length >= LAYOUT_LIMITS.images) break;
        const s = screenOf(im.y);
        const { cols, rows } = im.px;
        const cell = Math.max(1, Math.min(9, Math.round(im.w / cols)));
        // 오른쪽으로 넘치는 열은 자른다
        const useCols = Math.max(0, Math.min(cols, Math.floor((VIEW_W - im.x) / cell)));
        if (!useCols) continue;
        const room = Math.floor((breaks[s + 1] - im.y) / cell);       // 쪽 아래로 넘치는 줄은 자른다
        const useRows = Math.max(0, Math.min(rows, room));
        if (!useRows || cells[s] + cols * useRows > LAYOUT_LIMITS.cellsPerScreen) continue;
        cells[s] += cols * useRows;
        // 그림마다 8색으로 줄이고 페이지 색표에 넣는다 (넘치는 열을 뺀 칸만)
        const kept = [];
        for (let r = 0; r < useRows; r++) kept.push(...im.px.cells.slice(r * cols, r * cols + useCols));
        const q = quantize(kept, 8).map((h) => pal.fg(h));
        let rle = '';
        for (let r = 0; r < useRows; r++) {
            let i = r * useCols;
            while (i < (r + 1) * useCols) {
                let n = 1;
                while (i + n < (r + 1) * useCols && q[i + n] === q[i] && n < CODES.length - 1) n++;
                rle += q[i] + CODES[n];
                i += n;
            }
        }
        out.J.push(`J${p(s + 1, 3)}${p(im.x, 3)}${p(im.y - breaks[s], 3)}${cell}${p(useCols, 2)}${rle}`);
    }

    // 쪽 순서대로 (엔트리는 쪽마다 첫 항목 자리를 적어 둔다)
    const byScreen = (a, b) => a.slice(1, 4).localeCompare(b.slice(1, 4));
    for (const kk of ['X', 'Z', 'J']) out[kk].sort(byScreen);

    const make = (n) => {
        const keep = (arr) => arr.filter((l) => Number(l.slice(1, 4)) <= n);
        const body = [`T${entryChars(title).replace(/\s+/g, ' ').trim()}`, ...links.slice(0, MAX_LINKS).map((u) => `U${u}`),
            ...pal.lines(page), `M${n}`, ...keep(out.X), ...keep(out.Z), ...keep(out.J)].join('\n');
        return body;
    };
    let n = screens;
    let body = make(n);
    while (Buffer.byteLength(body) > MAX_BODY && n > 1) body = make(--n);
    return { body, screens: n, texts: out.Z.length, boxes: out.X.length, images: out.J.length, truncated: n < screens };
}

export { contrast };
