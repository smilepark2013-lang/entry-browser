// tools/snapcodec.mjs — 스냅샷 컬러 그리드 코덱 (JS 정본)
//
// 엔트리 화면은 캔버스라 텍스트를 복사할 수 없다. 데이터를 **밖으로 꺼내는 유일한 길**이
// 화면에 그려서 스크린샷을 찍는 것이다. 그래서 파일시스템을 색 격자로 그린다.
//
//   [내보내기]  fs 리스트 → 직렬화 문자열 → UTF-8 바이트 → 12비트 셀 → 격자 색
//                → 엔트리가 붓으로 그린다 → 사용자가 스크린샷
//   [불러오기]  스크린샷 → 분석기(encoder.html) → 직렬화 문자열 → `snap load` 에 붙여넣기
//
// 이 파일은 **양쪽의 정본**이다:
//   - 엔트리 쪽 그리기(src/snap.mjs)는 여기 정의된 격자·색을 그대로 만든다
//   - 분석기(tools/encoder.html)는 여기 정의된 순서로 되읽는다
//   - tools/test_snap.mjs 가 왕복을 검증한다
//
// ⚠ 엔트리 제약이 포맷을 정했다. 이유를 남긴다:
//   - **길이 접두사**를 쓴다. 이스케이프도 금지 문자도 없다. fs_data 는 '|' 를
//     줄바꿈으로 쓰므로 구분자 방식이면 파일 내용마다 이스케이프가 필요하고,
//     엔트리에서 글자 단위 치환은 프레임당 한 글자라 감당이 안 된다.
//   - 숫자 필드는 '|' 까지 읽고, 문자열은 **정확히 N글자**를 읽는다. 둘 다
//     `substring` 한 방이라 싸다.
//   - 채널 값은 8,24,...,248 (16단계, 간격 16, 양옆 마진 ±8). 0 과 255 를
//     비워 두는 이유는 마커/여백 색을 **데이터가 절대 못 만들게** 하기 위해서다.

// ---------------------------------------------------------------------------
// 상수 — 격자 기하
// ---------------------------------------------------------------------------
export const CELL = 6;              // 셀 한 변 (px). 엔트리 좌표계 그대로
export const COLS = 80;             // 480 / 6
export const ROWS = 45;             // 270 / 6

// 마커는 3x3 셀이라 **행을 세 줄 잡아먹는다.** 위 띠(0..2)와 아래 띠(42..44)를
// 통째로 비워야 데이터와 겹치지 않는다.
// (처음엔 데이터를 1..43 으로 잡았다가 좌하단 마커가 42·43행을 덮어써서 깨졌다.
//  test_snapshot.mjs 의 마커 검사가 그걸 잡았다.)
export const DATA_ROW0 = 3;         // 데이터가 시작하는 행
export const DATA_ROWS = 39;        // 3..41
export const DATA_COLS = 78;        // 0..77 (78,79 는 행 체크섬)
export const CK_COL = 78;           // 체크섬 셀 2개가 시작하는 열

export const CELLS_PER_PAGE = DATA_ROWS * DATA_COLS;   // 3354
export const HEADER_BYTES = 4;                          // page, total, len(2)
// 셀 하나 = 12비트 = 1.5바이트
export const PAGE_CAPACITY = Math.floor(CELLS_PER_PAGE * 3 / 2) - HEADER_BYTES;  // 5027

// ---------------------------------------------------------------------------
// 상수 — 색
// ---------------------------------------------------------------------------
/** 4비트 레벨 → 채널 값. 0/255 를 피해 마커와 겹치지 않게 한다. */
export const levelToByte = (l) => l * 16 + 8;
/** 채널 값 → 가장 가까운 레벨. 분석기가 실측 픽셀을 양자화할 때 쓴다. */
export const byteToLevel = (b) => Math.max(0, Math.min(15, Math.round((b - 8) / 16)));

