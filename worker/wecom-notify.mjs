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
  '【巡检台账已更新】',
  '{summary}',
  '操作人：{actor}',
  '时间：{time}',
  '{link}'
].join('\n');

/* 可用变量：{summary} {customer} {changes} {actor} {time} {date} {link} {count}
   {result} {files} {inspector} {vtime} {mode} {note}
   {result}    巡检结果（「正常 / 异常 / 其他」，多个去重后用「、」连）
   {files}     本次变更涉及的附件名（最多列 3 个，其余显示「等 N 个」）
   {inspector} 巡检人（多人用「/」连）
   {vtime}     巡检时间（多条取最新那条的日期）
   {mode}      巡检方式（现场 / 远程，多个去重后用「/」连）
   {note}      巡检备注（多条取最长的一条，超过 30 字截断）
   默认模板不含后四项（群机器人卡片另在明细行里展示），需要写进正文时自行添加。 */
export const TPL_VARS = [
  'summary', 'customer', 'changes', 'actor', 'time', 'date', 'link', 'count',
  'result', 'files', 'inspector', 'vtime', 'mode', 'note'
];

/* 巡检结果三态 → 中文。只认这三个值，空值/未知值不计入结论，
   避免老数据（没有 result 字段）被误报成「正常」。 */
export const RESULT_LABEL = { ok: '正常', issue: '异常', other: '其他' };

/* 一组巡检记录的结果值 → 短文本，如「正常、异常」。全空时返回「—」 */
export function resultText(vals) {
  const seen = [];
  (vals || []).forEach(function (v) {
    const t = RESULT_LABEL[v];
    if (t && seen.indexOf(t) < 0) seen.push(t);
  });
  return seen.join('、') || '—';
}

/* 附件名列表 → 「巡检报告.pdf、现场照片.jpg 等 5 个」。
   - 最多展示 3 个，其余折叠成「等 N 个」（N 是总数，不是未展示数）
   - 按 UTF-8 字节预算拼接（默认 100 字节，对齐企业微信卡片明细行的 value 上限），
     放不下就提前收尾，绝不让整条卡片因超长被拒（40058）
   - 单个名字超过 20 字截断，避免一个长文件名吃掉全部预算 */
export function filesText(names, maxBytes) {
  const raw = (names || []).filter(Boolean).map(function (s) { return String(s); });
  if (!raw.length) return '无';
  const budget = maxBytes || 100;
  const MAXN = 3;          /* 明细行最多列 3 个名字，再多看不过来也放不下 */
  const NAME_MAX = 20;     /* 单个名字超过 20 字截断，否则一个就吃掉整行 */
  /* 名字过长 → 截断加「…」；只要发生过截断或没列全，末尾统一标「等 N 个附件」 */
  const items = raw.map(function (s) { return s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '…' : s; });
  const cutName = items.some(function (t, i) { return t !== raw[i]; });
  const tailOf = function (n) { return ' 等 ' + n + ' 个附件'; };
  const bytesOf = function (s) {
    let n = 0;
    for (const ch of String(s)) n += ch.codePointAt(0) > 127 ? 3 : 1;
    return n;
  };
  const shown = [];
  for (let i = 0; i < items.length && shown.length < MAXN; i++) {
    const trial = shown.concat([items[i]]).join('、');
    /* 后面还有没列的、或名字被截过，都要给它留出尾部标记的位置 */
    const needTail = cutName || (i + 1 < items.length);
    const tail = (needTail && raw.length > 1) ? tailOf(raw.length) : '';
    if (bytesOf(trial + tail) > budget) break;
    shown.push(items[i]);
  }
  if (!shown.length) return raw.length + ' 个附件';
  /* 全部列全且名字完整 → 干净列表；否则标出总数，避免只看到一部分以为就这些 */
  const full = shown.length === items.length && !cutName;
  if (full || raw.length === 1) return shown.join('、');
  return shown.join('、') + tailOf(raw.length);
}

/* 巡检方式 → 中文。与前端 VISIT_MODES 保持同一套取值。 */
export const MODE_LABEL = { onsite: '现场', remote: '远程' };

/* 巡检方式列表 → 「现场」「现场/远程」；全空返回「—」 */
export function modeText(vals) {
  const seen = [];
  (vals || []).forEach(function (v) {
    const t = MODE_LABEL[v];
    if (t && seen.indexOf(t) < 0) seen.push(t);
  });
  return seen.join('/') || '—';
}

