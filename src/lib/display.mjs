// src/lib/display.mjs — 줄 목록(EBR2 본문)의 정의. 중계 앱과 엔트리 쪽이 **같은 파일**을 쓴다.
//
// 왜 HTML 이 아니라 줄 목록인가
//   엔트리는 반복 한 바퀴가 1프레임이고 글자를 다루는 블록이 몇 개 없다. HTML 을 글자
//   단위로 파싱하면 4만 자에 수십 초가 들고, 할 수 있는 모양도 "같은 크기 글 16줄"에 묶인다.
//   그래서 **배치는 중계 앱이 하고** 엔트리는 줄을 받아 그리기만 한다.
//   앱은 글꼴 크기마다 줄을 미리 접고(wrap), 줄마다 스타일·들여쓰기·링크·색·배경을 단다.
//   엔트리 쪽은 줄 하나를 고정 자리 substring 몇 번으로 읽는다 — 줄당 상수 시간이다.
//
// 본문 형식 (base64 를 풀었을 때, 첫 줄인 최종 주소 다음부터)
//   T<제목>                    한 번
//   U<주소>                    링크마다 한 줄. 나온 순서가 곧 링크 번호(1부터)
//                              같은 출처면 '/' 로 시작하는 경로만 — 엔트리가 이 페이지의 출처를 붙인다.
//                              한글은 %EB%8C%80 대신 글자 그대로 (readableUrl). 둘 다 붙여넣기를 줄인다
//   <S><II><LLLL><C><B><글>     줄 하나 — 아래 RECORD
//   K<x0>,<x1>,<링크>;…         (있으면) 바로 앞 줄 안에서 링크가 차지하는 가로 구간(px).
//                              누른 x 로 링크를 고른다. 구간 밖이면 그 줄의 링크(LLLL)로 간다.
//
// 양식 (칸은 탭으로 가른다 — 글 안의 탭은 layout 이 미리 공백으로 바꾼다)
//   F<방법>\t<action>                         양식. 나온 순서가 양식 번호. 방법 G(GET) / P(POST, 못 보낸다)
//   I<양식>\t<종류>\t<name>\t<값>\t<이름표>\t<켜짐>\t<최소>\t<최대>\t<간격>
//                                            입력 칸. 나온 순서가 칸 번호. 종류는 FIELD
//   O<칸>\t<값>\t<이름표>\t<골라짐>             선택 상자의 선택지 (칸마다 이어서 나온다)
//   W<칸>                                     바로 앞 줄이 그 칸의 **모양**이다 (누르면 칸을 다룬다)
//
// 조각 (문단 속 링크에 색을 입힌다) — 바로 앞 줄을 색이 바뀌는 곳에서 나눈다. 줄마다 여러 개.
//   R<XXX><SSS><NNN><C>   x(px, 글 시작 기준) · 시작 글자(1부터) · 글자 수 · 글자색 번호
//   글은 싣지 않는다 — 엔트리가 그 줄의 글에서 잘라 쓴다. 첫 조각 앞까지는 원래 줄 글상자가,
//   조각들은 여분 글상자가 그 x 에 그린다. 여분이 모자라면 엔트리는 그 줄을 한 색으로 통째 그린다.
//
// 펼치기 (<details> / <summary>) — 엔트리가 **그 자리에서** 접고 편다 (다시 요청하지 않는다)
//   D<0|1><묶음>   바로 앞 줄이 그 묶음의 요약 줄이다 (0 접힘 · 1 펼침). 이 뒤의 줄은 E 까지 그 묶음 안이다.
//                  요약이 여러 줄로 접히면 줄마다 D 가 붙는다 (첫 D 가 묶음을 연다). 묶음 번호는 나온 순서.
//   E              지금 묶음을 닫는다 (묶음 안에 묶음이 들 수 있다)
//   요약 줄의 첫 ▶ / ▼ 는 엔트리가 접고 펼 때 바꿔 쓴다.
//   슬라이더(range)는 W 가 붙은 스타일 8 줄이고, 바로 앞 줄이 "이름표: 값" 이다 (끌면 그 줄을 고친다)
//
//   S    스타일 (STYLES 의 번호, 0 은 빈 간격)
//   II   들여쓰기 px ÷ 4 (두 자리). 스타일 0 이면 **간격 px** 그대로
//   LLLL 링크 번호 (네 자리, 0000 = 없음)
//   C    글자색 번호 (COLORS, 그 뒤로 이 페이지의 P 색) — 한 글자, CODES 의 자리
//   B    바탕색 번호 (BGS, 그 뒤로 이 페이지의 Q 색)
//
// 페이지 색 (렌더 모드에서 사이트의 CSS 를 옮길 때. 링크(U) 줄 앞에 온다)
//   P#rrggbb   글자색 하나 — COLORS 다음 번호부터 차례로 (10, 11, …)
//   Q#rrggbb   바탕색 하나 — BGS 다음 번호부터 (5, 6, …)
//   G#rrggbb   페이지 바탕 (본문 뒤의 큰 상자. 없으면 흰색)
//
// ⚠ 줄은 '\n' 으로 나눈다. 글 안에 '\n' 이 들어가면 안 된다 (layout 이 걸러 낸다).
// ⚠ 글자는 ASCII + 한글 음절만 (엔트리에 chr() 이 없다 — simplify.entryChars).

