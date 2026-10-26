// 최소 USTAR 라이터. 외부 의존성 없이 .ent(tar+gzip)를 만들기 위한 것.
// .ent 는 tar 아카이브를 gzip 한 파일이다 (Entry Docs: "tar 압축, gzip memLevel 6").

const BLOCK = 512;

function pad(str, len) {
    const b = Buffer.alloc(len, 0);
    b.write(str, 0, 'utf8');
    return b;
}

function octal(num, len) {
    // len-1 자리 8진수 + NUL
    return pad(num.toString(8).padStart(len - 1, '0'), len);
}

function header(name, size, mtime) {
    const h = Buffer.alloc(BLOCK, 0);
    // 이름이 100바이트를 넘으면 prefix 필드로 분할해야 하지만,
    // 이 프로젝트의 경로(temp/project.json 등)는 짧아서 다루지 않는다.
    if (Buffer.byteLength(name) > 100) {
        throw new Error(`tar: 경로가 100바이트를 넘습니다: ${name}`);
    }
    pad(name, 100).copy(h, 0);
    octal(0o644, 8).copy(h, 100);   // mode
    octal(0, 8).copy(h, 108);       // uid
    octal(0, 8).copy(h, 116);       // gid
    octal(size, 12).copy(h, 124);   // size
    octal(mtime, 12).copy(h, 136);  // mtime
    h.write('        ', 148, 8);    // checksum 자리는 공백으로 두고 계산
    h.write('0', 156);              // typeflag: 일반 파일
    h.write('ustar\0', 257);
    h.write('00', 263);

    let sum = 0;
    for (const byte of h) sum += byte;
    octal(sum, 8).copy(h, 148);
    return h;
}

function padToBlock(buf) {
    const rem = buf.length % BLOCK;
    return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(BLOCK - rem, 0)]);
}

/**
 * @param {{name: string, data: Buffer|string}[]} files
 * @returns {Buffer} tar 아카이브
 */
export function createTar(files) {
    const mtime = Math.floor(Date.now() / 1000);
    const parts = [];
    for (const f of files) {
        const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
        parts.push(header(f.name, data.length, mtime));
        parts.push(padToBlock(data));
    }
    // 아카이브 끝 표시: 빈 블록 2개
    parts.push(Buffer.alloc(BLOCK * 2, 0));
    return Buffer.concat(parts);
}
