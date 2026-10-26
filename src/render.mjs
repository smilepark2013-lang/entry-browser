// src/render.mjs — 렌더 모드: 보이지 않는 Chromium 창에서 페이지를 진짜로 연다
//
// 텍스트 모드(guard.fetchPage + jsdom)는 받은 HTML 을 그대로 읽는다. 자바스크립트가 그리는
// 사이트, 스크립트로 넘기는 경유 페이지, 단일 페이지 앱은 거기서 비어 보인다.
// 렌더 모드는 Electron 에 든 Chromium 으로 페이지를 열어 스크립트까지 실행하고,
// 화면이 잠잠해지면 **그려진 결과 DOM** 을 뽑아 똑같은 배치 엔진(layout.mjs)에 넘긴다.
//
// ⚠ 남의 사이트 코드를 이 컴퓨터에서 실행한다. 그래서 가둔다:
//   - 세션은 메모리에만 있는 별도 파티션 ('persist:' 아님) — 앱을 끄면 쿠키·저장소가 사라진다.
//   - 모든 요청은 proxy.mjs 를 지난다 (내부망 차단을 CSS·이미지·fetch·웹소켓까지).
//   - 샌드박스·contextIsolation, Node 없음. 권한·다운로드·팝업·대화상자·file:// 모두 막는다.
//   - WebRTC 는 프록시를 거치지 않는 UDP 를 못 쓰게 한다 (내부 IP 노출·우회 방지).
//   - 창은 페이지 하나마다 새로 만들고 다 뽑으면 바로 닫는다.

import { app, BrowserWindow, session } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUrl, BlockedError } from './lib/guard.mjs';
import { startProxy } from './lib/proxy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PARTITION = 'entry-browser-render';      // 'persist:' 를 붙이지 않는다 → 디스크에 안 남는다
const QUIET_MS = 700;                          // 이만큼 새 요청이 없으면 잠잠하다고 본다
const STALE_MS = 3000;                         // 이보다 오래 걸린 요청(롱폴링·광고 비콘)은 기다리지 않는다

let ready = null;
const live = new Map();                        // webContentsId → Map(requestId → 시작 시각)
const lastStart = new Map();                   // webContentsId → 마지막 요청 시작 시각
const mainType = new Map();                    // webContentsId → 본문 문서 Content-Type
const blocks = [];                             // 최근 프록시가 막은 것 [{host, reason}]