export const MARKER = '#ff00ff';    // 모서리 마커 (데이터가 만들 수 없는 색)
export const BLANK = '#ffffff';     // 빈 셀 / 여백

const hex2 = (n) => n.toString(16).padStart(2, '0');
/** 레벨 3개(R,G,B) → '#rrggbb' */
export const cellColor = (r, g, b) =>
    `#${hex2(levelToByte(r))}${hex2(levelToByte(g))}${hex2(levelToByte(b))}`;

/** 마커 3곳 — 좌상, 우상, 좌하. 각각 3x3 셀. 분석기가 이걸로 격자를 잡는다. */
export const MARKERS = [
    { col: 0, row: 0 },
    { col: COLS - 3, row: 0 },
    { col: 0, row: ROWS - 3 },
];
export const MARKER_SIZE = 3;

/** 보정 띠 — 16단계 회색. 모니터/브라우저 색 편차를 분석기가 흡수한다. */
export const CAL_COL = 4;           // 좌상 마커(0..2) 다음, 한 칸 띄우고
export const CAL_ROW = 0;

// ---------------------------------------------------------------------------
// 1. 직렬화 — fs 병렬 리스트 ↔ 문자열
// ---------------------------------------------------------------------------
//   SNAP1|<노드수>|   그리고 노드마다
//   <부모>|<타입>|<이름길이>|<이름><내용길이>|<내용>
//
// 노드는 fs 리스트 순서 그대로다. 부모 인덱스가 1-based 그대로 보존되므로
// 복원 쪽은 순서대로 다시 append 하기만 하면 된다.

/** @param {{name:string,parent:number,type:string,data:string}[]} nodes */
export function serialize(nodes) {
    let s = `SNAP1|${nodes.length}|`;
    for (const n of nodes) {
        const name = String(n.name ?? '');
        const data = String(n.data ?? '');
        s += `${n.parent}|${n.type}|${name.length}|${name}${data.length}|${data}`;
    }
    return s;
}

export function deserialize(s) {
    let p = 0;
    const upto = () => {                       // '|' 까지 읽고 '|' 를 건너뛴다
        const i = s.indexOf('|', p);
        if (i < 0) throw new Error(`구분자 없음 @${p}`);
        const v = s.slice(p, i);
        p = i + 1;
        return v;
    };
    const exact = (n) => {                     // 정확히 n 글자
        if (p + n > s.length) throw new Error(`문자열이 짧다 @${p} (${n}글자 필요)`);
        const v = s.slice(p, p + n);
        p += n;
        return v;
    };

    if (upto() !== 'SNAP1') throw new Error('SNAP1 헤더가 아니다');
    const count = Number(upto());
    if (!Number.isInteger(count) || count < 0) throw new Error(`노드 수가 이상하다: ${count}`);

    const nodes = [];
    for (let i = 0; i < count; i++) {
        const parent = Number(upto());
        const type = upto();
        const name = exact(Number(upto()));
        const data = exact(Number(upto()));
        nodes.push({ name, parent, type, data });
    }
    if (p !== s.length) throw new Error(`끝에 ${s.length - p}글자가 남았다`);
    return nodes;
}

// ---------------------------------------------------------------------------
// 2. 글자 ↔ 바이트 (UTF-8, 엔트리가 할 수 있는 범위만)
// ---------------------------------------------------------------------------
// 엔트리에는 chr()/ord() 가 없다. 표 문자열 + charAt / 글자찾기로 흉내내는데
// (docs 의 §5 참고) 표를 둘 수 있는 범위는 **ASCII 와 한글 음절 11,172자**다.
// 그 밖의 글자는 '?' 로 떨어뜨린다. JS 쪽도 **똑같이** 떨어뜨려야 왕복이 맞는다.
//
// 이게 손실처럼 보이지만 실은 손실이 아니다: **이 OS 는 그 범위 밖의 글자를 애초에
// 만들 수 없다.** 키보드 핸들러가 ASCII 를 내고, 입력기가 한글 음절을 낸다. 그래서
// 범위가 정확히 맞는다. 유일한 구멍은 내가 에디터에서 써 넣는 **씨앗 파일**(pyprog/,
// www/)이다 — 거기 '—' 같은 활자용 글자가 섞이면 조용히 '?' 가 된다.
// → `tools/test_snap.mjs` 가 씨앗을 검사해서 그걸 잡는다.

