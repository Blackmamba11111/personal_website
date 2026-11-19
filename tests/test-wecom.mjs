/* 企业微信通知模块单测：模板 / 摘要 / 时间 / 两种投递链路 / 配置归一化
   跑法：node tests/test-wecom.mjs  */
import * as WX from '../worker/wecom-notify.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  => ' + extra : '')); }
}

/* ---------- 模板 ---------- */
check('默认模板含 {summary}', WX.WX_DEFAULT_TPL.indexOf('{summary}') >= 0, WX.WX_DEFAULT_TPL);
const filled = WX.fillTpl('客户：{customer} / {actor} / {nope}', { customer: '衡水银行', actor: '张三' });
check('已知变量被替换', filled === '客户：衡水银行 / 张三 / {nope}', filled);
check('未知变量原样保留', filled.indexOf('{nope}') >= 0);
check('空模板回落到默认模板', WX.fillTpl('', { summary: 'S' }).indexOf('S') >= 0);
check('变量为空串时不回退为占位符', WX.fillTpl('{summary}', { summary: '' }) === '', WX.fillTpl('{summary}', { summary: '' }));

/* ---------- 模板 → 卡片结构 ---------- */
const CV = {
  title: '衡水银行 · 巡检台账已更新', summary: '衡水银行：新增 1 条', actor: '张三',
  time: '2026-11-19 09:12', date: '2026-11-19', count: '1', result: '正常',
  files: '巡检报告.pdf、现场照片.jpg', inspector: '李四', vtime: '2026-11-19',
  mode: '现场', note: '补录设备台账', link: ''
};
const bc = WX.buildCard('', CV, '衡水银行 · 巡检台账已更新');
check('默认模板第一处 {title} 做卡片主标题', bc.title === '衡水银行 · 巡检台账已更新', bc.title);
check('默认模板摘出五行明细', bc.rows.length === 5 && bc.rows[0].key === '巡检人'
  && bc.rows[4].key === '附件' && bc.rows[4].val === '巡检报告.pdf、现场照片.jpg', JSON.stringify(bc.rows));
check('明细行不进正文、正文保留操作人与时间',
  bc.desc.indexOf('巡检人：') < 0 && bc.desc.indexOf('操作人：张三') >= 0, bc.desc);
check('卡片正文不含链接', bc.desc.indexOf('http') < 0, bc.desc);
const bc2 = WX.buildCard('{summary}', CV, '兜底标题');
check('模板无 {title} → 标题回退、无明细行', bc2.title === '兜底标题' && bc2.rows.length === 0, JSON.stringify(bc2));
const bc3 = WX.buildCard('{title}\n巡检人：{inspector}', CV, 'x');
check('删掉的行不再生成明细', bc3.rows.length === 1 && bc3.rows[0].key === '巡检人', JSON.stringify(bc3.rows));
check('明细键兼容全角冒号', WX.buildCard('备注：{note}', CV, 'x').rows[0].val === '补录设备台账');
check('摘要行不会被误判成明细行', WX.buildCard('{summary}', CV, 'x').rows.length === 0);

/* ---------- 摘要 ---------- */
const one = WX.summaryOf([{ customer: '衡水银行', add: 2, upd: 0, del: 0 }]);
check('单客户摘要', one === '衡水银行：新增 2 条', one);
const many = WX.summaryOf([
  { customer: '衡水银行', add: 1, upd: 1, del: 0 },
  { customer: '邢台银行', add: 0, upd: 0, del: 1 }
]);
check('多客户逐行列出', many === '· 衡水银行：新增 1 条、修改 1 条\n· 邢台银行：删除 1 条', JSON.stringify(many));
check('空条目返回空串', WX.summaryOf([]) === '');

/* ---------- 时间（UTC 存库 → 东八区显示） ---------- */
const t = WX.fmtTime('2026-11-16T01:30:00.000Z');
check('UTC 01:30 显示为 09:30', t === '2026-11-16 09:30', t);
const d = WX.fmtTime('2026-11-16T17:30:00.000Z', true);
check('纯日期跨日进位（UTC 17:30 → 次日）', d === '2026-11-17', d);

