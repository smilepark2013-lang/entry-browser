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
//
// 누르기 — 무대를 누르면(mouse_clicked) 이 쪽의 누를 자리(H)를 훑어 **마지막으로 맞은 것**을 고른다
// (칸이 링크보다 뒤에 온다). 링크면 이동, 칸이면 ui_field 를 세우고 sig_field (form.mjs 가 다룬다).
// 칸의 상태(□■○● · 입력한 값 · 고른 선택지)는 덧그림이 그린다: 화가가 칸 자리를 바탕색으로 덮고,
// 덧그림 글상자(layOver)가 복제본으로 글을 얹는다. 칸이 바뀌면 sig_lov — 덧그림만 다시 그린다.

import {
    num, text, add, sub, mul, div, quotient, eq, ne, gt, lt, le, ge, and, or, concat,
    charAt, substring, strLen, indexOf,
    ifDo, ifElse, forever, breakLoop, moveTo, showSelf, hideSelf, writeText, textColor, textEffect,
    penDown, penUp, penColor, penSize, penClear, makeCloneOf, removeAllClones, mouseX, mouseY,
} from '../tools/dsl.mjs';
import { CODES, VIEW_W, FIELD, MARK } from '../../src/lib/display.mjs';
import { LAYOUT_SIZES, LAY_LINE_H as LINE_H } from '../../src/lib/pager.mjs';
import { VIEW } from './theme.mjs';

export const LAY_LINE_H = LINE_H;           // 원본 글상자 높이 (pager 와 같은 값 — 조각의 y 가 이 상자 기준이다)
export const OVER_K = 4;                     // 덧그림 글 크기 단계 (11px)
const OVER_CHAR = 7;                         // 덧그림 글을 칸 폭에 맞춰 자를 때 한 글자 폭 어림 (px)
const STRIP = 48;                    // 붓 굵기 상한 — 그보다 높은 상자는 띠 여러 개로
const LJ_BATCH = 250;                // 그림 구간을 한 바퀴에 몇 개 그리나 (재귀 깊이)

export const spec = {
    variables: [
        'pg_lay', 'ly_n', 'ly_nx', 'ly_nz', 'ly_nj', 'ly_prev',
        'ly_s', 'ly_i', 'ly_lo', 'ly_hi', 'ly_mid', 'ly_kc', 'ly_hh', 'ly_yy',
        'ly_j', 'ly_p', 'ly_col', 'ly_row', 'ly_len', 'ly_run', 'ly_batch', 'ly_done',
        'ly_mx', 'ly_my', 'ly_hit', 'ly_nh', 'ly_bx', 'ly_bw', 'ly_f', 'ly_t', 'ly_q',
    ],
    lists: [
        'lx_s', 'lx_x', 'lx_y', 'lx_w', 'lx_h', 'lx_c',
        'lz_s', 'lz_x', 'lz_y', 'lz_w', 'lz_k', 'lz_c', 'lz_b', 'lz_l', 'lz_t',
        'lj_s', 'lj_x', 'lj_y', 'lj_n', 'lj_w', 'lj_d',
        'lh_s', 'lh_x', 'lh_y', 'lh_w', 'lh_h', 'lh_k', 'lh_n', 'lh_c',
        'ly_th',
    ],
    signals: ['sig_lay', 'sig_lov'],
    functions: ['ly_bsx', 'ly_bsz', 'ly_bsj', 'ly_bsh', 'ly_box', 'ly_strip', 'ly_txt', 'ly_img', 'ly_hith', 'ly_ovb', 'ly_ovt'],
};

