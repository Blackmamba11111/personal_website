/* ============================================================================
 * 远程认证协议单测（RADIUS / TACACS+ / LDAP）
 * 做法：在本地起「假认证服务器」（UDP / TCP），用真实报文与协议实现对接，
 *      因此不需要外网、也不需要真实设备，但仍能验证编解码与握手的正确性。
 * 运行：node tests/test-protocols.mjs
 * ==========================================================================*/
import dgram from 'node:dgram';
import net from 'node:net';
import crypto from 'node:crypto';
import * as P from '../worker/auth-protocols.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function md5(buf) { return crypto.createHash('md5').update(Buffer.from(buf)).digest(); }

/* ---------------- 传输层（Node 实现，供测试用） ---------------- */
function udpTransport() {
  return {
    udp(host, port, bytes, timeoutMs) {
      return new Promise((resolve, reject) => {
        const s = dgram.createSocket('udp4');
        const t = setTimeout(() => { try { s.close(); } catch (e) {} reject(new Error('timeout')); }, timeoutMs);
        s.on('message', (msg) => { clearTimeout(t); s.close(); resolve(new Uint8Array(msg)); });
        s.on('error', (e) => { clearTimeout(t); try { s.close(); } catch (e2) {} reject(e); });
        s.send(Buffer.from(bytes), port, host, (e) => { if (e) { clearTimeout(t); reject(e); } });
      });
    }
  };
}
function tcpTransport() {
  return {
    tcp(host, port, opts) {
      return new Promise((resolve, reject) => {
        const sock = net.connect({ host, port });
        let buf = Buffer.alloc(0);
        let waiter = null;
        const wake = () => { if (waiter && buf.length >= waiter.n) { const w = waiter; waiter = null; const out = buf.subarray(0, w.n); buf = buf.subarray(w.n); w.resolve(new Uint8Array(out)); } };
        sock.on('data', (c) => { buf = Buffer.concat([buf, c]); wake(); });
        sock.on('error', (e) => reject(e));
        sock.setTimeout(opts && opts.timeoutMs ? opts.timeoutMs : 5000, () => { sock.destroy(); reject(new Error('timeout')); });
        sock.once('connect', () => resolve({
          write(b) { return new Promise((res) => sock.write(Buffer.from(b), res)); },
          read(n) {
            if (buf.length >= n) { const out = buf.subarray(0, n); buf = buf.subarray(n); return Promise.resolve(new Uint8Array(out)); }
            return new Promise((res, rej) => { waiter = { n, resolve: res, reject: rej }; });
          },
          close() { sock.destroy(); }
        }));
      });
    }
  };
}
const T = Object.assign({}, udpTransport(), tcpTransport());

/* ---------------- 1. MD5 ---------------- */
check('MD5("")', P.md5Hex('') === 'd41d8cd98f00b204e9800998ecf8427e');
check('MD5("abc")', P.md5Hex('abc') === '900150983cd24fb0d6963f7d28e17f72');
check('MD5 长文本(80字节)',
  P.md5Hex('12345678901234567890123456789012345678901234567890123456789012345678901234567890') ===
  crypto.createHash('md5').update('12345678901234567890123456789012345678901234567890123456789012345678901234567890').digest('hex'));

