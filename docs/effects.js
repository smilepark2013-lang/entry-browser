// docs/effects.js — 소개 페이지의 움직임
//
//   1·4  첫 화면의 미니 Entry Browser — 저절로 왕복을 보여 주다가, 마우스를 올리면 직접 만질 수 있다
//   2    그 왼쪽 띠의 격자는 진짜 요청이다 (docs/grids.js — scripts/docs-grids.mjs 가 실제 코덱으로 만든다)
//   3    '작동 방식' 흐름도 — 화면에 들어오면 점 하나가 길을 따라 한 바퀴
//   5    테마 바꿀 때 색이 부드럽게 · 아이콘이 돌며 바뀜 · 명령 블록 복사 단추
//
// 움직임 줄이기(prefers-reduced-motion)를 켠 사람에게는 저절로 움직이지 않는다 (만지는 것은 된다).

(() => {
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s, el = document) => el.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================ 1·2·4 미니 브라우저
const mini = $('#mini');
if (mini) {
    // 페이지 — 실제 Entry Browser 처럼 줄 단위. go: 누르면 갈 페이지, sum: 펼치기 묶음
    const PAGES = {
        home: {
            url: 'index.html', title: '시작 페이지',
            lines: [
                ['h1', 'Entry Browser'],
                ['p', '엔트리 블록으로 만든 텍스트 브라우저입니다.'],
                ['p', '중계 앱을 켜 두면 진짜 웹 페이지를 글과 링크로 봅니다.'],
                ['h3', '가 보기'],
                ['li', '<a data-go="entry">위키백과: 엔트리 (프로그래밍 언어)</a>'],
                ['li', '<a data-go="scratch">위키백과: 스크래치 (프로그래밍 언어)</a>'],
                ['h3', '검색'],
                ['field', '덕덕고에서 검색 (누르고 입력 → Enter)'],
            ],
        },
        entry: {
            url: 'ko.wikipedia.org/wiki/엔트리_(프로그래밍_언어)', title: '엔트리 (프로그래밍 언어)',
            lines: [
                ['small', 'ko.wikipedia.org  -  본문만'],
                ['h1', '엔트리 (프로그래밍 언어)'],
                ['p', '엔트리는 한국에서 만든 블록 코딩 교육 플랫폼으로, 블록을 끼워'],
                ['p', '맞춰 게임과 애니메이션을 만든다. <a data-go="scratch">스크래치</a>와 비슷한 방식이다.'],
                ['sum', '역사', [
                    ['li', '2013년에 처음 공개되었다.'],
                    ['li', '지금은 비영리 재단이 운영한다.'],
                ]],
                ['h3', '주요 기능'],
                ['li', '블록 코딩과 텍스트 코딩'],
                ['li', '작품 공유와 커뮤니티'],
            ],
        },
        scratch: {
            url: 'ko.wikipedia.org/wiki/스크래치_(프로그래밍_언어)', title: '스크래치 (프로그래밍 언어)',
            lines: [
                ['small', 'ko.wikipedia.org  -  본문만'],
                ['h1', '스크래치 (프로그래밍 언어)'],
                ['p', '스크래치는 MIT 미디어 랩에서 만든 블록형 언어다. 한국의'],
                ['p', '<a data-go="entry">엔트리</a>도 비슷하게 블록을 끼워 맞추는 방식을 쓴다.'],
                ['sum', '버전', [
                    ['li', '1.4, 2.0, 3.0 순서로 나왔다.'],
                    ['li', '3.0 부터는 웹 브라우저에서 돈다.'],
                ]],
                ['h3', '같이 보기'],
                ['li', '<a data-go="entry">엔트리 (프로그래밍 언어)</a>'],
            ],
        },
    };

    const stage = $('.stage', mini);
    const page = $('#mini-page', mini);
    const grid = $('#mini-grid', mini);
    const url = $('#mini-url', mini);
    const status = $('#mini-status', mini);
    const ask = $('#mini-ask', mini);
    const askText = $('#mini-ask-text', mini);
    const clip = $('#mini-clip', mini);
    const cursor = $('#mini-cursor', mini);
    const tip = $('#mini-tip', mini);
    const G = window.GRIDS;

    // 격자 칸 (14×28) — 한 번 만들어 두고 색만 바꾼다
    const cells = [];
    for (let i = 0; i < G.cols * G.rows; i++) { const c = document.createElement('i'); grid.appendChild(c); cells.push(c); }
    const showGrid = (name, upto = G.rows) => {
        const g = G.pages[name].cells;
        cells.forEach((c, i) => { c.style.background = (Math.floor(i / G.cols) < upto && g[i]) || 'transparent'; });
    };
    const hideGrid = () => cells.forEach((c) => { c.style.background = 'transparent'; });

    let cur = 'home';
    let lastReq = 'entry';
    const hist = [];
    const fwd = [];

    const render = (name, animate) => {
        const p = PAGES[name];
        page.innerHTML = '';
        let n = 0;
        const add = (kind, html, extra = '') => {
            const d = document.createElement('div');
            d.className = `ln ${kind}${/data-go/.test(html) ? ' has-link' : ''} ${extra}`;
            d.innerHTML = html;
            if (animate && !reduce) { d.style.animationDelay = `${n * 80}ms`; d.classList.add('in'); }
            n++;
            page.appendChild(d);
            return d;
        };
        for (const [kind, html, kids] of p.lines) {
            if (kind === 'sum') {
                const s = add('sum', `<span class="tri"></span>${html}`, 'has-link');
                const box = document.createElement('div');
                box.className = 'kids';
                box.hidden = true;
                for (const [k2, h2] of kids) {
                    const d = document.createElement('div');
                    d.className = `ln ${k2}`;
                    d.innerHTML = h2;
                    box.appendChild(d);
                }
                page.appendChild(box);
                s.addEventListener('click', () => toggle(s, box));
            } else if (kind === 'li') add('li', `<span class="mk">•</span>${html}`);
            else add(kind, html);
        }
        url.textContent = p.url;
        const links = page.querySelectorAll('a[data-go]').length;
        status.textContent = `${p.title}   ·   링크 ${links}개`;
        cur = name;
    };
    const toggle = (s, box) => { box.hidden = !box.hidden; s.classList.toggle('open', !box.hidden); };

    // 왕복 — 링크를 누르면: 띠에 요청 격자 → 입력창 → (중계 앱이 클립보드에) → 붙여넣기 → 그려진다
    let busy = false;
    const roundTrip = async (to, { fast = false, token } = {}) => {
        const alive = () => token === undefined || token === run;
        busy = true;
        try {
            const req = to === 'home' ? null : to;          // 시작 페이지는 작품 안의 페이지 — 요청이 없다
            if (req && !reduce) {
                lastReq = req;
                status.textContent = '   불러오는 중…';
                for (let r = 1; r <= G.rows; r++) { showGrid(req, r); await sleep(fast ? 12 : 45); if (!alive()) return; }
                ask.classList.add('show');
                askText.textContent = '';
                await sleep(fast ? 400 : 1100); if (!alive()) return;
                clip.classList.add('show');
                await sleep(fast ? 600 : 1600); if (!alive()) return;
                clip.classList.remove('show');
                const pasted = `EBR2|${req === 'entry' ? 1 : 2}|…|aHR0cHM6Ly9rby53aWtpcGVkaWEub3Jn…`;   // 응답의 모양 (실제는 수천 자)
                for (let i = 0; i <= pasted.length; i += fast ? 8 : 3) { askText.textContent = pasted.slice(0, i); await sleep(28); if (!alive()) return; }
                await sleep(fast ? 250 : 600); if (!alive()) return;
                ask.classList.remove('show');
                hideGrid();
            }
            if (!alive()) return;
            render(to, true);
        } finally { busy = false; }
    };
    const go = async (to, opts) => {
        if (busy || to === cur) return;
        hist.push(cur); fwd.length = 0;
        await roundTrip(to, opts);
    };

    // ---- 만지기 (4) — 링크·펼치기·툴바
    page.addEventListener('click', (e) => {
        const a = e.target.closest('a[data-go]');
        if (a) { e.preventDefault(); stopAuto(); go(a.dataset.go, { fast: true }); }
    });
    $('#mini-back', mini).addEventListener('click', () => { if (busy || !hist.length) return; stopAuto(); fwd.push(cur); render(hist.pop(), true); });
    $('#mini-fwd', mini).addEventListener('click', () => { if (busy || !fwd.length) return; stopAuto(); hist.push(cur); render(fwd.pop(), true); });
    $('#mini-reload', mini).addEventListener('click', () => { if (busy) return; stopAuto(); roundTrip(cur, { fast: true }); });
    $('#mini-home', mini).addEventListener('click', () => { if (busy) return; stopAuto(); go('home', { fast: true }); });

    // ---- 진짜 격자 (2) — 띠에 마우스를 올리면 마지막 요청 격자와 그 안에 담긴 글을 보여 준다
    const strip = $('.strip', mini);
    strip.addEventListener('mouseenter', () => {
        stopAuto();
        showGrid(lastReq);
        tip.querySelector('code').textContent = G.pages[lastReq].req;
        tip.classList.add('show');
    });
    strip.addEventListener('mouseleave', () => { tip.classList.remove('show'); if (!busy) hideGrid(); });

    // ---- 저절로 (1) — 마우스가 미니 브라우저 위에 있으면 멈추고, 떠나고 4초 뒤에 다시
    let run = 0;
    let resume = null;
    const moveCursor = async (el, token) => {
        const s = stage.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const x = r.left - s.left + Math.min(r.width * 0.35, 60);
        const y = r.top - s.top + r.height * 0.55;
        cursor.style.transform = `translate(${x}px, ${y}px)`;
        await sleep(1150);
        return token === run;
    };
    const press = async (el) => { el.classList.add('pressed', 'hov'); await sleep(260); el.classList.remove('pressed'); };
    const auto = async () => {
        const token = ++run;
        const ok = () => token === run;
        // 커서는 카드 가운데에서 시작한다 (움직임 없이 옮겨 놓고 보인다)
        const s = stage.getBoundingClientRect();
        cursor.style.transition = 'none';
        cursor.style.transform = `translate(${s.width * 0.6}px, ${s.height * 0.62}px)`;
        void cursor.offsetWidth;
        cursor.style.transition = '';
        cursor.classList.add('show');
        while (ok()) {
            hist.length = 0; fwd.length = 0;
            render('home', true);
            await sleep(2200); if (!ok()) return;
            const link = page.querySelector('a[data-go="entry"]').closest('.ln');
            if (!(await moveCursor(link, token))) return;
            await press(link); if (!ok()) return;
            hist.push(cur);
            await roundTrip('entry', { token }); if (!ok()) return;
            await sleep(1800); if (!ok()) return;
            const sum = page.querySelector('.ln.sum');
            if (!(await moveCursor(sum, token))) return;
            await press(sum); if (!ok()) return;
            sum.click();
            await sleep(2600); if (!ok()) return;
            const next = page.querySelector('a[data-go="scratch"]').closest('.ln');
            if (!(await moveCursor(next, token))) return;
            await press(next); if (!ok()) return;
            hist.push(cur);
            await roundTrip('scratch', { token }); if (!ok()) return;
            await sleep(3400); if (!ok()) return;
            if (!(await moveCursor($('#mini-back', mini), token))) return;
            await sleep(200); if (!ok()) return;
            page.querySelectorAll('.hov').forEach((e) => e.classList.remove('hov'));
        }
    };
    const stopAuto = () => {
        run++;
        cursor.classList.remove('show');
        ask.classList.remove('show'); clip.classList.remove('show');
        page.querySelectorAll('.hov').forEach((e) => e.classList.remove('hov'));
        if (!strip.matches(':hover')) hideGrid();
        busy = false;
    };
    mini.addEventListener('mouseenter', () => { clearTimeout(resume); stopAuto(); });
    mini.addEventListener('mouseleave', () => { if (!reduce) resume = setTimeout(auto, 4000); });
    // 화면 밖이면 멈춘다 (배터리)
    new IntersectionObserver(([e]) => {
        if (reduce) return;
        if (e.isIntersecting && !mini.matches(':hover')) { clearTimeout(resume); auto(); } else stopAuto();
    }, { threshold: 0.3 }).observe(mini);

    render(reduce ? 'entry' : 'home', false);
}

// ============================================================ 3 흐름도
document.querySelectorAll('.flow-svg').forEach((svg) => {
    const motion = svg.querySelector('animateMotion');
    if (!motion || reduce) return;
    new IntersectionObserver(([e]) => {
        if (e.isIntersecting && getComputedStyle(svg).display !== 'none') {
            svg.classList.add('run');
            try { motion.beginElement(); } catch (err) { /* SMIL 이 없으면 점은 그냥 서 있다 */ }
        }
    }, { threshold: 0.6 }).observe(svg);
});

// ============================================================ 5 마무리
// 같은 페이지 안의 링크(상단바 · 첫 화면 단추) — 부드럽게 미끄러져 간다.
// CSS 의 scroll-behavior 는 브라우저·설정에 따라 꺼져 있어(실제로 바로 건너뛰었다) 직접 움직인다.
document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
        const id = a.getAttribute('href').slice(1);
        const target = id && document.getElementById(id);
        if (!target) return;
        e.preventDefault();
        // 상단바가 위에 붙어 있으니 그 높이만큼 덜 내려간다
        const bar = document.querySelector('header.top').offsetHeight;
        const top = target.getBoundingClientRect().top + scrollY - bar - 12;
        history.pushState(null, '', `#${id}`);
        if (reduce) { scrollTo(0, top); return; }
        const from = scrollY; const dist = top - from;
        const dur = Math.min(900, Math.max(450, Math.abs(dist) * 0.35));
        const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);   // 천천히 출발 · 천천히 멈춤
        const t0 = performance.now();
        const step = (now) => {
            const t = Math.min(1, (now - t0) / dur);
            scrollTo(0, from + dist * ease(t));
            if (t < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    });
});

// 명령 블록 복사 단추
document.querySelectorAll('pre').forEach((pre) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'copy';
    b.textContent = '복사';
    b.addEventListener('click', async () => {
        const text = pre.innerText.replace(/\n$/, '');
        try { await navigator.clipboard.writeText(text); } catch (e) {
            const r = document.createRange(); r.selectNodeContents(pre.querySelector('code') || pre);
            const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); document.execCommand('copy'); sel.removeAllRanges();
        }
        b.textContent = '복사됨'; b.classList.add('done');
        setTimeout(() => { b.textContent = '복사'; b.classList.remove('done'); }, 1500);
    });
    pre.classList.add('has-copy');
    pre.appendChild(b);
});
})();
