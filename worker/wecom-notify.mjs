/* ============================================================================
 * 企业微信通知 · 内网 Node 与 Cloudflare Workers 共用
 *
 * 两种接入方式（按用户各自配置）：
 *   robot —— 群机器人 Webhook。消息发到该群；配了接收手机号时用 text 类型 @ 人
 *            （企业微信 markdown 类型不支持 @ 提醒，所以带 @ 时自动降级为 text）。
 *   app   —— 自建应用。gettoken 拿 access_token 后按 userid 私聊送达，不受群限制。
 *
 * 设计约束：
 *   · 只用全局 fetch，不引第三方依赖（Workers 无 node:net / node:crypto）；
 *   · 所有失败都返回 { ok:false, err }，绝不抛异常打断台账保存；
 *   · access_token 在模块级缓存（Workers isolate 内跨请求复用），提前 60 秒过期。
 * ==========================================================================*/

/* 默认消息模板：纯文本，markdown / text 两种 msgtype 下都能正常换行显示。
   用户可在用户管理里自定义，变量见 TPL_VARS。 */
export const WX_DEFAULT_TPL = [
  '【巡检报告已更新】',
  '{summary}',
  '操作人：{actor}',
  '时间：{time}',
  '{link}'
].join('\n');

/* 可用变量：{summary} {customer} {changes} {actor} {time} {date} {link} {count} */
export const TPL_VARS = ['summary', 'customer', 'changes', 'actor', 'time', 'date', 'link', 'count'];

export const WX_TYPES = ['robot', 'app'];
export const WX_LABEL = { robot: '群机器人', app: '自建应用' };

const HOOK_RE = /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9_-]+$/;

/* 接收人列表：「13800138000, lizhi」→ ['13800138000','lizhi']（同时兼容手机号与 userid） */
export function splitTo(v) {
  return String(v == null ? '' : v)
    .split(/[,，;；\s]+/)
    .map(function (s) { return s.trim(); })
    .filter(Boolean)
    .slice(0, 50);
}

/* 模板变量替换：未知变量原样保留，便于管理员发现写错的名字 */
export function fillTpl(tpl, vars) {
  const src = String(tpl == null || tpl === '' ? WX_DEFAULT_TPL : tpl);
  return src.replace(/\{([A-Za-z_]+)\}/g, function (m, k) {
    return vars && vars[k] != null ? String(vars[k]) : m;
  });
}

/* 变更条目 → 摘要文本。items = [{ customer, add, upd, del }] */
export function summaryOf(items) {
  const list = (items || []).filter(Boolean);
  return list.map(function (it) {
    const parts = [];
    if (it.add) parts.push('新增 ' + it.add + ' 条');
    if (it.upd) parts.push('修改 ' + it.upd + ' 条');
    if (it.del) parts.push('删除 ' + it.del + ' 条');
    return (list.length > 1 ? '· ' : '') + (it.customer || '未知客户') + '：' + (parts.join('、') || '有更新');
  }).join('\n');
}

/* 时间显示统一走东八区：库里存的是 UTC ISO，直接截字符串会差 8 小时 */
export function fmtTime(iso, dateOnly) {
  const d = new Date(iso || Date.now());
  if (isNaN(d.getTime())) return String(iso || '');
  const opts = dateOnly
    ? { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }
    : { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
  const p = {};
  new Intl.DateTimeFormat('zh-CN', opts).formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
  return dateOnly
    ? (p.year + '-' + p.month + '-' + p.day)
    : (p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute);
}

/* ---------------- 群机器人 ---------------- */
export async function sendRobot(cfg, content, opts) {
  opts = opts || {};
  const f = opts.fetch || fetch;
  const hook = String((cfg && cfg.hook) || '').trim();
  if (!HOOK_RE.test(hook)) return { ok: false, err: 'Webhook 地址格式不正确（应以 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key= 开头）' };
  const phones = splitTo(cfg.to);
  /* 带 @ 时必须用 text：markdown 类型不支持 mentioned_mobile_list */
  const body = phones.length
    ? { msgtype: 'text', text: { content: content, mentioned_mobile_list: phones } }
    : { msgtype: 'markdown', markdown: { content: content } };
  try {
    const r = await f(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!r.ok) return { ok: false, err: 'HTTP ' + r.status };
    if (!j || j.errcode !== 0) return { ok: false, err: (j && j.errmsg) || '企业微信返回异常', code: (j && j.errcode) };
    return { ok: true };
  } catch (e) {
    return { ok: false, err: (e && e.message) || '网络错误' };
  }
}

/* ---------------- 自建应用 ---------------- */
const tokenCache = new Map();

async function appToken(cfg, f) {
  const key = String(cfg.corpid) + '|' + String(cfg.secret);
  const hit = tokenCache.get(key);
  if (hit && hit.exp > Date.now() + 60000) return hit.token;
  const u = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=' +
    encodeURIComponent(cfg.corpid) + '&corpsecret=' + encodeURIComponent(cfg.secret);
  const r = await f(u);
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  if (!j || !j.access_token) {
    throw new Error((j && j.errmsg) ? ('获取 access_token 失败：' + j.errmsg) : '获取 access_token 失败');
  }
  tokenCache.set(key, {
    token: j.access_token,
    exp: Date.now() + (Number(j.expires_in) || 7200) * 1000
  });
  return j.access_token;
}

export async function sendApp(cfg, content, opts) {
  opts = opts || {};
  const f = opts.fetch || fetch;
  const to = splitTo(cfg.to);
  if (!cfg.corpid) return { ok: false, err: '缺少 corpid' };
  if (!cfg.secret) return { ok: false, err: '缺少 corpsecret' };
  if (!cfg.agentid) return { ok: false, err: '缺少 agentid' };
  if (!to.length) return { ok: false, err: '自建应用需要填写接收人 userid' };
  try {
    const token = await appToken(cfg, f);
    const r = await f('https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        touser: to.join('|'),
        msgtype: 'text',
        agentid: Number(cfg.agentid),
        text: { content: content }
      })
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!r.ok) return { ok: false, err: 'HTTP ' + r.status };
    if (!j || j.errcode !== 0) {
      /* 40014 / 42001：token 失效 —— 清缓存，下次重新取 */
      if (j && (j.errcode === 40014 || j.errcode === 42001)) tokenCache.delete(String(cfg.corpid) + '|' + String(cfg.secret));
      return { ok: false, err: (j && j.errmsg) || '企业微信返回异常', code: (j && j.errcode) };
    }
    /* touser 里无效成员会被静默跳过，用 invaliduser 提示管理员核对 */
    if (j.invaliduser) return { ok: false, err: '以下接收人无效：' + j.invaliduser };
    return { ok: true };
  } catch (e) {
    return { ok: false, err: (e && e.message) || '网络错误' };
  }
}