/* ---------------- 2. RADIUS ---------------- */
function radiusServer(opts) {
  const secret = opts.secret || 's3cr3t';
  const srv = dgram.createSocket('udp4');
  const seen = { user: '', pwd: '', count: 0 };
  srv.on('message', (msg, rinfo) => {
    seen.count++;
    const code = msg[0], id = msg[1], len = (msg[2] << 8) | msg[3];
    const reqAuth = msg.subarray(4, 20);
    /* 解析属性 */
    let i = 20, user = '', encPwd = null;
    while (i + 2 <= len) {
      const type = msg[i], alen = msg[i + 1];
      const val = msg.subarray(i + 2, i + alen);
      if (type === 1) user = val.toString('utf8');
      if (type === 2) encPwd = val;
      i += alen;
    }
    /* 还原口令：p1 = MD5(secret + reqAuth)，p2 = MD5(secret + c1) */
    let pwd = Buffer.alloc(0), prev = reqAuth;
    if (encPwd) {
      for (let off = 0; off < encPwd.length; off += 16) {
        const b = md5(Buffer.concat([Buffer.from(secret), Buffer.from(prev)]));
        const block = Buffer.alloc(16);
        for (let k = 0; k < 16; k++) block[k] = encPwd[off + k] ^ b[k];
        pwd = Buffer.concat([pwd, block]);
        prev = block;
      }
      pwd = Buffer.from(pwd.toString('utf8').replace(/\u0000+$/, ''), 'utf8');
    }
    seen.user = user; seen.pwd = pwd.toString('utf8');
    const okUser = user === opts.user && seen.pwd === opts.password;
    const rcode = okUser ? 2 : 3;
    const attrs = okUser ? Buffer.from([18, 6, 0, 0, 0, 1]) : Buffer.alloc(0);  /* Reply-Message 省略，仅放个占位属性 */
    const head = Buffer.from([rcode, id, 0, 20 + attrs.length]);
    const calc = md5(Buffer.concat([head, reqAuth, attrs, Buffer.from(secret)]));
    srv.send(Buffer.concat([head, calc, attrs]), rinfo.port, rinfo.address);
  });
  return new Promise((res) => srv.bind(0, '127.0.0.1', () => res({
    port: srv.address().port, seen: seen, close: () => srv.close()
  })));
}

{
  const s = await radiusServer({ user: 'alice', password: 'P@ssw0rd-rad', secret: 's3cr3t' });
  const r1 = await P.radiusAuth(T, { host: '127.0.0.1', port: s.port, secret: 's3cr3t' }, 'alice', 'P@ssw0rd-rad');
  check('RADIUS 正确口令 → 通过', r1.ok === true, JSON.stringify(r1));
  check('RADIUS 服务端收到的用户名', s.seen.user === 'alice', s.seen.user);
  check('RADIUS 服务端还原出的口令', s.seen.pwd === 'P@ssw0rd-rad', JSON.stringify(s.seen.pwd));

  const r2 = await P.radiusAuth(T, { host: '127.0.0.1', port: s.port, secret: 's3cr3t' }, 'alice', 'wrong');
  check('RADIUS 错误口令 → 拒绝', r2.ok === false && r2.code === 'reject', JSON.stringify(r2));

  const r3 = await P.radiusAuth(T, { host: '127.0.0.1', port: s.port, secret: 'bad-secret' }, 'alice', 'P@ssw0rd-rad');
  check('RADIUS 共享密钥不一致 → 校验失败', r3.ok === false && r3.code === 'badsecret', JSON.stringify(r3));
  s.close();

  /* 无响应：端口上没人监听时 UDP 会回 ICMP，收敛为 neterr / timeout 都算合理 */
  const r4 = await P.radiusAuth(T, { host: '127.0.0.1', port: 1, secret: 'x', timeout: 1 }, 'bob', 'x');
  check('RADIUS 服务器无响应 → 报错而非崩溃', r4.ok === false && /timeout|neterr/.test(r4.code), JSON.stringify(r4));
}