/* ---------- 接收人 ---------- */
check('接收人支持中英文逗号与空格', JSON.stringify(WX.splitTo('13800138000，lizhi; 张三')) === JSON.stringify(['13800138000', 'lizhi', '张三']),
  JSON.stringify(WX.splitTo('13800138000，lizhi; 张三')));
check('接收人空值返回空数组', WX.splitTo('').length === 0);

/* ---------- hook 掩码 ---------- */
const hook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd1234-5678';
check('hook 掩码保留前 4 位', WX.maskHook(hook) === 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd****', WX.maskHook(hook));
check('空 hook 掩码为空串', WX.maskHook('') === '');

/* ---------- 配置归一化 ---------- */
let v = WX.normalizeWx({ enabled: 1, type: 'robot' }, null);
check('群机器人启用但没 hook → 报错', !!v.err, JSON.stringify(v));
v = WX.normalizeWx({ enabled: 1, type: 'robot', hook: hook, to: '13800138000' }, null);
check('群机器人配置完整 → 通过', !v.err && v.cfg.hook === hook, JSON.stringify(v));
v = WX.normalizeWx({ type: 'robot', hook: 'http://bad.example.com/x' }, null);
check('非企业微信域名的 hook → 报错', !!v.err, JSON.stringify(v));
v = WX.normalizeWx({ enabled: 1, type: 'app', corpid: 'c1', agentid: '1000002', secret: 's', to: '' }, null);
check('自建应用缺接收人 → 报错', !!v.err, JSON.stringify(v));
v = WX.normalizeWx({ enabled: 1, type: 'app', corpid: 'c1', agentid: '1000002', secret: 's', to: 'lizhi' }, null);
check('自建应用完整 → 通过', !v.err, JSON.stringify(v));
/* 密钥留空沿用旧值：编辑时前端不回显 secret */
v = WX.normalizeWx({ enabled: 1, type: 'app', corpid: 'c1', agentid: '1000002', to: 'lizhi' }, { secret: 'old-secret' });
check('secret 留空沿用旧值', !v.err && v.cfg.secret === 'old-secret', JSON.stringify(v));
v = WX.normalizeWx({ type: 'app', clearSecret: 1 }, { secret: 'old-secret' });
check('clearSecret 可显式清空', v.cfg.secret === '', JSON.stringify(v));
check('wxReady 对未启用返回 false', WX.wxReady({ enabled: 0, type: 'robot', hook: hook }) === false);
check('wxReady 对完整群机器人返回 true', WX.wxReady({ enabled: 1, type: 'robot', hook: hook }) === true);

/* ---------- 触发动作（新增 / 修改 / 删除） ---------- */
check('触发动作全集顺序固定', JSON.stringify(WX.WX_ACTS) === '["add","update","delete"]', JSON.stringify(WX.WX_ACTS));
check('动作中文名齐全', WX.WX_ACT_LABEL.add === '新增' && WX.WX_ACT_LABEL.update === '修改' && WX.WX_ACT_LABEL.delete === '删除');
let acts = WX.normActs(undefined, undefined);
check('未配置动作 → 默认全选（兼容旧配置）', JSON.stringify(acts) === '["add","update","delete"]', JSON.stringify(acts));
acts = WX.normActs(['delete', 'add'], undefined);
check('动作归一化：去重并按固定顺序输出', JSON.stringify(acts) === '["add","delete"]', JSON.stringify(acts));
acts = WX.normActs('update，add；bogus', undefined);
check('动作归一化：兼容逗号/中文分号串与非法值', JSON.stringify(acts) === '["add","update"]', JSON.stringify(acts));
acts = WX.normActs([], undefined);
check('动作归一化：显式空数组保留为空', Array.isArray(acts) && acts.length === 0, JSON.stringify(acts));
acts = WX.normActs(undefined, ['update']);
check('动作归一化：未传则沿用 base', JSON.stringify(acts) === '["update"]', JSON.stringify(acts));

check('actAllowed：未配置 acts 的旧数据一律放行',
  WX.actAllowed({}, 'add') && WX.actAllowed({}, 'update') && WX.actAllowed({}, 'delete'));
check('actAllowed：只勾新增时拦截修改/删除',
  WX.actAllowed({ acts: ['add'] }, 'add') && !WX.actAllowed({ acts: ['add'] }, 'update') && !WX.actAllowed({ acts: ['add'] }, 'delete'));
check('actAllowed：未知动作一律不放行', WX.actAllowed({ acts: ['add'] }, 'remove') === false);

v = WX.normalizeWx({ enabled: 1, type: 'robot', hook: hook }, null);
check('保存时不传 acts → 存成三个全选', JSON.stringify(v.cfg.acts) === '["add","update","delete"]', JSON.stringify(v.cfg.acts));
v = WX.normalizeWx({ enabled: 1, type: 'robot', hook: hook, acts: ['delete'] }, null);
check('保存时只勾删除 → 只存删除', !v.err && JSON.stringify(v.cfg.acts) === '["delete"]', JSON.stringify(v));
v = WX.normalizeWx({ enabled: 1, type: 'robot', hook: hook, acts: [] }, null);
check('启用但三个动作都不勾 → 报错拦截', !!v.err && /触发动作/.test(v.err), JSON.stringify(v));
v = WX.normalizeWx({ enabled: 0, type: 'robot', hook: hook, acts: [] }, null);
check('未启用时允许动作全空（半成品可先存）', !v.err, JSON.stringify(v));

/* ---------- 群机器人投递 ---------- */
async function testRobot() {
  let sent = null;
  const fake = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ errcode: 0, errmsg: 'ok' }) };
  };
  let r = await WX.sendRobot({ hook: hook, to: '' }, 'Hello', { fetch: fake });
  check('群机器人：无接收人时用 markdown', r.ok && sent.body.msgtype === 'markdown', JSON.stringify(sent && sent.body));
  check('群机器人：markdown 内容原样发送', sent.body.markdown.content === 'Hello');

  r = await WX.sendRobot({ hook: hook, to: '13800138000, lizhi' }, 'Hello', { fetch: fake });
  check('群机器人：有接收人时降级为 text', r.ok && sent.body.msgtype === 'text', JSON.stringify(sent && sent.body));
  check('群机器人：接收人进 mentioned_mobile_list',
    JSON.stringify(sent.body.text.mentioned_mobile_list) === JSON.stringify(['13800138000', 'lizhi']),
    JSON.stringify(sent.body.text));

  r = await WX.sendRobot({ hook: 'https://evil.example.com/x' }, 'Hello', { fetch: fake });
  check('群机器人：非法地址不发请求', !r.ok && /格式/.test(r.err), r.err);

  const failFetch = async () => ({ ok: true, json: async () => ({ errcode: 93000, errmsg: 'invalid webhook url' }) });
  r = await WX.sendRobot({ hook: hook }, 'Hello', { fetch: failFetch });
  check('群机器人：errcode 非 0 判失败并带出原因', !r.ok && r.err === 'invalid webhook url', JSON.stringify(r));

  const throwFetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  r = await WX.sendRobot({ hook: hook }, 'Hello', { fetch: throwFetch });
  check('群机器人：网络异常不抛出、返回失败', !r.ok && /ENOTFOUND/.test(r.err), r.err);
}