export const HANGUL_BASE = 0xac00;
export const HANGUL_LAST = 0xd7a3;

// ⚠ 표에 있는 글자만 ord() 가 된다. 표는 **출력 가능한 ASCII 95자 + 줄바꿈**이다.
//
//   줄바꿈이 왜 필요한가: fs_data 는 '|' 가 줄바꿈이라는 게 이 OS 의 규약인데
//   www/*.html 은 진짜 U+000A 를 담고 있다(브라우저 파서가 공백으로 읽는다).
//   스냅샷의 일은 있는 것을 보존하는 것이지 규약을 다시 따지는 게 아니다.
//
//   왜 표 맨 앞에 붙였나: `eq(글자, '\n')` 은 못 쓴다. 비교 블록은 양쪽을 숫자로
//   읽어서 공백·빈 문자열·'0' 이 줄바꿈과 전부 같아진다(HANDOFF §3). `글자 찾기`는
//   진짜 문자열 검색이라 안전하다. 그래서 표 1번 자리를 줄바꿈에 준다.
//
//   ORD_TABLE 은 **엔트리 쪽 src/snap.mjs 가 그대로 import 한다.** 정의가 하나여야
//   JS 와 블록이 어긋나지 않는다.
export const ASCII_LO = 32;
export const ASCII_HI = 126;
export const NL = 10;
export const ORD_TABLE = '\n' + Array.from(
    { length: ASCII_HI - ASCII_LO + 1 }, (_, i) => String.fromCharCode(ASCII_LO + i)).join('');
/** 표 위치(1-based) → 코드. 1번은 줄바꿈, 그 뒤는 32부터. */
export const posToCode = (p) => (p === 1 ? NL : p + ASCII_LO - 2);

export function textToBytes(s) {
    const out = [];
    for (const ch of s) {
        const c = ch.codePointAt(0);
        if (c === NL || (c >= ASCII_LO && c <= ASCII_HI)) {
            out.push(c);
        } else if (c >= HANGUL_BASE && c <= HANGUL_LAST) {
            out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        } else {
            out.push(0x3f);                     // '?'
        }
    }
    return Uint8Array.from(out);
}

export function bytesToText(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length;) {
        const b = bytes[i];
        if (b === NL || (b >= ASCII_LO && b <= ASCII_HI)) { s += String.fromCharCode(b); i += 1; }
        else if ((b & 0xf0) === 0xe0 && i + 2 < bytes.length) {
            s += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
            i += 3;
        } else { s += '?'; i += 1; }            // 2바이트/4바이트는 애초에 안 만든다
    }
    return s;
}

/** 엔트리가 표현할 수 있는 글자만 남긴 문자열. 직렬화 **전에** 통과시키면
 *  왕복이 반드시 맞는다 (엔트리 쪽 인코딩과 같은 손실을 미리 적용). */
export const normalize = (s) => bytesToText(textToBytes(s));

// ---------------------------------------------------------------------------
// 3. 바이트 ↔ 셀 (12비트/셀)
// ---------------------------------------------------------------------------
// 3바이트(24비트) = 셀 2개. 셀 하나는 니블 3개 = (R,G,B) 레벨.

/** @returns {number[]} 레벨 배열. 길이 = 셀 수 * 3 */
export function bytesToLevels(bytes) {
    const lv = [];
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i], b1 = bytes[i + 1] ?? 0, b2 = bytes[i + 2] ?? 0;
        lv.push(b0 >> 4, b0 & 0xf, b1 >> 4);            // 셀 1
        lv.push(b1 & 0xf, b2 >> 4, b2 & 0xf);           // 셀 2
    }
    return lv;
}