/* ---------------- 3. TACACS+ ---------------- */
function tacacsObf(payload, key, sid, version, seq) {
  const sidb = Buffer.from([(sid >>> 24) & 255, (sid >>> 16) & 255, (sid >>> 8) & 255, sid & 255]);
  let prev = md5(Buffer.concat([sidb, Buffer.from(key), Buffer.from([version, seq])]));
  const out = Buffer.alloc(payload.length);
  for (let off = 0; off < payload.length; off += 16) {
    if (off > 0) prev = md5(Buffer.concat([sidb, Buffer.from(key), prev]));
    const n = Math.min(16, payload.length - off);
    for (let i = 0; i < n; i++) out[off + i] = payload[off + i] ^ prev[i];
  }
  return out;
}
function tacacsServer(opts) {
  const key = opts.secret || 'tac-key';
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length < 12) return;
      const version = buf[0], seq = buf[2], flags = buf[3];
      const sid = ((buf[4] << 24) | (buf[5] << 16) | (buf[6] << 8) | buf[7]) >>> 0;
      const len = ((buf[8] << 24) | (buf[9] << 16) | (buf[10] << 8) | buf[11]) >>> 0;
      if (buf.length < 12 + len) return;
      let body = buf.subarray(12, 12 + len);
      if (!(flags & 1)) body = tacacsObf(body, key, sid, version, seq);
      const uLen = body[4], pLen = body[7];   /* port/rem 长度在位 5、6 */
      const portLen = body[5], remLen = body[6];
      const user = body.subarray(8, 8 + uLen).toString('utf8');
      const pwd = body.subarray(8 + uLen + portLen + remLen, 8 + uLen + portLen + remLen + pLen).toString('utf8');
      const ok = user === opts.user && pwd === opts.password;
      const msg = Buffer.from(ok ? 'Welcome' : 'Login invalid', 'utf8');
      const rep = Buffer.alloc(6 + msg.length);
      rep[0] = ok ? 1 : 2;   /* PASS / FAIL */
      rep[1] = 0;
      rep.writeUInt16BE(msg.length, 2);
      rep.writeUInt16BE(0, 4);
      msg.copy(rep, 6);
      const enc = tacacsObf(rep, key, sid, 0xc0, 2);
      const head = Buffer.alloc(12);
      head[0] = 0xc0; head[1] = 1; head[2] = 2; head[3] = 0;
      head.writeUInt32BE(sid, 4); head.writeUInt32BE(rep.length, 8);
      sock.write(Buffer.concat([head, enc]));
    });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({
    port: srv.address().port, close: () => srv.close()
  })));
}

{
  const s = await tacacsServer({ user: 'bob', password: 'Tac@123', secret: 'tac-key' });
  const r1 = await P.tacacsAuth(T, { host: '127.0.0.1', port: s.port, secret: 'tac-key' }, 'bob', 'Tac@123');
  check('TACACS+ 正确口令 → 通过', r1.ok === true && r1.code === 'accept', JSON.stringify(r1));
  const r2 = await P.tacacsAuth(T, { host: '127.0.0.1', port: s.port, secret: 'tac-key' }, 'bob', 'bad');
  check('TACACS+ 错误口令 → 拒绝', r2.ok === false && r2.code === 'reject', JSON.stringify(r2));
  s.close();

  /* 未加密（plain）模式：老设备不收加密报文时使用 */
  const s2 = await tacacsServer({ user: 'carol', password: 'plain@1', secret: 'k2' });
  const r3 = await P.tacacsAuth(T, { host: '127.0.0.1', port: s2.port, secret: 'k2', plain: '1' }, 'carol', 'plain@1');
  check('TACACS+ 未加密模式同样可用', r3.ok === true, JSON.stringify(r3));
  s2.close();
}

/* ---------------- 4. LDAP ---------------- */
function berRead(buf, i) {
  const tag = buf[i++];
  let len = buf[i++];
  if (len & 0x80) {
    const n = len & 0x7f; len = 0;
    for (let k = 0; k < n; k++) len = (len << 8) | buf[i++];
  }
  return { tag, len, start: i, end: i + len };
}
/* 假 LDAP 服务器：支持两种模式
   - 直接绑定：一次 bind（dn/密码须匹配 expectDn/password）
   - 服务账号模式：bind(svcDn/svcPassword) → search → 返回 entry+done；随后新连接 bind(expectDn) */
