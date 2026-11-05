/* ============================================================================
 * 询盘云 CRM（销售易）对接客户端 —— 登录 + 商机检索 + 维保明细 + 客户匹配
 *
 * 设计（与 auth-protocols.mjs 同思路：一份代码跑两个运行时）：
 *   · 内部部署（Node）：server.js 动态 import 本文件（deploy.sh 会拷到同级）
 *   · Cloudflare Workers：ESM import 本文件
 *   · 网络层由宿主注入 fetchImpl（签名同 fetch），便于测试注入 mock
 *
 * 认证方式（2026-11-05 逆向销售易登录页确认）：
 *   1. GET  {auc}/auc/passport/password-key        → { scode:"200", result: RSA公钥 }
 *   2. RSA PKCS1-v1.5 加密密码（与 JSEncrypt 兼容，纯 BigInt 实现）
 *   3. POST {auc}/auc/login {login_name, password, NECaptchaValidate:null, ...}
 *   4. 跟随重定向（收集 Set-Cookie）直至 crm 域 → 会话 cookie
 *   之后业务接口带 cookie + xsy-* 头（值从 cookie 解析，实测校准）。
 *
 * 业务接口（2026-11-05 网页登录态验证过的路径）：
 *   · 商机列表  POST {crm}/rest/bff/v3.0/neoui/table/search?entityApiKey=opportunity&skipTotalSize=true
 *     body { maxDisplayCount, dataView:"opportunity_view_225"(所有技术专用项目),
 *            conditions:[], page:{pageNo,pageSize}, sort:[{createdAt desc}] }
 *     注意：conditions 实测被忽略，只能全量分页拉取后本地过滤。
 *   · 字段映射  GET  {crm}/rest/bff/v3.0/neoui/table/initData1?...objectApiKey=opportunity
 *     data.items: [{apiKey, label, type}] → customItemXXX__c 翻译成中文标签
 *   · 维保明细  POST {crm}/rest/neobi/v2.0/query/query?avatarViewId=3439246815003399
 *     form-urlencoded: viewId=3439246815003399&filter={...}，
 *     filter.board.filter[0].value[0].val = 商机 recordId（模板替换），
 *     响应是 NeoBI cells [{type,row,col,value}]（type=1 为表头）。
 *
 * 返回值统一 { ok, code, message }：code 供前端排障展示，message 人类可读。
 * ==========================================================================*/

export const XSY_HOSTS = {
  auc: 'https://login.xiaoshouyi.com',
  crm: 'https://crm-tencent.xiaoshouyi.com',
};

/* 销售易登录返回码（取自前端 login chunk 常量表，2026-11-05） */
const CRM_SCODE = {
  '2030001': '账号或密码错误',
  '2030002': '账号或密码错误',
  '2030003': '账号或密码错误',
  '2030008': '用户名或密码不正确',
  '2030007': '需要输入验证码',
  '2030013': '密码已过期，请先在网页端修改',
  '2030014': '账号已被锁定，请在网页端解锁',
  '2030028': '首次登录需先重置密码',
  '2030029': '首次登录需先重置密码',
  '2030030': '首次登录需先重置密码',
  '2030031': '首次登录需先重置密码',
  '2030034': '首次登录需先在网页端完成初始化',
  '2030063': '账号状态异常，请先在网页端登录处理',
  '2030072': '登录会话已失效（需先建立租户上下文，请重试）',
  '2030105': '密码已过期，请先在网页端修改',
  '1030010': '需要先同意隐私协议，请在网页端登录一次',
};

/* 维保明细 NeoBI 视图（“设备维保明细表”，2026-11-05 抓包确认，替换 recordId 复用模板） */
const WB_VIEW_ID = '3439246815003399';
const WB_TEMPLATE = {
  url: XSY_HOSTS.crm + '/rest/neobi/v2.0/query/query?avatarViewId=' + WB_VIEW_ID + '&avatarLayoutId=unknown&avatarBizType=unknown',
  /* 视图层固定过滤条件与 board 拼装见 buildWbFilter；此模板来自线上抓包 */
};

