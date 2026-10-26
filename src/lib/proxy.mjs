// src/lib/proxy.mjs — 렌더 모드의 모든 요청이 지나가는 검문소
//
// 렌더 모드에서는 Chromium 이 페이지를 열고 자바스크립트를 실행한다. 그러면 문서 하나가
// 아니라 CSS·이미지·fetch()·웹소켓까지 **페이지가 원하는 곳은 어디든** 요청이 나간다.
// guard.mjs 의 검사를 문서에만 하면 페이지 속 스크립트가 `fetch('http://192.168.0.1/')`
// 로 공유기를 두드릴 수 있다.
//
// 그래서 렌더 세션의 프록시를 이 서버로 정한다. Chromium 은 프록시가 있으면 DNS 를 직접
// 풀지 않고 이름을 그대로 넘기므로, **실제 접속 IP 검사(guardedLookup)를 여기서 한 번에** 한다.
//   - CONNECT host:port  → https·wss. 검사 후 TCP 를 이어 준다 (내용은 암호화돼 못 본다).
//   - GET http://…       → http·ws. 검사 후 대신 요청한다.
// 127.0.0.1 에만 열고, 루프백 예외를 지워(`<-loopback>`) localhost 요청도 여기로 와서 막힌다.

import http from 'node:http';
import net from 'node:net';
import { checkUrl, guardedLookup } from './guard.mjs';

const HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade']);

/**
 * @param {{onBlock?: (host:string, reason:string) => void}} opts
 * @returns {Promise<{port:number, close:() => void}>}
 */
export function startProxy({ onBlock = () => {} } = {}) {
    const server = http.createServer((req, res) => {
        let u;
        try { u = checkUrl(req.url); } catch (e) {
            onBlock(req.url, e.message);
            res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(e.message);
            return;
        }
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
        const up = http.request(u, { method: req.method, headers, lookup: guardedLookup }, (r) => {
            res.writeHead(r.statusCode || 502, r.headers);
            r.pipe(res);
        });
        up.on('error', (e) => {
            onBlock(u.host, e.message);
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(e.message);
        });
        req.pipe(up);
    });

    // http 웹소켓(ws://)은 Upgrade 로 온다. 드물고 막아도 페이지는 대개 뜬다.
    server.on('upgrade', (req, sock) => sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'));

    server.on('connect', (req, client, head) => {
        let u;
        try { u = checkUrl(`https://${req.url}/`); } catch (e) {
            onBlock(req.url, e.message);
            client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
            return;
        }
        // IP 를 그대로 쓴 주소는 lookup 을 거치지 않는다 — checkUrl 이 이미 그 IP 를 검사했다.
        const host = u.hostname.replace(/^\[|\]$/g, '');
        const up = net.connect({ host, port: Number(u.port) || 443, lookup: guardedLookup }, () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head?.length) up.write(head);
            up.pipe(client);
            client.pipe(up);
        });
        up.setTimeout(30_000, () => up.destroy());
        up.on('error', (e) => {
            onBlock(u.host, e.message);
            client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        });
        client.on('error', () => up.destroy());
    });
    server.on('clientError', (_e, sock) => sock.destroy());

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            close: () => server.close(),
        }));
    });
}
