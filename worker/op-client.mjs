/**
 * 运营中心（op.zdns.cn）客户技术信息协议实现（2026-11-20）
 *
 * 与 crm-client.mjs 同一形态：只用全局 fetch，公网 Worker 与内网 Node 共用这一份。
 *
 * 认证：平台统一身份签发的 AccessToken（JWT，有效期 8 小时），随请求头
 * `AccessToken` 发送；网关 `mo-gateway.zdns.cn` 承接 /api/ 前缀并转发。
 * 该令牌由浏览器 localStorage 持有，服务端无法自动续期，故配置里存一份，
 * 过期后由超管在界面更新（opTokenInfo 会算出剩余时间用于提示）。
 */

export const OP_GATEWAY = 'https://mo-gateway.zdns.cn';
export const OP_TOKEN_TTL_HINT = 8 * 3600;   /* 平台固定签发 8 小时 */

/* ---------- 令牌 ---------- */

/** 解析 JWT 载荷（不验签，仅用于取 exp / username；验签由平台网关负责） */
export function opTokenInfo(token) {
  const t = String(token || '').trim();
  const out = { token: t, exp: 0, leftSec: 0, username: '', uid: '', ok: false };
  if (!t) return out;
  const parts = t.split('.');
  if (parts.length < 2) return out;
  try {
    const payload = JSON.parse(b64uText(parts[1]));
    out.exp = Number(payload.exp) || 0;
    out.username = String(payload.username || '');
    out.uid = String(payload.uid || '');
    out.leftSec = out.exp ? Math.max(0, out.exp - Math.floor(Date.now() / 1000)) : 0;
    out.ok = true;
  } catch (e) {
    out.ok = false;
  }
  return out;
}

function b64uText(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  if (typeof atob === 'function') {
    const bin = atob(t);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(t, 'base64').toString('utf8');
}

/* ---------- 请求 ---------- */

async function opCall(cfg, path, opt) {
  opt = opt || {};
  const token = String((cfg && cfg.token) || '').trim();
  if (!token) return { ok: false, code: 'notoken', message: '还没有配置运营中心访问令牌' };
  const info = opTokenInfo(token);
  if (info.ok && info.exp && info.leftSec <= 30) {
    return { ok: false, code: 'expired', message: '访问令牌已过期，请到运营中心重新获取后更新配置' };
  }
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    AccessToken: token,
    timestamp: String(Date.now()),
    'X-Language': 'zh-CN'
  };
  const timeout = Math.min(20000, Math.max(3000, (parseInt(cfg && cfg.timeout, 10) || 12) * 1000));
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(function () { try { ctl.abort(); } catch (e) {} }, timeout) : null;
  try {
    const r = await (opt.fetch || globalThis.fetch)(OP_GATEWAY + path, {
      method: opt.method || 'GET',
      headers: headers,
      body: opt.body,
      signal: ctl ? ctl.signal : undefined
    });
    if (timer) clearTimeout(timer);
    let j = null;
    try { j = await r.json(); } catch (e) {}
    if (!j) return { ok: false, code: 'badjson', message: '平台返回的不是 JSON（HTTP ' + r.status + '）' };
    if (String(j.code) !== '20000') {
      return { ok: false, code: String(j.code || r.status), message: strings(j.message || ('HTTP ' + r.status)) };
    }
    return { ok: true, data: j.data };
  } catch (e) {
    if (timer) clearTimeout(timer);
    return { ok: false, code: 'neterr', message: '连接运营中心失败：' + (e && e.message ? e.message : String(e)) };
  }
}

function strings(v) { return v == null ? '' : String(v); }

/* ---------- 客户检索 ---------- */

/**
 * 按客户名模糊检索。平台忽略分页以外的条件，username 支持子串匹配。
 * 返回 { ok, list:[{accountId, accountName, ...}], total }
 */
export async function opListAccount(cfg, keyword, opt) {
  const data = Object.assign({ pageNum: 1, pageSize: 20 }, (opt && opt.data) || {});
  if (keyword) data.username = String(keyword);
  const r = await opCall(cfg, '/api/crm/accountTech/listAccount', Object.assign({
    method: 'POST',
    body: JSON.stringify({ action: 'listAccount', data: data })
  }, opt || {}));
  if (!r.ok) return r;
  const list = (r.data && r.data.list) || [];
  return { ok: true, list: list, total: Number((r.data && r.data.total) || list.length) };
}