import { NANUM, MALGUN } from './fontwidth.mjs';

// ---------------------------------------------------------------- 보이는 자리 (엔트리 무대 px)
// 엔트리 쪽 theme.mjs 가 이 값에 맞춰 카드를 놓는다 (어긋나면 빌드가 멈춘다).
export const VIEW_W = 366;          // 글이 들어가는 폭
export const VIEW_H = 206;          // 본문 높이

// ---------------------------------------------------------------- 스타일
// size  글꼴 px      lh  줄 높이 px (= 글상자 높이)      pool  미리 만들 글상자 수
// font  'sans' 나눔고딕 / 'mono' D2 Coding
// pool 은 "한 화면에 그 스타일 줄이 동시에 몇 개까지 보이나" 다. 넘치면 그 줄은 안 그려진다.
// ovl  여분 글상자 수 — 문단 속 링크에 색을 입히는 조각(R)을 그린다. 모자라면 그 줄은 한 색으로 통째.
export const STYLES = {
    0: { name: 'gap' },
    1: { name: 'h1', size: 17, lh: 25, font: 'sans', pool: 4 },
    2: { name: 'h2', size: 14, lh: 21, font: 'sans', pool: 6 },
    3: { name: 'h3', size: 12, lh: 18, font: 'sans', pool: 8 },
    4: { name: 'body', size: 10, lh: 15, font: 'sans', pool: 15, ovl: 30 },
    5: { name: 'small', size: 9, lh: 13, font: 'sans', pool: 16, ovl: 16 },
    6: { name: 'mono', size: 9, lh: 13, font: 'mono', pool: 16 },
    7: { name: 'rule', lh: 9, pool: 5 },
    // 슬라이더 — 글상자가 아니라 **그림 두 개**(막대 + 손잡이)다. 끌어서 값을 바꾼다.
    8: { name: 'range', lh: 22, pool: 3, sprite: true },
};
export const S = { gap: 0, h1: 1, h2: 2, h3: 3, body: 4, small: 5, mono: 6, rule: 7, range: 8 };

// 입력 칸 종류 (I 줄의 <종류>)
export const FIELD = {
    text: 't',      // text · search · email · url · tel · number · textarea — 누르면 입력창
    submit: 's',    // 보내기 버튼
    hidden: 'h',    // 숨은 칸 (보내기에만 실린다)
    check: 'c',     // 체크박스 ■ □
    radio: 'r',     // 라디오 ● ○ (같은 양식·같은 name 중 하나)
    select: 'o',    // 선택 상자 ▾ (누를 때마다 다음 선택지)
    range: 'g',     // 슬라이더 (끌기)
};
export const MARK = { on: '■', off: '□', radioOn: '●', radioOff: '○', select: '▾', closed: '▶', opened: '▼' };
// 슬라이더 막대의 자리 (본문 왼쪽에서 px) — 엔트리 쪽이 같은 값으로 그리고, 끌 때 값으로 바꾼다
export const RANGE = { left: 12, width: 220 };