const WB_VIEW_FIXED_FILTER = [
  { modelKey: 'customEntity98__c', serialNo: 1, modelType: null, fieldKey: 'customItem2__c', type: 'text', udfId: null, hierarchyLevel: null, seq: '1', udfField: null, optionType: null, currencyOption: null, funType: null, pattern: null, udfType: null, operate: 'ex', value: [], timeType: null, formula: null, entityOnlyFilter: 0, transferSQL: null, excludeEmptyString: 1, includeNullValue: null, momYoY: null, timezone: null, langCode: null, moM: null, yoY: null },
  { modelKey: 'quoteLine', serialNo: 1, modelType: null, fieldKey: 'customItem36__c', type: 'text', udfId: null, hierarchyLevel: null, seq: '2', udfField: null, optionType: null, currencyOption: null, funType: null, pattern: null, udfType: null, operate: 'ex', value: [], timeType: null, formula: null, entityOnlyFilter: 0, transferSQL: null, excludeEmptyString: 1, includeNullValue: null, momYoY: null, timezone: null, langCode: null, moM: null, yoY: null },
  { modelKey: 'quoteLine', serialNo: 1, modelType: null, fieldKey: 'customItem7__c', type: 'text', udfId: null, hierarchyLevel: null, seq: '3', udfField: null, optionType: null, currencyOption: null, funType: null, pattern: null, udfType: null, operate: 'ex', value: [], timeType: null, formula: null, entityOnlyFilter: 0, transferSQL: null, excludeEmptyString: 1, includeNullValue: null, momYoY: null, timezone: null, langCode: null, moM: null, yoY: null },
  { modelKey: 'quoteLine', serialNo: 1, modelType: null, fieldKey: 'customItem9__c', type: 'text', udfId: null, hierarchyLevel: null, seq: '4', udfField: null, optionType: null, currencyOption: null, funType: null, pattern: null, udfType: null, operate: 'ex', value: [], timeType: null, formula: null, entityOnlyFilter: 0, transferSQL: null, excludeEmptyString: 1, includeNullValue: null, momYoY: null, timezone: null, langCode: null, moM: null, yoY: null },
  { modelKey: 'quoteLine', serialNo: 1, modelType: null, fieldKey: 'customItem10__c', type: 'text', udfId: null, hierarchyLevel: null, seq: '5', udfField: null, optionType: null, currencyOption: null, funType: null, pattern: null, udfType: null, operate: 'ex', value: [], timeType: null, formula: null, entityOnlyFilter: 0, transferSQL: null, excludeEmptyString: 1, includeNullValue: null, momYoY: null, timezone: null, langCode: null, moM: null, yoY: null },
  { modelKey: 'quoteLine', serialNo: 1, modelType: null, fieldKey: 'customItem11__c', type: 'text', udfId: null, hierarchyLevel: null, seq: '6', udfField: null, optionType: null, currencyOption: null, funType: null, pattern: null, udfType: null, operate: 'ex', value: [], timeType: null, formula: null, entityOnlyFilter: 0, transferSQL: null, excludeEmptyString: 1, includeNullValue: null, momYoY: null, timezone: null, langCode: null, moM: null, yoY: null },
];

function buildWbFilter(recordId) {
  return {
    board: {
      filter: [{ modelKey: 'account', serialNo: 1, fieldKey: 'customItem287__c', type: 'refer', fieldName: '技术项目', views: [Number(WB_VIEW_ID)], operate: 'eq', value: [{ val: Number(recordId) }] }],
      relation: '1',
    },
    view: { hrelation: null, relation: '1 and 2 and 3 and 4 and 5 and 6', filter: WB_VIEW_FIXED_FILTER },
  };
}

/* ---------------- RSA PKCS1-v1_5（纯 BigInt，与 JSEncrypt 兼容） ---------------- */

function b64ToBytes(b64) {
  const tbl = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
  let bits = 0, acc = 0;
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '=') break;
    const v = tbl.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

function bytesToB64(bytes) {
  const tbl = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += tbl[b0 >> 2] + tbl[((b0 & 3) << 4) | ((b1 == null ? 0 : b1) >> 4)];
    out += b1 == null ? '=' : tbl[((b1 & 15) << 2) | ((b2 == null ? 0 : b2) >> 6)];
    out += b2 == null ? '=' : tbl[b2 & 63];
  }
  return out;
}

function utf8Bytes(str) {
  return new TextEncoder().encode(String(str));
}

