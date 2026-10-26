// src/lib/guard.mjs — 주소 검사와 가져오기
//
// 이 앱은 **아무 엔트리 작품이나** 화면에 띄운 요청대로 인터넷에서 페이지를 가져온다.
// 그 작품을 만든 사람이 노리는 것은 엔트리가 아니라 **이 컴퓨터가 닿는 곳**이다:
// 공유기 관리 페이지, 사내망, localhost 에 떠 있는 개발 서버 같은 것들.
// 그래서 내부망·루프백·링크로컬 주소를 막는다.
//
// ⚠ 최선의 노력이지 완벽한 차단이 아니다 (README 의 고지). 그래서 사용자에게
//   격리된 환경(VM, Windows Sandbox)을 권한다.
//
// 어떻게 막나
//   - 주소가 IP 그대로면 그 IP 를 검사한다.
//   - 이름이면 **실제로 접속할 IP** 를 검사한다. http(s).request 의 `lookup` 을
//     바꿔 끼워서, 검사한 바로 그 주소로만 연결된다. 이름을 먼저 풀어 검사하고
//     따로 접속하면 그 사이에 DNS 답이 바뀌는 공격(DNS rebinding)에 뚫린다.
//   - 리다이렉트는 따라가되 **한 번 갈 때마다** 같은 검사를 다시 한다.
//   - 쿠키를 보내지도 저장하지도 않는다. 자바스크립트는 실행하지 않는다.

import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

export class BlockedError extends Error {}

const BLOCK = new net.BlockList();
for (const [a, p] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCK.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
    ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
    ['64:ff9b::', 96], ['2001:db8::', 32],
]) BLOCK.addSubnet(a, p, 'ipv6');

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;

/** IPv4-mapped IPv6(::ffff:10.0.0.1) 는 안에 든 IPv4 로 본다 */
export function isBlockedIp(ip) {
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (m) ip = m[1];
    const fam = net.isIP(ip);
    if (!fam) return true;                       // IP 가 아니면 막는다 (안전한 쪽)
    return BLOCK.check(ip, fam === 4 ? 'ipv4' : 'ipv6');
}

/** 요청하기 전 주소 자체를 본다. 통과하면 URL 객체를 돌려준다. */
export function checkUrl(raw) {
    let u;
    try { u = new URL(raw); } catch { throw new BlockedError(`주소 형식이 잘못됐습니다: ${raw}`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new BlockedError(`http/https 주소만 가져옵니다 (${u.protocol})`);
    }
    if (u.username || u.password) throw new BlockedError('주소에 아이디/비밀번호가 들어 있어 거절했습니다');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) {
        if (isBlockedIp(host)) throw new BlockedError(`내부망/예약 주소라 막았습니다 (${host})`);
    } else if (BLOCKED_NAMES.test(host) || !host.includes('.')) {
        throw new BlockedError(`내부망 이름으로 보여 막았습니다 (${host})`);
    }
    return u;
}

/** 접속 직전에 불리는 lookup. 막힌 IP 가 하나라도 섞이면 통째로 거절한다. */
export function guardedLookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return cb(err);
        const bad = addrs.find((a) => isBlockedIp(a.address));
        if (bad) return cb(new BlockedError(`${hostname} 이(가) 내부망 주소(${bad.address})를 가리켜 막았습니다`));
        if (options.all) return cb(null, addrs);
        return cb(null, addrs[0].address, addrs[0].family);
    });
}

const UA = 'EntryBrowserRelay/0.1 (+experimental; text-only)';

