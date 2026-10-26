// src/renderer/capture-worker.mjs — 캡처한 프레임에서 격자를 찾아 읽는다
//
// 프레임은 메시지로 받아 여기서만 쓰고 버린다. 저장하지 않는다.
//
// 격자는 두 가지다. 마커 셋이 이루는 사각형의 **가로세로 비**로 가른다.
//   Entry Browser   왼쪽 띠 (12x36칸)  — 세로로 길다 (비 ≈ 0.3)  → stripcodec
//   엔트리 OS www   무대 전체 (80x45칸) — 가로로 길다 (비 ≈ 1.8)  → snapcodec

import { readImage, decodeText } from '../lib/snapcodec.mjs';
import { readImage as readStrip } from '../lib/stripcodec.mjs';

const isMarker = (d, i) => d[i] >= 250 && d[i + 1] <= 6 && d[i + 2] >= 250;
const STRIDE = 2;       // 마커는 1배 크기에서도 18px 이라 두 칸씩 훑어도 놓치지 않는다

/** 마커 색 픽셀의 범위를 찾는다. 없으면 null — 대부분의 프레임은 여기서 끝난다. */
function markerBox({ width, height, data }) {
    let x0 = width; let y0 = height; let x1 = -1; let y1 = -1; let n = 0;
    for (let y = 0; y < height; y += STRIDE) {
        for (let x = 0; x < width; x += STRIDE) {
            if (!isMarker(data, (y * width + x) * 4)) continue;
            n++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
    }
    return n >= 12 ? { x0, y0, x1, y1 } : null;
}

/** 마커 범위만 잘라 판독기에 넘긴다. 전체 화면을 넘기면 덩어리 찾기가 느리다. */
function crop(img, b) {
    const pad = 12;
    const x0 = Math.max(0, b.x0 - pad); const y0 = Math.max(0, b.y0 - pad);
    const x1 = Math.min(img.width - 1, b.x1 + pad); const y1 = Math.min(img.height - 1, b.y1 + pad);
    const w = x1 - x0 + 1; const h = y1 - y0 + 1;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        const s = ((y0 + y) * img.width + x0) * 4;
        out.set(img.data.subarray(s, s + w * 4), y * w * 4);
    }
    return { width: w, height: h, data: out };
}

self.onmessage = ({ data: { width, height, buf } }) => {
    const img = { width, height, data: new Uint8ClampedArray(buf) };
    const box = markerBox(img);
    if (!box) return self.postMessage({ found: false });
    try {
        const part = crop(img, box);
        const tall = (box.x1 - box.x0) < (box.y1 - box.y0);
        const raw = tall ? readStrip(part) : decodeText([readImage(part).grid]);
        self.postMessage({ found: true, raw, kind: tall ? 'strip' : 'full' });
    } catch (e) {
        self.postMessage({ found: true, error: e.message });
    }
};