/** @param {number[]} lv @param {number} byteLen 실제 바이트 수 (패딩을 버린다) */
export function levelsToBytes(lv, byteLen) {
    const out = [];
    for (let i = 0; i < lv.length; i += 6) {
        const g = (k) => lv[i + k] ?? 0;
        out.push((g(0) << 4) | g(1), (g(2) << 4) | g(3), (g(4) << 4) | g(5));
        if (byteLen !== undefined && out.length >= byteLen) break;
    }
    return Uint8Array.from(byteLen === undefined ? out : out.slice(0, byteLen));
}

// ---------------------------------------------------------------------------
// 4. 페이지 — 헤더 + 쪽 나누기
// ---------------------------------------------------------------------------
// 페이지 바이트 = [쪽번호, 전체쪽수, 길이상위, 길이하위, ...데이터]
// 쪽 번호를 페이로드 **안**에 두면 분석기가 순서를 스스로 맞출 수 있다.

export function paginate(bytes) {
    const total = Math.max(1, Math.ceil(bytes.length / PAGE_CAPACITY));
    if (total > 255) throw new Error(`너무 크다: ${bytes.length}바이트 (최대 ${PAGE_CAPACITY * 255})`);
    const pages = [];
    for (let i = 0; i < total; i++) {
        const chunk = bytes.slice(i * PAGE_CAPACITY, (i + 1) * PAGE_CAPACITY);
        const buf = new Uint8Array(HEADER_BYTES + chunk.length);
        buf[0] = i + 1;
        buf[1] = total;
        buf[2] = chunk.length >> 8;
        buf[3] = chunk.length & 0xff;
        buf.set(chunk, HEADER_BYTES);
        pages.push(buf);
    }
    return pages;
}