function setup() {
    ready ??= (async () => {
        const proxy = await startProxy({
            onBlock: (host, reason) => { blocks.push({ host: String(host), reason }); if (blocks.length > 40) blocks.shift(); },
        });
        const ses = session.fromPartition(PARTITION);
        await ses.setProxy({ proxyRules: `127.0.0.1:${proxy.port}`, proxyBypassRules: '<-loopback>' });
        ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
        ses.setPermissionCheckHandler(() => false);
        ses.setDevicePermissionHandler(() => false);
        ses.on('will-download', (e) => e.preventDefault());
        ses.setSpellCheckerEnabled(false);
        // 앱 이름·Electron 표시를 뺀 평범한 Chrome UA. 'Electron' 을 보고 막는 사이트가 있다.
        const ua = ses.getUserAgent()
            .replace(/\s*Electron\/\S+/, '')
            .replace(new RegExp(`\\s*${app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/\\S+`), '');
        ses.setUserAgent(ua, 'ko-KR,ko,en');

        const wcOf = (d) => d.webContentsId ?? -1;
        ses.webRequest.onBeforeRequest((d, cb) => {
            if (!/^(https?|wss?|data|blob):/i.test(d.url)) return cb({ cancel: true });
            const id = wcOf(d);
            if (!live.has(id)) live.set(id, new Map());
            live.get(id).set(d.id, Date.now());
            lastStart.set(id, Date.now());
            cb({});
        });
        ses.webRequest.onHeadersReceived((d, cb) => {
            if (d.resourceType === 'mainFrame') {
                const h = Object.entries(d.responseHeaders || {}).find(([k]) => k.toLowerCase() === 'content-type');
                mainType.set(wcOf(d), String(h?.[1]?.[0] || ''));
            }
            cb({});
        });
        const done = (d) => live.get(wcOf(d))?.delete(d.id);
        ses.webRequest.onCompleted(done);
        ses.webRequest.onErrorOccurred(done);
        return ses;
    })();
    return ready;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function busy(wc) {
    if (wc.isLoading()) return true;
    const now = Date.now();
    if (now - (lastStart.get(wc.id) || 0) < QUIET_MS) return true;
    for (const t of live.get(wc.id)?.values() || []) if (now - t < STALE_MS) return true;
    return false;
}

/**
 * 렌더해서 결과 DOM 을 HTML 로 돌려준다.
 * HTML 이 아닌 문서(글자·PDF 등)는 { fallback: true } — 텍스트 모드가 맡는다.
 * @returns {Promise<{html?:string, finalUrl:string, status:number, fallback?:boolean, ms:number}>}
 */
export async function renderPage(raw, { timeout = 15000, layout = false, images = 'pixel' } = {}) {
    const start = checkUrl(raw).href;            // 시작 주소는 바로 검사해 깔끔한 오류를 낸다
    const ses = await setup();
    const t0 = Date.now();
    const w = new BrowserWindow({
        show: false,
        // 레이아웃 모드는 좁은 화면(LAYOUT_W)으로 연다 — 반응형 사이트가 엔트리 본문 폭에 맞는 배치를 준다
        width: layout ? LAYOUT_W : 1024,
        height: 900,
        useContentSize: true,
        webPreferences: {
            session: ses,
            preload: join(HERE, 'render-preload.cjs'),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            javascript: true,
            images: layout,                      // 그림은 레이아웃 모드에서만 받는다 (저해상도 칸으로 옮긴다)
            webgl: false,
            plugins: false,
            spellcheck: false,
            backgroundThrottling: false,
            autoplayPolicy: 'document-user-activation-required',
        },
    });
    const wc = w.webContents;
    try {
        wc.setAudioMuted(true);
        wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
        wc.setWindowOpenHandler(() => ({ action: 'deny' }));
        wc.on('will-prevent-unload', (e) => e.preventDefault());
        // 레이아웃 모드: 글꼴을 맑은 고딕으로 — 엔트리가 그 글꼴로 그리므로(실기) Chromium 도 같은 폭으로 줄을 접게 한다
        if (layout) wc.on('dom-ready', () => { wc.insertCSS(FORCE_CSS).catch(() => {}); });

        let status = 0;
        let failed = null;
        wc.on('did-navigate', (_e, _u, code) => { status = code || status; });
        wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
            if (isMain && code !== -3) failed = { code, desc, url };     // -3 은 다른 곳으로 넘어가며 끊긴 것
        });
        wc.loadURL(start).catch(() => { /* did-fail-load 가 알려 준다 */ });

        while (Date.now() - t0 < timeout) {
            await sleep(100);
            if (failed) break;
            if (status && !busy(wc)) break;
        }
        const type = mainType.get(wc.id) || '';
        if (failed) {
            const host = (() => { try { return new URL(failed.url || start).host; } catch { return ''; } })();
            const b = [...blocks].reverse().find((x) => host && x.host.includes(host));
            if (b) throw new BlockedError(b.reason);
            throw new Error(`페이지를 열지 못했습니다 (${failed.desc || failed.code})`);
        }
        if (type && !/html/i.test(type)) return { fallback: true, finalUrl: wc.getURL() || start, status, ms: Date.now() - t0 };

        if (layout) return { ...(await takeLayout(w, wc, { capture: images === 'pixel' })), finalUrl: wc.getURL() || start, status: status || 200, ms: Date.now() - t0 };

        // 격리된 세계(isolated world)에서 뽑는다 — 페이지 스크립트가 바꿔 둔 내장 함수를 쓰지 않는다.
        const out = await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: EXTRACT }]);
        return { html: out.html, finalUrl: out.url || wc.getURL() || start, status: status || 200, ms: Date.now() - t0 };
    } finally {
        live.delete(wc.id);
        lastStart.delete(wc.id);
        mainType.delete(wc.id);
        w.destroy();
    }
}