/* ---------- 自建应用投递 ---------- */
async function testApp() {
  const hits = [];
  const fake = async (url, init) => {
    hits.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    if (url.indexOf('/gettoken') >= 0) {
      return { ok: true, json: async () => ({ errcode: 0, access_token: 'TK-1', expires_in: 7200 }) };
    }
    return { ok: true, json: async () => ({ errcode: 0, errmsg: 'ok', invaliduser: '' }) };
  };
  const cfg = { type: 'app', corpid: 'corp-test-1', secret: 'sec-1', agentid: '1000002', to: 'lizhi, zhangsan' };
  let r = await WX.sendApp(cfg, 'Hello', { fetch: fake });
  check('自建应用：发送成功', r.ok, JSON.stringify(r));
  check('自建应用：先取 access_token 再发消息',
    hits.length === 2 && hits[0].url.indexOf('/gettoken') >= 0 && hits[1].url.indexOf('/message/send?access_token=TK-1') >= 0,
    hits.map(h => h.url).join(' | '));
  check('自建应用：touser 用 | 连接', hits[1].body.touser === 'lizhi|zhangsan', hits[1].body.touser);
  check('自建应用：agentid 转数字', hits[1].body.agentid === 1000002, hits[1].body.agentid);
  check('自建应用：正文用 text 类型', hits[1].body.msgtype === 'text' && hits[1].body.text.content === 'Hello');

  /* 第二次调用应命中 token 缓存 */
  hits.length = 0;
  await WX.sendApp(cfg, 'Again', { fetch: fake });
  check('自建应用：access_token 命中缓存（只发一次消息）', hits.length === 1 && hits[0].url.indexOf('/message/send') >= 0,
    hits.map(h => h.url).join(' | '));

  const invalid = async (url) => {
    if (url.indexOf('/gettoken') >= 0) return { ok: true, json: async () => ({ access_token: 'TK-2', expires_in: 7200 }) };
    return { ok: true, json: async () => ({ errcode: 0, invaliduser: 'wangwu' }) };
  };
  r = await WX.sendApp({ type: 'app', corpid: 'corp-test-2', secret: 's', agentid: '1', to: 'wangwu' }, 'x', { fetch: invalid });
  check('自建应用：无效接收人给出明确提示', !r.ok && /wangwu/.test(r.err), JSON.stringify(r));

  r = await WX.sendApp({ type: 'app', corpid: '', secret: '', agentid: '', to: 'x' }, 'x', { fetch: fake });
  check('自建应用：缺 corpid 不发请求', !r.ok && /corpid/.test(r.err), r.err);
}