/* 读一个 DER TLV 头，返回内容区间（不含 tag/长度字节） */
function derNode(der, pos) {
  if (pos >= der.length) throw new Error('公钥 DER 越界');
  const tag = der[pos];
  let i = pos + 1;
  if (i >= der.length) throw new Error('公钥 DER 截断');
  let len = der[i++];
  if (len & 0x80) {
    const cnt = len & 0x7f;
    if (cnt === 0 || cnt > 4) throw new Error('公钥 DER 长度字段非法');
    len = 0;
    for (let k = 0; k < cnt; k++) { len = (len << 8) | der[i++]; }
  }
  if (i + len > der.length) throw new Error('公钥 DER 长度越界');
  return { tag: tag, start: i, len: len, end: i + len };
}

function derIntToBig(der, node) {
  let v = 0n;
  for (let k = 0; k < node.len; k++) v = (v << 8n) | BigInt(der[node.start + k]);
  return v;
}

/* 解析公钥：支持
 *   · 裸 base64 DER（销售易 /auc/passport/password-key 返回的就是这种）
 *   · PEM（带 ----BEGIN PUBLIC KEY---- 头）
 *   · 裸 hex 模数（JSEncrypt 的另一种写法，指数默认 65537）
 * 结构两种：
 *   SubjectPublicKeyInfo: SEQ{ SEQ{OID, NULL}, BITSTRING(0x00 || SEQ{INT n, INT e}) }
 *   PKCS#1 RSAPublicKey:  SEQ{ INT n, INT e }
 */
function parseRsaKey(keyRaw) {
  if (keyRaw && typeof keyRaw === 'object') {
    /* 兜底：直接传了接口原始 result 对象 */
    keyRaw = keyRaw.key || keyRaw.publicKey || '';
  }
  const s = String(keyRaw || '').trim();
  if (!s) throw new Error('公钥内容为空');
  if (/^[0-9a-fA-F]{128,}$/.test(s)) return { n: BigInt('0x' + s), e: 65537n };

  let der;
  try {
    der = b64ToBytes(s.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
  } catch (e) {
    throw new Error('公钥不是合法的 Base64 编码');
  }
  if (!der.length) throw new Error('公钥内容为空');
  if (der[0] !== 0x30) throw new Error('公钥不是有效的 ASN.1 结构（首字节 0x' + der[0].toString(16) + '）');

  const top = derNode(der, 0);
  const first = derNode(der, top.start);
  if (first.tag === 0x02) {
    /* 裸 PKCS#1 */
    const eNode = derNode(der, first.end);
    if (eNode.tag !== 0x02) throw new Error('公钥缺少 RSA 公钥指数');
    return { n: derIntToBig(der, first), e: derIntToBig(der, eNode) };
  }
  if (first.tag === 0x30) {
    /* X.509：跳过 AlgorithmIdentifier，取 BIT STRING，再剥掉 unused-bits 字节 */
    const bits = derNode(der, first.end);
    if (bits.tag !== 0x03) throw new Error('公钥 ASN.1 结构异常：缺少 BIT STRING');
    if (!bits.len) throw new Error('公钥 BIT STRING 为空');
    const inner = derNode(der, bits.start + 1);
    if (inner.tag !== 0x30) throw new Error('公钥 ASN.1 结构异常：BIT STRING 内不是 SEQUENCE');
    const nNode = derNode(der, inner.start);
    if (nNode.tag !== 0x02) throw new Error('公钥缺少 RSA 模数');
    const eNode = derNode(der, nNode.end);
    if (eNode.tag !== 0x02) throw new Error('公钥缺少 RSA 公钥指数');
    return { n: derIntToBig(der, nNode), e: derIntToBig(der, eNode) };
  }
  throw new Error('公钥 ASN.1 结构无法识别（tag 0x' + first.tag.toString(16) + '）');
}

function rsaEncrypt(keyRaw, text) {
  const { n, e } = parseRsaKey(keyRaw);
  const k = (n.toString(2).length + 7) >> 3;          /* 模数字节长 */
  const data = utf8Bytes(text);
  if (data.length > k - 11) throw new Error('待加密内容超出 RSA 长度限制');
  /* EME-PKCS1-v1_5: 0x00 0x02 PS(≥8字节非零) 0x00 D */
  const em = new Uint8Array(k);
  em[0] = 0; em[1] = 2;
  for (let i = 2; i < k - data.length - 1; i++) {
    let b = 0;
    while (b === 0) b = Math.floor(Math.random() * 256);
    em[i] = b;
  }
  em[k - data.length - 1] = 0;
  em.set(data, k - data.length);
  let m = 0n;
  for (let i = 0; i < k; i++) m = (m << 8n) | BigInt(em[i]);
  /* modpow(m, e, n) */
  let result = 1n;
  let base = m % n;
  let exp = e;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % n;
    base = (base * base) % n;
    exp >>= 1n;
  }
  const out = new Uint8Array(k);
  for (let i = k - 1; i >= 0; i--) { out[i] = Number(result & 0xffn); result >>= 8n; }
  return bytesToB64(out);
}