// 그려진 DOM 을 복제하면서
//   - 화면에 안 보이는 요소(display:none, visibility:hidden, hidden, 접힌 details 속)를 뺀다
//   - 입력값·체크 상태를 속성으로 옮긴다 (스크립트가 채운 값은 속성에 없다)
//   - <noscript> 는 뺀다 (스크립트가 돌았으니 "자바스크립트를 켜세요" 문구다)
//   - **계산된 CSS** 를 data-eb 속성에 적는다 (형식은 css.mjs). 부모와 같은 값은 적지 않는다.
//     색은 1px 캔버스에 칠해 읽는다 — oklch()·color-mix() 처럼 rgb() 가 아닌 계산값도 #rrggbb 가 된다.
//     페이지 바탕(body → html → 흰색)은 <html data-eb-page> 에.
const EXTRACT = `(() => {
    const SKIP = new Set(['HEAD','SCRIPT','STYLE','NOSCRIPT','TEMPLATE','OPTION','OPTGROUP','BR','WBR',
        'SOURCE','TRACK','PARAM','AREA','MAP','TITLE','META','LINK','BASE']);
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const memo = new Map();
    const rgba = (c) => {                                  // 색 → [r, g, b, a(0~255)]
        if (memo.has(c)) return memo.get(c);
        g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1);
        const d = [...g.getImageData(0, 0, 1, 1).data];
        memo.set(c, d); return d;
    };
    const toHex = (r, gg, b) => '#' + [r, gg, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
    const hex = (c) => { const [r, gg, b, a] = rgba(c); return a < 128 ? '' : toHex(r, gg, b); };   // 반 넘게 비치면 없는 셈
    // 반투명 바탕은 아래 바탕과 섞는다 — 썸네일 위에 rgba(0,0,0,.6) 을 덮은 라벨이 그림 없이 새까만 띠가 됐다
    const over = (c, under) => {
        const [r, gg, b, a] = rgba(c);
        if (a < 26) return '';
        if (a > 249) return toHex(r, gg, b);
        const u = [1, 3, 5].map((i) => parseInt(under.slice(i, i + 2), 16));
        const t = a / 255;
        return toHex(r * t + u[0] * (1 - t), gg * t + u[1] * (1 - t), b * t + u[2] * (1 - t));
    };
    const look = (cs) => ({
        c: hex(cs.color), s: String(Math.round(parseFloat(cs.fontSize) || 16)),
        w: Number(cs.fontWeight) >= 600 ? '1' : '0',
        a: /center/.test(cs.textAlign) ? 'c' : /right|end/.test(cs.textAlign) ? 'r' : 'l',
        t: cs.textTransform === 'uppercase' ? 'u' : '',
        f: /mono|courier|consol|menlo|code/i.test(cs.fontFamily) ? 'm' : '',
    });
    // 접힌 <details> 의 속은 보이지 않아 빠진다 — 다 펼쳐 두고, 원래 접혀 있던 것에 표시를 단다
    // (엔트리가 그 자리에서 접고 편다)
    for (const d of document.querySelectorAll('details:not([open])')) { d.setAttribute('data-eb-closed', ''); d.open = true; }
    const root = document.documentElement;
    const orig = [root, ...root.querySelectorAll('*')];
    const copy = root.cloneNode(true);
    const dup = [copy, ...copy.querySelectorAll('*')];
    if (orig.length !== dup.length) return { html: '<!doctype html>' + root.outerHTML, url: location.href };
    const body = document.body;
    const page = (body && hex(getComputedStyle(body).backgroundColor)) || hex(getComputedStyle(root).backgroundColor) || '#ffffff';
    copy.setAttribute('data-eb-page', page);
    const seen = new Map();                                // 원본 요소 → 그 요소의 look (자식이 비교한다)
    const drop = [];
    for (let i = 0; i < orig.length; i++) {
        const el = orig[i], cl = dup[i], tag = el.tagName;
        if (tag === 'NOSCRIPT') { drop.push(cl); continue; }
        if (tag === 'INPUT') {
            if (el.type === 'checkbox' || el.type === 'radio') cl.toggleAttribute('checked', el.checked);
            else if (el.type !== 'password' && el.type !== 'file') cl.setAttribute('value', el.value);
        } else if (tag === 'TEXTAREA') {
            cl.textContent = el.value;
        } else if (tag === 'SELECT') {
            const o = cl.querySelectorAll('option');
            el.querySelectorAll('option').forEach((x, j) => o[j] && o[j].toggleAttribute('selected', x.selected));
        }
        if (SKIP.has(tag) || !body || !body.contains(el) || el.closest('select')) continue;
        if (el instanceof SVGElement && tag.toLowerCase() !== 'svg') continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'contents') { seen.set(el, seen.get(el.parentElement)); continue; }
        if (!el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) { drop.push(cl); continue; }
        const me = look(cs);
        const up = seen.get(el.parentElement) || {};
        seen.set(el, me);
        let out = '';
        for (const k of ['c', 's', 'w', 'a', 't', 'f']) if (me[k] !== up[k]) out += k + ':' + me[k] + ';';
        // 바탕은 물려받지 않는 속성이다. 보이는 바탕 = 가장 가까운 칠한 조상의 바탕이라
        // 그것과 달라질 때만 적는다 (어두운 띠 안의 흰 카드도 다시 흰색으로 적힌다).
        const own = el === body ? '' : over(cs.backgroundColor, up.b || page);
        me.b = own || up.b || page;
        if (me.b !== (up.b || page)) out += 'b:' + me.b + ';';
        if (out) cl.setAttribute('data-eb', out);
    }
    for (const cl of drop) cl.remove();
    return { html: '<!doctype html>' + copy.outerHTML, url: location.href };
})()`;

