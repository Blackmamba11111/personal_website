/* ============================================================
   doc97.js —— Word 97-2003（.doc / .wps）浏览器端解析器
   目标：像 docx 走 mammoth 那样，纯前端把二进制文档还原成可读 HTML。
   · 复合文档（OLE2 / CFB）流读取，零依赖
   · FIB + 片段表（CLX / PlcPcd）取正文（含 1 字节压缩与 UTF-16 两种片段）
   · CHPX / PAPX 属性页还原粗体、斜体、下划线、删除线、上下标、字号、颜色
   · 按 0x07 单元格标记 + fTtp 行结束标记还原表格
   · 内嵌图片按 PNG / JPEG / GIF / BMP 魔数尽力提取
   · 解析不了（如 WPS 2000 私有格式）时退回「文本抽取」，至少能看到文字
   对外接口：window.DOC97.toHtml(arrayBuffer) -> { html, warn }
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- 小工具 ---------------- */
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function s16(b, o) { var v = u16(b, o); return v > 0x7FFF ? v - 0x10000 : v; }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000; }
  function s32(b, o) { var v = u32(b, o); return v > 0x7FFFFFFF ? v - 0x100000000 : v; }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function utf16(b, o, n) {
    var out = '';
    for (var i = 0; i + 1 < n; i += 2) out += String.fromCharCode(u16(b, o + i));
    return out;
  }
  function b64(u8) {
    var s = '', i;
    for (i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    if (typeof global.btoa === 'function') return global.btoa(s);
    if (typeof Buffer !== 'undefined') return Buffer.from(s, 'binary').toString('base64');
    return '';
  }

  /* Windows-1252 高位字符（1 字节压缩片段用） */
  var CP1252 = {
    0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020,
    0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152,
    0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022,
    0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A,
    0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178
  };

  /* ---------------- 复合文档（CFB / OLE2） ---------------- */
  function readCFB(buf) {
    var u8 = new Uint8Array(buf);
    if (u32(u8, 0) !== 0xE011CFD0 || u32(u8, 4) !== 0xE11AB1A1) return null;   /* D0CF11E0 A1B11AE1 */
    var secSize = 1 << u16(u8, 30);
    var miniSize = 1 << u16(u8, 32);
    var dirStart = u32(u8, 48);
    var miniCut = u32(u8, 56);
    var miniFatStart = u32(u8, 60);
    var difatStart = u32(u8, 68);
    var secOff = function (s) { return (s + 1) * secSize; };

    /* DIFAT → FAT 扇区列表 */
    var fatSecs = [], i, v;
    for (i = 0; i < 109; i++) {
      v = u32(u8, 76 + i * 4);
      if (v === 0xFFFFFFFF) break;
      fatSecs.push(v);
    }
    var ds = difatStart, guard = 0;
    while (ds !== 0xFFFFFFFE && ds !== 0xFFFFFFFF && guard++ < 4096) {
      var o = secOff(ds), per = secSize / 4 - 1;
      for (i = 0; i < per; i++) {
        v = u32(u8, o + i * 4);
        if (v !== 0xFFFFFFFF) fatSecs.push(v);
      }
      ds = u32(u8, o + secSize - 4);
    }
    var fat = [];
    fatSecs.forEach(function (s) {
      var off = secOff(s);
      for (var k = 0; k < secSize / 4; k++) fat.push(u32(u8, off + k * 4));
    });

    function chain(start, table) {
      var out = [], s = start, g = 0;
      while (s !== 0xFFFFFFFE && s !== 0xFFFFFFFF && s !== undefined && g++ < 200000) {
        out.push(s);
        s = table[s];
      }
      return out;
    }
    function readSectors(start) {
      var secs = chain(start, fat), out = new Uint8Array(secs.length * secSize), p = 0;
      secs.forEach(function (s) {
        var off = secOff(s);
        if (off + secSize > u8.length) return;
        out.set(u8.subarray(off, off + secSize), p);
        p += secSize;
      });
      return out.subarray(0, p);
    }

    /* 目录 */
    var dirBytes = readSectors(dirStart);
    var entries = [], n = Math.floor(dirBytes.length / 128);
    for (i = 0; i < n; i++) {
      var base = i * 128;
      var nameLen = u16(dirBytes, base + 64);
      var nm = nameLen > 2 ? utf16(dirBytes, base, nameLen - 2) : '';
      entries.push({
        name: nm,
        type: dirBytes[base + 66],
        start: u32(dirBytes, base + 116),
        size: u32(dirBytes, base + 120)
      });
    }

    /* 迷你流（< 4096 字节的流存放在根项里） */
    var miniFat = null, miniStream = null;
    function ensureMini() {
      if (miniFat) return;
      miniFat = [];
      if (miniFatStart !== 0xFFFFFFFE && miniFatStart !== 0xFFFFFFFF) {
        var mb = readSectors(miniFatStart);
        for (var k = 0; k + 3 < mb.length; k += 4) miniFat.push(u32(mb, k));
      }
      var root = entries[0];
      miniStream = root ? readSectors(root.start).subarray(0, root.size) : new Uint8Array(0);
    }
    function stream(name) {
      var e = null;
      for (var k = 0; k < entries.length; k++) {
        if (entries[k].name === name && entries[k].type === 2) { e = entries[k]; break; }
      }
      if (!e) return null;
      if (e.size >= miniCut || e.size === 0) return readSectors(e.start).subarray(0, e.size);
      ensureMini();
      var secs = chain(e.start, miniFat);
      var out = new Uint8Array(e.size), p = 0;
      for (var j = 0; j < secs.length && p < e.size; j++) {
        var off = secs[j] * miniSize;
        var len = Math.min(miniSize, e.size - p);
        if (off + len > miniStream.length) len = Math.max(0, miniStream.length - off);
        if (len <= 0) break;
        out.set(miniStream.subarray(off, off + len), p);
        p += len;
      }
      return out.subarray(0, p);
    }
    return { stream: stream, names: entries.map(function (x) { return x.name; }) };
  }

  /* ---------------- 属性页（FKP） ---------------- */
  /* 每个属性页 512 字节：末尾是条目数，开头是 (crun+1) 个 FC 边界，
     中间是按偏移指向的 grpprl。这里展开成按 FC 排序的区间表。
     注意：PLC 本身在 Table 流里，而属性页（FKP）在 WordDocument 流里 —— 两个流别混用。 */
  function chpxTable(wd, table, fcPlc, lcbPlc) {
    return plcPages(wd, table, fcPlc, lcbPlc, function (page, off, crun, i, fcStart, fcEnd) {
      var base = 4 * (crun + 1);
      var b = page[off + base + i];
      var sprms = null;
      if (b) {
        var so = off + b * 2;
        var cb = page[so];
        if (so + 1 + cb <= off + 511) sprms = page.subarray(so + 1, so + 1 + cb);
      }
      return { fcStart: fcStart, fcEnd: fcEnd, sprms: sprms };
    });
  }
  function papxTable(wd, table, fcPlc, lcbPlc) {
    return plcPages(wd, table, fcPlc, lcbPlc, function (page, off, crun, i, fcStart, fcEnd) {
      var base = 4 * (crun + 1);
      var w = page[off + base + i * 13] | (page[off + base + i * 13 + 1] << 8);
      var sprms = null;
      if (w) {
        var po = off + w * 2;
        var cw = page[po];
        if (cw > 1) sprms = page.subarray(po + 3, po + 3 + (cw * 2 - 2));
      }
      return { fcStart: fcStart, fcEnd: fcEnd, sprms: sprms };
    });
  }
  function plcPages(wd, table, fcPlc, lcbPlc, readPage) {
    var out = [];
    if (!lcbPlc || fcPlc + lcbPlc > table.length) return out;
    var n = Math.floor((lcbPlc - 4) / 8);
    var pnBase = fcPlc + (n + 1) * 4;
    for (var p = 0; p < n; p++) {
      var pn = u32(table, pnBase + p * 4);
      if (pn === 0xFFFFFFFF || pn === 0) continue;
      var off = pn * 512;
      if (off + 512 > wd.length) continue;
      var page = wd.subarray(off, off + 512);
      var crun = page[511];
      if (!crun) continue;
      for (var i = 0; i < crun && i < 0xFF; i++) {
        var fcStart = u32(page, i * 4), fcEnd = u32(page, (i + 1) * 4);
        if (fcEnd <= fcStart) continue;
        var it = readPage(page, 0, crun, i, fcStart, fcEnd);
        if (it.sprms) out.push(it);
      }
    }
    out.sort(function (a, b) { return a.fcStart - b.fcStart; });
    return out;
  }
  function lookup(list, fc) {
    var lo = 0, hi = list.length - 1, best = null;
    while (lo <= hi) {
      var m = (lo + hi) >> 1;
      if (fc < list[m].fcStart) hi = m - 1;
      else if (fc >= list[m].fcEnd) lo = m + 1;
      else { best = list[m]; break; }
    }
    return best ? best.sprms : null;
  }

  /* ---------------- sprm 解析 ---------------- */
  var SPRM_LEN = [1, 1, 2, 4, 2, 2, 0, 3];
  function walkSprms(sprms, onSprm) {
    if (!sprms) return;
    var i = 0, n = sprms.length;
    while (i + 2 <= n) {
      var op = sprms[i] | (sprms[i + 1] << 8);
      i += 2;
      var spra = (op >> 13) & 7;
      var len;
      if (op === 0xD608 || op === 0xC615) {
        len = sprms[i] | (sprms[i + 1] << 8); i += 2;
      } else if (spra === 6) {
        var cb = sprms[i++];
        len = cb;
        if (cb === 255) { len = sprms[i] | (sprms[i + 1] << 8); i += 2; }
      } else {
        len = SPRM_LEN[spra];
      }
      if (i + len > n) break;
      onSprm(op, sprms, i, len);
      i += len;
    }
  }
  var COLOR_IDX = {
    1: '#000000', 2: '#0000FF', 3: '#00FFFF', 4: '#00FF00', 5: '#FF00FF', 6: '#FF0000',
    7: '#FFFF00', 8: '#FFFFFF', 9: '#000080', 10: '#008080', 11: '#008000', 12: '#800080',
    13: '#800000', 14: '#808000', 15: '#808080', 16: '#C0C0C0'
  };
  function applyChar(sprms, f) {
    walkSprms(sprms, function (op, b, i) {
      switch (op) {
        case 0x0835: f.bold = b[i] === 1 || b[i] === 0x81 ? b[i] === 1 : f.bold; break;
        case 0x0836: f.italic = b[i] === 1 || b[i] === 0x81 ? b[i] === 1 : f.italic; break;
        case 0x0837: f.strike = b[i] === 1 || b[i] === 0x81 ? b[i] === 1 : f.strike; break;
        case 0x2A53: f.strike = b[i] !== 0; break;
        case 0x2A3E: f.ul = b[i] !== 0; break;
        case 0x2A48: f.iss = b[i] === 1 ? 1 : (b[i] === 2 ? 2 : 0); break;
        case 0x4A43: f.size = (b[i] | (b[i + 1] << 8)) / 2; break;         /* 半磅 */
        case 0x2A42: f.color = COLOR_IDX[b[i]] || ''; break;
        case 0x6870: {
          var r = b[i], g = b[i + 1], bl = b[i + 2];
          if (b[i + 3] === 0xFF || !(r === 0 && g === 0 && bl === 0)) {
            f.color = 'rgb(' + r + ',' + g + ',' + bl + ')';
          }
          break;
        }
        case 0x0855: f.spec = b[i] === 1; break;
        case 0x6A03: f.pic = s32(b, i); break;
      }
    });
  }
  function applyPap(sprms, pap) {
    walkSprms(sprms, function (op, b, i) {
      switch (op) {
        case 0x2403: pap.jc = b[i]; break;                                  /* 0 左 1 中 2 右 3 两端 */
        case 0x2416: pap.inTable = b[i] === 1; break;
        case 0x2417: pap.ttp = b[i] === 1; break;
        case 0x840F: pap.left = s16(b, i); break;
        case 0x8411: pap.indent = s16(b, i); break;
        case 0x260A: pap.ilvl = b[i]; break;
        case 0x460B: pap.ilfo = b[i] | (b[i + 1] << 8); break;
      }
    });
  }

  /* ---------------- 片段表 → 正文字符 ---------------- */
  function pieceTable(words, table, fcClx, lcbClx) {
    if (!table || !lcbClx || fcClx + lcbClx > table.length) return null;
    var p = fcClx, end = fcClx + lcbClx, pcdt = null;
    while (p < end) {
      var t = table[p];
      if (t === 0x01) p += 3 + s16(table, p + 1);          /* Prc：属性修改，跳过 */
      else if (t === 0x02) { pcdt = { at: p + 5, len: s32(table, p + 1) }; break; }
      else break;
    }
    if (!pcdt) return null;
    var n = Math.floor((pcdt.len - 4) / 12);
    if (n <= 0) return null;
    var cps = [], pcdBase = pcdt.at + (n + 1) * 4, pieces = [];
    for (var i = 0; i <= n; i++) cps.push(u32(table, pcdt.at + i * 4));
    for (var j = 0; j < n; j++) {
      var fc = u32(table, pcdBase + j * 8 + 2);
      var comp = (fc & 0x40000000) !== 0;
      fc = fc & 0x3FFFFFFF;
      if (comp) fc = Math.floor(fc / 2);
      pieces.push({ cpStart: cps[j], cpEnd: cps[j + 1], fc: fc, comp: comp });
    }
    return pieces;
  }
  function charAt(words, pieces, cp) {
    var lo = 0, hi = pieces.length - 1;
    while (lo <= hi) {
      var m = (lo + hi) >> 1, p = pieces[m];
      if (cp < p.cpStart) hi = m - 1;
      else if (cp >= p.cpEnd) lo = m + 1;
      else {
        var off = cp - p.cpStart;
        if (p.comp) {
          var fc = p.fc + off;
          if (fc >= words.length) return null;
          var b = words[fc];
          return { ch: CP1252[b] || b, fc: fc };
        }
        var f2 = p.fc + off * 2;
        if (f2 + 1 >= words.length) return null;
        return { ch: u16(words, f2), fc: f2 };
      }
    }
    return null;
  }

  /* ---------------- 内嵌图片（尽力提取位图/PNG/JPEG） ---------------- */
  function findImage(data, fc) {
    if (!data || fc < 0 || fc + 8 > data.length) return null;
    var lcb = u32(data, fc);
    if (!lcb || lcb > 60 * 1024 * 1024) lcb = Math.min(data.length - fc, 4 * 1024 * 1024);
    var end = Math.min(data.length, fc + Math.max(lcb, 64));
    var start = fc, len = 0, mime = '';
    for (var i = fc; i + 4 < end; i++) {
      if (data[i] === 0x89 && data[i + 1] === 0x50 && data[i + 2] === 0x4E && data[i + 3] === 0x47) {
        var ie = -1;
        for (var k = i + 4; k + 3 < end; k++) {
          if (data[k] === 0x49 && data[k + 1] === 0x45 && data[k + 2] === 0x4E && data[k + 3] === 0x44) { ie = k + 8; break; }
        }
        start = i; len = ie > 0 ? ie - i : end - i; mime = 'image/png'; break;
      }
      if (data[i] === 0xFF && data[i + 1] === 0xD8 && data[i + 2] === 0xFF) {
        var je = -1;
        for (var k2 = i + 3; k2 + 1 < end; k2++) {
          if (data[k2] === 0xFF && data[k2 + 1] === 0xD9) je = k2 + 2;
        }
        if (je > 0) { start = i; len = je - i; mime = 'image/jpeg'; break; }
      }
      if (data[i] === 0x47 && data[i + 1] === 0x49 && data[i + 2] === 0x46 && data[i + 3] === 0x38) {
        start = i; len = end - i; mime = 'image/gif'; break;
      }
    }
    if (!mime || len <= 16) return null;
    return { src: 'data:' + mime + ';base64,' + b64(data.subarray(start, start + len)) };
  }

  /* ---------------- 正文 → 段落 / 表格 ---------------- */
  function buildBlocks(words, table, data, ccpText, chpxList, papxList) {
    var fcClx = u32(words, 0x01A2), lcbClx = u32(words, 0x01A6);
    var pieces = pieceTable(words, table, fcClx, lcbClx);
    if (!pieces) throw new Error('NO_PIECE_TABLE');

    var blocks = [];          /* {type:'p'|'cell'|'row', runs, pap} */
    var runs = [], curFmt = null, curText = '';
    var fieldState = 0;       /* 0 普通 1 域代码 2 域结果 */
    var paraStartFc = -1;

    function fmtKey(f) { return [f.bold, f.italic, f.ul, f.strike, f.iss, f.size, f.color].join('|'); }
    function flushRun() {
      if (curText && curFmt) runs.push({ t: curText, f: curFmt });
      curText = '';
    }
    function baseFmt(fc) {
      var f = { bold: false, italic: false, ul: false, strike: false, iss: 0, size: 0, color: '', spec: false, pic: -1 };
      var s = lookup(chpxList, fc);
      if (s) applyChar(s, f);
      return f;
    }
    function endParagraph(mark) {
      flushRun();
      var fc = paraStartFc >= 0 ? paraStartFc : 0;
      var pap = { jc: 0, inTable: false, ttp: false, left: 0, indent: 0 };
      var ps = lookup(papxList, fc);
      if (ps) applyPap(ps, pap);
      if (runs.length || pap.inTable || mark === 7) {
        blocks.push({
          type: mark === 7 ? 'cell' : 'p', runs: runs, pap: pap,
          ttp: pap.ttp, papFound: !!ps
        });
      }
      runs = []; paraStartFc = -1; curFmt = null; curText = '';
    }

    for (var cp = 0; cp < ccpText; cp++) {
      var c = charAt(words, pieces, cp);
      if (!c) break;
      var ch = c.ch;
      if (ch === 0x0D || ch === 0x07) {
        if (paraStartFc < 0) paraStartFc = c.fc;   /* 空段落：用结束标记自身的 FC 找属性 */
        endParagraph(ch);
        continue;
      }
      if (ch === 0x0C) { flushRun(); runs.push({ t: '', f: null, br: 'page' }); continue; }
      if (ch === 0x0B) { flushRun(); if (curFmt) curText = ''; runs.push({ t: '\n', f: null, br: 'line' }); continue; }
      if (ch === 0x13) { flushRun(); fieldState = 1; continue; }
      if (ch === 0x14) { flushRun(); fieldState = 2; continue; }
      if (ch === 0x15) { flushRun(); fieldState = 0; continue; }
      if (fieldState === 1) continue;
      if (ch === 0x01 || ch === 0x08) {
        /* 图片锚点：CHPX 里带 fcPicLocation 时尽力取出图片 */
        flushRun();
        var pf = baseFmt(c.fc);
        if (pf.pic >= 0) {
          var img = findImage(data, pf.pic);
          if (img) runs.push({ t: '', f: null, img: img.src });
        }
        continue;
      }
      if (ch === 0x05 || ch === 0x02 || ch === 0x1F) continue;      /* 批注/脚注引用/软连字符 */
      if (paraStartFc < 0) paraStartFc = c.fc;
      var fmt = baseFmt(c.fc);
      var txt = ch === 0x09 ? '\u00a0\u00a0\u00a0\u00a0'      /* 制表符 */
        : ch === 0x1E ? '-' : (ch === 0xA0 ? '\u00a0' : String.fromCharCode(ch));
      var key = fmtKey(fmt);
      if (!curFmt) { curFmt = fmt; curText = txt; }
      else if (key === fmtKey(curFmt)) curText += txt;
      else { flushRun(); curFmt = fmt; curText = txt; }
    }
    if (runs.length) endParagraph(0x0D);
    return blocks;
  }

  /* ---------------- 段落 / 表格 → HTML ---------------- */
  function runHtml(run, baseSize) {
    if (run.img) return '<img class="doc97-img" src="' + run.img + '" alt="">';
    if (run.br) return run.br === 'page' ? '<br class="doc97-pb">' : '<br>';
    var t = esc(run.t).replace(/\n/g, '<br>');
    var f = run.f || {};
    if (f.iss === 1) t = '<sup>' + t + '</sup>';
    else if (f.iss === 2) t = '<sub>' + t + '</sub>';
    if (f.ul) t = '<u>' + t + '</u>';
    if (f.strike) t = '<s>' + t + '</s>';
    if (f.italic) t = '<i>' + t + '</i>';
    if (f.bold) t = '<b>' + t + '</b>';
    if (f.color) t = '<span style="color:' + f.color + '">' + t + '</span>';
    /* 只在与正文字号不同时才写字号，避免整篇被 span 包一层 */
    if (f.size && Math.abs(f.size - baseSize) >= 0.5) {
      t = '<span style="font-size:' + f.size + 'pt">' + t + '</span>';
    }
    return t;
  }
  function paraHtml(runs, pap, inCell, baseSize) {
    var st = [];
    if (pap && pap.jc === 1) st.push('text-align:center');
    else if (pap && pap.jc === 2) st.push('text-align:right');
    else if (pap && pap.jc === 3) st.push('text-align:justify');
    if (pap && pap.left) st.push('margin-left:' + Math.round(pap.left / 20) + 'pt');
    if (pap && pap.indent) st.push('text-indent:' + Math.round(pap.indent / 20) + 'pt');
    var inner = runs.map(function (r) { return runHtml(r, baseSize); }).join('');
    var tag = inCell ? 'div' : 'p';
    return '<' + tag + ' class="doc97-p"' + (st.length ? ' style="' + st.join(';') + '"' : '') + '>' +
      (inner || '&nbsp;') + '</' + tag + '>';
  }
  function baseSizeOf(blocks) {
    var stat = {}, best = 10.5, bestN = 0;
    blocks.forEach(function (b) {
      (b.runs || []).forEach(function (r) {
        if (!r.f || !r.f.size) return;
        var n = (stat[r.f.size] = (stat[r.f.size] || 0) + String(r.t || '').length);
        if (n > bestN) { bestN = n; best = r.f.size; }
      });
    });
    return best;
  }
  function blocksToHtml(blocks) {
    var out = [], tableBuf = '', rowBuf = [], cellBuf = [], inTable = false;
    var baseSize = baseSizeOf(blocks);
    function closeTable() {
      if (cellBuf.length) cellBuf = [];
      if (rowBuf.length) { tableBuf += '<tr>' + rowBuf.join('') + '</tr>'; rowBuf = []; }
      if (tableBuf) out.push('<table class="doc97-tb">' + tableBuf + '</table>');
      tableBuf = ''; inTable = false;
    }
    function flushCell() {
      if (!cellBuf.length) return;
      var filled = cellBuf.filter(function (r) { return r.runs && r.runs.length; });
      var use = filled.length ? filled : cellBuf.slice(0, 1);
      rowBuf.push('<td>' + use.map(function (r) { return paraHtml(r.runs, r.pap, true, baseSize); }).join('') + '</td>');
      cellBuf = [];
    }
    function flushRow() {
      if (rowBuf.length) { tableBuf += '<tr>' + rowBuf.join('') + '</tr>'; rowBuf = []; }
    }
    blocks.forEach(function (b) {
      if (b.type === 'cell') {
        if (b.ttp) {                       /* 行结束标记本身不是单元格 */
          flushCell();
          flushRow();
          inTable = true;
          return;
        }
        /* 部分生成器写出的文档没有 fTtp，而是用「空单元格」收尾一行：
           本行已积累到 2 个以上单元格时，空单元格视为行结束而不是真单元格 */
        var empty = !(b.runs && b.runs.some(function (r) { return r.t && r.t.trim(); }));
        if (empty && rowBuf.length >= 2) { flushRow(); inTable = true; return; }
        cellBuf.push(b);
        flushCell();
        inTable = true;
        return;
      }
      /* 普通段落：属性缺失（同一属性页被多个段落共用）时沿用「是否在表格内」的上下文 */
      var isCellPara = b.papFound ? !!(b.pap && b.pap.inTable) : inTable;
      if (isCellPara && inTable && !b.ttp) { cellBuf.push(b); return; }
      closeTable();
      out.push(paraHtml(b.runs, b.pap, false, baseSize));
      inTable = false;
    });
    closeTable();
    return out.join('');
  }

  /* ---------------- 兜底：纯文本抽取 ---------------- */
  function fallbackText(u8) {
    var out = [], buf = '', i;
    for (i = 0; i + 1 < u8.length; i += 2) {
      var c = u8[i] | (u8[i + 1] << 8);
      var ok = (c >= 0x20 && c <= 0xD7FF) || (c >= 0xE000 && c <= 0xFFFD) ||
        c === 0x0D || c === 0x0A || c === 0x09;
      if (ok) { buf += String.fromCharCode(c); }
      else {
        if (buf.length >= 4) out.push(buf);
        buf = '';
      }
    }
    if (buf.length >= 4) out.push(buf);
    var txt = out.join('\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/[ \t]{2,}/g, ' ').trim();
    if (!txt) return '';
    return txt.split(/\r?\n/).map(function (line) {
      return '<p class="doc97-p">' + esc(line.trim()) + '</p>';
    }).join('');
  }

  /* ---------------- 主入口 ---------------- */
  function toHtml(arrayBuffer) {
    var cfb = readCFB(arrayBuffer);
    if (!cfb) throw new Error('文件不是 Word 97-2003 二进制格式');
    var wd = cfb.stream('WordDocument');
    if (!wd || wd.length < 512) {
      throw new Error('文档缺少 WordDocument 数据流');
    }
    var wIdent = u16(wd, 0);
    var flags = u16(wd, 0x0A);
    var tableName = (flags & 0x0200) ? '1Table' : '0Table';
    var table = cfb.stream(tableName) || cfb.stream('1Table') || cfb.stream('0Table');
    var data = cfb.stream('Data');

    if (wIdent !== 0xA5EC) {
      /* WPS 2000 等私有格式：尽力抽文字，让用户至少能看到内容 */
      var fb = fallbackText(new Uint8Array(arrayBuffer));
      if (fb) return { html: fb, warn: '该文件为旧版 WPS 格式，已尽量提取文字内容，版面可能有偏差' };
      throw new Error('无法识别的文档格式（既不是 Word 97-2003，也不是 OOXML）');
    }
    var nFib = u16(wd, 2);
    if (nFib < 101 || !table) throw new Error('文档结构不完整，无法解析');

    var ccpText = s32(wd, 0x4C);
    if (ccpText <= 0) return { html: '', warn: '文档正文为空' };

    /* FibRgFcLcb 起点 0x9A，每项 4 字节：索引 24/25 = CHPX，26/27 = PAPX */
    var fcPlcfBteChpx = u32(wd, 0x9A + 24 * 4), lcbPlcfBteChpx = u32(wd, 0x9A + 24 * 4 + 4);
    var fcPlcfBtePapx = u32(wd, 0x9A + 26 * 4), lcbPlcfBtePapx = u32(wd, 0x9A + 26 * 4 + 4);

    var chpxList = chpxTable(wd, table, fcPlcfBteChpx, lcbPlcfBteChpx);
    var papxList = papxTable(wd, table, fcPlcfBtePapx, lcbPlcfBtePapx);
    var blocks = buildBlocks(wd, table, data, ccpText, chpxList, papxList);
    var html = blocksToHtml(blocks);
    if (!html.replace(/<[^>]+>/g, '').trim() && !/doc97-img/.test(html)) {
      var alt = fallbackText(wd);
      if (alt) return { html: alt, warn: '文档结构异常，已尽量提取文字内容' };
      return { html: '<p class="doc97-p">（文档没有可显示的文本内容）</p>' };
    }
    return { html: html, warn: '' };
  }

  global.DOC97 = {
    toHtml: toHtml,
    /* 供测试与排查使用 */
    _readCFB: readCFB, _chpxTable: chpxTable, _papxTable: papxTable,
    _pieceTable: pieceTable, _u16: u16, _u32: u32
  };
})(typeof window !== 'undefined' ? window : this);
