// src/main.mjs — 중계 앱 메인 프로세스
//
// 하는 일
//   1. 화면 캡처 소스를 고르게 한다 (창 하나 또는 화면 하나). 캡처는 렌더러가 한다.
//   2. 렌더러가 격자에서 읽어 온 `WEB1|...` 요청을 받아 페이지를 가져온다.
//   3. 엔트리가 읽을 수 있는 작은 HTML 로 줄여 `EBR1|...` 로 포장하고 클립보드에 쓴다.
//
// 보안 원칙
//   - 동의하기 전에는 캡처도 요청도 하지 않는다.
//   - 화면 프레임은 렌더러 메모리에서만 다루고 **어디에도 저장하지 않는다.**
//   - 이 창은 바깥 페이지를 띄우지 않는다. 가져온 HTML 은 jsdom 으로 글자만 뽑는다.
//   - 렌더 모드(기본 꺼짐)만 보이지 않는 Chromium 창에서 스크립트를 실행한다 (src/render.mjs).
//   - 주소 검사는 src/lib/guard.mjs (내부망 차단, 리다이렉트마다 재검사).

import {
    app, BrowserWindow, ipcMain, desktopCapturer, session, clipboard, dialog, Notification, shell,
} from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchPage, decodeBody, BlockedError } from './lib/guard.mjs';
import { simplifyHtml, simplifyText, errorPage } from './lib/simplify.mjs';
import { layoutHtml, layoutText, layoutError } from './lib/layout.mjs';
import { record, S, C, B } from './lib/display.mjs';
import { parseRequest, encodeResponse } from './lib/payload.mjs';
import { renderPage } from './render.mjs';
import { pageLayout } from './lib/pager.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSENT_VERSION = 1;          // 고지문을 고치면 올린다 → 다시 동의를 받는다