/** 페이지 바이트들을 순서대로 이어붙인다. 빠진 쪽이 있으면 던진다. */
export function depaginate(pages) {
    const parsed = pages.map((b) => ({
        no: b[0], total: b[1], len: (b[2] << 8) | b[3], body: b.slice(HEADER_BYTES),
    }));
    const total = parsed[0]?.total ?? 0;
    if (parsed.some((p) => p.total !== total)) throw new Error('쪽마다 전체 쪽수가 다르다');
    if (parsed.length !== total) throw new Error(`${total}쪽 중 ${parsed.length}쪽만 있다`);
    parsed.sort((a, b) => a.no - b.no);
    parsed.forEach((p, i) => { if (p.no !== i + 1) throw new Error(`${i + 1}쪽이 없다`); });
    const out = [];
    for (const p of parsed) {
        if (p.body.length < p.len) throw new Error(`${p.no}쪽이 잘렸다`);
        out.push(...p.body.slice(0, p.len));
    }
    return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// 5. 격자 — 셀 배치 + 행 체크섬
// ---------------------------------------------------------------------------
// 행 체크섬은 셀 2개다:
//   [78] 그 행 데이터 니블 234개의 합 mod 4096
//   [79] 행 번호 mod 4096  ← 행이 밀려 읽히는 사고를 잡는다
// 12비트가 셀 하나에 그대로 들어가므로 계산도 그리기도 한 번씩이다.

const cksum = (levels) => levels.reduce((a, b) => a + b, 0) % 4096;
const to3 = (v) => [(v >> 8) & 0xf, (v >> 4) & 0xf, v & 0xf];
const from3 = (a, b, c) => (a << 8) | (b << 4) | c;

/**
 * 페이지 바이트 → 격자.
 * @returns {{col:number,row:number,color:string}[]} 그릴 셀 목록 (마커·보정 띠 포함)
 */
export function layout(pageBytes) {
    const lv = bytesToLevels(pageBytes);
    const cells = [];

    for (const m of MARKERS) {
        for (let dr = 0; dr < MARKER_SIZE; dr++) {
            for (let dc = 0; dc < MARKER_SIZE; dc++) {
                cells.push({ col: m.col + dc, row: m.row + dr, color: MARKER });
            }
        }
    }
    for (let i = 0; i < 16; i++) {
        cells.push({ col: CAL_COL + i, row: CAL_ROW, color: cellColor(i, i, i) });
    }

    for (let r = 0; r < DATA_ROWS; r++) {
        const rowLv = [];
        for (let c = 0; c < DATA_COLS; c++) {
            const k = (r * DATA_COLS + c) * 3;
            const [R, G, B] = [lv[k] ?? 0, lv[k + 1] ?? 0, lv[k + 2] ?? 0];
            rowLv.push(R, G, B);
            cells.push({ col: c, row: DATA_ROW0 + r, color: cellColor(R, G, B) });
        }
        const [s0, s1, s2] = to3(cksum(rowLv));
        const [r0, r1, r2] = to3(r % 4096);
        cells.push({ col: CK_COL, row: DATA_ROW0 + r, color: cellColor(s0, s1, s2) });
        cells.push({ col: CK_COL + 1, row: DATA_ROW0 + r, color: cellColor(r0, r1, r2) });
    }
    return cells;
}

/**
 * 격자에서 읽은 레벨 → 페이지 바이트. 분석기가 쓰는 쪽.
 * @param {number[][][]} grid  grid[row][col] = [R,G,B] 레벨
 * @returns {{bytes:Uint8Array, badRows:number[]}}
 */
export function readGrid(grid) {
    const lv = [];
    const badRows = [];
    for (let r = 0; r < DATA_ROWS; r++) {
        const row = grid[DATA_ROW0 + r];
        const rowLv = [];
        for (let c = 0; c < DATA_COLS; c++) rowLv.push(...row[c]);
        const gotSum = from3(...row[CK_COL]);
        const gotRow = from3(...row[CK_COL + 1]);
        if (gotSum !== cksum(rowLv) || gotRow !== r % 4096) badRows.push(r);
        lv.push(...rowLv);
    }
    const raw = levelsToBytes(lv);
    const len = (raw[2] << 8) | raw[3];
    return { bytes: raw.slice(0, HEADER_BYTES + len), badRows };
}

/** layout() 결과를 readGrid() 가 먹는 모양으로 되돌린다 (테스트/분석기 공용). */
export function cellsToGrid(cells) {
    const grid = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => [0, 0, 0]));
    for (const { col, row, color } of cells) {
        if (color === MARKER || color === BLANK) continue;
        grid[row][col] = [
            byteToLevel(parseInt(color.slice(1, 3), 16)),
            byteToLevel(parseInt(color.slice(3, 5), 16)),
            byteToLevel(parseInt(color.slice(5, 7), 16)),
        ];
    }
    return grid;
}

// ---------------------------------------------------------------------------
// 6. 한 방에 쓰는 입구
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 7. 분석기 — 스크린샷 픽셀 → 격자
// ---------------------------------------------------------------------------
// 여기 있는 이유: `tools/encoder.html` 이 이 파일을 통째로 인라인한다(빌드가 끼워
// 넣는다). 인코더에 따로 적으면 정의가 두 벌이 되고, 어긋나도 아무 말이 없다.
// 그리고 여기 있으면 **브라우저 없이 Node 에서 테스트할 수 있다.**
//
// 입력은 {width, height, data} — 캔버스 ImageData 와 같은 모양이면 뭐든 된다.

const px = (img, x, y) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
// ⚠ 문턱을 넉넉히 잡으면 **데이터 셀이 마커로 잡힌다.** 레벨 (15,0,15) 셀은
//   (248,8,248) 이라 "붉고 푸르고 안 초록"인 어떤 느슨한 조건에도 걸린다.
//   채널 값이 8..248 뿐이라는 사실이 여기서 값을 한다 — 250/6 은 데이터가
//   절대 못 넘는 선이다. (PNG 무손실이 전제라 이래도 된다. 그래서 JPEG 를 막는다)
const isMarker = (r, g, b) => r >= 250 && g <= 6 && b >= 250;