/* ---------- 卡片消息 ---------- */
async function testCard() {
  const hook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=cardkey';
  const card = {
    title: '衡水银行 · 巡检台账已更新',
    desc: '衡水银行：新增 1 条\n操作人：潘超',
    url: 'https://10.1.114.115/inspection-dashboard.html?cust=c1',
    rows: [{ key: '操作人', val: '潘超' }, { key: '时间', val: '2026-11-16 22:30' }]
  };
  const rec = (resp) => {
    const hits = [];
    const f = async (url, opt) => { hits.push({ url: url, body: JSON.parse(opt.body) }); return { ok: true, json: async () => resp }; };
    f.hits = hits;
    return f;
  };

  check('clipBytes：中文按 3 字节算', WX.clipBytes('一二三四五', 10) === '一二三', JSON.stringify(WX.clipBytes('一二三四五', 10)));
  check('clipBytes：英文按 1 字节算', WX.clipBytes('abcdefgh', 4) === 'abcd');

  const tc = WX.textCardOf(card);
  check('textcard：msgtype 为 textcard', tc.msgtype === 'textcard');
  check('textcard：换行转成 <br>', tc.textcard.description.indexOf('<br>') >= 0, tc.textcard.description);
  check('textcard：按钮文字为「查看详情」', tc.textcard.btntxt === '查看详情');
  check('textcard：url 原样写入', tc.textcard.url === card.url);

  const tp = WX.tplCardOf(card);
  check('template_card：类型为 text_notice', tp.template_card.card_type === 'text_notice');
  check('template_card：整卡跳转带 url', tp.template_card.card_action.type === 1 && tp.template_card.card_action.url === card.url);
  check('template_card：键值行两行', tp.template_card.horizontal_content_list.length === 2,
    JSON.stringify(tp.template_card.horizontal_content_list));

  /* 群机器人 + 卡片 + 没配接收人 → 发模板卡片 */
  let f = rec({ errcode: 0 });
  let r = await WX.sendRobot({ hook: hook, fmt: 'card' }, '纯文本兜底', { fetch: f, card: card });
  check('群机器人：默认用 template_card', r.ok && f.hits[0].body.msgtype === 'template_card', f.hits[0].body.msgtype);

  /* 群机器人 + 卡片 + 配了手机号 → 退回 text 并保留 @（卡片不支持 @人） */
  f = rec({ errcode: 0 });
  r = await WX.sendRobot({ hook: hook, fmt: 'card', to: '13800138000' }, '文本', { fetch: f, card: card });
  check('群机器人：配了接收人时卡片让位给 @', r.ok && f.hits[0].body.msgtype === 'text', f.hits[0].body.msgtype);

  /* atPhones（归属人手机号）也走 text；与接收人去重，不重复 @ */
  f = rec({ errcode: 0 });
  r = await WX.sendRobot({ hook: hook, fmt: 'card' }, '文本', { fetch: f, card: card, atPhones: ['13900139000'] });
  check('atPhones 让卡片让位给 @',
    r.ok && f.hits[0].body.msgtype === 'text' &&
    JSON.stringify(f.hits[0].body.text.mentioned_mobile_list) === '["13900139000"]',
    JSON.stringify(f.hits[0].body));
  f = rec({ errcode: 0 });
  r = await WX.sendRobot({ hook: hook, fmt: 'card', to: '13900139000' }, '文本', { fetch: f, card: card, atPhones: ['13900139000'] });
  check('atPhones 与接收人重复时只 @ 一次',
    JSON.stringify(f.hits[0].body.text.mentioned_mobile_list) === '["13900139000"]',
    JSON.stringify(f.hits[0].body.text.mentioned_mobile_list));
  f = rec({ errcode: 0 });
  await WX.sendRobot({ hook: hook, fmt: 'card', to: '13800138000' }, '文本', { fetch: f, card: card });
  check('群机器人：接收人的 @ 手机号仍在', JSON.stringify(f.hits[0].body.text.mentioned_mobile_list) === '["13800138000"]',
    JSON.stringify(f.hits[0].body.text.mentioned_mobile_list));

  /* 纯文本 / Markdown 两种显式选择 */
  f = rec({ errcode: 0 });
  await WX.sendRobot({ hook: hook, fmt: 'text' }, '文本', { fetch: f, card: card });
  check('群机器人：选纯文本就发 text（无 @ 也不转 markdown）', f.hits[0].body.msgtype === 'text', f.hits[0].body.msgtype);

  f = rec({ errcode: 0 });
  await WX.sendRobot({ hook: hook, fmt: 'markdown' }, '文本', { fetch: f, card: card });
  check('群机器人：选 Markdown 发 markdown', f.hits[0].body.msgtype === 'markdown', f.hits[0].body.msgtype);

  /* 卡片被判参数错误 → 自动降级，通知不能丢 */
  let n = 0;
  const degrade = async () => {
    n++;
    return { ok: true, json: async () => (n === 1 ? { errcode: 40058, errmsg: 'invalid param' } : { errcode: 0 }) };
  };
  r = await WX.sendRobot({ hook: hook, fmt: 'card' }, '兜底', { fetch: degrade, card: card });
  check('群机器人：卡片被拒后降级为文本并成功', r.ok && r.degraded === true, JSON.stringify(r));
  check('群机器人：降级只多发一次请求', n === 2, String(n));

  /* key 无效这类错误不重试（重试也没用） */
  n = 0;
  const deadKey = async () => { n++; return { ok: true, json: async () => ({ errcode: 93000, errmsg: 'invalid webhook url' }) }; };
  r = await WX.sendRobot({ hook: hook, fmt: 'card' }, 'x', { fetch: deadKey, card: card });
  check('群机器人：key 无效不重试', !r.ok && n === 1, JSON.stringify(r) + ' n=' + n);

  /* 卡片缺 url 时退回文本，不发空卡片 */
  f = rec({ errcode: 0 });
  await WX.sendRobot({ hook: hook, fmt: 'card' }, '文本', { fetch: f, card: { title: 'T', desc: 'D' } });
  check('群机器人：卡片缺 url 时退回文本', f.hits[0].body.msgtype !== 'template_card', f.hits[0].body.msgtype);

  /* 自建应用：三种形态 */
  const appCfg = { type: 'app', corpid: 'card-corp', secret: 'card-secret', agentid: '100', to: 'panchao', fmt: 'card' };
  let hits = [];
  const appFetch = async (url, opt) => {
    if (url.indexOf('/gettoken') >= 0) return { ok: true, json: async () => ({ access_token: 'TK-CARD', expires_in: 7200 }) };
    hits.push(JSON.parse(opt.body));
    return { ok: true, json: async () => ({ errcode: 0 }) };
  };
  r = await WX.sendApp(appCfg, '文本', { fetch: appFetch, card: card });
  check('自建应用：卡片用 textcard', r.ok && hits[0].msgtype === 'textcard', hits[0] && hits[0].msgtype);
  check('自建应用：接收人照常带上', hits[0].touser === 'panchao', hits[0].touser);

  hits = [];
  await WX.sendApp(Object.assign({}, appCfg, { fmt: 'markdown' }), '# 标题', { fetch: appFetch, card: card });
  check('自建应用：选 Markdown 发 markdown', hits[0].msgtype === 'markdown' && hits[0].markdown.content === '# 标题', hits[0].msgtype);

  hits = [];
  await WX.sendApp(Object.assign({}, appCfg, { fmt: 'text' }), '纯文本', { fetch: appFetch, card: card });
  check('自建应用：选纯文本发 text', hits[0].msgtype === 'text' && hits[0].text.content === '纯文本', hits[0].msgtype);

  /* 消息形式归一化 */
  check('fmt 默认 card', WX.normFmt(undefined, undefined) === 'card');
  check('fmt 继承旧值', WX.normFmt(undefined, 'text') === 'text');
  check('fmt 非法值回落 card', WX.normFmt('bogus', undefined) === 'card');
  check('fmt 显式覆盖旧值', WX.normFmt('markdown', 'card') === 'markdown');

  const n1 = WX.normalizeWx({ enabled: 1, type: 'robot', hook: hook, fmt: 'text' }, {});
  check('normalizeWx：保存 fmt', n1.cfg && n1.cfg.fmt === 'text', JSON.stringify(n1));
  const n2 = WX.normalizeWx({ enabled: 1, type: 'robot', hook: hook }, { fmt: 'markdown' });
  check('normalizeWx：未传 fmt 沿用旧值', n2.cfg && n2.cfg.fmt === 'markdown', JSON.stringify(n2));
  const n3 = WX.normalizeWx({ enabled: 0, type: 'robot' }, {});
  check('normalizeWx：全新配置默认卡片', n3.cfg && n3.cfg.fmt === 'card', JSON.stringify(n3));
}