function ldapServer(opts) {
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    const pending = [];                       /* 每条连接收到的完整报文 */
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1], hdr = 2;
        if (len & 0x80) {
          const n = len & 0x7f; len = 0; hdr = 2 + n;
          for (let k = 0; k < n; k++) len = (len << 8) | buf[2 + k];
        }
        if (buf.length < hdr + len) return;
        pending.push(buf.subarray(0, hdr + len));
        buf = buf.subarray(hdr + len);
        handle(pending[pending.length - 1]);
      }
    });
    function reply(msgId, opBuf) {
      /* 外层 SEQUENCE 长度 = messageID TLV(3 字节，id<128) + protocolOp 长度 */
      sock.write(Buffer.concat([Buffer.from([0x30, 3 + opBuf.length, 0x02, 0x01, msgId]), opBuf]));
    }
    function bindResp(rc) {
      return Buffer.from([0x61, 0x07, 0x0a, 0x01, rc, 0x04, 0x00, 0x04, 0x00]);
    }
    function opOf(msg) {
      const inner = msg.subarray(2);          /* 跳过 30 len */
      const msgId = inner[2];
      const op = berRead(inner, 2 + inner[1]);
      return { msgId, tag: op.tag, body: inner.subarray(op.start, op.end) };
    }
    function handle(msg) {
      const { msgId, tag, body } = opOf(msg);
      if (tag === 0x60) {                     /* BindRequest */
        const ver = berRead(body, 0);
        const dn = berRead(body, ver.end);
        const pw = berRead(body, dn.end);
        const dnStr = body.subarray(dn.start, dn.end).toString('utf8');
        const pwStr = body.subarray(pw.start, pw.end).toString('utf8');
        if (opts.svcDn && dnStr === opts.svcDn) {
          reply(msgId, bindResp(pwStr === opts.svcPassword ? 0 : 49));
          return;
        }
        const ok = dnStr === opts.expectDn && pwStr === opts.password && pw.tag === 0x80;
        reply(msgId, bindResp(ok ? 0 : (dnStr === opts.expectDn ? 49 : 32)));
        return;
      }
      if (tag === 0x63) {                     /* SearchRequest */
        let i = 0;
        const base = berRead(body, i); i = base.end;
        i += 2 + body[i + 1];                 /* scope */
        i += 2 + body[i + 1];                 /* derefAliases */
        i += 2 + body[i + 1];                 /* sizeLimit */
        i += 2 + body[i + 1];                 /* timeLimit */
        i += 2 + body[i + 1];                 /* typesOnly */
        const f = berRead(body, i);           /* 0xa3 equalityMatch */
        const fBody = body.subarray(f.start, f.end);
        const a = berRead(fBody, 0);
        const v = berRead(fBody, a.end);
        const attr = fBody.subarray(a.start, a.end).toString('utf8');
        const val = fBody.subarray(v.start, v.end).toString('utf8');
        if (attr !== opts.filterAttr || val !== opts.filterValue) {
          reply(msgId, Buffer.from([0x65, 0x07, 0x0a, 0x01, 32, 0x04, 0x00, 0x04, 0x00]));
          return;
        }
        const dnB = Buffer.from(opts.expectDn, 'utf8');
        reply(msgId, Buffer.concat([
          Buffer.from([0x64, 2 + dnB.length + 2, 0x04, dnB.length]), dnB, Buffer.from([0x30, 0x00])
        ]));
        reply(msgId, Buffer.from([0x65, 0x07, 0x0a, 0x01, 0, 0x04, 0x00, 0x04, 0x00]));
        return;
      }
    }
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({
    port: srv.address().port, close: () => srv.close()
  })));
}

{
  const s = await ldapServer({ expectDn: 'uid=dave,ou=people,dc=corp,dc=local', password: 'Ldap@123' });
  const r1 = await P.ldapAuth(T,
    { host: '127.0.0.1', port: s.port, bindPattern: 'uid={user},ou=people,dc=corp,dc=local' }, 'dave', 'Ldap@123');
  check('LDAP 正确口令 → 通过', r1.ok === true, JSON.stringify(r1));
  const r2 = await P.ldapAuth(T,
    { host: '127.0.0.1', port: s.port, bindPattern: 'uid={user},ou=people,dc=corp,dc=local' }, 'dave', 'bad');
  check('LDAP 错误口令 → 拒绝(结果码 49)', r2.ok === false && r2.code === 'reject', JSON.stringify(r2));
  const r3 = await P.ldapAuth(T,
    { host: '127.0.0.1', port: s.port, bindPattern: 'uid={user},ou=people,dc=corp,dc=local' }, 'dave', '');
  check('LDAP 空口令 → 本地拦掉（防匿名绑定）', r3.ok === false && r3.code === 'reject', JSON.stringify(r3));
  s.close();
}

