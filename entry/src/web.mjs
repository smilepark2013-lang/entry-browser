// src/web.mjs — 웹 주소를 중계 앱으로 가져온다 (형식의 정본: ../../PROTOCOL.md)
//
//   요청  WEB2|<번호>|<주소>  → 왼쪽 띠에 색 격자 (src/grid.mjs)
//         → 곧바로 입력창을 연다. 입력창은 무대 아래에 뜨고 격자는 띠 위쪽 168px 에만
//           있어서 가리지 않는다. 그동안 중계 앱이 화면을 캡처해 읽고 클립보드에 응답을 넣는다.
//   응답  EBR2|<번호>|<바이트수>|<Adler-32>|<base64>
//         base64 를 풀면  <최종 주소>\n<줄 목록>  → page.mjs 가 받아 그린다 (형식: display.mjs)
//   (WEB1/EBR1 은 엔트리 OS 의 www 다 — 본문이 HTML 이다)
//
// 이 모듈은 스레드를 만들지 않는다. `fetch` 는 page.mjs 의 sig_go(logic) 안에 그대로
// 펼쳐진다 — 그리기·묻기·풀기가 **한 스레드에서 차례로** 돈다. 신호로 갈라 보내면
// 보낸 쪽이 먼저 진행해 버린다 (entry-ppt HANDOFF §5.13.1).
//
// 결과 (sig_go 가 읽는다)
//   nv_ok    1 = br_src 에 페이지가 있다 (오류 페이지 포함)   0 = 취소
//   nv_final 그 페이지의 주소 (리다이렉트를 따라간 뒤)
//
// 왜 base64 인가 — 입력창은 HTML <input> 이라 **붙여넣은 줄바꿈이 사라진다.**
// 왜 리스트에 담지 않나 — 5000항목 상한. 바이트는 나오는 즉시 UTF-8 로 조립해 문자열에 붙인다.

import {
    num, text, add, sub, mul, quotient, mod, eq, ne, gt, lt, le, ge, and, or,
    concat, charAt, substring, strLen, indexOf, ifDo, ifElse, forever, breakLoop, penClear,
} from '../tools/dsl.mjs';
import { SYLL } from './syll.mjs';
import { ORD_TABLE, HANGUL_BASE, HANGUL_LAST } from '../../src/lib/snapcodec.mjs';
import { CAPACITY } from '../../src/lib/stripcodec.mjs';
import { S, C, B, VIEW_W, record, wrapRuns, RICH_RANGES, rangeTable, HANJA, HANJA_PUA } from '../../src/lib/display.mjs';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// 한 프레임 = BATCH 단계 × 단계마다 QUADS 묶음(4글자 → 3바이트). 재귀 깊이는 BATCH + 2 (wb_byte 한 칸).
// 엔트리 재귀 한계(≈900) 아래로 — 격자 그리기(grid.mjs)가 실기에서 600 깊이로 돈다.
// 예전 250 × 1 묶음이면 10만 자 붙여넣기에 107프레임이었다.
const BATCH = 500;
const QUADS = 3;
const CACHE_MAX = 6;        // 최근 페이지. 뒤로 가기가 매번 왕복하지 않게
const ADLER = 65521;

const ERRORS = [
    [1, 'EBR2 로 시작하는 응답이 아닙니다. 중계 앱이 복사한 내용을 그대로 붙여넣어 주세요.'],
    [2, '다른 요청의 응답입니다 (번호가 다릅니다). 예전 클립보드일 수 있습니다.'],
    [3, '응답이 잘렸습니다 (바이트 수가 다릅니다). 다시 붙여넣어 주세요.'],
    [4, '체크섬이 맞지 않습니다. 붙여넣는 중에 내용이 바뀌었습니다.'],
    [5, '응답 본문의 형식이 이상합니다 (주소 줄이 없습니다).'],
];

/** 오류 페이지의 줄들 (빌드할 때 접는다). 링크 1번 = 같은 주소 다시 요청 */
function errorRecords(title, msg) {
    const out = [record(S.h1, 0, 0, C.head, B.none, title), record(S.gap, 6, 0, 0, 0, '')];
    for (const ln of wrapRuns([{ text: msg, link: 0 }], S.body, VIEW_W)) out.push(record(S.body, 0, 0, C.text, B.none, ln.text));
    out.push(record(S.gap, 8, 0, 0, 0, ''));
    out.push(record(S.body, 0, 1, C.link, B.none, '이 주소 다시 요청하기'));
    out.push(record(S.small, 0, 0, C.dim, B.none, '뒤로 가려면 툴바의 ← 를 누르세요.'));
    return out.join('\n');
}