/**
 * 마커 3개를 찾아 격자 기하를 잡는다.
 * 마커 중심은 셀 좌표로 좌상(1.5,1.5) 우상(COLS-1.5,1.5) 좌하(1.5,ROWS-1.5) 이다.
 * 두 벡터로 풀면 **확대·이동은 물론 약간의 기울어짐까지** 흡수된다.
 */
export function findGeometry(img) {
    const seen = new Uint8Array(img.width * img.height);
    const blobs = [];
    for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
            const k = y * img.width + x;
            if (seen[k]) continue;
            const [r, g, b] = px(img, x, y);
            if (!isMarker(r, g, b)) { seen[k] = 1; continue; }
            // 너비우선으로 한 덩어리를 훑는다
            let sx = 0; let sy = 0; let n = 0;
            const stack = [[x, y]];
            seen[k] = 1;
            while (stack.length) {
                const [cx, cy] = stack.pop();
                sx += cx; sy += cy; n++;
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nx = cx + dx; const ny = cy + dy;
                    if (nx < 0 || ny < 0 || nx >= img.width || ny >= img.height) continue;
                    const nk = ny * img.width + nx;
                    if (seen[nk]) continue;
                    seen[nk] = 1;
                    const [pr, pg, pb] = px(img, nx, ny);
                    if (isMarker(pr, pg, pb)) stack.push([nx, ny]);
                }
            }
            blobs.push({ x: sx / n, y: sy / n, n });
        }
    }
    if (blobs.length < 3) throw new Error(`마커를 ${blobs.length}개만 찾았습니다 (3개 필요) — 화면 전체가 나왔는지 확인하세요`);
    blobs.sort((a, b) => b.n - a.n);
    const top3 = blobs.slice(0, 3).sort((a, b) => a.y - b.y);
    const [p1, p2] = [top3[0], top3[1]].sort((a, b) => a.x - b.x);
    const tl = p1; const tr = p2; const bl = top3[2];

    const half = MARKER_SIZE / 2;                       // 1.5
    const colV = { x: (tr.x - tl.x) / (COLS - 2 * half), y: (tr.y - tl.y) / (COLS - 2 * half) };
    const rowV = { x: (bl.x - tl.x) / (ROWS - 2 * half), y: (bl.y - tl.y) / (ROWS - 2 * half) };
    const org = { x: tl.x - half * (colV.x + rowV.x), y: tl.y - half * (colV.y + rowV.y) };
    return { org, colV, rowV, cellPx: Math.hypot(colV.x, colV.y) };
}

/** 셀 중앙 부근의 **중앙값**을 쓴다. 한 픽셀만 보면 안티앨리어싱에 걸린다. */
function sampleCell(img, geo, col, row) {
    const cx = geo.org.x + (col + 0.5) * geo.colV.x + (row + 0.5) * geo.rowV.x;
    const cy = geo.org.y + (col + 0.5) * geo.colV.y + (row + 0.5) * geo.rowV.y;
    const w = Math.max(0, Math.floor(geo.cellPx / 4));
    const ch = [[], [], []];
    for (let dy = -w; dy <= w; dy++) {
        for (let dx = -w; dx <= w; dx++) {
            const x = Math.round(cx + dx); const y = Math.round(cy + dy);
            if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
            const p = px(img, x, y);
            for (let i = 0; i < 3; i++) ch[i].push(p[i]);
        }
    }
    return ch.map((a) => {
        if (!a.length) return 0;
        a.sort((p, q) => p - q);
        return a[a.length >> 1];
    });
}

/**
 * 스크린샷 하나 → 레벨 격자.
 * @param {boolean} useCal 보정 띠로 색을 보정할지. 모니터/브라우저 색 편차를 흡수한다.
 */
