// src/ruler.mjs — 'ruler.html' (글자 폭 확인) — 엔트리의 글꼴 폭이 실측 표와 같은지 눈으로 보는 페이지
//
// 지금의 렌더러만으로 본다 (글상자를 겹치지 않는다):
//   위 줄    <글>|
//   아래 줄  <공백 n개>|  나눔    n = 나눔고딕 표로 잰 <글> 폭 ÷ 나눔고딕 공백 폭
//   아래 줄  <공백 m개>|  맑은    m = 맑은 고딕 표로 잰 값
// 엔트리가 그 글꼴로 그리면 그 줄의 | 가 위 줄의 | 와 나란하다. 공백 단위라 ±1~2px 은 정상.
//
// 🔴 실기 (2026-10-24, Windows): '맑은' 줄이 맞았다 — 글꼴 이름 '나눔고딕' 을 엔트리가 못 찾아 맑은 고딕으로
//   떨어진 것. f 키로 'Nanum Gothic' · 'NanumGothic' 을 줘도 '나눔' 줄은 맞지 않았다 → 줄 접기는 맑은 고딕 표.
//   다른 OS·다른 PC 에서 어긋나는지 볼 때도 이 페이지를 쓴다.

import { STYLES, S, C, B, VIEW_W, record, measurePx } from '../../src/lib/display.mjs';

const SAMPLES = [
    [S.body, '엔트리 브라우저는 화면과 클립보드로 인터넷에 닿는 실험입니다 가나다'],
    [S.body, 'the quick brown fox jumps over the lazy dog and keeps on running far'],
    [S.body, 'ENTRY BROWSER 2026 HTTP 200 OK ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
    [S.body, '위키백과(Wikipedia)는 2001년 1월 15일에 시작됐다. “인용” • 화살표 →'],
    [S.body, 'iiiiiiiiii llllllllll .......... ,,,,,,,,,, mmmmmmmmmm WWWWWWWWWW'],
    [S.small, '작은 글 9px — 캡션, 메뉴, 바닥글에 쓰는 크기입니다. Small text 0123456789'],
    [S.h3, '제목 3 (12px) Heading three 가나다라마바사'],
    [S.h2, '제목 2 (14px) Heading two 가나다'],
    [S.h1, '제목 1 (17px) Heading 가나다'],
];

/** 폭 안에 들어가게 자른다 (| 와 꼬리 글 자리를 남긴다) */
function fit(s, style) {
    while (measurePx(s, style) > VIEW_W * 0.78 || measurePx(s, style, 'malgun') > VIEW_W * 0.78) s = s.slice(0, -1);
    return s.trimEnd();
}

export function rulerPage() {
    const out = ['T글자 폭 확인'];
    const line = (style, color, t) => out.push(record(style, 0, 0, color, B.none, t));
    const gap = (px) => out.push(record(S.gap, px, 0, 0, 0, ''));
    line(S.h2, C.head, '글자 폭 확인');
    line(S.small, C.dim, '세로 막대 | 가 위 줄 끝의 | 와 나란한 줄이 지금 글꼴입니다.');
    line(S.small, C.dim, "'나눔' 줄 = 나눔고딕 · '맑은' 줄 = 맑은 고딕 (±1~2px 은 정상).");
    line(S.small, C.dim, 'f 키: 글꼴 이름을 바꿉니다 (아래 상태줄에 이름이 나옵니다).');
    line(S.small, C.dim, '바꾼 뒤 한 번 스크롤해서 다시 그리고, 이름마다 찍어 보내 주세요.');
    for (const [style, raw] of SAMPLES) {
        const s = fit(raw, style);
        const sp = (fn) => Math.round(fn(s, style) / fn(' ', style));
        gap(10);
        line(style, C.text, `${s}|`);
        const nanum = (t, st) => measurePx(t, st);
        const malgun = (t, st) => measurePx(t, st, 'malgun');
        line(style, C.link, `${' '.repeat(sp(nanum))}|  나눔`);
        line(style, C.dim, `${' '.repeat(sp(malgun))}|  맑은`);
        line(S.small, C.dim, `${STYLES[style].name} ${STYLES[style].size}px · 나눔 ${nanum(s, style).toFixed(1)}px · 맑은 ${malgun(s, style).toFixed(1)}px`);
    }
    return { name: 'ruler.html', body: out.join('\n') };
}