// 색은 번호로 보낸다 — 줄마다 #rrggbb 를 실으면 붙여넣기가 그만큼 길어진다.
export const COLORS = [
    '#334155', // 0 본문
    '#0f172a', // 1 제목·굵게
    '#2563eb', // 2 링크
    '#64748b', // 3 흐림 (캡션·인용·메타)
    '#475569', // 4 코드
    '#15803d', // 5 초록
    '#b91c1c', // 6 빨강 (오류)
    '#7c3aed', // 7 보라 (방문한 링크 자리 — 아직 안 쓴다)
    '#0f766e', // 8 청록
    '#9a3412', // 9 주황
];
export const C = { text: 0, head: 1, link: 2, dim: 3, code: 4, ok: 5, err: 6 };
export const BGS = ['#ffffff', '#f1f5f9', '#f8fafc', '#eff6ff', '#e2e8f0'];
export const B = { none: 0, code: 1, quote: 2, head: 3, field: 4 };
// 색 번호 한 글자 ↔ 번호. 0~9 는 예전 형식 그대로다. 엔트리 쪽은 indexOf(CODES, 글자) - 1 로 읽는다
export const CODES = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const codeOf = (n) => CODES[n];

// ---------------------------------------------------------------- 운반할 수 있는 글자
// 엔트리에는 chr() 이 없다. 코드 → 글자는 **표 문자열 + charAt** 으로 흉내낸다 (한글 음절표처럼).
// 엔트리 OS 는 ASCII 와 한글 음절만 표가 있었다. 웹 페이지에는 • · — … “ ” → ▶ ㄱ 같은 글자가
// 흔해서, 구간을 몇 개 더 심는다. **엔트리 쪽 web.mjs 가 이 표로 해독한다** — 정의가 하나다.
// 이웃한 구간은 묶는다 — 엔트리는 구간마다 비교 한 번이라 구간이 적을수록 빠르다 (표 글자 수는 파일 크기)
// 고른 근거: 실제 페이지 15곳의 보이는 글 70만 자에서 '?' 로 바뀌던 글자 (2026-10-24 조사)
export const RICH_RANGES = [
    [0x00a0, 0x024f],   // 라틴-1 기호 (· © ° × é) + 라틴 확장 (ō ū š č ı — 지명·인명)
    [0x0370, 0x04ff],   // 그리스 (α β π λ) + 키릴 (а к р)
    [0x2000, 0x27bf],   // 구두점 (– — “ ” • …) · 첨자 (² ₂) · 통화 (€ ₩) · ℃ ™ № · Ⅰ Ⅱ · 화살표 ·
                        // 수학 (− ≤ ≠ √ ∞) · 둘러싼 숫자 (① ②) · 상자선 (─ │) · 도형 (■ ▶ ●) · ☆ ★ ♥ ☎ · ✓ ✔ ✕
    [0x3000, 0x33ff],   // CJK 구두점 (《 》 「 」 〈 〉 、 。) · 일본 가나 · 한글 자모 (ㄱ ㅏ) · ㈜ ㉠ · ㎡ ㎞ ㎏
];
export const HANGUL = [0xac00, 0xd7a3];