/* ---------------- Cookie jar ---------------- */

function cookieFromSetCk(setCkList) {
  /* set-cookie 可能为数组或逗号拼接字符串（取分号前段即可，忽略属性） */
  const jar = {};
  const flat = [];
  if (typeof setCkList === 'string') flat.push(setCkList);
  else if (Array.isArray(setCkList)) flat.push.apply(flat, setCkList);
  else if (setCkList) Object.keys(setCkList).forEach(function (k) { flat.push(k + '=' + setCkList[k]); });
  flat.forEach(function (line) {
    String(line).split(/,(?=[^;]+?=)/).forEach(function (one) {
      const m = /^([^=;,\s]+)=([^;]*)/.exec(String(one).trim());
      if (m) jar[m[1]] = m[2];
    });
  });
  return jar;
}

function mergeCookie(jar, setCk) {
  const add = cookieFromSetCk(setCk);
  Object.keys(add).forEach(function (k) { jar[k] = add[k]; });
}

function cookieHeader(jar) {
  return Object.keys(jar).map(function (k) { return k + '=' + jar[k]; }).join('; ');
}

/* ---------------- 会话请求包装 ---------------- */

function xsyHeaders(session, extra) {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (session && session.userId) h['xsy-user-id'] = String(session.userId);
  if (session && session.tenantId) h['xsy-tenant-id'] = String(session.tenantId);
  h['xsy-client-type'] = 'neoweb';
  if (session && session.cookies) h['Cookie'] = cookieHeader(session.cookies);
  if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
  return h;
}

function err(code, message) {
  return { ok: false, code: code, message: message };
}

/* ---------------- 登录 ---------------- */
/*
 * 返回 { ok, session, code, message }
 * session = { cookies:{}, userId, tenantId }
 */
