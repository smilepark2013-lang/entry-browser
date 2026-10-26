// src/icons.mjs — 화면을 이루는 SVG (아이콘, 주소창, 카드, 띠)
//
// entry-ppt 에서 **SVG 커스텀 그림이 된다**는 것이 실기로 확인됐다 (그쪽 HANDOFF §7).
// 모양은 작품 안에 굳는다 — 런타임에 그림을 바꾸는 블록(change_to_some_shape)은
// 아직 확인 전이라 쓰지 않는다. 그래서 상태에 따라 바뀌는 것은 글상자 색이 맡는다.
//
// ⚠ SVG 안에 글자를 넣지 않는다. 글꼴이 없으면 통째로 안 보인다. 도형만 그린다.
// ⚠ #ff00ff(마젠타)를 쓰지 않는다. 그 색은 요청 격자의 마커다 — 중계 앱이 헷갈린다.
// ⚠ `width/height` 와 viewBox 를 실제 놓일 크기와 같게 둔다. 스프라이트는 dsl 의
//   `w` 로 그 크기에 맞춰진다 (배율 1).

import { C, CARD_W, CARD_H, PILL_W, PILL, THUMB, STRIP, VIEW } from './theme.mjs';
import { RANGE } from '../../src/lib/display.mjs';

const svg = (w, h, body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;

/** dsl 의 sprite({ pictures }) 에 넣을 모양 */
export const picture = (name, w, h, body) => ({ name, ext: 'svg', data: svg(w, h, body), width: w, height: h });

// 선 아이콘 (16px). 끝이 둥근 2px 선 — 요즘 브라우저 툴바의 결이다.
const ICON = 16;
const strokeIcon = (name, d, color = '#475569') => picture(name, ICON, ICON,
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`);

export const ICONS = {
    back: strokeIcon('back', 'M10 3.5 5.5 8l4.5 4.5M5.5 8H13'),
    fwd: strokeIcon('forward', 'M6 3.5 10.5 8 6 12.5M10.5 8H3'),
    reload: strokeIcon('reload', 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3'),
    home: strokeIcon('home', 'M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3V9.5h2V13h3V6.5'),
    up: strokeIcon('up', 'M4 10l4-4 4 4', '#64748b'),
    down: strokeIcon('down', 'M4 6l4 4 4-4', '#64748b'),
    // 주소창 왼쪽 지구본
    globe: picture('globe', 12, 12,
        '<circle cx="6" cy="6" r="4.6" fill="none" stroke="#64748b" stroke-width="1.2"/>'
        + '<ellipse cx="6" cy="6" rx="2" ry="4.6" fill="none" stroke="#64748b" stroke-width="1"/>'
        + '<path d="M1.6 6h8.8" stroke="#64748b" stroke-width="1"/>'),
};

/** 주소창 — 알약 모양 */
export const PILL_PIC = picture('omnibox', PILL_W, PILL.h,
    `<rect x="0.5" y="0.5" width="${PILL_W - 1}" height="${PILL.h - 1}" rx="${(PILL.h - 1) / 2}"`
    + ` fill="${C.pill}" stroke="#e2e8f0"/>`);

/** 본문 카드 — 둥근 모서리 + 옅은 그림자 */
export const CARD_PIC = picture('card', CARD_W, CARD_H,
    `<rect x="1" y="2" width="${CARD_W - 2}" height="${CARD_H - 2}" rx="8" fill="#cbd5e1" opacity="0.5"/>`
    + `<rect x="0.5" y="0.5" width="${CARD_W - 1}" height="${CARD_H - 2}" rx="8" fill="${C.card}" stroke="#e2e8f0"/>`);

/** 슬라이더 — 막대 (값과 상관없이 같은 모양: 그림은 런타임에 못 바꾼다) */
export const TRACK_PIC = picture('track', RANGE.width + 8, 12,
    `<rect x="4" y="4" width="${RANGE.width}" height="4" rx="2" fill="#cbd5e1"/>`);
/** 슬라이더 — 손잡이 (끌면 따라온다) */
export const KNOB_PIC = picture('knob', 16, 16,
    '<circle cx="8" cy="8.6" r="6.4" fill="#94a3b8" opacity="0.35"/>'
    + '<circle cx="8" cy="8" r="6" fill="#ffffff" stroke="#2563eb" stroke-width="2"/>');
/** 스크롤 막대가 다니는 길 (누르면 그 자리로, 끌 수 있다) */
export const SBAR_PIC = picture('sbar', 8, VIEW.h,
    `<rect x="2.5" y="0" width="3" height="${VIEW.h}" rx="1.5" fill="#f1f5f9"/>`);

/** 스크롤 막대 손잡이 */
export const THUMB_PIC = picture('thumb', THUMB.w, THUMB.h,
    `<rect x="0" y="0" width="${THUMB.w}" height="${THUMB.h}" rx="${THUMB.w / 2}" fill="#cbd5e1"/>`);

/**
 * 왼쪽 띠 — 쉬고 있을 때 격자 자리를 덮는 판.
 * 요청을 보낼 때 이 판이 사라지고 그 아래 붓이 격자를 그린다.
 * 무늬는 "이 자리로 신호가 오간다" 는 느낌만 준다 (점 격자 + 위아래 화살표).
 */
export const STRIP_PIC = (() => {
    const W = STRIP.WIDTH; const H = 270;
    let dots = '';
    for (let y = 18; y < 200; y += 12) {
        for (let x = 12; x < W; x += 12) {
            const o = (0.08 + 0.12 * Math.abs(Math.sin((x * 7 + y) / 40))).toFixed(2);
            dots += `<circle cx="${x}" cy="${y}" r="1.4" fill="#93c5fd" opacity="${o}"/>`;
        }
    }
    const cx = W / 2;
    return picture('strip', W, H,
        `<rect width="${W}" height="${H}" fill="${C.stage}"/>`
        + `<rect x="${W - 1}" width="1" height="${H}" fill="#1e293b"/>`
        + dots
        // 가운데: 둥근 칩 + 오가는 화살표 둘
        + `<rect x="${cx - 18}" y="96" width="36" height="36" rx="10" fill="#1e293b" stroke="#334155"/>`
        + `<path d="M${cx - 6} 106v16M${cx - 10} 110l4-4 4 4" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
        + `<path d="M${cx + 6} 122v-16M${cx + 2} 118l4 4 4-4" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
        // 아래 빈 자리(입력창 자리)에는 옅은 선 하나만
        + `<rect x="10" y="${STRIP.HEIGHT + 8}" width="${W - 20}" height="1" fill="#1e293b"/>`);
})();

/**
 * 표지 — 작품 섬네일. 무대 전체(480×270)를 덮는 맨 앞 그림이고, 시작하면 숨는다 (program.mjs).
 * 도형만 그린다 (위 ⚠ — 글자는 그 위의 글상자가 쓴다: COVER_TEXT 자리와 맞춘다).
 *   왼쪽: 제목 자리 · 실험용 배지 테두리 · 시작 단추     오른쪽: 브라우저 모형 (띠 격자 → 카드)
 */
export const COVER = { W: 480, H: 270, badge: { x: 58, y: 34, w: 104, h: 20 }, cta: { x: 58, y: 200, w: 124, h: 32 } };
export const COVER_PIC = (() => {
    const { W, H, badge: b, cta: c } = COVER;
    const cells = ['#38bdf8', '#f472b6', '#facc15', '#34d399', '#a78bfa', '#fb923c'];
    let grid = '';
    for (let r = 0; r < 16; r++) for (let k = 0; k < 2; k++) {
        grid += `<rect x="${16 + k * 12}" y="${38 + r * 12}" width="10" height="10" rx="2" fill="${cells[(r * 2 + k * 3) % cells.length]}" opacity="${0.55 + ((r + k) % 3) * 0.15}"/>`;
    }
    // 브라우저 모형 — 실제 화면처럼: 툴바 · 주소창 · 제목 · 본문 줄 · 문단 속 파란 링크 · 펼치기
    const X = 252; const Y = 32; const CW = 208; const CH = 204;
    const line = (y, parts) => {
        let x = X + 14; let o = '';
        for (const [w, color] of parts) { o += `<rect x="${x}" y="${y}" width="${w}" height="5" rx="2.5" fill="${color}"/>`; x += w + 4; }
        return o;
    };
    const G = '#cbd5e1'; const L = '#3b82f6';
    return picture('cover', W, H,
        `<defs><linearGradient id="cv" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e293b"/><stop offset="1" stop-color="#0b1120"/></linearGradient>`
        + `<radialGradient id="gl" cx="0.78" cy="0.35" r="0.55"><stop offset="0" stop-color="#2563eb" stop-opacity="0.35"/><stop offset="1" stop-color="#2563eb" stop-opacity="0"/></radialGradient></defs>`
        + `<rect width="${W}" height="${H}" fill="url(#cv)"/><rect width="${W}" height="${H}" fill="url(#gl)"/>`
        + grid
        // 배지 테두리 · 시작 단추 (▶ 는 도형)
        + `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${b.h / 2}" fill="#451a03" fill-opacity="0.5" stroke="#fbbf24" stroke-width="1.2"/>`
        + `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="${c.h / 2}" fill="#22c55e"/>`
        + `<path d="M${c.x + 18} ${c.y + 10} L${c.x + 29} ${c.y + 16} L${c.x + 18} ${c.y + 22} Z" fill="#052e16"/>`
        // 카드
        + `<rect x="${X + 3}" y="${Y + 5}" width="${CW}" height="${CH}" rx="12" fill="#000" opacity="0.35"/>`
        + `<rect x="${X}" y="${Y}" width="${CW}" height="${CH}" rx="12" fill="#ffffff"/>`
        + `<path d="M${X} ${Y + 12} a12 12 0 0 1 12 -12 h${CW - 24} a12 12 0 0 1 12 12 v18 h-${CW} z" fill="#f1f5f9"/>`
        + `<path d="M${X + 14} ${Y + 15} l-4 0 M${X + 10} ${Y + 15} l3 -3 M${X + 10} ${Y + 15} l3 3" stroke="#475569" stroke-width="1.6" stroke-linecap="round" fill="none"/>`
        + `<path d="M${X + 22} ${Y + 15} l4 0 M${X + 26} ${Y + 15} l-3 -3 M${X + 26} ${Y + 15} l-3 3" stroke="#475569" stroke-width="1.6" stroke-linecap="round" fill="none"/>`
        + `<circle cx="${X + 40}" cy="${Y + 15}" r="4" fill="none" stroke="#475569" stroke-width="1.6"/>`
        + `<rect x="${X + 52}" y="${Y + 8}" width="${CW - 64}" height="14" rx="7" fill="#ffffff" stroke="#e2e8f0"/>`
        + `<circle cx="${X + 60}" cy="${Y + 15}" r="3" fill="none" stroke="#94a3b8" stroke-width="1.2"/>`
        + `<rect x="${X + 68}" y="${Y + 13}" width="70" height="4" rx="2" fill="#94a3b8"/>`
        // 본문
        + `<rect x="${X + 14}" y="${Y + 42}" width="120" height="10" rx="3" fill="#0f172a"/>`
        + line(Y + 62, [[54, G], [40, L], [60, G]])
        + line(Y + 72, [[90, G], [64, G]])
        + line(Y + 82, [[36, G], [58, L], [44, G]])
        + `<rect x="${X + 14}" y="${Y + 98}" width="80" height="7" rx="3" fill="#334155"/>`
        + line(Y + 113, [[6, '#64748b'], [70, L]])
        + line(Y + 123, [[6, '#64748b'], [92, L]])
        + line(Y + 133, [[6, '#64748b'], [56, L]])
        + `<rect x="${X + 10}" y="${Y + 146}" width="${CW - 20}" height="24" rx="4" fill="#eff6ff"/>`
        + `<path d="M${X + 18} ${Y + 154} l6 4 l-6 4 z" fill="#2563eb"/>`
        + `<rect x="${X + 30}" y="${Y + 156}" width="64" height="5" rx="2.5" fill="#1e3a8a"/>`
        + line(Y + 180, [[70, G], [30, G], [50, L]])
        + line(Y + 190, [[110, G]])
        + `<rect x="${X + CW - 8}" y="${Y + 40}" width="3" height="40" rx="1.5" fill="#cbd5e1"/>`);
})();
