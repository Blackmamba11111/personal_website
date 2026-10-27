/* ============================================================================
 * 远程认证协议实现（RADIUS / TACACS+ / LDAP）
 *
 * 设计：本文件只做「报文编解码 + 握手流程」，不含任何网络 API，
 * 传输层由宿主注入（transport），因此同一份代码可同时跑在两个运行时：
 *   · 内部部署（Node）：dgram 发 UDP、net/tls 建 TCP —— 三种协议全支持
 *   · Cloudflare Workers：只有 TCP（cloudflare:sockets），无 UDP —— RADIUS 不可用
 *
 * transport 契约：
 *   udp(host, port, bytes, timeoutMs) -> Promise<Uint8Array>
 *   tcp(host, port, { timeoutMs, tls, insecure }) -> Promise<{
 *       write(bytes): Promise<void>,
 *       read(n): Promise<Uint8Array>,   // 精确读 n 字节，不足则等待
 *       close(): void | Promise<void>
 *   }>
 *
 * 返回值统一为 { ok, code, message }：
 *   code 只是给管理员排障用的短标识（如 'timeout' / 'reject' / 'badsecret'），
 *   前端展示仍用统一话术，避免通过登录错误信息枚举账号或探测服务器。
 * ==========================================================================*/

/* ---------------- 通用工具 ---------------- */
function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') {
    const out = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v.charCodeAt(i) & 0xff;
    return out;
  }
  if (v && v.buffer) return new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength);
  return new Uint8Array(0);
}
function concat(list) {
  let n = 0;
  for (let i = 0; i < list.length; i++) n += list[i].length;
  const out = new Uint8Array(n);
  let off = 0;
  for (let i = 0; i < list.length; i++) { out.set(list[i], off); off += list[i].length; }
  return out;
}
function hex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
function randomBytes(n) {
  const a = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(a);
  else for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
  return a;
}
function cstr(s) { return toBytes(String(s == null ? '' : s)); }

/* ---------------- MD5（WebCrypto 不提供，自带一份） ---------------- */
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

function rotl(x, c) { return ((x << c) | (x >>> (32 - c))) >>> 0; }