// 한자 — KS X 1001 의 4,888자 (EUC-KR 0xCAA1–0xFDFE). 한국어 문서에 쓰이는 한자는 거의 이 안이다.
// 한자는 흩어져 있어서 구간 표로는 2만 자를 다 실어야 한다. 그래서 **번호로** 보낸다:
// 중계 앱은 배치까지 진짜 한자로 하고(폭도 진짜로 잰다), 보낼 때만 사용자 정의 영역 U+E000+번호로
// 바꾼다(toWire). 엔트리는 그 구간을 이 표에서 꺼낸다. 호환 한자(U+F9xx)는 NFC 로 합친다 (4,622가지).
export const HANJA = (() => {
    const dec = new TextDecoder('euc-kr');
    let s = '';
    for (let hi = 0xca; hi <= 0xfd; hi++) for (let lo = 0xa1; lo <= 0xfe; lo++) s += dec.decode(new Uint8Array([hi, lo])).normalize('NFC');
    if ([...s].length !== 4888) throw new Error(`KS X 1001 한자 표를 만들지 못했습니다 (${[...s].length}자) — EUC-KR 을 지원하는 Node 가 필요합니다`);
    return s;
})();
export const HANJA_PUA = 0xe000;                 // 보낼 때 한자 번호를 싣는 자리 (U+E000 .. U+F317)
const HANJA_INDEX = new Map();
[...HANJA].forEach((ch, i) => { const c = ch.codePointAt(0); if (!HANJA_INDEX.has(c)) HANJA_INDEX.set(c, i); });
export const isHanja = (c) => HANJA_INDEX.has(c);

/**
 * 주소의 퍼센트 인코딩 중 **한글 음절만** 글자로 되돌린다 (%EB%8C%80 → 대).
 * 한글 한 자가 9바이트에서 3바이트로 — 한국어 위키 링크가 많은 페이지에서 붙여넣기가 14% 준다.
 * 엔트리 주소창에도 읽을 수 있는 주소가 보이고, 다시 요청할 때 색 격자(392바이트)에도 덜 찬다.
 * 다른 글자(공백 %20, 예약 문자, 한자 등)는 그대로 둔다 — 격자 코덱이 ASCII 와 한글만 싣는다.
 * 중계 앱은 받은 주소를 new URL() 로 다시 인코딩하므로 요청은 같다.
 */
export function readableUrl(u) {
    return String(u).replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
        // 퍼센트 묶음을 UTF-8 글자 단위로 끊어, 한글 음절이면 글자로 · 아니면 **원래 퍼센트 문자열 그대로**
        const bytes = m.match(/%[0-9A-Fa-f]{2}/g).map((x) => parseInt(x.slice(1), 16));
        let out = ''; let i = 0;
        while (i < bytes.length) {
            const b = bytes[i];
            const n = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
            const raw = m.slice(i * 3, (i + n) * 3);
            let ch = '';
            try { ch = decodeURIComponent(raw); } catch { /* 깨진 UTF-8 — 그대로 둔다 */ }
            const c = ch.length === 1 ? ch.codePointAt(0) : 0;
            out += c >= HANGUL[0] && c <= HANGUL[1] ? ch : raw;
            i += n;
        }
        return out;
    });
}
/** 보내기 직전 — 한자를 번호 자리(U+E000+번호)로 */
export function toWire(s) {
    let o = '';
    for (const ch of s) {
        const i = HANJA_INDEX.get(ch.codePointAt(0));
        o += i === undefined ? ch : String.fromCharCode(HANJA_PUA + i);
    }
    return o;
}
// 탭(9)은 양식 줄(F/I/O)의 구분자로만 쓴다 — 본문 글의 탭은 layout 이 공백으로 바꾼다
export const isTransportable = (c) => c === 10 || c === 9 || (c >= 32 && c <= 126)
    || (c >= HANGUL[0] && c <= HANGUL[1]) || RICH_RANGES.some(([a, b]) => c >= a && c <= b) || HANJA_INDEX.has(c);
/** 운반 못 하는 글자는 '?' 로 */
export function richText(s) {
    let o = '';
    for (const ch of s) o += isTransportable(ch.codePointAt(0)) ? ch : '?';
    return o;
}
export const rangeTable = ([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i)).join('');

export const INDENT_UNIT = 4;
export const MAX_LINES = 1500;      // 엔트리 리스트 5000항목 상한 안쪽 (줄마다 리스트 7개)
export const MAX_LINKS = 900;
export const MAX_SEGS = 4000;       // 조각(R) 상한 — 엔트리 리스트 5000항목 안쪽

