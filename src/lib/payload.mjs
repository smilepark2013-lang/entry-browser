// src/lib/payload.mjs — 요청 해석과 응답 포장 (PROTOCOL.md §1, §2)
//
// 판이 둘이다. 요청이 어느 판인지 밝히고, 응답은 그 판으로 돌려준다.
//   WEB1 → EBR1   본문이 **간단한 HTML** (엔트리 OS 의 www — 엔트리가 HTML 을 파싱한다)
//   WEB2 → EBR2   본문이 **줄 목록** (Entry Browser — 배치를 앱이 끝내 보낸다, display.mjs)

import { textToBytes } from './snapcodec.mjs';
import { richText, toWire, readableUrl } from './display.mjs';

export const URL_MAX = 2000;

/** 엔트리가 덧셈과 나머지만으로 똑같이 계산할 수 있는 체크섬 */
export function adler32(bytes) {
    let a = 1;
    let b = 0;
    for (const x of bytes) { a = (a + x) % 65521; b = (b + a) % 65521; }
    return b * 65536 + a;
}

/** 격자에서 읽은 문자열 → {version, seq, url}. WEB1/WEB2 가 아니면 null (스냅샷·PPT 격자는 무시) */
export function parseRequest(raw) {
    const m = /^WEB([12])\|(\d{1,9})\|(.+)$/s.exec(raw);
    if (!m) return null;
    const url = m[3].trim();
    if (url.length > URL_MAX) return null;
    return { version: Number(m[1]), seq: Number(m[2]), url };
}

/** 응답 문자열. 본문은 `<최종 주소>\n<본문>` 의 UTF-8 (엔트리가 그릴 수 있는 글자만) */
export function encodeResponse(seq, finalUrl, body, version = 1) {
    // 판 1 은 엔트리 OS 표(ASCII + 한글 음절), 판 2 는 그보다 넓은 표(display.RICH_RANGES)
    const bytes = version === 2
        ? new TextEncoder().encode(toWire(richText(`${readableUrl(finalUrl)}\n${body}`)))   // 한자는 번호 자리로 (display.HANJA)
        : textToBytes(`${finalUrl}\n${body}`);
    return `EBR${version}|${seq}|${bytes.length}|${adler32(bytes)}|${Buffer.from(bytes).toString('base64')}`;
}
