// src/lib/layout.mjs — 웹 페이지 → 줄 목록 (EBR2 본문, 형식은 display.mjs)
//
// 중계 앱이 브라우저의 **배치 엔진** 노릇을 한다. 엔트리는 받은 줄을 그리기만 한다.
//   1. DOM 을 훑어 블록으로 (제목·문단·목록·인용·코드·표·구분선·그림 자리)
//   2. 블록마다 스타일을 정하고 글꼴 폭에 맞춰 줄로 접는다
//   3. 블록 사이에 간격 줄을 넣는다
//
// 손상은 감수한다 — CSS 레이아웃(가로 배치·열)은 버리고 위에서 아래로 흐르는 문서로 만든다.
// 휴대폰의 "읽기 모드" 에 가깝다.
//
// 렌더 모드의 DOM 에는 계산된 CSS 가 data-eb 로 적혀 온다 (css.mjs). 그때는 글꼴 크기로 스타일을,
// 사이트의 글자색·바탕색·정렬을 줄마다 옮긴다. 없으면(텍스트 모드) 예전 그대로다.

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { entryChars as entryCharsBase } from './simplify.mjs';
import {
    VIEW_W, STYLES, S, C, B, COLORS, BGS, CODES, MAX_LINES, MAX_SEGS, readableUrl, MAX_LINKS, wrapRuns, record, textPx, formatSpans, FIELD, MARK,
} from './display.mjs';
import { baseLook, readLook, styleOf, readable, makePalette } from './css.mjs';

const SKIP = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed',
    'video', 'audio', 'source', 'map', 'head', 'title', 'meta', 'link', 'option',
]);
// <picture> 는 버리지 않는다 — 속의 <img> 가 대체 글을 갖고 있다 (예전에는 통째로 버려 대체 글까지 사라졌다)