// ---------------------------------------------------------------- 글 폭
// 엔트리에는 글의 픽셀 너비를 재는 블록이 없다. 그래서 **앱이** 접는다.
// 아래 어림(charEm)은 실측 표(fontwidth.mjs)에 없는 글자에만 쓴다.
const NARROW = new Set("ijl.,:;!|'`");
const SEMI = new Set('frt()[]{}" -/\\');
const WIDE = new Set('mwMW@%');
export function charEm(ch, font) {
    const c = ch.codePointAt(0);
    const hangul = c >= 0xac00 && c <= 0xd7a3;
    if (font === 'mono') return hangul ? 1.0 : 0.5;
    if (hangul) return 0.96;
    if (ch === ' ') return 0.3;
    if (NARROW.has(ch)) return 0.3;
    if (SEMI.has(ch)) return 0.4;
    if (WIDE.has(ch)) return 0.88;
    if (c >= 48 && c <= 57) return 0.57;
    if (c >= 65 && c <= 90) return 0.68;
    if (c >= 97 && c <= 122) return 0.55;
    return 0.6;
}
// 실측 표가 실기와 0.2% 안에서 맞아서 여유를 7% → 3% 로 줄였다 (맑은 고딕의 커닝은 폭을 줄이는 쪽이라 안전하다)
export const SAFETY = 0.97;

// ---------------------------------------------------------------- 실제 글자 폭 (실측 표)
// fontwidth.mjs 는 Chrome 캔버스로 잰 글자 폭이다 (entry/tools/fontwidth.mjs 가 만든다).
// 🔴 실기 (2026-10-24, Windows): 글상자 글꼴을 '나눔고딕' 이라고 적으면 엔트리는 그런 글꼴을 못 찾아
//   **맑은 고딕**으로 그린다 — 확인 페이지(ruler.html)의 폭이 맑은 고딕과 0.2% 안에서 맞았다.
//   'Nanum Gothic' · 'NanumGothic' 이름으로 바꿔도 나눔고딕은 불러와지지 않았다.
//   그래서 줄 접기(textPx)는 **맑은 고딕 표**를 쓴다. ⚠ 대체 글꼴은 OS 마다 달라서(맥은 Apple SD 산돌고딕)
//   Windows 밖에서는 조금 어긋날 수 있다 — 맑은 고딕이 대체로 넓은 편이라 넘치기보다 남는 쪽이다.
// face  'malgun' 맑은 고딕 (커닝이 있어 글자 폭의 합이 0.2~4% 크다 — 안전한 쪽) / 'nanum' 나눔고딕 (비교용)
export function charW(ch, bold = false, face = 'nanum') {
    const t = face === 'malgun' && MALGUN ? MALGUN : NANUM[bold ? 'bold' : 'regular'];
    const c = ch.codePointAt(0);
    if (c >= 32 && c <= 126) return t.ascii[c - 32] / 1000;
    if (c >= HANGUL[0] && c <= HANGUL[1]) return (t.hangulOdd[ch] ?? t.hangul) / 1000;
    for (const [a, b, w] of t.ranges) if (c >= a && c <= b) return w[c - a] / 1000;
    if (HANJA_INDEX.has(c)) return (t.hanjaOdd[ch] ?? t.hanja) / 1000;
    return charEm(ch, 'sans');                         // 표에 없는 글자
}
/** 실측 표로 잰 글 폭(px). 고정폭(mono) 스타일은 어림 그대로 */
export const measurePx = (s, style, face = 'nanum') => {
    const st = STYLES[style];
    if (st.font === 'mono') return textPx(s, style);
    let em = 0;
    for (const ch of s) em += charW(ch, false, face);
    return em * st.size;
};
/** 엔트리가 그릴 글 폭(px) — 줄 접기·들여쓰기·정렬·링크 구간이 모두 이것을 쓴다 */
export const textPx = (s, style) => {
    const st = STYLES[style];
    let em = 0;
    if (st.font === 'mono') for (const ch of s) em += charEm(ch, 'mono');     // D2 Coding — 아직 어림
    else for (const ch of s) em += charW(ch, false, 'malgun');
    return em * st.size;
};