/* 巡检人列表 → 「潘超」「潘超/张三」。保留出现顺序，空值忽略。 */
export function inspectorText(vals) {
  const seen = [];
  (vals || []).forEach(function (v) {
    const s = String(v == null ? '' : v).trim();
    if (s && seen.indexOf(s) < 0) seen.push(s);
  });
  return seen.join('/') || '—';
}

/* 巡检人 + 方式合成一行（卡片明细行位置有限，二者合并展示）：「潘超 · 现场」 */
export function byModeText(bys, modes) {
  const a = inspectorText(bys), b = modeText(modes);
  if (a === '—' && b === '—') return '—';
  if (a === '—') return b;
  if (b === '—') return a;
  return a + ' · ' + b;
}

/* 备注文本：多条取最长的一条（信息量最大），超过 max 字截断加省略号。
   多个客户/多条记录时不做拼接，避免卡片明细行被一句句话撑爆。 */
export function noteText(notes, max) {
  const n = max == null ? 30 : max;
  let best = '';
  (notes || []).forEach(function (x) {
    const s = String(x == null ? '' : x).trim();
    if (s.length > best.length) best = s;
  });
  if (!best) return '无';
  return best.length > n ? best.slice(0, n) + '…' : best;
}

/* 一组巡检日期 → 最新那条（ISO 日期串可直接比大小）；全空返回 '' */
export function latestDate(dates) {
  let best = '';
  (dates || []).forEach(function (d) {
    const s = String(d == null ? '' : d).trim();
    if (s && s > best) best = s;      /* YYYY-MM-DD 字典序即时间序 */
  });
  return best;
}

export const WX_TYPES = ['robot', 'app'];
export const WX_LABEL = { robot: '群机器人', app: '自建应用' };

/* 触发动作：只有勾选的变更类型才推送。默认全选（等于升级前的行为）。
   顺序固定为 新增 → 修改 → 删除，前后端展示与比对都依赖这个顺序。 */
export const WX_ACTS = ['add', 'update', 'delete'];
export const WX_ACT_LABEL = { add: '新增', update: '修改', delete: '删除' };

/* 触发动作归一化：数组或逗号串都接受，非法值丢弃，去重并按固定顺序输出。
   v 未传（undefined）= 沿用 base；base 也没有 = 全选（兼容没有 acts 字段的旧配置）。 */
export function normActs(v, base) {
  const src = v === undefined ? base : v;
  if (src === undefined || src === null) return WX_ACTS.slice();
  const arr = Array.isArray(src) ? src : String(src || '').split(/[,，;；\s]+/);
  const hit = arr.map(function (s) { return String(s == null ? '' : s).trim().toLowerCase(); });
  return WX_ACTS.filter(function (a) { return hit.indexOf(a) >= 0; });
}

/* 某类变更该不该推送。未配置 acts 的旧数据一律按「全选」处理，保证平滑升级。 */
export function actAllowed(cfg, action) {
  const a = String(action || '');
  if (WX_ACTS.indexOf(a) < 0) return false;
  return normActs(cfg && cfg.acts, undefined).indexOf(a) >= 0;
}

const HOOK_RE = /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9_-]+$/;

/* 企业微信手机号（@ 用）：单号，允许 + 国家码；不接受逗号，多号请用「接收人」 */
export const PHONE_RE = /^\+?\d{5,20}$/;

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

/* ---------------- 卡片消息 ----------------
 * 两种通道的卡片结构不一样，不能共用一份请求体：
 *   app   → textcard：标题 + 富文本描述 + 右下角按钮文字（最多 4 字）
 *   robot → template_card（card_type=text_notice）：主标题 + 二级标题 + 键值行，整卡可点
 * 卡片存在的意义是那一行「查看详情」——点开直接落到该客户的巡检详情，不用再进列表找。
 *
 * 注意：群里配了接收人（@手机号）时不能用 template_card，因为 mentioned_mobile_list
 * 只对 text 类型有效，卡片里没有 @ 的位置。这种配置下自动退回 text，保证人能收到提醒。 */

/* 消息形式三选：卡片（默认，带跳转按钮）/ 纯文本 / Markdown。
   纯文本在群机器人里还能 @人；卡片与 markdown 都不支持 @，配了接收人时统一走 text。 */
export const WX_FMTS = ['card', 'text', 'markdown'];
export const WX_FMT_LABEL = { card: '卡片（带跳转）', text: '纯文本', markdown: 'Markdown' };