export function build(ctx) {
    const { V, L, get, set, inc, listGet, defineFunction, call, onSignal, onMouse, sendSignal, put, go, ui } = ctx;
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
        // H<SSS><XXX><YYY><WWW><HHH><K><NNNN><C>
        ifDo(eq(get(V.in_c), text('H')), [
            set(V.in_hit, num(1)),
            inc(V.ly_nh, num(1)),
            put(L.lh_s, get(V.ly_nh), num3(2)), put(L.lh_x, get(V.ly_nh), num3(5)), put(L.lh_y, get(V.ly_nh), num3(8)),
            put(L.lh_w, get(V.ly_nh), num3(11)), put(L.lh_h, get(V.ly_nh), num3(14)),
            put(L.lh_k, get(V.ly_nh), charAt(line(), num(17))),
            put(L.lh_n, get(V.ly_nh), add(num(0), substring(line(), num(18), num(21)))),
            put(L.lh_c, get(V.ly_nh), code(charAt(line(), num(22)))),
        ]),
    ];
    const reset = [
        set(V.pg_lay, num(0)), set(V.ly_n, num(0)),
        set(V.ly_nx, num(0)), set(V.ly_nz, num(0)), set(V.ly_nj, num(0)), set(V.ly_nh, num(0)),
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
    bs('ly_bsx', L.lx_s); bs('ly_bsz', L.lz_s); bs('ly_bsj', L.lj_s); bs('ly_bsh', L.lh_s);
    const first = (fn, n) => [set(V.ly_lo, num(1)), set(V.ly_hi, add(get(n), num(1))), call(fn), set(V.ly_i, get(V.ly_lo))];
    const curScreen = set(V.ly_s, add(get(V.sc), num(1)));

    // ------------------------------------------------------------ 화가 — 상자
    // 상자 하나 = 가로 획 하나 (굵기 = 높이). 높으면 STRIP 씩 띠로 (ly_strip)
    defineFunction('ly_strip', [
        ifDo(gt(get(V.ly_hh), num(0)), [
            set(V.ly_run, get(V.ly_hh)),
            ifDo(gt(get(V.ly_run), num(STRIP)), [set(V.ly_run, num(STRIP))]),
            penSize(get(V.ly_run)),
            moveTo(add(num(VIEW.left), get(V.ly_bx)), sub(num(VIEW.top), add(get(V.ly_yy), div(get(V.ly_run), num(2))))),
            penDown(),
            moveTo(add(num(VIEW.left), add(get(V.ly_bx), get(V.ly_bw))), sub(num(VIEW.top), add(get(V.ly_yy), div(get(V.ly_run), num(2))))),
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
                set(V.ly_bx, listGet(L.lx_x, get(V.ly_i))), set(V.ly_bw, listGet(L.lx_w, get(V.ly_i))),
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

    // ------------------------------------------------------------ 덧그림 — 칸 자리를 바탕색으로 덮는다 (테두리 1px 는 남긴다)
    defineFunction('ly_ovb', [
        ifDo(le(get(V.ly_i), get(V.ly_nh)), [
            ifDo(eq(listGet(L.lh_s, get(V.ly_i)), get(V.ly_s)), [
                ifDo(and(eq(listGet(L.lh_k, get(V.ly_i)), text('F')), gt(listGet(L.lh_w, get(V.ly_i)), num(2))), [
                    penColor(pal(listGet(L.lh_c, get(V.ly_i)))),
                    set(V.ly_bx, add(listGet(L.lh_x, get(V.ly_i)), num(1))), set(V.ly_bw, sub(listGet(L.lh_w, get(V.ly_i)), num(2))),
                    set(V.ly_yy, add(listGet(L.lh_y, get(V.ly_i)), num(1))), set(V.ly_hh, sub(listGet(L.lh_h, get(V.ly_i)), num(2))),
                    call('ly_strip'),
                ]),
                inc(V.ly_i, num(1)),
                call('ly_ovb'),
            ]),
        ]),
    ]);
    const overBoxes = [curScreen, ...first('ly_bsh', V.ly_nh), call('ly_ovb')];

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
            ...overBoxes,
        ]),
    ]);
    // 칸이 바뀌었다 — 덧그림 바탕만 다시 (그 자리를 덮으므로 지울 필요가 없다)
    onSignal(ui.painter, 'sig_lov', [ifDo(eq(get(V.pg_lay), num(1)), overBoxes)]);

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
    });

    // ------------------------------------------------------------ 덧그림 글 — 칸의 지금 상태 (form.mjs 의 fm_* 를 읽는다)
    const MARKS = MARK.off + MARK.on + MARK.radioOff + MARK.radioOn;
    const fAt = (list) => listGet(list, get(V.ly_f));
    defineFunction('ly_ovt', [
        ifDo(le(get(V.ly_i), get(V.ly_nh)), [
            ifDo(eq(listGet(L.lh_s, get(V.ly_i)), get(V.ly_s)), [
                set(V.ly_f, listGet(L.lh_n, get(V.ly_i))),
                set(V.ly_t, text('')),
                ifDo(and(eq(listGet(L.lh_k, get(V.ly_i)), text('F')), and(ge(get(V.ly_f), num(1)), le(get(V.ly_f), get(V.pg_ni)))), [
                    set(V.ly_q, text('#1f2937')),
                    set(V.ly_bx, add(listGet(L.lh_x, get(V.ly_i)), num(4))),
                    // 칸 폭에 들어갈 글자 수 (어림)
                    set(V.ly_bw, quotient(sub(listGet(L.lh_w, get(V.ly_i)), num(6)), num(OVER_CHAR))),
                    ifDo(lt(get(V.ly_bw), num(1)), [set(V.ly_bw, num(1))]),
                    ifDo(eq(fAt(L.fm_type), text(FIELD.text)), [
                        ifElse(gt(strLen(fAt(L.fm_val)), num(0)), [set(V.ly_t, fAt(L.fm_val))],
                            [set(V.ly_t, fAt(L.fm_lab)), set(V.ly_q, text('#9ca3af'))]),
                    ]),
                    ifDo(eq(fAt(L.fm_type), text(FIELD.select)), [
                        ifDo(and(ge(fAt(L.fm_on), num(1)), le(fAt(L.fm_on), get(V.pg_no))), [
                            // 선택지 이름을 먼저 줄이고 ▾ 를 붙인다 (▾ 가 잘리지 않게)
                            set(V.ly_t, listGet(L.op_lab, fAt(L.fm_on))),
                            ifDo(gt(strLen(get(V.ly_t)), sub(get(V.ly_bw), num(2))), [
                                set(V.ly_t, substring(get(V.ly_t), num(1), sub(get(V.ly_bw), num(2)))),
                            ]),
                            set(V.ly_t, concat(get(V.ly_t), text(` ${MARK.select}`))),
                        ]),
                    ]),
                    // 체크박스 □■ · 라디오 ○● — 칸 가운데에
                    ifDo(eq(fAt(L.fm_type), text(FIELD.check)), [set(V.ly_t, charAt(text(MARKS), add(fAt(L.fm_on), num(1))))]),
                    ifDo(eq(fAt(L.fm_type), text(FIELD.radio)), [set(V.ly_t, charAt(text(MARKS), add(fAt(L.fm_on), num(3))))]),
                    ifDo(or(eq(fAt(L.fm_type), text(FIELD.check)), eq(fAt(L.fm_type), text(FIELD.radio))), [
                        set(V.ly_bx, add(listGet(L.lh_x, get(V.ly_i)), div(sub(listGet(L.lh_w, get(V.ly_i)), num(LAYOUT_SIZES[OVER_K])), num(2)))),
                    ]),
                    ifDo(gt(strLen(get(V.ly_t)), get(V.ly_bw)), [set(V.ly_t, substring(get(V.ly_t), num(1), get(V.ly_bw)))]),
                    ifDo(gt(strLen(get(V.ly_t)), num(0)), [
                        writeText(get(V.ly_t)),
                        textColor(get(V.ly_q)),
                        moveTo(add(num(VIEW.left + VIEW_W / 2), get(V.ly_bx)),
                            sub(num(VIEW.top), add(listGet(L.lh_y, get(V.ly_i)), div(listGet(L.lh_h, get(V.ly_i)), num(2))))),
                        showSelf(),
                        makeCloneOf('self'),
                    ]),
                ]),
                inc(V.ly_i, num(1)),
                call('ly_ovt'),
            ]),
        ]),
    ]);
    const overTexts = [
        removeAllClones(),
        hideSelf(),
        ifDo(and(eq(get(V.pg_lay), num(1)), gt(get(V.ly_n), num(0))), [
            curScreen, ...first('ly_bsh', V.ly_nh), call('ly_ovt'), hideSelf(),
        ]),
    ];
    onSignal(ui.layOver, 'sig_lay', overTexts);
    onSignal(ui.layOver, 'sig_lov', overTexts);

    // ------------------------------------------------------------ 누르기 — 이 쪽의 누를 자리 중 마지막으로 맞은 것
    defineFunction('ly_hith', [
        ifDo(le(get(V.ly_i), get(V.ly_nh)), [
            ifDo(eq(listGet(L.lh_s, get(V.ly_i)), get(V.ly_s)), [
                ifDo(and(ge(get(V.ly_mx), listGet(L.lh_x, get(V.ly_i))), le(get(V.ly_mx), add(listGet(L.lh_x, get(V.ly_i)), listGet(L.lh_w, get(V.ly_i))))), [
                    ifDo(and(ge(get(V.ly_my), listGet(L.lh_y, get(V.ly_i))), le(get(V.ly_my), add(listGet(L.lh_y, get(V.ly_i)), listGet(L.lh_h, get(V.ly_i))))), [
                        set(V.ly_hit, get(V.ly_i)),
                    ]),
                ]),
                inc(V.ly_i, num(1)),
                call('ly_hith'),
            ]),
        ]),
    ]);
    onMouse(ui.painter, [
        ifDo(and(eq(get(V.pg_lay), num(1)), and(eq(get(V.ui_busy), num(0)), eq(get(V.ui_modal), num(0)))), [
            set(V.ly_mx, sub(mouseX(), num(VIEW.left))),
            set(V.ly_my, sub(num(VIEW.top), mouseY())),
            ifDo(and(and(ge(get(V.ly_mx), num(0)), le(get(V.ly_mx), num(VIEW_W))), and(ge(get(V.ly_my), num(0)), le(get(V.ly_my), num(VIEW.h)))), [
                curScreen,
                set(V.ly_hit, num(0)),
                ...first('ly_bsh', V.ly_nh),
                call('ly_hith'),
                ifDo(gt(get(V.ly_hit), num(0)), [
                    ifElse(eq(listGet(L.lh_k, get(V.ly_hit)), text('L')),
                        go(1, listGet(L.ln_href, listGet(L.lh_n, get(V.ly_hit)))),
                        [set(V.ui_field, listGet(L.lh_n, get(V.ly_hit))), sendSignal('sig_field')]),
                ]),
            ]),
        ]),
    ]);

    const init = LAY_LINE_H.map((h) => ctx.listAdd(L.ly_th, num(h)));
    return { ingest, reset, after, init };
}