check('LDAP 绑定模板替换 {user}', P.ldapBindDn({ bindPattern: 'uid={user},dc=x' }, 'amy') === 'uid=amy,dc=x');
check('LDAP 绑定模板替换 {username}', P.ldapBindDn({ bindPattern: '{username}@corp.local' }, 'amy') === 'amy@corp.local');
check('LDAP 无模板时按 userAttr+baseDn 拼接',
  P.ldapBindDn({ userAttr: 'cn', baseDn: 'ou=staff,dc=x' }, 'amy') === 'cn=amy,ou=staff,dc=x');
check('LDAP 缺省模板即直接用登录名', P.ldapBindDn({}, 'amy') === 'amy');

/* ---- LDAP 服务账号模式：bind(服务账号) → search → bind(用户 DN) ---- */
{
  const s = await ldapServer({
    expectDn: 'cn= exterior,ou=external,dc=zdns,dc=com',
    password: 'User@123',
    svcDn: 'cn=admin,dc=zdns,dc=com',
    svcPassword: 'Svc@456',
    filterAttr: 'cn',
    filterValue: 'ext01'
  });
  const cfg = {
    host: '127.0.0.1', port: s.port,
    bindDn: 'cn=admin,dc=zdns,dc=com', bindPassword: 'Svc@456',
    baseDn: 'ou=external,dc=zdns,dc=com', userAttr: 'cn'
  };
  const r1 = await P.ldapAuth(T, cfg, 'ext01', 'User@123');
  check('LDAP 服务账号模式：搜索命中且口令正确 → 通过', r1.ok === true, JSON.stringify(r1));
  const r2 = await P.ldapAuth(T, cfg, 'ext01', 'wrong');
  check('LDAP 服务账号模式：用户口令错误 → 拒绝', r2.ok === false && r2.code === 'reject', JSON.stringify(r2));
  const r3 = await P.ldapAuth(T, cfg, 'nobody', 'User@123');
  check('LDAP 服务账号模式：目录无此用户 → nouser', r3.ok === false && r3.code === 'nouser', JSON.stringify(r3));
  const r4 = await P.ldapAuth(T, Object.assign({}, cfg, { bindPassword: 'bad' }), 'ext01', 'User@123');
  check('LDAP 服务账号模式：服务账号密码错误 → bindfail', r4.ok === false && r4.code === 'bindfail', JSON.stringify(r4));
  const r5 = await P.ldapAuth(T, Object.assign({}, cfg, { baseDn: '' }), 'ext01', 'User@123');
  check('LDAP 服务账号模式：缺 Base DN → cfg 提示', r5.ok === false && r5.code === 'cfg', JSON.stringify(r5));
  s.close();
}

/* ---------------- 5. 分派与错误处理 ---------------- */
{
  const r = await P.authenticate(T, { type: 'nope', host: '127.0.0.1' }, 'x', 'y');
  check('未知认证类型 → 明确报错', r.ok === false && r.code === 'badtype');
  const r2 = await P.authenticate({}, { type: 'radius', host: '127.0.0.1' }, 'x', 'y');
  check('无 UDP 传输能力（Workers）→ 提示不支持', r2.ok === false && r2.code === 'unsupported');
  check('认证类型标签', P.authTypeLabel('radius') === 'RADIUS' && P.authTypeLabel('tacacs') === 'TACACS+' &&
    P.authTypeLabel('ldap') === 'LDAP' && P.authTypeLabel('') === '本地');
}

console.log('<<通过 ' + pass + ' / 共 ' + (pass + fail) + '>>');
process.exit(fail ? 1 : 0);