/* v 未传 = 沿用 base；base 也没有 = card（默认）。非法值一律回落 card。 */
export function normFmt(v, base) {
  const s = String(v === undefined ? (base === undefined ? 'card' : base) : v).toLowerCase();
  return WX_FMTS.indexOf(s) >= 0 ? s : 'card';
}

/* 按字节截断：企业微信的 textcard 限制按 UTF-8 字节算，中文占 3 字节。
   用 for...of 迭代码位，避免把 emoji 的代理对截成半个字符。 */
export function clipBytes(s, maxBytes) {
  const str = String(s == null ? '' : s);
  let out = '', bytes = 0;
  for (const ch of str) {
    const b = ch.codePointAt(0) > 127 ? 3 : 1;
    if (bytes + b > maxBytes) break;
    out += ch; bytes += b;
  }
  return out;
}

/* 应用消息的 textcard。description 支持 <br>，必须把 \n 转掉，否则客户端不换行。 */
export function textCardOf(card) {
  const c = card || {};
  return {
    msgtype: 'textcard',
    textcard: {
      title: clipBytes(c.title || '巡检台账已更新', 120),
      description: clipBytes(String(c.desc || '').replace(/\r?\n/g, '<br>'), 480),
      url: String(c.url || ''),
      btntxt: '查看详情'
    }
  };
}

/* 群机器人的 template_card。主标题限 26 字、二级标题 100 字、键值行 6 行。 */
export function tplCardOf(card) {
  const c = card || {};
  const rows = (c.rows || []).slice(0, 6).map(function (r) {
    return { keyname: clipBytes(r && r.key, 60), value: clipBytes(r && r.val, 300) };
  });
  const tc = {
    card_type: 'text_notice',
    source: { desc: '巡检看板' },
    main_title: { title: clipBytes(c.title || '巡检台账已更新', 72) },
    horizontal_content_list: rows,
    card_action: { type: 1, url: String(c.url || '') }
  };
  if (c.desc) tc.sub_title_text = clipBytes(c.desc, 300);
  return { msgtype: 'template_card', template_card: tc };
}

/* 卡片被判为参数错误时，退回文本再发一次 —— 宁可样式差一点，也不能把通知丢掉。
   只认「格式类」错误码；key 失效、限流这类重试也没用，不浪费一次请求。 */
const CARD_ERR = [40058, 40035, 40008, 40004, 44004, 40003, 40002];

/* ---------------- 群机器人 ---------------- */
/* 向群机器人 POST 一份报文。企业微信把业务错误放在 body.errcode 里，
   HTTP 200 也可能是失败，所以两处都要判。 */
