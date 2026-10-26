// src/form.mjs — 양식: 입력 칸 받기 · 누르기 · 보내기 · 슬라이더 끌기
//
// 중계 앱이 양식(F)·칸(I)·선택지(O)를 줄 목록 머리에 싣고, 칸의 모양 줄 뒤에 W<칸> 을 붙인다
// (형식: src/lib/display.mjs). 여기서는:
//   - 받을 때 리스트에 넣는다 (page.mjs 의 in_one 이 이 모듈의 `ingest` 를 펼친다)
//   - 모양 줄을 누르면 sig_field → 칸 종류에 따라
//       글 칸     입력창을 열고 값을 칸 줄에 보인다. 양식에 글 칸이 하나뿐이면 바로 보낸다 (검색창)
//       체크박스  ■ □ 를 바꾼다      라디오  같은 양식·같은 name 을 끄고 이것을 켠다
//       선택 상자 다음 선택지로      보내기  주소를 만들어 이동한다
//   - 슬라이더는 그림(막대 + 손잡이)이고, 누른 채 끌면 값이 바뀐다
//
// 보내기는 **GET 만** 한다. 주소 = action ? name=value & … — `% & = + #` 와 공백은 여기서
// 이스케이프하고, 한글 같은 나머지는 중계 앱이 주소를 만들 때 인코딩한다(URL 이 알아서 한다).
//
// ⚠ `그리고/또는` 안에서는 **범위가 보장된** 리스트만 읽는다 (양쪽을 다 계산한다 — page.mjs 주석).
// ⚠ 칸은 페이지를 바꿀 때 비우지 않고 덮어쓴다. pg_nf / pg_ni / pg_no 까지만 유효하다.

import {
    num, text, add, sub, mul, div, quotient, eq, gt, lt, le, ge, and, or, not,
    concat, charAt, substring, strLen, indexOf,
    ifDo, ifElse, forever, breakLoop, moveTo, showSelf, hideSelf, mouseX, isClicked,
} from '../tools/dsl.mjs';
import { FIELD, MARK, RANGE, FIELD_COLS, STYLES } from '../../src/lib/display.mjs';
import { VIEW } from './theme.mjs';

const ESC_CHARS = '%&=+# ';
const ESC_TO = ['%25', '%26', '%3D', '%2B', '%23', '+'];
const VALUE_MAX = 300;               // 이스케이프 재귀 깊이 상한 (칸 재귀와 합쳐 900 안쪽)

export const spec = {
    variables: [
        'pg_nf', 'pg_ni', 'pg_no',
        'in_f', 'in_q', 'in_a', 'in_b', 'in_d', 'in_e', 'in_g', 'in_h', 'in_j', 'in_m', 'in_o',
        'ui_field', 'fx', 'fx_t', 'fx_l', 'fx_q', 'fx_n', 'fx_i',
        'fs_form', 'fs_btn', 'fs_q', 'fs_i', 'fs_t', 'fs_ok', 'fs_url',
        'fe_src', 'fe_out', 'fe_i', 'fe_c', 'fe_k',
        'rg_f', 'rg_line', 'rg_v', 'rk_f',
    ],
    lists: [
        'fo_meth', 'fo_act',
        'fm_form', 'fm_type', 'fm_name', 'fm_val', 'fm_lab', 'fm_on', 'fm_min', 'fm_max', 'fm_step', 'fm_line',
        'op_val', 'op_lab', 'ln_w', 'fe_tab',
    ],
    signals: ['sig_field'],
    functions: ['fm_q', 'fe_step', 'fm_rclr', 'fm_cnt', 'fm_sub', 'rd_track', 'rd_knob', 'rg_drag'],
};