/**
 * 조각들(runs: [{text, link}])을 폭에 맞춰 줄로 접는다.
 * 줄의 링크는 **그 줄에서 글자를 가장 많이 차지한 링크**다 (줄을 누르면 기본으로 그리로 간다).
 * spans 는 줄 안에서 링크가 차지하는 가로 구간(px, 글 시작 기준)이다 — 누른 x 로 링크를 고른다.
 * @returns {{text:string, link:number, linkChars:number, chars:number, spans:{x0,x1,link}[]}[]}
 */
export function wrapRuns(runs, style, widthPx) {
    const max = widthPx * SAFETY;
    const lines = [];
    let cur = { text: '', counts: new Map(), spans: [], colors: new Map(), ranges: [] };
    const curPx = () => textPx(cur.text, style);
    const flush = () => {
        const text = cur.text.replace(/\s+$/, '');
        if (text) {
            let link = 0; let best = 0;
            for (const [l, n] of cur.counts) if (l && n > best) { best = n; link = l; }
            // 같은 링크가 이어지면 하나로
            const spans = [];
            for (const s of cur.spans) {
                const last = spans.at(-1);
                if (last && last.link === s.link && s.x0 - last.x1 < 6) last.x1 = s.x1;
                else spans.push({ ...s });
            }
            // 줄의 글자색 = 그 줄에서 글자를 가장 많이 차지한 색 (조각에 color 가 있을 때 — CSS)
            let color; let most = 0;
            for (const [c, n] of cur.colors) if (n > most) { most = n; color = c; }
            lines.push({ text, link, linkChars: best, chars: [...text].length, spans, color, ranges: cur.ranges });
        }
        cur = { text: '', counts: new Map(), spans: [], colors: new Map(), ranges: [] };
    };
    const put = (piece, link, color) => {
        const x0 = textPx(cur.text, style);
        cur.text += piece;
        cur.counts.set(link, (cur.counts.get(link) || 0) + [...piece.trim()].length);
        if (color) cur.colors.set(color, (cur.colors.get(color) || 0) + [...piece.trim()].length);
        if (link && piece.trim()) {
            const lead = textPx(piece.match(/^\s*/)[0], style);
            cur.spans.push({ x0: x0 + lead, x1: textPx(cur.text.trimEnd(), style), link });
            // 같은 구간을 글자 번호로도 (c0 부터 c1 앞까지, 줄 글 기준) — 조각(R)이 쓴다.
            // 같은 링크가 공백만 사이에 두고 이어지면 하나로
            const end = [...cur.text.trimEnd()].length;
            const c0 = end - [...piece.trim()].length;
            const last = cur.ranges.at(-1);
            if (last && last.link === link && [...cur.text].slice(last.c1, c0).join('').trim() === '') last.c1 = end;
            else cur.ranges.push({ c0, c1: end, link });
        }
    };
    for (const run of runs) {
        // 낱말 단위로 (공백을 낱말 끝에 붙여 둔다)
        for (const word of run.text.split(/(?<=\s)/)) {
            if (!word) continue;
            if (cur.text && curPx() + textPx(word.trimEnd(), style) > max) flush();
            if (!cur.text) {
                const w = word.replace(/^\s+/, '');
                if (!w) continue;
                // 한 낱말이 한 줄보다 길면 글자 단위로 자른다 (긴 주소·영단어)
                if (textPx(w.trimEnd(), style) > max) {
                    for (const ch of w) {
                        if (cur.text && curPx() + textPx(ch, style) > max) flush();
                        put(ch, run.link, run.color);
                    }
                    continue;
                }
                put(w, run.link, run.color);
                continue;
            }
            put(word, run.link, run.color);
        }
    }
    flush();
    return lines;
}

// ---------------------------------------------------------------- 줄 기록
const pad = (n, w) => String(Math.max(0, Math.min(10 ** w - 1, Math.round(n)))).padStart(w, '0');