// ============================================================================ 레이아웃 모드
// Chromium 이 실제로 놓은 자리를 그리기 목록으로 뽑는다 (pager.mjs 가 쪽으로 나눈다).
export const LAYOUT_W = 600;          // CSS px. 엔트리 본문 366px 에 맞추면 0.61배 — 본문 16px 이 엔트리 10px 쯤
const LAYOUT_MAX_H = 9000;            // 이보다 긴 페이지는 자른다 (엔트리 쪽 수 한도)
const LAYOUT_MAX_W = 1200;            // 최소 폭이 넓은 페이지도 이 폭까지는 통째로 담는다 (그만큼 작게)
const FORCE_CSS = `*, *::before, *::after { font-family: "Malgun Gothic", "맑은 고딕", sans-serif !important; letter-spacing: normal !important; }
::-webkit-scrollbar { display: none !important; } html { scrollbar-width: none !important; }`;

async function takeLayout(w, wc, { capture = true } = {}) {
    // 창을 페이지 높이만큼 늘린다 — 전부 화면 안에 있어야 자리(getBoundingClientRect)와 캡처가 맞는다
    const h = await wc.executeJavaScriptInIsolatedWorld(1002, [{ code: `Math.min(document.documentElement.scrollHeight, ${LAYOUT_MAX_H})` }]);
    w.setContentSize(LAYOUT_W, Math.max(600, Math.ceil(h)));
    await sleep(350);
    // 최소 폭이 창보다 넓은 페이지(덕덕고 HTML 판은 655px)는 오른쪽이 넘쳐 카드 밖으로 나가고 캡처에서도 잘렸다.
    // 창을 그 폭(최대 LAYOUT_MAX_W)으로 늘려 다시 재고, pager 가 그 폭에 맞춰 줄인다.
    let width = LAYOUT_W;
    const sw = await wc.executeJavaScriptInIsolatedWorld(1002, [{ code: 'document.documentElement.scrollWidth' }]);
    if (sw > LAYOUT_W + 4) {
        width = Math.min(LAYOUT_MAX_W, Math.ceil(sw));
        const h2 = await wc.executeJavaScriptInIsolatedWorld(1002, [{ code: `Math.min(document.documentElement.scrollHeight, ${LAYOUT_MAX_H})` }]);
        w.setContentSize(width, Math.max(600, Math.ceil(h2)));
        await sleep(350);
    }
    for (let i = 0; i < 25 && busy(wc); i++) await sleep(100);     // 늘어난 자리의 지연 로딩 그림
    const list = await wc.executeJavaScriptInIsolatedWorld(1002, [{ code: LAYOUT }]);
    list.width = width;
    // 그림 — 화면을 한 번 캡처해 그림 자리만 칸으로 줄인다 (교차 출처 그림도 캡처는 된다).
    // 대체 글 모드면 캡처하지 않는다 (pager 가 회색 상자 + 대체 글로 그린다)
    if (capture && list.images.length) {
        try {
            const img = await wc.capturePage();
            const size = img.getSize();
            const bmp = img.toBitmap();                                 // BGRA
            const sc = size.width / width;
            let lit = 0;
            for (let i = 3; i < bmp.length; i += 4 * 997) lit += bmp[i];
            if (lit > 0) for (const im of list.images) im.px = cellsOf(bmp, size, sc, im, 366 / width);
        } catch { /* 캡처가 안 되면 그림은 빠진다 */ }
    }
    return { layout: list };
}