export function build(ctx) {
    const {
        V, L, get, set, inc, listAdd, listGet, listSet, defineFunction, call, onSignal, sendSignal, ask, answer,
        logic, put, go, repaint, lineOf, yOf,
    } = ctx;
    const at = (list, i) => listGet(list, i);

    // ================================================================== 받기
    // in_line 의 2번째 글자부터를 탭으로 가른다. in_f 가 남은 글이다.
    const takeTab = (dst) => [
        set(V.in_q, indexOf(get(V.in_f), text('\t'))),
        ifElse(eq(get(V.in_q), num(0)),
            [set(dst, get(V.in_f)), set(V.in_f, text(''))],
            [
                ifElse(gt(get(V.in_q), num(1)),
                    [set(dst, substring(get(V.in_f), num(1), sub(get(V.in_q), num(1))))],
                    [set(dst, text(''))]),
                ifElse(lt(get(V.in_q), strLen(get(V.in_f))),
                    [set(V.in_f, substring(get(V.in_f), add(get(V.in_q), num(1)), strLen(get(V.in_f))))],
                    [set(V.in_f, text(''))]),
            ]),
    ];
    const rest = [ifElse(gt(get(V.in_len), num(1)),
        [set(V.in_f, substring(get(V.in_line), num(2), get(V.in_len)))], [set(V.in_f, text(''))])];

    // in_one 안에 펼쳐진다. in_c = 첫 글자, in_hit 를 세운다.
    const ingest = [
        ifDo(eq(get(V.in_c), text('F')), [
            set(V.in_hit, num(1)),
            ...rest, ...takeTab(V.in_a), ...takeTab(V.in_b),
            inc(V.pg_nf, num(1)),
            put(L.fo_meth, get(V.pg_nf), get(V.in_a)),
            put(L.fo_act, get(V.pg_nf), get(V.in_b)),
        ]),
        ifDo(eq(get(V.in_c), text('I')), [
            set(V.in_hit, num(1)),
            ...rest,
            ...takeTab(V.in_a), ...takeTab(V.in_b), ...takeTab(V.in_d), ...takeTab(V.in_e), ...takeTab(V.in_g),
            ...takeTab(V.in_h), ...takeTab(V.in_j), ...takeTab(V.in_m), ...takeTab(V.in_o),
            inc(V.pg_ni, num(1)),
            put(L.fm_form, get(V.pg_ni), add(num(0), get(V.in_a))),
            put(L.fm_type, get(V.pg_ni), get(V.in_b)),
            put(L.fm_name, get(V.pg_ni), get(V.in_d)),
            put(L.fm_val, get(V.pg_ni), get(V.in_e)),
            put(L.fm_lab, get(V.pg_ni), get(V.in_g)),
            put(L.fm_on, get(V.pg_ni), add(num(0), get(V.in_h))),
            put(L.fm_min, get(V.pg_ni), add(num(0), get(V.in_j))),
            put(L.fm_max, get(V.pg_ni), add(num(0), get(V.in_m))),
            put(L.fm_step, get(V.pg_ni), add(num(0), get(V.in_o))),
            put(L.fm_line, get(V.pg_ni), num(0)),
        ]),
        ifDo(eq(get(V.in_c), text('O')), [
            set(V.in_hit, num(1)),
            ...rest, ...takeTab(V.in_a), ...takeTab(V.in_b), ...takeTab(V.in_d),
            inc(V.pg_no, num(1)),
            put(L.op_val, get(V.pg_no), get(V.in_b)),
            put(L.op_lab, get(V.pg_no), get(V.in_d)),
        ]),
        // W<칸> — 바로 앞 줄이 그 칸의 모양이다
        ifDo(eq(get(V.in_c), text('W')), [
            set(V.in_hit, num(1)),
            ...rest,
            set(V.in_a, add(num(0), get(V.in_f))),
            ifDo(gt(get(V.pg_n), num(0)), [
                put(L.ln_w, get(V.pg_n), get(V.in_a)),
                ifDo(and(ge(get(V.in_a), num(1)), le(get(V.in_a), get(V.pg_ni))), [put(L.fm_line, get(V.in_a), get(V.pg_n))]),
            ]),
        ]),
    ];
    if (FIELD_COLS !== 9) throw new Error('I 줄의 칸 수가 바뀌었습니다 — form.mjs 의 takeTab 수를 맞추세요');
    const onRecord = [put(L.ln_w, get(V.pg_n), num(0))];
    const reset = [set(V.pg_nf, num(0)), set(V.pg_ni, num(0)), set(V.pg_no, num(0))];

    // ================================================================== 보내기
    // 글 하나를 이스케이프한다: fe_src → fe_out (재귀 깊이 = 글자 수)
    defineFunction('fe_step', [
        ifDo(le(get(V.fe_i), strLen(get(V.fe_src))), [
            set(V.fe_c, charAt(get(V.fe_src), get(V.fe_i))),
            set(V.fe_k, indexOf(text(ESC_CHARS), get(V.fe_c))),
            ifElse(gt(get(V.fe_k), num(0)),
                [set(V.fe_out, concat(get(V.fe_out), at(L.fe_tab, get(V.fe_k))))],
                [set(V.fe_out, concat(get(V.fe_out), get(V.fe_c)))]),
            inc(V.fe_i, num(1)),
            call('fe_step'),
        ]),
    ]);
    const encode = (expr) => [
        set(V.fe_src, expr),
        ifDo(gt(strLen(get(V.fe_src)), num(VALUE_MAX)), [set(V.fe_src, substring(get(V.fe_src), num(1), num(VALUE_MAX)))]),
        set(V.fe_out, text('')), set(V.fe_i, num(1)), call('fe_step'),
    ];

    // 양식 fs_form 의 칸을 차례로 실어 fs_q 를 만든다. 보내기 단추는 **누른 것(fs_btn)만** 싣는다.
    defineFunction('fm_q', [
        ifDo(le(get(V.fs_i), get(V.pg_ni)), [
            ifDo(eq(at(L.fm_form, get(V.fs_i)), get(V.fs_form)), [
                set(V.fs_t, at(L.fm_type, get(V.fs_i))),
                set(V.fs_ok, num(0)),
                ifDo(or(or(eq(get(V.fs_t), text(FIELD.text)), eq(get(V.fs_t), text(FIELD.hidden))),
                    or(eq(get(V.fs_t), text(FIELD.select)), eq(get(V.fs_t), text(FIELD.range)))), [set(V.fs_ok, num(1))]),
                ifDo(or(eq(get(V.fs_t), text(FIELD.check)), eq(get(V.fs_t), text(FIELD.radio))), [
                    ifDo(eq(at(L.fm_on, get(V.fs_i)), num(1)), [set(V.fs_ok, num(1))]),
                ]),
                ifDo(eq(get(V.fs_t), text(FIELD.submit)), [ifDo(eq(get(V.fs_i), get(V.fs_btn)), [set(V.fs_ok, num(1))])]),
                ifDo(eq(strLen(at(L.fm_name, get(V.fs_i))), num(0)), [set(V.fs_ok, num(0))]),
                ifDo(eq(get(V.fs_ok), num(1)), [
                    ifDo(gt(strLen(get(V.fs_q)), num(0)), [set(V.fs_q, concat(get(V.fs_q), text('&')))]),
                    ...encode(at(L.fm_name, get(V.fs_i))),
                    set(V.fs_q, concat(get(V.fs_q), concat(get(V.fe_out), text('=')))),
                    ...encode(at(L.fm_val, get(V.fs_i))),
                    set(V.fs_q, concat(get(V.fs_q), get(V.fe_out))),
                ]),
            ]),
            inc(V.fs_i, num(1)),
            call('fm_q'),
        ]),
    ]);

    // fs_form · fs_btn 을 세우고 부른다. GET 양식만 보낸다.
    defineFunction('fm_sub', [
        ifDo(and(ge(get(V.fs_form), num(1)), le(get(V.fs_form), get(V.pg_nf))), [
            ifDo(eq(at(L.fo_meth, get(V.fs_form)), text('G')), [
                set(V.fs_q, text('')), set(V.fs_i, num(1)), call('fm_q'),
                set(V.fs_url, at(L.fo_act, get(V.fs_form))),
                ifElse(gt(indexOf(get(V.fs_url), text('?')), num(0)),
                    [set(V.fs_url, concat(get(V.fs_url), concat(text('&'), get(V.fs_q))))],
                    [set(V.fs_url, concat(get(V.fs_url), concat(text('?'), get(V.fs_q))))]),
                ...go(1, get(V.fs_url)),
            ]),
        ]),
    ]);

    // 양식 fx 의 글 칸 수 → fx_n
    defineFunction('fm_cnt', [
        ifDo(le(get(V.fx_i), get(V.pg_ni)), [
            ifDo(and(eq(at(L.fm_form, get(V.fx_i)), at(L.fm_form, get(V.fx))), eq(at(L.fm_type, get(V.fx_i)), text(FIELD.text))),
                [inc(V.fx_n, num(1))]),
            inc(V.fx_i, num(1)),
            call('fm_cnt'),
        ]),
    ]);

    // 칸 줄의 글을 다시 쓴다 (모양 줄이 없는 칸이면 건너뛴다)
    const rewrite = (line, textExpr) => ifDo(gt(line, num(0)), [listSet(L.ln_t, line, textExpr)]);
    // "  ■ 이름표". 표시 글자는 표 문자열 "□■○●" 에서 꺼낸다 — 위치 = (라디오면 2) + 켜짐 + 1.
    // ⚠ 부르기 전에 fx_q 에 라디오면 1, 체크박스면 0 을 적어 둔다 (비교는 참/거짓이라 식에 못 넣는다)
    const MARKS = MARK.off + MARK.on + MARK.radioOff + MARK.radioOn;
    const markText = (field) => concat(text('  '), concat(
        charAt(text(MARKS), add(add(mul(get(V.fx_q), num(2)), at(L.fm_on, field)), num(1))),
        concat(text(' '), at(L.fm_lab, field))));

    // 라디오 — 같은 양식·같은 name 을 전부 끈다 (재귀 깊이 = 칸 수)
    defineFunction('fm_rclr', [
        ifDo(le(get(V.fx_i), get(V.pg_ni)), [
            ifDo(and(and(eq(at(L.fm_form, get(V.fx_i)), at(L.fm_form, get(V.fx))), eq(at(L.fm_name, get(V.fx_i)), at(L.fm_name, get(V.fx)))),
                eq(at(L.fm_type, get(V.fx_i)), text(FIELD.radio))), [
                listSet(L.fm_on, get(V.fx_i), num(0)),
                set(V.fx_q, num(1)),
                rewrite(at(L.fm_line, get(V.fx_i)), markText(get(V.fx_i))),
            ]),
            inc(V.fx_i, num(1)),
            call('fm_rclr'),
        ]),
    ]);

    onSignal(logic, 'sig_field', [
        ifDo(and(eq(get(V.ui_busy), num(0)), and(ge(get(V.ui_field), num(1)), le(get(V.ui_field), get(V.pg_ni)))), [
            set(V.fx, get(V.ui_field)),
            set(V.fx_t, at(L.fm_type, get(V.fx))),
            set(V.fx_l, at(L.fm_line, get(V.fx))),

            // 글 칸 — 입력창 (묻기는 logic 이 한다: 보이는 오브젝트가 물으면 말풍선이 뜬다)
            ifDo(eq(get(V.fx_t), text(FIELD.text)), [
                set(V.ui_modal, num(1)),
                ask(concat(at(L.fm_lab, get(V.fx)), text(' — 입력하고 Enter (빈 칸이면 그대로)'))),
                set(V.fx_q, answer()),
                set(V.ui_modal, num(0)),
                ifDo(gt(strLen(get(V.fx_q)), num(0)), [
                    listSet(L.fm_val, get(V.fx), get(V.fx_q)),
                    rewrite(get(V.fx_l), concat(text('  '), get(V.fx_q))),
                    ifDo(gt(get(V.fx_l), num(0)), [listSet(L.ln_c, get(V.fx_l), num(0))]),
                    ...repaint,
                    // 이 양식에 글 칸이 하나뿐이면 바로 보낸다 — 검색창에서 Enter 를 친 것과 같다
                    set(V.fx_n, num(0)), set(V.fx_i, num(1)), call('fm_cnt'),
                    ifDo(eq(get(V.fx_n), num(1)), [
                        set(V.fs_form, at(L.fm_form, get(V.fx))), set(V.fs_btn, num(0)), call('fm_sub'),
                    ]),
                ]),
            ]),
            // 체크박스
            ifDo(eq(get(V.fx_t), text(FIELD.check)), [
                listSet(L.fm_on, get(V.fx), sub(num(1), at(L.fm_on, get(V.fx)))),
                set(V.fx_q, num(0)),
                rewrite(get(V.fx_l), markText(get(V.fx))),
                ...repaint,
            ]),
            // 라디오
            ifDo(eq(get(V.fx_t), text(FIELD.radio)), [
                set(V.fx_i, num(1)), call('fm_rclr'),
                listSet(L.fm_on, get(V.fx), num(1)),
                set(V.fx_q, num(1)),
                rewrite(get(V.fx_l), markText(get(V.fx))),
                ...repaint,
            ]),
            // 선택 상자 — 다음 선택지 (끝이면 처음으로)
            ifDo(eq(get(V.fx_t), text(FIELD.select)), [
                set(V.fx_i, add(at(L.fm_on, get(V.fx)), num(1))),
                ifDo(gt(get(V.fx_i), at(L.fm_max, get(V.fx))), [set(V.fx_i, at(L.fm_min, get(V.fx)))]),
                ifDo(and(ge(get(V.fx_i), num(1)), le(get(V.fx_i), get(V.pg_no))), [
                    listSet(L.fm_on, get(V.fx), get(V.fx_i)),
                    listSet(L.fm_val, get(V.fx), at(L.op_val, get(V.fx_i))),
                    rewrite(get(V.fx_l), concat(text(`  ${MARK.select} `), at(L.op_lab, get(V.fx_i)))),
                    ...repaint,
                ]),
            ]),
            // 보내기
            ifDo(eq(get(V.fx_t), text(FIELD.submit)), [
                set(V.fs_form, at(L.fm_form, get(V.fx))), set(V.fs_btn, get(V.fx)), call('fm_sub'),
            ]),
        ]),
    ]);

    // ================================================================== 슬라이더 (그림)
    const TRACK_X = VIEW.left + RANGE.left + RANGE.width / 2;
    const LEFT = VIEW.left + RANGE.left;
    defineFunction('rd_track', [
        ifElse(gt(lineOf(), num(0)), [moveTo(num(TRACK_X), yOf), showSelf()], [hideSelf()]),
    ]);
    // 손잡이 — 막대와 같은 칸(pk)을 읽고, 값으로 x 를 정한다
    defineFunction('rd_knob', [
        set(V.rk_f, num(0)),
        ifDo(gt(lineOf(), num(0)), [set(V.rk_f, at(L.ln_w, lineOf()))]),
        ifElse(gt(get(V.rk_f), num(0)),
            [
                moveTo(add(num(LEFT), mul(div(sub(at(L.fm_val, get(V.rk_f)), at(L.fm_min, get(V.rk_f))),
                    sub(at(L.fm_max, get(V.rk_f)), at(L.fm_min, get(V.rk_f)))), num(RANGE.width))), yOf),
                showSelf(),
            ],
            [hideSelf()]),
    ]);
    // 누른 채 끈다 — 손을 뗄 때까지 한 프레임에 한 번 값을 고치고 다시 그린다 (entry-ppt 의 끌기와 같다)
    defineFunction('rg_drag', [
        ifDo(and(eq(get(V.ui_busy), num(0)), gt(lineOf(), num(1))), [
            set(V.rg_line, lineOf()),
            set(V.rg_f, at(L.ln_w, get(V.rg_line))),
            ifDo(gt(get(V.rg_f), num(0)), [
                forever([
                    ifDo(not(isClicked()), [breakLoop()]),
                    set(V.rg_v, div(sub(mouseX(), num(LEFT)), num(RANGE.width))),
                    ifDo(lt(get(V.rg_v), num(0)), [set(V.rg_v, num(0))]),
                    ifDo(gt(get(V.rg_v), num(1)), [set(V.rg_v, num(1))]),
                    // 간격(step)에 맞추고, 소수는 둘째 자리까지 (0.1 단계가 0.30000000000000004 로 보이지 않게)
                    set(V.rg_v, mul(get(V.rg_v), sub(at(L.fm_max, get(V.rg_f)), at(L.fm_min, get(V.rg_f))))),
                    set(V.rg_v, add(at(L.fm_min, get(V.rg_f)), mul(quotient(add(div(get(V.rg_v), at(L.fm_step, get(V.rg_f))), num(0.5)), num(1)),
                        at(L.fm_step, get(V.rg_f))))),
                    set(V.rg_v, div(quotient(add(mul(get(V.rg_v), num(100)), num(0.5)), num(1)), num(100))),
                    listSet(L.fm_val, get(V.rg_f), get(V.rg_v)),
                    listSet(L.ln_t, sub(get(V.rg_line), num(1)), concat(at(L.fm_lab, get(V.rg_f)), concat(text(': '), get(V.rg_v)))),
                    sendSignal('sig_paint'),
                ]),
            ]),
        ]),
    ]);

    const init = ESC_TO.map((t) => listAdd(L.fe_tab, text(t)));
    return { ingest, onRecord, reset, init, rangeLh: STYLES[8].lh };
}