export function record(style, indentPx, link, color, bg, text) {
    const ii = style === S.gap ? pad(indentPx, 2) : pad(indentPx / INDENT_UNIT, 2);
    const cc = (n) => (typeof n === 'number' ? CODES[n] : n);
    return `${style}${ii}${pad(link, 4)}${cc(color)}${cc(bg)}${String(text).replace(/[\r\n]/g, ' ')}`;
}
export const RECORD_HEAD = 9;       // S(1) II(2) LLLL(4) C(1) B(1)

export function parseRecord(line) {
    const style = Number(line[0]);
    const ii = Number(line.slice(1, 3));
    return {
        style,
        indent: style === S.gap ? 0 : ii * INDENT_UNIT,
        gap: style === S.gap ? ii : 0,
        link: Number(line.slice(3, 7)),
        color: CODES.indexOf(line[7]),
        bg: CODES.indexOf(line[8]),
        text: line.slice(RECORD_HEAD),
    };
}

/** 본문 전체(T/U/줄) → 쓰기 좋은 모양 (테스트·미리보기). base 를 주면 '/' 로 시작하는 링크에 출처를 붙인다 */
export function parseBody(body, base = '') {
    let origin = '';
    try { origin = base ? new URL(base).origin : ''; } catch { /* 작품 안의 페이지 */ }
    const out = { title: '', links: [], lines: [], forms: [], fields: [], options: [], colors: [...COLORS], bgs: [...BGS], page: '' };
    for (const l of body.split('\n')) {
        if (!l) continue;
        const t = l.slice(1).split('\t');
        if (l[0] === 'T') out.title = l.slice(1);
        else if (l[0] === 'U') out.links.push(origin && l[1] === '/' ? origin + l.slice(1) : l.slice(1));
        else if (l[0] === 'P') out.colors.push(l.slice(1));
        else if (l[0] === 'Q') out.bgs.push(l.slice(1));
        else if (l[0] === 'G') out.page = l.slice(1);
        else if (l[0] === 'K') { if (out.lines.length) out.lines.at(-1).spans = parseSpans(l.slice(1)); }
        else if (l[0] === 'W') { if (out.lines.length) out.lines.at(-1).field = Number(l.slice(1)); }
        else if (l[0] === 'D') { if (out.lines.length) Object.assign(out.lines.at(-1), { group: Number(l.slice(2)), open: l[1] === '1' }); }
        else if (l[0] === 'E') out.lines.push({ end: true });
        else if (l[0] === 'R') {
            if (out.lines.length) {
                const ln = out.lines.at(-1);
                (ln.segs ||= []).push({ x: Number(l.slice(1, 4)), start: Number(l.slice(4, 7)), len: Number(l.slice(7, 10)), color: CODES.indexOf(l[10]) });
            }
        }
        else if (l[0] === 'F') out.forms.push({ method: t[0], action: t[1] });
        else if (l[0] === 'I') {
            out.fields.push({
                form: Number(t[0]), type: t[1], name: t[2], value: t[3], label: t[4],
                on: Number(t[5]), min: Number(t[6]), max: Number(t[7]), step: Number(t[8]),
            });
        } else if (l[0] === 'O') out.options.push({ field: Number(t[0]), value: t[1], label: t[2], selected: Number(t[3]) });
        else out.lines.push({ ...parseRecord(l), spans: [], field: 0 });
    }
    return out;
}
export const FIELD_COLS = 9;        // I 줄의 칸 수 (엔트리 쪽이 이만큼 떼어 읽는다)

export const formatSpans = (spans) => spans.map((s) => `${Math.round(s.x0)},${Math.round(s.x1)},${s.link}`).join(';');
export const parseSpans = (s) => s.split(';').filter(Boolean).map((t) => {
    const [x0, x1, link] = t.split(',').map(Number);
    return { x0, x1, link };
});

/** 줄의 높이 (스타일 0 은 간격) */
export const heightOf = (r) => (r.style === S.gap ? r.gap : STYLES[r.style].lh);
