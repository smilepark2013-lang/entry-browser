// src/page.mjs — 페이지: 줄 목록 받기 · 보이는 줄 배정 · 그리기 · 이동 · 마우스/키
//
// 엔트리는 HTML 을 **파싱하지 않는다.** 중계 앱이 배치를 끝낸 줄 목록(display.mjs)을
// 보내고, 여기서는 줄마다 substring 몇 번으로 읽어 리스트에 넣는다 (줄당 상수 시간).
//
// 그리기 — 스타일마다 글상자를 미리 만들어 둔다 (풀). 스크롤할 때마다:
//   1. logic 이 **보이는 줄**을 찾아 풀의 칸에 배정한다 (rd_line[칸] = 줄 번호)
//   2. sig_paint → 칸마다 자기 줄을 읽어 글·색·자리를 칠한다 (글상자 이동은 entry-ppt 실기 확인)
//
// 🔴 이 파일이 지키는 엔트리 규칙
//   - `그리고/또는` 은 **양쪽을 다 계산한다.** 그 안에서 리스트를 읽으면 범위 밖 오류로
//     작품이 멈춘다 (실기: 짧은 페이지의 빈 줄에 마우스를 올리자 튕겼다). 리스트 읽기는
//     늘 `만약` 안쪽에 둔다.
//   - 페이지를 바꿀 때 리스트를 **비우지 않는다.** 1500줄짜리 리스트 7개를 반복 블록으로
//     비우면 그것만 25초다. 대신 앞에서부터 **덮어쓰고** pg_n 까지만 읽는다.
//   - 펼치기(<details>)는 그 자리에서 접고 편다. 접힌 묶음의 줄은 ln_h=1 (높이 0) 이고,
//     접고 펼 때마다 logic 이 모든 줄의 y 를 다시 매긴다 (gd_step — 1500줄에 10프레임쯤).
//   - 일(받기·배정)은 logic 이 한다. 글상자는 **읽기만** 한다. logic 이 일하는 동안(ui_busy)
//     누른 것은 무시한다 — 신호가 일하는 스레드를 다시 시작시킨다.

import {
    num, text, add, sub, mul, div, quotient, eq, ne, gt, lt, le, ge, and, or,
    concat, charAt, substring, strLen, indexOf,
    ifDo, ifElse, forever, breakLoop, writeText, showSelf, hideSelf, moveTo,
    textColor, textBgColor, textFont, mouseX, mouseY, isClicked, not,
} from '../tools/dsl.mjs';
import { C, VIEW, THUMB, THUMB_TOP, THUMB_BOTTOM, FONT } from './theme.mjs';
import { STYLES, S, COLORS, BGS, CODES, MARK, MAX_SEGS, MAX_LINES, MAX_LINKS, INDENT_UNIT, RECORD_HEAD } from '../../src/lib/display.mjs';
import * as formMod from './form.mjs';
import * as layMod from './lay.mjs';
import { isWebUrl } from './web.mjs';

export const HOME = 'index.html';
// 글꼴 이름 후보 — 확인 페이지(ruler.html)에서 f 키로 돌려 본다. 엔트리는 이 문자열을 CSS font-family 로
// 쓴다. 실기에서 셋 다 나눔고딕을 불러오지 못하고 맑은 고딕으로 떨어졌다 (display.textPx 가 맑은 고딕 표를 쓰는 이유).
export const FACES = [FONT, 'Nanum Gothic', 'NanumGothic'];

const STYLE_IDS = Object.keys(STYLES).map(Number).filter((s) => s > 0);
const IN_BATCH = 300;               // 한 프레임에 받는 줄 수 (재귀 깊이 — 한계 ≈900 아래. 예전 150)

/** 풀의 칸 배치: 스타일 s 의 k 번째(0부터) 칸 → 전체 칸 번호(1부터) */
export const SLOTS = (() => {
    const off = {}; let n = 0;
    for (const s of STYLE_IDS) { off[s] = n; n += STYLES[s].pool; }
    return { off, total: n, slot: (s, k) => off[s] + k + 1 };
})();
/** 여분 글상자(조각) 배치 — 스타일 s 의 k 번째 → 전체 번호(1부터). ovl 이 없는 스타일은 0개 */
export const OVL = (() => {
    const off = {}; let n = 0;
    for (const s of STYLE_IDS) { off[s] = n; n += STYLES[s].ovl || 0; }
    return { off, total: n, slot: (s, k) => off[s] + k + 1 };
})();

export const spec = {
    variables: [
        // 현재 페이지
        'br_url', 'br_src', 'pg_title', 'pg_n', 'pg_nl', 'pg_h', 'sc', 'sc_max',
        'pg_np', 'pg_nb', 'pg_bg',              // 이 페이지의 글자색·바탕색 수, 페이지 바탕 (렌더 모드의 CSS)
        'pg_org', 'pg_q',                       // 이 페이지의 출처 (https://host — '/' 로 시작하는 링크에 붙인다)
        'pg_g', 'pg_ng', 'in_gap',              // 받는 중인 펼치기 묶음 · 묶음 수 · 앞 간격
        'ui_fold', 'gd_i', 'gd_y', 'gd_g', 'gd_ok', 'gd_batch',   // 접고 펴기 · 줄 y 다시 매기기
        'ui_font',                              // 글꼴 이름 후보 번호 (FACES, 1부터)
        'pg_ns', 'ov_j', 'ov_n', 'sg_k',        // 조각 수 · 배정 중인 조각 · 그리는 조각
        // 받기
        'in_rest', 'in_line', 'in_p', 'in_c', 'in_s', 'in_hit', 'in_len', 'in_batch', 'in_done',
        // 배정
        'rd_i', 'rd_k', 'rd_s', 'rd_h', 'bs_lo', 'bs_hi', 'bs_mid',
        // 이동 — 무엇을(nv_to) 어떻게(nv_kind: 1 새로 2 뒤로 3 앞으로 4 다시) → 결과(nv_final, nv_ok)
        'nv_to', 'nv_kind', 'nv_final', 'nv_ok', 'nv_q', 'nv_hit', 'nv_n',
        // 화면 상태 (logic 이 쓰고 화면 오브젝트가 읽는다)
        'ui_busy', 'ui_msg', 'ui_strip', 'ui_hov',
        // 마우스 (mouse 오브젝트만 쓴다)
        'ms_x', 'ms_y', 'ms_py', 'ms_h', 'ms_lo', 'ms_hi', 'ms_mid',
        // 누른 자리의 링크 (칸 오브젝트가 쓴다 — 누르기는 한 번에 하나다)
        'ck_line', 'ck_x', 'ck_hit', 'ck_rest', 'ck_a', 'ck_b', 'ck_c', 'ck_p',
        'sb_r',                                 // 스크롤 막대 끌기
        'pk', 'ph',                             // 그리는 칸 번호 · 줄 높이 (칸 스레드가 적고 바로 함수를 부른다)
    ],
    lists: [
        // 줄마다 하나씩 (덮어쓴다 — pg_n 까지만 유효)
        'ln_s', 'ln_x', 'ln_l', 'ln_c', 'ln_b', 'ln_t', 'ln_y', 'ln_k',
        'ln_g', 'ln_d', 'ln_h', 'ln_gp',        // 든 묶음 · 요약 줄이면 그 묶음 · 숨음 · 앞 간격(px)
        'gp_par', 'gp_open', 'gp_line',         // 묶음마다: 바깥 묶음 · 펼침 · 요약 첫 줄
        'ft_names',
        'ln_sg', 'ln_sn', 'ln_ov',              // 줄의 첫 조각 · 조각 수 · 이번 배정에서 조각으로 그리나
        'sg_x', 'sg_s', 'sg_n', 'sg_c', 'sg_l', // 조각마다: x · 시작 글자 · 글자 수 · 색 · 줄
        'rd_ov', 'ov_cnt', 'ov_cap', 'ov_off',  // 여분 글상자 배정 (rd_line 과 같은 꼴)
        'ln_href',                              // 링크 (pg_nl 까지만 유효)
        'rd_line', 'rd_cnt', 'rd_off', 'rd_cap', 'st_lh', 'pal', 'bgs',
        'br_hist', 'br_fwd', 'br_pname', 'br_pdata',
    ],
    signals: ['sig_go', 'sig_paint', 'sig_hover', 'sig_status', 'sig_strip', 'sig_addr', 'sig_fold', 'sig_font'],
    functions: ['in_step', 'in_one', 'gd_vis', 'gd_step', 'ft_set', 'rd_ovf', 'rd_ovc', 'rd_seg', 'ck_do', 'ck_ov', 'rd_clr', 'rd_bs', 'rd_fill', 'rd_lay', 'ms_bs', 'ms_tick', 'ck_find', 'rd_one', 'rd_rule', 'rd_hov', 'ck_click', 'sb_drag'],
};