/* ---------- 技术信息 ---------- */

/**
 * 一次取全某客户的技术档案：基本信息 / 网络信息 / 软件版本 / 维保与设备 / 技术活动 / 备注。
 * 单个子接口失败不影响其它分组，失败原因记录在 data.errors。
 */
export async function opTech(cfg, accountId, opt) {
  const id = String(accountId || '').trim();
  if (!id) return { ok: false, code: 'noid', message: '缺少客户在运营中心的账号 ID' };
  const f = (opt && opt.fetch) || globalThis.fetch;
  const get = function (p) { return opCall(cfg, p, { method: 'GET', fetch: f }); };

  const [profile, network, software, maint, activity, remark] = await Promise.all([
    get('/api/crm/getCrmAccount?accountId=' + encodeURIComponent(id)),
    get('/api/crm/accountTech/listNetworkInfo?crmAccountId=' + encodeURIComponent(id)),
    get('/api/crm/accountTech/listSoftwareVersion?crmAccountId=' + encodeURIComponent(id)),
    get('/api/crm/accountTech/listMaintenance?crmAccountId=' + encodeURIComponent(id)),
    get('/api/crm/accountTech/listActivityRecord?crmAccountId=' + encodeURIComponent(id)),
    get('/api/crm/accountTech/getRemarkInfo?crmAccountId=' + encodeURIComponent(id))
  ]);

  const errors = [];
  const mark = function (label, r) { if (!r.ok) errors.push(label + '：' + r.message); };

  mark('基本信息', profile);
  mark('网络信息', network);
  mark('软件版本', software);
  mark('维保设备', maint);
  mark('技术活动', activity);
  mark('备注', remark);

  const m = maint.ok ? (maint.data || {}) : {};
  const equipments = (m.equipments || []).map(function (e) {
    return {
      sn: strings(e.sn),
      product: strings(e.productName),
      type: strings(e.equipmentType),
      svcStart: strings(e.svcStartTime),
      svcEnd: strings(e.svcEndTime),
      currentVersion: strings(e.currentVersion),
      mainVersion: strings(e.mainVersion),
      status: e.maintenanceStatus == null ? '' : String(e.maintenanceStatus),
      renewal: strings(e.renewalStatus),
      running: strings(e.deviceRunningStatus),
      level: (e.serviceLevel || []).join(' / '),
      added: (e.valueAddedService || []).join(' / ')
    };
  });
  const acts = ((activity.ok && activity.data && activity.data.list) || []).map(function (a) {
    return {
      time: strings(a.supportTime || a.moUptime),
      type: strings(a.supportType),
      content: strings(a.supportContent),
      product: strings(a.supportProduct),
      method: strings(a.supportMethod),
      supporter: strings(a.supporter),
      text: strings(a.content)
    };
  });

  return {
    ok: true,
    accountId: id,
    profile: profile.ok ? shapeProfile(profile.data) : null,
    network: network.ok ? (network.data || []).map(shapeNetwork) : [],
    software: software.ok ? (software.data || []) : [],
    maintenance: {
      summary: {
        hardware: Number(m.hardwareEquipmentNum || 0),
        software: Number(m.softwareLicenseNum || 0),
        attachment: Number(m.attachmentEquipmentNum || 0),
        expired: Number(m.hardwareEquipmentExpireNum || 0) + Number(m.softwareLicenseExpireNum || 0),
        willExpire: Number(m.hardwareEquipmentWillExpireNum || 0) + Number(m.softwareLicenseWillExpireNum || 0)
      },
      equipments: equipments
    },
    activity: acts,
    remark: remark.ok ? (remark.data || null) : null,
    errors: errors
  };
}

function shapeProfile(p) {
  p = p || {};
  return {
    accountName: strings(p.accountName),
    moUsername: strings(p.moUsername),
    department: strings(p.department),
    owner: strings(p.accountOwner),
    mainA: strings(p.maintainerAName),
    mainB: strings(p.maintainerBName),
    level: strings(p.accountLevel),
    industry: strings(p.industry),
    type: strings(p.accountType)
  };
}

function shapeNetwork(n) {
  n = n || {};
  return {
    env: strings(n.env),
    hardware: strings(n.hardwareVersion),
    mainVersion: strings(n.mainVersion),
    softwareVersion: strings(n.softwareVersion),
    os: strings(n.os),
    module: (n.module || []).join(' / '),
    ha: (n.haArch || []).join(' / '),
    count: n.count == null ? '' : String(n.count),
    desc: strings(n.description),
    updatedAt: strings(n.updateTime)
  };
}

