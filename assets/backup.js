/* 备份与恢复 · admin 功能页（2026-11-25）
 *
 * 独立成文件：主页身体积守卫 614400 B，余量只有百来字节，本页只放这里。
 * 依赖主页面 window.__opBridge 暴露的 esc / toast / isAdmin；
 * 但请求与下载自己实现（备份包 190MB，需要原始流与上传进度，桥接的 JSON api 不够用）。
 *
 * 能力：
 *   1. 立即备份：配置与台账（全库快照）/ 巡检报告实体，可单选可全选；可同时下发到多台目标机
 *   2. 定时任务：逐条自定义内容档位、每天/每周、时间、保留份数、下发目标
 *   3. 目标服务器：scp / sftp / tftp，密码或私钥认证，可配多台，支持连通性测试
 *   4. 备份文件：下载到本机、删除、以及用任意一包反向还原；也支持上传本机备份包还原
 */
(function () {
  'use strict';
  if (window.__backupReady) return;
  window.__backupReady = true;

  var TOKEN_KEY = 'inspection_board_token_v1';
  var B = null, OV = null, POLL = null, EDIT_T = '', EDIT_K = '';

  function bridge() { if (!B) B = window.__opBridge || null; return B; }
  function byId(id) { return document.getElementById(id); }
  function esc(s) { var b = bridge(); return b ? b.esc(s) : String(s == null ? '' : s); }
  function toast(m) { var b = bridge(); if (b) b.toast(m); else alert(m); }
  function tk() {
    try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function api(path, opts) {
    opts = opts || {};
    var headers = { 'content-type': 'application/json' };
    if (tk()) headers.authorization = 'Bearer ' + tk();
    return fetch('/api' + path, {
      method: opts.method || 'GET', headers: headers,
      body: opts.body == null ? undefined : JSON.stringify(opts.body)
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) {}
        if (!j || typeof j.ok !== 'boolean') return { ok: false, error: '服务响应异常（HTTP ' + r.status + '）', status: r.status };
        return { ok: !!j.ok, data: j.data, error: j.error, status: r.status };
      });
    }, function (e) { return { ok: false, error: '无法连接服务器：' + (e && e.message ? e.message : '网络异常') }; });
  }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function fmtWhen(d) {
    if (!d) return '—';
    var t = new Date(d);
    if (isNaN(t.getTime())) return String(d);
    function p(n) { return n < 10 ? '0' + n : n; }
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) + ' ' + p(t.getHours()) + ':' + p(t.getMinutes());
  }
  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function scopeLabel(s) { return s === 'full' ? '配置+报告' : (s === 'files' ? '仅巡检报告' : '配置与台账'); }
  function protoLabel(p) { return String(p || '').toUpperCase(); }

  /* ---------------- 样式 ---------------- */
  function style() {
    if (byId('bkStyle')) return;
    var st = document.createElement('style');
    st.id = 'bkStyle';
    st.textContent =
      '#bkView .bk-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);font-size:12px;flex-wrap:wrap;}' +
      '#bkView .bk-row:last-child{border-bottom:0;}' +
      '#bkView .bk-row .grow{flex:1 1 220px;min-width:0;}' +
      '#bkView .bk-name{font-weight:600;color:var(--text-1);}' +
      '#bkView .bk-dim{color:var(--text-2);font-size:11.5px;}' +
      '#bkView .bk-tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10.5px;border:1px solid var(--line);color:var(--text-2);}' +
      '#bkView .bk-tag.on{color:var(--brand);border-color:#AFC4F5;background:#F2F7FF;}' +
      '#bkView .bk-tag.bad{color:var(--danger-ink);border-color:#F5C9C9;background:#FFF7F7;}' +
      '#bkView .bk-form{display:none;margin-top:10px;padding:12px;border:1px solid var(--line);border-radius:var(--r-sm);background:#FAFBFD;}' +
      '#bkView .bk-form.on{display:block;}' +
      '#bkView .bk-form .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}' +
      '#bkView .bk-form label.fl{display:block;font-size:11.5px;color:var(--text-2);margin-bottom:4px;}' +
      '#bkView .bk-form input[type=text],#bkView .bk-form input[type=password],#bkView .bk-form input[type=number],#bkView .bk-form select,#bkView .bk-form textarea{' +
      'width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:var(--r-sm);font-size:12px;background:#fff;}' +
      '#bkView .bk-form textarea{min-height:56px;font-family:ui-monospace,Menlo,monospace;}' +
      '#bkView .bk-chk{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-1);margin:3px 0;cursor:pointer;}' +
      '#bkView .bk-pick{display:flex;flex-wrap:wrap;gap:10px;}' +
      '#bkView .bk-prog{font-size:12px;color:var(--brand);}';
    document.head.appendChild(st);
  }

  /* ---------------- 页面骨架 ---------------- */
  function page() {
    style();
    var el = byId('bkView');
    if (el) return el;
    el = document.createElement('div');
    el.className = 'page';
    el.id = 'bkView';
    el.innerHTML =
      '<div class="page-head">' +
      '<button type="button" class="btn" id="bkBack">← 返回看板</button>' +
      '<h2>备份与恢复</h2>' +
      '<span class="sub" id="bkSub">配置、台账与巡检报告</span>' +
      '<div class="spacer"></div>' +
      '<button type="button" class="btn" id="bkRefresh">刷新</button>' +
      '</div>' +
      '<div class="page-body">' +

      '<div class="ucard">' +
      '<div class="m-caption">立即备份</div>' +
      '<div class="hint" id="bkInfo">加载中…</div>' +
      '<div class="grid2" style="grid-template-columns:1fr 1fr;gap:14px;margin-top:10px;">' +
      '<div><label class="fl" style="font-size:11.5px;color:var(--text-2);">备份内容</label>' +
      '<label class="bk-chk"><input type="checkbox" id="bkDb" checked> 配置与台账（全库快照）</label>' +
      '<label class="bk-chk"><input type="checkbox" id="bkFiles"> 巡检报告实体（附件原件）</label>' +
      '<div class="hint" id="bkSizeHint"></div></div>' +
      '<div><label class="fl" style="font-size:11.5px;color:var(--text-2);">同时下发到（可多选）</label>' +
      '<div class="bk-pick" id="bkTargetPick"><span class="bk-dim">暂无目标服务器</span></div>' +
      '<div class="hint">不选则只保存在服务器本地，可随时下载。</div></div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin-top:12px;">' +
      '<button type="button" class="btn primary" id="bkRun">开始备份</button>' +
      '<span class="bk-prog" id="bkProg"></span>' +
      '</div>' +
      '</div>' +

      '<div class="ucard">' +
      '<div class="m-caption">定时任务' +
      '<button type="button" class="btn" id="bkTaskNew" style="float:right">+ 新建任务</button></div>' +
      '<div id="bkTaskList"><div class="hint">加载中…</div></div>' +
      '<div class="bk-form" id="bkTaskForm">' +
      '<div class="grid2">' +
      '<div><label class="fl">任务名称</label><input type="text" id="bkTName" placeholder="例如：每日配置备份"></div>' +
      '<div><label class="fl">执行时间（HH:MM）</label><input type="text" id="bkTTime" value="02:30" placeholder="02:30"></div>' +
      '<div><label class="fl">周期</label><select id="bkTFreq"><option value="daily">每天</option><option value="weekly">每周</option></select></div>' +
      '<div><label class="fl">星期（每周有效）</label><select id="bkTWeek">' +
      '<option value="0">周日</option><option value="1">周一</option><option value="2">周二</option>' +
      '<option value="3">周三</option><option value="4">周四</option><option value="5">周五</option><option value="6">周六</option>' +
      '</select></div>' +
      '<div><label class="fl">保留份数（服务器本地）</label><input type="number" id="bkTKeep" min="1" max="365" value="7"></div>' +
      '<div><label class="fl">状态</label><label class="bk-chk"><input type="checkbox" id="bkTEnabled" checked> 启用</label></div>' +
      '</div>' +
      '<div style="margin-top:8px;"><label class="fl">备份内容</label>' +
      '<label class="bk-chk"><input type="checkbox" id="bkTDb" checked> 配置与台账（全库快照）</label>' +
      '<label class="bk-chk"><input type="checkbox" id="bkTFiles"> 巡检报告实体</label></div>' +
      '<div style="margin-top:8px;"><label class="fl">下发目标</label><div class="bk-pick" id="bkTTargets"></div></div>' +
      '<div style="margin-top:12px;display:flex;gap:8px;">' +
      '<button type="button" class="btn primary" id="bkTSave">保存任务</button>' +
      '<button type="button" class="btn" id="bkTCancel">取消</button>' +
      '</div></div>' +
      '</div>' +

      '<div class="ucard">' +
      '<div class="m-caption">目标服务器（scp / sftp / tftp）' +
      '<button type="button" class="btn" id="bkTargetNew" style="float:right">+ 新增目标</button></div>' +
      '<div id="bkTargetList"><div class="hint">加载中…</div></div>' +
      '<div class="bk-form" id="bkTargetForm">' +
      '<div class="grid2">' +
      '<div><label class="fl">名称</label><input type="text" id="bkGName" placeholder="例如：备份服务器A"></div>' +
      '<div><label class="fl">协议</label><select id="bkGProto"><option value="scp">SCP</option><option value="sftp">SFTP</option><option value="tftp">TFTP</option></select></div>' +
      '<div><label class="fl">主机地址</label><input type="text" id="bkGHost" placeholder="10.1.114.200"></div>' +
      '<div><label class="fl">端口</label><input type="number" id="bkGPort" value="22"></div>' +
      '<div><label class="fl">登录用户（tftp 免填）</label><input type="text" id="bkGUser" placeholder="root"></div>' +
      '<div><label class="fl">认证方式</label><select id="bkGAuth"><option value="password">密码</option><option value="key">私钥</option></select></div>' +
      '<div><label class="fl">远端目录（tftp 免填，留空为默认）</label><input type="text" id="bkGDir" placeholder="/opt/backup"></div>' +
      '<div><label class="fl">状态</label><label class="bk-chk"><input type="checkbox" id="bkGEnabled" checked> 启用</label></div>' +
      '</div>' +
      '<div style="margin-top:8px;"><label class="fl" id="bkGSecretLabel">密码</label>' +
      '<textarea id="bkGSecret" placeholder="留空表示不修改已保存的凭据"></textarea>' +
      '<div class="hint">凭据以 AES-256-GCM 加密存放在数据库中，界面不回显。</div></div>' +
      '<div style="margin-top:12px;display:flex;gap:8px;">' +
      '<button type="button" class="btn primary" id="bkGSave">保存目标</button>' +
      '<button type="button" class="btn" id="bkGCancel">取消</button>' +
      '</div></div>' +
      '</div>' +

      '<div class="ucard">' +
      '<div class="m-caption">备份文件与恢复</div>' +
      '<div id="bkFiles"><div class="hint">加载中…</div></div>' +
      '<div style="margin-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
      '<button type="button" class="btn" id="bkUpBtn">上传备份包恢复…</button>' +
      '<input type="file" id="bkUpFile" accept=".gz,.tgz,application/gzip" style="display:none">' +
      '<span class="bk-prog" id="bkUpProg"></span>' +
      '</div>' +
      '<div class="hint" style="margin-top:6px;">恢复会先为当前数据留一份回滚点，然后替换数据库与附件目录，并让所有用户重新登录。</div>' +
      '<div id="bkRuns" class="hint" style="margin-top:12px;"></div>' +
      '</div>' +

      '</div>';
    document.body.appendChild(el);

    el.querySelector('#bkBack').addEventListener('click', function () { el.classList.remove('on'); });
    el.querySelector('#bkRefresh').addEventListener('click', function () { load(); });
    el.querySelector('#bkRun').addEventListener('click', runBackup);
    el.querySelector('#bkTaskNew').addEventListener('click', function () { openTaskForm(''); });
    el.querySelector('#bkTCancel').addEventListener('click', function () { byId('bkTaskForm').classList.remove('on'); });
    el.querySelector('#bkTSave').addEventListener('click', saveTask);
    el.querySelector('#bkTargetNew').addEventListener('click', function () { openTargetForm(''); });
    el.querySelector('#bkGCancel').addEventListener('click', function () { byId('bkTargetForm').classList.remove('on'); });
    el.querySelector('#bkGSave').addEventListener('click', saveTarget);
    el.querySelector('#bkGProto').addEventListener('change', syncProtoUI);
    el.querySelector('#bkGAuth').addEventListener('change', syncProtoUI);
    el.querySelector('#bkUpBtn').addEventListener('click', function () { byId('bkUpFile').click(); });
    el.querySelector('#bkUpFile').addEventListener('change', onUploadPick);
    return el;
  }

  function open() {
    var el = page();
    el.classList.add('on');
    load();
  }

  /* ---------------- 数据加载 ---------------- */
  function load() {
    return api('/backup/overview').then(function (r) {
      if (!r.ok) {
        byId('bkInfo').textContent = r.error || '读取失败';
        return;
      }
      OV = r.data;
      render();
      if (OV.busy || OV.restoring) startPoll();
    });
  }

  function render() {
    if (!OV) return;
    var d = OV.sizes || {};
    var filesBytes = (d.filesBytes && d.filesBytes.bytes) || 0;
    var filesCount = (d.filesBytes && d.filesBytes.count) || 0;
    byId('bkInfo').innerHTML = '服务器：<b>' + esc(OV.dir) + '</b>　·　配置与台账 <b>' +
      fmtSize(d.dbBytes) + '</b>　·　巡检报告 <b>' + fmtSize(filesBytes) + '</b>（' + filesCount + ' 个文件）';
    var tools = OV.tools || {};
    var miss = [];
    if (!tools.tar) miss.push('tar');
    if (!tools.scp) miss.push('scp');
    if (!tools.sftp) miss.push('sftp');
    if (!tools.tftp) miss.push('tftp');
    if (!tools.sshpass) miss.push('sshpass');
    byId('bkSizeHint').innerHTML = miss.length
      ? '<span style="color:var(--danger-ink)">缺少命令：' + miss.join('、') + '，对应通道不可用（需重建镜像）</span>'
      : '已就绪：tar / scp / sftp / tftp / sshpass';
    byId('bkSub').textContent = OV.restoring ? '正在恢复数据…' : '配置、台账与巡检报告';

    renderTargetPick();
    renderTargets();
    renderTasks();
    renderFiles();
    renderRuns();
    renderProgress();
  }

  function renderTargetPick() {
    var box = byId('bkTargetPick');
    var list = (OV.targets || []).filter(function (t) { return t.enabled; });
    if (!list.length) { box.innerHTML = '<span class="bk-dim">暂无启用的目标服务器</span>'; return; }
    var old = {};
    Array.prototype.forEach.call(box.querySelectorAll('input[type=checkbox]'), function (c) { if (c.checked) old[c.value] = 1; });
    box.innerHTML = list.map(function (t) {
      return '<label class="bk-chk"><input type="checkbox" value="' + esc(t.id) + '"' +
        (old[t.id] ? ' checked' : '') + '> ' + esc(t.name || t.host) + '（' + protoLabel(t.proto) + '）</label>';
    }).join('');
  }

  function renderTargets() {
    var box = byId('bkTargetList');
    var list = OV.targets || [];
    if (!list.length) { box.innerHTML = '<div class="hint">还没有目标服务器。需要异地备份时在这里新增。</div>'; return; }
    box.innerHTML = list.map(function (t) {
      var state = t.lastOk == null ? '<span class="bk-tag">未测试</span>'
        : (t.lastOk ? '<span class="bk-tag on">上次成功</span>' : '<span class="bk-tag bad">上次失败</span>');
      return '<div class="bk-row">' +
        '<div class="grow"><div class="bk-name">' + esc(t.name || t.host) + ' ' +
        (t.enabled ? '' : '<span class="bk-tag">已停用</span>') + '</div>' +
        '<div class="bk-dim">' + protoLabel(t.proto) + ' · ' + esc(t.user ? t.user + '@' : '') + esc(t.host) + ':' + t.port +
        (t.remoteDir ? ' · ' + esc(t.remoteDir) : '') + ' · ' + (t.auth === 'key' ? '私钥' : '密码') +
        (t.hasSecret ? '' : '（未设置凭据）') + '</div>' +
        '<div class="bk-dim">' + state + ' ' + esc(t.lastMsg || '') + (t.lastAt ? ' · ' + fmtWhen(t.lastAt) : '') + '</div></div>' +
        '<button type="button" class="btn" data-bk-test="' + esc(t.id) + '">测试</button>' +
        '<button type="button" class="btn" data-bk-edit="' + esc(t.id) + '">编辑</button>' +
        '<button type="button" class="btn" data-bk-targetdel="' + esc(t.id) + '">删除</button>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-bk-test]'), function (b) {
      b.addEventListener('click', function () { testTarget(b.getAttribute('data-bk-test')); });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-bk-edit]'), function (b) {
      b.addEventListener('click', function () { openTargetForm(b.getAttribute('data-bk-edit')); });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-bk-targetdel]'), function (b) {
      b.addEventListener('click', function () { delTarget(b.getAttribute('data-bk-targetdel')); });
    });
  }

  function renderTasks() {
    var box = byId('bkTaskList');
    var list = OV.tasks || [];
    if (!list.length) {
      box.innerHTML = '<div class="hint">暂无定时任务。建议：每日 02:30 只备配置与台账（快、小），每周日 03:00 备含报告的完整包。</div>';
      return;
    }
    box.innerHTML = list.map(function (t) {
      var when = t.freq === 'weekly' ? ('每' + WEEK[t.weekday] + ' ' + t.atTime) : ('每天 ' + t.atTime);
      var content = (t.includeDb ? '配置与台账' : '') + (t.includeDb && t.includeFiles ? ' + ' : '') + (t.includeFiles ? '巡检报告' : '');
      var tg = (t.targetIds || []).length;
      return '<div class="bk-row">' +
        '<div class="grow"><div class="bk-name">' + esc(t.name) + ' ' + (t.enabled ? '' : '<span class="bk-tag">已停用</span>') + '</div>' +
        '<div class="bk-dim">' + esc(when) + ' · ' + esc(content) + ' · 保留 ' + t.keep + ' 份 · ' +
        (tg ? '下发 ' + tg + ' 台' : '仅本地') + '</div>' +
        '<div class="bk-dim">下次：' + (t.enabled ? fmtWhen(t.nextAt) : '—') +
        (t.lastRunAt ? ' · 上次：' + fmtWhen(t.lastRunAt) + ' ' + esc(t.lastResult || '') : '') + '</div></div>' +
        '<button type="button" class="btn" data-bk-tedit="' + esc(t.id) + '">编辑</button>' +
        '<button type="button" class="btn" data-bk-tdel="' + esc(t.id) + '">删除</button>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-bk-tedit]'), function (b) {
      b.addEventListener('click', function () { openTaskForm(b.getAttribute('data-bk-tedit')); });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-bk-tdel]'), function (b) {
      b.addEventListener('click', function () { delTask(b.getAttribute('data-bk-tdel')); });
    });
  }

  function renderFiles() {
    var box = byId('bkFiles');
    var list = OV.files || [];
    if (!list.length) { box.innerHTML = '<div class="hint">服务器上还没有备份包。</div>'; return; }
    box.innerHTML = list.map(function (f) {
      return '<div class="bk-row">' +
        '<div class="grow"><div class="bk-name">' + esc(f.name) + '</div>' +
        '<div class="bk-dim">' + fmtSize(f.size) + ' · ' + esc(scopeLabel(f.scope)) + ' · ' + esc(f.at) + '</div></div>' +
        '<button type="button" class="btn" data-bk-dl="' + esc(f.name) + '">下载</button>' +
        '<button type="button" class="btn" data-bk-rs="' + esc(f.name) + '">用此包恢复</button>' +
        '<button type="button" class="btn" data-bk-fdel="' + esc(f.name) + '">删除</button>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-bk-dl]'), function (b) {
      b.addEventListener('click', function () { downloadPack(b.getAttribute('data-bk-dl'), b); });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-bk-rs]'), function (b) {
      b.addEventListener('click', function () { restoreLocal(b.getAttribute('data-bk-rs')); });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-bk-fdel]'), function (b) {
      b.addEventListener('click', function () { delFile(b.getAttribute('data-bk-fdel')); });
    });
  }

  function renderRuns() {
    var box = byId('bkRuns');
    var list = (OV.runs || []).slice(0, 8);
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div style="font-weight:600;color:var(--text-1);margin-bottom:4px;">最近记录</div>' +
      list.map(function (r) {
        return '<div class="bk-dim">' + fmtWhen(r.at) + ' · ' +
          (r.kind === 'restore' ? '恢复' : (r.kind === 'schedule' ? '定时' : '手动')) + ' · ' +
          esc(scopeLabel(r.scope)) + ' · ' + (r.ok ? '成功' : '<span style="color:var(--danger-ink)">失败</span>') +
          ' · ' + esc(r.file || '') + (r.detail ? ' · ' + esc(r.detail) : '') + '</div>';
      }).join('');
  }

  function renderProgress() {
    var el = byId('bkProg');
    if (!OV) return;
    if (OV.restoring) { el.textContent = '正在恢复数据，请勿关闭页面…'; return; }
    if (OV.busy && OV.progress) { el.textContent = OV.progress.message || '处理中…'; return; }
    el.textContent = '';
  }

  /* ---------------- 立即备份 ---------------- */
  function pickedTargets() {
    var out = [];
    Array.prototype.forEach.call(byId('bkTargetPick').querySelectorAll('input[type=checkbox]'), function (c) {
      if (c.checked) out.push(c.value);
    });
    return out;
  }

  function runBackup() {
    var dbOn = byId('bkDb').checked, filesOn = byId('bkFiles').checked;
    if (!dbOn && !filesOn) { toast('请至少选择一种备份内容'); return; }
    var scope = dbOn && filesOn ? 'full' : (filesOn ? 'files' : 'config');
    var btn = byId('bkRun');
    btn.disabled = true;
    byId('bkProg').textContent = '已提交，正在打包…';
    api('/backup/run', { method: 'POST', body: { scope: scope, targetIds: pickedTargets() } })
      .then(function (r) {
        if (!r.ok) { toast(r.error || '启动失败'); btn.disabled = false; byId('bkProg').textContent = ''; return; }
        startPoll();
      });
  }

  function startPoll() {
    if (POLL) return;
    var n = 0;
    POLL = setInterval(function () {
      n++;
      api('/backup/progress').then(function (r) {
        if (!r.ok || !r.data) return;
        var p = r.data;
        if (p.restoring) { byId('bkProg').textContent = '正在恢复数据，请勿关闭页面…'; return; }
        if (p.busy) {
          byId('bkProg').textContent = (p.progress && p.progress.message) || '处理中…';
          return;
        }
        clearInterval(POLL); POLL = null;
        byId('bkRun').disabled = false;
        byId('bkProg').textContent = '';
        load();
      });
      if (n > 600) { clearInterval(POLL); POLL = null; byId('bkRun').disabled = false; }
    }, 1500);
  }

  /* ---------------- 目标服务器 ---------------- */
  function syncProtoUI() {
    var proto = byId('bkGProto').value;
    var auth = byId('bkGAuth').value;
    byId('bkGSecretLabel').textContent = auth === 'key' ? '私钥内容（PEM）' : '密码';
    byId('bkGSecret').placeholder = auth === 'key'
      ? '-----BEGIN OPENSSH PRIVATE KEY----- …'
      : '留空表示不修改已保存的密码';
    if (proto === 'tftp') {
      byId('bkGPort').value = 69;
      byId('bkGUser').value = '';
      byId('bkGUser').disabled = true;
      byId('bkGAuth').disabled = true;
      byId('bkGSecret').disabled = true;
      byId('bkGSecret').value = '';
    } else {
      if (byId('bkGPort').value === '69') byId('bkGPort').value = 22;
      byId('bkGUser').disabled = false;
      byId('bkGAuth').disabled = false;
      byId('bkGSecret').disabled = false;
    }
  }

  function openTargetForm(id) {
    EDIT_T = id || '';
    var f = byId('bkTargetForm');
    var t = (OV.targets || []).filter(function (x) { return x.id === EDIT_T; })[0];
    byId('bkGName').value = t ? t.name : '';
    byId('bkGProto').value = t ? t.proto : 'scp';
    byId('bkGHost').value = t ? t.host : '';
    byId('bkGPort').value = t ? t.port : 22;
    byId('bkGUser').value = t ? t.user : '';
    byId('bkGAuth').value = t ? t.auth : 'password';
    byId('bkGDir').value = t ? t.remoteDir : '';
    byId('bkGEnabled').checked = t ? !!t.enabled : true;
    byId('bkGSecret').value = '';
    syncProtoUI();
    f.classList.add('on');
    byId('bkGHost').focus();
  }

  function saveTarget() {
    var body = {
      id: EDIT_T || undefined,
      name: byId('bkGName').value.trim(),
      proto: byId('bkGProto').value,
      host: byId('bkGHost').value.trim(),
      port: Number(byId('bkGPort').value) || 0,
      user: byId('bkGUser').value.trim(),
      auth: byId('bkGAuth').value,
      remoteDir: byId('bkGDir').value.trim(),
      enabled: byId('bkGEnabled').checked,
      secret: byId('bkGSecret').value
    };
    if (!body.host) { toast('请填写主机地址'); return; }
    if (body.proto !== 'tftp' && !body.user) { toast('请填写登录用户'); return; }
    api('/backup/targets', { method: 'POST', body: body }).then(function (r) {
      if (!r.ok) { toast(r.error || '保存失败'); return; }
      byId('bkTargetForm').classList.remove('on');
      toast('目标服务器已保存');
      load();
    });
  }

  function delTarget(id) {
    if (!window.confirm('删除该目标服务器？已备份的文件不受影响。')) return;
    api('/backup/targets/' + encodeURIComponent(id), { method: 'DELETE' }).then(function (r) {
      if (!r.ok) { toast(r.error || '删除失败'); return; }
      load();
    });
  }

  function testTarget(id) {
    toast('正在测试连通性…');
    api('/backup/targets/test', { method: 'POST', body: { id: id } }).then(function (r) {
      toast(r.ok ? '连接成功，已试传测试文件' : ('失败：' + (r.error || '未知原因')));
      load();
    });
  }

  /* ---------------- 定时任务 ---------------- */
  function openTaskForm(id) {
    EDIT_K = id || '';
    var t = (OV.tasks || []).filter(function (x) { return x.id === EDIT_K; })[0];
    byId('bkTName').value = t ? t.name : '';
    byId('bkTFreq').value = t ? t.freq : 'daily';
    byId('bkTWeek').value = String(t ? t.weekday : 0);
    byId('bkTTime').value = t ? t.atTime : '02:30';
    byId('bkTKeep').value = t ? t.keep : 7;
    byId('bkTDb').checked = t ? !!t.includeDb : true;
    byId('bkTFiles').checked = t ? !!t.includeFiles : false;
    byId('bkTEnabled').checked = t ? !!t.enabled : true;
    var picks = (OV.targets || []).map(function (g) {
      var on = t && (t.targetIds || []).indexOf(g.id) >= 0;
      return '<label class="bk-chk"><input type="checkbox" value="' + esc(g.id) + '"' + (on ? ' checked' : '') + '> ' +
        esc(g.name || g.host) + '（' + protoLabel(g.proto) + '）</label>';
    }).join('');
    byId('bkTTargets').innerHTML = picks || '<span class="bk-dim">暂无目标服务器</span>';
    byId('bkTaskForm').classList.add('on');
    byId('bkTName').focus();
  }

  function saveTask() {
    var ids = [];
    Array.prototype.forEach.call(byId('bkTTargets').querySelectorAll('input[type=checkbox]'), function (c) {
      if (c.checked) ids.push(c.value);
    });
    var body = {
      id: EDIT_K || undefined,
      name: byId('bkTName').value.trim(),
      includeDb: byId('bkTDb').checked,
      includeFiles: byId('bkTFiles').checked,
      freq: byId('bkTFreq').value,
      weekday: Number(byId('bkTWeek').value) || 0,
      atTime: byId('bkTTime').value.trim(),
      keep: Number(byId('bkTKeep').value) || 7,
      targetIds: ids,
      enabled: byId('bkTEnabled').checked
    };
    if (!body.includeDb && !body.includeFiles) { toast('请至少选择一种备份内容'); return; }
    if (!/^\d{1,2}:\d{2}$/.test(body.atTime)) { toast('时间格式应为 HH:MM'); return; }
    api('/backup/tasks', { method: 'POST', body: body }).then(function (r) {
      if (!r.ok) { toast(r.error || '保存失败'); return; }
      byId('bkTaskForm').classList.remove('on');
      toast('定时任务已保存');
      load();
    });
  }

  function delTask(id) {
    if (!window.confirm('删除该定时任务？已生成的备份文件不受影响。')) return;
    api('/backup/tasks/' + encodeURIComponent(id), { method: 'DELETE' }).then(function (r) {
      if (!r.ok) { toast(r.error || '删除失败'); return; }
      load();
    });
  }

  /* ---------------- 下载 / 还原 ---------------- */
  function downloadPack(name, btn) {
    var old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '下载中…'; }
    fetch('/api/backup/download?name=' + encodeURIComponent(name), {
      headers: tk() ? { authorization: 'Bearer ' + tk() } : {}
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
      toast('已开始下载 ' + name);
    }).catch(function (e) {
      toast('下载失败：' + (e && e.message ? e.message : '网络异常'));
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = old; }
    });
  }

  function restoreLocal(name) {
    var msg = '确定用「' + name + '」恢复？\n\n' +
      '· 当前数据库与附件会被备份包内容替换\n' +
      '· 恢复前会自动保留一份当前数据库的回滚点\n' +
      '· 所有用户（含你）会被强制重新登录\n' +
      '· 恢复期间系统短暂不可用';
    if (!window.confirm(msg)) return;
    byId('bkProg').textContent = '正在恢复，请勿关闭页面…';
    api('/backup/restore', { method: 'POST', body: { name: name } }).then(function (r) {
      if (!r.ok) { toast(r.error || '恢复失败'); byId('bkProg').textContent = ''; return; }
      alert('恢复完成。所有会话已失效，点击确定后重新登录。');
      location.reload();
    });
  }

  function onUploadPick() {
    var inp = byId('bkUpFile');
    var f = inp.files && inp.files[0];
    if (!f) return;
    if (!window.confirm('上传并恢复「' + f.name + '」（' + fmtSize(f.size) + '）？\n\n' +
      '当前数据库与附件会被该包内容替换，恢复前会自动保留当前数据库的回滚点，' +
      '所有用户（含你）会被强制重新登录。')) { inp.value = ''; return; }
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/backup/restore-upload', true);
    if (tk()) xhr.setRequestHeader('authorization', 'Bearer ' + tk());
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) {
        byId('bkUpProg').textContent = '上传中 ' + Math.round(e.loaded / e.total * 100) + '%';
      }
    };
    xhr.onload = function () {
      var j = null;
      try { j = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status === 200 && j && j.ok) {
        byId('bkUpProg').textContent = '';
        alert('恢复完成。所有会话已失效，点击确定后重新登录。');
        location.reload();
      } else {
        byId('bkUpProg').textContent = '';
        toast('恢复失败：' + ((j && j.error) || ('HTTP ' + xhr.status)));
      }
      inp.value = '';
    };
    xhr.onerror = function () {
      byId('bkUpProg').textContent = '';
      toast('上传失败，请检查网络或包大小');
      inp.value = '';
    };
    xhr.send(f);
    byId('bkUpProg').textContent = '准备上传…';
  }

  function delFile(name) {
    if (!window.confirm('删除备份包「' + name + '」？该操作不可恢复。')) return;
    api('/backup/file?name=' + encodeURIComponent(name), { method: 'DELETE' }).then(function (r) {
      if (!r.ok) { toast(r.error || '删除失败'); return; }
      load();
    });
  }

  /* ---------------- 入口 ---------------- */
  function ensureEntry() {
    var b = bridge();
    var menu = byId('userMenu');
    if (!menu) return;
    var btn = byId('umBackup');
    if (!btn) {
      var ref = byId('umCrm');
      if (!ref || !ref.parentNode) return;
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'umBackup';
      btn.textContent = '备份与恢复';
      btn.addEventListener('click', function () {
        menu.classList.remove('on');
        open();
      });
      var anchor = byId('umOp');
      ref.parentNode.insertBefore(btn, (anchor && anchor.parentNode === ref.parentNode) ? anchor.nextSibling : ref.nextSibling);
    }
    btn.style.display = (b && b.isAdmin()) ? 'block' : 'none';
  }

  function boot() {
    var n = 0;
    var iv = setInterval(function () { ensureEntry(); if (++n > 3600) clearInterval(iv); }, 500);
    ensureEntry();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