export async function xsyLogin(opts, deps) {
  const fetchImpl = (deps && deps.fetchImpl) || fetch;
  const auc = (deps && deps.aucBase) || XSY_HOSTS.auc;
  const log = (deps && deps.log) || function () {};
  const jar = {};

  const jarFetch = function (url, init, host) {
    const headers = Object.assign({}, init.headers || {});
    headers['Cookie'] = cookieHeader(jar);
    return fetchImpl(url, Object.assign({}, init, { headers: headers, redirect: 'manual' })).then(function (resp) {
      mergeCookie(jar, resp.headers && resp.headers.getSetCookie ? resp.headers.getSetCookie() : (resp.headers && resp.headers.get && resp.headers.get('set-cookie')));
      return resp;
    });
  };

  try {
    /* 0. 先打开租户登录入口，收集租户上下文 cookie。
       实测（2026-11-05）：直接打 /auc/login 只带 password-key 的会话，
       密码校验通过后会回 2030072「长时间未操作，请刷新重试」——
       因为缺少 /global/login.action → /neologin/skip/... → /auc/oauth2/auth
       这条链下发的 SESSION / AUC_SESSION / auc-sso-oauth-context / x-ienterprise-tenant。 */
    log('crm: 打开登录入口，建立租户上下文');
    let entryUrl = ((deps && deps.crmBase) || XSY_HOSTS.crm) + '/global/login.action';
    let loginPage = '';
    let hops0 = 0;
    while (entryUrl && hops0 < 6) {
      const er = await jarFetch(entryUrl, { method: 'GET', headers: { 'Accept': 'text/html,application/xhtml+xml' } });
      loginPage = entryUrl;
      const loc = er.headers && er.headers.get && er.headers.get('location');
      if (er.status >= 300 && er.status < 400 && loc) {
        entryUrl = loc.startsWith('http') ? loc : new URL(loc, entryUrl).toString();
        hops0++;
        continue;
      }
      entryUrl = null;
    }
    if (!jar['auc-sso-oauth-context']) {
      log('crm: 警告 —— 未取到 auc-sso-oauth-context，登录可能被判会话失效');
    }

    /* 1. 公钥 */
    log('crm: 拉取登录公钥');
    const kr = await jarFetch(auc + '/auc/passport/password-key', { method: 'GET' });
    let kj = {};
    try { kj = await kr.json(); } catch (_) { kj = {}; }
    if (String(kj.scode) !== '200' || !kj.result) {
      return err('pwdkey', '获取登录公钥失败：' + (kj.message || kj.error_msg || kj.scode || ('HTTP ' + kr.status)));
    }
    /* 实际返回 {"scode":"200","result":{"pwdSwitch":1,"key":"MIGf..."}}，公钥在 result.key */
    const keyRaw = typeof kj.result === 'string'
      ? kj.result
      : (kj.result.key || kj.result.publicKey || kj.result.public_key || '');
    if (!keyRaw) return err('pwdkey', '获取登录公钥失败：响应中缺少 key 字段');
    let encPwd;
    try {
      encPwd = rsaEncrypt(keyRaw, opts.password);
    } catch (ke) {
      return err('pwdkey', '登录公钥解析失败：' + (ke && ke.message));
    }

    /* 2. 提交登录
       实测（2026-11-05 前端 login chunk 反查）：/auc/login 只接受
       application/x-www-form-urlencoded，且带 withCredentials；发 JSON 会被 301 打回登录页。 */
    log('crm: 提交登录（用户 ' + opts.loginName + '）');
    const form = new URLSearchParams();
    form.set('login_name', String(opts.loginName));
    form.set('password', encPwd);
    form.set('mobileParams[login_type]', 'web');
    form.set('login_type', 'web');
    if (opts.captcha) form.set('NECaptchaValidate', String(opts.captcha));

    const lr = await jarFetch(auc + '/auc/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Accept': 'application/json, text/plain, */*',
        'Origin': auc,
        'Referer': loginPage || (auc + '/auc/default_login'),
      },
      body: form.toString(),
    });
    let lj = {};
    try { lj = await lr.json(); } catch (_) { lj = {}; }
    /* 成功码只有 200（直接成功）与 302（需跳转落地）；其余一律失败。
       失败时 HTTP 仍是 200，只看状态码会把错密码判成成功。 */
    const scode = String(lj.scode == null ? '' : lj.scode);
    if (scode && scode !== '200' && scode !== '302') {
      if (scode === '2030007' || scode === '1030010') {
        return err('needcode', '登录需要验证码或补充认证（scode ' + scode + '），账号密码方式暂不可用');
      }
      const human = String(CRM_SCODE[scode] || lj.error_msg || lj.message || '').replace(/^登录失败[：:]\s*/, '');
      const detail = human ? (human + (scode ? '（' + scode + '）' : '')) : ('HTTP ' + lr.status + '，未返回 scode');
      return err('authfail', '登录失败：' + detail);
    }
    if (!scode && lr.status >= 400) {
      return err('authfail', '登录失败：HTTP ' + lr.status + '（未返回 scode）');
    }
    const res = lj.result || {};
    const next = res.redirectUrl || res.redirect_url || res.url
      || (lj.data && (lj.data.redirectUrl || lj.data.redirect_url || lj.data.url))
      || lj.redirect_url
      || (lr.headers && lr.headers.get && lr.headers.get('location'));

    /* 3. 跟随重定向（最多 6 跳，跨域也允许——登录链会跳到 crm 域落地会话） */
    let hop = next;
    let hops = 0;
    let finalUrl = '';
    let base = auc;
    while (hop && hops < 6) {
      const abs = hop.startsWith('http') ? hop : new URL(hop, base).toString();
      base = abs;
      finalUrl = abs;
      log('crm: 跟随登录跳转 → ' + abs.slice(0, 80));
      const rr = await jarFetch(abs, { method: 'GET' });
      if (rr.status >= 300 && rr.status < 400) { hop = rr.headers && rr.headers.get && rr.headers.get('location'); hops++; continue; }
      hop = null;
    }
    /* 又被弹回登录页 → 实际没登录成功 */
    if (/default_login|oauth2\/auth|\/login\.action/.test(finalUrl)) {
      return err('authfail', '登录失败：认证未通过（被重定向回 ' + finalUrl.replace(/^https?:\/\/[^/]+/, '') + '）');
    }

    /* 4. 从 cookie 提取用户/租户标识（xsy-* 请求头的值；缺失也能跑，靠 cookie 鉴权） */
    const session = { cookies: jar };
    const cUser = jar['c-user'] || '';
    const mUid = /"userId"\s*:\s*(\d+)/.exec(cUser) || /^(\d+)/.exec(cUser);
    if (mUid) session.userId = mUid[1];
    const cTenant = jar['x-ienterprise-tenant'] || '';
    const mT = /(\d{5,})/.exec(cTenant);
    if (mT) session.tenantId = mT[1];
    if (!Object.keys(jar).length) {
      return err('nosession', '登录响应未返回任何会话 cookie（scode ' + scode + '）');
    }
    return { ok: true, session: session, message: '登录成功' };
  } catch (e) {
    return err('exception', '登录异常：' + (e && e.message));
  }
}