/* ---------- 巡检结论 / 附件名（2026-11-18 新增）---------- */
function testResultFiles() {
  check('TPL_VARS 含 result 与 files', WX.TPL_VARS.indexOf('result') >= 0 && WX.TPL_VARS.indexOf('files') >= 0, WX.TPL_VARS.join(','));
  check('fillTpl 替换 {result}', WX.fillTpl('结论：{result}', { result: '正常' }) === '结论：正常');
  check('fillTpl 替换 {files}', WX.fillTpl('附件：{files}', { files: 'a.pdf' }) === '附件：a.pdf');

  check('resultText 单值', WX.resultText(['ok']) === '正常', WX.resultText(['ok']));
  check('resultText 三态映射', WX.resultText(['ok', 'issue', 'other']) === '正常、异常、其他', WX.resultText(['ok', 'issue', 'other']));
  check('resultText 去重保序', WX.resultText(['issue', 'ok', 'issue']) === '异常、正常', WX.resultText(['issue', 'ok', 'issue']));
  check('resultText 空集合返回破折号', WX.resultText([]) === '—', WX.resultText([]));
  check('resultText 未知值不算正常', WX.resultText(['', undefined, 'bogus']) === '—', WX.resultText(['', undefined, 'bogus']));

  check('filesText 无附件', WX.filesText([]) === '无', WX.filesText([]));
  check('filesText 单个', WX.filesText(['巡检报告.pdf']) === '巡检报告.pdf');
  check('filesText 两个全展示不加「等」', WX.filesText(['a.pdf', 'b.jpg']) === 'a.pdf、b.jpg', WX.filesText(['a.pdf', 'b.jpg']));
  const five = WX.filesText(['1.pdf', '2.pdf', '3.pdf', '4.pdf', '5.pdf']);
  check('filesText 未列全 → 「等 N 个附件」（N 为总数）', five === '1.pdf、2.pdf、3.pdf 等 5 个附件', five);

  const longName = '承德银行2026年第四季度巡检报告最终版.docx';
  const oneLong = WX.filesText([longName]);
  check('filesText 单个超长名截断到 20 字以内并带省略号',
    oneLong.length <= 20 && oneLong.slice(-1) === '…', oneLong);
  check('filesText 单个附件不加「等 N 个附件」', oneLong.indexOf('等') < 0, oneLong);

  const mixed = WX.filesText([longName, '链路日志.txt']);
  check('filesText 名字被截断时标注「等 2 个附件」', mixed.indexOf('等 2 个附件') > 0, mixed);

  const heavy = WX.filesText([longName, longName, longName]);
  const bytesOf = (s) => { let n = 0; for (const ch of String(s)) n += ch.codePointAt(0) > 127 ? 3 : 1; return n; };
  check('filesText 超出字节预算时提前收尾', bytesOf(heavy) <= 100, bytesOf(heavy) + 'B: ' + heavy);
  check('filesText 预算内仍保留「等 N 个附件」', heavy.indexOf('等 3 个附件') > 0, heavy);
}