/* 统一入口：按 type 分派。cfg 为已解析的配置对象 */
export async function deliver(cfg, content, opts) {
  if (!cfg) return { ok: false, err: '未配置' };
  const type = cfg.type === 'app' ? 'app' : 'robot';
  return type === 'app' ? sendApp(cfg, content, opts) : sendRobot(cfg, content, opts);
}

/* 配置是否可用（用于列表上打「已配置」标记） */
export function wxReady(cfg) {
  if (!cfg || !cfg.enabled) return false;
  if (cfg.type === 'app') return !!(cfg.corpid && cfg.secret && cfg.agentid && splitTo(cfg.to).length);
  return HOOK_RE.test(String(cfg.hook || ''));
}

/* 校验并归一化「用户提交的机器人配置」。
   密钥类字段留空 = 沿用旧值（前端不回显明文）；
   base 为库里的旧配置对象。返回 { err } 或 { cfg } */
export function normalizeWx(input, base) {
  input = input || {};
  base = base || {};
  const type = String(input.type || base.type || 'robot').toLowerCase();
  if (WX_TYPES.indexOf(type) < 0) return { err: '接入方式需为「群机器人」或「自建应用」' };

  const cfg = {
    type: type,
    hook: base.hook || '',
    corpid: base.corpid || '',
    secret: base.secret || '',
    agentid: base.agentid || '',
    to: base.to || '',
    tpl: base.tpl || '',
    skipSelf: base.skipSelf ? 1 : 0
  };

  /* hook：显式传空串表示清空；未传表示不改 */
  if (input.hook !== undefined) {
    const h = String(input.hook || '').trim();
    if (h && !HOOK_RE.test(h)) return { err: 'Webhook 地址格式不正确（应以 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key= 开头）' };
    cfg.hook = h;
  }
  if (input.corpid !== undefined) cfg.corpid = String(input.corpid || '').trim();
  if (input.agentid !== undefined) cfg.agentid = String(input.agentid || '').trim();
  if (input.secret) cfg.secret = String(input.secret).trim();
  if (input.clearSecret) cfg.secret = '';
  if (input.to !== undefined) cfg.to = splitTo(input.to).join(', ');
  if (input.tpl !== undefined) {
    const t = String(input.tpl || '');
    if (t.length > 2000) return { err: '消息模板最多 2000 字' };
    cfg.tpl = t;
  }
  if (input.skipSelf !== undefined) cfg.skipSelf = input.skipSelf ? 1 : 0;

  /* 启用时才做完整性校验：允许先存半成品再补 */
  if (input.enabled) {
    if (type === 'robot' && !cfg.hook) return { err: '启用前请填写群机器人 Webhook 地址' };
    if (type === 'app') {
      if (!cfg.corpid || !cfg.agentid) return { err: '启用前请填写 corpid 与 agentid' };
      if (!cfg.secret) return { err: '启用前请填写 corpsecret' };
      if (!/^\d{4,12}$/.test(String(cfg.agentid))) return { err: 'agentid 应为数字（企业微信应用详情页可见）' };
      if (!splitTo(cfg.to).length) return { err: '自建应用需填写接收人 userid（可在企业微信通讯录查看）' };
    }
  }
  return { cfg: cfg };
}

/* hook 掩码：保留 host 与 key 前 4 位，避免整串凭据出现在接口响应/截图里 */
export function maskHook(hook) {
  const h = String(hook || '');
  if (!h) return '';
  const m = /^(.*[?&]key=)(.+)$/.exec(h);
  if (!m) return h.slice(0, 12) + '****';
  const k = m[2];
  return m[1] + (k.length > 4 ? k.slice(0, 4) + '****' : '****');
}