/* ---------------- 业务：字段映射 + 商机全量 ---------------- */

async function xsyJson(session, url, init, deps) {
  const fetchImpl = (deps && deps.fetchImpl) || fetch;
  const headers = xsyHeaders(session, init && init.headers);
  const resp = await fetchImpl(url, Object.assign({}, init, { headers: headers, redirect: 'follow' }));
  const text = await resp.text();
  let j;
  try { j = JSON.parse(text); } catch (_) { return err('badjson', 'CRM 返回非 JSON（HTTP ' + resp.status + '）：' + text.slice(0, 120)); }
  if (resp.status === 401 || resp.status === 403) return err('authexpire', 'CRM 会话已失效（HTTP ' + resp.status + '）');
  return { ok: true, json: j, status: resp.status };
}

export async function fetchFieldLabels(session, deps) {
  const url = XSY_HOSTS.crm + '/rest/bff/v3.0/neoui/table/initData1?tableType=list&objectId=&clientType=web&objectApiKey=opportunity&onlyReturnOneViewDetail=1';
  const r = await xsyJson(session, url, { method: 'GET' }, deps);
  if (!r.ok) return r;
  const items = (r.json.data && r.json.data.items) || [];
  const labels = {};
  items.forEach(function (it) {
    if (it.apiKey) labels[it.apiKey] = { label: it.label || it.labelKey || it.apiKey, type: it.type || it.dataType || '' };
  });
  /* 标准字段的兜底映射 */
  const std = {
    ownerId: '负责人', accountId: '客户名称', createdBy: '创建人', updatedBy: '修改人',
    createdAt: '创建时间', updatedAt: '更新时间', opportunityName: '机会名称',
    money: '金额', closeDate: '预计成交日期', winRate: '赢率', 'entityType-label': '业务类型',
  };
  Object.keys(std).forEach(function (k) { if (!labels[k]) labels[k] = { label: std[k], type: '' }; });
  return { ok: true, labels: labels };
}

/* 拉全量「所有技术专用项目」商机（conditions 被服务端忽略，只能全量分页） */
export async function fetchAllOpportunities(session, deps) {
  const log = (deps && deps.log) || function () {};
  const maxPages = (deps && deps.maxPages) || 8;
  const pageSize = (deps && deps.pageSize) || 200;
  const url = XSY_HOSTS.crm + '/rest/bff/v3.0/neoui/table/search?entityApiKey=opportunity&skipTotalSize=true';
  const all = [];
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const r = await xsyJson(session, url, {
      method: 'POST',
      body: JSON.stringify({
        maxDisplayCount: 5000,
        dataView: (deps && deps.dataView) || 'opportunity_view_225',
        conditions: [],
        page: { pageNo: pageNo, pageSize: pageSize },
        sort: [{ sortdatafield: 'createdAt', sortorder: 'desc' }],
        extParams: { refreshTime: Date.now() },
      }),
    }, deps);
    if (!r.ok) return r;
    const recs = (r.json.data && r.json.data.records) || [];
    all.push.apply(all, recs);
    log('crm: 商机分页 ' + pageNo + '，本页 ' + recs.length + ' 条');
    if (recs.length < pageSize) break;
  }
  return { ok: true, records: all };
}

/* 商机字段中文标签化：把 record 翻译成 {id, f: {中文标签: 值文本}} */
export function translateRecord(rec, labels) {
  const f = {};
  Object.keys(rec).forEach(function (k) {
    if (k === 'id') return;
    const lab = (labels[k] && labels[k].label) || k;
    const v = rec[k];
    let s;
    if (v === null || v === undefined || v === '') return;
    if (typeof v === 'number') s = String(v);
    else if (typeof v === 'object') s = v.name ? String(v.name) : (Array.isArray(v) ? v.join(', ') : JSON.stringify(v));
    else s = String(v);
    if (!f[lab]) f[lab] = s;
  });
  return { id: rec.id, f: f, updatedAt: rec.updatedAt || 0 };
}

