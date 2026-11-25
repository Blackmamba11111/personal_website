/* 备份与恢复 · admin 功能页（2026-11-25 改版：技术手册风）
 *
 * 独立成文件：主页身体积守卫 614400 B，余量只有百来字节，本页只放这里。
 * 样式外置到 assets/backup.css，本文件只在打开时注入一个 link。
 * 依赖主页面 window.__opBridge 暴露的 esc / toast / isAdmin；
 * 但请求与下载自己实现（备份包 190MB，需要原始流与上传进度，桥接的 JSON api 不够用）。
 *
 * 能力：
 *   1. 立即备份：配置与台账（全库快照）/ 巡检报告实体，可单选可全选；可同时下发到多台目标机
 *   2. 定时任务：逐条自定义内容档位、每天/每周、时间、保留份数、下发目标
 *   3. 目标服务器：scp / sftp / tftp，密码或私钥认证，可配多台，支持连通性测试
 *   4. 备份文件：下载到本机、删除、以及用任意一包反向还原；也支持上传本机备份包还原
 *
 * 2026-11-25 修：原 #bkFiles 同时用作「巡检报告」复选框与文件列表容器，
 * renderFiles 会把列表 HTML 写进复选框，导致备份文件列表永远渲染不出来。
 * 列表容器改为 #bkFileList，复选框保留 #bkFiles。
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
  function sep() { return '<i>·</i>'; }

  /* ---------------- 样式（外置） ---------------- */
  function style() {
    if (byId('bkCss')) return;
    var l = document.createElement('link');
    l.id = 'bkCss';
    l.rel = 'stylesheet';
    l.href = '/assets/backup.css?v=1';
    document.head.appendChild(l);
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
      '<div class="bk-mast">' +
        '<div>' +
          '<div class="bk-kicker">Admin · Backup / Restore</div>' +
          '<h1>备份与恢复</h1>' +
          '<p class="bk-lead" id="bkSub">配置、台账与巡检报告的统一备份出口</p>' +
        '</div>' +
        '<div class="bk-mast-r">' +
          '<button type="button" class="bk-btn" id="bkRefresh">刷新状态</button>' +
          '<button type="button" class="bk-btn ghost" id="bkBack">← 返回看板</button>' +
        '</div>' +
      '</div>' +
      '<div class="bk-body"><div class="bk-wrap">' +

        '<div class="bk-readout" id="bkReadout"></div>' +
        '<div class="bk-alert" id="bkInfo"></div>' +

        /* 01 立即备份 */
        '<section class="bk-sec">' +
          '<div class="bk-num">01</div>' +
          '<div>' +
            '<div class="bk-sec-head"><div>' +
              '<h2>立即备份</h2>' +
              '<p>生成一致快照包并保存在服务器本地；可同时下发到已启用的目标机。</p>' +
            '</div></div>' +
            '<div class="bk-choose">' +
              '<label class="bk-opt"><input type="checkbox" id="bkDb" checked>' +
                '<span class="bk-opt-box"><span class="bk-opt-t"><i></i>配置与台账</span>' +
                '<em>全库快照 · <span id="bkDbSize">—</span></em></span></label>' +
              '<label class="bk-opt"><input type="checkbox" id="bkFiles">' +
                '<span class="bk-opt-box"><span class="bk-opt-t"><i></i>巡检报告实体</span>' +
                '<em>附件原件 · <span id="bkFilesSize">—</span></em></span></label>' +
            '</div>' +
            '<div class="bk-field">' +
              '<span class="bk-label">下发至目标服务器 · 可多选</span>' +
              '<div class="bk-chips" id="bkTargetPick"></div>' +
            '</div>' +
            '<div class="bk-fire">' +
              '<button type="button" class="bk-btn cta" id="bkRun">开始备份</button>' +
              '<span class="bk-prog" id="bkProg"></span>' +
            '</div>' +
            '<p class="bk-note" id="bkSizeHint"></p>' +
          '</div>' +
        '</section>' +

        /* 02 定时任务 */
        '<section class="bk-sec">' +
          '<div class="bk-num">02</div>' +
          '<div>' +
            '<div class="bk-sec-head"><div>' +
              '<h2>定时任务</h2>' +
              '<p>按日或按周自动打包。容器重启后按库中记录的 next_at 续跑，不漏不重。</p>' +
            '</div><div class="bk-sec-act">' +
              '<button type="button" class="bk-btn" id="bkTaskNew">+ 新建任务</button>' +
            '</div></div>' +
            '<div class="bk-list" id="bkTaskList"></div>' +
            '<div class="bk-form" id="bkTaskForm">' +
              '<div class="bk-grid">' +
                '<div class="bk-fld"><span class="bk-label">任务名称</span><input type="text" id="bkTName" placeholder="每日配置备份"></div>' +
                '<div class="bk-fld"><span class="bk-label">执行时间 · HH:MM</span><input type="text" id="bkTTime" value="02:30" placeholder="02:30"></div>' +
                '<div class="bk-fld"><span class="bk-label">周期</span><select id="bkTFreq"><option value="daily">每天</option><option value="weekly">每周</option></select></div>' +
                '<div class="bk-fld"><span class="bk-label">星期 · 每周有效</span><select id="bkTWeek">' +
                  '<option value="0">周日</option><option value="1">周一</option><option value="2">周二</option>' +
                  '<option value="3">周三</option><option value="4">周四</option><option value="5">周五</option><option value="6">周六</option>' +
                '</select></div>' +
                '<div class="bk-fld"><span class="bk-label">本地保留份数</span><input type="number" id="bkTKeep" min="1" max="365" value="7"></div>' +
                '<div class="bk-fld"><span class="bk-label">状态</span><label class="bk-check"><input type="checkbox" id="bkTEnabled" checked> 启用</label></div>' +
              '</div>' +
              '<div class="bk-field mt"><span class="bk-label">备份内容</span>' +
                '<div class="bk-chips">' +
                  '<label class="bk-chip"><input type="checkbox" id="bkTDb" checked><span class="bk-chip-t">配置与台账</span></label>' +
                  '<label class="bk-chip"><input type="checkbox" id="bkTFiles"><span class="bk-chip-t">巡检报告</span></label>' +
                '</div>' +
              '</div>' +
              '<div class="bk-field mt"><span class="bk-label">下发目标</span>' +
                '<div class="bk-chips" id="bkTTargets"></div>' +
              '</div>' +
              '<div class="bk-form-foot">' +
                '<button type="button" class="bk-btn cta" id="bkTSave">保存任务</button>' +
                '<button type="button" class="bk-btn" id="bkTCancel">取消</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>' +

        /* 03 目标服务器 */
        '<section class="bk-sec">' +
          '<div class="bk-num">03</div>' +
          '<div>' +
            '<div class="bk-sec-head"><div>' +
              '<h2>目标服务器</h2>' +
              '<p>支持 scp / sftp / tftp。凭据以 AES-256-GCM 加密存放，界面不回显。</p>' +
            '</div><div class="bk-sec-act">' +
              '<button type="button" class="bk-btn" id="bkTargetNew">+ 新增目标</button>' +
            '</div></div>' +
            '<div class="bk-list" id="bkTargetList"></div>' +
            '<div class="bk-form" id="bkTargetForm">' +
              '<div class="bk-grid">' +
                '<div class="bk-fld"><span class="bk-label">名称</span><input type="text" id="bkGName" placeholder="备份服务器 A"></div>' +
                '<div class="bk-fld"><span class="bk-label">协议</span><select id="bkGProto"><option value="scp">SCP</option><option value="sftp">SFTP</option><option value="tftp">TFTP</option></select></div>' +
                '<div class="bk-fld"><span class="bk-label">主机地址</span><input type="text" id="bkGHost" placeholder="10.1.114.200"></div>' +
                '<div class="bk-fld"><span class="bk-label">端口</span><input type="number" id="bkGPort" value="22"></div>' +
                '<div class="bk-fld"><span class="bk-label">登录用户 · tftp 免填</span><input type="text" id="bkGUser" placeholder="root"></div>' +
                '<div class="bk-fld"><span class="bk-label">认证方式</span><select id="bkGAuth"><option value="password">密码</option><option value="key">私钥</option></select></div>' +
                '<div class="bk-fld"><span class="bk-label">远端目录 · 留空为默认</span><input type="text" id="bkGDir" placeholder="/opt/backup"></div>' +
                '<div class="bk-fld"><span class="bk-label">状态</span><label class="bk-check"><input type="checkbox" id="bkGEnabled" checked> 启用</label></div>' +
              '</div>' +
              '<div class="bk-field mt"><span class="bk-label" id="bkGSecretLabel">密码</span>' +
                '<div class="bk-fld"><textarea id="bkGSecret" placeholder="留空表示不修改已保存的凭据"></textarea></div>' +
              '</div>' +
              '<div class="bk-form-foot">' +
                '<button type="button" class="bk-btn cta" id="bkGSave">保存目标</button>' +
                '<button type="button" class="bk-btn" id="bkGCancel">取消</button>' +
                '<p class="bk-note">凭据加密存放，保存后仅显示「已设置」。</p>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>' +

        /* 04 文件与恢复 */
        '<section class="bk-sec">' +
          '<div class="bk-num">04</div>' +
          '<div>' +
            '<div class="bk-sec-head"><div>' +
              '<h2>备份文件与恢复</h2>' +
              '<p>任意一包都可反向还原。恢复前自动留回滚点，完成后所有会话失效、需重新登录。</p>' +
            '</div><div class="bk-sec-act">' +
              '<button type="button" class="bk-btn" id="bkUpBtn">上传备份包恢复</button>' +
              '<input type="file" id="bkUpFile" accept=".gz,.tgz,application/gzip" style="display:none">' +
              '<span class="bk-prog" id="bkUpProg"></span>' +
            '</div></div>' +
            '<div class="bk-file-head"><span>文件</span><span>大小</span><span>生成时间</span><span>操作</span></div>' +
            '<div class="bk-list" id="bkFileList"></div>' +
            '<div class="bk-log" id="bkRuns"></div>' +
          '</div>' +
        '</section>' +

      '</div></div>';
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

  function cell(v, label, small, title) {
    return '<div class="bk-cell">' +
      '<b' + (small ? ' class="sm"' : '') + (title ? ' title="' + esc(title) + '"' : '') + '>' + v + '</b>' +
      '<span>' + esc(label) + '</span></div>';
  }

  function renderReadout() {
    var d = OV.sizes || {};
    var filesBytes = (d.filesBytes && d.filesBytes.bytes) || 0;
    var filesCount = (d.filesBytes && d.filesBytes.count) || 0;
    byId('bkReadout').innerHTML =
      cell(esc(OV.dir), '存储位置', true, OV.dir) +
      cell(fmtSize(d.dbBytes), '配置与台账') +
      cell(fmtSize(filesBytes), '巡检报告 · ' + filesCount + ' 个文件') +
      cell((OV.targets || []).length + ' / ' + (OV.tasks || []).length, '异地目标 / 定时任务');
  }

  function render() {
    if (!OV) return;
    var d = OV.sizes || {};
    var filesBytes = (d.filesBytes && d.filesBytes.bytes) || 0;
    var filesCount = (d.filesBytes && d.filesBytes.count) || 0;

    byId('bkInfo').textContent = '';
    renderReadout();
    if (byId('bkDbSize')) byId('bkDbSize').textContent = fmtSize(d.dbBytes);
    if (byId('bkFilesSize')) byId('bkFilesSize').textContent = fmtSize(filesBytes) + '（' + filesCount + ' 个）';

    var tools = OV.tools || {};
    var miss = [];
    if (!tools.tar) miss.push('tar');
    if (!tools.scp) miss.push('scp');
    if (!tools.sftp) miss.push('sftp');
    if (!tools.tftp) miss.push('tftp');
    if (!tools.sshpass) miss.push('sshpass');
    byId('bkSizeHint').innerHTML = miss.length
      ? '<span class="bk-st bad">缺少命令：' + miss.join('、') + '，对应通道不可用（需重建镜像）</span>'
      : '已就绪 ' + sep() + ' tar / scp / sftp / tftp / sshpass';
    byId('bkSub').textContent = OV.restoring
      ? '正在恢复数据，请勿关闭页面…'
      : '配置、台账与巡检报告的统一备份出口';

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
    if (!list.length) { box.innerHTML = '<span class="bk-note">暂无启用的目标服务器，备份只留在本机。</span>'; return; }
    var old = {};
    Array.prototype.forEach.call(box.querySelectorAll('input[type=checkbox]'), function (c) { if (c.checked) old[c.value] = 1; });
    box.innerHTML = list.map(function (t) {
      return '<label class="bk-chip"><input type="checkbox" value="' + esc(t.id) + '"' +
        (old[t.id] ? ' checked' : '') + '><span class="bk-chip-t">' + esc(t.name || t.host) +
        '<small>' + protoLabel(t.proto) + '</small></span></label>';
    }).join('');
  }

  function renderTargets() {
    var box = byId('bkTargetList');
    var list = OV.targets || [];
    if (!list.length) {
      box.innerHTML = '<div class="bk-empty"><strong>No target</strong>' +
        '还没有目标服务器，备份只能落在本机磁盘。需要异地副本时点右上角「新增目标」。</div>';
      return;
    }
    box.innerHTML = list.map(function (t) {
      var state = t.lastOk == null ? '<span class="bk-st">未测试</span>'
        : (t.lastOk ? '<span class="bk-st ok">上次成功</span>' : '<span class="bk-st bad">上次失败</span>');
      var addr = protoLabel(t.proto) + ' ' + (t.user ? t.user + '@' : '') + t.host + ':' + t.port;
      return '<div class="bk-item">' +
        '<div class="bk-item-t">' +
          '<div class="n">' + esc(t.name || t.host) +
            '<em>' + protoLabel(t.proto) + '</em>' +
            (t.enabled ? '' : '<span class="bk-st off">已停用</span>') +
            state + '</div>' +
          '<div class="m">' + esc(addr) +
            (t.remoteDir ? sep() + esc(t.remoteDir) : '') +
            sep() + (t.auth === 'key' ? '私钥' : '密码') +
            (t.hasSecret ? '' : sep() + '<b>未设置凭据</b>') +
            (t.lastAt ? sep() + fmtWhen(t.lastAt) : '') +
            (t.lastMsg ? sep() + esc(t.lastMsg) : '') + '</div>' +
        '</div>' +
        '<div class="bk-act">' +
          '<button type="button" class="bk-btn" data-bk-test="' + esc(t.id) + '">测试</button>' +
          '<button type="button" class="bk-btn" data-bk-edit="' + esc(t.id) + '">编辑</button>' +
          '<button type="button" class="bk-btn danger" data-bk-targetdel="' + esc(t.id) + '">删除</button>' +
        '</div>' +
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
      box.innerHTML = '<div class="bk-empty"><strong>No schedule</strong>' +
        '暂无定时任务，只能手动备份。建议先配两条：每日 02:30 只备配置（快、小），每周日 03:00 备含报告的完整包。</div>';
      return;
    }
    box.innerHTML = list.map(function (t) {
      var when = t.freq === 'weekly' ? ('每' + WEEK[t.weekday] + ' ' + t.atTime) : ('每天 ' + t.atTime);
      var content = (t.includeDb ? '配置与台账' : '') + (t.includeDb && t.includeFiles ? ' + ' : '') + (t.includeFiles ? '巡检报告' : '');
      var tg = (t.targetIds || []).length;
      var lastBad = t.lastRunAt && /失败|fail|error/i.test(String(t.lastResult || ''));
      return '<div class="bk-item">' +
        '<div class="bk-item-t">' +
          '<div class="n">' + esc(t.name) +
            (t.enabled ? '' : '<span class="bk-st off">已停用</span>') +
            (lastBad ? '<span class="bk-st bad">上次失败</span>' : '') + '</div>' +
          '<div class="m">' + esc(when) + sep() + esc(content) + sep() + '保留 ' + t.keep + ' 份' +
            sep() + (tg ? '下发 ' + tg + ' 台' : '仅本地') + '</div>' +
          '<div class="m">' + (t.enabled ? '下次 ' + fmtWhen(t.nextAt) : '未启用') +
            (t.lastRunAt ? sep() + '上次 ' + fmtWhen(t.lastRunAt) + (t.lastResult ? sep() + esc(t.lastResult) : '') : '') +
            '</div>' +
        '</div>' +
        '<div class="bk-act">' +
          '<button type="button" class="bk-btn" data-bk-tedit="' + esc(t.id) + '">编辑</button>' +
          '<button type="button" class="bk-btn danger" data-bk-tdel="' + esc(t.id) + '">删除</button>' +
        '</div>' +
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
    var box = byId('bkFileList');
    var list = OV.files || [];
    if (!list.length) {
      box.innerHTML = '<div class="bk-empty"><strong>No package</strong>' +
        '服务器上还没有备份包。用上方「开始备份」生成第一个，或上传已有的 .tar.gz 直接恢复。</div>';
      return;
    }
    box.innerHTML = list.map(function (f) {
      return '<div class="bk-item bk-file">' +
        '<div class="bk-item-t"><div class="n">' + esc(f.name) + '</div>' +
          '<div class="m">' + esc(scopeLabel(f.scope)) + '</div></div>' +
        '<div class="sz">' + fmtSize(f.size) + '</div>' +
        '<div class="at">' + esc(fmtWhen(f.at)) + '</div>' +
        '<div class="bk-act">' +
          '<button type="button" class="bk-btn" data-bk-dl="' + esc(f.name) + '">下载</button>' +
          '<button type="button" class="bk-btn" data-bk-rs="' + esc(f.name) + '">恢复</button>' +
          '<button type="button" class="bk-btn danger" data-bk-fdel="' + esc(f.name) + '">删除</button>' +
        '</div>' +
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
    if (!list.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
    box.style.display = '';
    box.innerHTML = '<h3>最近记录</h3>' +
      list.map(function (r) {
        var kind = r.kind === 'restore' ? '恢复' : (r.kind === 'schedule' ? '定时' : '手动');
        return '<div class="bk-log-row">' +
          '<span>' + fmtWhen(r.at) + '</span>' +
          '<span class="k">' + kind + '</span>' +
          '<span class="d">' + esc(scopeLabel(r.scope)) + sep() +
            (r.ok ? '成功' : '<b class="fail">失败</b>') +
            (r.file ? sep() + esc(r.file) : '') +
            (r.detail ? sep() + esc(r.detail) : '') + '</span>' +
        '</div>';
      }).join('');
  }

  function renderProgress() {
    var el = byId('bkProg');
    if (!OV || !el) return;
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
    byId('bkGSecretLabel').textContent = auth === 'key' ? '私钥内容 · PEM' : '密码';
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
      return '<label class="bk-chip"><input type="checkbox" value="' + esc(g.id) + '"' + (on ? ' checked' : '') + '>' +
        '<span class="bk-chip-t">' + esc(g.name || g.host) + '<small>' + protoLabel(g.proto) + '</small></span></label>';
    }).join('');
    byId('bkTTargets').innerHTML = picks || '<span class="bk-note">暂无目标服务器</span>';
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
    style();
    var n = 0;
    var iv = setInterval(function () { ensureEntry(); if (++n > 3600) clearInterval(iv); }, 500);
    ensureEntry();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