/** 주소가 웹 주소인가 — 브라우저가 이걸로 로컬 페이지와 가른다 */
export const isWebUrl = (u) => or(eq(indexOf(u, text('http://')), num(1)),
    eq(indexOf(u, text('https://')), num(1)));

export const spec = {
    variables: [
        'wb_seq', 'wb_url', 'wb_hit', 'wb_k', 'wb_nocache',
        'wb_in', 'wb_rest', 'wb_fld', 'wb_p', 'wb_rseq', 'wb_nb', 'wb_ck', 'wb_err',
        'wb_b64', 'wb_i', 'wb_len', 'wb_batch', 'wb_done',
        'wb_a', 'wb_b', 'wb_c', 'wb_d', 'wb_by', 'wb_md', 'wb_need', 'wb_cp',
        'wb_out', 'wb_n', 'wb_s1', 'wb_s2', 'wb_ch',
    ],
    lists: ['wb_curl', 'wb_csrc'],
    signals: [],
    functions: ['wb_step', 'wb_byte'],
};

export function build(ctx) {
    const {
        V, L, get, set, inc, listAdd, listPop, listGet, listLen,
        until, defineFunction, call, sendSignal, ask, answer, status,
    } = ctx;

    const add1 = (v, s) => set(v, concat(get(v), s));
    // 오류도 **페이지(줄 목록)** 로 보여준다. 엔트리는 글을 접을 수 없으므로 문구는 빌드할 때 접어 둔다.
    // 링크 1번이 같은 주소를 다시 요청한다 — 주소만 런타임에 끼운다.
    const page = (title, msg) => concat(concat(text(`T${title}\nU`), get(V.wb_url)), text(`\n${errorRecords(title, msg)}`));

    // ------------------------------------------------------------------ 해독
    const sixbit = (ch) => sub(indexOf(text(B64), ch), num(1));
    const readSix = (target, offset) => ifElse(
        le(add(get(V.wb_i), num(offset)), get(V.wb_len)),
        [set(target, sixbit(charAt(get(V.wb_b64), add(get(V.wb_i), num(offset)))))],
        [set(target, num(-1))]);

    // 바이트 하나 → Adler-32 누적 + UTF-8 조립. 상태(wb_need)를 먼저 떠 놓는다.
    defineFunction('wb_byte', [
        inc(V.wb_n, num(1)),
        set(V.wb_s1, mod(add(get(V.wb_s1), get(V.wb_by)), num(ADLER))),
        set(V.wb_s2, mod(add(get(V.wb_s2), get(V.wb_s1)), num(ADLER))),
        set(V.wb_md, get(V.wb_need)),
        ifDo(eq(get(V.wb_md), num(0)), [
            // 줄바꿈은 글자가 아니라 **바이트 값**으로 가른다 (숫자 비교라 안전하다)
            ifDo(eq(get(V.wb_by), num(10)), [add1(V.wb_out, text('\n'))]),
            ifDo(eq(get(V.wb_by), num(9)), [add1(V.wb_out, text('\t'))]),          // 양식 줄의 구분자
            ifDo(and(ge(get(V.wb_by), num(32)), le(get(V.wb_by), num(126))),
                // 표 1번이 줄바꿈, 2번부터 32.. 이므로 위치 = 코드 - 30
                [add1(V.wb_out, charAt(text(ORD_TABLE), sub(get(V.wb_by), num(30))))]),
            ifDo(and(ge(get(V.wb_by), num(128)), lt(get(V.wb_by), num(192))), [add1(V.wb_out, text('?'))]),
            ifDo(and(ge(get(V.wb_by), num(192)), lt(get(V.wb_by), num(224))),
                [set(V.wb_cp, sub(get(V.wb_by), num(192))), set(V.wb_need, num(1))]),
            ifDo(and(ge(get(V.wb_by), num(224)), lt(get(V.wb_by), num(240))),
                [set(V.wb_cp, sub(get(V.wb_by), num(224))), set(V.wb_need, num(2))]),
            ifDo(ge(get(V.wb_by), num(240)),
                [set(V.wb_cp, sub(get(V.wb_by), num(240))), set(V.wb_need, num(3))]),
        ]),
        ifDo(gt(get(V.wb_md), num(0)), [
            set(V.wb_cp, add(mul(get(V.wb_cp), num(64)), sub(get(V.wb_by), num(128)))),
            inc(V.wb_need, num(-1)),
            ifDo(eq(get(V.wb_need), num(0)), [
                // chr() 이 없다 — 구간마다 표 문자열에서 꺼낸다 (한글 음절 + display.RICH_RANGES).
                // ⚠ charAt 은 **만약 안에서만** 부른다. `그리고` 조건과 같은 줄에 두면 범위 밖에서도 읽는다.
                set(V.wb_ch, text('?')),
                ifDo(and(ge(get(V.wb_cp), num(HANGUL_BASE)), le(get(V.wb_cp), num(HANGUL_LAST))),
                    [set(V.wb_ch, charAt(text(SYLL), sub(get(V.wb_cp), num(HANGUL_BASE - 1))))]),
                ...RICH_RANGES.map((r) => ifDo(and(ge(get(V.wb_cp), num(r[0])), le(get(V.wb_cp), num(r[1]))),
                    [set(V.wb_ch, charAt(text(rangeTable(r)), sub(get(V.wb_cp), num(r[0] - 1))))])),
                // 한자 — 중계 앱이 U+E000+번호로 보낸다 (KS X 1001 순서의 표에서 꺼낸다)
                ifDo(and(ge(get(V.wb_cp), num(HANJA_PUA)), lt(get(V.wb_cp), num(HANJA_PUA + HANJA.length))),
                    [set(V.wb_ch, charAt(text(HANJA), sub(get(V.wb_cp), num(HANJA_PUA - 1))))]),
                add1(V.wb_out, get(V.wb_ch)),
            ]),
        ]),
    ]);

    // 4글자 → 최대 3바이트. 재귀 한 단계에서 QUADS 묶음을 처리한다 — 프레임 수는 줄고 재귀 깊이는 그대로
    const quad = () => ifElse(gt(get(V.wb_i), get(V.wb_len)),
        [set(V.wb_done, num(1))],
        [
            readSix(V.wb_a, 0), readSix(V.wb_b, 1), readSix(V.wb_c, 2), readSix(V.wb_d, 3),
            ifDo(and(ge(get(V.wb_a), num(0)), ge(get(V.wb_b), num(0))), [
                set(V.wb_by, add(mul(get(V.wb_a), num(4)), quotient(get(V.wb_b), num(16)))),
                call('wb_byte'),
                ifDo(ge(get(V.wb_c), num(0)), [
                    set(V.wb_by, add(mul(mod(get(V.wb_b), num(16)), num(16)), quotient(get(V.wb_c), num(4)))),
                    call('wb_byte'),
                    ifDo(ge(get(V.wb_d), num(0)), [
                        set(V.wb_by, add(mul(mod(get(V.wb_c), num(4)), num(64)), get(V.wb_d))),
                        call('wb_byte'),
                    ]),
                ]),
            ]),
            inc(V.wb_i, num(4)),
        ]);
    defineFunction('wb_step', [
        ifDo(gt(get(V.wb_batch), num(0)), [
            ...Array.from({ length: QUADS }, quad),
            inc(V.wb_batch, num(-1)),
            call('wb_step'),
        ]),
    ]);

    // '|' 까지 잘라 dst 에 담는다 (필드마다 상수 시간)
    const takeBar = (dst) => [
        set(V.wb_p, indexOf(get(V.wb_rest), text('|'))),
        ifElse(gt(get(V.wb_p), num(0)),
            [
                ifElse(gt(get(V.wb_p), num(1)),
                    [set(dst, substring(get(V.wb_rest), num(1), sub(get(V.wb_p), num(1))))],
                    [set(dst, text(''))]),
                ifElse(lt(get(V.wb_p), strLen(get(V.wb_rest))),
                    [set(V.wb_rest, substring(get(V.wb_rest), add(get(V.wb_p), num(1)), strLen(get(V.wb_rest))))],
                    [set(V.wb_rest, text(''))]),
            ],
            [set(V.wb_err, num(1)), set(dst, text(''))]),
    ];
    const failIf = (code, cond) => ifDo(and(eq(get(V.wb_err), num(0)), cond), [set(V.wb_err, num(code))]);

    const decode = [
        set(V.wb_err, num(0)),
        set(V.wb_rest, get(V.wb_in)),
        ...takeBar(V.wb_fld),
        failIf(1, ne(get(V.wb_fld), text('EBR2'))),
        ...takeBar(V.wb_rseq),
        failIf(2, ne(get(V.wb_rseq), get(V.wb_seq))),
        ...takeBar(V.wb_nb),
        ...takeBar(V.wb_ck),
        ifDo(eq(get(V.wb_err), num(0)), [
            ...status('  응답을 푸는 중…'),
            set(V.wb_b64, get(V.wb_rest)),
            set(V.wb_i, num(1)),
            set(V.wb_len, strLen(get(V.wb_b64))),
            set(V.wb_out, text('')),
            set(V.wb_n, num(0)),
            set(V.wb_s1, num(1)),
            set(V.wb_s2, num(0)),
            set(V.wb_need, num(0)),
            set(V.wb_done, num(0)),
            forever([
                ifDo(eq(get(V.wb_done), num(1)), [breakLoop()]),
                set(V.wb_batch, num(BATCH)),
                call('wb_step'),
            ]),
            failIf(3, ne(get(V.wb_n), get(V.wb_nb))),
            failIf(4, ne(add(mul(get(V.wb_s2), num(65536)), get(V.wb_s1)), get(V.wb_ck))),
            set(V.wb_p, indexOf(get(V.wb_out), text('\n'))),      // 첫 줄 = 최종 주소
            failIf(5, lt(get(V.wb_p), num(2))),
        ]),
    ];

    const remember = (keyExpr) => [
        listAdd(L.wb_curl, keyExpr),
        listAdd(L.wb_csrc, get(V.br_src)),
        until(le(listLen(L.wb_curl), num(CACHE_MAX)), [listPop(L.wb_curl, num(1)), listPop(L.wb_csrc, num(1))]),
    ];

    const loaded = [
        set(V.nv_final, substring(get(V.wb_out), num(1), sub(get(V.wb_p), num(1)))),
        ifElse(lt(get(V.wb_p), strLen(get(V.wb_out))),
            [set(V.br_src, substring(get(V.wb_out), add(get(V.wb_p), num(1)), strLen(get(V.wb_out))))],
            [set(V.br_src, text(''))]),
        ...remember(get(V.nv_final)),
        // 리다이렉트됐으면 요청한 주소로도 찾을 수 있게
        ifDo(ne(get(V.wb_url), get(V.nv_final)), remember(get(V.wb_url))),
    ];

    // 오류도 **페이지로** 보여준다. 링크 하나가 같은 주소를 다시 요청한다. 캐시하지 않는다.
    const failed = [
        set(V.nv_final, get(V.wb_url)),
        ...ERRORS.map(([code, msg]) => ifDo(eq(get(V.wb_err), num(code)), [set(V.br_src, page('응답을 읽지 못했습니다', msg))])),
    ];

    const request = [
        set(V.wb_url, get(V.nv_to)),
        inc(V.wb_seq, num(1)),
        set(V.gr_buf, concat(concat(concat(text('WEB2|'), get(V.wb_seq)), text('|')), get(V.wb_url))),
        // 띠의 판을 치우고 그 자리에 격자를 그린다
        set(V.ui_strip, num(0)),
        sendSignal('sig_strip'),
        ...status('  ◀ 요청 코드를 그리는 중…'),
        call('gr_draw'),
        ifElse(eq(get(V.gr_over), num(1)),
            [
                set(V.ui_strip, num(1)),
                sendSignal('sig_strip'),
                set(V.nv_final, get(V.wb_url)),
                set(V.br_src, page('주소가 너무 깁니다', `왼쪽 띠에는 요청이 ${CAPACITY}바이트까지 들어갑니다. 더 짧은 주소를 써 주세요.`)),
                set(V.nv_ok, num(1)),
            ],
            [
                ...status('  ◀ 중계 앱이 왼쪽 코드를 읽으면, 입력창에 Ctrl+V → Enter'),
                set(V.ui_modal, num(1)),
                ask('중계 앱이 복사한 응답을 붙여넣고 Enter (빈 칸 = 취소)'),
                set(V.wb_in, answer()),
                set(V.ui_modal, num(0)),
                penClear(),                         // 격자는 이 스레드(logic)가 그렸다 — 지우기도 여기서
                set(V.ui_strip, num(1)),
                sendSignal('sig_strip'),
                ifElse(eq(strLen(get(V.wb_in)), num(0)),
                    [set(V.nv_ok, num(0)), ...status('  취소했습니다')],
                    [...decode, ifElse(eq(get(V.wb_err), num(0)), loaded, failed), set(V.nv_ok, num(1))]),
            ]),
    ];

    const fetch = [
        // 캐시 (다시 받기면 건너뛴다)
        set(V.wb_hit, num(0)),
        ifDo(eq(get(V.wb_nocache), num(0)), [
            set(V.wb_k, num(1)),
            until(gt(get(V.wb_k), listLen(L.wb_curl)), [
                ifDo(eq(listGet(L.wb_curl, get(V.wb_k)), get(V.nv_to)), [set(V.wb_hit, get(V.wb_k))]),
                inc(V.wb_k, num(1)),
            ]),
        ]),
        set(V.wb_nocache, num(0)),
        ifElse(gt(get(V.wb_hit), num(0)),
            [set(V.br_src, listGet(L.wb_csrc, get(V.wb_hit))), set(V.nv_final, get(V.nv_to)), set(V.nv_ok, num(1))],
            request),
    ];

    return { init: [set(V.wb_seq, num(0)), set(V.wb_nocache, num(0))], fetch };
}