/**
 * 마커로 잡은 격자를 **행 번호 셀로 검산해 미세 조정한다.**
 *
 * 🔴 실기에서 위 3행만 맞고 나머지 36행이 전부 체크섬 실패였다. 그리는 쪽은
 *   시뮬레이터로 확인했을 때 완벽했다 — 어긋난 것은 **찍은 그림에서 격자 자리를
 *   잡는 단계**다. 마커 중심이 반 픽셀만 틀어져도 아래로 갈수록 밀려서(drift)
 *   위쪽 몇 줄만 살아남는다. 정확히 그 모양이었다.
 *
 * 다행히 격자는 **자기가 몇 행인지 적고 다닌다** (CK_COL+1 셀 = r % 4096).
 * 그래서 정답을 알고 맞출 수 있다: 원점과 행 간격을 조금씩 흔들어 보고
 * **행 번호가 가장 많이 맞는** 것을 고른다. 사람이 다시 찍을 필요가 없다.
 */
function refineGeometry(img, geo) {
    const scoreOf = (g) => {
        let ok = 0;
        for (let r = 0; r < DATA_ROWS; r++) {
            const cell = sampleCell(img, g, CK_COL + 1, DATA_ROW0 + r).map(byteToLevel);
            if (from3(...cell) === r % 4096) ok++;
        }
        return ok;
    };
    let best = geo;
    let bestScore = scoreOf(geo);
    if (bestScore === DATA_ROWS) return { geo, score: bestScore, tuned: false };

    // 원점을 ±0.6셀, 행 간격을 ±1.5% 안에서 흔든다. 그 밖이면 마커를 잘못 잡은
    // 것이라 흔들어도 안 맞고, 넓게 뒤지면 엉뚱한 자리에 걸릴 위험만 커진다.
    const step = geo.cellPx / 6;
    for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
            for (const k of [1, 0.995, 1.005, 0.99, 1.01, 0.985, 1.015]) {
                const g = {
                    org: { x: geo.org.x + dx * step, y: geo.org.y + dy * step },
                    colV: geo.colV,
                    rowV: { x: geo.rowV.x * k, y: geo.rowV.y * k },
                    cellPx: geo.cellPx,
                };
                const sc = scoreOf(g);
                if (sc > bestScore) { bestScore = sc; best = g; }
                if (bestScore === DATA_ROWS) return { geo: best, score: bestScore, tuned: true };
            }
        }
    }
    return { geo: best, score: bestScore, tuned: best !== geo };
}

export function readImage(img, useCal = true) {
    const found = findGeometry(img);
    const { geo, score, tuned } = refineGeometry(img, found);

    // 보정 띠 — 16단계 회색의 **실측값**. 이걸 기준으로 양자화하면 감마가 틀어져도 맞는다.
    let ref = null;
    if (useCal) {
        ref = Array.from({ length: 16 }, (_, i) => {
            const s = sampleCell(img, geo, CAL_COL + i, CAL_ROW);
            return (s[0] + s[1] + s[2]) / 3;
        });
        // 단조증가가 아니면 띠를 잘못 읽은 것이다. 그럴 땐 이론값으로 돌아간다.
        for (let i = 1; i < 16; i++) if (ref[i] <= ref[i - 1]) { ref = null; break; }
    }
    const quant = (v) => {
        if (!ref) return byteToLevel(v);
        let best = 0;
        for (let i = 1; i < 16; i++) if (Math.abs(v - ref[i]) < Math.abs(v - ref[best])) best = i;
        return best;
    };

    const grid = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => [0, 0, 0]));
    for (let r = DATA_ROW0; r < DATA_ROW0 + DATA_ROWS; r++) {
        for (let c = 0; c < COLS; c++) grid[r][c] = sampleCell(img, geo, c, r).map(quant);
    }
    return { grid, geo, calibrated: !!ref, rowsOk: score, tuned };
}

/**
 * 스크린샷 여러 장 → 원래 노드 목록. 인코더 탭이 부르는 입구.
 * @returns {{nodes, text, pages, calibrated}}
 */
