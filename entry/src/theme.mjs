// src/theme.mjs — 색과 배치의 정본 (Entry Browser)
//
// 무대 480 x 270 (x -240..240, y -135..135, **y 가 위로**)
//
//   x -240   -168                                                  240
//    ┌───────┬──────────────────────────────────────────────────────┐ 135
//    │ 요청  │ ←  →  ↻  ⌂   ( ◯ https://ko.wikipedia.org/...      ) │ 툴바 30
//    │ 코드  ├──────────────────────────────────────────────────────┤ 105
//    │ 띠    │ ┌──────────────────────────────────────────────────┐ │
//    │ 72px  │ │ 제목                                            ▐ │ │ 본문 16줄
//    │       │ │ 본문 …                                           │ │
//    │ (격자 │ │ 링크 줄은 파랗고, 마우스를 올리면 밝아진다         │ │
//    │  216) │ └──────────────────────────────────────────────────┘ │
//    │ 54 빈 ├──────────────────────────────────────────────────────┤ -119
//    │  자리 │ 상태                                          ▲ ▼  │ 상태 16
//    └───────┴──────────────────────────────────────────────────────┘ -135
//
// 왼쪽 띠 아래 54px 는 **비워 둔다.** 입력창(묻고 기다리기)이 무대 아래쪽에 뜨는데,
// 격자를 가리면 중계 앱이 못 읽는다. 그래서 격자를 다 그리자마자 입력창을 열 수 있다.
//
// 🔴 글상자는 런타임에 **크기를 못 바꾼다** (`set_scale_size` 가 작품 불러오기를 깨뜨린다 —
//   entry-os · entry-ppt). 그래서 크기는 여기 상수로 굳고, 줄마다 다른 것은 **색**뿐이다.

import * as STRIP from '../../src/lib/stripcodec.mjs';
import { VIEW_W, VIEW_H } from '../../src/lib/display.mjs';

export { STRIP };

// ---------------------------------------------------------------- 색 (Tailwind slate 계열)
export const C = {
    stage: '#0f172a',       // 띠와 무대 바닥
    frame: '#e2e8f0',       // 브라우저 창 바탕 (카드 바깥)
    bar: '#ffffff',         // 툴바
    line: '#e2e8f0',        // 구분선
    pill: '#f1f5f9',        // 주소창
    card: '#ffffff',        // 본문 카드
    hover: '#eff6ff',       // 링크 줄에 마우스
    status: '#f8fafc',

    head: '#0f172a',        // 제목
    text: '#334155',        // 본문
    bold: '#0f172a',
    dim: '#64748b',         // 기울임·안내
    code: '#475569',        // pre
    link: '#2563eb',
    url: '#475569',         // 주소창 글자
    accent: '#2563eb',
    warn: '#b45309',
    ok: '#15803d',
};

// 엔트리에서 확인된 글꼴은 이것 하나다 (entry-ppt HANDOFF §7).
// 없는 이름을 주면 브라우저 기본 글꼴로 떨어진다 — 안전하지만 모양이 달라진다.
export const FONT = '나눔고딕';
export const MONO = 'D2 Coding';      // 엔트리 OS 가 쓰는 글꼴 (실기 확인)

// ---------------------------------------------------------------- 배치
export const STAGE = { left: -240, right: 240, top: 135, bottom: -135 };

export const BROWSER = { left: STRIP.X0 + STRIP.WIDTH, right: 240 };       // -168 .. 240
export const BW = BROWSER.right - BROWSER.left;                              // 408
export const BX = (BROWSER.left + BROWSER.right) / 2;                        // 36 (가운데)

export const TOOLBAR = { top: 135, h: 30 };
export const TY = TOOLBAR.top - TOOLBAR.h / 2;                               // 120

export const STATUS = { h: 16 };
export const SY = STAGE.bottom + STATUS.h / 2;                               // -127

// 본문 카드 — 툴바와 상태줄 사이, 사방 4px 여백
export const CARD = {
    left: BROWSER.left + 4, right: BROWSER.right - 4,
    top: TOOLBAR.top - TOOLBAR.h - 4, bottom: STAGE.bottom + STATUS.h + 3,
};
export const CARD_W = CARD.right - CARD.left;                                // 400
export const CARD_H = CARD.top - CARD.bottom;                                // 214

// 본문 — 글이 놓이는 자리. 폭·높이는 중계 앱과 같은 정의(display.mjs)를 쓴다.
// 앱은 이 폭에 맞춰 줄을 접어 보낸다. 어긋나면 글이 카드 밖으로 넘친다 → 아래에서 막는다.
export const VIEW = {
    left: CARD.left + 10,
    top: CARD.top - 6,
    w: VIEW_W,
    h: VIEW_H,
};
VIEW.right = VIEW.left + VIEW.w;
VIEW.bottom = VIEW.top - VIEW.h;
if (VIEW.right > CARD.right - 10) throw new Error(`본문 폭(${VIEW_W})이 카드보다 넓습니다 — display.VIEW_W 를 줄이세요`);
if (VIEW.bottom < CARD.bottom + 3) throw new Error(`본문 높이(${VIEW_H})가 카드보다 깁니다 — display.VIEW_H 를 줄이세요`);

// 스크롤 막대 (자리만 움직인다 — 크기는 못 바꾼다)
export const THUMB = { x: CARD.right - 6, w: 4, h: 28 };
export const THUMB_TOP = VIEW.top - THUMB.h / 2;
export const THUMB_BOTTOM = VIEW.bottom + THUMB.h / 2;
// 툴바 단추 (아이콘 가운데 x)
export const BTN = { back: BROWSER.left + 16, fwd: BROWSER.left + 36, reload: BROWSER.left + 56, home: BROWSER.left + 76 };
export const PILL = { left: BROWSER.left + 92, right: BROWSER.right - 10, h: 22 };
export const PILL_W = PILL.right - PILL.left;
export const PILL_X = (PILL.left + PILL.right) / 2;
