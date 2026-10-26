// src/lib/simplify.mjs — 진짜 웹 페이지 → 엔트리 OS 브라우저가 읽는 작은 HTML
//
// 엔트리 쪽 파서(entry-os/src/browser.mjs)는 글자 하나에 한 스텝씩 도는 스트리밍
// 파서다. 아는 태그가 적고, 소문자만 읽고, 속성은 따옴표 안 첫 값만 본다.
// 그래서 여기서 **엔트리가 헷갈릴 일이 없는 모양으로** 다시 쓴다 (PROTOCOL.md §2).
//
// 손상은 감수한다. 레이아웃·그림·폼·스크립트는 버리고 글과 링크만 남긴다.

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { normalize } from './snapcodec.mjs';
import { isTransportable, richText } from './display.mjs';

export const MAX_CHARS = 40000;

const SKIP = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed',
    'video', 'audio', 'picture', 'source', 'map', 'head', 'title', 'meta', 'link',
    'input', 'select', 'textarea', 'button', 'option', 'dialog',
]);
// 전체 보기에서도 버리는 것 — 쿠키 배너·메뉴는 글보다 링크가 많아 화면만 차지한다
const CHROME = new Set(['nav', 'aside', 'footer', 'form']);

const HEADS = { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h3', h5: 'h3', h6: 'h3' };
const BLOCKS = new Set([
    'p', 'div', 'section', 'article', 'main', 'header', 'figure', 'figcaption', 'address',
    'dl', 'dt', 'dd', 'center', 'details', 'summary', 'table', 'tbody', 'thead', 'tfoot',
    'ul', 'ol', 'menu', 'body', 'html',
]);

// ---------------------------------------------------------------------------
// 글자 — ASCII + 한글 음절 + 줄바꿈만 (엔트리에 chr() 이 없어 표로 흉내낼 수 있는 범위)
// ---------------------------------------------------------------------------
const MAP = new Map(Object.entries({
    '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
    '‘': "'", '’': "'", '‚': "'", '′': "'", '´': "'",
    '“': '"', '”': '"', '„': '"', '″': '"', '«': '"', '»': '"',
    '「': '"', '」': '"', '『': '"', '』': '"',
    '…': '...', '·': '-', '•': '*', '●': '*', '○': 'o', '■': '*',
    '×': 'x', '÷': '/', '→': '->', '←': '<-', '⇒': '=>',
    '©': '(c)', '®': '(R)', '™': '(TM)', '°': ' deg', '₩': 'W', '€': 'EUR',
    '、': ',', '。': '.', '〜': '~', ' ': ' ', '\t': ' ', '\r': '',
}));

/**
 * @param {string} s
 * @param {{rich?: boolean}} opt  rich = Entry Browser (EBR2). 구두점·화살표·도형·자모까지 운반된다
 *                                 (display.RICH_RANGES). 아니면 엔트리 OS 처럼 ASCII + 한글 음절만.
 */
export function entryChars(s, { rich = false } = {}) {
    s = s.normalize('NFC');
    let out = '';
    for (const ch of s) {
        const c = ch.codePointAt(0);
        if (c === 10 || (c >= 32 && c <= 126) || (c >= 0xac00 && c <= 0xd7a3)) { out += ch; continue; }
        if ((c >= 0x200b && c <= 0x200f) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff || c === 0x00ad) continue;  // 폭 없는 글자 · BOM · 소프트 하이픈
        if ((c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x00a0 || c === 0x202f) { out += ' '; continue; }  // 여러 폭의 공백
        if (rich && isTransportable(c)) { out += ch; continue; }
        if (MAP.has(ch)) { out += MAP.get(ch); continue; }
        if (c >= 0xff01 && c <= 0xff5e) { out += String.fromCharCode(c - 0xfee0); continue; } // 전각 ASCII
        if (c === 0x3000) { out += ' '; continue; }
        if (rich) {
            const k = ch.normalize('NFKC');                 // ￦ → ₩ · ﬁ → fi · ㍿ → 株式会社
            if (k !== ch && [...k].every((x) => isTransportable(x.codePointAt(0)))) { out += k; continue; }
        }
        // é → e 처럼 발음 기호만 떼면 ASCII 가 되는 글자
        const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
        if (/^[\x20-\x7e]+$/.test(base)) { out += base; continue; }
        out += '?';
    }
    // 정의가 엔트리 쪽과 같은지 마지막으로 한 번 더 거른다
    return rich ? richText(out) : normalize(out);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------------------
// DOM → 블록 목록
// ---------------------------------------------------------------------------
// 블록은 {tag, html}. 인라인(글·링크·굵게)은 블록 안에서 HTML 조각으로 쌓는다.
// 엔트리 파서는 태그 안의 태그를 모르고 블록이 열리면 그냥 줄을 끊으므로,
// 블록을 **평평하게** 늘어놓는 편이 화면이 덜 깨진다.

function toBlocks(root, base) {
    const blocks = [];
    let cur = { tag: 'p', html: '' };
    const flush = () => {
        const t = cur.html.replace(/[ ]+/g, ' ').trim();
        if (t) blocks.push({ tag: cur.tag, html: cur.tag === 'pre' ? cur.html : t });
        cur = { tag: 'p', html: '' };
    };
    const open = (tag) => { flush(); cur.tag = tag; };

    const walk = (node, inPre, inLink = false) => {
        if (node.nodeType === 3) {                                              // 글
            let t = entryChars(node.nodeValue || '');
            if (!inPre) t = t.replace(/\s+/g, ' ');
            cur.html += esc(t);
            return;
        }
        if (node.nodeType !== 1) return;
        const tag = node.tagName.toLowerCase();
        if (SKIP.has(tag)) return;
        if (node.getAttribute('hidden') !== null || node.getAttribute('aria-hidden') === 'true') return;

        if (tag === 'br') { cur.html += inPre ? '\n' : '<br>'; return; }
        if (tag === 'hr') { flush(); blocks.push({ tag: 'hr', html: '' }); return; }
        if (tag === 'img') {
            const alt = entryChars(node.getAttribute('alt') || '').trim();
            if (alt) cur.html += esc(` [그림: ${alt}] `);
            return;
        }
        if (tag === 'a') {
            const href = absolute(node.getAttribute('href'), base);
            const inner = { before: cur.html };
            cur.html = '';
            node.childNodes.forEach((c) => walk(c, inPre, true));
            const label = cur.html.replace(/<br>/g, ' ').replace(/[ ]+/g, ' ').trim();
            cur.html = inner.before + (href && label ? `<a href="${href}">${label}</a>` : label);
            return;
        }
        if (tag === 'b' || tag === 'strong' || tag === 'i' || tag === 'em') {
            const t = tag === 'b' || tag === 'strong' ? 'b' : 'i';
            cur.html += `<${t}>`;
            node.childNodes.forEach((c) => walk(c, inPre, inLink));
            cur.html += `</${t}>`;
            return;
        }
        if (tag === 'td' || tag === 'th') {
            if (cur.html.trim()) cur.html += ' | ';
            node.childNodes.forEach((c) => walk(c, inPre, inLink));
            return;
        }

        let blockTag = null;
        if (HEADS[tag]) blockTag = HEADS[tag];
        else if (tag === 'li') blockTag = 'li';
        else if (tag === 'pre') blockTag = 'pre';
        else if (tag === 'blockquote') blockTag = 'blockquote';
        else if (tag === 'tr') blockTag = 'p';
        else if (BLOCKS.has(tag) || CHROME.has(tag)) blockTag = 'p';

        // 링크 안의 블록(<a><div>…)은 줄을 끊지 않는다. 끊으면 링크가 반으로 갈린다.
        if (blockTag && !inLink) {
            open(blockTag);
            node.childNodes.forEach((c) => walk(c, inPre || tag === 'pre', inLink));
            flush();
        } else {
            node.childNodes.forEach((c) => walk(c, inPre, inLink));             // span 등
        }
    };
    walk(root, false);
    flush();
    return blocks;
}

function absolute(href, base) {
    if (!href) return null;
    try {
        const u = new URL(href, base);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        // 같은 페이지 안의 #조각은 링크로 치지 않는다 (엔트리에서 따라갈 곳이 없다)
        const b = new URL(base);
        if (u.hash && u.origin === b.origin && u.pathname === b.pathname && u.search === b.search) return null;
        u.hash = '';
        // 엔트리 파서는 따옴표 사이를 주소로 읽는다. 주소 안에 따옴표가 있으면 안 된다.
        // ⚠ & 는 &amp; 로 바꾸지 **않는다.** 엔트리는 태그 안에서 문자 참조를 풀지 않아서
        //   &amp; 가 주소에 그대로 남는다.
        return entryChars(u.href).replace(/"/g, '%22').replace(/[<>]/g, encodeURIComponent);
    } catch { return null; }
}

function render(blocks, max) {
    let out = '';
    let inList = false;
    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        let piece;
        if (b.tag === 'li') {
            piece = `${inList ? '' : '<ul>\n'}<li>${b.html}</li>\n`;
            inList = true;
            if (blocks[i + 1]?.tag !== 'li') { piece += '</ul>\n'; inList = false; }
        } else if (b.tag === 'hr') {
            piece = '<hr>\n';
        } else {
            piece = `<${b.tag}>${b.html}</${b.tag}>\n`;
        }
        if (out.length + piece.length > max) {
            if (inList) out += '</ul>\n';
            out += `<hr>\n<p><i>(페이지가 길어 여기서 잘랐습니다. 남은 블록 ${blocks.length - i}개)</i></p>\n`;
            return { html: out, truncated: true };
        }
        out += piece;
    }
    return { html: out, truncated: false };
}

/**
 * @param {string} source  원문 HTML
 * @param {string} url     최종 주소 (상대 링크 기준)
 * @param {{mode?:'article'|'full'}} opt
 */
export function simplifyHtml(source, url, { mode = 'article' } = {}) {
    // runScripts 를 주지 않으면 jsdom 은 스크립트를 **실행하지 않는다.**
    // resources 도 기본값이라 그림·CSS·하위 문서를 내려받지 않는다.
    const dom = new JSDOM(source, { url, contentType: 'text/html' });
    const doc = dom.window.document;
    let title = entryChars(doc.title || '').trim();

    let root = null;
    let used = 'full';
    if (mode === 'article') {
        try {
            const art = new Readability(doc.cloneNode(true)).parse();
            if (art?.content && (art.textContent || '').trim().length > 200) {
                root = new JSDOM(`<body>${art.content}</body>`, { url }).window.document.body;
                if (art.title) title = entryChars(art.title).trim();
                used = 'article';
            }
        } catch { /* 본문을 못 찾으면 전체로 */ }
    }
    if (!root) root = doc.body || doc.documentElement;

    const blocks = toBlocks(root, url);
    const head = title ? `<h1>${esc(title)}</h1>\n` : '';
    const note = `<p><i>${esc(entryChars(new URL(url).host))} - ${used === 'article' ? '본문만' : '전체'}</i></p>\n`;
    const { html, truncated } = render(blocks, MAX_CHARS - head.length - note.length);
    dom.window.close();
    return { title, html: head + note + html, mode: used, truncated };
}

export function simplifyText(source, url) {
    const t = entryChars(source).slice(0, MAX_CHARS);
    return { title: url, html: `<h1>${esc(entryChars(url))}</h1>\n<pre>${esc(t)}</pre>\n`, mode: 'text', truncated: source.length > MAX_CHARS };
}

/** 오류도 페이지다. 엔트리 쪽은 오류를 따로 다루지 않는다. */
export function errorPage(url, title, detail) {
    return [
        `<h1>${esc(entryChars(title))}</h1>`,
        `<p>${esc(entryChars(detail))}</p>`,
        `<p><a href="${absolute(url, url) || ''}">이 주소 다시 요청하기</a></p>`,
        '<p>Backspace 로 뒤로 갑니다.</p>',
    ].join('\n');
}
