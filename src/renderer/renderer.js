// src/renderer/renderer.js — 화면: 소스 고르기, 캡처 루프, 기록

const $ = (id) => document.getElementById(id);
const INTERVAL = 600;           // ms. 격자는 Enter 를 누를 때까지 떠 있으니 이 정도면 충분하다

const worker = new Worker(new URL('./capture-worker.mjs', import.meta.url), { type: 'module' });
const video = $('video');
const canvas = $('canvas');
const ctx2d = canvas.getContext('2d', { willReadFrequently: true });

let stream = null;
let timer = null;
let waiting = false;            // 워커가 프레임 하나를 읽는 중
let lastErrorAt = 0;

// ---------------------------------------------------------------- 기록
function addLog({ kind, text, at = Date.now() }) {
    const li = document.createElement('li');
    li.className = kind;
    const t = new Date(at).toLocaleTimeString('ko-KR', { hour12: false });
    li.textContent = `${t}  ${text}`;
    $('log').prepend(li);
    while ($('log').children.length > 60) $('log').lastChild.remove();
}
window.relay.onLog(addLog);

function setState(cls, text) {
    $('state').className = `state ${cls}`;
    $('stateText').textContent = text;
}

// ---------------------------------------------------------------- 설정
async function loadSettings() {
    const s = await window.relay.settings();
    document.querySelectorAll('input[name=mode]').forEach((r) => { r.checked = r.value === s.mode; });
    $('confirm').checked = s.confirmNewHosts;
    $('render').checked = s.render;
    $('layout').checked = s.layout;
    $('layout').disabled = !s.render;             // 렌더 모드가 있어야 배치를 잴 수 있다
    document.querySelectorAll('input[name=limg]').forEach((r) => { r.checked = r.value === s.layoutImages; r.disabled = !s.render || !s.layout; });
    $('known').textContent = s.knownHosts;
    return s;
}
document.querySelectorAll('input[name=mode]').forEach((r) =>
    r.addEventListener('change', () => window.relay.set({ mode: r.value })));
$('confirm').addEventListener('change', (e) => window.relay.set({ confirmNewHosts: e.target.checked }));
$('render').addEventListener('change', async (e) => {
    await window.relay.set({ render: e.target.checked });
    const s = await loadSettings();     // 경고에서 취소하면 꺼진 채로 돌아온다
    addLog({ kind: s.render ? 'warn' : 'info', text: s.render ? '렌더 모드를 켰습니다 (자바스크립트 실행)' : '렌더 모드를 껐습니다' });
});
$('layout').addEventListener('change', async (e) => {
    await window.relay.set({ layout: e.target.checked });
    const s = await loadSettings();
    addLog({ kind: 'info', text: s.layout ? '레이아웃 모드를 켰습니다 (쪽 넘김)' : '레이아웃 모드를 껐습니다' });
});
document.querySelectorAll('input[name=limg]').forEach((r) => r.addEventListener('change', async () => {
    await window.relay.set({ layoutImages: r.value });
    addLog({ kind: 'info', text: r.value === 'alt' ? '레이아웃 그림: 대체 글만' : '레이아웃 그림: 저해상도 칸' });
}));
$('forget').addEventListener('click', async () => {
    await window.relay.set({ forgetHosts: true });
    loadSettings();
    addLog({ kind: 'info', text: '기억한 사이트를 모두 잊었습니다' });
});

// ---------------------------------------------------------------- 소스
async function loadSources() {
    const list = await window.relay.sources();
    const sel = $('source');
    const prev = sel.value;
    sel.innerHTML = '';
    for (const s of list) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = `${s.id.startsWith('screen') ? '화면' : '창'} — ${s.name}`;
        sel.append(o);
    }
    // 엔트리가 열려 있을 법한 창을 먼저 고른다 (엔트리 사이트 제목에는 '엔트리' 가 들어간다)
    const guess = list.find((s) => s.id === prev)
        || list.find((s) => /엔트리/.test(s.name) && !/Relay/.test(s.name));
    if (guess) sel.value = guess.id;
}
$('refresh').addEventListener('click', loadSources);

// ---------------------------------------------------------------- 캡처
async function start() {
    const id = $('source').value;
    if (!id) return addLog({ kind: 'error', text: '캡처할 창을 먼저 고르세요' });
    await window.relay.choose(id);
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
    } catch (e) {
        return addLog({ kind: 'error', text: `캡처를 시작하지 못했습니다: ${e.message}` });
    }
    stream.getVideoTracks()[0].addEventListener('ended', stop);
    video.srcObject = stream;
    await video.play();
    timer = setInterval(grab, INTERVAL);
    $('toggle').textContent = '캡처 멈춤';
    setState('on', '캡처 중 — 격자를 기다립니다');
    addLog({ kind: 'info', text: `캡처 시작: ${$('source').selectedOptions[0]?.textContent}` });
}

function stop() {
    clearInterval(timer);
    timer = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    canvas.width = 0;
    canvas.height = 0;
    waiting = false;
    $('toggle').textContent = '캡처 시작';
    setState('off', '꺼짐');
    addLog({ kind: 'info', text: '캡처를 멈췄습니다' });
}

$('toggle').addEventListener('click', () => (stream ? stop() : start()));
$('again').addEventListener('click', async () => {
    await window.relay.reset();
    addLog({ kind: 'info', text: '다음에 읽히는 격자를 새 요청처럼 처리합니다' });
});

function grab() {
    if (waiting || !video.videoWidth) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx2d.drawImage(video, 0, 0);
    const { width, height, data } = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
    // 캔버스에 화면을 남겨 두지 않는다. 픽셀은 워커로 **넘기고**(transfer) 여기서는 손을 뗀다.
    canvas.width = 0;
    waiting = true;
    worker.postMessage({ width, height, buf: data.buffer }, [data.buffer]);
}

worker.onmessage = async ({ data }) => {
    waiting = false;
    if (!stream || !data.found) {
        if (stream) setState('on', '캡처 중 — 격자를 기다립니다');
        return;
    }
    if (data.error) {
        setState('warn', '격자를 찾았지만 읽지 못했습니다');
        // 그리는 중인 격자는 몇 프레임 동안 실패한다. 기록은 가끔만 남긴다.
        if (Date.now() - lastErrorAt > 5000) {
            lastErrorAt = Date.now();
            addLog({ kind: 'warn', text: `격자 판독 실패 (그리는 중이면 정상): ${data.error}` });
        }
        return;
    }
    if (!/^WEB[12]\|/.test(data.raw)) {
        setState('warn', '엔트리 OS 웹 요청이 아닌 격자입니다');
        return;
    }
    setState('busy', '요청을 처리하는 중');
    const r = await window.relay.request(data.raw);
    if (r.ok) setState('done', `응답 #${r.seq} 준비됨 — 엔트리 입력창에 Ctrl+V → Enter`);
    else if (r.reason === 'duplicate') setState('done', '응답 준비됨 — 엔트리 입력창에 Ctrl+V → Enter');
};

// ---------------------------------------------------------------- 동의
async function boot() {
    const s = await loadSettings();
    if (!s.consented) {
        $('consent').hidden = false;
        return;
    }
    loadSources();
}
$('agree').addEventListener('change', (e) => { $('accept').disabled = !e.target.checked; });
$('accept').addEventListener('click', async () => {
    if (await window.relay.consent(true)) {
        $('consent').hidden = true;
        loadSources();
    }
});
$('quit').addEventListener('click', () => window.close());

boot();