/* ---------- 项目技术信息（按附件表格口径） ---------- */

/**
 * 取某客户在运营中心的「网络信息」行，整理成项目信息表的列口径：
 * 网络环境 / 产品类型 / 数量 / 软件版本 / 操作系统 / 功能模块 / 组网架构 / 备注。
 * 一个客户多行 = 附件里同一项目下的多行，前端按项目合并前两列并加小计行。
 */
export async function opProject(cfg, accountId, opt) {
  const id = String(accountId || '').trim();
  if (!id) return { ok: false, code: 'noid', message: '缺少客户在运营中心的账号 ID' };
  const f = (opt && opt.fetch) || globalThis.fetch;
  const get = function (p) { return opCall(cfg, p, { method: 'GET', fetch: f }); };
  const [profile, network] = await Promise.all([
    get('/api/crm/getCrmAccount?accountId=' + encodeURIComponent(id)),
    get('/api/crm/accountTech/listNetworkInfo?crmAccountId=' + encodeURIComponent(id))
  ]);
  if (!network.ok) return { ok: false, code: network.code, message: network.message };

  const rows = (network.data || []).map(function (n) {
    n = n || {};
    const hw = strings(n.hardwareVersion).trim();
    const mods = (n.module || []).map(strings).filter(Boolean).join('、');
    const has = (n.haArch || []).map(strings).filter(Boolean).join('、');
    return {
      env: strings(n.env),
      product: hw ? ('硬件-' + hw) : '纯软件',
      count: Number(n.count) || 0,
      version: strings(n.softwareVersion),
      os: strings(n.os),
      module: mods,
      ha: has,
      note: strings(n.description),
      updatedAt: strings(n.updateTime)
    };
  });
  return {
    ok: true,
    accountId: id,
    accountName: profile.ok ? strings(profile.data && profile.data.accountName) : '',
    owner: profile.ok ? strings(profile.data && profile.data.accountOwner) : '',
    mainA: profile.ok ? strings(profile.data && profile.data.maintainerAName) : '',
    mainB: profile.ok ? strings(profile.data && profile.data.maintainerBName) : '',
    department: profile.ok ? strings(profile.data && profile.data.department) : '',
    rows: rows,
    total: rows.reduce(function (s, r) { return s + (r.count || 0); }, 0)
  };
}

/* ---------- 名称归一化（与本地台账客户名对齐） ---------- */

const SUFFIX = /(股份有限公司|有限责任公司|有限公司|集团公司|集团|公司)$/;

/** 去括号内容、去企业后缀、去空白，用于放宽检索与结果比对 */
export function opNormName(s) {
  let t = strings(s).trim();
  t = t.replace(/[（(][^）)]*[）)]/g, '');
  t = t.replace(/\s+/g, '');
  let prev = '';
  while (prev !== t) { prev = t; t = t.replace(SUFFIX, ''); }
  return t;
}

/** 由本地客户名生成检索关键词序列：全名 → 去括号 → 去后缀 → 取前 4 字 */
export function opKeywords(name) {
  const out = [];
  const push = function (v) { const s = strings(v).trim(); if (s && out.indexOf(s) < 0) out.push(s); };
  push(name);
  const noBracket = strings(name).replace(/[（(][^）)]*[）)]/g, '').trim();
  push(noBracket);
  const norm = opNormName(name);
  push(norm);
  if (norm.length > 4) push(norm.slice(0, 4));
  return out;
}

/** 在检索结果里挑最贴近本地客户名的一条：完全一致 > 归一化一致 > 唯一结果 */
export function opPickMatch(localName, list) {
  const arr = list || [];
  if (!arr.length) return null;
  const exact = arr.filter(function (x) { return strings(x.accountName) === strings(localName); });
  if (exact.length === 1) return { item: exact[0], level: 1 };
  const norm = opNormName(localName);
  const near = arr.filter(function (x) { return opNormName(x.accountName) === norm; });
  if (near.length === 1) return { item: near[0], level: 2 };
  if (arr.length === 1) return { item: arr[0], level: 3 };
  if (near.length > 1) return { item: near[0], level: 2, multi: near.length };
  if (exact.length > 1) return { item: exact[0], level: 1, multi: exact.length };
  return null;
}