/* ---------------- 业务：维保明细 ---------------- */

export async function fetchMaintenance(session, recordId, deps) {
  const log = (deps && deps.log) || function () {};
  const body = 'viewId=' + WB_VIEW_ID + '&filter=' + encodeURIComponent(JSON.stringify(buildWbFilter(recordId)));
  const r = await xsyJson(session, WB_TEMPLATE.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body,
  }, deps);
  if (!r.ok) return r;
  /* NeoBI 响应：data 里嵌套 {type,row,col,value} 单元格数组（type=1 表头） */
  const found = (function findCells(o, depth) {
    if (depth > 4 || !o || typeof o !== 'object') return null;
    if (Array.isArray(o)) {
      if (o.length && o[0] && typeof o[0] === 'object' && 'type' in o[0] && 'row' in o[0]) return o;
      for (let i = 0; i < o.length; i++) { const f2 = findCells(o[i], depth + 1); if (f2) return f2; }
      return null;
    }
    const keys = Object.keys(o);
    for (let i = 0; i < keys.length; i++) { const f2 = o[keys[i]] && findCells(o[keys[i]], depth + 1); if (f2) return f2; }
    return null;
  })(r.json.data, 0);
  if (!found || !found.length) {
    log('crm: 维保明细为空（record ' + recordId + '）');
    return { ok: true, devices: [], columns: [] };
  }
  const headers = [], rows = {};
  found.forEach(function (c) {
    if (c.type === 1) headers[c.col] = c.value;
    else { if (!rows[c.row]) rows[c.row] = []; rows[c.row][c.col] = c.value; }
  });
  const table = Object.keys(rows).sort(function (a, b) { return a - b; }).map(function (k) { return rows[k]; });
  /* 列序（2026-11-05 实测）：销售|合同日期|合同名称|序列号|产品名称|产品型号|维保开始时间|维保结束时间|到期天数|操作系统|软件版本 */
  const colIdx = function (names) {
    for (let i = 0; i < headers.length; i++) {
      const h = String(headers[i] || '');
      if (names.some(function (n) { return h.indexOf(n) >= 0; })) return i;
    }
    return -1;
  };
  const ix = {
    serial: colIdx(['序列号']), product: colIdx(['产品名称']), model: colIdx(['型号']),
    start: colIdx(['维保开始']), end: colIdx(['维保结束']), os: colIdx(['操作系统']),
    ver: colIdx(['软件版本']),
  };
  const devices = [];
  table.forEach(function (row) {
    const cell = function (i) { return (i >= 0 && row && row[i] !== undefined && row[i] !== null) ? String(row[i]) : ''; };
    const serial = cell(ix.serial);
    if (!serial || /^台\/?套?数/.test(serial)) return;   /* 合计行 */
    devices.push({
      serialNo: serial, product: cell(ix.product), model: cell(ix.model),
      start: cell(ix.start), end: cell(ix.end), os: cell(ix.os), version: cell(ix.ver),
    });
  });
  return { ok: true, devices: devices, columns: headers.filter(Boolean) };
}

/* 维保三态判定（全部到期 / 部分到期 / 未到期），口径 2026-11-05 确认 */
export function warrantyStatus(devices, now) {
  const today = now || new Date();
  const y = today.getFullYear(), m = today.getMonth() + 1, d = today.getDate();
  const todayStr = y + '/' + String(m).padStart(2, '0') + '/' + String(d).padStart(2, '0');
  const parse = function (s) {
    const mm = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(String(s || ''));
    return mm ? Number(mm[1] + String(mm[2]).padStart(2, '0') + String(mm[3]).padStart(2, '0')) : null;
  };
  const t = parse(todayStr);
  let known = 0, expired = 0;
  devices.forEach(function (dv) {
    const e = parse(dv.end);
    if (e === null) return;
    known++;
    if (e < t) expired++;
  });
  const status = known === 0 ? 'unknown' : (expired === known ? 'expired' : (expired > 0 ? 'partial' : 'ok'));
  return { status: status, total: devices.length, known: known, expired: expired };
}