async function postRobot(hook, body, f) {
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

/* 卡片没有 @ 位。需要提醒某人时，在卡片之后再补发一条纯文本
   —— 企业微信只有 text 支持 mentioned_mobile_list。
   phones 为空直接跳过（skipped），调用方据此不记流水。 */
export async function sendMention(cfg, content, opts) {
  opts = opts || {};
  const f = opts.fetch || fetch;
  const hook = String((cfg && cfg.hook) || '').trim();
  if (!HOOK_RE.test(hook)) return { ok: false, skipped: 'bad-hook', err: 'Webhook 地址格式不正确' };
  const phones = splitTo(opts.phones != null ? opts.phones : cfg.phone);
  if (!phones.length) return { ok: true, skipped: 'no-phone' };
  return postRobot(hook, {
    msgtype: 'text',
    text: { content: String(content || ''), mentioned_mobile_list: phones }
  }, f);
}

export async function sendRobot(cfg, content, opts) {
  opts = opts || {};
  const f = opts.fetch || fetch;
  const hook = String((cfg && cfg.hook) || '').trim();
  if (!HOOK_RE.test(hook)) return { ok: false, err: 'Webhook 地址格式不正确（应以 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key= 开头）' };
  const phones = splitTo(cfg.to);
  const card = (opts.card && opts.card.url) ? opts.card : null;
  const fmt = normFmt(cfg.fmt, undefined);

  /* 带 @ 时必须用 text：markdown / 卡片都不支持 mentioned_mobile_list */
  const textBody = () => phones.length
    ? { msgtype: 'text', text: { content: content, mentioned_mobile_list: phones } }
    : { msgtype: 'text', text: { content: content } };
  const mdBody = () => ({ msgtype: 'markdown', markdown: { content: content } });
  /* 卡片发不出去时的兜底：有 @ 用 text（保住提醒），否则用 markdown（保住排版） */
  const fallbackBody = () => (phones.length ? textBody() : mdBody());

  let body;
  if (fmt === 'card' && card && !phones.length) body = tplCardOf(card);
  else if (fmt === 'text') body = textBody();
  else if (fmt === 'markdown') body = phones.length ? textBody() : mdBody();
  else body = fallbackBody();   /* 卡片 + @人 / 卡片缺数据 → 文本（保住 @ 提醒与发送） */

  const post = function (b) { return postRobot(hook, b, f); };

  const r = await post(body);
  if (r.ok || body.msgtype !== 'template_card') return r;
  if (CARD_ERR.indexOf(r.code) < 0) return r;
  const r2 = await post(fallbackBody());
  return r2.ok ? { ok: true, degraded: true } : r2;
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
  const fmt = normFmt(cfg.fmt, undefined);
  const card = (opts.card && opts.card.url) ? opts.card : null;

  /* 应用消息三种形态都支持：textcard / markdown / text。
     接收人写在请求参数里，与消息类型无关，所以卡片不会丢 @ 能力。 */
  const build = function (useFmt) {
    const base = { touser: to.join('|'), agentid: Number(cfg.agentid) };
    if (useFmt === 'card' && card) return Object.assign(base, textCardOf(card));
    if (useFmt === 'markdown') return Object.assign(base, { msgtype: 'markdown', markdown: { content: content } });
    return Object.assign(base, { msgtype: 'text', text: { content: content } });
  };
  const fmtOf = function () {
    if (fmt === 'card') return card ? 'card' : 'text';
    return fmt === 'markdown' ? 'markdown' : 'text';
  };

  const post = async function (body) {
    const r = await f('https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=' + encodeURIComponent(await appToken(cfg, f)), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    return { r: r, j: j };
  };

  try {
    const first = await post(build(fmtOf()));
    let { r, j } = first;
    /* 卡片被拒（参数格式问题）→ 退回文本重发一次，不能因为样式把通知丢掉 */
    if ((!r.ok || !j || j.errcode !== 0) && fmtOf() === 'card' && j && CARD_ERR.indexOf(j.errcode) >= 0) {
      const second = await post(build('text'));
      if (second.r.ok && second.j && second.j.errcode === 0) {
        if (second.j.invaliduser) return { ok: false, err: '以下接收人无效：' + second.j.invaliduser };
        return { ok: true, degraded: true };
      }
      ({ r, j } = second);
    }
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
    phone: base.phone || '',
    atOwner: base.atOwner !== undefined ? (base.atOwner ? 1 : 0) : 1,
    tpl: base.tpl || '',
    skipSelf: base.skipSelf ? 1 : 0,
    fmt: normFmt(undefined, base.fmt),
    acts: normActs(undefined, base.acts)
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
  if (input.phone !== undefined) {
    const ph = String(input.phone || '').replace(/[\s()（）-]/g, '');
    if (ph && !PHONE_RE.test(ph)) return { err: '企业微信手机号格式不正确（只填一个号码，可带 + 与国家码）' };
    cfg.phone = ph;
  }
  if (input.atOwner !== undefined) cfg.atOwner = input.atOwner ? 1 : 0;
  if (input.tpl !== undefined) {
    const t = String(input.tpl || '');
    if (t.length > 2000) return { err: '消息模板最多 2000 字' };
    cfg.tpl = t;
  }
  if (input.skipSelf !== undefined) cfg.skipSelf = input.skipSelf ? 1 : 0;
  if (input.fmt !== undefined) cfg.fmt = normFmt(input.fmt, undefined);
  if (input.acts !== undefined) cfg.acts = normActs(input.acts, undefined);

  /* 启用时才做完整性校验：允许先存半成品再补 */
  if (input.enabled) {
    if (type === 'robot' && !cfg.hook) return { err: '启用前请填写群机器人 Webhook 地址' };
    if (type === 'app') {
      if (!cfg.corpid || !cfg.agentid) return { err: '启用前请填写 corpid 与 agentid' };
      if (!cfg.secret) return { err: '启用前请填写 corpsecret' };
      if (!/^\d{4,12}$/.test(String(cfg.agentid))) return { err: 'agentid 应为数字（企业微信应用详情页可见）' };
      if (!splitTo(cfg.to).length) return { err: '自建应用需填写接收人 userid（可在企业微信通讯录查看）' };
    }
    if (!cfg.acts.length) return { err: '请至少勾选一个触发动作（新增 / 修改 / 删除）' };
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