export function build(ctx) {
    const {
        V, L, get, set, inc, listAdd, listGet, listLen, listPop, listSet,
        until, defineFunction, call, onSignal, onKey, onClick, onStart, sendSignal, ask, answer,
        logic, ui, web, status, pages,
    } = ctx;

    const idle = () => and(eq(get(V.ui_busy), num(0)), eq(get(V.ui_modal), num(0)));
    /** 리스트 i 번째에 쓴다. 모자라면 늘린다 (비우지 않고 덮어쓰는 이유는 위 주석) */
    const put = (list, idx, val) => ifElse(le(idx, listLen(list)), [listSet(list, idx, val)], [listAdd(list, val)]);

    // 칸 pk 가 보여 줄 줄 = rd_line[pk] (0 이면 빈 칸). 그리기 함수들이 쓴다.
    const lineOf = () => listGet(L.rd_line, get(V.pk));
    const field = (list) => listGet(list, lineOf());
    const yOf = sub(sub(num(VIEW.top), div(get(V.ph), num(2))), sub(field(L.ln_y), get(V.sc)));
    /** 다른 오브젝트가 쓰는 이동 입구. 일하는 중이면 무시한다. */
    const go = (kind, toExpr) => [
        ifDo(idle(), [set(V.nv_kind, num(kind)), set(V.nv_to, toExpr), sendSignal('sig_go')]),
    ];
    const repaint = [call('rd_lay'), sendSignal('sig_paint')];

    const form = formMod.build({ ...ctx, put, go, repaint, lineOf, yOf });
    const lay = layMod.build({ ...ctx, put, go });

    // ================================================================== 받기
    // in_rest 에서 한 줄 떼어 in_line 에. 줄 하나 = substring 두 번 (V8 은 잘라낸 문자열을 복사하지 않는다)
    defineFunction('in_one', [
        set(V.in_len, strLen(get(V.in_line))),
        ifDo(gt(get(V.in_len), num(0)), [
            set(V.in_c, charAt(get(V.in_line), num(1))),
            set(V.in_hit, num(0)),
            ifDo(eq(get(V.in_c), text('T')), [
                set(V.in_hit, num(1)),
                ifElse(gt(get(V.in_len), num(1)),
                    [set(V.pg_title, substring(get(V.in_line), num(2), get(V.in_len)))],
                    [set(V.pg_title, text(''))]),
            ]),
            ifDo(eq(get(V.in_c), text('U')), [
                set(V.in_hit, num(1)),
                ifDo(lt(get(V.pg_nl), num(MAX_LINKS)), [
                    inc(V.pg_nl, num(1)),
                    ifElse(gt(get(V.in_len), num(1)),
                        // '/' 로 시작하면 같은 출처의 경로만 온 것 — 출처를 붙인다
                        [ifElse(eq(charAt(get(V.in_line), num(2)), text('/')),
                            [put(L.ln_href, get(V.pg_nl), concat(get(V.pg_org), substring(get(V.in_line), num(2), get(V.in_len))))],
                            [put(L.ln_href, get(V.pg_nl), substring(get(V.in_line), num(2), get(V.in_len)))])],
                        [put(L.ln_href, get(V.pg_nl), text(''))]),
                ]),
            ]),
            // 페이지 색 — 기본 색표 뒤에 덮어쓴다 (P 글자색 · Q 바탕색 · G 페이지 바탕)
            ifDo(eq(get(V.in_c), text('P')), [
                set(V.in_hit, num(1)),
                ifDo(lt(add(get(V.pg_np), num(COLORS.length)), num(CODES.length)), [
                    inc(V.pg_np, num(1)),
                    put(L.pal, add(get(V.pg_np), num(COLORS.length)), substring(get(V.in_line), num(2), get(V.in_len))),
                ]),
            ]),
            ifDo(eq(get(V.in_c), text('Q')), [
                set(V.in_hit, num(1)),
                ifDo(lt(add(get(V.pg_nb), num(BGS.length)), num(CODES.length)), [
                    inc(V.pg_nb, num(1)),
                    put(L.bgs, add(get(V.pg_nb), num(BGS.length)), substring(get(V.in_line), num(2), get(V.in_len))),
                ]),
            ]),
            ifDo(eq(get(V.in_c), text('G')), [
                set(V.in_hit, num(1)),
                set(V.pg_bg, substring(get(V.in_line), num(2), get(V.in_len))),
            ]),
            // 펼치기 — D<0|1><묶음>: 앞 줄이 요약 줄. 첫 D 가 묶음을 연다. E: 묶음을 닫는다
            ifDo(eq(get(V.in_c), text('D')), [
                set(V.in_hit, num(1)),
                set(V.in_s, substring(get(V.in_line), num(3), get(V.in_len))),
                ifDo(ne(get(V.pg_g), get(V.in_s)), [
                    put(L.gp_par, get(V.in_s), get(V.pg_g)),
                    put(L.gp_open, get(V.in_s), add(num(0), charAt(get(V.in_line), num(2)))),
                    put(L.gp_line, get(V.in_s), get(V.pg_n)),
                    set(V.pg_g, get(V.in_s)),
                    set(V.pg_ng, get(V.in_s)),
                ]),
                // 요약 줄 자신은 바깥 묶음에 든다 (접어도 보인다)
                ifDo(gt(get(V.pg_n), num(0)), [
                    listSet(L.ln_g, get(V.pg_n), listGet(L.gp_par, get(V.in_s))),
                    listSet(L.ln_d, get(V.pg_n), get(V.in_s)),
                ]),
            ]),
            // 조각 — R<XXX><SSS><NNN><C>: 앞 줄의 x · 시작 글자 · 글자 수 · 색
            ifDo(eq(get(V.in_c), text('R')), [
                set(V.in_hit, num(1)),
                ifDo(and(gt(get(V.pg_n), num(0)), lt(get(V.pg_ns), num(MAX_SEGS))), [
                    inc(V.pg_ns, num(1)),
                    put(L.sg_x, get(V.pg_ns), add(num(0), substring(get(V.in_line), num(2), num(4)))),
                    put(L.sg_s, get(V.pg_ns), add(num(0), substring(get(V.in_line), num(5), num(7)))),
                    put(L.sg_n, get(V.pg_ns), add(num(0), substring(get(V.in_line), num(8), num(10)))),
                    put(L.sg_c, get(V.pg_ns), sub(indexOf(text(CODES), charAt(get(V.in_line), num(11))), num(1))),
                    put(L.sg_l, get(V.pg_ns), get(V.pg_n)),
                    ifDo(eq(listGet(L.ln_sn, get(V.pg_n)), num(0)), [listSet(L.ln_sg, get(V.pg_n), get(V.pg_ns))]),
                    listSet(L.ln_sn, get(V.pg_n), add(listGet(L.ln_sn, get(V.pg_n)), num(1))),
                ]),
            ]),
            ifDo(eq(get(V.in_c), text('E')), [
                set(V.in_hit, num(1)),
                ifDo(gt(get(V.pg_g), num(0)), [set(V.pg_g, listGet(L.gp_par, get(V.pg_g)))]),
            ]),
            // 양식 · 칸 · 선택지 · 칸 모양 (src/form.mjs)
            ...form.ingest,
            // 레이아웃 모드 — 쪽 수 · 상자 · 글 조각 · 그림 (src/lay.mjs)
            ...lay.ingest,
            // 링크 구간 — 바로 앞 줄에 붙인다
            ifDo(eq(get(V.in_c), text('K')), [
                set(V.in_hit, num(1)),
                ifDo(gt(get(V.pg_n), num(0)), [
                    ifElse(gt(get(V.in_len), num(1)),
                        [put(L.ln_k, get(V.pg_n), substring(get(V.in_line), num(2), get(V.in_len)))],
                        [put(L.ln_k, get(V.pg_n), text(''))]),
                ]),
            ]),
            // 줄 기록: <S><II><LLLL><C><B><글>
            ifDo(and(eq(get(V.in_hit), num(0)), ge(get(V.in_len), num(RECORD_HEAD))), [
                set(V.in_s, add(num(0), get(V.in_c))),
                ifElse(eq(get(V.in_s), num(0)),
                    // 간격 줄 — 저장하지 않고 높이만 더한다
                    [
                        inc(V.pg_h, add(num(0), substring(get(V.in_line), num(2), num(3)))),
                        inc(V.in_gap, add(num(0), substring(get(V.in_line), num(2), num(3)))),
                    ],
                    [ifDo(and(lt(get(V.pg_n), num(MAX_LINES)), and(ge(get(V.in_s), num(1)), le(get(V.in_s), num(STYLE_IDS.length)))), [
                        inc(V.pg_n, num(1)),
                        put(L.ln_s, get(V.pg_n), get(V.in_s)),
                        put(L.ln_x, get(V.pg_n), mul(add(num(0), substring(get(V.in_line), num(2), num(3))), num(INDENT_UNIT))),
                        put(L.ln_l, get(V.pg_n), add(num(0), substring(get(V.in_line), num(4), num(7)))),
                        // 색 번호는 한 글자 (CODES 의 자리). ⚠ 페이지 색이 늦게 와도 그리기 전에는 다 와 있다
                        put(L.ln_c, get(V.pg_n), sub(indexOf(text(CODES), charAt(get(V.in_line), num(8))), num(1))),
                        put(L.ln_b, get(V.pg_n), sub(indexOf(text(CODES), charAt(get(V.in_line), num(9))), num(1))),
                        ifElse(gt(get(V.in_len), num(RECORD_HEAD)),
                            [put(L.ln_t, get(V.pg_n), substring(get(V.in_line), num(RECORD_HEAD + 1), get(V.in_len)))],
                            [put(L.ln_t, get(V.pg_n), text(''))]),
                        put(L.ln_y, get(V.pg_n), get(V.pg_h)),
                        put(L.ln_k, get(V.pg_n), text('')),
                        put(L.ln_g, get(V.pg_n), get(V.pg_g)),
                        put(L.ln_d, get(V.pg_n), num(0)),
                        put(L.ln_h, get(V.pg_n), num(0)),
                        put(L.ln_gp, get(V.pg_n), get(V.in_gap)),
                        put(L.ln_sg, get(V.pg_n), num(0)),
                        put(L.ln_sn, get(V.pg_n), num(0)),
                        put(L.ln_ov, get(V.pg_n), num(0)),
                        set(V.in_gap, num(0)),
                        ...form.onRecord,
                        inc(V.pg_h, listGet(L.st_lh, get(V.in_s))),
                    ])]),
            ]),
        ]),
    ]);

    defineFunction('in_step', [
        ifDo(gt(get(V.in_batch), num(0)), [
            ifElse(eq(strLen(get(V.in_rest)), num(0)),
                [set(V.in_done, num(1))],
                [
                    set(V.in_p, indexOf(get(V.in_rest), text('\n'))),
                    ifElse(eq(get(V.in_p), num(0)),
                        [set(V.in_line, get(V.in_rest)), set(V.in_rest, text(''))],
                        [
                            ifElse(gt(get(V.in_p), num(1)),
                                [set(V.in_line, substring(get(V.in_rest), num(1), sub(get(V.in_p), num(1))))],
                                [set(V.in_line, text(''))]),
                            ifElse(lt(get(V.in_p), strLen(get(V.in_rest))),
                                [set(V.in_rest, substring(get(V.in_rest), add(get(V.in_p), num(1)), strLen(get(V.in_rest))))],
                                [set(V.in_rest, text(''))]),
                        ]),
                    call('in_one'),
                ]),
            inc(V.in_batch, num(-1)),
            call('in_step'),
        ]),
    ]);

    // ================================================================== 펼치기
    // 줄 gd_g 의 묶음부터 바깥으로 올라가며 하나라도 접혀 있으면 gd_ok = 0 (재귀 깊이 = 묶음 깊이)
    defineFunction('gd_vis', [
        ifDo(gt(get(V.gd_g), num(0)), [
            ifElse(eq(listGet(L.gp_open, get(V.gd_g)), num(0)),
                [set(V.gd_ok, num(0)), set(V.gd_g, num(0))],
                [set(V.gd_g, listGet(L.gp_par, get(V.gd_g)))]),
            call('gd_vis'),
        ]),
    ]);
    // 줄 y 다시 매기기 — 한 번에 gd_batch 줄. 숨은 줄은 높이 0 (y 는 다음 줄과 같다 → 이진 탐색이 그대로 된다)
    defineFunction('gd_step', [
        ifDo(and(gt(get(V.gd_batch), num(0)), le(get(V.gd_i), get(V.pg_n))), [
            set(V.gd_ok, num(1)),
            set(V.gd_g, listGet(L.ln_g, get(V.gd_i))),
            call('gd_vis'),
            ifElse(eq(get(V.gd_ok), num(1)),
                [
                    inc(V.gd_y, listGet(L.ln_gp, get(V.gd_i))),
                    listSet(L.ln_y, get(V.gd_i), get(V.gd_y)),
                    listSet(L.ln_h, get(V.gd_i), num(0)),
                    inc(V.gd_y, listGet(L.st_lh, listGet(L.ln_s, get(V.gd_i)))),
                ],
                [listSet(L.ln_y, get(V.gd_i), get(V.gd_y)), listSet(L.ln_h, get(V.gd_i), num(1))]),
            inc(V.gd_i, num(1)),
            inc(V.gd_batch, num(-1)),
            call('gd_step'),
        ]),
    ]);
    const relayout = [
        set(V.gd_i, num(1)),
        set(V.gd_y, num(0)),
        forever([
            ifDo(gt(get(V.gd_i), get(V.pg_n)), [breakLoop()]),
            set(V.gd_batch, num(IN_BATCH)),
            call('gd_step'),
        ]),
        set(V.pg_h, get(V.gd_y)),
        set(V.sc_max, sub(get(V.pg_h), num(VIEW.h))),
        ifDo(lt(get(V.sc_max), num(0)), [set(V.sc_max, num(0))]),
        ifDo(gt(get(V.sc), get(V.sc_max)), [set(V.sc, get(V.sc_max))]),
    ];
    // 요약 줄을 누르면 (ck_click → ui_fold) — 펼침을 뒤집고, 요약 줄의 ▶/▼ 를 바꾸고, 다시 배치
    onSignal(logic, 'sig_fold', [
        set(V.ui_busy, num(1)),
        listSet(L.gp_open, get(V.ui_fold), sub(num(1), listGet(L.gp_open, get(V.ui_fold)))),
        set(V.gd_i, listGet(L.gp_line, get(V.ui_fold))),
        ifDo(gt(get(V.gd_i), num(0)), [
            ifDo(ge(strLen(listGet(L.ln_t, get(V.gd_i))), num(2)), [
                listSet(L.ln_t, get(V.gd_i), concat(
                    charAt(text(MARK.closed + MARK.opened), add(listGet(L.gp_open, get(V.ui_fold)), num(1))),
                    substring(listGet(L.ln_t, get(V.gd_i)), num(2), strLen(listGet(L.ln_t, get(V.gd_i)))))),
            ]),
        ]),
        ...relayout,
        call('rd_lay'),
        set(V.ui_busy, num(0)),
        sendSignal('sig_paint'),
    ]);

    /** br_src(줄 목록 문자열) → ln_* 리스트 */
    const ingest = [
        set(V.pg_n, num(0)), set(V.pg_nl, num(0)), set(V.pg_h, num(0)), set(V.pg_title, text('')),
        set(V.pg_np, num(0)), set(V.pg_nb, num(0)), set(V.pg_bg, text(C.card)),
        set(V.pg_g, num(0)), set(V.pg_ng, num(0)), set(V.in_gap, num(0)), set(V.pg_ns, num(0)),
        // 출처 = br_url 의 '://' 다음 첫 '/' 앞까지 (작품 안의 페이지면 '')
        set(V.pg_org, text('')),
        set(V.pg_q, indexOf(get(V.br_url), text('://'))),
        ifDo(gt(get(V.pg_q), num(0)), [
            set(V.pg_org, substring(get(V.br_url), add(get(V.pg_q), num(3)), strLen(get(V.br_url)))),
            ifElse(gt(indexOf(get(V.pg_org), text('/')), num(0)),
                [set(V.pg_org, substring(get(V.br_url), num(1), add(get(V.pg_q), add(num(1), indexOf(get(V.pg_org), text('/'))))))],
                [set(V.pg_org, get(V.br_url))]),
        ]),
        ...form.reset,
        ...lay.reset,
        set(V.in_rest, get(V.br_src)),
        set(V.in_done, num(0)),
        forever([
            ifDo(eq(get(V.in_done), num(1)), [breakLoop()]),
            set(V.in_batch, num(IN_BATCH)),
            call('in_step'),
        ]),
        set(V.sc, num(0)),
        set(V.sc_max, sub(get(V.pg_h), num(VIEW.h))),
        ifDo(lt(get(V.sc_max), num(0)), [set(V.sc_max, num(0))]),
        // 펼치기가 있으면 접힌 묶음을 숨기고 y 를 다시 매긴다
        ifDo(gt(get(V.pg_ng), num(0)), relayout),
        ...lay.after,
    ];

    // ================================================================== 배정
    defineFunction('rd_clr', [
        ifDo(le(get(V.rd_k), num(SLOTS.total)), [listSet(L.rd_line, get(V.rd_k), num(0)), inc(V.rd_k, num(1)), call('rd_clr')]),
    ]);
    // 처음으로 ln_y >= sc 인 줄 (이진 탐색 — 재귀 깊이 log2(1500) ≈ 11)
    defineFunction('rd_bs', [
        ifDo(lt(get(V.bs_lo), get(V.bs_hi)), [
            set(V.bs_mid, quotient(add(get(V.bs_lo), get(V.bs_hi)), num(2))),
            ifElse(lt(listGet(L.ln_y, get(V.bs_mid)), get(V.sc)),
                [set(V.bs_lo, add(get(V.bs_mid), num(1)))],
                [set(V.bs_hi, get(V.bs_mid))]),
            call('rd_bs'),
        ]),
    ]);
    // 보이는 줄을 풀에 배정한다. 줄이 화면 아래로 넘어가면 멈춘다 (재귀 깊이 = 보이는 줄 수)
    defineFunction('rd_fill', [
        ifDo(le(get(V.rd_i), get(V.pg_n)), [
            set(V.rd_s, listGet(L.ln_s, get(V.rd_i))),
            ifElse(eq(listGet(L.ln_h, get(V.rd_i)), num(1)),
                [set(V.rd_h, num(0))],                  // 접힌 묶음의 줄 — 건너뛴다
                [set(V.rd_h, listGet(L.st_lh, get(V.rd_s)))]),
            ifDo(le(add(listGet(L.ln_y, get(V.rd_i)), get(V.rd_h)), add(get(V.sc), num(VIEW.h))), [
                ifDo(and(gt(get(V.rd_h), num(0)), lt(listGet(L.rd_cnt, get(V.rd_s)), listGet(L.rd_cap, get(V.rd_s)))), [
                    listSet(L.rd_cnt, get(V.rd_s), add(listGet(L.rd_cnt, get(V.rd_s)), num(1))),
                    listSet(L.rd_line, add(listGet(L.rd_off, get(V.rd_s)), listGet(L.rd_cnt, get(V.rd_s))), get(V.rd_i)),
                    // 조각 — 그 줄의 조각이 **다** 들어갈 때만 쓴다 (일부만 그리면 글이 빈다)
                    listSet(L.ln_ov, get(V.rd_i), num(0)),
                    ifDo(and(gt(listGet(L.ln_sn, get(V.rd_i)), num(0)),
                        le(add(listGet(L.ov_cnt, get(V.rd_s)), listGet(L.ln_sn, get(V.rd_i))), listGet(L.ov_cap, get(V.rd_s)))), [
                        set(V.ov_j, num(0)),
                        set(V.ov_n, listGet(L.ln_sn, get(V.rd_i))),
                        call('rd_ovf'),
                        listSet(L.ln_ov, get(V.rd_i), num(1)),
                    ]),
                ]),
                inc(V.rd_i, num(1)),
                call('rd_fill'),
            ]),
        ]),
    ]);
    // 줄 rd_i 의 조각 ov_j(0부터)..ov_n 을 여분 글상자에 (재귀 깊이 = 그 줄의 조각 수)
    defineFunction('rd_ovf', [
        ifDo(lt(get(V.ov_j), get(V.ov_n)), [
            listSet(L.ov_cnt, get(V.rd_s), add(listGet(L.ov_cnt, get(V.rd_s)), num(1))),
            listSet(L.rd_ov, add(listGet(L.ov_off, get(V.rd_s)), listGet(L.ov_cnt, get(V.rd_s))), add(listGet(L.ln_sg, get(V.rd_i)), get(V.ov_j))),
            inc(V.ov_j, num(1)),
            call('rd_ovf'),
        ]),
    ]);
    defineFunction('rd_ovc', [
        ifDo(le(get(V.rd_k), num(OVL.total)), [listSet(L.rd_ov, get(V.rd_k), num(0)), inc(V.rd_k, num(1)), call('rd_ovc')]),
    ]);
    defineFunction('rd_lay', [
        set(V.rd_k, num(1)),
        call('rd_clr'),
        set(V.rd_k, num(1)),
        call('rd_ovc'),
        ...STYLE_IDS.map((s) => listSet(L.rd_cnt, num(s), num(0))),
        ...STYLE_IDS.map((s) => listSet(L.ov_cnt, num(s), num(0))),
        set(V.bs_lo, num(1)),
        set(V.bs_hi, add(get(V.pg_n), num(1))),
        call('rd_bs'),
        set(V.rd_i, get(V.bs_lo)),
        call('rd_fill'),
    ]);
    // ================================================================== 이동
    const clearFwd = until(le(listLen(L.br_fwd), num(0)), [listPop(L.br_fwd, listLen(L.br_fwd))]);
    // 성공했을 때만 기록을 고친다. 그래서 요청을 취소하면 아무 일도 없던 것이 된다.
    const commit = [
        ifDo(eq(get(V.nv_kind), num(1)), [
            ifDo(gt(strLen(get(V.br_url)), num(0)), [listAdd(L.br_hist, get(V.br_url))]),
            clearFwd,
        ]),
        ifDo(eq(get(V.nv_kind), num(2)), [
            listAdd(L.br_fwd, get(V.br_url)),
            ifDo(gt(listLen(L.br_hist), num(0)), [listPop(L.br_hist, listLen(L.br_hist))]),
        ]),
        ifDo(eq(get(V.nv_kind), num(3)), [
            listAdd(L.br_hist, get(V.br_url)),
            ifDo(gt(listLen(L.br_fwd), num(0)), [listPop(L.br_fwd, listLen(L.br_fwd))]),
        ]),
        set(V.br_url, get(V.nv_final)),
    ];

    const local = [
        set(V.nv_hit, num(0)),
        set(V.nv_n, num(1)),
        until(gt(get(V.nv_n), listLen(L.br_pname)), [
            ifDo(eq(listGet(L.br_pname, get(V.nv_n)), get(V.nv_to)), [set(V.nv_hit, get(V.nv_n))]),
            inc(V.nv_n, num(1)),
        ]),
        ifElse(eq(get(V.nv_hit), num(0)),
            [set(V.br_src, concat(text(pages.notFoundHead), concat(get(V.nv_to), text(pages.notFoundTail))))],
            [set(V.br_src, listGet(L.br_pdata, get(V.nv_hit)))]),
        set(V.nv_final, get(V.nv_to)),
        set(V.nv_ok, num(1)),
    ];

    const loadedMsg = concat(concat(text('  '), get(V.pg_title)),
        concat(text('   ·   링크 '), concat(get(V.pg_nl), text('개'))));
    // 레이아웃 모드 — 제목 · 쪽 n / N
    const layMsg = concat(concat(text('  '), get(V.pg_title)),
        concat(text('   ·   '), concat(add(get(V.sc), num(1)), concat(text(' / '), concat(get(V.ly_n), text('쪽'))))));
    /** 레이아웃 모드에서 쪽이 바뀌었으면 다시 그린다 (sc = 쪽 - 1) */
    const layFlip = [
        ifDo(eq(get(V.pg_lay), num(1)), [
            ifDo(ne(get(V.sc), get(V.ly_prev)), [
                set(V.ly_prev, get(V.sc)),
                set(V.ui_msg, layMsg),
                sendSignal('sig_status'),
                sendSignal('sig_lay'),
            ]),
        ]),
    ];

    onSignal(logic, 'sig_go', [
        set(V.ui_busy, num(1)),
        set(V.nv_ok, num(0)),
        ...status('  불러오는 중…'),
        ifElse(isWebUrl(get(V.nv_to)), web.fetch, local),
        ifDo(eq(get(V.nv_ok), num(1)), [
            ...status('  그리는 중…'),
            ...commit,
            ...ingest,
            set(V.ui_hov, num(0)),
            set(V.ui_msg, loadedMsg),
            ifDo(eq(get(V.pg_lay), num(1)), [set(V.ui_msg, layMsg)]),
        ]),
        call('rd_lay'),
        set(V.ui_busy, num(0)),
        sendSignal('sig_paint'),
        sendSignal('sig_status'),
        // 레이아웃 쪽을 그린다 (레이아웃이 아니면 지난 쪽의 복제본·붓을 지운다)
        set(V.ly_prev, get(V.sc)),
        sendSignal('sig_lay'),
    ]);

    const back =[ifDo(gt(listLen(L.br_hist), num(0)), go(2, listGet(L.br_hist, listLen(L.br_hist))))];
    const fwd = [ifDo(gt(listLen(L.br_fwd), num(0)), go(3, listGet(L.br_fwd, listLen(L.br_fwd))))];
    const reload = [ifDo(idle(), [set(V.wb_nocache, num(1)), ...go(4, get(V.br_url))])];
    const home = go(1, text(HOME));

    // 주소 입력 — 묻기는 **logic** 이 한다. 보이는 오브젝트가 물으면 그 위에 말풍선이 뜬다.
    onSignal(logic, 'sig_addr', [
        set(V.ui_modal, num(1)),
        ask('주소 (예: ko.wikipedia.org) — 빈 칸이면 그대로'),
        set(V.nv_q, answer()),
        set(V.ui_modal, num(0)),
        ifDo(gt(strLen(get(V.nv_q)), num(0)), [
            // :// 가 없으면 https:// 를 붙인다. `help.html` 처럼 / 없는 .html 은 이 작품 안의 페이지다.
            ifDo(and(eq(indexOf(get(V.nv_q), text('://')), num(0)),
                or(eq(indexOf(get(V.nv_q), text('.html')), num(0)), gt(indexOf(get(V.nv_q), text('/')), num(0)))),
            [set(V.nv_q, concat(text('https://'), get(V.nv_q)))]),
            ...go(1, get(V.nv_q)),
        ]),
    ]);
    const askAddress = [ifDo(idle(), [sendSignal('sig_addr')])];

    // ================================================================== 그리기 (칸마다)
    // 칸 pk 가 보여 줄 줄 = rd_line[pk]. 0 이면 숨는다.
    //
    // 🔴 그리기·바탕·누르기는 **공용 함수**다. 칸 70개에 몸통을 하나씩 두면 블록이 만 개를
    //   넘는다. 칸의 스레드는 자기 번호(pk)와 줄 높이(ph)를 적고 함수를 부를 뿐이다.
    //   함수는 **부른 오브젝트로** 실행되고(글 쓰기·옮기기가 그 칸에 먹는다), 반복이 없어
    //   중간에 다른 스레드가 끼어들지 않는다 — 그래서 전역 pk 를 써도 섞이지 않는다.
    // 바탕 — 마우스가 올라간 링크·칸 줄이면 밝게. ⚠ `그리고` 를 쓰지 않는다 (위 주석)
    //   (이 식은 lineOf() > 0 일 때만 계산된다 — 부르는 쪽이 `만약` 으로 감싼다)
    const bgOf = ifElse(eq(get(V.ui_hov), lineOf()),
        [ifElse(or(or(gt(field(L.ln_l), num(0)), gt(field(L.ln_w), num(0))), gt(field(L.ln_d), num(0))), [textBgColor(C.hover)],
            [textBgColor(listGet(L.bgs, add(field(L.ln_b), num(1))))])],
        [textBgColor(listGet(L.bgs, add(field(L.ln_b), num(1))))]);

    defineFunction('rd_one', [
        ifElse(gt(lineOf(), num(0)),
            [
                ifElse(eq(field(L.ln_ov), num(1)),
                    [ifElse(gt(listGet(L.sg_s, field(L.ln_sg)), num(1)),
                        [writeText(substring(field(L.ln_t), num(1), sub(listGet(L.sg_s, field(L.ln_sg)), num(1))))],
                        [writeText(text(''))])],
                    [writeText(field(L.ln_t))]),
                textColor(listGet(L.pal, add(field(L.ln_c), num(1)))),
                bgOf,
                // 들여쓰기는 앱이 공백으로 넣어 보낸다 — 상자는 늘 같은 x (옮기면 카드 밖으로 튀어나온다)
                moveTo(num(VIEW.left + VIEW.w / 2), yOf),
                showSelf(),
            ],
            [hideSelf()]),
    ]);
    // 조각 — 여분 글상자 pk 가 rd_ov[pk] 번 조각을 그 줄의 y, 줄 시작 + x 에 그린다 (바탕은 투명 — 줄 글상자의
    // 바탕·마우스 올림 밝힘이 그대로 비친다)
    const seg = (list) => listGet(list, get(V.sg_k));
    defineFunction('rd_seg', [
        set(V.sg_k, listGet(L.rd_ov, get(V.pk))),
        ifElse(gt(get(V.sg_k), num(0)),
            [
                writeText(substring(listGet(L.ln_t, seg(L.sg_l)), seg(L.sg_s), sub(add(seg(L.sg_s), seg(L.sg_n)), num(1)))),
                textColor(listGet(L.pal, add(seg(L.sg_c), num(1)))),
                moveTo(add(num(VIEW.left + VIEW.w / 2), seg(L.sg_x)),
                    sub(sub(num(VIEW.top), div(get(V.ph), num(2))), sub(listGet(L.ln_y, seg(L.sg_l)), get(V.sc)))),
                showSelf(),
            ],
            [hideSelf()]),
    ]);
    defineFunction('rd_rule', [
        ifElse(gt(lineOf(), num(0)), [moveTo(num(VIEW.left + VIEW.w / 2), yOf), showSelf()], [hideSelf()]),
    ]);
    defineFunction('rd_hov', [ifDo(gt(lineOf(), num(0)), [bgOf])]);
    // 누르면 — 칸의 모양 줄이면 그 칸을 다루고(src/form.mjs), 아니면 링크:
    // 누른 x 가 링크 구간(ln_k) 안이면 그 링크, 아니면 그 줄의 링크
    defineFunction('ck_click', [ifDo(gt(lineOf(), num(0)), [set(V.ck_line, lineOf()), call('ck_do')])]);
    defineFunction('ck_ov', [
        set(V.sg_k, listGet(L.rd_ov, get(V.pk))),
        ifDo(gt(get(V.sg_k), num(0)), [set(V.ck_line, listGet(L.sg_l, get(V.sg_k))), call('ck_do')]),
    ]);
    // 줄 ck_line 을 눌렀다 — 요약 줄이면 접고 펴고, 칸이면 칸을, 아니면 누른 x 의 링크로
    defineFunction('ck_do', [
        ifDo(gt(get(V.ck_line), num(0)), [
            ifElse(gt(listGet(L.ln_d, get(V.ck_line)), num(0)),
                [ifDo(idle(), [set(V.ui_fold, listGet(L.ln_d, get(V.ck_line))), sendSignal('sig_fold')])],
                [ifElse(gt(listGet(L.ln_w, get(V.ck_line)), num(0)),
                [ifDo(idle(), [set(V.ui_field, listGet(L.ln_w, get(V.ck_line))), sendSignal('sig_field')])],
                [
                    set(V.ck_x, sub(mouseX(), add(num(VIEW.left), listGet(L.ln_x, get(V.ck_line))))),   // ln_x 는 지금 늘 0 (들여쓰기는 공백)
                    set(V.ck_hit, num(0)),
                    set(V.ck_rest, listGet(L.ln_k, get(V.ck_line))),
                    call('ck_find'),
                    ifDo(eq(get(V.ck_hit), num(0)), [set(V.ck_hit, listGet(L.ln_l, get(V.ck_line)))]),
                    ifDo(gt(get(V.ck_hit), num(0)), go(1, listGet(L.ln_href, get(V.ck_hit)))),
                ])]),
        ]),
    ]);

    for (const s of STYLE_IDS) {
        const st = STYLES[s];
        (ui.ovl[s] || []).forEach((box, i) => {
            const me = [set(V.pk, num(OVL.slot(s, i))), set(V.ph, num(st.lh))];
            onSignal(box, 'sig_paint', [...me, call('rd_seg')]);
            onClick(box, [...me, call('ck_ov')]);
            onSignal(box, 'sig_font', [call('ft_set')]);
        });
        ui.pools[s].forEach((box, i) => {
            const k = SLOTS.slot(s, i);
            const me = [set(V.pk, num(k)), set(V.ph, num(st.lh))];
            if (s === S.range) {
                // 슬라이더: 막대와 손잡이가 **같은 칸**을 본다. 둘 다 누르면 끌기가 시작된다
                onSignal(box, 'sig_paint', [...me, call('rd_track')]);
                onSignal(ui.knobs[i], 'sig_paint', [...me, call('rd_knob')]);
                onClick(box, [...me, call('rg_drag')]);
                onClick(ui.knobs[i], [...me, call('rg_drag')]);
                return;
            }
            onSignal(box, 'sig_paint', [...me, call(s === S.rule ? 'rd_rule' : 'rd_one')]);
            if (s !== S.rule && STYLES[s].font === 'sans') onSignal(box, 'sig_font', [call('ft_set')]);
            if (s !== S.rule) {
                onSignal(box, 'sig_hover', [...me, call('rd_hov')]);
                onClick(box, [...me, call('ck_click')]);
            }
        });
    }
    // 주소창 — https:// 는 떼고 보여 준다
    onSignal(ui.pagebg, 'sig_paint', [textBgColor(get(V.pg_bg))]);
    onSignal(ui.url, 'sig_paint', [
        ifElse(eq(indexOf(get(V.br_url), text('https://')), num(1)),
            [writeText(substring(get(V.br_url), num(9), strLen(get(V.br_url))))],
            [writeText(get(V.br_url))]),
    ]);
    onClick(ui.url, askAddress);
    onClick(ui.pill, askAddress);

    onSignal(ui.status, 'sig_status', [writeText(get(V.ui_msg))]);

    onSignal(ui.thumb, 'sig_paint', [
        ifElse(gt(get(V.sc_max), num(0)),
            [
                showSelf(),
                moveTo(num(THUMB.x), sub(num(THUMB_TOP), mul(div(get(V.sc), get(V.sc_max)), num(THUMB_TOP - THUMB_BOTTOM)))),
            ],
            [hideSelf()]),
    ]);

    onSignal(ui.sbar, 'sig_paint', [ifElse(gt(get(V.sc_max), num(0)), [showSelf()], [hideSelf()])]);
    // 끌기 — 막대(손잡이)나 그 길(sbar)을 누른 채 움직이면 그 높이로 간다. 손잡이 가운데가 마우스를 따라온다.
    defineFunction('sb_drag', [
        ifDo(and(eq(get(V.ui_busy), num(0)), gt(get(V.sc_max), num(0))), [
            forever([
                ifDo(not(isClicked()), [breakLoop()]),
                set(V.sb_r, div(sub(num(THUMB_TOP), mouseY()), num(THUMB_TOP - THUMB_BOTTOM))),
                ifDo(lt(get(V.sb_r), num(0)), [set(V.sb_r, num(0))]),
                ifDo(gt(get(V.sb_r), num(1)), [set(V.sb_r, num(1))]),
                // 레이아웃 모드면 가까운 쪽으로 (반올림)
                ifElse(eq(get(V.pg_lay), num(1)),
                    [set(V.sc, quotient(add(mul(get(V.sb_r), get(V.sc_max)), num(0.5)), num(1)))],
                    [set(V.sc, quotient(mul(get(V.sb_r), get(V.sc_max)), num(1)))]),
                call('rd_lay'),
                sendSignal('sig_paint'),
                ...layFlip,
            ]),
        ]),
    ]);
    onClick(ui.thumb, [call('sb_drag')]);
    onClick(ui.sbar, [call('sb_drag')]);

    onSignal(ui.strip, 'sig_strip', [ifElse(eq(get(V.ui_strip), num(1)), [showSelf()], [hideSelf()])]);

    // ================================================================== 조작
    const scrollTo = (expr) => [
        ifDo(eq(get(V.ui_busy), num(0)), [
            set(V.sc, expr),
            ifDo(gt(get(V.sc), get(V.sc_max)), [set(V.sc, get(V.sc_max))]),
            ifDo(lt(get(V.sc), num(0)), [set(V.sc, num(0))]),
            ...repaint,
            ...layFlip,
        ]),
    ];
    // 레이아웃 모드에서는 스크롤 대신 한 쪽씩 (sc 가 쪽 번호다)
    const scroll = (d) => [ifElse(eq(get(V.pg_lay), num(1)),
        scrollTo(add(get(V.sc), num(Math.sign(d)))),
        scrollTo(add(get(V.sc), num(d))))];
    const PAGE = VIEW.h - 30;

    onClick(ui.btn.back, back);
    onClick(ui.btn.fwd, fwd);
    onClick(ui.btn.reload, reload);
    onClick(ui.btn.home, home);
    onClick(ui.btn.up, scroll(-PAGE));
    onClick(ui.btn.down, scroll(PAGE));

    onKey(ui.keys, 38, scroll(-45));            // ↑
    onKey(ui.keys, 40, scroll(45));             // ↓
    onKey(ui.keys, 33, scroll(-PAGE));          // PageUp
    onKey(ui.keys, 34, scroll(PAGE));           // PageDown
    onKey(ui.keys, 32, scroll(PAGE));           // Space
    onKey(ui.keys, 36, scrollTo(num(0)));       // Home
    onKey(ui.keys, 35, scrollTo(get(V.sc_max))); // End
    onKey(ui.keys, 8, back);                    // Backspace
    onKey(ui.keys, 71, askAddress);             // g
    onKey(ui.keys, 82, reload);                 // r
    onKey(ui.keys, 72, home);                   // h
    // f — 글꼴 이름 후보를 돌린다 (확인 페이지용). 글상자마다 ft_set 을 부른다. 필드라 식을 못 꽂아 갈래로 편다
    defineFunction('ft_set', FACES.map((f, i) => ifDo(eq(get(V.ui_font), num(i + 1)), [textFont(f)])));
    onKey(ui.keys, 70, [
        inc(V.ui_font, num(1)),
        ifDo(gt(get(V.ui_font), num(FACES.length)), [set(V.ui_font, num(1))]),
        sendSignal('sig_font'),
        set(V.ui_msg, concat(text('  글꼴 이름: '), listGet(L.ft_names, get(V.ui_font)))),
        sendSignal('sig_status'),
        sendSignal('sig_paint'),
    ]);
    // 안전밸브 — 일이 도중에 죽으면 누를 길이 사라진다. UI 가 아니다 (entry-ppt)
    [27, 192].forEach((k) => onKey(ui.keys, k, [set(V.ui_busy, num(0)), set(V.ui_modal, num(0))]));

    // ================================================================== 마우스를 올린 줄
    // mouse 오브젝트 혼자 돈다 (한 프레임에 한 번, 바뀔 때만 알린다).
    // 마지막으로 ln_y <= py 인 줄을 찾는다 — logic 과 다른 변수(ms_*)를 쓴다.
    defineFunction('ms_bs', [
        ifDo(lt(get(V.ms_lo), get(V.ms_hi)), [
            set(V.ms_mid, quotient(add(add(get(V.ms_lo), get(V.ms_hi)), num(1)), num(2))),
            ifElse(gt(listGet(L.ln_y, get(V.ms_mid)), get(V.ms_py)),
                [set(V.ms_hi, sub(get(V.ms_mid), num(1)))],
                [set(V.ms_lo, get(V.ms_mid))]),
            call('ms_bs'),
        ]),
    ]);
    // 링크 구간 "x0,x1,링크;x0,x1,링크" 에서 ck_x 를 덮는 링크를 찾는다 (재귀 깊이 = 구간 수)
    const takeTo = (sep, dst) => [
        set(V.ck_p, indexOf(get(V.ck_rest), text(sep))),
        ifElse(eq(get(V.ck_p), num(0)),
            [set(dst, get(V.ck_rest)), set(V.ck_rest, text(''))],
            [
                ifElse(gt(get(V.ck_p), num(1)),
                    [set(dst, substring(get(V.ck_rest), num(1), sub(get(V.ck_p), num(1))))],
                    [set(dst, text(''))]),
                ifElse(lt(get(V.ck_p), strLen(get(V.ck_rest))),
                    [set(V.ck_rest, substring(get(V.ck_rest), add(get(V.ck_p), num(1)), strLen(get(V.ck_rest))))],
                    [set(V.ck_rest, text(''))]),
            ]),
    ];
    defineFunction('ck_find', [
        ifDo(and(gt(strLen(get(V.ck_rest)), num(0)), eq(get(V.ck_hit), num(0))), [
            ...takeTo(',', V.ck_a),
            ...takeTo(',', V.ck_b),
            ...takeTo(';', V.ck_c),
            // 글자 폭이 어림값이라 양옆으로 3px 씩 봐준다
            ifDo(and(ge(get(V.ck_x), sub(get(V.ck_a), num(3))), le(get(V.ck_x), add(get(V.ck_b), num(3)))),
                [set(V.ck_hit, add(num(0), get(V.ck_c)))]),
            call('ck_find'),
        ]),
    ]);

    // 한 바퀴. 함수로 빼 둔 것은 시뮬레이터가 이것만 돌려 볼 수 있게 하려는 것이다
    // (빈 줄 위에 마우스를 올리면 튕기던 사고를 테스트로 막는다).
    defineFunction('ms_tick', [
            set(V.ms_h, num(0)),
            // 받는 중에는 리스트가 바뀌고 있다 — 손대지 않는다
            ifDo(and(eq(get(V.ui_busy), num(0)), gt(get(V.pg_n), num(0))), [
                set(V.ms_x, mouseX()),
                set(V.ms_y, mouseY()),
                ifDo(and(and(ge(get(V.ms_x), num(VIEW.left)), le(get(V.ms_x), num(VIEW.right))),
                    and(le(get(V.ms_y), num(VIEW.top)), ge(get(V.ms_y), num(VIEW.bottom)))), [
                    set(V.ms_py, add(get(V.sc), sub(num(VIEW.top), get(V.ms_y)))),
                    set(V.ms_lo, num(1)),
                    set(V.ms_hi, get(V.pg_n)),
                    call('ms_bs'),
                    // 찾은 줄이 정말 py 를 덮는가 (줄 사이 간격이면 아니다)
                    ifDo(and(le(listGet(L.ln_y, get(V.ms_lo)), get(V.ms_py)), eq(listGet(L.ln_h, get(V.ms_lo)), num(0))), [
                        ifDo(lt(get(V.ms_py), add(listGet(L.ln_y, get(V.ms_lo)), listGet(L.st_lh, listGet(L.ln_s, get(V.ms_lo))))), [
                            set(V.ms_h, get(V.ms_lo)),
                        ]),
                    ]),
                ]),
            ]),
            ifDo(ne(get(V.ms_h), get(V.ui_hov)), [set(V.ui_hov, get(V.ms_h)), sendSignal('sig_hover')]),
    ]);
    onStart(ui.mouse, [
        hideSelf(),
        set(V.ui_hov, num(0)),
        forever([call('ms_tick')]),
    ]);

    // ================================================================== 시작
    const init = [
        ...Array.from({ length: SLOTS.total }, () => listAdd(L.rd_line, num(0))),
        ...Array.from({ length: OVL.total }, () => listAdd(L.rd_ov, num(0))),
        ...STYLE_IDS.flatMap((s) => [
            listAdd(L.ov_cnt, num(0)),
            listAdd(L.ov_off, num(OVL.off[s])),
            listAdd(L.ov_cap, num(STYLES[s].ovl || 0)),
        ]),
        ...STYLE_IDS.flatMap((s) => [
            listAdd(L.rd_cnt, num(0)),
            listAdd(L.rd_off, num(SLOTS.off[s])),
            listAdd(L.rd_cap, num(STYLES[s].pool)),
            listAdd(L.st_lh, num(STYLES[s].lh)),
        ]),
        ...COLORS.map((c) => listAdd(L.pal, text(c))),
        ...FACES.map((f) => listAdd(L.ft_names, text(f))),
        set(V.ui_font, num(1)),
        ...BGS.map((c) => listAdd(L.bgs, text(c))),
        ...form.init,
        ...lay.init,
        ...pages.list.flatMap((p) => [listAdd(L.br_pname, text(p.name)), listAdd(L.br_pdata, text(p.body))]),
        set(V.ui_busy, num(0)),
        set(V.ui_strip, num(1)),
        set(V.br_url, text('')),
        set(V.pg_n, num(0)), set(V.pg_nl, num(0)), set(V.pg_h, num(0)),
        set(V.pg_np, num(0)), set(V.pg_nb, num(0)), set(V.pg_bg, text(C.card)),
        set(V.sc, num(0)), set(V.sc_max, num(0)),
        set(V.nv_kind, num(0)),
        set(V.nv_to, text(HOME)),
    ];

    return { init, start: [sendSignal('sig_go')] };
}
