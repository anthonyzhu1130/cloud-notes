(function () {
  'use strict';
  var CONFIG = window.APP_CONFIG || {};
  var TOKEN_STORAGE_KEY = 'cloudNotes.githubToken';
  var REMINDER_STORAGE_KEY = 'cloudNotes.reminders';

  var state = {
    data: null,
    remoteUpdatedAt: null,
    token: null,
    editing: false,
    searchKeyword: '',
    busy: false,
    collapsedCategories: {},
    collapsedNotes: {},
    currentView: 'dashboard',
    currentNoteId: null
  };

  var toolState = {
    pomodoroTimer: null,
    pomodoroTime: 25 * 60,
    pomodoroTotal: 25 * 60,
    pomodoroCount: 0
  };

  var REMINDER_CATS = [
    { key: 'work', label: '工作' },
    { key: 'study', label: '学习' },
    { key: 'sport', label: '运动' },
    { key: 'food', label: '饮食' },
    { key: 'sleep', label: '睡眠' }
  ];

  var REMINDER_REPEATS = [
    { key: 'once', label: '一次性' },
    { key: 'daily', label: '每天' },
    { key: 'weekly', label: '每周' },
    { key: 'monthly', label: '每月' }
  ];

  var reminderState = {
    list: [],
    filter: { search: '', cat: 'all', sort: 'remaining', dir: 'asc' },
    editing: null,
    notified: {}
  };

  var editNoteCtx = { noteId: null, images: [], files: [], removedImages: [], removedFiles: [] };
  var newNoteCtx = { images: [], files: [] };
  var importCandidate = null;

  function byId(id) { return document.getElementById(id); }
  function deepClone(v) { return JSON.parse(JSON.stringify(v)); }
  function pad(n) { var s = String(n); return s.length < 2 ? '0' + s : s; }

  function newId(prefix) {
    var id;
    if (window.crypto && typeof window.crypto.randomUUID === 'function') id = window.crypto.randomUUID();
    else id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    return prefix ? prefix + '-' + id : id;
  }

  function formatSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function formatTime(iso) {
    if (!iso) return '未知';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function getExtension(name) {
    var m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function safeFileName(name) {
    var n = String(name || 'file');
    n = n.replace(/\\/g, '/');
    var parts = n.split('/');
    n = parts[parts.length - 1];
    n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_');
    n = n.replace(/\.\./g, '_');
    n = n.replace(/^[.\s]+/, '_');
    n = n.replace(/\s+/g, '_');
    if (!n) n = 'file';
    if (n.length > 120) { var dot = n.lastIndexOf('.'); n = dot > 3 ? n.slice(0, 100) + n.slice(dot) : n.slice(0, 120); }
    return n;
  }

  function guessMimeType(name) {
    var ext = getExtension(name);
    var map = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp',
      pdf:'application/pdf', doc:'application/msword',
      docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls:'application/vnd.ms-excel',
      xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt:'application/vnd.ms-powerpoint',
      pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      txt:'text/plain', csv:'text/csv', zip:'application/zip' };
    return map[ext] || 'application/octet-stream';
  }

  function assetUrl(path) { return String(path || '').split('/').map(encodeURIComponent).join('/'); }

  function utf8ToBase64(str) {
    var bytes = new TextEncoder().encode(String(str));
    var binary = ''; var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(binary);
  }

  function base64ToUtf8(b64) {
    var clean = String(b64 || '').replace(/[\r\n\s]/g, '');
    var binary = atob(clean);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = ''; var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(binary);
  }

  function readFileAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('读取文件失败：' + file.name)); };
      reader.readAsArrayBuffer(file);
    });
  }

  function AppError(message, status, detail) {
    this.name = 'AppError';
    this.message = message;
    this.status = status || 0;
    this.detail = detail || '';
  }
  AppError.prototype = Object.create(Error.prototype);

  function apiBase() { return 'https://api.github.com/repos/' + encodeURIComponent(CONFIG.OWNER || '') + '/' + encodeURIComponent(CONFIG.REPO || ''); }
  function contentsUrl(path) { var clean = String(path || '').split('/').filter(Boolean).map(encodeURIComponent).join('/'); return apiBase() + '/contents/' + clean; }

  function describeError(status, detail) {
    var tail = detail ? '（' + detail + '）' : '';
    switch (status) {
      case 0: return '网络请求失败，请检查网络连接。' + tail;
      case 401: return '身份验证失败，请检查 Token。' + tail;
      case 403: return /rate limit/i.test(detail) ? 'API 请求次数受限。' + tail : '权限不足（403）。' + tail;
      case 404: return '未找到资源（404）：检查用户名、仓库名、分支、路径、Token 权限。' + tail;
      case 409: return '远端文件已变化，请重新加载后再编辑。' + tail;
      case 413: return '请求内容过大（413）。' + tail;
      case 422: return '请求参数错误（422）。' + tail;
      default: return 'GitHub API 请求失败（HTTP ' + status + '）。' + tail;
    }
  }

  function ghFetch(url, options) {
    options = options || {};
    var headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': CONFIG.API_VERSION || '2022-11-28' };
    if (options.token) headers['Authorization'] = 'Bearer ' + options.token;
    var init = { method: options.method || 'GET', headers: headers, cache: 'no-store' };
    if (options.body !== undefined && options.body !== null) { headers['Content-Type'] = 'application/json; charset=utf-8'; init.body = JSON.stringify(options.body); }
    return fetch(url, init).then(function (res) {
      if (!res.ok) return res.text().then(function (text) {
        var detail = '';
        try { detail = JSON.parse(text).message || ''; } catch (e) {}
        throw new AppError(describeError(res.status, detail), res.status, detail);
      });
      if (res.status === 204) return null;
      return res.text().then(function (text) { if (!text) return null; try { return JSON.parse(text); } catch (e) { return null; } });
    }, function (err) { throw new AppError('网络请求失败。', 0, String((err && err.message) || err)); });
  }

  function parseNotesJson(text, sha) {
    var json;
    try { json = JSON.parse(text); } catch (e) { throw new AppError('远端 notes.json 不是合法 JSON。', 0); }
    return { json: normalizeData(json), sha: sha || null };
  }

  function fetchRemoteNotes(token) {
    var url = contentsUrl(CONFIG.NOTES_PATH) + '?ref=' + encodeURIComponent(CONFIG.BRANCH || 'main') + '&t=' + Date.now();
    return ghFetch(url, { token: token || state.token || null }).then(function (res) {
      if (!res) throw new AppError('远端 notes.json 返回空数据。', 0);
      if (res.content && res.encoding === 'base64') return parseNotesJson(base64ToUtf8(res.content), res.sha);
      if (res.download_url) return fetch(res.download_url + '?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new AppError('下载 notes.json 失败。', r.status);
        return r.text();
      }).then(function (t) { return parseNotesJson(t, res.sha); });
      throw new AppError('无法读取远端 notes.json。', 0);
    });
  }

  function normalizeImage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return { id: String(raw.id || newId('image')), originalName: String(raw.originalName || ''), storedName: String(raw.storedName || ''),
      path: String(raw.path || ''), mimeType: String(raw.mimeType || ''), size: Number(raw.size) || 0,
      description: String(raw.description || ''), sha: String(raw.sha || ''), createdAt: String(raw.createdAt || new Date().toISOString()) };
  }

  function normalizeFile(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return { id: String(raw.id || newId('file')), originalName: String(raw.originalName || ''), storedName: String(raw.storedName || ''),
      path: String(raw.path || ''), mimeType: String(raw.mimeType || ''), size: Number(raw.size) || 0,
      sha: String(raw.sha || ''), createdAt: String(raw.createdAt || new Date().toISOString()) };
  }

  function normalizeData(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('notes.json 结构不正确。', 0);
    if (raw.categories !== undefined && !Array.isArray(raw.categories)) throw new AppError('categories 必须是数组。', 0);
    if (raw.notes !== undefined && !Array.isArray(raw.notes)) throw new AppError('notes 必须是数组。', 0);
    var nowIso = new Date().toISOString();
    var data = { version: (typeof raw.version === 'number') ? raw.version : 1, updatedAt: (typeof raw.updatedAt === 'string') ? raw.updatedAt : nowIso, categories: [], notes: [] };
    (raw.categories || []).forEach(function (c) {
      if (!c || typeof c !== 'object') return;
      data.categories.push({ id: String(c.id || newId('category')), name: String(c.name || '未命名目录'),
        marked: !!c.marked, collapsed: !!c.collapsed,
        createdAt: String(c.createdAt || nowIso), updatedAt: String(c.updatedAt || c.createdAt || nowIso) });
    });
    (raw.notes || []).forEach(function (n) {
      if (!n || typeof n !== 'object') return;
      data.notes.push({ id: String(n.id || newId('note')), categoryId: String(n.categoryId || ''),
        title: String(n.title || '无标题笔记'), content: (typeof n.content === 'string') ? n.content : '',
        marked: !!n.marked, collapsed: !!n.collapsed,
        images: Array.isArray(n.images) ? n.images.map(normalizeImage).filter(Boolean) : [],
        attachments: Array.isArray(n.attachments) ? n.attachments.map(normalizeFile).filter(Boolean) : [],
        createdAt: String(n.createdAt || nowIso), updatedAt: String(n.updatedAt || n.createdAt || nowIso) });
    });
    return data;
  }

  function commitData(nextData, message) {
    if (!state.token) return Promise.reject(new AppError('当前不是编辑模式。', 401));
    return fetchRemoteNotes().catch(function (err) { if (err && err.status === 404) return null; throw err; }).then(function (remote) {
      if (remote && state.remoteUpdatedAt && remote.json.updatedAt && remote.json.updatedAt !== state.remoteUpdatedAt) {
        throw new AppError('远端文件已变化，请重新加载后再编辑。', 409);
      }
      nextData.version = nextData.version || 1;
      nextData.updatedAt = new Date().toISOString();
      var body = { message: message, content: utf8ToBase64(JSON.stringify(nextData, null, 2) + '\n'), branch: CONFIG.BRANCH || 'main' };
      if (remote && remote.sha) body.sha = remote.sha;
      return ghFetch(contentsUrl(CONFIG.NOTES_PATH), { method: 'PUT', token: state.token, body: body }).then(function () {
        state.data = nextData;
        state.remoteUpdatedAt = nextData.updatedAt;
      });
    });
  }

  function putRepoFile(path, base64Content, message) {
    return ghFetch(contentsUrl(path) + '?ref=' + encodeURIComponent(CONFIG.BRANCH || 'main') + '&t=' + Date.now(), { token: state.token })
      .catch(function (err) { if (err && err.status === 404) return null; throw err; })
      .then(function (existing) {
        var body = { message: message, content: base64Content, branch: CONFIG.BRANCH || 'main' };
        if (existing && existing.sha) body.sha = existing.sha;
        return ghFetch(contentsUrl(path), { method: 'PUT', token: state.token, body: body });
      });
  }

  function deleteRepoFile(path, message) {
    return ghFetch(contentsUrl(path) + '?ref=' + encodeURIComponent(CONFIG.BRANCH || 'main') + '&t=' + Date.now(), { token: state.token }).then(function (info) {
      if (!info || !info.sha) throw new AppError('无法获取文件 sha：' + path, 404);
      return ghFetch(contentsUrl(path), { method: 'DELETE', token: state.token, body: { message: message, sha: info.sha, branch: CONFIG.BRANCH || 'main' } });
    });
  }

  function validateImageFile(file) {
    var ext = getExtension(file.name);
    var allowed = (CONFIG.ALLOWED_IMAGE_EXTENSIONS || []).map(function (x) { return String(x).toLowerCase(); });
    if (allowed.indexOf(ext) === -1) return '不支持的图片格式：.' + ext;
    if (file.type === 'image/svg+xml') return '不允许上传 SVG 图片。';
    if (file.size > (CONFIG.MAX_IMAGE_SIZE || 5 * 1024 * 1024)) return '图片过大（' + formatSize(file.size) + '）';
    return null;
  }

  function validateAttachmentFile(file) {
    var ext = getExtension(file.name);
    var allowed = (CONFIG.ALLOWED_FILE_EXTENSIONS || []).map(function (x) { return String(x).toLowerCase(); });
    if (allowed.indexOf(ext) === -1) return '不支持的附件格式：.' + ext;
    if (file.size > (CONFIG.MAX_FILE_SIZE || 10 * 1024 * 1024)) return '附件过大（' + formatSize(file.size) + '）';
    return null;
  }

  function uploadAttachment(kind, noteId, item) {
    var isImage = kind === 'image';
    var root = isImage ? (CONFIG.IMAGE_ROOT || 'assets/images') : (CONFIG.FILE_ROOT || 'assets/files');
    var storedName = item.id + '-' + safeFileName(item.file.name);
    var path = root + '/' + noteId + '/' + storedName;
    return readFileAsArrayBuffer(item.file).then(function (buffer) {
      return putRepoFile(path, arrayBufferToBase64(buffer), (isImage ? '上传图片：' : '上传附件：') + item.file.name).then(function (res) {
        var sha = (res && res.content && res.content.sha) ? res.content.sha : '';
        var meta = { id: item.id, originalName: item.file.name, storedName: storedName, path: path,
          mimeType: item.file.type || guessMimeType(item.file.name), size: item.file.size,
          sha: sha, createdAt: new Date().toISOString() };
        if (isImage) meta.description = String(item.description || '');
        return meta;
      });
    });
  }

  function notify(kind, message, timeout) {
    var area = byId('notifyArea');
    if (!area) return null;
    var div = document.createElement('div');
    div.className = 'notify notify-' + kind;
    var span = document.createElement('span');
    span.textContent = String(message);
    div.appendChild(span);
    var close = document.createElement('button');
    close.type = 'button'; close.className = 'notify-close'; close.setAttribute('aria-label', '关闭提示'); close.textContent = '×';
    close.addEventListener('click', function () { if (div.parentNode) div.parentNode.removeChild(div); });
    div.appendChild(close); area.appendChild(div);
    if (timeout === undefined) timeout = 6000;
    if (timeout > 0) setTimeout(function () { if (div.parentNode) div.parentNode.removeChild(div); }, timeout);
    return div;
  }

  function showModal(id) { var el = byId(id); if (el) el.classList.remove('hidden'); }
  function hideModal(id) { var el = byId(id); if (el) el.classList.add('hidden'); }

  var confirmResolver = null;
  function askConfirm(options) {
    options = options || {};
    return new Promise(function (resolve) {
      confirmResolver = resolve;
      byId('confirmTitle').textContent = options.title || '确认操作';
      byId('confirmMessage').textContent = options.message || '';
      byId('confirmOkBtn').textContent = options.confirmText || '确认';
      showModal('confirmModal');
      byId('confirmOkBtn').focus();
    });
  }
  function resolveConfirm(v) { hideModal('confirmModal'); var r = confirmResolver; confirmResolver = null; if (r) r(v); }

  /* ===== 时钟（关键修复：单独 try-catch + 在 renderDashboard 里也调用） ===== */
  function updateClock() {
    try {
      var now = new Date();
      var days = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
      var t = byId('currentTime');
      var d = byId('currentDate');
      if (t) t.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
      if (d) d.textContent = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 ' + days[now.getDay()];
    } catch (e) { /* 忽略 */ }
  }

  /* ===== 番茄钟 ===== */
  function updatePomodoroDisplay() {
    var el = byId('pomodoroDisplay');
    if (el) el.textContent = pad(Math.floor(toolState.pomodoroTime / 60)) + ':' + pad(toolState.pomodoroTime % 60);
    var c = byId('pomodoroCount');
    if (c) c.textContent = String(toolState.pomodoroCount);
  }
  function startPomodoro() {
    if (toolState.pomodoroTimer) return;
    if (toolState.pomodoroTime <= 0) toolState.pomodoroTime = toolState.pomodoroTotal;
    toolState.pomodoroTimer = setInterval(function () {
      toolState.pomodoroTime--; updatePomodoroDisplay();
      if (toolState.pomodoroTime <= 0) {
        clearInterval(toolState.pomodoroTimer); toolState.pomodoroTimer = null;
        toolState.pomodoroCount++;
        try { localStorage.setItem('pomodoroCount', String(toolState.pomodoroCount)); } catch (e) {}
        toolState.pomodoroTime = toolState.pomodoroTotal; updatePomodoroDisplay();
        notify('success', '🍅 番茄钟时间到！休息一下吧。', 10000);
      }
    }, 1000);
  }
  function pausePomodoro() { if (toolState.pomodoroTimer) { clearInterval(toolState.pomodoroTimer); toolState.pomodoroTimer = null; } }
  function resetPomodoro() { pausePomodoro(); toolState.pomodoroTime = toolState.pomodoroTotal; updatePomodoroDisplay(); }

  /* ===== 定时提醒 ===== */
  function loadRemindersFromStorage() {
    try {
      var s = localStorage.getItem(REMINDER_STORAGE_KEY);
      reminderState.list = s ? JSON.parse(s) : [];
      if (!Array.isArray(reminderState.list)) reminderState.list = [];
    } catch (e) { reminderState.list = []; }
  }
  function saveRemindersToStorage() {
    try { localStorage.setItem(REMINDER_STORAGE_KEY, JSON.stringify(reminderState.list)); } catch (e) {}
  }
  function catLabel(key) { for (var i = 0; i < REMINDER_CATS.length; i++) if (REMINDER_CATS[i].key === key) return REMINDER_CATS[i].label; return key || '工作'; }
  function repeatLabel(key) { for (var i = 0; i < REMINDER_REPEATS.length; i++) if (REMINDER_REPEATS[i].key === key) return REMINDER_REPEATS[i].label; return key || '一次性'; }

  function computeNextAt(r) {
    if (!r || !r.date || !r.time) return null;
    var dt = new Date(r.date + 'T' + r.time + ':00');
    if (isNaN(dt.getTime())) return null;
    var now = new Date();
    if (r.repeat === 'once') return dt;
    var guard = 0;
    while (dt <= now && guard < 1000) {
      guard++;
      if (r.repeat === 'daily') dt.setDate(dt.getDate() + 1);
      else if (r.repeat === 'weekly') dt.setDate(dt.getDate() + 7);
      else if (r.repeat === 'monthly') dt.setMonth(dt.getMonth() + 1);
      else break;
    }
    return dt;
  }

  function formatRemaining(ms) {
    if (ms <= 0) return '已到期';
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (d > 0) return '剩余 ' + d + ' 天 ' + h + ' 小时';
    if (h > 0) return '剩余 ' + h + ' 小时 ' + m + ' 分钟';
    if (m > 0) return '剩余 ' + m + ' 分钟';
    return '不到 1 分钟';
  }

  function formatDateTime(d) {
    if (!d) return '—';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function initReminderSelects() {
    var catSel = byId('reminderCat');
    if (catSel) {
      catSel.textContent = '';
      REMINDER_CATS.forEach(function (c) {
        var o = document.createElement('option'); o.value = c.key; o.textContent = c.label;
        catSel.appendChild(o);
      });
    }
    var repSel = byId('reminderRepeat');
    if (repSel) {
      repSel.textContent = '';
      REMINDER_REPEATS.forEach(function (r) {
        var o = document.createElement('option'); o.value = r.key; o.textContent = r.label;
        repSel.appendChild(o);
      });
    }
    var catFilter = byId('reminderCatFilter');
    if (catFilter) {
      catFilter.textContent = '';
      var o0 = document.createElement('option'); o0.value = 'all'; o0.textContent = '请选择分类'; catFilter.appendChild(o0);
      REMINDER_CATS.forEach(function (c) {
        var o = document.createElement('option'); o.value = c.key; o.textContent = c.label;
        catFilter.appendChild(o);
      });
    }
  }

  function renderReminderCatTabs() {
    var box = byId('reminderCatTabs'); if (!box) return;
    box.textContent = '';
    function mk(key, label) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'reminder-cat-tab' + (reminderState.filter.cat === key ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', function () { reminderState.filter.cat = key; renderReminderCatTabs(); renderReminderList(); });
      box.appendChild(b);
    }
    mk('all', '全部');
    REMINDER_CATS.forEach(function (c) { mk(c.key, c.label); });
  }

  function renderReminderList() {
    var tbody = byId('reminderTbody'); if (!tbody) return;
    tbody.textContent = '';
    var f = reminderState.filter;
    var list = reminderState.list.slice();
    if (f.cat && f.cat !== 'all') list = list.filter(function (r) { return r.category === f.cat; });
    if (f.search) { var kw = f.search.toLowerCase(); list = list.filter(function (r) { return String(r.name || '').toLowerCase().indexOf(kw) !== -1; }); }
    list.sort(function (a, b) {
      var va, vb;
      if (f.sort === 'name') {
        va = String(a.name || ''); vb = String(b.name || '');
        return f.dir === 'asc' ? va.localeCompare(vb, 'zh') : vb.localeCompare(va, 'zh');
      }
      if (f.sort === 'created') { va = new Date(a.createdAt || 0).getTime(); vb = new Date(b.createdAt || 0).getTime(); }
      else { var na = computeNextAt(a), nb = computeNextAt(b); va = na ? na.getTime() : Infinity; vb = nb ? nb.getTime() : Infinity; }
      return f.dir === 'asc' ? va - vb : vb - va;
    });
    if (list.length === 0) {
      var tr = document.createElement('tr');
      var td = document.createElement('td'); td.colSpan = 7; td.className = 'reminder-empty'; td.textContent = '暂无提醒事项';
      tr.appendChild(td); tbody.appendChild(tr);
      return;
    }
    list.forEach(function (r) {
      var nextAt = computeNextAt(r);
      var remaining = nextAt ? (nextAt.getTime() - Date.now()) : 0;
      var tr = document.createElement('tr');

      var td1 = document.createElement('td'); td1.textContent = r.name || '未命名'; tr.appendChild(td1);

      var td2 = document.createElement('td');
      var span2 = document.createElement('span');
      span2.className = 'reminder-cat-badge cat-' + (r.category || 'work');
      span2.textContent = catLabel(r.category);
      td2.appendChild(span2); tr.appendChild(td2);

      var td3 = document.createElement('td'); td3.textContent = repeatLabel(r.repeat); tr.appendChild(td3);
      var td4 = document.createElement('td'); td4.textContent = r.emailNotify ? '邮件' : '—'; tr.appendChild(td4);

      var td5 = document.createElement('td'); td5.className = 'reminder-remaining';
      td5.textContent = formatRemaining(remaining); tr.appendChild(td5);

      var td6 = document.createElement('td'); td6.textContent = formatDateTime(nextAt); tr.appendChild(td6);

      var td7 = document.createElement('td');
      var pinBtn = document.createElement('button');
      pinBtn.type = 'button';
      pinBtn.className = 'btn btn-small btn-ghost';
      pinBtn.textContent = r.pinned ? '取消前台' : '前台显示';
      pinBtn.addEventListener('click', function () {
        r.pinned = !r.pinned; saveRemindersToStorage(); renderReminderList(); renderDashboard();
      });
      td7.appendChild(pinBtn);

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-small btn-danger';
      delBtn.textContent = '删除';
      delBtn.style.marginLeft = '6px';
      delBtn.addEventListener('click', function () {
        askConfirm({ title: '删除提醒', message: '确认删除「' + (r.name || '') + '」吗？', confirmText: '确认删除' }).then(function (ok) {
          if (!ok) return;
          reminderState.list = reminderState.list.filter(function (x) { return x.id !== r.id; });
          saveRemindersToStorage(); renderReminderList(); renderDashboard();
          notify('success', '已删除。', 4000);
        });
      });
      td7.appendChild(delBtn);

      tr.appendChild(td7);
      tbody.appendChild(tr);
    });
  }

  function renderPinnedReminders() {
    var box = byId('pinnedRemindersList');
    var section = byId('pinnedRemindersSection');
    if (!box || !section) return;
    var list = reminderState.list.filter(function (r) { return r.pinned; });
    box.textContent = '';
    if (list.length === 0) { section.style.display = 'none'; return; }
    section.style.display = '';
    list.forEach(function (r) {
      var nextAt = computeNextAt(r);
      var card = document.createElement('div');
      card.className = 'pinned-reminder-card';
      var name = document.createElement('span'); name.className = 'pinned-reminder-name'; name.textContent = '⏰ ' + (r.name || '');
      card.appendChild(name);
      var t = document.createElement('span'); t.className = 'pinned-reminder-time';
      t.textContent = formatDateTime(nextAt) + ' · ' + formatRemaining(nextAt ? (nextAt.getTime() - Date.now()) : 0);
      card.appendChild(t);
      box.appendChild(card);
    });
  }

  function openReminderModal() {
    var r = reminderState.editing;
    byId('reminderModalTitle').textContent = r ? '编辑倒计时' : '新增倒计时';
    byId('reminderName').value = r ? (r.name || '') : '';
    byId('reminderDate').value = r ? (r.date || '') : '';
    byId('reminderTime').value = r ? (r.time || '') : '';
    byId('reminderCat').value = r ? (r.category || 'work') : 'work';
    byId('reminderRepeat').value = r ? (r.repeat || 'once') : 'once';
    byId('reminderEmail').checked = r ? !!r.emailNotify : false;
    byId('reminderError').classList.add('hidden');
    byId('reminderError').textContent = '';
    showModal('reminderModal');
    byId('reminderName').focus();
  }

  function saveReminderFromModal() {
    var name = String(byId('reminderName').value || '').trim();
    var date = String(byId('reminderDate').value || '');
    var time = String(byId('reminderTime').value || '');
    var cat = String(byId('reminderCat').value || 'work');
    var rep = String(byId('reminderRepeat').value || 'once');
    var email = !!byId('reminderEmail').checked;
    var errEl = byId('reminderError');
    errEl.classList.add('hidden'); errEl.textContent = '';
    if (!name) { errEl.textContent = '名称不能为空。'; errEl.classList.remove('hidden'); return; }
    if (!date) { errEl.textContent = '请选择日期。'; errEl.classList.remove('hidden'); return; }
    if (!time) { errEl.textContent = '请选择时间。'; errEl.classList.remove('hidden'); return; }
    if (reminderState.editing) {
      var target = reminderState.list.find(function (x) { return x.id === reminderState.editing.id; });
      if (target) {
        target.name = name; target.date = date; target.time = time;
        target.category = cat; target.repeat = rep; target.emailNotify = email;
      }
    } else {
      reminderState.list.push({
        id: newId('reminder'), name: name, date: date, time: time,
        category: cat, repeat: rep, emailNotify: email, pinned: false,
        createdAt: new Date().toISOString()
      });
    }
    saveRemindersToStorage();
    hideModal('reminderModal');
    reminderState.editing = null;
    renderReminderList();
    renderDashboard();
    notify('success', '已保存。', 4000);
  }

  function checkDueReminders() {
    var now = Date.now();
    reminderState.list.forEach(function (r) {
      var nextAt = computeNextAt(r);
      if (!nextAt) return;
      var diff = nextAt.getTime() - now;
      var key = r.id + '_' + nextAt.getTime();
      if (diff <= 0 && diff > -60000 && !reminderState.notified[key]) {
        reminderState.notified[key] = true;
        notify('warn', '⏰ 提醒：' + (r.name || '') + '（' + catLabel(r.category) + '）', 20000);
      }
    });
  }

  /* ===== 排序 / 筛选 ===== */
  function getSortedCategories() {
    if (!state.data) return [];
    var list = state.data.categories.slice();
    list.sort(function (a, b) {
      var ma = a.marked ? 1 : 0, mb = b.marked ? 1 : 0;
      if (ma !== mb) return mb - ma;
      return (new Date(b.updatedAt || 0).getTime() || 0) - (new Date(a.updatedAt || 0).getTime() || 0);
    });
    return list;
  }
  function getSortedNotes(categoryId) {
    if (!state.data) return [];
    var list = state.data.notes.filter(function (n) { return n.categoryId === categoryId; });
    list.sort(function (a, b) {
      var ma = a.marked ? 1 : 0, mb = b.marked ? 1 : 0;
      if (ma !== mb) return mb - ma;
      return (new Date(b.updatedAt || 0).getTime() || 0) - (new Date(a.updatedAt || 0).getTime() || 0);
    });
    return list;
  }

  function noteMatches(note, keyword) {
    if (!keyword) return false;
    if (String(note.title || '').toLowerCase().indexOf(keyword) !== -1) return true;
    if (String(note.content || '').toLowerCase().indexOf(keyword) !== -1) return true;
    var hit = false;
    (note.images || []).forEach(function (img) {
      if (String(img.originalName || '').toLowerCase().indexOf(keyword) !== -1) hit = true;
      if (String(img.description || '').toLowerCase().indexOf(keyword) !== -1) hit = true;
    });
    (note.attachments || []).forEach(function (f) { if (String(f.originalName || '').toLowerCase().indexOf(keyword) !== -1) hit = true; });
    return hit;
  }

  function getVisibleGroups() {
    var keyword = String(state.searchKeyword || '').trim().toLowerCase();
    var groups = [];
    getSortedCategories().forEach(function (cat) {
      var notes = getSortedNotes(cat.id);
      var visible;
      if (!keyword) visible = notes;
      else if (String(cat.name || '').toLowerCase().indexOf(keyword) !== -1) visible = notes;
      else visible = notes.filter(function (n) { return noteMatches(n, keyword); });
      if (keyword && visible.length === 0) return;
      groups.push({ category: cat, notes: visible });
    });
    return groups;
  }

  function isCategoryCollapsed(cat) {
    if (Object.prototype.hasOwnProperty.call(state.collapsedCategories, cat.id)) return !!state.collapsedCategories[cat.id];
    return !!cat.collapsed;
  }

  function setHighlightedText(el, text, keyword) {
    el.textContent = '';
    var source = String(text === undefined || text === null ? '' : text);
    var kw = String(keyword || '');
    if (!kw) { el.appendChild(document.createTextNode(source)); return; }
    var ls = source.toLowerCase(), lk = kw.toLowerCase();
    var index = 0, pos = ls.indexOf(lk, index), guard = 0;
    while (pos !== -1 && guard < 2000) {
      guard++;
      if (pos > index) el.appendChild(document.createTextNode(source.slice(index, pos)));
      var mark = document.createElement('mark'); mark.className = 'hl';
      mark.textContent = source.slice(pos, pos + lk.length); el.appendChild(mark);
      index = pos + lk.length; pos = ls.indexOf(lk, index);
    }
    if (index < source.length) el.appendChild(document.createTextNode(source.slice(index)));
  }

  function renderSidebar() {
    var container = byId('categoryNav'); if (!container) return;
    container.textContent = '';
    if (!state.data) { var p = document.createElement('p'); p.className = 'empty-hint'; p.textContent = '加载中...'; container.appendChild(p); return; }
    var keyword = String(state.searchKeyword || '').trim().toLowerCase();
    var groups = getVisibleGroups();
    if (groups.length === 0) { var p2 = document.createElement('p'); p2.className = 'empty-hint'; p2.textContent = keyword ? '未找到匹配的笔记' : '暂无目录'; container.appendChild(p2); return; }
    groups.forEach(function (group) {
      var cat = group.category;
      var collapsed = isCategoryCollapsed(cat);
      var item = document.createElement('div'); item.className = 'cat-nav-item';
      var head = document.createElement('div'); head.className = 'cat-nav-head';
      head.addEventListener('click', function () { state.collapsedCategories[cat.id] = !isCategoryCollapsed(cat); renderSidebar(); });
      var toggle = document.createElement('span'); toggle.textContent = collapsed ? '▶' : '▼'; toggle.style.fontSize = '0.7rem'; toggle.style.width = '12px';
      head.appendChild(toggle);
      var nameEl = document.createElement('span'); nameEl.className = 'cat-nav-name'; setHighlightedText(nameEl, cat.name, keyword); head.appendChild(nameEl);
      var countEl = document.createElement('span'); countEl.className = 'cat-nav-count'; countEl.textContent = String(group.notes.length); head.appendChild(countEl);
      item.appendChild(head);
      if (!collapsed) {
        var ul = document.createElement('ul'); ul.className = 'cat-nav-notes';
        group.notes.forEach(function (note) {
          var li = document.createElement('li');
          var a = document.createElement('a');
          a.className = 'cat-nav-link' + (state.currentView === 'note' && state.currentNoteId === note.id ? ' active' : '');
          a.href = '#';
          setHighlightedText(a, note.title, keyword);
          if (note.marked) a.textContent = a.textContent + ' ⭐';
          a.addEventListener('click', function (e) {
            e.preventDefault(); state.currentView = 'note'; state.currentNoteId = note.id; render();
          });
          li.appendChild(a); ul.appendChild(li);
        });
        item.appendChild(ul);
      }
      container.appendChild(item);
    });
  }

  function renderSidebarActive() {
    var map = { dashboard: 'sideToolDashboard', pomodoro: 'sideToolPomodoro', timer: 'sideToolTimer' };
    ['sideToolDashboard', 'sideToolPomodoro', 'sideToolTimer'].forEach(function (id) { var el = byId(id); if (el) el.classList.remove('active'); });
    var activeId = map[state.currentView];
    if (activeId) { var el2 = byId(activeId); if (el2) el2.classList.add('active'); }
  }

  function renderQuickLinks() {
    var grid = byId('quickLinksGrid'); if (!grid) return;
    grid.textContent = '';
    var links = CONFIG.QUICK_LINKS || [];
    if (links.length === 0) {
      var p = document.createElement('p'); p.className = 'empty-hint';
      p.textContent = '暂无常用链接，可在 config.js 中修改 QUICK_LINKS。';
      grid.appendChild(p); return;
    }
    links.forEach(function (link) {
      var a = document.createElement('a');
      a.className = 'quick-link-card';
      a.href = link.url || '#';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      var icon = document.createElement('div'); icon.className = 'quick-link-icon'; icon.textContent = link.icon || '🔗';
      a.appendChild(icon);
      var name = document.createElement('div'); name.className = 'quick-link-name'; name.textContent = link.name || link.url || '';
      a.appendChild(name);
      grid.appendChild(a);
    });
  }

  function renderDashboard() {
    var dv = byId('dashboardView');
    if (dv) dv.classList.remove('hidden');
    updateClock();  // ★ 每次进主页刷新时间
    var hour = new Date().getHours();
    var greeting = '早上好';
    if (hour >= 12 && hour < 18) greeting = '下午好';
    else if (hour >= 18) greeting = '晚上好';
    var gEl = byId('greetingText');
    if (gEl) gEl.textContent = greeting + '，欢迎回来';
    if (state.data) {
      byId('statTotalNotes').textContent = String(state.data.notes.length);
      byId('statMarkedNotes').textContent = String(state.data.notes.filter(function (n) { return n.marked; }).length);
      byId('statTotalCategories').textContent = String(state.data.categories.length);
    }
    renderQuickLinks();
    renderPinnedReminders();
  }

  function renderNoteView(noteId) {
    byId('noteView').classList.remove('hidden');
    var note = state.data.notes.find(function (n) { return n.id === noteId; });
    if (!note) {
      byId('noteViewTitle').textContent = '笔记不存在';
      byId('noteViewContent').textContent = '该笔记可能已被删除，请返回主页。';
      return;
    }
    var cat = state.data.categories.find(function (c) { return c.id === note.categoryId; });
    byId('noteViewTitle').textContent = note.title;
    byId('noteViewMeta').textContent = '所属目录：' + (cat ? cat.name : '未知') + ' · 创建：' + formatTime(note.createdAt) + ' · 最后修改：' + formatTime(note.updatedAt) + (note.marked ? ' · ⭐ 重点笔记' : '');
    byId('noteViewContent').textContent = note.content || '（无正文）';
    var gallery = byId('noteViewGallery'); gallery.textContent = '';
    (note.images || []).forEach(function (img) {
      var fig = document.createElement('figure'); fig.className = 'note-figure';
      var a = document.createElement('a'); a.href = assetUrl(img.path); a.target = '_blank'; a.rel = 'noopener noreferrer';
      var im = document.createElement('img'); im.src = assetUrl(img.path); im.alt = img.description || img.originalName;
      a.appendChild(im); fig.appendChild(a);
      var cap = document.createElement('figcaption'); cap.textContent = img.description || img.originalName;
      fig.appendChild(cap); gallery.appendChild(fig);
    });
    var atts = byId('noteViewAttachments'); atts.textContent = '';
    (note.attachments || []).forEach(function (f) {
      var li = document.createElement('li');
      var a = document.createElement('a'); a.href = assetUrl(f.path); a.download = f.originalName; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = '📎 ' + f.originalName; li.appendChild(a);
      var size = document.createElement('span'); size.className = 'file-info'; size.textContent = '（' + formatSize(f.size) + '）';
      li.appendChild(size); atts.appendChild(li);
    });
    var markBtn = byId('btnToggleMarkCurrentNote');
    if (markBtn) markBtn.textContent = note.marked ? '取消重点' : '设为重点';
  }

  function hideAllViews() {
    ['dashboardView', 'noteView', 'pomodoroView', 'timerView'].forEach(function (id) {
      var el = byId(id); if (el) el.classList.add('hidden');
    });
  }

  function render() {
    renderSidebar();
    renderSidebarActive();
    hideAllViews();
    if (state.currentView === 'dashboard') renderDashboard();
    else if (state.currentView === 'note') renderNoteView(state.currentNoteId);
    else if (state.currentView === 'pomodoro') { byId('pomodoroView').classList.remove('hidden'); updatePomodoroDisplay(); }
    else if (state.currentView === 'timer') { byId('timerView').classList.remove('hidden'); renderReminderCatTabs(); renderReminderList(); }
  }

  function fillCategorySelect(select, selectedId) {
    if (!select) return;
    select.textContent = '';
    var cats = getSortedCategories();
    if (cats.length === 0) { var o = document.createElement('option'); o.value = ''; o.textContent = '（暂无目录）'; select.appendChild(o); return; }
    cats.forEach(function (c) {
      var o = document.createElement('option'); o.value = c.id; o.textContent = c.name + (c.marked ? '（重点）' : '');
      if (c.id === selectedId) o.selected = true;
      select.appendChild(o);
    });
  }

  function loadRemoteData(options) {
    options = options || {};
    if (state.busy) return Promise.resolve();
    state.busy = true;
    var tip = options.silent ? null : notify('info', '正在读取远端数据…', 0);
    return fetchRemoteNotes().then(function (result) {
      state.data = result.json;
      state.remoteUpdatedAt = result.json.updatedAt;
      state.collapsedCategories = {}; state.collapsedNotes = {};
      render();
      if (tip) tip.remove();
      if (!options.silent) notify('success', '远端数据已加载。', 4000);
    }).catch(function (err) {
      if (tip) tip.remove();
      render();
      notify('error', (err && err.message) || '读取远端数据失败。', 12000);
    }).then(function () { state.busy = false; });
  }

  function verifyToken(token) {
    if (!CONFIG.OWNER || !CONFIG.REPO) return Promise.reject(new AppError('config.js 中 OWNER 或 REPO 未填写。', 0));
    return ghFetch(apiBase(), { token: token }).then(function (info) {
      if (!info || !info.full_name) throw new AppError('无法访问该仓库。', 404);
      return fetchRemoteNotes(token).catch(function (err) {
        if (err && err.status === 404) throw new AppError('可访问仓库，但读取 notes.json 失败。', 404);
        throw err;
      });
    });
  }

  function enterEditMode() {
    if (state.editing) { notify('info', '当前已是编辑模式。', 4000); return; }
    byId('tokenInput').value = '';
    byId('tokenError').classList.add('hidden'); byId('tokenError').textContent = '';
    showModal('tokenModal');
    byId('tokenInput').focus();
  }

  function confirmEnterEditMode() {
    var input = byId('tokenInput'); var errEl = byId('tokenError'); var btn = byId('btnTokenConfirm');
    var token = String(input.value || '').trim();
    errEl.classList.add('hidden'); errEl.textContent = '';
    if (!token) { errEl.textContent = '请输入 Token。'; errEl.classList.remove('hidden'); return; }
    btn.disabled = true; btn.textContent = '正在验证…';
    verifyToken(token).then(function () {
      state.token = token; state.editing = true;
      try { sessionStorage.setItem(TOKEN_STORAGE_KEY, token); } catch (e) {}
      input.value = '';
      hideModal('tokenModal');
      document.body.classList.add('edit-mode');
      render();
      notify('success', '已进入编辑模式。', 8000);
      return loadRemoteData({ silent: true });
    }).catch(function (err) {
      errEl.textContent = (err && err.message) || 'Token 验证失败。';
      errEl.classList.remove('hidden');
    }).then(function () { btn.disabled = false; btn.textContent = '进入编辑模式'; });
  }

  function exitEditMode() {
    state.token = null; state.editing = false;
    try { sessionStorage.removeItem(TOKEN_STORAGE_KEY); } catch (e) {}
    byId('tokenInput').value = '';
    editNoteCtx.noteId = null; editNoteCtx.images = []; editNoteCtx.files = [];
    editNoteCtx.removedImages = []; editNoteCtx.removedFiles = [];
    hideModal('editNoteModal'); hideModal('tokenModal');
    document.body.classList.remove('edit-mode');
    render();
    notify('info', '已退出编辑模式。', 5000);
  }

  function openEditNote(noteId) {
    if (!state.editing) return;
    if (noteId) {
      var note = state.data.notes.find(function (n) { return n.id === noteId; });
      if (!note) { notify('error', '找不到该笔记。', 8000); return; }
      editNoteCtx.noteId = noteId;
      byId('editNoteModalTitle').textContent = '编辑笔记';
      byId('editNoteTitle').value = note.title;
      byId('editNoteContent').value = note.content || '';
      byId('editNoteMarked').checked = !!note.marked;
      fillCategorySelect(byId('editNoteCategory'), note.categoryId);
    } else {
      editNoteCtx.noteId = null;
      byId('editNoteModalTitle').textContent = '新增笔记';
      byId('editNoteTitle').value = '';
      byId('editNoteContent').value = '';
      byId('editNoteMarked').checked = false;
      fillCategorySelect(byId('editNoteCategory'), '');
    }
    editNoteCtx.images = []; editNoteCtx.files = [];
    editNoteCtx.removedImages = []; editNoteCtx.removedFiles = [];
    byId('editNoteImages').value = ''; byId('editNoteFiles').value = '';
    byId('editNoteError').classList.add('hidden'); byId('editNoteError').textContent = '';
    renderEditExistingMedia(); bindEditNotePreviews();
    showModal('editNoteModal'); byId('editNoteTitle').focus();
  }

  function renderEditExistingMedia() {
    var imgBox = byId('editNoteExistingImages'); var fileBox = byId('editNoteExistingFiles');
    imgBox.textContent = ''; fileBox.textContent = '';
    if (!editNoteCtx.noteId) return;
    var note = state.data.notes.find(function (n) { return n.id === editNoteCtx.noteId; });
    if (!note) return;
    var images = (note.images || []).filter(function (img) { return editNoteCtx.removedImages.indexOf(img.id) === -1; });
    var files = (note.attachments || []).filter(function (f) { return editNoteCtx.removedFiles.indexOf(f.id) === -1; });
    if (images.length === 0) { var p = document.createElement('p'); p.className = 'empty-hint'; p.textContent = '暂无图片'; imgBox.appendChild(p); }
    else images.forEach(function (img) {
      var row = document.createElement('div'); row.className = 'pending-item';
      var im = document.createElement('img'); im.src = assetUrl(img.path); im.alt = img.originalName || ''; row.appendChild(im);
      var name = document.createElement('span'); name.className = 'pending-name'; name.textContent = (img.originalName || '') + '（' + formatSize(img.size) + '）'; row.appendChild(name);
      var del = document.createElement('button'); del.type = 'button'; del.className = 'btn btn-small btn-danger'; del.textContent = '删除';
      del.addEventListener('click', function () {
        askConfirm({ title: '删除图片', message: '确认删除图片「' + (img.originalName || '') + '」吗？', confirmText: '标记删除' }).then(function (ok) {
          if (!ok) return; editNoteCtx.removedImages.push(img.id); renderEditExistingMedia();
        });
      });
      row.appendChild(del); imgBox.appendChild(row);
    });
    if (files.length === 0) { var p2 = document.createElement('p'); p2.className = 'empty-hint'; p2.textContent = '暂无附件'; fileBox.appendChild(p2); }
    else files.forEach(function (f) {
      var row = document.createElement('div'); row.className = 'pending-item';
      var name = document.createElement('span'); name.className = 'pending-name'; name.textContent = (f.originalName || '') + '（' + formatSize(f.size) + '）'; row.appendChild(name);
      var del = document.createElement('button'); del.type = 'button'; del.className = 'btn btn-small btn-danger'; del.textContent = '删除';
      del.addEventListener('click', function () {
        askConfirm({ title: '删除附件', message: '确认删除附件「' + (f.originalName || '') + '」吗？', confirmText: '标记删除' }).then(function (ok) {
          if (!ok) return; editNoteCtx.removedFiles.push(f.id); renderEditExistingMedia();
        });
      });
      row.appendChild(del); fileBox.appendChild(row);
    });
  }

  function renderPendingList(container, items, kind, onRemove) {
    if (!container) return;
    container.textContent = '';
    items.forEach(function (item) {
      var row = document.createElement('div'); row.className = 'pending-item';
      if (kind === 'image') { var im = document.createElement('img'); im.src = item.previewUrl; im.alt = item.file.name; row.appendChild(im); }
      var nameEl = document.createElement('span'); nameEl.className = 'pending-name';
      nameEl.textContent = item.file.name + '（' + formatSize(item.file.size) + '）'; row.appendChild(nameEl);
      if (kind === 'image') {
        var descWrap = document.createElement('div'); descWrap.className = 'pending-desc';
        var label = document.createElement('label'); label.className = 'field-label'; label.textContent = '图片说明';
        var id = 'desc-' + item.id; label.setAttribute('for', id);
        var inp = document.createElement('input'); inp.type = 'text'; inp.id = id; inp.value = item.description || ''; inp.maxLength = 200;
        inp.addEventListener('input', function () { item.description = inp.value; });
        descWrap.appendChild(label); descWrap.appendChild(inp); row.appendChild(descWrap);
      }
      var status = document.createElement('span'); status.className = 'pending-status status-' + item.status; status.textContent = item.statusText;
      row.appendChild(status); item.statusEl = status;
      var del = document.createElement('button'); del.type = 'button'; del.className = 'btn btn-small btn-danger'; del.textContent = '移除';
      del.addEventListener('click', function () { onRemove(item); });
      row.appendChild(del);
      container.appendChild(row);
    });
  }

  function removePendingItem(list, item) {
    var idx = list.indexOf(item); if (idx !== -1) list.splice(idx, 1);
    if (item.previewUrl) { try { URL.revokeObjectURL(item.previewUrl); } catch (e) {} }
  }

  function updatePendingStatus(item, status) {
    item.status = status;
    item.statusText = status === 'uploading' ? '正在上传' : status === 'done' ? '上传成功' : status === 'error' ? '上传失败' : '等待上传';
    if (item.statusEl) { item.statusEl.className = 'pending-status status-' + item.status; item.statusEl.textContent = item.statusText; }
  }

  function bindEditNotePreviews() {
    renderPendingList(byId('editNoteImagePreview'), editNoteCtx.images, 'image', function (item) { removePendingItem(editNoteCtx.images, item); bindEditNotePreviews(); });
    renderPendingList(byId('editNoteFilePreview'), editNoteCtx.files, 'file', function (item) { removePendingItem(editNoteCtx.files, item); bindEditNotePreviews(); });
  }

  function handleEditNoteImageSelect(files) {
    var problems = [];
    Array.prototype.forEach.call(files, function (file) {
      var err = validateImageFile(file);
      if (err) { problems.push(file.name + '：' + err); return; }
      editNoteCtx.images.push({ id: newId('image'), file: file, description: '', previewUrl: URL.createObjectURL(file), status: 'waiting', statusText: '等待上传' });
    });
    if (problems.length) notify('error', '以下图片未通过校验：\n' + problems.join('\n'), 12000);
    bindEditNotePreviews();
  }

  function handleEditNoteFileSelect(files) {
    var problems = [];
    Array.prototype.forEach.call(files, function (file) {
      var err = validateAttachmentFile(file);
      if (err) { problems.push(file.name + '：' + err); return; }
      editNoteCtx.files.push({ id: newId('file'), file: file, status: 'waiting', statusText: '等待上传' });
    });
    if (problems.length) notify('error', '以下附件未通过校验：\n' + problems.join('\n'), 12000);
    bindEditNotePreviews();
  }

  function closeEditNoteModal() {
    editNoteCtx.images.forEach(function (it) { if (it.previewUrl) { try { URL.revokeObjectURL(it.previewUrl); } catch (e) {} } });
    editNoteCtx.noteId = null; editNoteCtx.images = []; editNoteCtx.files = [];
    editNoteCtx.removedImages = []; editNoteCtx.removedFiles = [];
    hideModal('editNoteModal');
  }

  function saveEditNote() {
    if (!state.editing) return;
    var isNew = !editNoteCtx.noteId;
    var noteId = isNew ? newId('note') : editNoteCtx.noteId;
    var title = String(byId('editNoteTitle').value || '').trim();
    var content = String(byId('editNoteContent').value || '');
    var marked = !!byId('editNoteMarked').checked;
    var categoryId = String(byId('editNoteCategory').value || '');
    var saveBtn = byId('btnSaveEditNote'); var errEl = byId('editNoteError');
    errEl.classList.add('hidden'); errEl.textContent = '';
    if (!title) { errEl.textContent = '笔记标题必须填写。'; errEl.classList.remove('hidden'); return; }
    if (!categoryId) { errEl.textContent = '请选择所属目录。'; errEl.classList.remove('hidden'); return; }
    var note = isNew ? null : state.data.notes.find(function (n) { return n.id === noteId; });
    if (!isNew && !note) { errEl.textContent = '找不到要编辑的笔记。'; errEl.classList.remove('hidden'); return; }
    var keptImages = note ? (note.images || []).filter(function (img) { return editNoteCtx.removedImages.indexOf(img.id) === -1; }) : [];
    var keptFiles = note ? (note.attachments || []).filter(function (f) { return editNoteCtx.removedFiles.indexOf(f.id) === -1; }) : [];
    if (!content.trim() && keptImages.length === 0 && editNoteCtx.images.length === 0 && keptFiles.length === 0 && editNoteCtx.files.length === 0) {
      errEl.textContent = '标题、图片和附件不能全部为空。'; errEl.classList.remove('hidden'); return;
    }
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    var working = notify('info', '正在保存…', 0);
    var warnings = [];
    var uploadedImages = [], uploadedFiles = [], reallyRemovedImages = [], reallyRemovedFiles = [];
    var chain = Promise.resolve();
    editNoteCtx.images.forEach(function (item) {
      chain = chain.then(function () {
        updatePendingStatus(item, 'uploading');
        return uploadAttachment('image', noteId, item).then(function (meta) { uploadedImages.push(meta); updatePendingStatus(item, 'done'); })
          .catch(function (err) { updatePendingStatus(item, 'error'); throw new AppError('图片「' + item.file.name + '」上传失败：' + ((err && err.message) || ''), err && err.status); });
      });
    });
    editNoteCtx.files.forEach(function (item) {
      chain = chain.then(function () {
        updatePendingStatus(item, 'uploading');
        return uploadAttachment('file', noteId, item).then(function (meta) { uploadedFiles.push(meta); updatePendingStatus(item, 'done'); })
          .catch(function (err) { updatePendingStatus(item, 'error'); throw new AppError('附件「' + item.file.name + '」上传失败：' + ((err && err.message) || ''), err && err.status); });
      });
    });
    if (!isNew) {
      (note.images || []).forEach(function (img) {
        if (editNoteCtx.removedImages.indexOf(img.id) === -1) return;
        chain = chain.then(function () {
          return deleteRepoFile(img.path, '删除图片：' + (img.originalName || '')).then(function () { reallyRemovedImages.push(img.id); })
            .catch(function (err) { if (err && err.status === 404) reallyRemovedImages.push(img.id); else warnings.push('图片删除失败：' + img.path); });
        });
      });
      (note.attachments || []).forEach(function (f) {
        if (editNoteCtx.removedFiles.indexOf(f.id) === -1) return;
        chain = chain.then(function () {
          return deleteRepoFile(f.path, '删除附件：' + (f.originalName || '')).then(function () { reallyRemovedFiles.push(f.id); })
            .catch(function (err) { if (err && err.status === 404) reallyRemovedFiles.push(f.id); else warnings.push('附件删除失败：' + f.path); });
        });
      });
    }
    chain.then(function () {
      var next = deepClone(state.data);
      var nowIso = new Date().toISOString();
      if (isNew) {
        next.notes.push({ id: noteId, categoryId: categoryId, title: title, content: content, marked: marked, collapsed: false,
          images: uploadedImages, attachments: uploadedFiles, createdAt: nowIso, updatedAt: nowIso });
      } else {
        var target = next.notes.find(function (n) { return n.id === noteId; });
        target.categoryId = categoryId; target.title = title; target.content = content; target.marked = marked;
        target.images = (note.images || []).filter(function (img) { return reallyRemovedImages.indexOf(img.id) === -1; }).concat(uploadedImages);
        target.attachments = (note.attachments || []).filter(function (f) { return reallyRemovedFiles.indexOf(f.id) === -1; }).concat(uploadedFiles);
        target.updatedAt = nowIso;
      }
      return commitData(next, (isNew ? '新增笔记：' : '编辑笔记：') + title);
    }).then(function () {
      working.remove();
      notify('success', '已保存到 GitHub。' + (warnings.length ? '（' + warnings.join('；') + '）' : ''), warnings.length ? 15000 : 6000);
      closeEditNoteModal();
      if (isNew) { state.currentView = 'note'; state.currentNoteId = noteId; }
      render();
    }).catch(function (err) {
      working.remove();
      errEl.textContent = (err && err.message) || '保存失败。';
      errEl.classList.remove('hidden');
      notify('error', errEl.textContent, 15000);
    }).then(function () { saveBtn.disabled = false; });
  }

  function addCategory() {
    if (!state.editing) { notify('warn', '请先进入编辑模式。', 5000); return; }
    var input = byId('newCategoryName'); if (!input) return;
    var name = String(input.value || '').trim();
    if (!name) { notify('error', '目录名称不能为空。', 5000); return; }
    if (state.data.categories.some(function (c) { return c.name === name; })) { notify('error', '已存在同名目录。', 5000); return; }
    var nowIso = new Date().toISOString();
    var next = deepClone(state.data);
    next.categories.push({ id: newId('category'), name: name, marked: false, collapsed: false, createdAt: nowIso, updatedAt: nowIso });
    var tip = notify('info', '正在保存…', 0);
    commitData(next, '新增目录：' + name).then(function () { input.value = ''; tip.remove(); notify('success', '已保存到 GitHub。', 5000); render(); })
      .catch(function (err) { tip.remove(); notify('error', (err && err.message) || '保存失败。', 12000); });
  }

  function toggleNoteMarked(id) {
    if (!state.editing) return;
    var next = deepClone(state.data);
    var note = next.notes.find(function (n) { return n.id === id; });
    if (!note) return;
    note.marked = !note.marked; note.updatedAt = new Date().toISOString();
    var tip = notify('info', '正在保存…', 0);
    commitData(next, (note.marked ? '设为重点笔记：' : '取消重点笔记：') + note.title).then(function () { tip.remove(); notify('success', '已保存到 GitHub。', 5000); render(); })
      .catch(function (err) { tip.remove(); notify('error', (err && err.message) || '保存失败。', 12000); });
  }

  function deleteNote(id) {
    if (!state.editing) return;
    var note = state.data.notes.find(function (n) { return n.id === id; });
    if (!note) return;
    var imgCount = (note.images || []).length, fileCount = (note.attachments || []).length;
    var message = '确认删除笔记「' + note.title + '」吗？';
    if (imgCount > 0 || fileCount > 0) message += '\n\n该笔记有 ' + imgCount + ' 张图片和 ' + fileCount + ' 个附件，将一并删除。';
    askConfirm({ title: '删除笔记', message: message, confirmText: '确认删除' }).then(function (ok) {
      if (!ok) return;
      var tip = notify('info', '正在删除…', 0);
      var warnings = [];
      var chain = Promise.resolve();
      (note.images || []).forEach(function (img) {
        if (!img.path) return;
        chain = chain.then(function () {
          return deleteRepoFile(img.path, '删除图片：' + (img.originalName || '')).catch(function (err) { if (!err || err.status !== 404) warnings.push('图片删除失败：' + img.path); });
        });
      });
      (note.attachments || []).forEach(function (f) {
        if (!f.path) return;
        chain = chain.then(function () {
          return deleteRepoFile(f.path, '删除附件：' + (f.originalName || '')).catch(function (err) { if (!err || err.status !== 404) warnings.push('附件删除失败：' + f.path); });
        });
      });
      chain.then(function () {
        var next = deepClone(state.data);
        next.notes = next.notes.filter(function (n) { return n.id !== id; });
        return commitData(next, '删除笔记：' + note.title);
      }).then(function () {
        tip.remove();
        notify('success', '已保存到 GitHub。' + (warnings.length ? '（' + warnings.join('；') + '）' : ''), 12000);
        if (state.currentView === 'note' && state.currentNoteId === id) { state.currentView = 'dashboard'; state.currentNoteId = null; }
        render();
      }).catch(function (err) { tip.remove(); notify('error', (err && err.message) || '删除失败。', 12000); });
    });
  }

  function exportBackup() {
    if (!state.data) { notify('warn', '数据尚未加载。', 5000); return; }
    var text = JSON.stringify(state.data, null, 2);
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url; a.download = 'notes-backup-' + stamp + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    notify('success', '已导出 JSON 备份。', 9000);
  }

  function handleImportFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var raw;
      try { raw = JSON.parse(String(reader.result)); } catch (e) { notify('error', '导入失败：不是合法 JSON。', 10000); return; }
      var summaryEl = byId('importSummary'), errEl = byId('importError');
      summaryEl.textContent = ''; errEl.classList.add('hidden');
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.categories) || !Array.isArray(raw.notes)) {
        summaryEl.textContent = '导入失败：categories 或 notes 不是数组。';
        byId('btnImportConfirm').disabled = true; importCandidate = null; showModal('importModal'); return;
      }
      try {
        var normalized = normalizeData(raw);
        importCandidate = normalized;
        summaryEl.textContent = '结构校验通过。\n\n· 目录数量：' + normalized.categories.length + '\n· 笔记数量：' + normalized.notes.length + '\n\n确认导入后将覆盖 GitHub 上的 ' + CONFIG.NOTES_PATH + '。';
        byId('btnImportConfirm').disabled = false;
        showModal('importModal');
      } catch (e) {
        summaryEl.textContent = '导入失败：' + ((e && e.message) || '');
        byId('btnImportConfirm').disabled = true; importCandidate = null; showModal('importModal');
      }
    };
    reader.onerror = function () { notify('error', '读取 JSON 文件失败。', 8000); };
    reader.readAsText(file, 'utf-8');
  }

  function confirmImport() {
    if (!importCandidate) return;
    if (!state.editing) { notify('warn', '请先进入编辑模式。', 6000); return; }
    var btn = byId('btnImportConfirm'); btn.disabled = true;
    var tip = notify('info', '正在保存…', 0);
    commitData(importCandidate, '导入并覆盖 notes.json').then(function () {
      tip.remove(); hideModal('importModal'); importCandidate = null;
      notify('success', '已保存到 GitHub。', 6000); render();
    }).catch(function (err) {
      tip.remove();
      var errEl = byId('importError'); errEl.textContent = (err && err.message) || '导入失败。'; errEl.classList.remove('hidden');
    }).then(function () { btn.disabled = false; });
  }

  /* ===== Word 导入 ===== */
  var MAMMOTH_CDNS = ['https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js', 'https://unpkg.com/mammoth@1.8.0/mammoth.browser.min.js'];
  var mammothPromise = null;
  var wordCtx = { blocks: null, fileName: '', preview: null };
  function loadScriptOnce(src) { return new Promise(function (resolve, reject) { var s = document.createElement('script'); s.src = src; s.async = true; s.onload = function () { resolve(); }; s.onerror = function () { if (s.parentNode) s.parentNode.removeChild(s); reject(new Error('脚本加载失败')); }; document.head.appendChild(s); }); }
  function loadMammoth() { if (window.mammoth) return Promise.resolve(); if (mammothPromise) return mammothPromise; mammothPromise = (function () { var p = Promise.reject(); MAMMOTH_CDNS.forEach(function (url) { p = p.catch(function () { return loadScriptOnce(url).then(function () { if (!window.mammoth) throw new Error('mammoth 未加载'); }); }); }); return p.catch(function () { mammothPromise = null; throw new AppError('无法加载 Word 解析库。', 0); }); })(); return mammothPromise; }
  function extractBlocksFromHtml(html) {
    var parser = new DOMParser(); var doc = parser.parseFromString(html, 'text/html'); var blocks = [];
    function textOf(node) { return String(node.textContent || '').replace(/\s+/g, ' ').trim(); }
    function walk(node) {
      if (!node || node.nodeType !== 1) return;
      var tag = node.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) { var t = textOf(node); if (t) blocks.push({ type: 'heading', level: parseInt(tag.charAt(1), 10), text: t }); return; }
      if (tag === 'p') { var imgs = node.querySelectorAll('img'); var t2 = textOf(node); if (t2) blocks.push({ type: 'paragraph', text: t2 }); else if (imgs.length) blocks.push({ type: 'paragraph', text: '[图片]' }); return; }
      if (tag === 'ul' || tag === 'ol') { var items = []; Array.prototype.forEach.call(node.children, function (li) { if (li.tagName.toLowerCase() !== 'li') return; var t3 = textOf(li); if (t3) items.push('· ' + t3); }); if (items.length) blocks.push({ type: 'paragraph', text: items.join('\n') }); return; }
      Array.prototype.forEach.call(node.childNodes, walk);
    }
    Array.prototype.forEach.call(doc.body.childNodes, walk);
    return blocks;
  }
  function buildWordPreview(blocks, mode, fileName) {
    if (mode === 'single') {
      var lines = []; blocks.forEach(function (b) { if (b.type === 'heading') lines.push('【' + b.text + '】'); else lines.push(b.text); });
      return { mode: 'single', singleNote: { title: fileName || 'Word', content: lines.join('\n\n') } };
    }
    var categories = []; var currentCat = null, currentNoteTitle = null, buffer = [];
    function ensureCat(name) { var c = categories.find(function (x) { return x.name === name; }); if (!c) { c = { name: name, notes: [] }; categories.push(c); } return c; }
    function flush() { if (currentCat && (currentNoteTitle || buffer.length)) currentCat.notes.push({ title: currentNoteTitle || currentCat.name, content: buffer.join('\n\n').trim() }); buffer = []; currentNoteTitle = null; }
    blocks.forEach(function (b) {
      if (b.type === 'heading') {
        if (b.level === 1) { flush(); currentCat = ensureCat(b.text); }
        else if (b.level === 2) { flush(); if (!currentCat) currentCat = ensureCat(fileName || 'Word'); currentNoteTitle = b.text; }
        else { if (currentNoteTitle) buffer.push('【' + b.text + '】'); }
      } else buffer.push(b.text);
    });
    flush();
    return { mode: 'h1-h2', categories: categories.filter(function (c) { return c.notes.length > 0; }) };
  }
  function refreshWordPreview() {
    if (!wordCtx.blocks) return;
    var mode = byId('wordImportMode').value;
    var singleRow = byId('wordImportSingleRow'); if (singleRow) singleRow.style.display = (mode === 'single') ? '' : 'none';
    var preview = buildWordPreview(wordCtx.blocks, mode, wordCtx.fileName); wordCtx.preview = preview;
    var summaryEl = byId('wordImportSummary'), errEl = byId('wordImportError');
    errEl.classList.add('hidden');
    if (mode === 'h1-h2') {
      var totalNotes = preview.categories.reduce(function (acc, c) { return acc + c.notes.length; }, 0);
      var s = '导入方式：按标题层级\n识别到 ' + preview.categories.length + ' 个目录、' + totalNotes + ' 篇笔记\n\n';
      preview.categories.forEach(function (c) { s += '📁 ' + c.name + '（' + c.notes.length + ' 篇）\n'; c.notes.forEach(function (n) { s += '   📄 ' + n.title + '\n'; }); });
      summaryEl.textContent = s;
      byId('btnWordImportConfirm').disabled = preview.categories.length === 0;
      if (preview.categories.length === 0) { errEl.textContent = '未识别到标题结构。'; errEl.classList.remove('hidden'); }
    } else {
      summaryEl.textContent = '导入方式：整篇文档\n标题：' + preview.singleNote.title + '\n内容长度：' + preview.singleNote.content.length + ' 字符';
      byId('btnWordImportConfirm').disabled = false;
    }
  }
  function handleWordFile(file) {
    if (!state.editing) { notify('warn', '请先进入编辑模式。', 5000); return; }
    if (getExtension(file.name) !== 'docx') { notify('error', '只支持 .docx。', 8000); return; }
    wordCtx.fileName = file.name.replace(/\.docx$/i, ''); wordCtx.blocks = null; wordCtx.preview = null;
    var loading = notify('info', '正在解析 Word…', 0);
    loadMammoth().then(function () { return readFileAsArrayBuffer(file); })
      .then(function (buffer) { return window.mammoth.convertToHtml({ arrayBuffer: buffer }); })
      .then(function (result) {
        loading.remove();
        var blocks = extractBlocksFromHtml((result && result.value) || '');
        if (!blocks.length) throw new AppError('Word 中未找到有效内容。', 0);
        wordCtx.blocks = blocks;
        fillCategorySelect(byId('wordImportSingleCategory'), '');
        byId('wordImportMode').value = 'h1-h2';
        refreshWordPreview(); showModal('wordImportModal');
      }).catch(function (err) { loading.remove(); notify('error', (err && err.message) || '解析 Word 失败。', 12000); });
  }
  function executeWordImport() {
    if (!state.editing) { notify('warn', '请先进入编辑模式。', 5000); return; }
    var preview = wordCtx.preview; if (!preview) return;
    var btn = byId('btnWordImportConfirm'); if (btn.disabled) return; btn.disabled = true;
    var working = notify('info', '正在保存…', 0);
    var nowIso = new Date().toISOString();
    try {
      var next = deepClone(state.data);
      if (preview.mode === 'single') {
        var categoryId = String(byId('wordImportSingleCategory').value || '');
        if (!categoryId) throw new AppError('请选择目标目录。', 0);
        next.notes.push({ id: newId('note'), categoryId: categoryId, title: preview.singleNote.title, content: preview.singleNote.content,
          marked: false, collapsed: false, images: [], attachments: [], createdAt: nowIso, updatedAt: nowIso });
      } else {
        preview.categories.forEach(function (cp) {
          var cat = next.categories.find(function (c) { return c.name === cp.name; });
          if (!cat) { cat = { id: newId('category'), name: cp.name, marked: false, collapsed: false, createdAt: nowIso, updatedAt: nowIso }; next.categories.push(cat); }
          cp.notes.forEach(function (np) {
            next.notes.push({ id: newId('note'), categoryId: cat.id, title: np.title, content: np.content, marked: false, collapsed: false, images: [], attachments: [], createdAt: nowIso, updatedAt: nowIso });
          });
        });
      }
      commitData(next, '从 Word 导入：' + wordCtx.fileName).then(function () {
        working.remove(); hideModal('wordImportModal');
        wordCtx.blocks = null; wordCtx.preview = null; wordCtx.fileName = '';
        notify('success', '已保存到 GitHub。', 6000); render();
      }).catch(function (err) {
        working.remove();
        var errEl = byId('wordImportError'); errEl.textContent = (err && err.message) || '导入失败。'; errEl.classList.remove('hidden');
      }).then(function () { btn.disabled = false; });
    } catch (err) {
      working.remove(); btn.disabled = false;
      notify('error', (err && err.message) || '导入失败。', 12000);
    }
  }

  /* ===== 事件绑定 ===== */
  function bindEvents() {
    function safeBind(id, event, handler) {
      var el = byId(id);
      if (el) el.addEventListener(event, handler);
    }
    safeBind('btnEnterEdit', 'click', enterEditMode);
    safeBind('btnExitEdit', 'click', exitEditMode);
    safeBind('btnToggleToken', 'click', function () {
      var inp = byId('tokenInput'), btn = byId('btnToggleToken');
      if (inp.type === 'password') { inp.type = 'text'; btn.textContent = '隐藏'; } else { inp.type = 'password'; btn.textContent = '显示'; }
    });
    safeBind('btnTokenConfirm', 'click', confirmEnterEditMode);
    safeBind('btnTokenCancel', 'click', function () { byId('tokenInput').value = ''; hideModal('tokenModal'); });
    safeBind('tokenInput', 'keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); confirmEnterEditMode(); } });
    safeBind('confirmOkBtn', 'click', function () { resolveConfirm(true); });
    safeBind('confirmCancelBtn', 'click', function () { resolveConfirm(false); });
    safeBind('btnToggleSidebar', 'click', function () {
      byId('sidebar').classList.toggle('collapsed');
      byId('btnToggleSidebar').textContent = byId('sidebar').classList.contains('collapsed') ? '▶' : '◀';
    });
    ['sideToolDashboard', 'sideToolPomodoro', 'sideToolTimer'].forEach(function (id) {
      safeBind(id, 'click', function () {
        if (id === 'sideToolDashboard') state.currentView = 'dashboard';
        else if (id === 'sideToolPomodoro') state.currentView = 'pomodoro';
        else if (id === 'sideToolTimer') state.currentView = 'timer';
        render();
      });
    });
    safeBind('btnBackFromPomodoro', 'click', function () { state.currentView = 'dashboard'; render(); });
    safeBind('btnBackFromTimer', 'click', function () { state.currentView = 'dashboard'; render(); });
    safeBind('btnPomodoroStart', 'click', startPomodoro);
    safeBind('btnPomodoroPause', 'click', pausePomodoro);
    safeBind('btnPomodoroReset', 'click', resetPomodoro);

    safeBind('btnReminderAdd', 'click', function () { reminderState.editing = null; openReminderModal(); });
    safeBind('btnReminderCancel', 'click', function () { reminderState.editing = null; hideModal('reminderModal'); });
    safeBind('btnReminderSave', 'click', saveReminderFromModal);
    safeBind('btnReminderSearch', 'click', function () {
      reminderState.filter.search = String(byId('reminderSearch').value || '');
      reminderState.filter.cat = String(byId('reminderCatFilter').value || 'all');
      reminderState.filter.sort = String(byId('reminderSort').value || 'remaining');
      renderReminderCatTabs(); renderReminderList();
    });
    safeBind('reminderSearch', 'keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        reminderState.filter.search = String(byId('reminderSearch').value || '');
        renderReminderList();
      }
    });
    safeBind('reminderCatFilter', 'change', function () {
      reminderState.filter.cat = String(byId('reminderCatFilter').value || 'all');
      renderReminderCatTabs(); renderReminderList();
    });
    safeBind('reminderSort', 'change', function () {
      reminderState.filter.sort = String(byId('reminderSort').value || 'remaining');
      renderReminderList();
    });
    safeBind('btnReminderSortDir', 'click', function () {
      reminderState.filter.dir = reminderState.filter.dir === 'asc' ? 'desc' : 'asc';
      byId('btnReminderSortDir').textContent = reminderState.filter.dir === 'asc' ? '↑ 升序' : '↓ 降序';
      renderReminderList();
    });
    safeBind('btnReminderReset', 'click', function () {
      byId('reminderSearch').value = '';
      byId('reminderCatFilter').value = 'all';
      byId('reminderSort').value = 'remaining';
      reminderState.filter = { search: '', cat: 'all', sort: 'remaining', dir: 'asc' };
      byId('btnReminderSortDir').textContent = '↑ 升序';
      renderReminderCatTabs(); renderReminderList();
    });

    safeBind('searchInput', 'input', function () { state.searchKeyword = String(byId('searchInput').value || ''); renderSidebar(); });
    safeBind('btnClearSearch', 'click', function () { byId('searchInput').value = ''; state.searchKeyword = ''; renderSidebar(); });
    safeBind('btnQuickAddNote', 'click', function () { openEditNote(null); });
    safeBind('btnQuickReload', 'click', function () { loadRemoteData({}); });
    safeBind('btnQuickExport', 'click', exportBackup);
    safeBind('btnImportWordDash', 'click', function () { byId('wordFileInput').click(); });
    safeBind('btnBackToDash', 'click', function () { state.currentView = 'dashboard'; state.currentNoteId = null; render(); });
    safeBind('btnEditCurrentNote', 'click', function () { if (state.currentNoteId) openEditNote(state.currentNoteId); });
    safeBind('btnDeleteCurrentNote', 'click', function () { if (state.currentNoteId) deleteNote(state.currentNoteId); });
    safeBind('btnToggleMarkCurrentNote', 'click', function () { if (state.currentNoteId) toggleNoteMarked(state.currentNoteId); });
    safeBind('btnAddCategory', 'click', addCategory);
    safeBind('newCategoryName', 'keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); addCategory(); } });
    safeBind('editNoteImages', 'change', function (ev) { var files = ev.target.files; ev.target.value = ''; if (files && files.length) handleEditNoteImageSelect(files); });
    safeBind('editNoteFiles', 'change', function (ev) { var files = ev.target.files; ev.target.value = ''; if (files && files.length) handleEditNoteFileSelect(files); });
    safeBind('btnSaveEditNote', 'click', saveEditNote);
    safeBind('btnCancelEditNote', 'click', closeEditNoteModal);
    safeBind('importFileInput', 'change', function (ev) { var f = ev.target.files && ev.target.files[0]; ev.target.value = ''; if (f) handleImportFile(f); });
    safeBind('btnImportConfirm', 'click', confirmImport);
    safeBind('btnImportCancel', 'click', function () { importCandidate = null; hideModal('importModal'); });
    safeBind('wordFileInput', 'change', function (ev) { var f = ev.target.files && ev.target.files[0]; ev.target.value = ''; if (f) handleWordFile(f); });
    safeBind('wordImportMode', 'change', refreshWordPreview);
    safeBind('wordImportSingleCategory', 'change', refreshWordPreview);
    safeBind('btnWordImportConfirm', 'click', executeWordImport);
    safeBind('btnWordImportCancel', 'click', function () { wordCtx.blocks = null; wordCtx.preview = null; wordCtx.fileName = ''; hideModal('wordImportModal'); });

    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (!byId('confirmModal').classList.contains('hidden')) { resolveConfirm(false); return; }
      if (!byId('tokenModal').classList.contains('hidden')) { byId('tokenInput').value = ''; hideModal('tokenModal'); return; }
      if (!byId('importModal') || !byId('importModal').classList.contains('hidden')) { importCandidate = null; if (byId('importModal')) hideModal('importModal'); return; }
      if (!byId('editNoteModal').classList.contains('hidden')) { closeEditNoteModal(); return; }
      if (!byId('reminderModal').classList.contains('hidden')) { reminderState.editing = null; hideModal('reminderModal'); return; }
      if (!byId('wordImportModal').classList.contains('hidden')) { hideModal('wordImportModal'); return; }
    });
  }

  function init() {
    if (CONFIG.SITE_TITLE) document.title = CONFIG.SITE_TITLE;

    // 1) 最先启动时钟（即使后面出错也能运行）
    updateClock();
    setInterval(updateClock, 1000);

    try {
      var saved = sessionStorage.getItem(TOKEN_STORAGE_KEY);
      if (saved) { state.token = saved; state.editing = true; document.body.classList.add('edit-mode'); }
    } catch (e) {}
    try { toolState.pomodoroCount = parseInt(localStorage.getItem('pomodoroCount') || '0', 10) || 0; } catch (e) {}

    loadRemindersFromStorage();
    initReminderSelects();

    try { bindEvents(); } catch (e) { console.error('bindEvents 出错：', e); }
    try { render(); } catch (e) { console.error('render 出错：', e); }

    updatePomodoroDisplay();
    renderReminderList();

    // 每 30 秒检查一次到期提醒
    setInterval(checkDueReminders, 30000);

    loadRemoteData({ silent: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();