export function md5(input) {
  const msg = toBytes(input);
  const total = (((msg.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const dv = new DataView(buf.buffer);
  const bits = msg.length * 8;
  dv.setUint32(total - 8, bits >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bits / 4294967296) >>> 0, true);

  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, MD5_S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return out;
}
export function md5Hex(input) { return hex(md5(input)); }

/* 定长比较，避免按字节提前返回泄露时序（密钥/摘要比对用） */
function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function timeoutOf(cfg, dft) {
  const n = Number(cfg && cfg.timeout);
  return (isFinite(n) && n > 0 ? Math.min(n, 30) : dft) * 1000;
}
function errText(e) {
  return e && e.message ? e.message : String(e || '未知错误');
}

/* ============================================================================
 * RADIUS（RFC 2865，PAP 认证：Access-Request → Access-Accept / Reject）
 * ==========================================================================*/
export const RADIUS_CODES = {
  1: 'Access-Request', 2: 'Access-Accept', 3: 'Access-Reject',
  11: 'Access-Challenge', 12: 'Status-Server', 13: 'Status-Client'
};

/* RFC 2865 §5.2：口令按 16 字节分组，与前一组密文链式异或 */
function radiusHidePassword(password, secret, requestAuth) {
  let pwd = cstr(password).slice(0, 128);
  const pad = (16 - (pwd.length % 16)) % 16;
  if (pad) pwd = concat([pwd, new Uint8Array(pad)]);
  if (!pwd.length) pwd = new Uint8Array(16);
  const out = new Uint8Array(pwd.length);
  let prev = requestAuth;
  for (let off = 0; off < pwd.length; off += 16) {
    const b = md5(concat([cstr(secret), prev]));
    for (let i = 0; i < 16; i++) out[off + i] = pwd[off + i] ^ b[i];
    prev = out.subarray(off, off + 16);
  }
  return out;
}

function radiusAttr(type, value) {
  const v = toBytes(value);
  const len = 2 + v.length;
  const out = new Uint8Array(len);
  out[0] = type; out[1] = len; out.set(v, 2);
  return out;
}

export async function radiusAuth(transport, cfg, username, password) {
  cfg = cfg || {};
  const secret = String(cfg.secret || '');
  if (!transport || !transport.udp) {
    return { ok: false, code: 'unsupported', message: '当前运行环境不支持 UDP（RADIUS 需要 UDP 出网）' };
  }
  const requestAuth = randomBytes(16);
  const ident = randomBytes(1)[0];
  const attrs = concat([
    radiusAttr(1, username),                                   /* User-Name */
    radiusAttr(2, radiusHidePassword(password, secret, requestAuth)), /* User-Password */
    radiusAttr(32, cfg.nasId || 'inspection-ledger')            /* NAS-Identifier */
  ]);
  const len = 20 + attrs.length;
  const pkt = new Uint8Array(len);
  pkt[0] = 1;                     /* Access-Request */
  pkt[1] = ident;
  pkt[2] = (len >> 8) & 0xff; pkt[3] = len & 0xff;
  pkt.set(requestAuth, 4);
  pkt.set(attrs, 20);

  let res;
  try {
    res = await transport.udp(cfg.host, Number(cfg.port) || 1812, pkt, timeoutOf(cfg, 5));
  } catch (e) {
    const msg = errText(e);
    return { ok: false, code: /timeout|timed out/i.test(msg) ? 'timeout' : 'neterr', message: '认证服务器无响应：' + msg };
  }
  if (!res || res.length < 20) return { ok: false, code: 'badreply', message: '认证服务器返回的数据长度不合法' };
  const code = res[0];
  const respLen = (res[2] << 8) | res[3];
  if (res[1] !== ident) return { ok: false, code: 'badreply', message: '响应标识与请求不匹配（可能是另一台设备/旧响应）' };
  if (respLen > res.length) return { ok: false, code: 'badreply', message: '认证服务器返回的数据被截断' };

  /* 校验 Response Authenticator：MD5(Code+ID+Len+RequestAuth+Attrs+Secret) */
  const body = res.slice(0, respLen);
  const forCalc = new Uint8Array(body);
  forCalc.set(requestAuth, 4);
  const expect = md5(concat([forCalc, cstr(secret)]));
  if (!safeEqual(expect, body.subarray(4, 20))) {
    return { ok: false, code: 'badsecret', message: '响应校验失败：共享密钥（secret）不一致或数据被篡改' };
  }
  if (code === 2) return { ok: true, code: 'accept', message: '认证通过' };
  if (code === 3) return { ok: false, code: 'reject', message: '认证被拒绝（用户名或密码不正确）' };
  if (code === 11) return { ok: false, code: 'challenge', message: '服务器要求二次挑战（Access-Challenge），本系统暂不支持' };
  return { ok: false, code: 'code' + code, message: '认证服务器返回未预期的响应码 ' + code };
}

/* ============================================================================
 * TACACS+（RFC 8907，AUTHEN / PAP）
 * ==========================================================================*/
const TAC_PLUS_AUTHEN = 0x01;
const TAC_PLUS_AUTHEN_LOGIN = 0x01;
const TAC_PLUS_AUTHEN_TYPE_PAP = 0x02;
const TAC_PLUS_AUTHEN_SVC_LOGIN = 0x01;
const TAC_STATUS = { 1: 'PASS', 2: 'FAIL', 3: 'GETDATA', 4: 'GETUSER', 5: 'ERROR', 6: 'FOLLOW', 7: 'RESTART' };

/* TACACS+ 报文混淆：以 session_id + key 为种子做 MD5 链，逐 16 字节异或。
   RFC 8907 §4.5：首块额外混入 version 与 seq_no。 */
function tacacsObfuscate(payload, key, sessionId, version, seqNo) {
  const sid = new Uint8Array([(sessionId >>> 24) & 255, (sessionId >>> 16) & 255, (sessionId >>> 8) & 255, sessionId & 255]);
  const k = cstr(key);
  let prev = md5(concat([sid, k, new Uint8Array([version, seqNo])]));
  const out = new Uint8Array(payload.length);
  for (let off = 0; off < payload.length; off += 16) {
    if (off > 0) prev = md5(concat([sid, k, prev]));
    const n = Math.min(16, payload.length - off);
    for (let i = 0; i < n; i++) out[off + i] = payload[off + i] ^ prev[i];
  }
  return out;
}

function tacacsHeader(seqNo, flags, sessionId, length) {
  const h = new Uint8Array(12);
  h[0] = 0xc0;                 /* version：major 12 / minor 0 */
  h[1] = TAC_PLUS_AUTHEN;
  h[2] = seqNo;
  h[3] = flags;
  h[4] = (sessionId >>> 24) & 255; h[5] = (sessionId >>> 16) & 255;
  h[6] = (sessionId >>> 8) & 255;  h[7] = sessionId & 255;
  h[8] = (length >>> 24) & 255; h[9] = (length >>> 16) & 255;
  h[10] = (length >>> 8) & 255; h[11] = length & 255;
  return h;
}
function u32(v) {
  const a = randomBytes(4);
  const n = ((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) >>> 0;
  return n || 1;
}

export async function tacacsAuth(transport, cfg, username, password) {
  cfg = cfg || {};
  if (!transport || !transport.tcp) {
    return { ok: false, code: 'unsupported', message: '当前运行环境不支持 TCP 出网' };
  }
  const secret = String(cfg.secret || '');
  const plain = String(cfg.plain) === '1' || cfg.plain === true;  /* 少数老设备不收加密报文 */
  const flags = plain ? 0x01 : 0x00;
  const sessionId = u32();
  const u = cstr(username).slice(0, 255);
  const p = cstr(password).slice(0, 255);
  const port = cstr(cfg.portName || '').slice(0, 255);
  const rem = cstr(cfg.remAddr || '').slice(0, 255);

  /* AUTHEN START（PAP：口令直接放在 data 字段） */
  const body = concat([
    new Uint8Array([TAC_PLUS_AUTHEN_LOGIN, 0x01, TAC_PLUS_AUTHEN_TYPE_PAP, TAC_PLUS_AUTHEN_SVC_LOGIN,
      u.length, port.length, rem.length, p.length]),
    u, port, rem, p
  ]);
  const wire = concat([tacacsHeader(1, flags, sessionId, body.length),
    plain ? body : tacacsObfuscate(body, secret, sessionId, 0xc0, 1)]);

  let sock = null;
  try {
    sock = await transport.tcp(cfg.host, Number(cfg.port) || 49, { timeoutMs: timeoutOf(cfg, 5) });
    await sock.write(wire);
    const head = await sock.read(12);
    if (head[0] !== 0xc0) return { ok: false, code: 'badreply', message: 'TACACS+ 响应版本不符（可能不是 TACACS+ 服务）' };
    if (head[1] !== TAC_PLUS_AUTHEN) return { ok: false, code: 'badreply', message: 'TACACS+ 响应类型不符' };
    const len = ((head[8] << 24) | (head[9] << 16) | (head[10] << 8) | head[11]) >>> 0;
    if (len > 65535) return { ok: false, code: 'badreply', message: 'TACACS+ 响应长度异常' };
    const respFlags = head[3];
    const sid = ((head[4] << 24) | (head[5] << 16) | (head[6] << 8) | head[7]) >>> 0;
    if (sid !== sessionId) return { ok: false, code: 'badreply', message: 'TACACS+ 会话号不匹配' };
    let payload = len ? await sock.read(len) : new Uint8Array(0);
    if (!(respFlags & 0x01)) payload = tacacsObfuscate(payload, secret, sessionId, head[0], head[2]);
    if (payload.length < 6) return { ok: false, code: 'badreply', message: 'TACACS+ 响应体不完整' };
    const status = payload[0];
    const msgLen = (payload[2] << 8) | payload[3];
    const msg = msgLen ? String.fromCharCode.apply(null, payload.slice(6, 6 + msgLen)) : '';
    if (status === 1) return { ok: true, code: 'accept', message: msg || '认证通过' };
    if (status === 2) return { ok: false, code: 'reject', message: msg || '认证被拒绝（用户名或密码不正确）' };
    return {
      ok: false, code: 'status' + status,
      message: '认证未完成：' + (TAC_STATUS[status] || ('status=' + status)) + (msg ? '（' + msg + '）' : '')
    };
  } catch (e) {
    const msg = errText(e);
    return { ok: false, code: /timeout|timed out/i.test(msg) ? 'timeout' : 'neterr', message: '认证服务器无响应：' + msg };
  } finally {
    if (sock) { try { await sock.close(); } catch (e) {} }
  }
}

/* ============================================================================
 * LDAP（RFC 4511，simple bind）
 * ==========================================================================*/
function berLen(n) {
  if (n < 128) return new Uint8Array([n]);
  const parts = [];
  let v = n;
  while (v > 0) { parts.unshift(v & 0xff); v >>= 8; }
  return new Uint8Array([0x80 | parts.length].concat(parts));
}
function tlv(tag, content) {
  return concat([new Uint8Array([tag]), berLen(content.length), content]);
}
function ldapStr(tag, s) { return tlv(tag, cstr(s)); }

/* 按模板拼绑定 DN：{user} 会被替换为登录名。企业 AD 常用 user@domain /
   DOMAIN\\user 形式，此时模板直接写 {user} 即可。 */
export function ldapBindDn(cfg, username) {
  cfg = cfg || {};
  const tpl = String(cfg.bindPattern || '');
  if (tpl) {
    if (tpl.indexOf('{user}') >= 0 || tpl.indexOf('{username}') >= 0) {
      return tpl.replace(/\{user(name)?\}/g, username);
    }
    return tpl;                       /* 模板里没有占位符：原样使用（如固定测试账号） */
  }
  const base = String(cfg.baseDn || '');
  if (base) return String(cfg.userAttr || 'uid') + '=' + username + ',' + base;
  return username;                    /* 缺省：登录名直接当 DN（AD 的 UPN / DOMAIN\\user 场景） */
}

/* ---------------- 报文构造与解析（messageID 递增，支持绑定+搜索两次交互） ---------------- */
function intBytes(n) {
  return n < 128 ? new Uint8Array([n]) : new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

/* 读取一条完整 LDAPMessage，返回 { tag, content }（content 为 protocolOp 的内容区） */
async function readLdapMsg(sock) {
  const head = await sock.read(2);
  if (head[0] !== 0x30) throw new Error('LDAP 响应不是 SEQUENCE（可能不是 LDAP 服务）');
  let len = head[1];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4) throw new Error('LDAP 响应长度字段异常');
    const lb = await sock.read(n);
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | lb[i];
  }
  const payload = len ? await sock.read(len) : new Uint8Array(0);
  if (!payload.length || payload[0] !== 0x02) throw new Error('LDAP 响应结构异常（缺少 messageID）');
  let i = 2 + payload[1];
  if (i >= payload.length) throw new Error('LDAP 响应缺少 protocolOp');
  const tag = payload[i];
  let opLen = payload[i + 1], j = i + 2;
  if (opLen & 0x80) {
    const n = opLen & 0x7f;
    opLen = 0;
    for (let k = 0; k < n; k++) opLen = (opLen << 8) | payload[j++];
  }
  return { tag: tag, content: payload.subarray(j, j + opLen) };
}

function bindMsg(id, dn, pwd) {
  return tlv(0x30, concat([
    tlv(0x02, intBytes(id)),
    tlv(0x60, concat([
      tlv(0x02, new Uint8Array([0x03])),   /* version 3 */
      ldapStr(0x04, dn),
      tlv(0x80, cstr(pwd))                 /* authentication: simple */
    ]))
  ]));
}

/* SearchRequest：全子树、只要命中一条、不返回属性（只需要 DN） */
function searchMsg(id, base, attr, value, timeLimit) {
  const filter = tlv(0xa3, concat([ldapStr(0x04, attr), ldapStr(0x04, value)]));
  return tlv(0x30, concat([
    tlv(0x02, intBytes(id)),
    tlv(0x63, concat([
      ldapStr(0x04, base),
      tlv(0x0a, new Uint8Array([0x02])),        /* scope: wholeSubtree */
      tlv(0x0a, new Uint8Array([0x00])),        /* derefAliases: never */
      tlv(0x02, new Uint8Array([0x01])),        /* sizeLimit: 1 */
      tlv(0x02, intBytes(timeLimit || 5)),      /* timeLimit(秒) */
      tlv(0x01, new Uint8Array([0x00])),        /* typesOnly: false */
      filter,
      tlv(0x30, new Uint8Array(0))              /* attributes: 空 */
    ]))
  ]));
}

/* BindResponse / SearchResultDone 的内容区第一个 TLV 就是 ENUMERATED 结果码 */
function resultCodeOf(msg) {
  if (msg.content[0] !== 0x0a) return null;
  return msg.content[2];
}

/* SearchResEntry 内容区第一个 TLV 是 objectName（LDAPDN） */
function entryDnOf(msg) {
  if (msg.content[0] !== 0x04) return '';
  let len = msg.content[1], j = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let k = 0; k < n; k++) len = (len << 8) | msg.content[j++];
  }
  return new TextDecoder().decode(msg.content.subarray(j, j + len));
}

