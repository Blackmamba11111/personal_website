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

/* 解析公钥：支持 PEM（X.509 SubjectPublicKeyInfo）与裸 hex 模数两种形态 */
function parseRsaKey(keyRaw) {
  const s = String(keyRaw || '').trim();
  /* 形态1：裸 hex（JSEncrypt 有时直接用 hex 模数，指数默认 10001） */
  if (/^[0-9a-fA-F]{128,}$/.test(s)) return { n: BigInt('0x' + s), e: 65537n };
  /* 形态2：PEM */
  const b64 = s.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = b64ToBytes(b64);
  /* 简化 ASN.1 走位：找 INTEGER 序列 */
  let i = 0;
  const readLen = () => {
    const first = der[i++];
    if (first & 0x80) { const n = first & 0x7f; let v = 0; for (let k = 0; k < n; k++) v = (v << 8) | der[i++]; return v; }
    return first;
  };
  /* 外层 SEQUENCE */
  if (der[i++] !== 0x30) throw new Error('公钥不是有效的 ASN.1 结构');
  readLen();
  /* 可能包了一层 BIT STRING（SubjectPublicKeyInfo） */
  const trySeq = () => {
    if (der[i] === 0x02) { i++; readLen(); const start = i, len = 0; let j = i; let l2 = readLen(); void len; void start; void j; void l2; }
  };
  void trySeq;
  /* 直接在 DER 里找两个 INTEGER：模数与指数。
     SubjectPublicKeyInfo: SEQ{ SEQ{OID,OID}, BITSTRING{ SEQ{INT n, INT e}} }
     RSAPublicKey:          SEQ{INT n, INT e}
     统一策略：顺序扫描所有 0x02 INTEGER，取最后一个 >=128bit 的为 n，其后第一个小整数为 e。 */
  const ints = [];
  let p = 0;
  while (p < der.length - 1) {
    if (der[p] === 0x02) {
      let q = p + 1;
      let len = der[q++];
      if (len & 0x80) { const n = len & 0x7f; len = 0; for (let k = 0; k < n; k++) len = (len << 8) | der[q++]; }
      if (len > 0 && q + len <= der.length) { ints.push({ off: q, len }); p = q + len; continue; }
    }
    p++;
  }
  if (!ints.length) throw new Error('公钥 DER 中未找到 RSA 模数');
  const big = ints.filter(function (x) { return x.len >= 120; });
  const pick = big.length ? big[big.length - 1] : ints[ints.length - 1];
  let hex = '';
  for (let k = 0; k < pick.len; k++) hex += der[pick.off + k].toString(16).padStart(2, '0');
  const n = BigInt('0x' + (hex.replace(/^00/, '') || '0'));
  let e = 65537n;
  /* 找 pick 之后的短整数作为指数 */
  for (const it of ints) {
    if (it.off > pick.off && it.len <= 8) {
      let eh = '';
      for (let k = 0; k < it.len; k++) eh += der[it.off + k].toString(16).padStart(2, '0');
      e = BigInt('0x' + (eh || '10001'));
      break;
    }
  }
  return { n, e };
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
    /* 1. 公钥 */
    log('crm: 拉取登录公钥');
    const kr = await jarFetch(auc + '/auc/passport/password-key', { method: 'GET' });
    const kj = await kr.json();
    if (String(kj.scode) !== '200' || !kj.result) {
      return err('pwdkey', '获取登录公钥失败：' + (kj.message || kj.scode || '未知'));
    }
    const encPwd = rsaEncrypt(kj.result, opts.password);

    /* 2. 提交登录 */
    log('crm: 提交登录（用户 ' + opts.loginName + '）');
    const lr = await jarFetch(auc + '/auc/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login_name: opts.loginName,
        password: encPwd,
        NECaptchaValidate: null,
        login_type: 'web',
        device_type: 'web',
        mobileParams: { login_type: 'web' },
      }),
    });
    let lj = {};
    try { lj = await lr.json(); } catch (_) { lj = {}; }
    /* 可能的响应形态：{scode:'200', data:{redirect_url}} / 302 location / {scode:'203xxxx'} 失败码 */
    if (String(lj.scode) !== '200' && lr.status >= 400) {
      return err('authfail', '登录失败：' + (lj.message || ('HTTP ' + lr.status)));
    }
    const next = (lj.data && (lj.data.redirect_url || lj.data.redirectUrl || lj.data.url)) || lj.redirect_url || (lr.headers && lr.headers.get && lr.headers.get('location'));

    /* 3. 跟随重定向（最多 6 跳，跨域也允许——登录链会跳到 crm 域落地会话） */
    let hop = next;
    let hops = 0;
    while (hop && hops < 6) {
      const abs = hop.startsWith('http') ? hop : auc + hop;
      log('crm: 跟随登录跳转 → ' + abs.slice(0, 80));
      const rr = await jarFetch(abs, { method: 'GET' });
      if (rr.status >= 300 && rr.status < 400) { hop = rr.headers && rr.headers.get && rr.headers.get('location'); hops++; continue; }
      hop = null;
    }

    /* 4. 从 cookie 提取用户/租户标识（xsy-* 请求头的值；缺失也能跑，靠 cookie 鉴权） */
    const session = { cookies: jar };
    const cUser = jar['c-user'] || '';
    const mUid = /"userId"\s*:\s*(\d+)/.exec(cUser) || /^(\d+)/.exec(cUser);
    if (mUid) session.userId = mUid[1];
    const cTenant = jar['x-ienterprise-tenant'] || '';
    const mT = /(\d{5,})/.exec(cTenant);
    if (mT) session.tenantId = mT[1];
    if (!jar['JSESSIONID'] && !jar['SESSION'] && !jar['AUC_SESSION']) {
      return err('nosession', '登录响应未返回会话（可能触发验证码或账号密码错误）：' + (lj.scode || lj.message || '无 cookie'));
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