function once(u, { timeout, maxBytes }) {
    const mod = u.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const req = mod.request(u, {
            method: 'GET',
            lookup: guardedLookup,
            timeout,
            headers: {
                'user-agent': UA,
                accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1',
                'accept-language': 'ko,en;q=0.7',
                'accept-encoding': 'gzip, deflate, br',
            },
        }, (res) => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                return resolve({ redirect: res.headers.location, status });
            }
            const enc = String(res.headers['content-encoding'] || '').toLowerCase();
            let stream = res;
            if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
            else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
            else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

            const chunks = [];
            let size = 0;
            let cut = false;
            stream.on('data', (c) => {
                if (cut) return;
                size += c.length;
                if (size > maxBytes) {
                    // 너무 크면 앞부분만 쓴다. 엔트리가 어차피 4만 자에서 자른다.
                    chunks.push(c.subarray(0, c.length - (size - maxBytes)));
                    cut = true;
                    req.destroy();
                    return finish();
                }
                chunks.push(c);
            });
            const finish = () => resolve({
                status,
                headers: res.headers,
                body: Buffer.concat(chunks),
                truncated: cut,
            });
            stream.on('end', () => { if (!cut) finish(); });
            stream.on('error', (e) => { if (!cut) reject(e); });
        });
        req.on('timeout', () => req.destroy(new Error(`${Math.round(timeout / 1000)}초 안에 응답이 없습니다`)));
        req.on('error', reject);
        req.end();
    });
}

/**
 * 페이지 하나를 가져온다. 리다이렉트를 따라가며 매번 검사한다.
 * @returns {Promise<{finalUrl:string,status:number,contentType:string,body:Buffer,truncated:boolean}>}
 */
export async function fetchPage(raw, { timeout = 15000, maxBytes = 3_000_000, maxRedirects = 5 } = {}) {
    let u = checkUrl(raw);
    for (let hop = 0; hop <= maxRedirects; hop++) {
        const r = await once(u, { timeout, maxBytes });
        if (r.redirect) {
            u = checkUrl(new URL(r.redirect, u).href);
            continue;
        }
        // <meta http-equiv="refresh" content="0;url=…"> 도 리다이렉트로 따라간다.
        // 경유 페이지(덕덕고 /l/ 등)는 HTTP 리다이렉트 대신 이것과 자바스크립트로 넘긴다 —
        // 스크립트는 실행하지 않으니 이것마저 안 따라가면 빈 페이지가 된다. 검사는 똑같이 한다.
        const refresh = metaRefresh(r);
        if (refresh) {
            u = checkUrl(new URL(refresh, u).href);
            continue;
        }
        return {
            finalUrl: u.href,
            status: r.status,
            contentType: String(r.headers['content-type'] || ''),
            body: r.body,
            truncated: r.truncated,
        };
    }
    throw new Error(`리다이렉트가 ${maxRedirects}번을 넘었습니다`);
}

/** HTML 앞부분에서 곧바로(5초 이하) 넘기는 meta refresh 의 주소. 없으면 null */
function metaRefresh(r) {
    if (r.status < 200 || r.status >= 300) return null;
    if (!/html/i.test(String(r.headers['content-type'] || 'text/html'))) return null;
    const head = r.body.subarray(0, 8192).toString('latin1');
    for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
        const tag = m[0];
        if (!/http-equiv\s*=\s*["']?refresh/i.test(tag)) continue;
        const content = /content\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2] ?? /content\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
        const mm = /^\s*(\d+(?:\.\d+)?)\s*[;,]\s*(?:url\s*=\s*)?['"]?([^'"]+)['"]?\s*$/i.exec(content || '');
        if (mm && Number(mm[1]) <= 5 && mm[2].trim()) return mm[2].trim();
    }
    return null;
}

/** Content-Type 헤더 → <meta charset> → utf-8 순으로 글자 인코딩을 정해 문자열로 */
export function decodeBody(body, contentType) {
    let label = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
    if (!label) {
        const head = body.subarray(0, 4096).toString('latin1');
        label = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
    }
    try {
        return new TextDecoder(label || 'utf-8', { fatal: false }).decode(body);
    } catch {
        return new TextDecoder('utf-8', { fatal: false }).decode(body);
    }
}