/** 그림 자리 → 칸 (열 최대 48, 줄 최대 40, 엔트리에서 칸 4px 안팎) */
function cellsOf(bmp, size, sc, im, k) {
    const cols = Math.max(1, Math.min(48, Math.round((im.w * k) / 4)));
    const cw = im.w / cols;
    const rows = Math.max(1, Math.min(40, Math.round(im.h / cw)));
    const ch = im.h / rows;
    const cells = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            let R = 0; let G = 0; let B = 0; let n = 0;
            for (let sy = 0; sy < 3; sy++) {
                for (let sx = 0; sx < 3; sx++) {
                    const x = Math.floor((im.x + (c + (sx + 0.5) / 3) * cw) * sc);
                    const y = Math.floor((im.y + (r + (sy + 0.5) / 3) * ch) * sc);
                    if (x < 0 || y < 0 || x >= size.width || y >= size.height) continue;
                    const i = (y * size.width + x) * 4;
                    B += bmp[i]; G += bmp[i + 1]; R += bmp[i + 2]; n++;
                }
            }
            const hx = (v) => Math.round(v / Math.max(1, n)).toString(16).padStart(2, '0');
            cells.push(`#${hx(R)}${hx(G)}${hx(B)}`);
        }
    }
    return { cols, rows, cells };
}

