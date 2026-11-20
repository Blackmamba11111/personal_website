/* 运营中心（op.zdns.cn）项目技术信息 · admin 功能页（2026-11-20 / v2）
 *
 * 独立成文件：主页身体积接近守卫上限，本页只在超管使用时加载。
 * 依赖主页面 window.__opBridge 暴露的 api / esc / toast / fmtTs / isAdmin / users / vendor。
 *
 * 功能：选基准用户 → 按其台账客户名检索运营中心 → 分批拉取网络信息，
 *       按附件《项目信息梳理》口径展示（10 列，按项目合并 + 小计行），
 *       支持各字段检索与导出 xlsx；可开启定时拉取。
 */
(function () {
  'use strict';
  var B = null;
  var DATA = { owner: '', customers: [], failed: [], updatedAt: '', total: 0 };
  var RUNNING = false;

  /* 列宽取自附件《副本ZDNS项目信息v2-20261118.xlsx》（Excel 字符宽） */
  var COLS = [
    { k: 'idx', t: '序号', w: 9.62 },
    { k: 'name', t: '项目名称', w: 37.86 },
    { k: 'mainA', t: '维护人A', w: 14.5 },
    { k: 'mainB', t: '维护人B', w: 14.5 },
    { k: 'env', t: '网络环境', w: 35.89 },
    { k: 'product', t: '产品类型', w: 25.63 },
    { k: 'count', t: '数量', w: 7.85 },
    { k: 'version', t: '软件版本', w: 49.9 },
    { k: 'os', t: '操作系统', w: 44.39 },
    { k: 'module', t: '功能模块', w: 17.22 },
    { k: 'ha', t: '组网架构', w: 55.09 },
    { k: 'note', t: '备注', w: 26.56 }
  ];

  function style() {
    if (document.getElementById('opStyle')) return;
    var st = document.createElement('style');
    st.id = 'opStyle';
    st.textContent = '#opTable tr.sum-row td{background:#F5F8FE;font-weight:600;}' +
      '#opTable td{vertical-align:top;}' +
      '.prog-line{margin:10px 0 0;padding:9px 12px;border-radius:var(--r-sm);background:#F2F7FF;' +
      'color:var(--brand);font-size:12px;}';
    document.head.appendChild(st);
  }
  function bridge() { if (!B) B = window.__opBridge || null; return B; }
  function esc(s) { var b = bridge(); return b ? b.esc(s) : String(s == null ? '' : s); }
  function api(p, o) { var b = bridge(); return b ? b.api(p, o) : Promise.reject(new Error('桥接未就绪')); }
  function toast(m) { var b = bridge(); if (b) b.toast(m); }
  function fmtTs(s, noSec) { var b = bridge(); return b ? b.fmtTs(s, noSec) : (s || ''); }

  /* ---------- 页面骨架 ---------- */

  function page() {
    style();
    var el = document.getElementById('opView');
    if (el) return el;
    el = document.createElement('div');
    el.className = 'page';
    el.id = 'opView';
    el.innerHTML =
      '<div class="page-head">' +
      '<button type="button" class="btn" id="btnOpBack">← 返回看板</button>' +
      '<h2>项目技术信息</h2>' +
      '<span class="sub" id="opSub">运营中心 · 按基准用户台账客户名拉取</span>' +
      '<div class="spacer"></div>' +
      '<button type="button" class="btn" id="btnOpExport">导出 xlsx</button>' +
      '<button type="button" class="btn primary" id="btnOpRun">立即拉取</button>' +
      '</div>' +
      '<div class="page-body">' +
      '<div class="ucard">' +
      '<div class="m-caption">数据源与定时</div>' +
      '<div class="grid2" style="grid-template-columns:1fr 1fr 140px;gap:10px;">' +
      '<div class="field"><label>基准用户（按其台账客户名检索）</label><select id="opOwner"></select>' +
      '<div class="hint" id="opOwnerHint">切换用户后点「立即拉取」重新抓取。</div></div>' +
      '<div class="field"><label>定时拉取</label>' +
      '<label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:12px;">' +
      '<input type="checkbox" id="opAuto"> 按间隔自动拉取</label>' +
      '<div class="hint" id="opAutoHint">开启后按下方间隔在后台拉取，结果覆盖展示。</div></div>' +
      '<div class="field"><label>间隔（小时）</label><input type="number" id="opInterval" min="1" max="720" step="1" value="12"></div>' +
      '</div>' +
      '<div class="field"><label>运营中心访问令牌（AccessToken）</label>' +
      '<textarea id="opToken" placeholder="登录 op.zdns.cn 后在控制台执行 copy(localStorage.AccessToken)，粘贴到这里" ' +
      'style="width:100%;min-height:64px;padding:8px 10px;border:1px solid var(--line);border-radius:var(--r-sm);' +
      'font-family:var(--font-mono);font-size:11.5px;"></textarea>' +
      '<div class="hint" id="opTokenState">未配置</div></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      '<button type="button" class="btn" id="btnOpSave">保存配置</button>' +
      '<button type="button" class="btn" id="btnOpTest">测试连通性</button>' +
      '<span class="hint" id="opTestOut" style="align-self:center;"></span></div>' +
      '</div>' +
      '<div class="prog-line" id="opProg" style="display:none;"></div>' +
      '<div class="ucard" style="margin-top:12px;">' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">' +
      '<div class="m-caption" style="margin:0;">项目信息（<span id="opCount">0</span> 个项目 / <span id="opRows">0</span> 行）</div>' +
      '<div class="spacer" style="flex:1 1 auto;"></div>' +
      '<select id="opField" style="width:150px;">' +
      '<option value="all">全部字段</option><option value="name">项目名称</option>' +
      '<option value="mainA">维护人A</option><option value="mainB">维护人B</option>' +
      '<option value="env">网络环境</option><option value="product">产品类型</option>' +
      '<option value="version">软件版本</option><option value="os">操作系统</option>' +
      '<option value="module">功能模块</option><option value="ha">组网架构</option>' +
      '<option value="note">备注</option></select>' +
      '<input type="text" id="opQ" placeholder="检索关键词" autocomplete="off" style="width:200px;">' +
      '<span class="hint" id="opSyncAt"></span>' +
      '</div>' +
      '<div class="scroll-x" style="width:100%;"><table class="mini" id="opTable">' +
      '<thead><tr>' + COLS.map(function (c) { return '<th>' + c.t + '</th>'; }).join('') + '</tr></thead>' +
      '<tbody></tbody></table></div>' +
      '<div class="hint" id="opFailed" style="margin-top:10px;"></div>' +
      '</div>' +
      '</div>';
    document.body.appendChild(el);
    el.querySelector('#btnOpBack').addEventListener('click', function () { close(); });
    el.querySelector('#btnOpRun').addEventListener('click', function () { start(true); });
    el.querySelector('#btnOpExport').addEventListener('click', exportXlsx);
    el.querySelector('#btnOpSave').addEventListener('click', saveCfg);
    el.querySelector('#btnOpTest').addEventListener('click', testCfg);
    el.querySelector('#opOwner').addEventListener('change', onOwnerChange);
    el.querySelector('#opAuto').addEventListener('change', saveCfg);
    el.querySelector('#opInterval').addEventListener('change', saveCfg);
    el.querySelector('#opQ').addEventListener('input', render);
    el.querySelector('#opField').addEventListener('change', render);
    return el;
  }

  function open() {
    var el = page();
    el.classList.add('on');
    fillOwners();
    loadCfg();
    loadRows();
  }
  function close() { var el = document.getElementById('opView'); if (el) el.classList.remove('on'); }

  function fillOwners() {
    var b = bridge();
    var sel = document.getElementById('opOwner');
    if (!b || !sel || sel.getAttribute('data-filled') === '1') return;
    var users = (b.users() || []).filter(function (u) { return (u.status || 'active') === 'active'; });
    sel.innerHTML = users.map(function (u) {
      return '<option value="' + esc(u.username) + '">' + esc(u.name || u.username) +
        '（' + esc(u.username) + '）</option>';
    }).join('');
    sel.setAttribute('data-filled', '1');
  }

  /* ---------- 配置 ---------- */

  function loadCfg() {
    api('/op/config').then(function (r) {
      if (!r.ok || !r.data) { document.getElementById('opTokenState').textContent = r.error || '读取失败'; return; }
      var d = r.data;
      var sel = document.getElementById('opOwner');
      if (d.owner) sel.value = d.owner;
      DATA.owner = sel.value || d.owner || '';
      document.getElementById('opAuto').checked = !!d.auto;
      document.getElementById('opInterval').value = d.intervalHours || 12;
      document.getElementById('opToken').value = '';
      var st = document.getElementById('opTokenState');
      var out = document.getElementById('opTestOut');
      if (!d.configured) { st.textContent = '未配置：请粘贴访问令牌后保存'; st.style.color = 'var(--danger-ink)'; }
      else {
        var left = Math.max(0, Math.round((d.leftSec || 0) / 60));
        st.textContent = '已配置（账号：' + (d.username || '—') + '），' +
          (d.leftSec > 0 ? '剩余 ' + Math.floor(left / 60) + ' 小时 ' + (left % 60) + ' 分' : '已过期，请重新粘贴');
        st.style.color = d.leftSec > 0 ? '' : 'var(--danger-ink)';
      }
      if (d.progress) {
        showProg('正在拉取：' + d.progress.idx + ' / ' + d.progress.total + ' 个客户');
      } else document.getElementById('opProg').style.display = 'none';
      if (d.lastSyncAt) document.getElementById('opSyncAt').textContent = '上次同步 ' + fmtTs(d.lastSyncAt, true);
      out.textContent = '';
    });
  }

  function saveCfg() {
    var body = {
      auto: document.getElementById('opAuto').checked,
      intervalHours: Number(document.getElementById('opInterval').value) || 12,
      owner: document.getElementById('opOwner').value || ''
    };
    var tk = document.getElementById('opToken').value.trim();
    if (tk) body.token = tk;
    api('/op/config', { method: 'PUT', body: body }).then(function (r) {
      if (!r.ok) { toast(r.error || '保存失败'); return; }
      if (tk) document.getElementById('opToken').value = '';
      toast('配置已保存');
      loadCfg();
    });
  }

  function testCfg() {
    var out = document.getElementById('opTestOut');
    var tk = document.getElementById('opToken').value.trim();
    var body = { keyword: '中国银行' };
    if (tk) body.token = tk;
    out.style.color = '';
    out.textContent = '测试中…';
    api('/op/test', { method: 'POST', body: body }).then(function (r) {
      if (!r.ok || !r.data) { out.textContent = r.error || '测试失败'; out.style.color = 'var(--danger-ink)'; return; }
      if (r.data.ok) {
        out.style.color = 'var(--ok-ink)';
        out.textContent = r.data.message + '：' + (r.data.sample || []).join('、');
      } else {
        out.style.color = 'var(--danger-ink)';
        out.textContent = '失败（' + (r.data.code || '') + '）：' + (r.data.message || '');
      }
    });
  }

  function onOwnerChange() {
    DATA.owner = document.getElementById('opOwner').value || '';
    saveCfg();
    loadRows();
  }

  /* ---------- 拉取 ---------- */

  function showProg(text) {
    var el = document.getElementById('opProg');
    el.style.display = 'block';
    el.textContent = text;
  }

  function start(reset) {
    if (RUNNING) { toast('上一轮拉取仍在进行'); return; }
    var owner = document.getElementById('opOwner').value;
    if (!owner) { toast('请先选择基准用户'); return; }
    RUNNING = true;
    DATA.owner = owner;
    var btn = document.getElementById('btnOpRun');
    btn.disabled = true;
    var guard = 0;
    (function step(first) {
      if (guard++ > 60) { RUNNING = false; btn.disabled = false; toast('拉取批次数超限，请稍后重试'); return; }
      showProg('正在拉取…');
      api('/op/run', { method: 'POST', body: { owner: owner, reset: first && reset } }).then(function (r) {
        if (!r.ok || !r.data) {
          RUNNING = false; btn.disabled = false;
          showProg('拉取失败：' + (r.error || '未知错误'));
          return;
        }
        var d = r.data;
        if (!d.ok) { RUNNING = false; btn.disabled = false; showProg(d.message || '拉取失败'); return; }
        showProg('正在拉取：' + d.processed + ' / ' + d.total + ' 个客户（已成功 ' + d.customers + '，失败 ' + d.failed + '）');
        if (!d.done) { step(false); return; }
        RUNNING = false; btn.disabled = false;
        showProg('拉取完成：' + d.customers + ' 个项目，' + d.failed + ' 个未匹配');
        loadRows();
        loadCfg();
      }, function () {
        RUNNING = false; btn.disabled = false;
        showProg('请求未送达服务端');
      });
    })(true);
  }

  function loadRows() {
    var owner = document.getElementById('opOwner').value || DATA.owner;
    if (!owner) return;
    api('/op/rows?owner=' + encodeURIComponent(owner)).then(function (r) {
      if (!r.ok || !r.data) return;
      DATA = {
        owner: owner, customers: r.data.customers || [], failed: r.data.failed || [],
        updatedAt: r.data.updatedAt, total: r.data.total || 0
      };
      render();
    });
  }

  /* ---------- 渲染（前端字段检索，与后端同一套键） ---------- */

  /* 客户级字段（项目名 / 维护人A / 维护人B）不属于设备行，需单独取值 */
  var CUST_KEYS = ['name', 'mainA', 'mainB'];
  var ROW_KEYS = ['env', 'product', 'version', 'os', 'module', 'ha', 'note'];

  function filtered() {
    var q = (document.getElementById('opQ').value || '').trim().toLowerCase();
    var field = document.getElementById('opField').value || 'all';
    if (!q) return DATA.customers;
    var hit = function (r, c) {
      var pick = function (k) {
        return CUST_KEYS.indexOf(k) >= 0 ? String(c[k] || '') : String(r[k] || '');
      };
      if (field === 'all') {
        return CUST_KEYS.concat(ROW_KEYS).some(function (k) { return pick(k).toLowerCase().indexOf(q) >= 0; });
      }
      return pick(field).toLowerCase().indexOf(q) >= 0;
    };
    return DATA.customers.map(function (c) {
      var rows = (c.rows || []).filter(function (r) { return hit(r, c); });
      if (!rows.length) return null;
      return { name: c.name, accountName: c.accountName, mainA: c.mainA, mainB: c.mainB, rows: rows,
        total: rows.reduce(function (s, r) { return s + (Number(r.count) || 0); }, 0) };
    }).filter(Boolean);
  }

  function render() {
    var tbody = document.querySelector('#opTable tbody');
    if (!tbody) return;
    var list = filtered();
    var html = [];
    var rowN = 0;
    list.forEach(function (c, ci) {
      var rows = c.rows || [];
      rows.forEach(function (r, ri) {
        rowN++;
        html.push('<tr>' +
          (ri === 0 ? '<td rowspan="' + rows.length + '" class="mono">' + (ci + 1) + '</td>' +
            '<td rowspan="' + rows.length + '"><b>' + esc(c.name) + '</b></td>' +
            '<td rowspan="' + rows.length + '">' + esc(c.mainA || '—') + '</td>' +
            '<td rowspan="' + rows.length + '">' + esc(c.mainB || '—') + '</td>' : '') +
          '<td>' + esc(r.env || '—') + '</td><td>' + esc(r.product || '—') +
          '</td><td class="mono">' + esc(r.count == null ? '—' : r.count) + '</td>' +
          '<td class="mono">' + esc(r.version || '—') + '</td><td>' + esc(r.os || '—') +
          '</td><td>' + esc(r.module || '—') + '</td><td>' + esc(r.ha || '—') +
          '</td><td>' + esc(r.note || '') + '</td></tr>');
      });
      html.push('<tr class="sum-row"><td colspan="4" style="text-align:center;">小计</td>' +
        '<td></td><td></td><td class="mono"><b>' + c.total + '</b></td>' +
        '<td colspan="5"></td></tr>');
    });
    if (!rowN) {
      html.push('<tr><td colspan="12" style="text-align:center;color:var(--ink-3);padding:18px 0;">' +
        '还没有数据：配置令牌后点「立即拉取」</td></tr>');
    }
    tbody.innerHTML = html.join('');
    document.getElementById('opCount').textContent = list.length;
    document.getElementById('opRows').textContent = rowN;
    document.getElementById('opSyncAt').textContent = DATA.updatedAt ? '数据时间 ' + fmtTs(DATA.updatedAt, true) : '';
    var f = document.getElementById('opFailed');
    if (DATA.failed && DATA.failed.length) {
      f.style.color = 'var(--danger-ink)';
      f.textContent = '未匹配 / 失败 ' + DATA.failed.length + ' 个：' +
        DATA.failed.map(function (x) { return x.name + '（' + x.message + '）'; }).join('；');
    } else { f.textContent = ''; f.style.color = ''; }
  }

  /* ---------- 导出 xlsx（严格复刻《副本ZDNS项目信息v2》样式） ---------- */

  var XJS_SRC = 'assets/vendor/xlsx-js-style.min.js';
  var xjsP = null;

  /* 加载可写样式的表格库；加载完成后还原 window.XLSX，
     避免覆盖主看板附件预览正在用的 SheetJS。 */
  function loadXjs() {
    if (xjsP) return xjsP;
    /* 测试钩子：直接注入库，跳过脚本加载 */
    if (window.__opXjsLib) {
      xjsP = window.__opXjsLib.utils
        ? Promise.resolve(window.__opXjsLib)
        : Promise.reject(new Error('导出组件不可用'));
      return xjsP;
    }
    xjsP = new Promise(function (resolve, reject) {
      var prev = window.XLSX;
      var s = document.createElement('script');
      s.src = XJS_SRC;
      s.async = true;
      s.onload = function () {
        var lib = window.XLSX;
        try { if (prev) window.XLSX = prev; else delete window.XLSX; } catch (e) {}
        if (lib && lib.utils) resolve(lib); else reject(new Error('表格组件不可用'));
      };
      s.onerror = function () {
        try { if (prev) window.XLSX = prev; } catch (e) {}
        reject(new Error('表格组件加载失败'));
      };
      document.head.appendChild(s);
    });
    return xjsP;
  }

  var FONT = '微软雅黑';
  var HEAD_FILL = 'FF4472C4', HEAD_FONT = 'FFFFFFFF';
  var KEY_FILL = 'FFC9D9F0', KEY_FONT = 'FF1F3864';   /* 序号/项目名/维护人 A、B 列 */
  var ROW_FILL = 'FFE9F0FB', ROW_FONT = 'FF1A1A1A';   /* 其余设备列 */
  var LINE_RGB = 'FFB4B4B4';
  /* 附件中每个项目的小计行按 蓝→绿→橙→紫 轮换 */
  var SUM_FILLS = [
    { font: 'FF1F3864', fill: 'FFB4C7E7' },
    { font: 'FF375623', fill: 'FFC6E0B4' },
    { font: 'FF833C00', fill: 'FFF4C79A' },
    { font: 'FF3F3151', fill: 'FFCFC2E6' }
  ];

  function borderAll() {
    var b = { style: 'thin', color: { rgb: LINE_RGB } };
    return { top: b, bottom: b, left: b, right: b };
  }

  /* 按附件口径构造工作表（纯函数，便于回归测试） */
  function buildSheet(X, list) {
    var aoa = [COLS.map(function (c) { return c.t; })];
    var merges = [];
    var sumRows = [];
    list.forEach(function (c, ci) {
      var rows = c.rows || [];
      var start = aoa.length;            /* 0 基首行下标 */
      rows.forEach(function (r, ri) {
        aoa.push([
          ri === 0 ? (ci + 1) : '',
          ri === 0 ? c.name : '',
          ri === 0 ? (c.mainA || '') : '',
          ri === 0 ? (c.mainB || '') : '',
          r.env || '', r.product || '', Number(r.count) || 0,
          r.version || '', r.os || '', r.module || '', r.ha || '', r.note || ''
        ]);
      });
      /* 客户级四列纵向合并：序号 / 项目名称 / 维护人A / 维护人B */
      if (rows.length > 1) {
        for (var col = 0; col < 4; col++) {
          merges.push({ s: { r: start, c: col }, e: { r: start + rows.length - 1, c: col } });
        }
      }
      aoa.push(['小计', '', '', '', '', '', c.total, '', '', '', '', '']);
      var sr = aoa.length - 1;
      merges.push({ s: { r: sr, c: 0 }, e: { r: sr, c: 3 } });
      sumRows.push({ r: sr, from: start, to: start + rows.length - 1, ci: ci });
    });

    var ws = X.utils.aoa_to_sheet(aoa);
    ws['!merges'] = merges;
    /* 附件列宽是 Excel 字符宽；SheetJS 的 wch 口径比之多 0.83 */
    ws['!cols'] = COLS.map(function (c) { return { wch: Math.max(6, c.w - 0.83) }; });
    ws['!rows'] = aoa.map(function (_, i) { return { hpt: i === 0 ? 34 : 16.8 }; });

    /* 表头：微软雅黑 11 加粗白字 / 4472C4 底 / 居中换行 / 细边框 */
    COLS.forEach(function (_, ci) {
      var cell = ws[X.utils.encode_cell({ r: 0, c: ci })];
      if (!cell) return;
      cell.s = {
        font: { name: FONT, sz: 11, bold: true, color: { rgb: HEAD_FONT } },
        fill: { patternType: 'solid', fgColor: { rgb: HEAD_FILL } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: borderAll()
      };
    });

    var sumAt = {};
    sumRows.forEach(function (x) { sumAt[x.r] = x; });

    for (var i = 1; i < aoa.length; i++) {
      var sum = sumAt[i];
      var sc = SUM_FILLS[(sum ? sum.ci : 0) % SUM_FILLS.length];
      for (var j = 0; j < COLS.length; j++) {
        var ad = X.utils.encode_cell({ r: i, c: j });
        var cell = ws[ad] || (ws[ad] = { t: 's', v: '' });
        if (sum) {
          cell.s = {
            font: { name: FONT, sz: 11, bold: true, color: { rgb: sc.font } },
            fill: { patternType: 'solid', fgColor: { rgb: sc.fill } },
            alignment: { horizontal: 'center', vertical: 'center' },
            border: borderAll()
          };
          continue;
        }
        var isKey = j <= 3;
        var isNote = j === 11;          /* 备注列：附件中为宋体、无底色、不设字色 */
        var fnt = { name: isNote ? '宋体' : FONT, sz: 11, bold: isKey && j === 1 };
        if (!isNote) fnt.color = { rgb: isKey ? KEY_FONT : ROW_FONT };
        var st = {
          font: fnt,
          alignment: { horizontal: (isKey || isNote || j === 6) ? 'center' : 'left',
            vertical: 'center', wrapText: !isNote && j !== 6 },
          border: borderAll()
        };
        if (!isNote) st.fill = { patternType: 'solid', fgColor: { rgb: isKey ? KEY_FILL : ROW_FILL } };
        cell.s = st;
        if (j === 6) cell.z = '0';
      }
    }

    /* 小计数量写成公式，与附件一致：=SUM(该组数量列) */
    sumRows.forEach(function (x) {
      var ad = X.utils.encode_cell({ r: x.r, c: 6 });
      var old = ws[ad];
      ws[ad] = { t: 'n', v: x.total, f: 'SUM(G' + (x.from + 1) + ':G' + (x.to + 1) + ')', s: old ? old.s : undefined };
    });

    return ws;
  }

  function exportXlsx() {
    var list = filtered();
    if (!list.length) { toast('没有可导出的数据'); return; }
    var btn = document.getElementById('btnOpExport');
    btn.disabled = true;
    loadXjs().then(function (X) {
      var ws = buildSheet(X, list);
      var wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, ws, '项目信息梳理');
      var name = '项目信息-' + (DATA.owner || 'export') + '-' + stamp() + '.xlsx';
      X.writeFile(wb, name);
      toast('已导出 ' + name);
      btn.disabled = false;
    }, function (e) {
      btn.disabled = false;
      toast((e && e.message) || '导出组件加载失败');
    });
  }

  function stamp() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  /* ---------- 装配 ---------- */

  /* 入口：账号菜单（admin 区）里「CRM 台账关联」之后。
     按钮动态插入而不是写进主页面 HTML —— 主页身体积贴着 614400B 守卫上限，
     且本文件只在需要时才被浏览器加载。 */
  function ensureEntry() {
    var b = bridge();
    var menu = document.getElementById('userMenu');
    if (!menu) return;
    var btn = document.getElementById('umOp');
    if (!btn) {
      var ref = document.getElementById('umCrm');
      if (!ref || !ref.parentNode) return;
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'umOp';
      btn.textContent = '项目技术信息';
      btn.addEventListener('click', function () {
        menu.classList.remove('on');
        open();
      });
      ref.parentNode.insertBefore(btn, ref.nextSibling);
    }
    /* 每个 tick 同步显隐：菜单每次渲染只会重置 umCrm 的 display，不会管这一项 */
    btn.style.display = (b && b.isAdmin()) ? 'block' : 'none';
  }

  function tick() { ensureEntry(); }
  /* 导出构造器暴露给回归测试（纯函数，无副作用） */
  window.__opBuildSheet = buildSheet;
  function boot() {
    var n = 0;
    var iv = setInterval(function () { tick(); if (++n > 3600) clearInterval(iv); }, 500);
    tick();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