// 위·아래 첨자로 바꿀 수 있는 글자 (모두 바꿀 수 있을 때만 바꾼다)
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎' };
/** 막대 [■■■□□] — progress·meter 의 값 */
const bar = (v, min, max) => {
    const t = Math.max(0, Math.min(1, (v - min) / ((max - min) || 1)));
    const n = Math.round(t * 10);
    return `[${'■'.repeat(n)}${'□'.repeat(10 - n)}] ${Math.round(t * 100)}%`;
};
const HEAD = { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h3', h5: 'h3', h6: 'h3' };
const BLOCK = new Set([
    'p', 'div', 'section', 'article', 'main', 'header', 'figure', 'dd', 'dt', 'address', 'center',
    'details', 'summary', 'body', 'html', 'form', 'fieldset', 'legend', 'hgroup', 'search',
]);
const SMALL = new Set(['figcaption', 'small', 'caption', 'nav', 'footer', 'aside']);

// Entry Browser 는 구두점·화살표·도형·자모까지 운반한다 (display.RICH_RANGES)
const entryChars = (s) => entryCharsBase(s, { rich: true });

const MAX_BODY = 120_000;           // 본문 바이트 상한 — base64 로 16만 자, 입력창(25만 자) 안쪽

// ---------------------------------------------------------------------------
// 1. DOM → 블록
// ---------------------------------------------------------------------------

/**
 * 데이터 표인가, 배치용 표인가.
 * 배치용 표를 고정폭 격자로 그리면 칸만 늘어서고 글은 잘린다 (해커뉴스에서 그랬다).
 * 데이터 표라는 표시가 있을 때만 격자로 그린다: 칸 제목(th)·표 제목(caption)·class.
 */
function isDataTable(el) {
    if (el.querySelector('table')) return false;                     // 표 안에 표 = 배치
    const marked = el.querySelector('th, caption') || /wikitable|infobox|table|grid|data/i.test(el.className || '');
    if (!marked) return false;
    const cells = [...el.querySelectorAll('td, th')].slice(0, 200);
    const long = cells.filter((c) => (c.textContent || '').trim().length > 80).length;
    return long <= cells.length * 0.2;
}

/** 보이는 글만 (textContent 는 <script>·<style> 안의 글까지 준다 — 구글 표 칸에서 새어 나왔다) */
function visibleText(el) {
    let s = '';
    el.childNodes.forEach((n) => {
        if (n.nodeType === 3) s += n.nodeValue;
        else if (n.nodeType === 1 && !SKIP.has(n.tagName.toLowerCase())) s += ` ${visibleText(n)} `;
    });
    return s;
}
// 블록: { kind, depth, quote, small, marker, runs:[{text, link}] }
//       { kind:'pre', text }  { kind:'table', rows:[{head, cells}] }  { kind:'hr' }

function extract(root, linkOf, fm, look0 = null) {
    const blocks = [];
    let cur = null;

    // ---- 입력 칸 ----
    // 칸 하나 = fm.fields 의 항목 하나. 보이는 칸은 **자기 줄**(블록 'widget')을 갖는다.
    const clean = (s, max = 60) => entryChars(String(s || '')).replace(/[\t\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    const labelOf = (el) => clean(el.getAttribute('aria-label') || fm.labelText.get(el) || el.getAttribute('placeholder')
        || el.getAttribute('title') || el.getAttribute('name') || '');
    const addField = (f) => {
        fm.fields.push({ on: 0, min: 0, max: 0, step: 0, label: '', value: '', name: '', ...f });
        return fm.fields.length;
    };
    const widget = (field) => { flush(); blocks.push({ kind: 'widget', field }); };

    const control = (el, tag, ctx) => {
        const form = ctx.form || 0;
        const name = clean(el.getAttribute('name'), 80);
        if (el.hasAttribute('disabled')) return;
        if (tag === 'textarea') {
            widget(addField({ form, type: FIELD.text, name, value: clean(el.textContent, 200), label: labelOf(el) || '입력' }));
            return;
        }
        if (tag === 'select') {
            const opts = [...el.querySelectorAll('option')].filter((o) => !o.disabled);
            if (!opts.length) return;
            const first = fm.options.length + 1;
            let sel = opts.findIndex((o) => o.selected || o.hasAttribute('selected'));
            if (sel < 0) sel = 0;
            opts.forEach((o, i) => fm.options.push({
                value: clean(o.getAttribute('value') ?? o.textContent, 120), label: clean(o.textContent, 50), selected: i === sel ? 1 : 0,
            }));
            const f = addField({ form, type: FIELD.select, name, value: fm.options[first - 1 + sel].value,
                label: labelOf(el), on: first + sel, min: first, max: fm.options.length });
            fm.options.slice(first - 1).forEach((o) => { o.field = f; });
            widget(f);
            return;
        }
        if (tag === 'button') {
            const type = (el.getAttribute('type') || 'submit').toLowerCase();
            if (type !== 'submit' || !form) return;              // 스크립트로 움직이는 단추는 엔트리에서 할 일이 없다
            const label = clean(el.textContent || el.getAttribute('aria-label') || el.getAttribute('value'), 30) || '보내기';
            widget(addField({ form, type: FIELD.submit, name, value: clean(el.getAttribute('value'), 120), label }));
            return;
        }
        // input
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        const value = clean(el.getAttribute('value'), 200);
        if (type === 'hidden') {
            // 토큰처럼 긴 값은 버린다 — 보내는 주소가 띠 격자(392바이트)를 넘는다. 검색은 대개 없어도 된다.
            // 글자 인코딩 힌트(ie=EUC-KR 등)도 버린다 — 중계 앱은 늘 UTF-8 로 인코딩하는데, 구글이
            // ie=EUC-KR 을 받으면 한글 검색어를 EUC-KR 로 읽어 깨진다.
            if (/^(ie|oe|_charset_|charset)$/i.test(name)) return;
            if (name && value.length <= 40) addField({ form, type: FIELD.hidden, name, value });
            return;
        }
        if (type === 'password') { flush(); blocks.push({ kind: 'note', text: '(비밀번호 칸은 받지 않습니다 — 화면 격자에 그대로 그려집니다)' }); return; }
        if (type === 'file') { flush(); blocks.push({ kind: 'note', text: '(파일 올리기는 지원하지 않습니다)' }); return; }
        if (type === 'button' || type === 'reset') return;
        if (type === 'submit' || type === 'image') {
            if (!form) return;
            const label = clean(el.getAttribute('value') || el.getAttribute('alt') || el.getAttribute('aria-label'), 30) || '보내기';
            widget(addField({ form, type: FIELD.submit, name, value, label }));
            return;
        }
        if (type === 'checkbox' || type === 'radio') {
            // 양식 밖의 체크박스는 대개 CSS 로 메뉴를 여닫는 장치다 (위키백과 "주 메뉴") — 엔트리에선 할 일이 없다
            if (!form) return;
            widget(addField({ form, type: type === 'checkbox' ? FIELD.check : FIELD.radio, name, value: value || 'on',
                label: labelOf(el) || name, on: el.hasAttribute('checked') ? 1 : 0 }));
            return;
        }
        if (type === 'range') {
            const min = Number(el.getAttribute('min') ?? 0) || 0;
            let max = Number(el.getAttribute('max') ?? 100);
            if (!(max > min)) max = min + 100;
            const step = Number(el.getAttribute('step')) > 0 ? Number(el.getAttribute('step')) : 1;
            let v = el.hasAttribute('value') ? Number(el.getAttribute('value')) : (min + max) / 2;
            v = Math.min(max, Math.max(min, Math.round((v - min) / step) * step + min));
            const f = addField({ form, type: FIELD.range, name, value: String(v), label: labelOf(el) || name || '값', min, max, step });
            flush();
            blocks.push({ kind: 'range', field: f });
            return;
        }
        // text · search · email · url · tel · number · date …
        widget(addField({ form, type: FIELD.text, name, value, label: labelOf(el) || '입력' }));
    };

    const flush = () => {
        if (cur && cur.runs.some((r) => r.text.trim())) {
            // 조각 경계를 넘는 공백도 하나로 (칸 사이에 넣은 ' ' 가 겹친다)
            let prevSpace = true;
            for (const r of cur.runs) {
                r.text = r.text.replace(/\s+/g, ' ');
                if (prevSpace) r.text = r.text.replace(/^ /, '');
                if (r.text) prevSpace = r.text.endsWith(' ');
            }
            cur.runs = cur.runs.filter((r) => r.text);
            blocks.push(cur);
        }
        cur = null;
    };
    const open = (kind, ctx, extra = {}) => {
        flush();
        cur = { kind, depth: ctx.depth, quote: ctx.quote, small: ctx.small, css: ctx.css, runs: [], ...extra };
    };
    const text = (t, ctx) => {
        if (!t) return;
        if (!cur) open(ctx.small ? 'small' : 'p', ctx);
        cur.runs.push({ text: ctx.css?.upper ? t.toUpperCase() : t, link: ctx.link, color: ctx.css?.color });
    };
    const hidden = (el) => el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true'
        || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(el.getAttribute('style') || '');

    const walk = (node, ctx) => {
        if (node.nodeType === 3) {
            text(entryChars(node.nodeValue || '').replace(/\s+/g, ' '), ctx);
            return;
        }
        if (node.nodeType !== 1) return;
        const el = node;
        const tag = el.tagName.toLowerCase();
        if (SKIP.has(tag) || hidden(el)) return;
        if (ctx.css && el.hasAttribute('data-eb')) ctx = { ...ctx, css: readLook(el, ctx.css) };
        const kids = (c) => el.childNodes.forEach((n) => walk(n, c));

        // 줄바꿈 — 같은 종류의 블록을 **간격 없이** 이어서 연다 (cont)
        if (tag === 'br') {
            if (cur) {
                const { kind, css } = cur;
                flush();
                cur = { kind, depth: ctx.depth, quote: ctx.quote, small: ctx.small, css, runs: [], cont: true, marker: '' };
            }
            return;
        }
        if (tag === 'hr') { flush(); blocks.push({ kind: 'hr' }); return; }
        if (tag === 'img') {
            // 대체 글이 없으면 title · aria-label 로
            const alt = entryChars(el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            if (alt && alt.length > 1) {
                if (ctx.link) text(` ${alt} `, ctx);
                else { flush(); blocks.push({ kind: 'img', alt }); }
            }
            return;
        }
        if (tag === 'dialog' && !el.hasAttribute('open')) return;          // 닫힌 대화상자는 안 보인다
        // ---- 글 수준의 뜻 — 엔트리는 한 줄에 한 모양이라 글자로 나타낸다 ----
        if (tag === 'del' || tag === 's' || tag === 'strike') { text('~~', ctx); kids(ctx); text('~~', ctx); return; }
        if (tag === 'q') { text('“', ctx); kids(ctx); text('”', ctx); return; }
        if (tag === 'sup' || tag === 'sub') {
            const map = tag === 'sup' ? SUP : SUB;
            const t = entryChars(visibleText(el)).replace(/\s+/g, ' ').trim();
            // 각주 [1] 처럼 링크가 든 것, 바꿀 수 없는 글자가 섞인 것은 그대로 둔다
            if (t && !el.querySelector('a') && [...t].every((ch) => map[ch])) { text([...t].map((ch) => map[ch]).join(''), ctx); return; }
            kids(ctx);
            return;
        }
        if (tag === 'progress' || tag === 'meter') {
            const num = (a, d) => (el.hasAttribute(a) && Number.isFinite(Number(el.getAttribute(a))) ? Number(el.getAttribute(a)) : d);
            const max = num('max', tag === 'progress' ? 1 : 1);
            const min = tag === 'meter' ? num('min', 0) : 0;
            if (tag === 'progress' && !el.hasAttribute('value')) text(' [진행 중] ', ctx);
            else text(` ${bar(num('value', 0), min, max)} `, ctx);
            return;
        }
        // ---- 양식 ----
        if (tag === 'form') {
            const m = (el.getAttribute('method') || 'get').toLowerCase() === 'post' ? 'P' : 'G';
            const action = fm.resolve(el.getAttribute('action') || '');
            fm.forms.push({ method: action ? m : 'P', action: action || '' });
            flush();
            kids({ ...ctx, form: fm.forms.length });
            flush();
            return;
        }
        if (tag === 'label' && fm.skipLabels.has(el)) {
            // 체크박스·라디오의 이름표 — 칸 줄에 이미 실었으니 글은 다시 쓰지 않는다
            el.querySelectorAll('input, select, textarea, button').forEach((c) => walk(c, ctx));
            return;
        }
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') {
            // CSS 클래스로 숨긴 칸 (style 속성이 아니라 class 로 숨긴다 — 덕덕고의 state_hidden)
            if (/(^|\s)(hidden|is-hidden|sr-only|visually-hidden|screen-reader-text)(\s|$)/.test(el.getAttribute('class') || '')) return;
            control(el, tag, ctx);
            return;
        }
        if (tag === 'a') {
            const link = linkOf(el.getAttribute('href'));
            // 링크끼리 붙어 있으면 띄운다 (원래는 CSS 여백이 갈라 주던 자리다)
            const last = cur?.runs.at(-1)?.text;
            if (last && !/\s$/.test(last)) text(' ', ctx);
            kids({ ...ctx, link: link || ctx.link });
            return;
        }
        if (HEAD[tag]) { open(HEAD[tag], ctx); kids({ ...ctx, small: false }); flush(); return; }
        if (tag === 'pre') {
            flush();
            const t = entryChars((el.textContent || '').replace(/\t/g, '    ').replace(/\r/g, ''));
            if (t.trim()) blocks.push({ kind: 'pre', text: t.replace(/^\n+|\n+$/g, ''), css: ctx.css });
            return;
        }
        if (tag === 'table' && !isDataTable(el)) {
            // 배치용 표 (해커뉴스·옛 게시판) — 줄마다 문단 하나로 푼다. 칸 사이는 띄어 쓴다.
            flush();
            el.querySelectorAll('tr').forEach((tr) => {
                if (tr.closest('table') !== el) return;
                const css = ctx.css && readLook(tr, ctx.css);
                const row = { ...ctx, css, inline: true };      // 칸 안의 div·center 가 줄을 끊지 않게
                open('p', row);
                [...tr.children].forEach((cell) => {
                    const c = css ? { ...row, css: readLook(cell, css) } : row;
                    // 칸을 칠했으면(해커뉴스 머리줄의 주황) 그 줄의 바탕으로
                    if (css && cur && c.css.bg !== css.bg && cur.css.bg === css.bg) cur.css = { ...cur.css, bg: c.css.bg };
                    cell.childNodes.forEach((n) => walk(n, c));
                    text(' ', c);
                });
                flush();
            });
            return;
        }
        if (tag === 'table') {
            flush();
            const rows = [];
            el.querySelectorAll('tr').forEach((tr) => {
                if (tr.closest('table') !== el) return;      // 안쪽 표의 줄은 그 칸의 글로만
                const cells = [...tr.children].filter((c) => /^(td|th)$/i.test(c.tagName));
                if (!cells.length) return;
                rows.push({
                    head: cells.every((c) => c.tagName.toLowerCase() === 'th'),
                    cells: cells.map((c) => entryChars(visibleText(c)).replace(/\s+/g, ' ').trim()),
                    link: linkOf(cells.map((c) => c.querySelector('a[href]')).find(Boolean)?.getAttribute('href')),
                });
            });
            if (rows.length) blocks.push({ kind: 'table', rows });
            return;
        }
        if (tag === 'ul' || tag === 'ol' || tag === 'menu') {
            flush();
            const c = { ...ctx, depth: ctx.depth + 1, ol: tag === 'ol' ? { n: Number(el.getAttribute('start')) || 1 } : null };
            kids(c);
            flush();
            return;
        }
        if (tag === 'li') {
            const marker = ctx.ol ? `${ctx.ol.n++}.` : (ctx.depth > 1 ? '-' : '•');
            open('li', ctx, { marker });
            kids(ctx);
            flush();
            return;
        }
        if (tag === 'blockquote') { flush(); kids({ ...ctx, quote: true }); flush(); return; }
        if (tag === 'details') {
            // 펼치기 — 요약 줄 + 묶음. 접힌 것도 내용을 다 보낸다 (엔트리가 그 자리에서 편다).
            // 렌더 모드는 뽑기 전에 다 펼쳐 두고 원래 접혀 있던 것에 data-eb-closed 를 단다.
            flush();
            const group = ++fm.groups;
            const isOpen = el.hasAttribute('open') && !el.hasAttribute('data-eb-closed');
            const sum = [...el.children].find((c) => c.tagName.toLowerCase() === 'summary');
            const css = sum && ctx.css ? readLook(sum, ctx.css) : ctx.css;
            // 요약 안의 제목·링크는 한 줄 글로 (누르면 접고 펴는 줄이다)
            const label = sum ? entryChars(visibleText(sum)).replace(/\s+/g, ' ').trim() : '';
            blocks.push({ kind: 'summary', group, isOpen, depth: ctx.depth, css, runs: [{ text: label || '세부 정보', link: 0, color: css?.color }] });
            el.childNodes.forEach((n) => { if (n !== sum) walk(n, ctx); });
            flush();
            blocks.push({ kind: 'dend', group });
            return;
        }
        if (ctx.inline && (BLOCK.has(tag) || SMALL.has(tag))) { text(' ', ctx); kids(ctx); text(' ', ctx); return; }
        if (SMALL.has(tag)) { flush(); kids({ ...ctx, small: true }); flush(); return; }
        if (BLOCK.has(tag) || tag === 'tr') {
            flush();
            kids(ctx);
            flush();
            return;
        }
        kids(ctx);                      // span, b, i, code, em, strong, label …
    };
    walk(root, { depth: 0, quote: false, small: false, link: 0, ol: null, form: 0, css: look0 });
    flush();

    // 검색 칸 하나뿐인 POST 양식(덕덕고 등)은 GET 으로 보낸다 — 검색 엔진은 대개 주소의 ?q= 도 받는다.
    // 그 밖의 POST 양식(로그인·글쓰기)은 그대로 막는다. 쿠키가 없어 어차피 동작하지 않고, 위험하다.
    fm.forms.forEach((f, i) => {
        if (f.method !== 'P' || !f.action) return;
        const texts = fm.fields.filter((x) => x.form === i + 1 && x.type === FIELD.text);
        if (texts.length === 1 && /^(q|query|search|keyword|kw|wd|s|term)$/i.test(texts[0].name)) f.method = 'G';
    });
    return blocks;
}

/**
 * 양식 준비 — 체크박스·라디오의 이름표를 미리 찾아 둔다.
 * <label for="x"> 가 칸보다 **앞에** 나오는 일이 흔해서, 훑으면서 찾으면 늦다.
 */
function prepareForms(root, base) {
    const fm = { forms: [], fields: [], options: [], labelText: new Map(), skipLabels: new Set(), groups: 0 };
    fm.resolve = (href) => {
        try {
            const u = new URL(href, base);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
            u.hash = '';
            return entryChars(readableUrl(u.href)).replace(/\s/g, '%20');
        } catch { return ''; }
    };
    const labels = [...root.querySelectorAll('label')];
    root.querySelectorAll('input, select, textarea').forEach((el) => {
        const id = el.getAttribute('id');
        const lab = el.closest('label') || (id && labels.find((l) => l.getAttribute('for') === id));
        if (!lab) return;
        fm.labelText.set(el, visibleText(lab));
        const type = (el.getAttribute('type') || '').toLowerCase();
        // 이름표를 칸 줄에 싣는 종류는 원래 자리의 이름표 글을 지운다 (두 번 나오지 않게)
        if (type === 'checkbox' || type === 'radio' || type === 'range') fm.skipLabels.add(lab);
    });
    return fm;
}

// ---------------------------------------------------------------------------
// 2. 블록 → 줄
// ---------------------------------------------------------------------------
const GAP = { h1: 12, h2: 9, h3: 7, p: 5, small: 3, li: 2, pre: 5, table: 5, hr: 3, img: 4 };
const W2 = (s) => [...s].reduce((a, ch) => a + (ch.codePointAt(0) >= 0xac00 ? 2 : 1), 0);   // 고정폭 칸 수

function cutCols(s, max) {
    let out = ''; let w = 0;
    for (const ch of s) {
        const cw = ch.codePointAt(0) >= 0xac00 ? 2 : 1;
        if (w + cw > max) return `${out.slice(0, -1)}~`;
        out += ch; w += cw;
    }
    return out;
}

/**
 * @param theme  CSS 를 옮길 때 { page: 페이지 바탕, pal: makePalette() }. 없으면 기본 색 번호만 쓴다.
 */
function layoutBlocks(blocks, fm = { forms: [], fields: [], options: [] }, theme = null) {
    const out = [];
    let pendingGap = 0;
    let lastBg = '';
    let glued = false;
    const gap = (px) => { pendingGap = Math.max(pendingGap, px); };
    // 색 → 번호 글자. CSS 모드에서는 색이 '#rrggbb' 로도 온다. 바탕이 없으면(B.none) 페이지 바탕이고,
    // 글자는 그 바탕 위에서 읽히게 고친다 (readable).
    const paint = (color, bg) => {
        if (!theme) return { fc: color, bc: bg, bgHex: '' };
        const bgHex = typeof bg === 'string' ? bg : (bg === B.none ? theme.page : BGS[bg]);
        const fg = readable(typeof color === 'string' ? color : COLORS[color], bgHex);
        return { fc: theme.pal.fg(fg), bc: theme.pal.bg(bgHex), bgHex };
    };
    // 들여쓰기는 **앞에 공백을 넣어** 낸다. 글상자를 오른쪽으로 옮기면 폭(런타임에 못 바꾼다)만큼
    // 카드 밖으로 튀어나온다 — 미리보기에서 인용문 상자가 그랬다. 엔트리 OS 브라우저도 공백으로
    // 들여 썼다(실기 확인). 돌려주는 값은 공백이 차지한 폭(px) — 링크 구간을 그만큼 민다.
    const emit = (style, indent, link, color, bg, t) => {
        const { fc, bc, bgHex } = paint(color, bg);
        // 같은 색 바탕이 이어지면 사이를 띄우지 않는다 — 간격 줄은 글상자가 없어 페이지 바탕이
        // 비친다. 띄우면 색 띠가 줄무늬가 된다.
        if (theme && bgHex !== theme.page && bgHex === lastBg) pendingGap = 0;
        if (glued) { pendingGap = 0; glued = false; }
        lastBg = bgHex;
        if (pendingGap && out.length) out.push(record(S.gap, pendingGap, 0, 0, 0, ''));
        pendingGap = 0;
        lastPaint = { fc, bgHex };
        let shift = 0;
        if (indent > 0 && style !== S.rule) {
            const space = textPx(' ', style);
            const n = Math.round(indent / space);
            t = ' '.repeat(n) + t;
            shift = n * space;
        }
        out.push(record(style, 0, link, fc, bc, t));
        lastText = t;
        return shift;
    };
    let lastText = ''; let lastPaint = null;
    // 조각 (R) — 줄 안의 링크를 색으로 보이게 줄을 나눈다. ln.ranges 는 ln.text 안의 링크 구간(글자 번호).
    // 줄 글(lastText)은 앞에 들여쓰기 공백·머리표가 붙어 있으니 그만큼 민다. x 는 앞 글의 폭(textPx).
    const pad3 = (n) => String(Math.max(0, Math.min(999, Math.round(n)))).padStart(3, '0');
    let segCount = 0;
    const segments = (ln, style, baseColor, linkColorOf) => {
        if (segCount + ln.ranges.length * 2 + 1 > MAX_SEGS) return;    // 넘치면 그 줄은 한 색 (엔트리 리스트 상한)
        const full = [...lastText];
        const shift = full.length - [...ln.text].length;
        const pieces = [];
        let at = ln.ranges[0].c0;
        for (const r of ln.ranges) {
            if (r.c0 > at) pieces.push([at, r.c0, baseColor]);          // 링크 사이 글
            pieces.push([r.c0, r.c1, linkColorOf(r.link)]);
            at = r.c1;
        }
        if (at < ln.chars) pieces.push([at, ln.chars, baseColor]);     // 마지막 링크 뒤
        for (const [a, b, color] of pieces) {
            const s = shift + a;
            const piece = full.slice(s, shift + b).join('');
            if (!piece.trim()) continue;                                // 공백뿐인 조각은 그릴 것이 없다
            const lead = piece.length - piece.trimStart().length;      // 앞 공백은 건너뛴다 (x 를 그만큼 민다)
            const x = textPx(full.slice(0, s + lead).join(''), style);
            const { fc } = paint(color, theme ? lastPaint.bgHex : B.none);  // 줄과 같은 바탕 위에서 읽히게
            out.push(`R${pad3(x)}${pad3(s + lead + 1)}${pad3(piece.trim().length)}${typeof fc === 'number' ? CODES[fc] : fc}`);
            segCount++;
        }
    };
    // 링크가 줄의 대부분이면 글자를 파랗게. 일부면 그대로 두고, 마우스를 올렸을 때
    // 엔트리 쪽이 바탕을 밝혀 준다 (문단마다 링크가 있는 위키백과에서 바탕을 깔았더니
    // 거의 모든 줄이 파래져 읽기 힘들었다).
    const linkLook = (ln, baseColor) => {
        if (ln.link && ln.linkChars / Math.max(1, ln.chars) >= 0.5) return { color: C.link, bg: B.none };
        return { color: baseColor, bg: B.none };
    };

    for (const b of blocks) {
        if (out.length >= MAX_LINES) break;
        // 맨 윗줄(주소 · 보기 방식) — 바로 다음 블록과 붙여 쓴다 (예전부터 그 자리에 간격이 없었다)
        if (b.head) { emit(S.small, 0, 0, C.dim, B.none, b.text); glued = true; continue; }
        if (b.kind === 'note') { gap(GAP.small); emit(S.small, 0, 0, C.dim, B.none, b.text); continue; }
        if (b.kind === 'widget') {
            // 칸의 모양. 바로 뒤의 W 줄이 "이 줄 = 몇 번 칸" 이다 (엔트리가 누르면 그 칸을 다룬다)
            const f = fm.fields[b.field - 1];
            const sendable = f.form && fm.forms[f.form - 1]?.method === 'G';
            gap(GAP.li + 2);
            if (f.type === FIELD.text) emit(S.body, 0, 0, f.value ? C.text : C.dim, B.field, `  ${f.value || f.label}`);
            else if (f.type === FIELD.check) emit(S.body, 0, 0, C.text, B.none, `  ${f.on ? MARK.on : MARK.off} ${f.label}`);
            else if (f.type === FIELD.radio) emit(S.body, 0, 0, C.text, B.none, `  ${f.on ? MARK.radioOn : MARK.radioOff} ${f.label}`);
            else if (f.type === FIELD.select) emit(S.body, 0, 0, C.text, B.field, `  ${MARK.select} ${fm.options[f.on - 1].label}`);
            else if (f.type === FIELD.submit) {
                if (!sendable) { emit(S.body, 0, 0, C.dim, B.code, `  [ ${f.label} ]  보낼 수 없는 양식 (POST)`); continue; }
                emit(S.body, 0, 0, C.link, B.head, `  [ ${f.label} ]`);
            }
            out.push(`W${b.field}`);
            continue;
        }
        if (b.kind === 'range') {
            // 이름표 줄 + 막대 줄. 엔트리가 끌 때 **바로 앞 줄**의 글을 "이름표: 값" 으로 고친다
            const f = fm.fields[b.field - 1];
            gap(GAP.li + 2);
            emit(S.body, 0, 0, C.text, B.none, `${f.label}: ${f.value}`);
            emit(S.range, 0, 0, 0, 0, '');
            out.push(`W${b.field}`);
            continue;
        }
        if (b.kind === 'summary') {
            const css = theme && b.css;
            const style = css ? styleOf(css, 'p', b.runs[0].text.length) : S.body;
            const mark = b.isOpen ? MARK.opened : MARK.closed;
            gap(GAP.p);
            for (const ln of wrapRuns([{ text: `${mark} ${b.runs[0].text}`, link: 0 }], style, VIEW_W)) {
                if (out.length >= MAX_LINES) break;
                emit(style, 0, 0, css ? css.color : C.head, css ? css.bg : B.none, ln.text);
                out.push(`D${b.isOpen ? 1 : 0}${b.group}`);
            }
            continue;
        }
        if (b.kind === 'dend') { out.push('E'); continue; }
        if (b.kind === 'hr') { gap(GAP.hr); emit(S.rule, 0, 0, 0, 0, ''); gap(GAP.hr); continue; }
        if (b.kind === 'img') { gap(GAP.img); emit(S.small, 0, 0, C.dim, B.code, ` [그림] ${b.alt}`); continue; }
        if (b.kind === 'pre') {
            gap(GAP.pre);
            const cols = Math.floor((VIEW_W * 0.97) / (STYLES[S.mono].size * 0.5)) - 1;
            for (const raw of b.text.split('\n')) {
                let rest = raw.replace(/\s+$/, '');
                do {
                    const piece = cutColsHard(rest, cols);
                    emit(S.mono, 0, 0, b.css?.color ?? C.code, b.css && b.css.bg !== b.css.page ? b.css.bg : B.code, ` ${piece}`);
                    rest = rest.slice(piece.length);
                } while (rest.length && out.length < MAX_LINES);
            }
            gap(GAP.pre);
            continue;
        }
        if (b.kind === 'table') {
            gap(GAP.table);
            const n = Math.min(8, Math.max(...b.rows.map((r) => r.cells.length)));
            const total = Math.floor((VIEW_W * 0.97) / (STYLES[S.mono].size * 0.5)) - 1;
            let widths = Array.from({ length: n }, (_, i) => Math.min(28, Math.max(1, ...b.rows.map((r) => W2(r.cells[i] || '')))));
            // 넘치면 넓은 칸부터 줄인다
            const budget = total - (n - 1) * 3;
            while (widths.reduce((a, x) => a + x, 0) > budget && Math.max(...widths) > 4) {
                const i = widths.indexOf(Math.max(...widths));
                widths[i] -= 1;
            }
            widths = widths.map((w) => Math.max(1, w));
            const fmt = (cells) => cells.slice(0, n).map((c, i) => {
                const t = cutCols(c || '', widths[i]);
                return t + ' '.repeat(Math.max(0, widths[i] - W2(t)));
            }).join(' | ').replace(/\s+$/, '');
            b.rows.forEach((r, k) => {
                if (out.length >= MAX_LINES) return;
                const { head } = r;
                emit(S.mono, 0, r.link || 0, head ? C.head : (r.link ? C.link : C.text), head ? B.head : B.code, ` ${fmt(r.cells)}`);
                if (head) emit(S.mono, 0, 0, C.dim, B.code, ` ${widths.map((w) => '-'.repeat(w)).join('-+-')}`);
            });
            gap(GAP.table);
            continue;
        }

        // 글 블록
        let style = S.body; let color = C.text; let indent = 0; let kind = 'p';
        if (b.kind === 'h1') { style = S.h1; color = C.head; kind = 'h1'; }
        else if (b.kind === 'h2') { style = S.h2; color = C.head; kind = 'h2'; }
        else if (b.kind === 'h3') { style = S.h3; color = C.head; kind = 'h3'; }
        else if (b.kind === 'small' || b.small) { style = S.small; color = C.dim; kind = 'small'; }
        else if (b.kind === 'li') kind = 'li';
        if (b.quote) { indent += 14; color = C.dim; }
        const depth = Math.min(4, b.depth || 0);
        if (kind === 'li') indent += 4 + (depth - 1) * 14;
        // CSS — 크기로 스타일을, 사이트의 색·바탕·정렬을 쓴다
        const css = theme && b.css;
        let bg = B.none;
        if (css) {
            style = styleOf(css, b.kind, b.runs.reduce((a, r) => a + r.text.trim().length, 0));
            color = css.color;
            bg = css.bg;
        }
        // 가운데·오른쪽 정렬은 앞 공백으로 (들여쓰기와 같은 방법)
        const align = (t, avail) => {
            if (!css || css.align === 'l') return 0;
            const room = Math.max(0, avail * 0.97 - textPx(t, style));
            return css.align === 'c' ? room / 2 : room;
        };

        const runs = b.runs.map((r) => ({ text: r.text, link: r.link, color: r.color }));
        // 앞뒤 공백 정리
        runs[0].text = runs[0].text.replace(/^\s+/, '');

        // 링크가 대부분인 블록(메뉴, "더 알아보기: 가 · 나 · 다")은 **링크마다 한 줄**로.
        // 엔트리에서는 줄 하나가 링크 하나라서, 한 줄에 몰아 두면 첫 링크만 누를 수 있다.
        const linkIds = [...new Set(runs.filter((r) => r.link && r.text.trim()).map((r) => r.link))];
        const total = runs.reduce((a, r) => a + r.text.trim().length, 0);
        const linked = runs.reduce((a, r) => a + (r.link ? r.text.trim().length : 0), 0);
        if (linkIds.length >= 2 && linked >= total * 0.45 && kind !== 'li') {
            if (!b.cont) gap(GAP[kind] ?? GAP.p);
            // 첫 링크 앞의 글("더 알아보기:")은 머리줄로 남긴다
            const lead = runs.slice(0, runs.findIndex((r) => r.link)).map((r) => r.text).join('').trim();
            if (/[가-힣A-Za-z0-9]/.test(lead)) {
                for (const ln of wrapRuns([{ text: lead, link: 0 }], style, VIEW_W - indent)) {
                    emit(style, indent + align(ln.text, VIEW_W - indent), 0, color, bg, ln.text);
                }
            }
            for (const id of linkIds) {
                const label = runs.filter((r) => r.link === id).map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
                const linkColor = css ? (runs.find((r) => r.link === id && r.color)?.color ?? color) : C.link;
                for (const ln of wrapRuns([{ text: label, link: id }], style, VIEW_W - indent)) {
                    if (out.length >= MAX_LINES) break;
                    emit(style, indent + align(ln.text, VIEW_W - indent), id, linkColor, bg, ln.text);
                }
            }
            continue;
        }
        const marker = kind === 'li' && b.marker ? `${b.marker} ` : '';
        const markerPx = marker ? textPx(marker, style) : 0;
        const lines = wrapRuns(runs, style, VIEW_W - indent - markerPx);
        if (!lines.length) continue;
        if (!b.cont) gap(GAP[kind] ?? GAP.p);
        lines.forEach((ln, i) => {
            if (out.length >= MAX_LINES) return;
            // CSS 모드: 줄의 색은 그 줄에서 가장 많은 글자의 색 (링크 줄이면 사이트의 링크 색)
            const look = css ? { color: ln.color ?? color, bg } : linkLook(ln, color);
            const lineIndent = indent + (marker && i > 0 ? markerPx : 0);
            const body = (i === 0 ? marker : '') + ln.text;
            const lead = emit(style, lineIndent + align(body, VIEW_W - lineIndent), ln.link, look.color, look.bg, body);
            // 링크가 줄의 일부면 구간을 붙인다 (들여쓰기 공백과 첫 줄의 머리표만큼 민다)
            const whole = css ? ln.linkChars / Math.max(1, ln.chars) >= 0.5 : look.color === C.link;
            if (!whole && ln.spans.length) {
                const shift = lead + (i === 0 && marker ? markerPx : 0);
                out.push(`K${formatSpans(ln.spans.map((sp) => ({ ...sp, x0: sp.x0 + shift, x1: sp.x1 + shift })))}`);
                // 그리고 링크에 색을 — 조각으로 나눈다 (CSS 모드면 사이트의 링크 색)
                const linkColorOf = (id) => (css ? (runs.find((r) => r.link === id && r.color)?.color ?? C.link) : C.link);
                if (ln.ranges?.length) segments(ln, style, look.color, linkColorOf);
            }
        });
    }
    if (out.length >= MAX_LINES) emit(S.small, 0, 0, C.dim, B.none, '(페이지가 길어 여기서 잘랐습니다)');
    return out;
}

// 고정폭 칸 수로 자른다 (한글 2칸) — 잘린 **원문 앞부분**을 그대로 돌려준다
function cutColsHard(s, max) {
    let w = 0; let i = 0;
    for (const ch of s) {
        const cw = ch.codePointAt(0) >= 0xac00 ? 2 : 1;
        if (w + cw > max) break;
        w += cw; i += ch.length;
    }
    return s.slice(0, Math.max(i, 1));
}

// ---------------------------------------------------------------------------
// 3. 입구
// ---------------------------------------------------------------------------
/**
 * 검색 엔진의 **경유 링크**를 실제 주소로 푼다.
 * 덕덕고 결과 링크는 duckduckgo.com/l/?uddg=<실제 주소> 로 가는데, 그 페이지는 HTTP 리다이렉트가
 * 아니라 자바스크립트(와 noscript 의 meta refresh)로 넘긴다. 엔트리에서는 빈 페이지가 됐다.
 * 미리 풀면 왕복도 한 번 줄고, 주소가 짧아져 띠 격자(392바이트)에도 들어간다.
 * (풀지 못한 경유는 guard.fetchPage 가 meta refresh 를 따라가서 받는다)
 */
const WRAPPERS = [
    { host: /(^|\.)duckduckgo\.com$/, path: /^\/l\/?$/, param: 'uddg' },
    { host: /(^|\.)google\.[a-z.]+$/, path: /^\/url$/, param: ['q', 'url'] },
];
function unwrapRedirect(u) {
    for (const w of WRAPPERS) {
        if (!w.host.test(u.hostname) || !w.path.test(u.pathname)) continue;
        for (const p of [].concat(w.param)) {
            const target = u.searchParams.get(p);
            if (!target) continue;
            try {
                const t = new URL(target);
                if (t.protocol === 'http:' || t.protocol === 'https:') { t.hash = ''; return t; }
            } catch { /* 다음 이름 */ }
        }
    }
    return u;
}

export function makeLinker(page, base = page) {
    const links = [];
    const index = new Map();
    const local = page.startsWith('entry://');
    let origin = '';
    if (!local) { try { origin = new URL(page).origin; } catch { /* 형식이 틀린 주소 (오류 페이지) */ } }
    const linkOf = (href) => {
        if (!href) return 0;
        let url;
        if (local && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
            url = href;                                     // 작품 안의 페이지 (help.html)
        } else {
            try {
                const u = new URL(href, local ? undefined : base);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') return 0;
                if (!local) {
                    const b = new URL(page);
                    if (u.hash && u.origin === b.origin && u.pathname === b.pathname && u.search === b.search) return 0;
                }
                u.hash = '';
                url = readableUrl(unwrapRedirect(u).href);
                // 같은 출처면 경로만 (엔트리가 출처를 붙인다 — page.mjs 의 pg_org)
                if (origin && url.startsWith(`${origin}/`)) url = url.slice(origin.length);
            } catch { return 0; }
        }
        url = entryChars(url).replace(/\s/g, '%20');
        if (index.has(url)) return index.get(url);
        if (links.length >= MAX_LINKS) return 0;
        links.push(url);
        index.set(url, links.length);
        return links.length;
    };
    return { links, linkOf };
}

/**
 * @param {string} source 원문 HTML
 * @param {string} url    최종 주소 (상대 링크 기준). 작품 안의 페이지는 'entry://local/<이름>'
 * @param {{mode?:'article'|'full'}} opt
 * @returns {{title, body, lines:number, links:number, mode, truncated}}
 */
export function layoutHtml(source, url, { mode = 'article' } = {}) {
    // ⚠ jsdom 은 잘못된 주소를 받으면 던진다. 오류 페이지(형식이 틀린 주소)를 만들다 앱이 죽으면
    //   클립보드에 아무것도 안 들어가 엔트리가 영영 기다린다 — 그래서 늘 성한 주소를 준다.
    let domUrl = 'https://local.invalid/';
    if (!url.startsWith('entry://')) { try { domUrl = new URL(url).href; } catch { /* 그대로 */ } }
    let dom = new JSDOM(source, { url: domUrl, contentType: 'text/html' });
    let doc = dom.window.document;
    const look0 = baseLook(doc);                    // 렌더 모드가 CSS 를 적어 보냈으면
    const theme = look0 && { page: look0.page, pal: makePalette() };
    let title = entryChars(doc.title || '').replace(/\s+/g, ' ').trim();
    // <base href> 가 있으면 상대 링크를 그것 기준으로 푼다 (같은 페이지 #링크 판단은 페이지 주소로)
    let base = url;
    const baseHref = doc.querySelector('base[href]')?.getAttribute('href');
    if (baseHref && !url.startsWith('entry://')) { try { base = new URL(baseHref, url).href; } catch { /* 그대로 */ } }

    let root = null; let used = 'full';
    if (mode === 'article' && !url.startsWith('entry://')) {
        // Readability 는 문서를 고친다. 예전엔 원문을 통째로 복제(cloneNode)해 넘겼는데 큰 페이지에서
        // 그것만 130ms 였다. 원문에 바로 돌리고, 본문을 못 찾은 드문 경우에만 원문을 다시 파싱한다.
        let touched = false;
        try {
            touched = true;
            const art = new Readability(doc).parse();
            if (art?.content && (art.textContent || '').trim().length > 400) {
                root = doc.createElement('body');
                root.innerHTML = art.content;
                if (art.title) title = entryChars(art.title).replace(/\s+/g, ' ').trim();
                used = 'article';
            }
        } catch { /* 본문을 못 찾으면 전체 */ }
        if (!root && touched) {
            dom.window.close();
            dom = new JSDOM(source, { url: domUrl, contentType: 'text/html' });
            doc = dom.window.document;
        }
    }
    if (!root) root = doc.body || doc.documentElement;
    const { links, linkOf } = makeLinker(url, base);
    const fm = prepareForms(root, url.startsWith('entry://') ? 'https://local.invalid/' : base);
    const blocks = extract(root, linkOf, fm, look0);
    // 본문만 보기면 제목을 맨 위에 (Readability 가 본문에서 h1 을 빼는 경우가 많다)
    if (used === 'article' && title && !(blocks[0]?.kind === 'h1')) blocks.unshift({ kind: 'h1', depth: 0, runs: [{ text: title, link: 0 }] });
    if (host0(url)) blocks.unshift({ kind: 'note', text: `${host0(url)}  -  ${used === 'article' ? '본문만' : '전체'}`, head: true });
    let lines = layoutBlocks(blocks, fm, theme);
    dom.window.close();

    // 링크는 실제로 쓰인 것만 남긴다 (번호를 다시 매긴다)
    const make = (ls) => {
        const used = new Map();
        const keep = [];
        const idOf = (n) => { if (!used.has(n)) { keep.push(links[n - 1]); used.set(n, keep.length); } return used.get(n); };
        const remapped = ls.map((l) => {
            if (l[0] === 'K') return `K${l.slice(1).split(';').map((t) => { const [a, b, n] = t.split(','); return `${a},${b},${idOf(Number(n))}`; }).join(';')}`;
            if (!/^[1-9]/.test(l)) return l;               // 간격(0)과 W·D·E 줄은 그대로
            const n = Number(l.slice(3, 7));
            if (!n) return l;
            if (!used.has(n)) { keep.push(links[n - 1]); used.set(n, keep.length); }
            return l.slice(0, 3) + String(used.get(n)).padStart(4, '0') + l.slice(7);
        });
        // 양식 · 칸 · 선택지 — 탭으로 가른다 (글 안의 탭은 clean() 이 이미 지웠다)
        const formLines = [
            ...fm.forms.map((f) => `F${f.method}\t${f.action}`),
            ...fm.fields.map((f) => `I${[f.form, f.type, f.name, f.value, f.label, f.on, f.min, f.max, f.step].join('\t')}`),
            ...fm.options.map((o) => `O${[o.field, o.value, o.label, o.selected].join('\t')}`),
        ];
        const colors = theme ? theme.pal.lines(theme.page) : [];
        return [`T${title}`, ...keep.map((u) => `U${u}`), ...colors, ...formLines, ...remapped].join('\n');
    };
    let body = make(lines);
    let truncated = false;
    while (Buffer.byteLength(body) > MAX_BODY && lines.length > 20) {
        lines = lines.slice(0, Math.floor(lines.length * 0.85));
        lines.push(theme ? record(S.small, 0, 0, theme.pal.fg(readable(COLORS[C.dim], theme.page)), theme.pal.bg(theme.page), '(페이지가 길어 여기서 잘랐습니다)')
            : record(S.small, 0, 0, C.dim, B.none, '(페이지가 길어 여기서 잘랐습니다)'));
        body = make(lines);
        truncated = true;
    }
    return { title, body, lines: lines.length, links: (body.match(/^U/gm) || []).length, mode: used, truncated };
}

/** 주소의 호스트 (맨 윗줄에 쓴다). 작품 안의 페이지·형식이 틀린 주소(오류 페이지)는 '' */
function host0(url) {
    if (url.startsWith('entry://')) return '';
    try { return entryChars(new URL(url).host); } catch { return ''; }
}

/** 글만 있는 문서 (text/plain) */
export function layoutText(source, url) {
    const t = entryChars(source).slice(0, 60000);
    const blocks = [{ kind: 'pre', text: t }];
    const lines = layoutBlocks(blocks);
    return { title: url, body: [`T${url}`, ...lines].join('\n'), lines: lines.length, links: 0, mode: 'text', truncated: source.length > 60000 };
}

/** 오류도 페이지다 — 엔트리 쪽은 오류를 따로 다루지 않는다 */
export function layoutError(url, title, detail) {
    const html = `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`
        + `<ul><li><a href="${escapeHtml(url)}">이 주소 다시 요청하기</a></li></ul><p>뒤로 가려면 ← 를 누르세요.</p>`;
    return layoutHtml(html, url, { mode: 'full' });
}
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
