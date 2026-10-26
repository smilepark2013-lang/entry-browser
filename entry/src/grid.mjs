// src/grid.mjs — 요청 문자열을 왼쪽 띠에 색 격자로 그린다 (→ 중계 앱이 캡처해 읽는다)
//
// 기하의 정본은 중계 앱과 같은 파일 `src/lib/stripcodec.mjs` 다. 상수를 거기서 가져온다 —
// 정의가 두 벌이면 그리는 쪽과 읽는 쪽이 조용히 어긋난다.
//
//   gr_buf 에 문자열을 넣고 call('gr_draw') → 다 그리면 돌아온다
//   너무 길면 그리지 않고 gr_over = 1 (gr_bytes 에 바이트 수)
//
// 🔴 **신호가 아니라 함수다** (entry-ppt HANDOFF §5.13.1).
//   신호로 그리면 보낸 쪽 스레드가 그 사이 계속 진행한다. 그리기는 수십 프레임이라
//   그동안 입력창이 먼저 열리거나 다른 갱신이 끼어든다. 함수면 다 그릴 때까지 기다린다.
//   그리고 **붓 획은 블록을 실행한 오브젝트의 것**이므로, 지우는 쪽(logic)과 같은
//   오브젝트에서 부른다.
//
// ⚠ 조심한 것
//  1. `eq(글자, '\n')` 을 쓰지 않는다 (비교 블록은 양쪽을 숫자로 읽는다). 글자 판별은 `글자 찾기`.
//  2. 엔트리 붓은 **butt cap** 이다. 셀을 채우려면 왼쪽 모서리에서 오른쪽 모서리까지 긋는다.
//  3. 반복 블록은 한 바퀴가 1프레임 → 트램폴린.

import {
    num, text, add, sub, mul, quotient, mod, eq, gt, lt, ge, and,
    concat, charAt, indexOf, strLen, ifDo, ifElse, forever, breakLoop,
    penDown, penUp, penColor, penSize, penClear, moveTo,
} from '../tools/dsl.mjs';
import { SYLL } from './syll.mjs';
import { ORD_TABLE, ASCII_LO, NL, HANGUL_BASE, MARKER } from '../../src/lib/snapcodec.mjs';
import {
    CELL, X0, Y0, DATA_COLS, DATA_ROW0, CK_COL, CELLS, CAPACITY, HEADER_BYTES,
    MARKERS, MARKER_SIZE, calCell, PAD,
} from '../../src/lib/stripcodec.mjs';

const HEXD = '0123456789abcdef';
const BATCH = 600;                  // 재귀 깊이 한계 ≈900 아래로

const cellLeft = (col) => X0 + col * CELL;
const cellMidY = (row) => Y0 - row * CELL - CELL / 2;

export const spec = {
    variables: [
        'gr_buf', 'gr_p', 'gr_ch', 'gr_code', 'gr_tmp', 'gr_e0', 'gr_e1', 'gr_e2', 'gr_en', 'gr_ei',
        'gr_hi', 'gr_byte', 'gr_bytes', 'gr_over', 'gr_bpos',
        'gr_b0', 'gr_b1', 'gr_b2', 'gr_bn', 'gr_cell', 'gr_sum',
        'gr_r', 'gr_g', 'gr_b', 'gr_row', 'gr_col', 'gr_batch', 'gr_done',
    ],
    lists: [],
    functions: ['gr_draw', 'gr_count', 'gr_step', 'gr_emit'],
    signals: [],
};