export function analyze(images, useCal = true) {
    const reads = images.map((im) => readImage(im, useCal));
    // 🔴 **원문을 먼저 꺼낸다.** 무엇이 담겨 있는지는 그 다음 문제다 —
    //   같은 격자에 파일시스템(SNAP1)도 슬라이드 문서(PPT1)도 들어온다.
    const raw = decodeText(reads.map((r) => r.grid));
    const out = {
        raw,
        kind: raw.startsWith('SNAP1|') ? 'snap' : (raw.startsWith('PPT1|') ? 'ppt' : 'unknown'),
        pages: reads.length,
        calibrated: reads.every((r) => r.calibrated),
    };
    // 파일시스템 스냅샷일 때만 노드로 푼다. 그 밖은 원문 그대로 넘긴다.
    if (out.kind === 'snap') {
        out.nodes = deserialize(raw);
        out.text = serialize(out.nodes);
    } else {
        out.text = raw;
    }
    return out;
}

/**
 * 셀 목록 → 가짜 스크린샷. **테스트 전용** — 분석기를 브라우저 없이 검증한다.
 * scale 은 픽셀 배율, (ox,oy) 는 여백. 실제 스크린샷의 확대·이동을 흉내낸다.
 */
export function render(cells, { scale = 1, ox = 0, oy = 0, bg = [13, 17, 23] } = {}) {
    const W = Math.round(COLS * CELL * scale) + ox * 2;
    const H = Math.round(ROWS * CELL * scale) + oy * 2;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
        data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255;
    }
    for (const { col, row, color } of cells) {
        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        const x0 = Math.round(col * CELL * scale) + ox;
        const y0 = Math.round(row * CELL * scale) + oy;
        const x1 = Math.round((col + 1) * CELL * scale) + ox;
        const y1 = Math.round((row + 1) * CELL * scale) + oy;
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                if (x < 0 || y < 0 || x >= W || y >= H) continue;
                const i = (y * W + x) * 4;
                data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
            }
        }
    }
    return { width: W, height: H, data };
}

/** 노드 목록 → 페이지별 셀 목록 */
export function encode(nodes) {
    return encodeText(serialize(nodes));
}

/**
 * 🔴 **아무 문자열이나** 격자로 만든다.
 *   `encode` 는 파일시스템 노드 전용이라 `serialize`(SNAP1)를 거친다. 그런데
 *   이 코덱을 쓰는 것이 하나가 아니다 — entry-ppt 는 자기 문서(PPT1 문자열)를
 *   같은 격자에 담는다. 담는 것이 무엇이든 격자·마커·체크섬은 똑같으므로,
 *   **문자열 층과 포맷 층을 가른다.**
 */
export function encodeText(s) {
    return paginate(textToBytes(s)).map(layout);
}

/**
 * 격자 목록 → **담겨 있던 문자열 그대로**.
 * 🔴 포맷을 모른다 — SNAP1 일 수도, PPT1 일 수도 있다. 그걸 아는 것은 부르는 쪽이다.
 *   `decode` 가 늘 `deserialize` 를 거치는 바람에 entry-ppt 스냅샷은 넣어도
 *   파싱이 엉켰다 (SNAP1 이 아니니까). 층을 가르면 둘 다 읽힌다.
 */
export function decodeText(grids) {
    const pages = [];
    const bad = [];
    grids.forEach((g, i) => {
        const { bytes, badRows } = readGrid(g);
        if (badRows.length) bad.push({ page: i + 1, rows: badRows });
        pages.push(bytes);
    });
    if (bad.length) {
        const d = bad.map((b) => `${b.page}쪽 ${b.rows.length}행`).join(', ');
        throw new Error(`체크섬 실패 (${d}) — 다시 촬영할 것`);
    }
    return bytesToText(depaginate(pages));
}

/** 격자 목록 → 노드 목록 (파일시스템 스냅샷) */
export function decode(grids) {
    return deserialize(decodeText(grids));
}