// ---------------------------------------------------------------------------
// 설정 — userData/settings.json
// ---------------------------------------------------------------------------
const DEFAULTS = {
    consent: 0,                     // 동의한 고지문 버전
    mode: 'article',                // 'article' 본문만 / 'full' 전체
    confirmNewHosts: true,          // 처음 보는 사이트는 물어본다
    render: false,                  // 렌더 모드 — Chromium 으로 열어 자바스크립트까지 실행
    layout: false,                  // 레이아웃 모드 — 렌더 모드 위에서 실제 사이트 모양을 쪽 단위로 (Entry Browser 만)
    layoutImages: 'pixel',          // 레이아웃 모드의 그림 — 'pixel' 저해상도 칸 / 'alt' 대체 글만 (가볍다)
    knownHosts: [],
};
let settings = { ...DEFAULTS };
const settingsPath = () => join(app.getPath('userData'), 'settings.json');
function loadSettings() {
    try { settings = { ...DEFAULTS, ...JSON.parse(readFileSync(settingsPath(), 'utf8')) }; } catch { /* 처음 */ }
}
function saveSettings() {
    mkdirSync(dirname(settingsPath()), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}
const consented = () => settings.consent >= CONSENT_VERSION;

// ---------------------------------------------------------------------------
// 창
// ---------------------------------------------------------------------------
let win = null;
let chosenSourceId = null;

function createWindow() {
    win = new BrowserWindow({
        width: 560,
        height: 720,
        minWidth: 420,
        title: 'Entry Browser Relay (실험용)',
        backgroundColor: '#0d1117',
        webPreferences: {
            preload: join(HERE, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    win.removeMenu();
    win.loadFile(join(HERE, 'renderer', 'index.html'));

    // 이 창은 우리 화면만 띄운다. 링크는 기본 브라우저로 넘기고, 창 안 이동은 막는다.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https:\/\//.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// 화면 캡처 권한 — 우리 창이 고른 소스 하나만 넘긴다
function setupCapture() {
    // ⚠ 화면 공유(getDisplayMedia)는 권한 이름이 'display-capture' 로 온다 ('media' 가 아니다).
    //   'media' 만 허용했다가 실기에서 `Permission denied` 로 캡처가 안 열렸다.
    const ALLOWED = new Set(['display-capture', 'media']);
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
        cb(wc === win?.webContents && ALLOWED.has(permission) && consented());
    });
    session.defaultSession.setDisplayMediaRequestHandler(async (request, cb) => {
        if (!consented() || !chosenSourceId) return cb({});
        const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
        const src = sources.find((s) => s.id === chosenSourceId);
        cb(src ? { video: src } : {});
    });
}

// ---------------------------------------------------------------------------
// 요청 처리
// ---------------------------------------------------------------------------
const log = (kind, text) => win?.webContents.send('relay:log', { kind, text, at: Date.now() });

let lastKey = '';
let busy = false;

async function confirmHost(host, url) {
    if (!settings.confirmNewHosts || settings.knownHosts.includes(host)) return true;
    const { response, checkboxChecked } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['가져오기', '거절'],
        defaultId: 1,
        cancelId: 1,
        title: '새 사이트 요청',
        message: `엔트리 작품이 처음 보는 사이트를 요청합니다:\n${host}`,
        detail: `${url}\n\n믿을 수 없는 작품이 보낸 요청이라면 거절하세요.`,
        checkboxLabel: '이 사이트는 다시 묻지 않기',
    });
    if (response !== 0) return false;
    if (checkboxChecked) { settings.knownHosts.push(host); saveSettings(); }
    return true;
}

// 판(version)에 따라 본문 모양이 다르다 — 1 은 간단한 HTML (엔트리 OS), 2 는 줄 목록 (Entry Browser)
const pageFor = (version) => (version === 2
    ? {
        html: (src, url) => { const p = layoutHtml(src, url, { mode: settings.mode }); return { ...p, body: p.body }; },
        text: (src, url) => layoutText(src, url),
        error: (url, title, detail) => layoutError(url, title, detail).body,
        status: (body, code) => body.replace(/^(T[^\n]*\n(?:U[^\n]*\n)*)/, `$1${record(S.small, 0, 0, C.err, B.none, `HTTP ${code}`)}\n`),
    }
    : {
        html: (src, url) => { const p = simplifyHtml(src, url, { mode: settings.mode }); return { ...p, body: p.html }; },
        text: (src, url) => { const p = simplifyText(src, url); return { ...p, body: p.html }; },
        error: (url, title, detail) => errorPage(url, title, detail),
        status: (body, code) => `<p><b>HTTP ${code}</b></p>\n${body}`,
    });

async function buildPage(url, version) {
    const fmt = pageFor(version);
    let host = url;
    try { host = new URL(url).host; } catch { /* 아래 fetchPage 가 형식 오류를 낸다 */ }
    if (!(await confirmHost(host, url))) {
        return { finalUrl: url, body: fmt.error(url, '요청을 거절했습니다', `${host} 요청을 중계 앱에서 거절했습니다.`) };
    }
    // 레이아웃 모드 — Chromium 이 놓은 자리를 그대로 (쪽 넘김). Entry Browser(판 2)만 그릴 줄 안다
    if (settings.render && settings.layout && version === 2) {
        try {
            const r = await renderPage(url, { layout: true, images: settings.layoutImages });
            if (r.layout) {
                const p = pageLayout(r.layout, r.finalUrl, { title: r.layout.title, images: settings.layoutImages });
                log('ok', `${r.status} ${r.finalUrl} (레이아웃 ${(r.ms / 1000).toFixed(1)}초, ${p.screens}쪽 · 글 ${p.texts} · 상자 ${p.boxes} · 그림 ${p.images}${p.truncated ? ', 잘림' : ''})`);
                return { finalUrl: r.finalUrl, body: p.body };
            }
        } catch (e) {
            if (e instanceof BlockedError) {
                log('block', `${url} — ${e.message}`);
                return { finalUrl: url, body: fmt.error(url, '막은 주소입니다', e.message) };
            }
            log('warn', `레이아웃 실패, 렌더 모드로 다시 가져옵니다 — ${e.message}`);
        }
    }
    if (settings.render) {
        try {
            const r = await renderPage(url);
            if (!r.fallback) {
                const page = fmt.html(r.html, r.finalUrl);
                let { body } = page;
                if (r.status >= 400) body = fmt.status(body, r.status);
                log('ok', `${r.status} ${r.finalUrl} (렌더 ${(r.ms / 1000).toFixed(1)}초, ${page.mode}${page.lines ? `, ${page.lines}줄` : ''}${page.truncated ? ', 잘림' : ''})`);
                return { finalUrl: r.finalUrl, body };
            }
            // HTML 이 아닌 문서는 아래 텍스트 모드로
        } catch (e) {
            if (e instanceof BlockedError) {
                log('block', `${url} — ${e.message}`);
                return { finalUrl: url, body: fmt.error(url, '막은 주소입니다', e.message) };
            }
            log('warn', `렌더 실패, 텍스트 모드로 다시 가져옵니다 — ${e.message}`);
        }
    }
    try {
        const r = await fetchPage(url);
        const type = r.contentType.split(';')[0].trim().toLowerCase();
        let page;
        if (!type || type === 'text/html' || type === 'application/xhtml+xml') {
            page = fmt.html(decodeBody(r.body, r.contentType), r.finalUrl);
        } else if (type.startsWith('text/')) {
            page = fmt.text(decodeBody(r.body, r.contentType), r.finalUrl);
        } else {
            return { finalUrl: r.finalUrl, body: fmt.error(r.finalUrl, '볼 수 없는 형식입니다', `${type} 은(는) 글자로 바꿀 수 없습니다.`) };
        }
        let { body } = page;
        if (r.status >= 400) body = fmt.status(body, r.status);
        log('ok', `${r.status} ${r.finalUrl} (${page.mode}${page.lines ? `, ${page.lines}줄` : ''}${page.truncated || r.truncated ? ', 잘림' : ''})`);
        return { finalUrl: r.finalUrl, body };
    } catch (e) {
        const blocked = e instanceof BlockedError;
        log(blocked ? 'block' : 'error', `${url} — ${e.message}`);
        return { finalUrl: url, body: fmt.error(url, blocked ? '막은 주소입니다' : '가져오지 못했습니다', e.message) };
    }
}

ipcMain.handle('relay:request', async (_e, raw) => {
    if (!consented()) return { ok: false, reason: 'consent' };
    const req = parseRequest(String(raw));
    if (!req) return { ok: false, reason: 'format' };
    // 격자는 사용자가 붙여넣을 때까지 떠 있다. 같은 요청은 한 번만.
    const key = `${req.version}|${req.seq}|${req.url}`;
    if (key === lastKey || busy) return { ok: false, reason: 'duplicate' };
    lastKey = key;
    busy = true;
    try {
        log('req', `#${req.seq} ${req.url}`);
        const t0 = Date.now();
        const page = await buildPage(req.url, req.version);
        const payload = encodeResponse(req.seq, page.finalUrl, page.body, req.version);
        clipboard.writeText(payload);
        log('clip', `클립보드에 응답을 썼습니다 (${payload.length.toLocaleString()}자, ${((Date.now() - t0) / 1000).toFixed(1)}초). 엔트리 입력창에 Ctrl+V → Enter`);
        if (Notification.isSupported()) {
            new Notification({ title: '응답 준비됨', body: '엔트리 입력창에 Ctrl+V → Enter', silent: false }).show();
        }
        return { ok: true, seq: req.seq, chars: payload.length };
    } finally {
        busy = false;
    }
});
ipcMain.handle('relay:sources', async () => {
    if (!consented()) return [];
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } });
    // 이 앱 자기 창은 뺀다. 이름에 'Entry' 가 들어 있어서 엔트리 창으로 잘못 골라졌다 (실행 확인).
    const own = win ? win.getMediaSourceId() : '';
    return sources.filter((s) => s.id !== own).map((s) => ({ id: s.id, name: s.name }));
});
ipcMain.handle('relay:choose', (_e, id) => { chosenSourceId = id ? String(id) : null; return true; });

