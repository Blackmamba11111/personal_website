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

await testRobot();
await testApp();

console.log('<<通过 ' + pass + ' / 共 ' + (pass + fail) + '>>');
if (fail) process.exitCode = 1;
