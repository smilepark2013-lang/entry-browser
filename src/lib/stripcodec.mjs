// src/lib/stripcodec.mjs — 무대 왼쪽 띠에 그리는 작은 격자 (Entry Browser 의 요청)
//
// 엔트리 OS 스냅샷 격자(snapcodec.mjs)는 **무대 전체**를 쓴다. 요청 하나를 보내자고
// 브라우저 화면을 통째로 가리는 것은 어색해서, Entry Browser 는 왼쪽 84px 띠에만 그린다.
// 그동안 페이지는 그대로 보인다.
//
// 바이트·색·체크섬 규칙은 snapcodec 과 **같다** (거기서 가져온다). 다른 것은 기하뿐이다.
//
//   ┌────────────────┐  col 0..13 (6px 칸, 84px)
//   │MMM cccccccc MMM│  row 0..2   마커 3x3 두 개 + 보정 띠 16칸 (8x2 자리에 접어 넣는다)
//   │MMM cccccccc MMM│
//   │MMM          MMM│
//   │dddddddddddd kr │  row 3..24  데이터 12칸 + 행 체크섬 2칸 (k 니블 합, r 행 번호)
//   │   ...          │
//   │MMM             │  row 25..27 좌하 마커
//   └────────────────┘  y = -33 (그 아래 102px 는 비워 둔다 — 입력창이 뜨는 자리)
//
// 🔴 처음엔 36행(216px)이었는데 실기에서 입력창이 아래쪽 마커·체크섬을 가렸다
//   (그래도 읽히긴 했다 — 판독기가 행 번호로 자리를 맞춘다). 28행으로 줄이고 폭을 늘렸다.
//
// 쪽은 늘 하나다. 용량은 392 바이트 (헤더 4바이트 제외) — 주소 하나에는 충분하다.

import {
    textToBytes, bytesToText, bytesToLevels, levelsToBytes,
    levelToByte, byteToLevel, cellColor, MARKER, BLANK,
} from './snapcodec.mjs';

export const CELL = 6;
export const COLS = 14;
export const ROWS = 28;
export const X0 = -240;                 // 무대 좌표: 띠의 왼쪽 위
export const Y0 = 135;
export const WIDTH = COLS * CELL;       // 84
export const HEIGHT = ROWS * CELL;      // 168

export const MARKER_SIZE = 3;
export const MARKERS = [
    { col: 0, row: 0 },
    { col: COLS - 3, row: 0 },
    { col: 0, row: ROWS - 3 },
];
// 보정 띠 16칸: 위 마커 사이 6x3 자리에 접어 넣는다. i 번째 → (CAL_COL + i % 6, i / 6)
export const CAL_COL = 3;
export const CAL_W = COLS - 6;          // 8칸 x 2줄 = 16
export const calCell = (i) => ({ col: CAL_COL + (i % CAL_W), row: Math.floor(i / CAL_W) });

export const DATA_ROW0 = 3;
export const DATA_ROWS = ROWS - 6;      // 22
export const DATA_COLS = COLS - 2;      // 12
export const CK_COL = DATA_COLS;        // 12, 13
export const CELLS = DATA_ROWS * DATA_COLS;                      // 264
export const HEADER_BYTES = 4;                                     // 쪽, 전체쪽수, 길이(2)
export const CAPACITY = Math.floor(CELLS * 3 / 2) - HEADER_BYTES;  // 392

// 남는 칸을 채우는 바이트. 판독기는 머리의 길이까지만 읽으므로 무엇이든 되는데,
// 0 으로 채우면 띠가 시커먼 덩어리가 된다. 이 세 바이트를 되풀이하면 칸이 전부
// 레벨 (1,2,4) = #182848 — 띠 바탕(#0f172a)과 비슷한 남색이 된다.
// 자리는 **머리부터 센 바이트 위치 % 3** 으로 고른다 (엔트리 쪽 grid.mjs 와 같은 규칙).
export const PAD = [0x12, 0x41, 0x24];

const cksum = (levels) => levels.reduce((a, b) => a + b, 0) % 4096;
const to3 = (v) => [(v >> 8) & 0xf, (v >> 4) & 0xf, v & 0xf];
const from3 = (a, b, c) => (a << 8) | (b << 4) | c;

/** 문자열 → 그릴 셀 목록 (테스트와 미리보기용. 엔트리 쪽은 entry/src/grid.mjs 가 같은 것을 그린다) */
export function layoutText(s) {
    const body = textToBytes(s);
    if (body.length > CAPACITY) throw new Error(`요청이 너무 깁니다: ${body.length}바이트 (최대 ${CAPACITY})`);
    const bytes = new Uint8Array(CELLS * 3 / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = PAD[i % 3];
    bytes.set([1, 1, body.length >> 8, body.length & 0xff]);
    bytes.set(body, HEADER_BYTES);
    const lv = bytesToLevels(bytes);

    const cells = [];
    for (const m of MARKERS) {
        for (let dr = 0; dr < MARKER_SIZE; dr++) {
            for (let dc = 0; dc < MARKER_SIZE; dc++) cells.push({ col: m.col + dc, row: m.row + dr, color: MARKER });
        }
    }
    for (let i = 0; i < 16; i++) cells.push({ ...calCell(i), color: cellColor(i, i, i) });
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

/** grid[row][col] = [R,G,B] 레벨 → 문자열. 체크섬이 하나라도 틀리면 던진다. */
export function readGrid(grid) {
    const lv = [];
    const bad = [];
    for (let r = 0; r < DATA_ROWS; r++) {
        const row = grid[DATA_ROW0 + r];
        const rowLv = [];
        for (let c = 0; c < DATA_COLS; c++) rowLv.push(...row[c]);
        if (from3(...row[CK_COL]) !== cksum(rowLv) || from3(...row[CK_COL + 1]) !== r % 4096) bad.push(r);
        lv.push(...rowLv);
    }
    if (bad.length) throw new Error(`체크섬 실패 (${bad.length}행)`);
    const raw = levelsToBytes(lv);
    const len = (raw[2] << 8) | raw[3];
    if (raw[0] !== 1 || raw[1] !== 1 || len > CAPACITY) throw new Error('띠 격자 머리가 이상합니다');
    return bytesToText(raw.slice(HEADER_BYTES, HEADER_BYTES + len));
}

/** layoutText 결과 → readGrid 가 먹는 모양 (테스트용) */
export function cellsToGrid(cells) {
    const grid = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => [0, 0, 0]));
    for (const { col, row, color } of cells) {
        if (color === MARKER || color === BLANK) continue;
        grid[row][col] = [1, 3, 5].map((i) => byteToLevel(parseInt(color.slice(i, i + 2), 16)));
    }
    return grid;
}

