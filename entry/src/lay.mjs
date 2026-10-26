// src/lay.mjs — 레이아웃 모드: 실제 사이트 모양을 쪽 단위로 그린다
//
// 중계 앱(src/lib/pager.mjs)이 Chromium 의 배치를 쪽별 그리기 목록으로 보낸다:
//   M<쪽 수> · X 상자 · Z 글 조각 · J 그림 (형식은 pager.mjs 머리말)
// 엔트리는 스크롤하지 않고 **쪽을 넘긴다.** 쪽을 넘길 때만(sig_lay):
//   - 화가(painter) 가 붓으로 상자·그림을 그린다 (정확한 색, 아무 크기 — 붓 끝은 각졌다)
//   - 글 원본(크기 단계마다 하나)이 자기 상태(글·색·자리·굵게)를 맞추고 **자신을 복제**한다.
//     엔트리 복제본은 만드는 순간의 상태를 그대로 복사하므로 복제본 쪽 스크립트가 필요 없다.
// 그 뒤에는 아무것도 하지 않는다 — 스크롤마다 수백 개를 다시 그리면 너무 느리다.
//
// 쪽 번호는 스크롤 위치(sc)를 빌려 쓴다 (sc = 쪽 - 1, sc_max = 쪽 수 - 1). 그래서 스크롤 막대·
// 화살표 단추·키보드가 그대로 쪽 넘김이 된다 (page.mjs 의 scroll 이 레이아웃이면 ±1 쪽).
//
// ⚠ 재귀는 쪽 하나의 항목 수만큼이다 (상자 ≤ 400 · 글 ≤ 300 — pager 의 LAYOUT_LIMITS). 그림 칸은
//   많아서 반복 블록으로 나눠 그린다 (한 바퀴에 LJ_BATCH 구간).

import {
    num, text, add, sub, mul, div, quotient, eq, ne, gt, lt, le, ge, and,
    charAt, substring, strLen, indexOf,
    ifDo, ifElse, forever, breakLoop, moveTo, showSelf, hideSelf, writeText, textColor, textEffect,
    penDown, penUp, penColor, penSize, penClear, makeCloneOf, removeAllClones, mouseX, mouseY,
} from '../tools/dsl.mjs';
import { CODES, VIEW_W } from '../../src/lib/display.mjs';
import { LAYOUT_SIZES } from '../../src/lib/pager.mjs';
import { VIEW } from './theme.mjs';

export const LAY_LINE_H = LAYOUT_SIZES.map((s) => Math.round(s * 1.5));   // 원본 글상자 높이
const STRIP = 48;                    // 붓 굵기 상한 — 그보다 높은 상자는 띠 여러 개로
const LJ_BATCH = 250;                // 그림 구간을 한 바퀴에 몇 개 그리나 (재귀 깊이)

export const spec = {
    variables: [
        'pg_lay', 'ly_n', 'ly_nx', 'ly_nz', 'ly_nj', 'ly_prev',
        'ly_s', 'ly_i', 'ly_lo', 'ly_hi', 'ly_mid', 'ly_kc', 'ly_hh', 'ly_yy',
        'ly_j', 'ly_p', 'ly_col', 'ly_row', 'ly_len', 'ly_run', 'ly_batch', 'ly_done',
        'ly_mx', 'ly_my', 'ly_hit',
    ],
    lists: [
        'lx_s', 'lx_x', 'lx_y', 'lx_w', 'lx_h', 'lx_c',
        'lz_s', 'lz_x', 'lz_y', 'lz_w', 'lz_k', 'lz_c', 'lz_b', 'lz_l', 'lz_t',
        'lj_s', 'lj_x', 'lj_y', 'lj_n', 'lj_w', 'lj_d',
        'ly_th',
    ],
    signals: ['sig_lay'],
    functions: ['ly_bsx', 'ly_bsz', 'ly_bsj', 'ly_box', 'ly_strip', 'ly_txt', 'ly_img', 'ly_hitz'],
};