/* ---------- 巡检人 / 方式 / 备注 / 巡检时间（2026-11-18 第二批）---------- */
function testVisitFields() {
  check('TPL_VARS 含巡检四项',
    ['inspector', 'vtime', 'mode', 'note'].every((k) => WX.TPL_VARS.indexOf(k) >= 0), WX.TPL_VARS.join(','));
  check('modeText 映射现场/远程', WX.modeText(['onsite', 'remote']) === '现场/远程', WX.modeText(['onsite', 'remote']));
  check('modeText 去重保序', WX.modeText(['remote', 'onsite', 'remote']) === '远程/现场', WX.modeText(['remote', 'onsite', 'remote']));
  check('modeText 空值返回破折号', WX.modeText([]) === '—', WX.modeText([]));
  check('inspectorText 多人斜杠相连', WX.inspectorText(['潘超', '张三']) === '潘超/张三', WX.inspectorText(['潘超', '张三']));
  check('inspectorText 去重', WX.inspectorText(['潘超', '潘超']) === '潘超', WX.inspectorText(['潘超', '潘超']));
  check('byModeText 合并成「人 · 方式」', WX.byModeText(['潘超'], ['onsite']) === '潘超 · 现场', WX.byModeText(['潘超'], ['onsite']));
  check('byModeText 缺一方时只显示另一方', WX.byModeText([], ['remote']) === '远程', WX.byModeText([], ['remote']));
  check('byModeText 全空返回破折号', WX.byModeText([], []) === '—', WX.byModeText([], []));

  const shortNote = '机房环境与网络链路正常';
  check('noteText 短备注原样输出', WX.noteText([shortNote]) === shortNote, WX.noteText([shortNote]));
  const longNote = '机房环境与网络链路一切正常，空调运行稳定，温湿度在合理区间，UPS 电池组电压正常，核心交换机风扇无异常噪音，消防设施检查合格。';
  const cut = WX.noteText([longNote]);
  check('noteText 超 30 字截断并加省略号', cut.length === 31 && cut.slice(-1) === '…', cut.length + ' 字：' + cut);
  check('noteText 多条取最长的一条',
    WX.noteText(['短', '这是一条比较长的备注文字']) === '这是一条比较长的备注文字',
    WX.noteText(['短', '这是一条比较长的备注文字']));
  check('noteText 空备注返回「无」', WX.noteText(['', '  ']) === '无', WX.noteText(['', '  ']));

  check('latestDate 取最新日期', WX.latestDate(['2026-09-01', '2026-11-18', '2026-03-02']) === '2026-11-18',
    WX.latestDate(['2026-09-01', '2026-11-18', '2026-03-02']));
  check('latestDate 空集合返回空串', WX.latestDate([]) === '', JSON.stringify(WX.latestDate([])));
}