// ---------------------------------------------------------------------------
// 판독 — 캡처한 화면 → 격자 (snapcodec.readImage 와 같은 수법, 기하만 다르다)
// ---------------------------------------------------------------------------
const px = (img, x, y) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const isMarker = (r, g, b) => r >= 250 && g <= 6 && b >= 250;

export function findGeometry(img) {
    const seen = new Uint8Array(img.width * img.height);
    const blobs = [];
    for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
            const k = y * img.width + x;
            if (seen[k]) continue;
            seen[k] = 1;
            if (!isMarker(...px(img, x, y))) continue;
            let sx = 0; let sy = 0; let n = 0;
            const stack = [[x, y]];
            while (stack.length) {
                const [cx, cy] = stack.pop();
                sx += cx; sy += cy; n++;
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nx = cx + dx; const ny = cy + dy;
                    if (nx < 0 || ny < 0 || nx >= img.width || ny >= img.height) continue;
                    const nk = ny * img.width + nx;
                    if (seen[nk]) continue;
                    seen[nk] = 1;
                    if (isMarker(...px(img, nx, ny))) stack.push([nx, ny]);
                }
            }
            blobs.push({ x: sx / n, y: sy / n, n });
        }
    }
    if (blobs.length < 3) throw new Error(`마커를 ${blobs.length}개만 찾았습니다`);
    blobs.sort((a, b) => b.n - a.n);
    const top3 = blobs.slice(0, 3).sort((a, b) => a.y - b.y);
    const [tl, tr] = [top3[0], top3[1]].sort((a, b) => a.x - b.x);
    const bl = top3[2];
    const half = MARKER_SIZE / 2;
    const colV = { x: (tr.x - tl.x) / (COLS - 2 * half), y: (tr.y - tl.y) / (COLS - 2 * half) };
    const rowV = { x: (bl.x - tl.x) / (ROWS - 2 * half), y: (bl.y - tl.y) / (ROWS - 2 * half) };
    const org = { x: tl.x - half * (colV.x + rowV.x), y: tl.y - half * (colV.y + rowV.y) };
    return { org, colV, rowV, cellPx: Math.hypot(colV.x, colV.y) };
}

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

/** 마커로 잡은 자리를 행 번호 셀로 검산해 미세 조정한다 (snapcodec.refineGeometry 와 같다) */
function refine(img, geo) {
    const score = (g) => {
        let ok = 0;
        for (let r = 0; r < DATA_ROWS; r++) {
            if (from3(...sampleCell(img, g, CK_COL + 1, DATA_ROW0 + r).map(byteToLevel)) === r) ok++;
        }
        return ok;
    };
    let best = geo; let bestScore = score(geo);
    if (bestScore === DATA_ROWS) return best;
    const step = geo.cellPx / 6;
    for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
            for (const k of [1, 0.995, 1.005, 0.99, 1.01]) {
                const g = { ...geo, org: { x: geo.org.x + dx * step, y: geo.org.y + dy * step },
                    rowV: { x: geo.rowV.x * k, y: geo.rowV.y * k } };
                const sc = score(g);
                if (sc > bestScore) { bestScore = sc; best = g; }
                if (bestScore === DATA_ROWS) return best;
            }
        }
    }
    return best;
}

/** 스크린샷(ImageData 꼴) → 담긴 문자열 */
export function readImage(img) {
    const geo = refine(img, findGeometry(img));
    let ref = Array.from({ length: 16 }, (_, i) => {
        const { col, row } = calCell(i);
        const s = sampleCell(img, geo, col, row);
        return (s[0] + s[1] + s[2]) / 3;
    });
    for (let i = 1; i < 16; i++) if (ref[i] <= ref[i - 1]) { ref = null; break; }
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
    return readGrid(grid);
}

/** 셀 목록 → 가짜 스크린샷 (테스트용) */
export function render(cells, { scale = 1, ox = 0, oy = 0, bg = [15, 23, 42] } = {}) {
    const W = Math.round(COLS * CELL * scale) + ox * 2;
    const H = Math.round(ROWS * CELL * scale) + oy * 2;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) data.set([...bg, 255], i * 4);
    for (const { col, row, color } of cells) {
        const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
        const x0 = Math.round(col * CELL * scale) + ox; const x1 = Math.round((col + 1) * CELL * scale) + ox;
        const y0 = Math.round(row * CELL * scale) + oy; const y1 = Math.round((row + 1) * CELL * scale) + oy;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([...rgb, 255], (y * W + x) * 4);
    }
    return { width: W, height: H, data };
}

export { levelToByte };
