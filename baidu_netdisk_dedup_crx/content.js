// ============================================================
// 免责与合规声明（请仔细阅读）
// 为什么不算非法/外挂：
//   · 它运行在你自己的浏览器、你自己的已登录账号里，操作的是你自己的文件。
//   · 调用的是百度网盘网页端自身就在用的公开 Web API（列文件、删除到回收站），不是破解接口、不碰别人数据、不注入广告。
//   · 它本质上是把你手动能做的事（浏览→识别重复→删除）自动化，没有「外挂」常见的特征：盗号、绕过付费功能、刷量、分发牟利。无他者权益受损，不落入黑客/侵权范畴。
// 防护风险：
//   · 删除走回收站（10 天可恢复）——即使误删也能救回，降低了「不可逆损害」风险；
//   · 分批 20 个、批间 1 秒限速、勾选 + 输入「删除」+ confirm 三道关——降低风控触发概率，也防止误操作；
//   · 插件免费，没有「牟利型外挂」特征。禁止用于商业用途，禁止代操作他人网盘、传播使用，责任自付。
//   · 批量列举 + 批量删除可能触发百度反滥用机制，表现为临时限制操作、弹验证码、或短时封禁删除功能。
// ============================================================

(function () {
  'use strict';

  /* ============================================================
   * 配置区
   * ============================================================ */
  const DEFAULT_ROOTS = ['/示例目录1', '/示例目录2'];
  const LIST_PAGE_SIZE = 1000;
  const DELETE_BATCH = 20;
  const DELETE_INTERVAL = 1000;
  const REQUEST_GAP = 80;
  const LS_KEY = 'bnd_dedup_settings_v1';
  const SNAP_KEY = 'last_scan';

  const state = {
    apiHost: '', token: '', manualToken: '',
    files: [],           // 原始文件清单（持久化的主体）
    groups: null,        // {key: [item,...]}
    allPaths: new Map(), // path -> item
    selected: new Set(), // 默认勾选（每组除第1份外）
    overrides: new Map(),// path -> bool，用户手动改过的勾选（优先级最高）
    view: [], page: 1, pageSize: 50, filter: '', sort: 'size',
    totalFiles: 0, snapshotAt: null,
    roots: '', criteria: 'name+size'
  };

  /* ============================================================
   * 本地存储：IndexedDB 优先，localStorage 兜底
   * ============================================================ */
  const Store = (function () {
    const DB_NAME = 'bnd_dedup_db', STORE = 'kv';
    function idb() {
      return new Promise((res, rej) => {
        if (typeof indexedDB === 'undefined') return rej(new Error('no indexedDB'));
        let rq;
        try { rq = indexedDB.open(DB_NAME, 1); } catch (e) { return rej(e); }
        rq.onupgradeneeded = () => {
          const db = rq.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
        rq.onblocked = () => rej(new Error('indexedDB blocked'));
      });
    }
    function idbSet(k, v) {
      return idb().then(db => new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(v, k);
        tx.oncomplete = () => res(true);
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error);
      }));
    }
    function idbGet(k) {
      return idb().then(db => new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readonly');
        const rq = tx.objectStore(STORE).get(k);
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      }));
    }
    function idbDel(k) {
      return idb().then(db => new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(k);
        tx.oncomplete = () => res(true);
        tx.onerror = () => rej(tx.error);
      }));
    }
    const LS_SNAP = 'bnd_dedup_snapshot_v1';
    return {
      async set(k, v) {
        try { return await idbSet(k, v); }
        catch (e) {
          try { localStorage.setItem(LS_SNAP, JSON.stringify(v)); return true; }
          catch (e2) { throw new Error('快照保存失败（IndexedDB 与 localStorage 均不可用或空间不足）：' + e2.message); }
        }
      },
      async get(k) {
        try { const v = await idbGet(k); if (v !== undefined && v !== null) return v; } catch (e) {}
        try { const s = localStorage.getItem(LS_SNAP); return s ? JSON.parse(s) : null; } catch (e) { return null; }
      },
      async del(k) {
        try { await idbDel(k); } catch (e) {}
        try { localStorage.removeItem(LS_SNAP); } catch (e) {}
      }
    };
  })();

  /* ============================================================
   * 基础工具
   * ============================================================ */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function fmtSize(bytes) {
    if (bytes == null || isNaN(bytes)) return '-';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, n = +bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(2)) + ' ' + u[i];
  }

  function baseName(path, serverName) {
    if (serverName) return serverName;
    return (path || '').split('/').pop();
  }

  function escapeHtml(s) {
    const AMP = '&';
    return String(s)
      .split(AMP).join(AMP + 'amp;')
      .split('<').join(AMP + 'lt;')
      .split('>').join(AMP + 'gt;')
      .split('"').join(AMP + 'quot;')
      .split("'").join(AMP + '#39;');
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function nowStamp() {
    const d = new Date(), p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob(['\uFEFF' + content], { type: mime || 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
  }

  /* ---- CSV ---- */
  function csvCell(v) {
    v = String(v == null ? '' : v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function csvRow(cells) { return cells.map(csvCell).join(','); }

  function parseCSV(text) {
    text = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
        else if (c === '\r') { /* skip */ }
        else field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }

  /* ============================================================
   * bdstoken：多策略级联
   * ============================================================ */
  function findBdstoken(o, depth) {
    depth = depth || 0;
    if (depth > 6 || !o || typeof o !== 'object') return null;
    for (const k in o) {
      const v = o[k];
      if ((k === 'bdstoken' || k === 'MYBDSTOKEN') && typeof v === 'string' && v.length >= 8) return v;
      if (v && typeof v === 'object') { const r = findBdstoken(v, depth + 1); if (r) return r; }
    }
    return null;
  }

  const TOKEN_RE = /["']?bdstoken["']?\s*[:=]\s*["']([0-9a-zA-Z_\-]{8,})["']/;
  function extractToken(text) {
    if (!text) return null;
    const m = text.match(TOKEN_RE);
    return m ? m[1] : null;
  }
  function isPlausibleToken(v) {
    return typeof v === 'string' && v.length >= 8 && /^[0-9a-zA-Z_\-]+$/.test(v);
  }
  function resolveApiHost(sel) {
    if (sel && sel !== 'auto') return sel;
    const h = location.hostname || '';
    if (h.indexOf('baidu.com') >= 0) return location.origin;
    return 'https://pan.baidu.com';
  }
  async function fetchJson(url) {
    const r = await fetch(url, { credentials: 'include' });
    return { status: r.status, json: await r.json() };
  }

  async function getBdstoken(onLog) {
    const say = (label, ok, detail) => { if (onLog) onLog((ok ? '✓ ' : '✗ ') + label + (detail ? ' — ' + detail : ''), ok ? 'ok' : 'err'); };

    if (state.manualToken && isPlausibleToken(state.manualToken)) {
      say('使用手动填写的 bdstoken', true, state.manualToken.slice(0, 8) + '…');
      return state.manualToken;
    }
    const globals = [
      ['window.yunData.bdstoken', () => window.yunData && window.yunData.bdstoken],
      ['window.yunData.MYBDSTOKEN', () => window.yunData && window.yunData.MYBDSTOKEN],
      ['window.locals.bdstoken', () => window.locals && window.locals.bdstoken],
      ['window.__INITIAL_STATE__.bdstoken', () => window.__INITIAL_STATE__ && window.__INITIAL_STATE__.bdstoken],
      ['window.bdstoken', () => window.bdstoken],
      ['window.G.bdstoken', () => window.G && window.G.bdstoken]
    ];
    for (const [label, getter] of globals) {
      try { const v = getter(); if (isPlausibleToken(v)) { say(label, true, String(v).slice(0, 8) + '…'); return v; } } catch (e) {}
    }
    let diag;
    try { diag = window.yunData ? 'window.yunData 存在，keys=' + Object.keys(window.yunData).slice(0, 12).join(',') : 'window.yunData=undefined'; }
    catch (e) { diag = '读取 window.yunData 异常'; }
    say('页面全局变量', false, diag);

    try {
      const scripts = Array.prototype.slice.call(document.querySelectorAll('script'));
      for (const s of scripts) { const v = extractToken(s.textContent || ''); if (v) { say('页面 <script> 文本', true, v.slice(0, 8) + '…'); return v; } }
      say('页面 <script> 文本', false, '扫描 ' + scripts.length + ' 个 script 未命中');
    } catch (e) { say('页面 <script> 文本', false, e.message); }

    try {
      const r = await fetch(state.apiHost + '/disk/home', { credentials: 'include' });
      const t = await r.text();
      const v = extractToken(t);
      if (v) { say('/disk/home HTML', true, v.slice(0, 8) + '…'); return v; }
      say('/disk/home HTML', false, 'HTTP ' + r.status + '，长度 ' + t.length + '，未命中');
    } catch (e) { say('/disk/home HTML', false, e.message + '（可能跨域被拦）'); }

    try {
      const url = state.apiHost + '/api/gettemplatevariable?clienttype=0&web=1&fields=' + encodeURIComponent('["bdstoken"]');
      const { status, json } = await fetchJson(url);
      const v = findBdstoken(json);
      if (v) { say('/api/gettemplatevariable', true, v.slice(0, 8) + '…'); return v; }
      say('/api/gettemplatevariable', false, 'HTTP ' + status + '，返回 ' + JSON.stringify(json).slice(0, 160));
    } catch (e) { say('/api/gettemplatevariable', false, e.message); }

    try {
      const url = state.apiHost + '/api/getsingleton?channel=4&clienttype=0&web=1&t=' + Date.now();
      const { status, json } = await fetchJson(url);
      const v = findBdstoken(json);
      if (v) { say('/api/getsingleton', true, v.slice(0, 8) + '…'); return v; }
      say('/api/getsingleton', false, 'HTTP ' + status + '，返回 ' + JSON.stringify(json).slice(0, 160));
    } catch (e) { say('/api/getsingleton', false, e.message); }

    throw new Error('全部策略均失败，无法获取 bdstoken。请在「手动 bdstoken」处粘贴令牌（F12 → Network → 任选一个网盘请求 → 参数里的 bdstoken），或切换 API 域名后重试。');
  }

  async function diagnose(onLog) {
    const say = (m, c) => onLog && onLog(m, c);
    say('===== 开始诊断 =====', 'info');
    say('当前页面：' + location.href, 'info');
    say('API 域名：' + state.apiHost, 'info');
    try { say('登录线索：' + (document.cookie.indexOf('BDUSS') >= 0 ? 'cookie 中检测到 BDUSS，已登录' : 'cookie 中未检测到 BDUSS'), 'info'); } catch (e) {}
    let token = null;
    try { token = await getBdstoken(onLog); say('令牌获取成功：' + token.slice(0, 8) + '…', 'ok'); }
    catch (e) { say(e.message, 'err'); say('===== 诊断结束（失败）=====', 'err'); return; }
    try {
      const data = await listDir('/', 1);
      if (!data) say('根目录列举失败：接口未返回有效数据', 'err');
      else if (data.errno && data.errno !== 0) say('根目录列举 errno=' + data.errno + '（0=成功）', 'err');
      else say('根目录列举成功，' + (data.list ? data.list.length : 0) + ' 项，total=' + data.total, 'ok');
    } catch (e) { say('根目录列举异常：' + e.message, 'err'); }
    say('===== 诊断结束 =====', 'info');
  }

  /* ============================================================
   * 列举 / 遍历 / 分组 / 删除
   * ============================================================ */
  async function listDir(dir, page) {
    const bases = [state.apiHost + '/api/filemanager?method=list', state.apiHost + '/api/list'];
    for (const base of bases) {
      const url = base + '?order=name&desc=0&showempty=0&web=1&page=' + page +
        '&num=' + LIST_PAGE_SIZE + '&bdstoken=' + encodeURIComponent(state.token);
      try {
        const resp = await fetch(url, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'dir=' + encodeURIComponent(dir)
        });
        const j = await resp.json();
        if (j && (j.errno === 0 || j.errno === undefined) && Array.isArray(j.list)) return j;
        if (j && j.errno === -6) throw new Error('登录已失效（errno=-6），请刷新页面重新登录。');
      } catch (e) {
        if (e.message && e.message.indexOf('登录已失效') >= 0) throw e;
      }
    }
    return null;
  }

  async function walk(roots, onProgress, onChunk) {
    const files = [];
    const queue = roots.map(r => r.trim()).filter(Boolean);
    let scannedDirs = 0, scannedFiles = 0;
    while (queue.length) {
      const dir = queue.shift();
      let page = 1;
      while (true) {
        const data = await listDir(dir, page);
        if (!data || !Array.isArray(data.list) || data.list.length === 0) break;
        for (const it of data.list) {
          if (it.isdir === 1 || it.isdir === '1') queue.push(it.path);
          else {
            files.push({ path: it.path, name: baseName(it.path, it.server_filename), size: it.size, md5: it.md5, fs_id: it.fs_id });
            scannedFiles++;
          }
        }
        scannedDirs++;
        if (onProgress) onProgress({ scannedDirs, scannedFiles, current: dir, queueLen: queue.length, files: files });
        if (onChunk) await onChunk(files);   // 断点续扫：定期落盘
        if (data.list.length < LIST_PAGE_SIZE) break;
        page++;
        await sleep(REQUEST_GAP);
      }
      await sleep(REQUEST_GAP);
    }
    return files;
  }

  function analyze(files, criteria) {
    const groups = {};
    for (const f of files) {
      const nameKey = (f.name || '').toLowerCase();
      let key;
      if (criteria === 'md5') key = f.md5 || ('NOSIZE:' + f.size);
      else if (criteria === 'name') key = nameKey;
      else if (criteria === 'name+md5') key = nameKey + '\u0000' + (f.md5 || '');
      else key = nameKey + '\u0000' + f.size;
      (groups[key] = groups[key] || []).push(f);
    }
    const dupes = {};
    for (const k in groups) if (groups[k].length >= 2) dupes[k] = groups[k];
    return dupes;
  }

  async function deleteSelected(paths, onLog, onBatchDone) {
    for (let i = 0; i < paths.length; i += DELETE_BATCH) {
      const chunk = paths.slice(i, i + DELETE_BATCH);
      const url = state.apiHost + '/api/filemanager?method=filemanager&opera=delete&bdstoken=' + encodeURIComponent(state.token);
      try {
        const resp = await fetch(url, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'filelist=' + encodeURIComponent(JSON.stringify(chunk))
        });
        const j = await resp.json();
        if (!j || (j.errno !== 0 && j.errno !== undefined)) {
          onLog('删除批次失败 errno=' + (j && j.errno) + '，已停止。已完成的不会重复删，稍后可再次点击删除继续。', 'err');
          return { ok: false, done: i };
        }
        onLog('已删除 ' + (i + chunk.length) + ' / ' + paths.length + ' 个文件', 'ok');
        if (onBatchDone) await onBatchDone(chunk);   // 每批成功后落盘，支持中断续删
      } catch (e) {
        onLog('删除请求异常：' + e.message + '，已停止。', 'err');
        return { ok: false, done: i };
      }
      await sleep(DELETE_INTERVAL);
    }
    return { ok: true, done: paths.length };
  }

  /* ============================================================
   * 结果集：索引 / 默认勾选 / 有效勾选 / 视图
   * ============================================================ */
  function buildIndexes() {
    state.allPaths.clear();
    for (const k in state.groups) for (const it of state.groups[k]) state.allPaths.set(it.path, it);
  }

  function resetDefaultSelection() {
    state.selected.clear();
    for (const k in state.groups) {
      const items = state.groups[k];
      for (let i = 1; i < items.length; i++) state.selected.add(items[i].path); // 每组保留第 1 份
    }
  }

  // 用户手动改过的优先，其余用默认
  function effectiveSelected() {
    const s = new Set();
    state.allPaths.forEach((it, p) => {
      if (state.overrides.has(p)) { if (state.overrides.get(p)) s.add(p); }
      else if (state.selected.has(p)) s.add(p);
    });
    return s;
  }

  function buildView() {
    const kw = state.filter.trim().toLowerCase();
    const arr = [];
    for (const k in state.groups) {
      const items = state.groups[k];
      if (kw && (items[0].name || '').toLowerCase().indexOf(kw) < 0) continue;
      const size = items[0].size || 0;
      arr.push({ key: k, items: items, size: size, free: size * (items.length - 1) });
    }
    if (state.sort === 'size') arr.sort((a, b) => b.free - a.free);
    else if (state.sort === 'count') arr.sort((a, b) => b.items.length - a.items.length);
    else arr.sort((a, b) => (a.items[0].name || '').localeCompare(b.items[0].name || '', 'zh'));
    state.view = arr;
    const maxPage = Math.max(1, Math.ceil(arr.length / state.pageSize));
    if (state.page > maxPage) state.page = maxPage;
    if (state.page < 1) state.page = 1;
  }

  function selectedStat() {
    const sel = effectiveSelected();
    let n = 0, bytes = 0;
    sel.forEach(p => { const it = state.allPaths.get(p); if (it) { n++; bytes += (it.size || 0); } });
    return { n: n, bytes: bytes };
  }

  /* ---- 快照 ---- */
  function buildSnapshot(complete) {
    return {
      savedAt: new Date().toISOString(),
      complete: !!complete,
      roots: state.roots,
      criteria: state.criteria,
      files: state.files,
      overrides: Array.from(state.overrides.entries()).map(e => [e[0], e[1] ? 1 : 0])
    };
  }

  function buildCSV() {
    const sel = effectiveSelected();
    const head = ['组号', '文件名', '文件大小(字节)', '文件大小', 'MD5', '副本序号', '副本总数', '文件路径', '默认建议', '删除标记（1表示确定删）'];
    const lines = [csvRow(head)];
    let gi = 0;
    for (const k in state.groups) {
      const items = state.groups[k];
      gi++;
      items.forEach((it, idx) => {
        lines.push(csvRow([
          gi, it.name, it.size || 0, fmtSize(it.size), it.md5 || '',
          idx + 1, items.length, it.path,
          idx === 0 ? '保留' : '可删',
          sel.has(it.path) ? '1' : ''
        ]));
      });
    }
    return lines.join('\r\n');
  }

  function buildJSON() {
    const sel = effectiveSelected();
    const out = [];
    let gi = 0;
    for (const k in state.groups) {
      const items = state.groups[k];
      gi++;
      items.forEach((it, idx) => {
        out.push({
          group: gi, name: it.name, size: it.size || 0, md5: it.md5 || '',
          index: idx + 1, total: items.length, path: it.path,
          suggest: idx === 0 ? '保留' : '可删', del: sel.has(it.path) ? 1 : 0
        });
      });
    }
    return JSON.stringify({ exportedAt: new Date().toISOString(), rows: out }, null, 2);
  }

  // 全量文件清单：扫描到的所有文件（不只重复项），按路径排序便于浏览
  function allFilesSorted() {
    return (state.files || []).slice().sort((a, b) =>
      (a.path || '').localeCompare(b.path || '', 'zh'));
  }

  // path -> 重复组号（仅重复组内才有）
  function buildDupMark() {
    const mark = new Map();
    let gi = 0;
    for (const k in state.groups) {
      const items = state.groups[k];
      if (items && items.length >= 2) {
        gi++;
        items.forEach(it => mark.set(it.path, gi));
      }
    }
    return mark;
  }

  function buildAllCSV() {
    const head = ['序号', '文件名', '文件路径', '所在目录', '大小(字节)', '大小', 'MD5', '是否重复', '重复组号'];
    const mark = buildDupMark();
    const lines = [csvRow(head)];
    allFilesSorted().forEach((it, i) => {
      const dir = (it.path || '').split('/').slice(0, -1).join('/') || '/';
      const g = mark.get(it.path);
      lines.push(csvRow([
        i + 1, it.name, it.path, dir, it.size || 0, fmtSize(it.size), it.md5 || '',
        g ? '是' : '', g || ''
      ]));
    });
    return lines.join('\r\n');
  }

  function buildAllJSON() {
    const mark = buildDupMark();
    const rows = allFilesSorted().map((it, i) => {
      const dir = (it.path || '').split('/').slice(0, -1).join('/') || '/';
      const g = mark.get(it.path);
      return {
        index: i + 1, name: it.name, path: it.path, dir: dir,
        size: it.size || 0, sizeText: fmtSize(it.size), md5: it.md5 || '',
        dup: g ? true : false, group: g || 0
      };
    });
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      roots: state.roots,
      criteria: state.criteria,
      total: rows.length,
      rows: rows
    }, null, 2);
  }

  function parseImported(text, log) {
    const t = String(text || '').trim();
    if (t.charAt(0) === '{' || t.charAt(0) === '[') {
      const j = JSON.parse(t);
      const rows = Array.isArray(j) ? j : (j.rows || []);
      return rows.filter(r => r && (r.del === 1 || r.del === '1' || r.del === true) && r.path).map(r => r.path);
    }
    const rows = parseCSV(t);
    if (!rows.length) return [];
    const header = rows[0].map(h => String(h).trim());
    const idxPath = header.findIndex(h => /文件路径|^path$/i.test(h));
    const idxDel = header.findIndex(h => /删除标记|是否删除|^删除$|^del$/i.test(h));
    const idxName = header.findIndex(h => /文件名|^name$/i.test(h));
    if (idxPath < 0) throw new Error('CSV 里找不到「文件路径」列，请确认导出的是本工具的 CSV。');
    if (idxDel < 0) throw new Error('CSV 里找不到「删除标记」列，请确认导出的是本工具的 CSV。');
    const paths = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const mark = String(r[idxDel] == null ? '' : r[idxDel]).trim().toLowerCase();
      if (['1', 'y', 'yes', '是', 'true', 'delete', '删除', 'd'].indexOf(mark) >= 0) {
        const p = String(r[idxPath] || '').trim();
        if (p) paths.push(p);
      }
    }
    if (idxName < 0) log('提示：未识别到「文件名」列，已按路径匹配。', 'info');
    return paths;
  }

  /* ============================================================
   * UI
   * ============================================================ */
  function injectStyle() {
    const css = `
    #bnd-panel{position:fixed;top:56px;right:12px;width:540px;max-height:88vh;overflow:auto;
      background:#fff;border:1px solid #d9d9d9;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);
      font:13px/1.5 -apple-system,'Microsoft YaHei',sans-serif;color:#333;z-index:999999;}
    #bnd-panel h3{margin:0;padding:10px 14px;background:#2f6fed;color:#fff;font-size:14px;
      border-radius:10px 10px 0 0;display:flex;justify-content:space-between;align-items:center;
      position:sticky;top:0;z-index:9;}
    #bnd-panel h3 span{cursor:pointer;font-weight:400;}
    #bnd-body{padding:10px 14px 14px;}
    #bnd-panel label{display:block;margin:8px 0 4px;font-weight:600;color:#555;}
    #bnd-panel textarea,#bnd-panel select,#bnd-panel input[type=text]{width:100%;box-sizing:border-box;
      border:1px solid #ccc;border-radius:6px;padding:6px 8px;font:13px/1.4 -apple-system,monospace;color:#333;}
    #bnd-panel textarea{height:56px;resize:vertical;}
    .bnd-hint{color:#888;font-size:11px;margin-top:3px;line-height:1.4;}
    .bnd-inlinerow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:6px 0 0;}
    .bnd-inlinerow .bnd-btn{margin:0;flex:none;}
    .bnd-inlinehint{flex:1;min-width:220px;color:#888;font-size:11px;line-height:1.5;}
    .bnd-btn{display:inline-block;margin:6px 6px 0 0;padding:6px 12px;border:none;border-radius:6px;
      background:#2f6fed;color:#fff;cursor:pointer;font-size:12.5px;}
    .bnd-btn:disabled{background:#aaa;cursor:not-allowed;}
    .bnd-btn.danger{background:#e53935;}
    .bnd-btn.ghost{background:#eef0f4;color:#333;}
    .bnd-btn.warn{background:#f9a825;color:#fff;}
    #bnd-log{margin-top:8px;max-height:170px;overflow:auto;background:#f6f6f6;border:1px solid #eee;
      border-radius:6px;padding:8px;font:12px/1.45 monospace;white-space:pre-wrap;}
    #bnd-log .ok{color:#1a7f37;} #bnd-log .err{color:#c62828;} #bnd-log .info{color:#1565c0;}
    #bnd-summary{margin:8px 0;padding:8px 10px;background:#eef4ff;border-radius:6px;color:#1a3a8f;}
    #bnd-snapbar{margin:8px 0;padding:8px 10px;background:#fff7e6;border:1px solid #ffd591;
      border-radius:6px;color:#ad6800;font-size:12.5px;}
    #bnd-snapbar .bnd-btn{margin:4px 6px 0 0;padding:5px 10px;}
    #bnd-actions{position:sticky;top:44px;background:#fff;z-index:8;padding:6px 0 8px;
      border-bottom:2px solid #2f6fed;margin-bottom:6px;}
    .bnd-tbrow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0;}
    .bnd-tbrow input[type=text],.bnd-tbrow select{width:auto;min-width:96px;}
    #bnd-filter{flex:1;min-width:120px;}
    .bnd-stat{padding:4px 8px;background:#fff7e6;border:1px solid #ffd591;border-radius:6px;color:#ad6800;font-size:12.5px;}
    .bnd-group{border:1px solid #e0e0e0;border-radius:6px;margin:6px 0;overflow:hidden;}
    .bnd-group-head{background:#f3f6fb;padding:6px 10px;cursor:pointer;display:flex;justify-content:space-between;gap:8px;}
    .bnd-group-head b{color:#2f6fed;font-weight:400;font-size:12px;white-space:nowrap;}
    .bnd-group-body{padding:4px 10px 8px;}
    .bnd-row{display:flex;align-items:center;gap:6px;padding:3px 0;border-top:1px dashed #eee;}
    .bnd-row input[type=checkbox]{margin:0;flex:none;}
    .bnd-row .p{color:#666;font:11.5px monospace;word-break:break-all;}
    .bnd-row .s{margin-left:auto;color:#888;font-size:11px;white-space:nowrap;}
    #bnd-toggle{position:fixed;top:56px;right:12px;z-index:999998;background:#2f6fed;color:#fff;
      border:none;border-radius:8px;padding:8px 12px;cursor:pointer;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.2);}
    #bnd-results{min-height:20px;}
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function createPanel() {
    injectStyle();
    const saved = {};
    try { Object.assign(saved, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (e) {}

    const toggle = document.createElement('button');
    toggle.id = 'bnd-toggle'; toggle.textContent = '网盘文件扫描与去重';
    document.body.appendChild(toggle);

    const panel = document.createElement('div');
    panel.id = 'bnd-panel';
    panel.style.display = 'none';
    panel.innerHTML = `
      <h3>百度网盘 文件分析 & 去除重复 <span id="bnd-close">✕</span></h3>
      <div id="bnd-body">

        <label>API 域名（令牌获取不到时切换）</label>
        <select id="bnd-host">
          <option value="auto">自动（跟随当前域名）</option>
          <option value="https://pan.baidu.com">https://pan.baidu.com</option>
          <option value="https://yun.baidu.com">https://yun.baidu.com</option>
        </select>

        <label>手动 bdstoken（可选，留空自动获取）</label>
        <input type="text" id="bnd-token" placeholder="留空自动获取；失败时在此粘贴">
        <div class="bnd-hint">F12 → Network → 任选一个网盘请求 → 参数里的 bdstoken。填了就跳过自动策略。</div>

        <label>扫描根目录（每行一个，前加：/ 号 ）</label>
        <textarea id="bnd-roots"></textarea>

        <label>重复判定标准（改了会立即离线重新分组，不用重扫）</label>
        <select id="bnd-criteria">
          <option value="name+size">文件名 + 大小（高效）</option>
          <option value="md5">MD5（推荐，文件指纹判定，不遗漏）</option>
          <option value="name+md5">文件名 + MD5（最严格）</option>
          <option value="name">仅文件名</option>
        </select>

        <div>
          <button class="bnd-btn" id="bnd-scan">开始扫描</button>
          <button class="bnd-btn ghost" id="bnd-diag">诊断令牌</button>
          <button class="bnd-btn ghost" id="bnd-clear">清空结果(保留快照)</button>
          <button class="bnd-btn ghost" id="bnd-copylog">复制日志</button>
        </div>
        <div>
          <button class="bnd-btn ghost" id="bnd-expcsv">导出重复清单(Excel)</button>
          <button class="bnd-btn ghost" id="bnd-expjson">导出重复清单(JSON)</button>
          <button class="bnd-btn ghost" id="bnd-expallcsv">导出全部文件(Excel)</button>
          <button class="bnd-btn ghost" id="bnd-expalljson">导出全部文件(JSON)</button>
          <button class="bnd-btn ghost" id="bnd-impbtn">导入删除标记（CSV/JSON）</button>
          <input type="file" id="bnd-impfile" accept=".csv,.json,.txt" style="display:none;">
        </div>
        <div class="bnd-inlinerow">
          <button class="bnd-btn warn" id="bnd-snapdel">清除本地快照</button>
          <span class="bnd-inlinehint">扫描结果会自动存到本地落盘（IndexedDB），关掉网页再打开也能一键恢复，无需重扫；勾选决定同样会记住。除非「清除本地快照」才删存档。</span>
        </div>

        <div id="bnd-snapbar" style="display:none;"></div>
        <div id="bnd-summary"></div>

        <div id="bnd-actions" style="display:none;">
          <div class="bnd-tbrow">
            <button class="bnd-btn ghost" id="bnd-keepfirst">每组只留第1份</button>
            <button class="bnd-btn ghost" id="bnd-selpage">本页全选可删</button>
            <button class="bnd-btn ghost" id="bnd-unselall">全部取消</button>
            <button class="bnd-btn ghost" id="bnd-invert">本页反选</button>
          </div>
          <div class="bnd-tbrow">
            <input type="text" id="bnd-filter" placeholder="按文件名筛选…">
            <select id="bnd-sort">
              <option value="size">可释放空间↓</option>
              <option value="count">副本数↓</option>
              <option value="name">文件名</option>
            </select>
            <select id="bnd-pagesize">
              <option value="20">每页20组</option>
              <option value="50">每页50组</option>
              <option value="100">每页100组</option>
              <option value="300">每页300组</option>
            </select>
            <button class="bnd-btn ghost" id="bnd-prev">‹上一页</button>
            <span id="bnd-pageinfo" style="font-size:12px;color:#666;"></span>
            <button class="bnd-btn ghost" id="bnd-next">下一页›</button>
          </div>
          <div class="bnd-tbrow">
            <span id="bnd-selstat" class="bnd-stat">已选 0 个，合计 0 B</span>
            <span style="color:#888;font-size:12px;">输入「删除」解锁：</span>
            <input type="text" id="bnd-confirm" placeholder="删除" style="width:80px;">
            <button class="bnd-btn danger" id="bnd-del" disabled>删除选中（进回收站）</button>
          </div>
        </div>

        <div id="bnd-results"></div>
        <div id="bnd-log"></div>
      </div>`;
    document.body.appendChild(panel);

    const $ = (id) => panel.querySelector('#' + id);
    const hostEl = $('bnd-host'), tokenEl = $('bnd-token'), rootsEl = $('bnd-roots'), criteriaEl = $('bnd-criteria');
    const scanBtn = $('bnd-scan'), diagBtn = $('bnd-diag'), clearBtn = $('bnd-clear'), copyBtn = $('bnd-copylog');
    const expCsvBtn = $('bnd-expcsv'), expJsonBtn = $('bnd-expjson'), impBtn = $('bnd-impbtn'), impFile = $('bnd-impfile');
    const expAllCsvBtn = $('bnd-expallcsv'), expAllJsonBtn = $('bnd-expalljson');
    const snapDelBtn = $('bnd-snapdel'), snapbarEl = $('bnd-snapbar');
    const summaryEl = $('bnd-summary'), resultsEl = $('bnd-results'), actionsEl = $('bnd-actions');
    const logEl = $('bnd-log'), confirmEl = $('bnd-confirm'), delBtn = $('bnd-del');
    const filterEl = $('bnd-filter'), sortEl = $('bnd-sort'), pageSel = $('bnd-pagesize');
    const pageInfoEl = $('bnd-pageinfo'), selstatEl = $('bnd-selstat');

    if (saved.host) hostEl.value = saved.host;
    if (saved.token) tokenEl.value = saved.token;
    if (saved.criteria) criteriaEl.value = saved.criteria;
    if (saved.pageSize) pageSel.value = saved.pageSize;
    rootsEl.value = saved.roots ? saved.roots : DEFAULT_ROOTS.join('\n');
    state.pageSize = parseInt(pageSel.value, 10) || 50;
    state.roots = rootsEl.value;
    state.criteria = criteriaEl.value;

    function saveSettings() {
      state.roots = rootsEl.value;
      state.criteria = criteriaEl.value;
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({
          host: hostEl.value, token: tokenEl.value, criteria: criteriaEl.value,
          roots: rootsEl.value, pageSize: pageSel.value
        }));
      } catch (e) {}
    }
    [hostEl, tokenEl, criteriaEl, rootsEl, pageSel].forEach(el => el.addEventListener('change', saveSettings));

    function log(msg, cls) {
      const line = document.createElement('div');
      if (cls) line.className = cls;
      line.textContent = msg;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    }

    /* ---- 快照存取 ---- */
    let saveTimer = null;
    function saveSnapshot(complete, quiet) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          await Store.set(SNAP_KEY, buildSnapshot(complete));
          state.snapshotAt = new Date().toISOString();
          renderSummary();
          if (!quiet) log('已保存到本地快照。', 'ok');
        } catch (e) { log(e.message, 'err'); }
      }, 400);
    }
    function saveSnapshotNow(complete) {
      clearTimeout(saveTimer);
      return Store.set(SNAP_KEY, buildSnapshot(complete))
        .then(() => { state.snapshotAt = new Date().toISOString(); })
        .catch(e => { log(e.message, 'err'); });
    }

    async function restoreSnapshot(payload) {
      state.files = payload.files || [];
      if (payload.criteria) criteriaEl.value = payload.criteria;
      if (payload.roots) rootsEl.value = payload.roots;
      state.roots = rootsEl.value;
      state.criteria = criteriaEl.value;
      state.overrides = new Map((payload.overrides || []).map(e => [e[0], !!e[1]]));
      state.groups = analyze(state.files, criteriaEl.value);
      buildIndexes();
      resetDefaultSelection();
      state.totalFiles = state.files.length;
      state.page = 1; state.filter = ''; filterEl.value = '';
      state.snapshotAt = payload.savedAt || null;
      snapbarEl.style.display = 'none';
      renderSummary();
      actionsEl.style.display = 'block';
      renderPage();
      log('已恢复上次记录：' + fmtTime(payload.savedAt) + '，' + state.files.length + ' 个文件，' +
        Object.keys(state.groups).length + ' 组重复。勾选决定已一并恢复。' +
        (payload.complete === false ? '（注意：上次扫描中途中断，这是部分结果）' : ''), 'ok');
    }

    function renderRestoreBanner(payload) {
      const probe = analyze(payload.files || [], payload.criteria || 'name+size');
      let free = 0;
      for (const k in probe) free += (probe[k][0].size || 0) * (probe[k].length - 1);
      snapbarEl.style.display = 'block';
      snapbarEl.innerHTML = '检测到本地记录：' + fmtTime(payload.savedAt) + '，' +
        (payload.files || []).length + ' 个文件，' + Object.keys(probe).length + ' 组重复，可释放 ' + fmtSize(free) + '<br>';
      const b1 = document.createElement('button');
      b1.className = 'bnd-btn'; b1.textContent = '恢复并继续分析';
      b1.addEventListener('click', () => restoreSnapshot(payload));
      const b2 = document.createElement('button');
      b2.className = 'bnd-btn ghost'; b2.textContent = '忽略';
      b2.addEventListener('click', () => { snapbarEl.style.display = 'none'; });
      const b3 = document.createElement('button');
      b3.className = 'bnd-btn ghost'; b3.textContent = '删除该记录';
      b3.addEventListener('click', async () => {
        await Store.del(SNAP_KEY);
        snapbarEl.style.display = 'none';
        log('本地快照已清除。', 'ok');
      });
      snapbarEl.appendChild(b1); snapbarEl.appendChild(b2); snapbarEl.appendChild(b3);
    }

    // 启动时检测本地快照
    (async () => {
      try {
        const snap = await Store.get(SNAP_KEY);
        if (snap && snap.files && snap.files.length) renderRestoreBanner(snap);
      } catch (e) {}
    })();

    toggle.addEventListener('click', () => { panel.style.display = (panel.style.display === 'none') ? 'block' : 'none'; });
    $('bnd-close').addEventListener('click', () => { panel.style.display = 'none'; });

    copyBtn.addEventListener('click', () => {
      const text = Array.prototype.map.call(logEl.children, d => d.textContent).join('\n');
      try { navigator.clipboard.writeText(text); log('日志已复制。', 'ok'); }
      catch (e) { log('复制失败，请手动选中复制。', 'err'); }
    });

    snapDelBtn.addEventListener('click', async () => {
      if (!confirm('确认清除本地保存的扫描记录？清除后需要重新扫描。')) return;
      await Store.del(SNAP_KEY);
      snapbarEl.style.display = 'none';
      state.snapshotAt = null;
      renderSummary();
      log('本地快照已清除。', 'ok');
    });

    function updateSelStat() {
      const s = selectedStat();
      selstatEl.textContent = '已选 ' + s.n + ' 个，合计 ' + fmtSize(s.bytes);
    }

    /* ---- 渲染 ---- */
    function renderPage() {
      buildView();
      resultsEl.innerHTML = '';
      const totalGroups = state.view.length;
      const maxPage = Math.max(1, Math.ceil(totalGroups / state.pageSize));
      const start = (state.page - 1) * state.pageSize;
      const slice = state.view.slice(start, start + state.pageSize);

      slice.forEach(g => {
        const box = document.createElement('div');
        box.className = 'bnd-group';
        const head = document.createElement('div');
        head.className = 'bnd-group-head';
        head.innerHTML = '<span>📄 ' + escapeHtml(g.items[0].name) + ' ×' + g.items.length +
          ' ｜ 单份 ' + fmtSize(g.size) + ' ｜ 可释放 ' + fmtSize(g.free) + '</span><b>展开/收起</b>';
        const body = document.createElement('div');
        body.className = 'bnd-group-body';
        body.style.display = 'none';

        g.items.forEach((it, idx) => {
          const row = document.createElement('div');
          row.className = 'bnd-row';
          if (idx === 0) {
            const keep = document.createElement('span');
            keep.style.color = '#1a7f37'; keep.textContent = '【保留】';
            row.appendChild(keep);
          }
          const cb = document.createElement('input');
          cb.type = 'checkbox'; cb.className = 'bnd-del';
          cb.setAttribute('data-path', it.path);
          cb.checked = state.overrides.has(it.path) ? state.overrides.get(it.path) : state.selected.has(it.path);
          cb.addEventListener('change', () => {
            state.overrides.set(it.path, cb.checked);   // 记住手动决定
            updateSelStat();
            saveSnapshot(true, true);
          });
          row.appendChild(cb);
          const p = document.createElement('span');
          p.className = 'p'; p.textContent = it.path;
          row.appendChild(p);
          const s = document.createElement('span');
          s.className = 's'; s.textContent = fmtSize(it.size);
          row.appendChild(s);
          body.appendChild(row);
        });

        head.addEventListener('click', () => { body.style.display = (body.style.display === 'none') ? 'block' : 'none'; });
        box.appendChild(head); box.appendChild(body);
        resultsEl.appendChild(box);
      });

      pageInfoEl.textContent = '第 ' + state.page + ' / ' + maxPage + ' 页（筛选后 ' + totalGroups + ' 组）';
      updateSelStat();
    }

    function renderSummary(totalFiles) {
      if (typeof totalFiles === 'number' && totalFiles > 0) state.totalFiles = totalFiles;
      let groupCount = 0, dupFiles = 0, reclaim = 0;
      if (state.groups) {
        for (const k in state.groups) {
          const items = state.groups[k];
          groupCount++; dupFiles += items.length;
          reclaim += (items[0].size || 0) * (items.length - 1);
        }
      }
      const s = selectedStat();
      let totalBytes = 0;
      (state.files || []).forEach(it => { totalBytes += (it.size || 0); });
      summaryEl.innerHTML =
        '文件 <b>' + state.totalFiles + '</b> 个 ｜ 占用 <b>' + fmtSize(totalBytes) + '</b> ｜ 重复组 <b>' + groupCount + '</b> 个 ｜ ' +
        '重复文件 <b>' + dupFiles + '</b> 个 ｜ 全部可释放 <b>' + fmtSize(reclaim) + '</b>' +
        (s.n ? ' ｜ <b>当前已选 ' + s.n + ' 个 / ' + fmtSize(s.bytes) + '</b>' : '') +
        (state.snapshotAt ? '<br><span style="color:#888;">本地快照：' + fmtTime(state.snapshotAt) + '（已自动保存，刷新可恢复）</span>' : '');
    }

    function regroup() {
      state.groups = analyze(state.files, criteriaEl.value);
      buildIndexes();
      resetDefaultSelection();
      state.page = 1; state.filter = ''; filterEl.value = '';
      renderSummary();
      actionsEl.style.display = 'block';
      renderPage();
      log('已按「' + criteriaEl.options[criteriaEl.selectedIndex].text + '」离线重新分组，未重新扫描；你手动勾选的决定已保留。', 'ok');
      saveSnapshot(true, true);
    }

    /* ---- 清空 ---- */
    function clearResults() {
      summaryEl.innerHTML = ''; resultsEl.innerHTML = '';
      actionsEl.style.display = 'none'; logEl.innerHTML = '';
      delBtn.disabled = true; confirmEl.value = '';
    }
    clearBtn.addEventListener('click', () => {
      clearResults();
      state.groups = null; state.files = [];
      state.selected.clear(); state.overrides.clear(); state.allPaths.clear();
      state.view = []; state.page = 1; state.totalFiles = 0;
      log('内存结果已清空（本地快照仍在，可用「恢复」找回）。', 'info');
    });

    /* ---- 扫描 ---- */
    scanBtn.addEventListener('click', async () => {
      clearResults();
      const roots = rootsEl.value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!roots.length) { log('请至少填写一个扫描根目录。', 'err'); return; }
      state.roots = rootsEl.value;
      state.criteria = criteriaEl.value;
      state.apiHost = resolveApiHost(hostEl.value);
      state.manualToken = (tokenEl.value || '').trim();
      scanBtn.disabled = true;
      let lastSnap = Date.now();
      try {
        log('API 域名：' + state.apiHost, 'info');
        state.token = await getBdstoken(log);
        log('令牌就绪，开始递归扫描（每 8 秒自动存一次进度，中断也不会白扫）…', 'ok');

        state.files = await walk(roots,
          (p) => {
            summaryEl.innerHTML = '扫描中… 目录 ' + p.scannedDirs + ' ，文件 ' + p.scannedFiles +
              ' ，待处理 ' + p.queueLen + '<br><span style="color:#888;">当前：' + escapeHtml(p.current) + '</span>';
          },
          async (filesSoFar) => {
            if (Date.now() - lastSnap > 8000) {
              lastSnap = Date.now();
              state.files = filesSoFar;
              await saveSnapshotNow(false);
              log('进度已落盘_清单记录：（' + filesSoFar.length + ' 个文件）。', 'info');
            }
          });

        state.overrides = new Map();   // 新扫描：清空旧的手动决定
        state.groups = analyze(state.files, criteriaEl.value);
        buildIndexes();
        resetDefaultSelection();
        state.totalFiles = state.files.length;
        state.page = 1; state.filter = ''; filterEl.value = '';
        renderSummary(state.files.length);
        actionsEl.style.display = 'block';
        renderPage();
        await saveSnapshotNow(true);
        log('扫描完成：' + state.files.length + ' 个文件，' + Object.keys(state.groups).length +
          ' 组重复。已保存到本地，可随时关页面，下次打开点「恢复」继续。', 'ok');
      } catch (e) {
        log('扫描出错：' + e.message, 'err');
        log('已保存的进度不会丢失，可在解决后重新扫描或在下次打开时恢复。', 'info');
        try { await saveSnapshotNow(false); } catch (e2) {}
      } finally { scanBtn.disabled = false; }
    });

    diagBtn.addEventListener('click', async () => {
      clearResults();
      state.apiHost = resolveApiHost(hostEl.value);
      state.manualToken = (tokenEl.value || '').trim();
      diagBtn.disabled = true;
      try { await diagnose(log); } catch (e) { log('诊断异常：' + e.message, 'err'); }
      finally { diagBtn.disabled = false; }
    });

    /* ---- 工具条 ---- */
    criteriaEl.addEventListener('change', () => {
      saveSettings();
      if (state.files && state.files.length) regroup();
    });
    filterEl.addEventListener('input', () => { state.filter = filterEl.value; state.page = 1; renderPage(); });
    sortEl.addEventListener('change', () => { state.sort = sortEl.value; renderPage(); });
    pageSel.addEventListener('change', () => { state.pageSize = parseInt(pageSel.value, 10) || 50; state.page = 1; renderPage(); });
    $('bnd-prev').addEventListener('click', () => { if (state.page > 1) { state.page--; renderPage(); } });
    $('bnd-next').addEventListener('click', () => {
      const maxPage = Math.max(1, Math.ceil(state.view.length / state.pageSize));
      if (state.page < maxPage) { state.page++; renderPage(); }
    });

    function pathsInPage() {
      const start = (state.page - 1) * state.pageSize;
      const out = [];
      state.view.slice(start, start + state.pageSize).forEach(g => g.items.forEach(it => out.push(it.path)));
      return out;
    }
    function setOverrideFor(paths, val, rerender) {
      paths.forEach(p => state.overrides.set(p, val));
      if (rerender) renderPage();
      saveSnapshot(true, true);
    }
    $('bnd-selpage').addEventListener('click', () => setOverrideFor(pathsInPage(), true, true));
    $('bnd-unselall').addEventListener('click', () => {
      state.allPaths.forEach((it, p) => state.overrides.set(p, false));
      renderPage(); saveSnapshot(true, true);
    });
    $('bnd-invert').addEventListener('click', () => {
      const sel = effectiveSelected();
      pathsInPage().forEach(p => state.overrides.set(p, !sel.has(p)));
      renderPage(); saveSnapshot(true, true);
    });
    $('bnd-keepfirst').addEventListener('click', () => {
      state.overrides.clear();      // 回到默认：每组保留第 1 份
      renderPage(); saveSnapshot(true, true);
    });

    /* ---- 导出 / 导入 ---- */
    expCsvBtn.addEventListener('click', () => {
      if (!state.groups) { log('请先扫描或恢复记录。', 'err'); return; }
      downloadFile('百度网盘重复文件_' + nowStamp() + '.csv', buildCSV(), 'text/csv;charset=utf-8');
      log('已导出 CSV，可用 Excel 直接打开。', 'ok');
    });
    expJsonBtn.addEventListener('click', () => {
      if (!state.groups) { log('请先扫描或恢复记录。', 'err'); return; }
      downloadFile('百度网盘重复文件_' + nowStamp() + '.json', buildJSON(), 'application/json;charset=utf-8');
      log('已导出 JSON（保留完整字段，适合无损回导）。', 'ok');
    });

    expAllCsvBtn.addEventListener('click', () => {
      if (!state.files || !state.files.length) { log('还没有扫描记录。请先扫描或恢复本地记录。', 'err'); return; }
      let bytes = 0;
      state.files.forEach(it => { bytes += (it.size || 0); });
      downloadFile('百度网盘（已扫目录）全部文件_' + nowStamp() + '.csv', buildAllCSV(), 'text/csv;charset=utf-8');
      log('已导出全部文件清单：' + state.files.length + ' 个文件，合计 ' + fmtSize(bytes) +
        '（含所在目录、大小、MD5，重复文件已标注组号）。', 'ok');
    });

    expAllJsonBtn.addEventListener('click', () => {
      if (!state.files || !state.files.length) { log('还没有扫描记录。请先扫描或恢复本地记录。', 'err'); return; }
      downloadFile('百度网盘（已扫目录）全部文件_' + nowStamp() + '.json', buildAllJSON(), 'application/json;charset=utf-8');
      log('已导出全部文件清单 JSON：' + state.files.length + ' 个文件。', 'ok');
    });

    impBtn.addEventListener('click', () => impFile.click());
    impFile.addEventListener('change', () => {
      const f = impFile.files && impFile.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const paths = parseImported(reader.result, log);
          if (!paths.length) { log('文件中没有标记为删除的行（删除标记列需填 1）。', 'err'); impFile.value = ''; return; }

          let matched = 0, unmatched = 0, bytes = 0;
          const miss = [];
          paths.forEach(p => {
            const it = state.allPaths.get(p);
            if (it) { matched++; bytes += (it.size || 0); }
            else { unmatched++; if (miss.length < 5) miss.push(p); }
          });

          if (!state.groups || !state.files.length) {
            log('当前没有扫描结果，无法校验路径。将以文件为准选中 ' + paths.length + ' 个路径。', 'info');
            state.files = paths.map(p => ({ path: p, name: baseName(p), size: 0, md5: '' }));
            state.groups = {};
            state.files.forEach((it, i) => { state.groups['imp' + i] = [it]; });
            buildIndexes();
            state.overrides = new Map();
            paths.forEach(p => state.overrides.set(p, true));
            state.totalFiles = state.files.length;
            renderSummary(); actionsEl.style.display = 'block';
            state.page = 1; state.filter = ''; filterEl.value = '';
            renderPage();
            log('导入完成：共 ' + paths.length + ' 条待删除。请核对后再删除。', 'ok');
          } else {
            state.overrides = new Map();
            state.allPaths.forEach((it, p) => state.overrides.set(p, false));
            paths.forEach(p => { if (state.allPaths.has(p)) state.overrides.set(p, true); });
            renderPage(); renderSummary();
            await saveSnapshotNow(true);
            if (unmatched) {
              log('导入完成：匹配 ' + matched + ' 条（' + fmtSize(bytes) + '），' + unmatched + ' 条在当前结果中找不到，已忽略。', 'err');
              miss.forEach(m => log('  未匹配：' + m, 'err'));
              log('若这些文件确实存在，请重新扫描后再导入。', 'info');
            } else {
              log('导入完成：匹配 ' + matched + ' 条，合计 ' + fmtSize(bytes) + '。已选中，可核对后删除。', 'ok');
            }
          }
        } catch (e) { log('导入失败：' + e.message, 'err'); }
        finally { impFile.value = ''; }
      };
      reader.onerror = () => { log('读取文件失败。', 'err'); impFile.value = ''; };
      reader.readAsText(f, 'utf-8');
    });

    /* ---- 删除 ---- */
    confirmEl.addEventListener('input', () => { delBtn.disabled = (confirmEl.value.trim() !== '删除'); });
    delBtn.addEventListener('click', async () => {
      if (confirmEl.value.trim() !== '删除') return;
      const paths = Array.from(effectiveSelected()).filter(p => state.allPaths.has(p));
      if (!paths.length) { log('没有勾选任何要删除的文件。', 'err'); return; }
      const s = selectedStat();
      if (!confirm('确认删除选中的 ' + paths.length + ' 个文件（合计 ' + fmtSize(s.bytes) + '）？\n删除后进入回收站，10 天内可恢复。')) return;
      delBtn.disabled = true;
      try {
        if (!state.token) state.token = await getBdstoken(log);
        const res = await deleteSelected(paths, log, async () => { await saveSnapshotNow(true); });
        if (res.ok) {
          log('全部删除完成。可在网盘「回收站」恢复或清空。', 'ok');
          // 从结果集与文件清单中剔除已删项，刷新界面
          const doneSet = new Set(paths);
          state.files = state.files.filter(it => !doneSet.has(it.path));
          doneSet.forEach(p => { state.overrides.delete(p); state.allPaths.delete(p); });
          for (const k in state.groups) {
            state.groups[k] = state.groups[k].filter(it => !doneSet.has(it.path));
            if (state.groups[k].length < 2) delete state.groups[k];
          }
          resetDefaultSelection();
          state.totalFiles = state.files.length;
          renderPage(); renderSummary();
          await saveSnapshotNow(true);
        }
      } catch (e) { log('删除失败：' + e.message, 'err'); }
      finally { delBtn.disabled = false; }
    });
  }

  /* ============================================================
   * 启动
   * ============================================================ */
  function init() {
    if (document.getElementById('bnd-toggle')) return;
    createPanel();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