async function bindOnce(sock, id, dn, pwd) {
  await sock.write(bindMsg(id, dn, pwd));
  return resultCodeOf(await readLdapMsg(sock));
}

function bindResult(rc) {
  if (rc === 0) return { ok: true, code: 'accept', message: '认证通过' };
  if (rc === 49) return { ok: false, code: 'reject', message: '认证被拒绝（用户名或密码不正确）' };
  if (rc === 32) return { ok: false, code: 'nouser', message: '绑定 DN 不存在（结果码 32）：请检查绑定模板' };
  if (rc === 53) return { ok: false, code: 'unwilling', message: '服务器拒绝绑定（结果码 53），可能账号被锁或不允许该方式登录' };
  return { ok: false, code: 'rc' + rc, message: 'LDAP 返回结果码 ' + rc };
}

export async function ldapAuth(transport, cfg, username, password) {
  cfg = cfg || {};
  if (!transport || !transport.tcp) {
    return { ok: false, code: 'unsupported', message: '当前运行环境不支持 TCP 出网' };
  }
  if (!String(password || '').length) {
    /* 空口令的 simple bind 在 LDAP 里等价于匿名绑定，多数服务器会返回成功，
       必须本地拦掉，否则任何空密码都能登录。 */
    return { ok: false, code: 'reject', message: 'LDAP 认证不接受空口令' };
  }
  const port = Number(cfg.port) || (cfg.tls ? 636 : 389);
  const connect = function () {
    return transport.tcp(cfg.host, port, {
      timeoutMs: timeoutOf(cfg, 5), tls: !!cfg.tls, insecure: cfg.verifyTls !== true
    });
  };
  const svcDn = String(cfg.bindDn || '').trim();
  const svcPwd = String(cfg.bindPassword || '');

  try {
    if (svcDn && svcPwd) {
      /* 服务账号模式（OpenLDAP 常见）：先绑服务账号 → 搜出用户 DN → 换连接用用户口令绑定。
         两个 bind 用不同连接，避免共享同一会话时的状态残留。 */
      let sock = await connect();
      let userDn = '';
      try {
        const rc = await bindOnce(sock, 1, svcDn, svcPwd);
        if (rc === 49) return { ok: false, code: 'bindfail', message: '服务账号绑定被拒绝：请检查 Bind DN 与 Bind 密码' };
        if (rc === 53) return { ok: false, code: 'bindfail', message: '服务账号被服务器拒绝（结果码 53），可能该账号不允许此方式登录' };
        if (rc !== 0) return { ok: false, code: 'bindfail', message: '服务账号绑定失败（结果码 ' + rc + '）' };
        const base = String(cfg.baseDn || '').trim();
        if (!base) return { ok: false, code: 'cfg', message: '使用服务账号模式需要同时填写 Base DN' };
        const attr = String(cfg.userAttr || 'uid');
        await sock.write(searchMsg(2, base, attr, username, timeoutOf(cfg, 5)));
        for (;;) {
          const m = await readLdapMsg(sock);
          if (m.tag === 0x64 && !userDn) userDn = entryDnOf(m);   /* SearchResEntry */
          else if (m.tag === 0x65) {                              /* SearchResultDone */
            const rc2 = resultCodeOf(m);
            if (rc2 === 32) return { ok: false, code: 'nouser', message: '目录中未找到该用户：请检查 Base DN 与用户属性（' + attr + '）' };
            if (rc2 !== 0) return { ok: false, code: 'rc' + rc2, message: 'LDAP 搜索失败（结果码 ' + rc2 + '）' };
            break;
          }
          /* 其它 tag（延续引用等）忽略，继续读 */
        }
      } finally {
        try { await sock.close(); } catch (e) {}
      }
      if (!userDn) return { ok: false, code: 'nouser', message: '目录中未找到该用户：请检查 Base DN 与用户属性' };

      sock = await connect();
      try {
        return bindResult(await bindOnce(sock, 1, userDn, password));
      } finally {
        try { await sock.close(); } catch (e) {}
      }
    }

    /* 直接绑定模式：登录名按模板拼成 DN，一次绑定完成认证 */
    let sock = await connect();
    try {
      return bindResult(await bindOnce(sock, 1, ldapBindDn(cfg, username), password));
    } finally {
      try { await sock.close(); } catch (e) {}
    }
  } catch (e) {
    const msg = errText(e);
    return { ok: false, code: /timeout|timed out/i.test(msg) ? 'timeout' : 'neterr', message: '认证服务器无响应：' + msg };
  }
}

/* ---------------- 统一入口 ---------------- */
export const AUTH_TYPES = ['radius', 'tacacs', 'ldap'];

export function authTypeLabel(t) {
  if (t === 'radius') return 'RADIUS';
  if (t === 'tacacs') return 'TACACS+';
  if (t === 'ldap') return 'LDAP';
  return '本地';
}

export async function authenticate(transport, server, username, password) {
  const type = String((server && server.type) || '');
  const cfg = Object.assign({}, (server && server.cfg) || {});
  if (server && server.host) cfg.host = server.host;
  if (server && server.port) cfg.port = server.port;
  if (type === 'radius') return radiusAuth(transport, cfg, username, password);
  if (type === 'tacacs') return tacacsAuth(transport, cfg, username, password);
  if (type === 'ldap') return ldapAuth(transport, cfg, username, password);
  return { ok: false, code: 'badtype', message: '不支持的认证类型：' + (type || '(空)') };
}