export function build(ctx) {
    const { V, L, get, set, inc, listGet, defineFunction, call, onSignal, onClick, sendSignal, put, go, ui } = ctx;
    const line = () => get(V.in_line);
    const num3 = (a) => add(num(0), substring(line(), num(a), num(a + 2)));
    const code = (expr) => sub(indexOf(text(CODES), expr), num(1));
    const pal = (c) => listGet(L.pal, add(c, num(1)));

    // ------------------------------------------------------------ 받기 (page.mjs 의 in_one 이 펼친다)
    const ingest = [
        ifDo(eq(get(V.in_c), text('M')), [
            set(V.in_hit, num(1)),
            set(V.pg_lay, num(1)),
            set(V.ly_n, add(num(0), substring(line(), num(2), get(V.in_len)))),
        ]),
        ifDo(eq(get(V.in_c), text('X')), [
            set(V.in_hit, num(1)),
            inc(V.ly_nx, num(1)),
            put(L.lx_s, get(V.ly_nx), num3(2)), put(L.lx_x, get(V.ly_nx), num3(5)), put(L.lx_y, get(V.ly_nx), num3(8)),
            put(L.lx_w, get(V.ly_nx), num3(11)), put(L.lx_h, get(V.ly_nx), num3(14)),
            put(L.lx_c, get(V.ly_nx), code(charAt(line(), num(17)))),
        ]),
        ifDo(eq(get(V.in_c), text('Z')), [
            set(V.in_hit, num(1)),
            inc(V.ly_nz, num(1)),
            put(L.lz_s, get(V.ly_nz), num3(2)), put(L.lz_x, get(V.ly_nz), num3(5)), put(L.lz_y, get(V.ly_nz), num3(8)),
            put(L.lz_w, get(V.ly_nz), num3(11)),
            put(L.lz_k, get(V.ly_nz), code(charAt(line(), num(14)))),
            put(L.lz_c, get(V.ly_nz), code(charAt(line(), num(15)))),
            put(L.lz_b, get(V.ly_nz), add(num(0), charAt(line(), num(16)))),
            put(L.lz_l, get(V.ly_nz), add(num(0), substring(line(), num(17), num(20)))),
            ifElse(gt(get(V.in_len), num(20)),
                [put(L.lz_t, get(V.ly_nz), substring(line(), num(21), get(V.in_len)))],
                [put(L.lz_t, get(V.ly_nz), text(''))]),
        ]),
        ifDo(eq(get(V.in_c), text('J')), [
            set(V.in_hit, num(1)),
            inc(V.ly_nj, num(1)),
            put(L.lj_s, get(V.ly_nj), num3(2)), put(L.lj_x, get(V.ly_nj), num3(5)), put(L.lj_y, get(V.ly_nj), num3(8)),
            put(L.lj_n, get(V.ly_nj), add(num(0), charAt(line(), num(11)))),
            put(L.lj_w, get(V.ly_nj), add(num(0), substring(line(), num(12), num(13)))),
            ifElse(gt(get(V.in_len), num(13)),
                [put(L.lj_d, get(V.ly_nj), substring(line(), num(14), get(V.in_len)))],
                [put(L.lj_d, get(V.ly_nj), text(''))]),
        ]),
    ];
    const reset = [
        set(V.pg_lay, num(0)), set(V.ly_n, num(0)),
        set(V.ly_nx, num(0)), set(V.ly_nz, num(0)), set(V.ly_nj, num(0)),
    ];
    // 받은 뒤 — 쪽 수를 스크롤 끝으로 (sc 는 이미 0)
    const after = [
        ifDo(eq(get(V.pg_lay), num(1)), [set(V.sc_max, sub(get(V.ly_n), num(1)))]),
        set(V.ly_prev, num(-1)),
    ];

    // ------------------------------------------------------------ 쪽의 첫 항목 (쪽 순서로 왔다 — 이진 탐색)
    const bs = (name, list, n) => defineFunction(name, [
        ifDo(lt(get(V.ly_lo), get(V.ly_hi)), [
            set(V.ly_mid, quotient(add(get(V.ly_lo), get(V.ly_hi)), num(2))),
            ifElse(lt(listGet(list, get(V.ly_mid)), get(V.ly_s)),
                [set(V.ly_lo, add(get(V.ly_mid), num(1)))],
                [set(V.ly_hi, get(V.ly_mid))]),
            call(name),
        ]),
    ]);
    bs('ly_bsx', L.lx_s); bs('ly_bsz', L.lz_s); bs('ly_bsj', L.lj_s);
    const first = (fn, n) => [set(V.ly_lo, num(1)), set(V.ly_hi, add(get(n), num(1))), call(fn), set(V.ly_i, get(V.ly_lo))];
    const curScreen = set(V.ly_s, add(get(V.sc), num(1)));

    // ------------------------------------------------------------ 화가 — 상자
    // 상자 하나 = 가로 획 하나 (굵기 = 높이). 높으면 STRIP 씩 띠로 (ly_strip)
    defineFunction('ly_strip', [
        ifDo(gt(get(V.ly_hh), num(0)), [
            set(V.ly_run, get(V.ly_hh)),
            ifDo(gt(get(V.ly_run), num(STRIP)), [set(V.ly_run, num(STRIP))]),
            penSize(get(V.ly_run)),
            moveTo(add(num(VIEW.left), listGet(L.lx_x, get(V.ly_i))), sub(num(VIEW.top), add(get(V.ly_yy), div(get(V.ly_run), num(2))))),
            penDown(),
            moveTo(add(num(VIEW.left), add(listGet(L.lx_x, get(V.ly_i)), listGet(L.lx_w, get(V.ly_i)))),
                sub(num(VIEW.top), add(get(V.ly_yy), div(get(V.ly_run), num(2))))),
            penUp(),
            inc(V.ly_yy, get(V.ly_run)),
            inc(V.ly_hh, sub(num(0), get(V.ly_run))),
            call('ly_strip'),
        ]),
    ]);
    defineFunction('ly_box', [
        ifDo(le(get(V.ly_i), get(V.ly_nx)), [
            ifDo(eq(listGet(L.lx_s, get(V.ly_i)), get(V.ly_s)), [
                penColor(pal(listGet(L.lx_c, get(V.ly_i)))),
                set(V.ly_yy, listGet(L.lx_y, get(V.ly_i))),
                set(V.ly_hh, listGet(L.lx_h, get(V.ly_i))),
                call('ly_strip'),
                inc(V.ly_i, num(1)),
                call('ly_box'),
            ]),
        ]),
    ]);

    // ------------------------------------------------------------ 화가 — 그림 (색·길이 쌍을 구간마다 한 획)
    // ly_j 그림의 ly_p 번째 글자부터. 그림이 끝나면 다음 그림(같은 쪽일 때)으로 넘어간다
    defineFunction('ly_img', [
        ifDo(and(gt(get(V.ly_batch), num(0)), eq(get(V.ly_done), num(0))), [
            ifElse(gt(get(V.ly_p), strLen(listGet(L.lj_d, get(V.ly_j)))),
                [
                    inc(V.ly_j, num(1)), set(V.ly_p, num(1)), set(V.ly_col, num(0)), set(V.ly_row, num(0)),
                    ifElse(gt(get(V.ly_j), get(V.ly_nj)), [set(V.ly_done, num(1))],
                        [ifDo(ne(listGet(L.lj_s, get(V.ly_j)), get(V.ly_s)), [set(V.ly_done, num(1))])]),
                ],
                [
                    set(V.ly_len, code(charAt(listGet(L.lj_d, get(V.ly_j)), add(get(V.ly_p), num(1))))),
                    set(V.ly_run, mul(get(V.ly_len), listGet(L.lj_n, get(V.ly_j)))),
                    penColor(pal(code(charAt(listGet(L.lj_d, get(V.ly_j)), get(V.ly_p))))),
                    penSize(listGet(L.lj_n, get(V.ly_j))),
                    set(V.ly_yy, sub(num(VIEW.top), add(add(listGet(L.lj_y, get(V.ly_j)), mul(get(V.ly_row), listGet(L.lj_n, get(V.ly_j)))),
                        div(listGet(L.lj_n, get(V.ly_j)), num(2))))),
                    moveTo(add(num(VIEW.left), add(listGet(L.lj_x, get(V.ly_j)), mul(get(V.ly_col), listGet(L.lj_n, get(V.ly_j))))), get(V.ly_yy)),
                    penDown(),
                    moveTo(add(num(VIEW.left), add(add(listGet(L.lj_x, get(V.ly_j)), mul(get(V.ly_col), listGet(L.lj_n, get(V.ly_j)))), get(V.ly_run))), get(V.ly_yy)),
                    penUp(),
                    inc(V.ly_col, get(V.ly_len)),
                    ifDo(ge(get(V.ly_col), listGet(L.lj_w, get(V.ly_j))), [set(V.ly_col, num(0)), inc(V.ly_row, num(1))]),
                    inc(V.ly_p, num(2)),
                ]),
            inc(V.ly_batch, num(-1)),
            call('ly_img'),
        ]),
    ]);

    onSignal(ui.painter, 'sig_lay', [
        penClear(),
        ifDo(and(eq(get(V.pg_lay), num(1)), gt(get(V.ly_n), num(0))), [
            curScreen,
            ...first('ly_bsx', V.ly_nx),
            call('ly_box'),
            ...first('ly_bsj', V.ly_nj),
            set(V.ly_j, get(V.ly_i)),
            set(V.ly_p, num(1)), set(V.ly_col, num(0)), set(V.ly_row, num(0)), set(V.ly_done, num(0)),
            ifElse(gt(get(V.ly_j), get(V.ly_nj)), [set(V.ly_done, num(1))],
                [ifDo(ne(listGet(L.lj_s, get(V.ly_j)), get(V.ly_s)), [set(V.ly_done, num(1))])]),
            forever([
                ifDo(eq(get(V.ly_done), num(1)), [breakLoop()]),
                set(V.ly_batch, num(LJ_BATCH)),
                call('ly_img'),
            ]),
        ]),
    ]);

    // ------------------------------------------------------------ 글 원본 — 자기 크기의 조각마다 상태를 맞추고 복제
    defineFunction('ly_txt', [
        ifDo(le(get(V.ly_i), get(V.ly_nz)), [
            ifDo(eq(listGet(L.lz_s, get(V.ly_i)), get(V.ly_s)), [
                ifDo(eq(listGet(L.lz_k, get(V.ly_i)), get(V.ly_kc)), [
                    writeText(listGet(L.lz_t, get(V.ly_i))),
                    textColor(pal(listGet(L.lz_c, get(V.ly_i)))),
                    ifElse(eq(listGet(L.lz_b, get(V.ly_i)), num(1)), [textEffect('fontBold', true)], [textEffect('fontBold', false)]),
                    moveTo(add(num(VIEW.left + VIEW_W / 2), listGet(L.lz_x, get(V.ly_i))),
                        sub(num(VIEW.top), add(listGet(L.lz_y, get(V.ly_i)), div(listGet(L.ly_th, add(get(V.ly_kc), num(1))), num(2))))),
                    showSelf(),
                    makeCloneOf('self'),
                ]),
                inc(V.ly_i, num(1)),
                call('ly_txt'),
            ]),
        ]),
    ]);
    // 누르기 — 마우스 자리가 이 쪽의 링크 조각 위인가
    defineFunction('ly_hitz', [
        ifDo(and(le(get(V.ly_i), get(V.ly_nz)), eq(get(V.ly_hit), num(0))), [
            ifDo(eq(listGet(L.lz_s, get(V.ly_i)), get(V.ly_s)), [
                ifDo(gt(listGet(L.lz_l, get(V.ly_i)), num(0)), [
                    ifDo(and(ge(get(V.ly_mx), listGet(L.lz_x, get(V.ly_i))), le(get(V.ly_mx), add(listGet(L.lz_x, get(V.ly_i)), listGet(L.lz_w, get(V.ly_i))))), [
                        ifDo(and(ge(get(V.ly_my), listGet(L.lz_y, get(V.ly_i))),
                            le(get(V.ly_my), add(listGet(L.lz_y, get(V.ly_i)), listGet(L.ly_th, add(listGet(L.lz_k, get(V.ly_i)), num(1)))))), [
                            set(V.ly_hit, listGet(L.lz_l, get(V.ly_i))),
                        ]),
                    ]),
                ]),
                inc(V.ly_i, num(1)),
                call('ly_hitz'),
            ]),
        ]),
    ]);
    ui.layText.forEach((box, k) => {
        onSignal(box, 'sig_lay', [
            removeAllClones(),
            hideSelf(),
            ifDo(and(eq(get(V.pg_lay), num(1)), gt(get(V.ly_n), num(0))), [
                curScreen,
                set(V.ly_kc, num(k)),
                ...first('ly_bsz', V.ly_nz),
                call('ly_txt'),
                hideSelf(),
            ]),
        ]);
        onClick(box, [
            ifDo(eq(get(V.pg_lay), num(1)), [
                curScreen,
                set(V.ly_mx, sub(mouseX(), num(VIEW.left))),
                set(V.ly_my, sub(num(VIEW.top), mouseY())),
                set(V.ly_hit, num(0)),
                ...first('ly_bsz', V.ly_nz),
                call('ly_hitz'),
                ifDo(gt(get(V.ly_hit), num(0)), go(1, listGet(L.ln_href, get(V.ly_hit)))),
            ]),
        ]);
    });

    const init = LAY_LINE_H.map((h) => ctx.listAdd(L.ly_th, num(h)));
    return { ingest, reset, after, init };
}