export function build(ctx) {
    const { V, get, set, inc, defineFunction, call } = ctx;

    // 채널 값은 레벨*16+8 이다. 16진수 아랫자리는 **항상 8** 이고 윗자리가 곧 레벨이다.
    const hx = (lv) => charAt(text(HEXD), add(lv, num(1)));
    const colorOf = (r, g, b) => concat(
        concat(concat(text('#'), hx(r)), concat(text('8'), hx(g))),
        concat(text('8'), concat(hx(b), text('8'))));
    const stroke = (x0, x1, y) => [moveTo(x0, y), penDown(), moveTo(x1, y), penUp()];
    const drawCell = (xExpr, yExpr, r, g, b) => [penColor(colorOf(r, g, b)), ...stroke(xExpr, add(xExpr, num(CELL)), yExpr)];
    const drawFixed = (col0, col1, row, hex) => [
        penColor(hex), ...stroke(num(cellLeft(col0)), num(cellLeft(col1 + 1)), num(cellMidY(row))),
    ];

    // 글자 → UTF-8 바이트 (ord() 대신 표 + 글자 찾기). 표 밖은 '?'
    const openChar = [
        set(V.gr_ch, charAt(get(V.gr_buf), get(V.gr_p))),
        inc(V.gr_p, num(1)),
        set(V.gr_en, num(1)),
        set(V.gr_ei, num(0)),
        set(V.gr_tmp, indexOf(text(ORD_TABLE), get(V.gr_ch))),
        ifElse(gt(get(V.gr_tmp), num(0)),
            [ifElse(eq(get(V.gr_tmp), num(1)),
                [set(V.gr_e0, num(NL))],
                [set(V.gr_e0, add(get(V.gr_tmp), num(ASCII_LO - 2)))])],
            [
                set(V.gr_tmp, indexOf(text(SYLL), get(V.gr_ch))),
                ifElse(gt(get(V.gr_tmp), num(0)),
                    [
                        set(V.gr_code, add(get(V.gr_tmp), num(HANGUL_BASE - 1))),
                        set(V.gr_e0, add(num(224), quotient(get(V.gr_code), num(4096)))),
                        set(V.gr_e1, add(num(128), mod(quotient(get(V.gr_code), num(64)), num(64)))),
                        set(V.gr_e2, add(num(128), mod(get(V.gr_code), num(64)))),
                        set(V.gr_en, num(3)),
                    ],
                    [set(V.gr_e0, num(63))]),
            ]),
    ];

    defineFunction('gr_count', [
        ifDo(gt(get(V.gr_batch), num(0)), [
            ifElse(gt(get(V.gr_p), strLen(get(V.gr_buf))),
                [set(V.gr_done, num(1))],
                [...openChar, inc(V.gr_bytes, get(V.gr_en)), inc(V.gr_batch, num(-1)), call('gr_count')]),
        ]),
    ]);

    // 셀 하나 + 행 체크섬. 행이 끝나면 체크섬 셀 2개 ([10] 니블 합 mod 4096, [11] 행 번호)
    defineFunction('gr_emit', [
        set(V.gr_col, mod(get(V.gr_cell), num(DATA_COLS))),
        set(V.gr_row, add(quotient(get(V.gr_cell), num(DATA_COLS)), num(DATA_ROW0))),
        ...drawCell(add(mul(get(V.gr_col), num(CELL)), num(X0)),
            sub(num(Y0 - CELL / 2), mul(get(V.gr_row), num(CELL))),
            get(V.gr_r), get(V.gr_g), get(V.gr_b)),
        inc(V.gr_sum, add(add(get(V.gr_r), get(V.gr_g)), get(V.gr_b))),
        inc(V.gr_cell, num(1)),
        ifDo(eq(mod(get(V.gr_cell), num(DATA_COLS)), num(0)), [
            set(V.gr_sum, mod(get(V.gr_sum), num(4096))),
            set(V.gr_r, mod(quotient(get(V.gr_sum), num(256)), num(16))),
            set(V.gr_g, mod(quotient(get(V.gr_sum), num(16)), num(16))),
            set(V.gr_b, mod(get(V.gr_sum), num(16))),
            ...drawCell(num(cellLeft(CK_COL)), sub(num(Y0 - CELL / 2), mul(get(V.gr_row), num(CELL))),
                get(V.gr_r), get(V.gr_g), get(V.gr_b)),
            set(V.gr_tmp, sub(get(V.gr_row), num(DATA_ROW0))),
            set(V.gr_r, mod(quotient(get(V.gr_tmp), num(256)), num(16))),
            set(V.gr_g, mod(quotient(get(V.gr_tmp), num(16)), num(16))),
            set(V.gr_b, mod(get(V.gr_tmp), num(16))),
            ...drawCell(num(cellLeft(CK_COL + 1)), sub(num(Y0 - CELL / 2), mul(get(V.gr_row), num(CELL))),
                get(V.gr_r), get(V.gr_g), get(V.gr_b)),
            set(V.gr_sum, num(0)),
        ]),
    ]);

    // 바이트 3개 = 셀 2개
    const flushBytes = [
        set(V.gr_r, quotient(get(V.gr_b0), num(16))),
        set(V.gr_g, mod(get(V.gr_b0), num(16))),
        set(V.gr_b, quotient(get(V.gr_b1), num(16))),
        call('gr_emit'),
        set(V.gr_r, mod(get(V.gr_b1), num(16))),
        set(V.gr_g, quotient(get(V.gr_b2), num(16))),
        set(V.gr_b, mod(get(V.gr_b2), num(16))),
        call('gr_emit'),
        set(V.gr_bn, num(0)),
    ];

    // 한 스텝 = 바이트 하나. 셀을 다 채울 때까지 (모자라면 0 — 격자는 늘 가득 차야 한다)
    defineFunction('gr_step', [
        ifDo(and(gt(get(V.gr_batch), num(0)), eq(get(V.gr_done), num(0))), [
            ifElse(ge(get(V.gr_cell), num(CELLS)),
                [set(V.gr_done, num(1))],
                [
                    ifElse(lt(get(V.gr_hi), num(HEADER_BYTES)),
                        [
                            // 머리 4바이트: 쪽 1, 전체 1, 길이(2바이트)
                            ifDo(eq(get(V.gr_hi), num(0)), [set(V.gr_byte, num(1))]),
                            ifDo(eq(get(V.gr_hi), num(1)), [set(V.gr_byte, num(1))]),
                            ifDo(eq(get(V.gr_hi), num(2)), [set(V.gr_byte, quotient(get(V.gr_bytes), num(256)))]),
                            ifDo(eq(get(V.gr_hi), num(3)), [set(V.gr_byte, mod(get(V.gr_bytes), num(256)))]),
                            inc(V.gr_hi, num(1)),
                        ],
                        [
                            ifDo(ge(get(V.gr_ei), get(V.gr_en)), [
                                ifElse(gt(get(V.gr_p), strLen(get(V.gr_buf))), [set(V.gr_en, num(0))], openChar),
                            ]),
                            // 글이 끝나면 남은 칸은 PAD 를 되풀이한다 (띠가 시커멓지 않게 — stripcodec.PAD)
                            ifElse(eq(get(V.gr_en), num(0)),
                                [
                                    set(V.gr_tmp, mod(get(V.gr_bpos), num(3))),
                                    ...PAD.map((v, k) => ifDo(eq(get(V.gr_tmp), num(k)), [set(V.gr_byte, num(v))])),
                                ],
                                [
                                    ifDo(eq(get(V.gr_ei), num(0)), [set(V.gr_byte, get(V.gr_e0))]),
                                    ifDo(eq(get(V.gr_ei), num(1)), [set(V.gr_byte, get(V.gr_e1))]),
                                    ifDo(eq(get(V.gr_ei), num(2)), [set(V.gr_byte, get(V.gr_e2))]),
                                    inc(V.gr_ei, num(1)),
                                ]),
                        ]),
                    inc(V.gr_bpos, num(1)),
                    ifDo(eq(get(V.gr_bn), num(0)), [set(V.gr_b0, get(V.gr_byte))]),
                    ifDo(eq(get(V.gr_bn), num(1)), [set(V.gr_b1, get(V.gr_byte))]),
                    ifDo(eq(get(V.gr_bn), num(2)), [set(V.gr_b2, get(V.gr_byte))]),
                    inc(V.gr_bn, num(1)),
                    ifDo(eq(get(V.gr_bn), num(3)), flushBytes),
                    inc(V.gr_batch, num(-1)),
                    call('gr_step'),
                ]),
        ]),
    ]);

    const frame = [
        // 마커 3곳. 데이터는 채널 값 8..248 만 쓰므로 순수 마젠타는 절대 나오지 않는다.
        ...MARKERS.flatMap((m) => Array.from({ length: MARKER_SIZE }, (_, dr) =>
            drawFixed(m.col, m.col + MARKER_SIZE - 1, m.row + dr, MARKER)).flat()),
        // 보정 띠 16칸 — 위 마커 사이에 접어 넣는다
        ...Array.from({ length: 16 }, (_, i) => {
            const { col, row } = calCell(i);
            const v = (i * 16 + 8).toString(16).padStart(2, '0');
            return drawFixed(col, col, row, `#${v}${v}${v}`);
        }).flat(),
    ];

    defineFunction('gr_draw', [
        penClear(),
        penSize(num(CELL)),
        // 바이트 수 먼저 (길이 머리가 필요하고, 넘치면 그리지 않는다)
        set(V.gr_p, num(1)), set(V.gr_bytes, num(0)),
        set(V.gr_en, num(0)), set(V.gr_ei, num(0)), set(V.gr_done, num(0)),
        forever([
            ifDo(eq(get(V.gr_done), num(1)), [breakLoop()]),
            set(V.gr_batch, num(BATCH)),
            call('gr_count'),
        ]),
        set(V.gr_over, num(0)),
        ifDo(gt(get(V.gr_bytes), num(CAPACITY)), [set(V.gr_over, num(1))]),
        ifDo(eq(get(V.gr_over), num(0)), [
            ...frame,
            set(V.gr_p, num(1)), set(V.gr_hi, num(0)), set(V.gr_bpos, num(0)),
            set(V.gr_en, num(0)), set(V.gr_ei, num(0)),
            set(V.gr_bn, num(0)), set(V.gr_cell, num(0)), set(V.gr_sum, num(0)),
            set(V.gr_done, num(0)),
            forever([
                ifDo(eq(get(V.gr_done), num(1)), [breakLoop()]),
                set(V.gr_batch, num(BATCH)),
                call('gr_step'),
            ]),
        ]),
    ]);

    return { init: [], CAPACITY };
}