/* ---------- 卡片之后的 @ 提醒 + 手机号配置（2026-11-18 第三批） ---------- */
async function testMention() {
  const hook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123';
  let hit = null;
  const fake = async (url, init) => {
    hit = { url: String(url), body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ errcode: 0, errmsg: 'ok' }) };
  };

  let r = await WX.sendMention({ hook: hook, phone: '13800138000' }, '台账已更新', { fetch: fake });
  check('sendMention 发 text 并带 mentioned_mobile_list',
    r.ok && hit.body.msgtype === 'text' &&
    JSON.stringify(hit.body.text.mentioned_mobile_list) === '["13800138000"]',
    JSON.stringify(hit && hit.body));
  check('sendMention 正文原样发送', hit.body.text.content === '台账已更新');

  hit = null;
  r = await WX.sendMention({ hook: hook, phone: '' }, 'x', { fetch: fake });
  check('没填手机号时跳过发送', r.ok === true && r.skipped === 'no-phone' && hit === null, JSON.stringify(r));

  hit = null;
  r = await WX.sendMention({ hook: 'https://example.com/x', phone: '13800138000' }, 'x', { fetch: fake });
  check('Webhook 非法时跳过', r.ok === false && r.skipped === 'bad-hook' && hit === null, JSON.stringify(r));

  /* 配置项：手机号归一化 + @ 开关默认值 */
  let n = WX.normalizeWx({ type: 'robot', hook: hook, enabled: 1, phone: '139 0013 9000' }, {});
  check('手机号保存时去掉空格与横线', !n.err && n.cfg.phone === '13900139000', JSON.stringify(n));
  n = WX.normalizeWx({ type: 'robot', hook: hook, enabled: 1, phone: '138-0013-8000' }, {});
  check('手机号允许带横线', !n.err && n.cfg.phone === '13800138000', JSON.stringify(n.cfg && n.cfg.phone));
  n = WX.normalizeWx({ type: 'robot', hook: hook, enabled: 1, phone: '13800138000,13900139000' }, {});
  check('手机号只接受单个号码', !!n.err && /手机号/.test(n.err), JSON.stringify(n));
  n = WX.normalizeWx({ type: 'robot', hook: hook, enabled: 1 }, {});
  check('@ 归属人默认开启', !n.err && n.cfg.atOwner === 1, JSON.stringify(n.cfg && n.cfg.atOwner));
  n = WX.normalizeWx({ type: 'robot', hook: hook, enabled: 1, atOwner: 0 }, {});
  check('@ 归属人可关闭', !n.err && n.cfg.atOwner === 0, JSON.stringify(n.cfg && n.cfg.atOwner));
  n = WX.normalizeWx({ type: 'robot', hook: hook, enabled: 1 }, { phone: '13800138000', atOwner: 0 });
  check('未提交时沿用旧手机号与开关', !n.err && n.cfg.phone === '13800138000' && n.cfg.atOwner === 0,
    JSON.stringify(n.cfg && [n.cfg.phone, n.cfg.atOwner]));
}

await testRobot();
await testApp();
await testCard();
testResultFiles();
testVisitFields();
await testMention();

console.log('<<通过 ' + pass + ' / 共 ' + (pass + fail) + '>>');
if (fail) process.exitCode = 1;