ipcMain.handle('relay:settings', () => ({
    consented: consented(),
    mode: settings.mode,
    confirmNewHosts: settings.confirmNewHosts,
    render: settings.render,
    layout: settings.layout,
    layoutImages: settings.layoutImages,
    knownHosts: settings.knownHosts.length,
}));
ipcMain.handle('relay:set', async (_e, patch) => {
    if (patch?.render === false) settings.render = false;
    if (typeof patch?.layout === 'boolean') settings.layout = patch.layout;
    if (patch?.layoutImages === 'pixel' || patch?.layoutImages === 'alt') settings.layoutImages = patch.layoutImages;
    if (patch?.render === true && !settings.render) {
        const { response } = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['켜기', '취소'],
            defaultId: 1,
            cancelId: 1,
            title: '렌더 모드',
            message: '방문하는 사이트의 자바스크립트를 이 컴퓨터에서 실행합니다.',
            detail: '자바스크립트로 그리는 사이트와 경유 페이지가 열리지만, 텍스트 모드보다 위험합니다.\n\n'
                + '- 보이지 않는 Chromium 창(샌드박스)에서 실행하고, 모든 요청에 내부망 차단을 겁니다.\n'
                + '- 쿠키·저장소는 메모리에만 두고 앱을 끄면 지웁니다.\n'
                + '- 그래도 브라우저 취약점까지 막지는 못합니다. 가상 머신이나 Windows Sandbox 에서 쓰고, '
                + '앱(Electron)을 최신으로 유지하세요.',
        });
        settings.render = response === 0;
    }
    if (patch?.mode === 'article' || patch?.mode === 'full') settings.mode = patch.mode;
    if (typeof patch?.confirmNewHosts === 'boolean') settings.confirmNewHosts = patch.confirmNewHosts;
    if (patch?.forgetHosts) settings.knownHosts = [];
    saveSettings();
    return true;
});
ipcMain.handle('relay:consent', (_e, yes) => {
    settings.consent = yes ? CONSENT_VERSION : 0;
    saveSettings();
    return consented();
});
ipcMain.handle('relay:reset', () => { lastKey = ''; return true; });

// ---------------------------------------------------------------------------
app.setAppUserModelId('io.github.entry-browser.relay');
app.whenReady().then(() => {
    loadSettings();
    setupCapture();
    createWindow();
});
app.on('window-all-closed', () => app.quit());