/* ---------------- 客户匹配（两级，口径 2026-11-05 确认） ---------------- */
/*
 * 第一级：CRM「客户名称」=== 巡检客户名（精确）
 * 第二级：CRM「项目名称」含巡检客户名（去「技术专用-」前缀后双向包含）
 * 多条命中：取最新修改日（updatedAt 最大）一条，并标记 multi=true
 */
export function matchForCustomer(custName, translated) {
  if (!custName) return { status: 'miss' };
  const name = String(custName).trim();
  let hits = translated.filter(function (t) { return (t.f['客户名称'] || '') === name; });
  let level = hits.length ? 1 : 0;
  if (!hits.length) {
    hits = translated.filter(function (t) {
      const pn = String(t.f['项目名称'] || '').replace(/^技术专用-/, '');
      return pn.indexOf(name) >= 0 || name.indexOf(pn.replace(/^技术专用-/, '')) >= 0;
    });
    if (hits.length) level = 2;
  }
  if (!hits.length) return { status: 'miss' };
  /* 「取最新一条」要兼容两种时间形态：毫秒时间戳（数字）与 ISO 字符串 */
  const ts = function (v) {
    if (typeof v === 'number') return v;
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  };
  hits.sort(function (a, b) { return ts(b.updatedAt) - ts(a.updatedAt); });
  return { status: 'ok', level: level, multi: hits.length > 1, hitCount: hits.length, opp: hits[0] };
}

/* ---------------- 一轮完整同步 ---------------- */
/*
 * opts = { loginName, password, session?(复用), customerNames:[...去重客户名] }
 * cb.onMatch(customerName, result)  每个客户回调（result 含快照）
 * 返回 { ok, session, stats:{matched,missed,failed,total}, error }
 * 限流：维保查询间 sleep 300ms（deps.sleep 可注入）
 */
export async function runCrmSync(opts, deps) {
  const log = (deps && deps.log) || function () {};
  const sleep = (deps && deps.sleep) || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const onMatch = (opts && opts.onMatch) || function () {};

  let session = opts.session;
  if (!session) {
    const lr = await xsyLogin(opts, deps);
    if (!lr.ok) return { ok: false, code: lr.code, message: lr.message, stats: null };
    session = lr.session;
  }

  const fr = await fetchAllOpportunities(session, deps);
  if (fr.ok && fr.code === 'authexpire') return { ok: false, code: 'authexpire', message: 'CRM 会话失效，请重新测试连通性', session: null };
  if (!fr.ok) {
    /* 会话失效：重登一次再试 */
    const lr2 = await xsyLogin(opts, deps);
    if (!lr2.ok) return { ok: false, code: lr2.code, message: lr2.message, session: null };
    session = lr2.session;
    const fr2 = await fetchAllOpportunities(session, deps);
    if (!fr2.ok) return { ok: false, code: fr2.code, message: fr2.message, session: session };
    fr.records = fr2.records;
  }

  const labR = await fetchFieldLabels(session, deps);
  if (!labR.ok) return { ok: false, code: labR.code, message: labR.message, session: session };
  const labels = labR.labels;

  const translated = fr.records.map(function (rec) { return translateRecord(rec, labels); });
  log('crm: 商机共 ' + translated.length + ' 条，待匹配客户 ' + opts.customerNames.length + ' 个');

  const stats = { matched: 0, missed: 0, failed: 0, total: opts.customerNames.length };
  for (let i = 0; i < opts.customerNames.length; i++) {
    const cname = opts.customerNames[i];
    const m = matchForCustomer(cname, translated);
    if (m.status !== 'ok') {
      stats.missed++;
      await onMatch(cname, { status: 'miss' });
      continue;
    }
    let result = {
      status: 'ok', level: m.level, multi: m.multi, hitCount: m.hitCount,
      opp: m.opp, maintenance: null, warranty: null, error: null,
    };
    try {
      const wb = await fetchMaintenance(session, m.opp.id, deps);
      if (wb.ok) {
        result.maintenance = wb.devices;
        result.warranty = warrantyStatus(wb.devices);
      } else {
        result.error = wb.message;
        stats.failed++;
        await onMatch(cname, result);
        continue;
      }
    } catch (e) {
      result.error = '维保查询异常：' + (e && e.message);
      stats.failed++;
      await onMatch(cname, result);
      continue;
    }
    stats.matched++;
    await onMatch(cname, result);
    if (i < opts.customerNames.length - 1) await sleep(300);
  }
  return { ok: true, session: session, stats: stats };
}