// 페이지 안에서 — 상자(칠한 바탕·테두리), 글 조각(줄 하나 = 조각 하나), 그림 자리
const LAYOUT = `(() => {
    const MAXH = ${LAYOUT_MAX_H};
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const memo = new Map();
    const rgba = (c) => {
        if (memo.has(c)) return memo.get(c);
        g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1);
        const d = [...g.getImageData(0, 0, 1, 1).data]; memo.set(c, d); return d;
    };
    const hex = (r, gg, b) => '#' + [r, gg, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
    const solid = (c, under) => {
        const [r, gg, b, a] = rgba(c);
        if (a < 13) return '';
        if (a > 249 || !under) return hex(r, gg, b);
        const u = [1, 3, 5].map((i) => parseInt(under.slice(i, i + 2), 16)); const t = a / 255;
        return hex(r * t + u[0] * (1 - t), gg * t + u[1] * (1 - t), b * t + u[2] * (1 - t));
    };
    const body = document.body;
    const root = document.documentElement;
    const page = (body && solid(getComputedStyle(body).backgroundColor)) || solid(getComputedStyle(root).backgroundColor) || '#ffffff';
    const boxes = [], texts = [], images = [];
    const effBg = new Map();
    const ICON = /material-(icons|symbols)|(^|\\s)(fa|fas|far|fab|bi|icon|glyphicon)(\\s|-|$)/i;
    const R = (r) => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });
    for (const el of body ? body.querySelectorAll('*') : []) {
        const up = effBg.get(el.parentElement) || page;
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
        if (el.closest('svg') && tag.toLowerCase() !== 'svg') continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none') continue;
        if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) { effBg.set(el, up); continue; }
        const r = el.getBoundingClientRect();
        const bg = solid(cs.backgroundColor, up);
        effBg.set(el, bg || up);
        if (r.width < 1 || r.height < 1 || r.top + scrollY > MAXH) continue;
        if (bg && bg !== up) boxes.push({ ...R(r), c: bg });
        // 테두리 — 변마다 가는 상자
        for (const [side, f] of [['Top', (b, wd) => ({ x: b.x, y: b.y, w: b.w, h: wd })], ['Bottom', (b, wd) => ({ x: b.x, y: b.y + b.h - wd, w: b.w, h: wd })],
            ['Left', (b, wd) => ({ x: b.x, y: b.y, w: wd, h: b.h })], ['Right', (b, wd) => ({ x: b.x + b.w - wd, y: b.y, w: wd, h: b.h })]]) {
            const wd = parseFloat(cs['border' + side + 'Width']) || 0;
            if (wd < 0.5 || cs['border' + side + 'Style'] === 'none' || cs['border' + side + 'Style'] === 'hidden') continue;
            const c = solid(cs['border' + side + 'Color'], bg || up);
            if (c && c !== (bg || up)) boxes.push({ ...f(R(r), Math.max(1, wd)), c });
        }
        // 그림 자리
        const bgImg = cs.backgroundImage && cs.backgroundImage !== 'none' && /url\\(/.test(cs.backgroundImage);
        if ((tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'PICTURE' || tag.toLowerCase() === 'svg' || bgImg) && r.width >= 12 && r.height >= 12) {
            if (tag !== 'PICTURE') images.push({ ...R(r), alt: el.getAttribute && (el.getAttribute('alt') || '') });
        }
        // 입력 칸의 글 (글 마디가 아니라 값·안내문이다)
        if ((tag === 'INPUT' && !/^(hidden|checkbox|radio|range|file|image|color)$/i.test(el.type)) || tag === 'TEXTAREA' || tag === 'SELECT') {
            const t = tag === 'SELECT' ? (el.selectedOptions[0]?.textContent || '') : (el.value || el.placeholder || '');
            if (t.trim() && el.type !== 'password') {
                const fs = parseFloat(cs.fontSize) || 14;
                const pl = parseFloat(cs.paddingLeft) || 4;
                texts.push({ x: r.left + scrollX + pl, y: r.top + scrollY + (r.height - fs * 1.3) / 2, w: Math.max(4, r.width - pl * 2), h: fs * 1.3,
                    t: t.trim().slice(0, 80), s: fs, c: solid(el.value ? cs.color : '#757575') || '#333333', b: 0, href: '' });
            }
        }
    }
    // 화면 읽기 전용 글(sr-only — 1px 상자·clip 으로 숨김)은 빼야 한다. 그대로 두면 한 글자씩 세로로 쌓였다
    const srMemo = new Map();
    const srOnly = (el) => {
        if (srMemo.has(el)) return srMemo.get(el);
        let v = false;
        for (let e = el, i = 0; e && e !== body && i < 5; e = e.parentElement, i++) {
            const c = getComputedStyle(e);
            const r = e.getBoundingClientRect();
            if ((c.position === 'absolute' || c.position === 'fixed') && ((r.width <= 3 || r.height <= 3) || (c.clip && c.clip !== 'auto')
                || /inset\\(\\s*50%|circle\\(\\s*0/.test(c.clipPath))) { v = true; break; }
            if (r.right < 0 || r.bottom < 0) { v = true; break; }      // 화면 밖으로 밀어 둔 것
        }
        srMemo.set(el, v);
        return v;
    };
    // 글 — 낱말마다 자리를 재서 같은 줄끼리 묶는다 (줄 하나 = 조각 하나)
    const walker = document.createTreeWalker(body || root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let words = 0;
    for (let n = walker.nextNode(); n && words < 25000; n = walker.nextNode()) {
        const v = n.nodeValue;
        if (!v || !v.trim()) continue;
        const el = n.parentElement;
        if (!el || el.closest('script,style,noscript,textarea,select,option,svg,template')) continue;
        if (ICON.test(el.className && el.className.baseVal === undefined ? el.className : '')) continue;
        if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
        if (srOnly(el)) continue;
        const cs = getComputedStyle(el);
        const fs = parseFloat(cs.fontSize) || 16;
        if (fs < 5) continue;
        const color = solid(cs.color, effBg.get(el) || page) || '#000000';
        const bold = Number(cs.fontWeight) >= 600 ? 1 : 0;
        const a = el.closest('a[href]');
        const href = a ? a.href : '';
        const upper = cs.textTransform === 'uppercase';
        let frag = null;
        const flush = () => { if (frag && frag.t.trim()) texts.push(frag); frag = null; };
        const put = (r, t) => {
            if (r.width < 0.5 || r.top + scrollY > MAXH) return;
            const y = r.top + scrollY;
            if (frag && Math.abs(frag.y - y) < Math.max(2, fs * 0.3) && r.left + scrollX >= frag.x + frag.w - 2) {
                frag.w = r.right + scrollX - frag.x; frag.t += t; frag.h = Math.max(frag.h, r.height);
            } else {
                flush();
                frag = { x: r.left + scrollX, y, w: r.width, h: r.height, t, s: fs, c: color, b: bold, href };
            }
        };
        const re = /\\S+\\s*/g; let m;
        const lead = v.match(/^\\s*/)[0].length;
        re.lastIndex = lead;
        while ((m = re.exec(v)) && words < 25000) {
            words++;
            const s0 = m.index; const word = m[0].replace(/\\s+$/, '');
            range.setStart(n, s0); range.setEnd(n, s0 + word.length);
            const rs = range.getClientRects();
            const t = (upper ? m[0].toUpperCase() : m[0]).replace(/\\s+/g, ' ');
            if (rs.length <= 1) { if (rs.length) put(rs[0], t); continue; }
            // 한 낱말이 줄을 넘는다 (띄어쓰기 없는 긴 글) — 글자마다
            for (let i = 0; i < word.length; i++) {
                range.setStart(n, s0 + i); range.setEnd(n, s0 + i + 1);
                const r1 = range.getBoundingClientRect();
                put(r1, upper ? word[i].toUpperCase() : word[i]);
            }
            if (m[0].length > word.length && frag) frag.t += ' ';
        }
        flush();
    }
    return { page, height: Math.min(root.scrollHeight, MAXH), title: document.title, boxes, texts, images };
})()`;
