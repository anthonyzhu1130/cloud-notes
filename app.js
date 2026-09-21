/* =========================================================================
 * 云端分类笔记 —— app.js
 *
 * 纯前端实现，通过 GitHub REST Contents API 读写 data/notes.json 与附件文件。
 * 本文件不包含任何 Token。
 * ========================================================================= */
(function () {
  'use strict';

  /* =====================================================================
   * 0. 配置与常量
   * =================================================================== */

  const CONFIG = window.APP_CONFIG || {};

  const TOKEN_STORAGE_KEY = 'cloudNotes.githubToken';

  const DANGEROUS_MIME = [
    'text/html',
    'application/xhtml+xml',
    'image/svg+xml',
    'application/javascript',
    'text/javascript',
    'application/x-httpd-php',
    'application/x-msdownload',
    'application/x-sh',
    'text/x-shellscript',
    'application/x-msdos-program'
  ];

  const DANGEROUS_EXTENSIONS = [
    'html', 'htm', 'xhtml', 'svg', 'js', 'mjs', 'cjs', 'php', 'asp', 'aspx',
    'jsp', 'sh', 'bat', 'cmd', 'exe', 'dll', 'com', 'scr', 'vbs', 'jar'
  ];

  /* =====================================================================
   * 1. 错误类型
   * =================================================================== */

  class AppError extends Error {
    constructor(message, status, detail) {
      super(message);
      this.name = 'AppError';
      this.status = status || 0;
      this.detail = detail || '';
    }
  }

  /* =====================================================================
   * 2. 运行时状态
   * =================================================================== */

  const state = {
    data: null,
    remoteUpdatedAt: null,
    token: null,
    editing: false,
    searchKeyword: '',
    busy: false,
    collapsedCategories: Object.create(null),
    collapsedNotes: Object.create(null),
    currentView: 'dashboard',
    currentNoteId: null
  };

  // 番茄钟 / 倒计时的全局状态，只在页面初始化时创建一次
  const toolState = {
    pomodoroTimer: null,
    pomodoroTime: 25 * 60,
    pomodoroTotal: 25 * 60,
    pomodoroCount: 0,
    timerInterval: null,
    timerRemaining: 0
  };

  const newNoteCtx = {
    images: [],
    files: []
  };

  const editNoteCtx = {
    noteId: null,
    images: [],
    files: [],
    removedImages: [],
    removedFiles: []
  };

  let importCandidate = null;

  /* =====================================================================
   * 3. 通用工具
   * =================================================================== */

  function byId(id) {
    return document.getElementById(id);
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function newId(prefix) {
    let id;
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      id = window.crypto.randomUUID();
    } else if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      const arr = new Uint8Array(16);
      window.crypto.getRandomValues(arr);
      const parts = [];
      for (let i = 0; i < arr.length; i++) {
        parts.push(('0' + arr[i].toString(16)).slice(-2));
      }
      id = parts.join('');
    } else {
      let s = '';
      for (let i = 0; i < 16; i++) {
        s += Math.floor(Math.random() * 16).toString(16);
      }
      id = s + Date.now().toString(16);
    }
    return prefix ? prefix + '-' + id : id;
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function formatTime(iso) {
    if (!iso) return '未知';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function getExtension(name) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function safeFileName(name) {
    let n = String(name || 'file');
    n = n.replace(/\\/g, '/');
    const parts = n.split('/');
    n = parts[parts.length - 1];
    n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_');
    n = n.replace(/\.\./g, '_');
    n = n.replace(/^[.\s]+/, '_');
    n = n.replace(/\s+/g, '_');
    if (!n) n = 'file';
    if (n.length > 120) {
      const dot = n.lastIndexOf('.');
      if (dot > 3) {
        n = n.slice(0, 100) + n.slice(dot);
      } else {
        n = n.slice(0, 120);
      }
    }
    return n;
  }

  function guessMimeType(name) {
    const ext = getExtension(name);
    const map = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      txt: 'text/plain',
      csv: 'text/csv',
      zip: 'application/zip'
    };
    return map[ext] || 'application/octet-stream';
  }

  function assetUrl(path) {
    return String(path || '').split('/').map(encodeURIComponent).join('/');
  }

  /* =====================================================================
   * 4. Base64 与文件读取
   * =================================================================== */

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(String(str));
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToUtf8(b64) {
    const clean = String(b64 || '').replace(/[\r\n\s]/g, '');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function readFileAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () {
        reject(new AppError('读取本地文件失败：' + file.name, 0));
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /* =====================================================================
   * 5. GitHub API
   * =================================================================== */

  function apiBase() {
    return 'https://api.github.com/repos/' +
      encodeURIComponent(CONFIG.OWNER || '') + '/' +
      encodeURIComponent(CONFIG.REPO || '');
  }

  function contentsUrl(path) {
    const clean = String(path || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return apiBase() + '/contents/' + clean;
  }

  function describeError(status, detail) {
    const tail = detail ? '（GitHub 返回：' + detail + '）' : '';
    switch (status) {
      case 0:
        return '网络请求失败，请检查网络连接后重试。' + tail;
      case 401:
        return '身份验证失败，请检查 Token 是否正确或是否已过期。' + tail;
      case 403:
        if (/rate limit/i.test(detail)) {
          return 'GitHub API 请求次数受限（403）。请稍后再试，或稍后重新输入有效 Token。' + tail;
        }
        return '权限不足（403）：请检查 Token 是否具有该仓库 Contents 的读写权限、是否被组织仓库限制、分支是否被保护。' + tail;
      case 404:
        return '未找到资源（404）：请检查 GitHub 用户名、仓库名称、分支名称、文件路径是否正确，以及 Token 是否有权访问该私有仓库。' + tail;
      case 409:
        return '远端文件已经发生变化，可能有其他设备正在编辑。为避免覆盖最新内容，请重新加载远端数据后再编辑。' + tail;
      case 413:
        return '请求内容过大（413）：请压缩图片或选择更小的文件后重试。' + tail;
      case 422:
        return '请求参数错误（422）：请检查 Base64 内容、sha、分支、文件路径与提交参数是否正确。' + tail;
      default:
        return 'GitHub API 请求失败（HTTP ' + status + '）。' + tail;
    }
  }

  async function ghFetch(url, options) {
    options = options || {};
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': CONFIG.API_VERSION || '2022-11-28'
    };
    const token = options.token || null;
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }

    const init = {
      method: options.method || 'GET',
      headers: headers,
      cache: 'no-store'
    };

    if (options.body !== undefined && options.body !== null) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      init.body = JSON.stringify(options.body);
    }

    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new AppError(
        '网络请求失败，请检查网络连接后重试。',
        0,
        String((err && err.message) || err)
      );
    }

    if (!res.ok) {
      let detail = '';
      try {
        const data = await res.json();
        detail = (data && data.message) ? data.message : '';
      } catch (e) {
        detail = '';
      }
      throw new AppError(describeError(res.status, detail), res.status, detail);
    }

    if (res.status === 204) return null;

    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  async function fetchRemoteNotes(token) {
    const url = contentsUrl(CONFIG.NOTES_PATH) +
      '?ref=' + encodeURIComponent(CONFIG.BRANCH || 'main') +
      '&t=' + Date.now();

    const res = await ghFetch(url, { token: token || state.token || null });

    if (!res) {
      throw new AppError('远端 ' + CONFIG.NOTES_PATH + ' 返回了空数据。', 0);
    }

    let text = null;

    if (res.content && res.encoding === 'base64') {
      text = base64ToUtf8(res.content);
    } else if (res.download_url) {
      let r;
      try {
        r = await fetch(res.download_url + '?t=' + Date.now(), { cache: 'no-store' });
      } catch (e) {
        throw new AppError(
          '下载 ' + CONFIG.NOTES_PATH + ' 内容失败，请检查网络连接。',
          0,
          String((e && e.message) || e)
        );
      }
      if (!r.ok) {
        throw new AppError(
          '下载 ' + CONFIG.NOTES_PATH + ' 内容失败（HTTP ' + r.status + '）。',
          r.status
        );
      }
      text = await r.text();
    }

    if (typeof text !== 'string') {
      throw new AppError('无法读取远端 ' + CONFIG.NOTES_PATH + ' 的内容。', 0);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new AppError(
        '远端 ' + CONFIG.NOTES_PATH + ' 不是合法的 JSON。为防止覆盖远端数据，已停止操作，请先手动修复该文件。',
        0
      );
    }

    return {
      json: normalizeData(json),
      sha: res.sha || null
    };
  }

  /* =====================================================================
   * 6. 数据结构规范化与校验
   * =================================================================== */

  function normalizeMediaImage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      id: String(raw.id || newId('image')),
      originalName: String(raw.originalName || ''),
      storedName: String(raw.storedName || ''),
      path: String(raw.path || ''),
      mimeType: String(raw.mimeType || ''),
      size: Number(raw.size) || 0,
      description: String(raw.description || ''),
      sha: String(raw.sha || ''),
      createdAt: String(raw.createdAt || new Date().toISOString())
    };
  }

  function normalizeMediaFile(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      id: String(raw.id || newId('file')),
      originalName: String(raw.originalName || ''),
      storedName: String(raw.storedName || ''),
      path: String(raw.path || ''),
      mimeType: String(raw.mimeType || ''),
      size: Number(raw.size) || 0,
      sha: String(raw.sha || ''),
      createdAt: String(raw.createdAt || new Date().toISOString())
    };
  }

  function normalizeData(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AppError('notes.json 的数据结构不正确：顶层必须是一个对象。', 0);
    }
    if (raw.categories !== undefined && !Array.isArray(raw.categories)) {
      throw new AppError('notes.json 的数据结构不正确：categories 必须是数组。', 0);
    }
    if (raw.notes !== undefined && !Array.isArray(raw.notes)) {
      throw new AppError('notes.json 的数据结构不正确：notes 必须是数组。', 0);
    }

    const nowIso = new Date().toISOString();

    const data = {
      version: (typeof raw.version === 'number') ? raw.version : 1,
      updatedAt: (typeof raw.updatedAt === 'string') ? raw.updatedAt : nowIso,
      categories: [],
      notes: []
    };

    (raw.categories || []).forEach(function (c) {
      if (!c || typeof c !== 'object') return;
      data.categories.push({
        id: String(c.id || newId('category')),
        name: String(c.name || '未命名目录'),
        marked: !!c.marked,
        collapsed: !!c.collapsed,
        createdAt: String(c.createdAt || nowIso),
        updatedAt: String(c.updatedAt || c.createdAt || nowIso)
      });
    });

    (raw.notes || []).forEach(function (n) {
      if (!n || typeof n !== 'object') return;
      const images = Array.isArray(n.images)
        ? n.images.map(normalizeMediaImage).filter(Boolean)
        : [];
      const attachments = Array.isArray(n.attachments)
        ? n.attachments.map(normalizeMediaFile).filter(Boolean)
        : [];
      data.notes.push({
        id: String(n.id || newId('note')),
        categoryId: String(n.categoryId || ''),
        title: String(n.title || '无标题笔记'),
        content: (typeof n.content === 'string') ? n.content : '',
        marked: !!n.marked,
        collapsed: !!n.collapsed,
        images: images,
        attachments: attachments,
        createdAt: String(n.createdAt || nowIso),
        updatedAt: String(n.updatedAt || n.createdAt || nowIso)
      });
    });

    return data;
  }

  /* =====================================================================
   * 7. 数据写入
   * =================================================================== */

  async function commitData(nextData, message) {
    if (!state.token) {
      throw new AppError('当前不是编辑模式，无法写入 GitHub。请先进入编辑模式。', 401);
    }

    let remote = null;
    try {
      remote = await fetchRemoteNotes();
    } catch (err) {
      if (err && err.status === 404) {
        remote = null;
      } else {
        throw err;
      }
    }

    if (remote && state.remoteUpdatedAt && remote.json.updatedAt &&
        remote.json.updatedAt !== state.remoteUpdatedAt) {
      throw new AppError(
        '远端文件已经发生变化，可能有其他设备正在编辑。为避免覆盖最新内容，请重新加载远端数据后再编辑。',
        409
      );
    }

    nextData.version = nextData.version || 1;
    nextData.updatedAt = new Date().toISOString();

    const body = {
      message: message,
      content: utf8ToBase64(JSON.stringify(nextData, null, 2) + '\n'),
      branch: CONFIG.BRANCH || 'main'
    };
    if (remote && remote.sha) {
      body.sha = remote.sha;
    }

    await ghFetch(contentsUrl(CONFIG.NOTES_PATH), {
      method: 'PUT',
      token: state.token,
      body: body
    });

    state.data = nextData;
    state.remoteUpdatedAt = nextData.updatedAt;
  }

  async function putRepoFile(path, base64Content, message) {
    let sha = null;
    try {
      const existing = await ghFetch(
        contentsUrl(path) + '?ref=' + encodeURIComponent(CONFIG.BRANCH || 'main') + '&t=' + Date.now(),
        { token: state.token }
      );
      if (existing && existing.sha) sha = existing.sha;
    } catch (err) {
      if (!err || err.status !== 404) throw err;
    }

    const body = {
      message: message,
      content: base64Content,
      branch: CONFIG.BRANCH || 'main'
    };
    if (sha) body.sha = sha;

    return await ghFetch(contentsUrl(path), {
      method: 'PUT',
      token: state.token,
      body: body
    });
  }

  async function deleteRepoFile(path, message) {
    const info = await ghFetch(
      contentsUrl(path) + '?ref=' + encodeURIComponent(CONFIG.BRANCH || 'main') + '&t=' + Date.now(),
      { token: state.token }
    );
    if (!info || !info.sha) {
      throw new AppError('无法获取文件 sha，删除失败：' + path, 404);
    }
    return await ghFetch(contentsUrl(path), {
      method: 'DELETE',
      token: state.token,
      body: {
        message: message,
        sha: info.sha,
        branch: CONFIG.BRANCH || 'main'
      }
    });
  }

  /* =====================================================================
   * 8. 附件上传
   * =================================================================== */

  function validateImageFile(file) {
    const ext = getExtension(file.name);
    if (DANGEROUS_EXTENSIONS.indexOf(ext) !== -1) {
      return '出于安全考虑，不允许上传 .' + ext + ' 文件。';
    }
    const allowed = (CONFIG.ALLOWED_IMAGE_EXTENSIONS || []).map(function (x) {
      return String(x).toLowerCase();
    });
    if (allowed.indexOf(ext) === -1) {
      return '不支持的图片格式：.' + ext + '（允许：' + allowed.join('、') + '）';
    }
    if (file.type) {
      if (file.type === 'image/svg+xml') {
        return '出于安全考虑，不允许上传 SVG 图片。';
      }
      if (file.type.indexOf('image/') !== 0) {
        return '文件 MIME 类型不是图片：' + file.type;
      }
    }
    if (file.size > (CONFIG.MAX_IMAGE_SIZE || 5 * 1024 * 1024)) {
      return '图片过大：' + formatSize(file.size) + '，超过限制 ' +
        formatSize(CONFIG.MAX_IMAGE_SIZE || 5 * 1024 * 1024);
    }
    return null;
  }

  function validateAttachmentFile(file) {
    const ext = getExtension(file.name);
    if (DANGEROUS_EXTENSIONS.indexOf(ext) !== -1) {
      return '出于安全考虑，不允许上传 .' + ext + ' 文件。';
    }
    const allowed = (CONFIG.ALLOWED_FILE_EXTENSIONS || []).map(function (x) {
      return String(x).toLowerCase();
    });
    if (allowed.indexOf(ext) === -1) {
      return '不支持的附件格式：.' + ext + '（允许：' + allowed.join('、') + '）';
    }
    const mime = String(file.type || '').toLowerCase();
    if (mime && DANGEROUS_MIME.indexOf(mime) !== -1) {
      return '出于安全考虑，不允许上传该类型的文件：' + file.type;
    }
    if (file.size > (CONFIG.MAX_FILE_SIZE || 10 * 1024 * 1024)) {
      return '附件过大：' + formatSize(file.size) + '，超过限制 ' +
        formatSize(CONFIG.MAX_FILE_SIZE || 10 * 1024 * 1024);
    }
    return null;
  }

  async function uploadAttachment(kind, noteId, item) {
    const isImage = kind === 'image';
    const root = isImage ? (CONFIG.IMAGE_ROOT || 'assets/images') : (CONFIG.FILE_ROOT || 'assets/files');
    const safe = safeFileName(item.file.name);
    const storedName = item.id + '-' + safe;
    const path = root + '/' + noteId + '/' + storedName;

    const buffer = await readFileAsArrayBuffer(item.file);
    const base64 = arrayBufferToBase64(buffer);

    const message = (isImage ? '上传图片：' : '上传附件：') + item.file.name;
    const res = await putRepoFile(path, base64, message);

    const sha = (res && res.content && res.content.sha) ? res.content.sha : '';

    const meta = {
      id: item.id,
      originalName: item.file.name,
      storedName: storedName,
      path: path,
      mimeType: item.file.type || guessMimeType(item.file.name),
      size: item.file.size,
      sha: sha,
      createdAt: new Date().toISOString()
    };

    if (isImage) {
      meta.description = String(item.description || '');
    }

    return meta;
  }

  /* =====================================================================
   * 9. 通知与模态窗口
   * =================================================================== */

  function notify(kind, message, timeout) {
    const area = byId('notifyArea');
    if (!area) return null;

    const div = document.createElement('div');
    div.className = 'notify notify-' + kind;

    const span = document.createElement('span');
    span.textContent = String(message);
    div.appendChild(span);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'notify-close';
    close.setAttribute('aria-label', '关闭提示');
    close.textContent = '×';
    close.addEventListener('click', function () {
      if (div.parentNode) div.parentNode.removeChild(div);
    });
    div.appendChild(close);

    area.appendChild(div);

    if (timeout === undefined) timeout = 6000;
    if (timeout > 0) {
      setTimeout(function () {
        if (div.parentNode) div.parentNode.removeChild(div);
      }, timeout);
    }
    return div;
  }

  function showModal(id) {
    const el = byId(id);
    if (el) el.classList.remove('hidden');
  }

  function hideModal(id) {
    const el = byId(id);
    if (el) el.classList.add('hidden');
  }

  let confirmResolver = null;

  function askConfirm(options) {
    options = options || {};
    return new Promise(function (resolve) {
      confirmResolver = resolve;

      const titleEl = byId('confirmTitle');
      const msgEl = byId('confirmMessage');
      const okBtn = byId('confirmOkBtn');

      titleEl.textContent = options.title || '确认操作';
      msgEl.textContent = options.message || '';
      okBtn.textContent = options.confirmText || '确认';
      okBtn.classList.toggle('btn-danger', options.danger !== false);
      okBtn.classList.toggle('btn-primary', options.danger === false);

      showModal('confirmModal');
      okBtn.focus();
    });
  }

  function resolveConfirm(value) {
    hideModal('confirmModal');
    const r = confirmResolver;
    confirmResolver = null;
    if (r) r(value);
  }

  /* =====================================================================
   * 10. 排序与筛选
   * =================================================================== */

  function getSortedCategories() {
    if (!state.data) return [];
    const list = state.data.categories.slice();
    list.sort(function (a, b) {
      const ma = a.marked ? 1 : 0;
      const mb = b.marked ? 1 : 0;
      if (ma !== mb) return mb - ma;
      const ta = new Date(a.updatedAt || 0).getTime() || 0;
      const tb = new Date(b.updatedAt || 0).getTime() || 0;
      return tb - ta;
    });
    return list;
  }

  function getSortedNotes(categoryId) {
    if (!state.data) return [];
    const list = state.data.notes.filter(function (n) {
      return n.categoryId === categoryId;
    });
    list.sort(function (a, b) {
      const ma = a.marked ? 1 : 0;
      const mb = b.marked ? 1 : 0;
      if (ma !== mb) return mb - ma;
      const ta = new Date(a.updatedAt || 0).getTime() || 0;
      const tb = new Date(b.updatedAt || 0).getTime() || 0;
      return tb - ta;
    });
    return list;
  }

  function categoryMatches(cat, keyword) {
    if (!keyword) return false;
    return String(cat.name || '').toLowerCase().indexOf(keyword) !== -1;
  }

  function noteMatches(note, keyword) {
    if (!keyword) return false;
    if (String(note.title || '').toLowerCase().indexOf(keyword) !== -1) return true;
    if (String(note.content || '').toLowerCase().indexOf(keyword) !== -1) return true;

    const images = note.images || [];
    for (let i = 0; i < images.length; i++) {
      if (String(images[i].originalName || '').toLowerCase().indexOf(keyword) !== -1) return true;
      if (String(images[i].description || '').toLowerCase().indexOf(keyword) !== -1) return true;
      if (String(images[i].storedName || '').toLowerCase().indexOf(keyword) !== -1) return true;
    }

    const files = note.attachments || [];
    for (let j = 0; j < files.length; j++) {
      if (String(files[j].originalName || '').toLowerCase().indexOf(keyword) !== -1) return true;
      if (String(files[j].storedName || '').toLowerCase().indexOf(keyword) !== -1) return true;
    }

    return false;
  }

  function getVisibleGroups() {
    const keyword = String(state.searchKeyword || '').trim().toLowerCase();
    const groups = [];

    getSortedCategories().forEach(function (cat) {
      const notes = getSortedNotes(cat.id);
      let visible;

      if (!keyword) {
        visible = notes;
      } else if (categoryMatches(cat, keyword)) {
        visible = notes;
      } else {
        visible = notes.filter(function (n) {
          return noteMatches(n, keyword);
        });
      }

      if (keyword && visible.length === 0) return;

      groups.push({ category: cat, notes: visible });
    });

    return groups;
  }

  function isCategoryCollapsed(cat) {
    if (Object.prototype.hasOwnProperty.call(state.collapsedCategories, cat.id)) {
      return !!state.collapsedCategories[cat.id];
    }
    return !!cat.collapsed;
  }

  function isNoteCollapsed(note) {
    if (Object.prototype.hasOwnProperty.call(state.collapsedNotes, note.id)) {
      return !!state.collapsedNotes[note.id];
    }
    return !!note.collapsed;
  }

  /* =====================================================================
   * 11. 安全高亮
   * =================================================================== */

  function setHighlightedText(el, text, keyword) {
    el.textContent = '';
    const source = String(text === undefined || text === null ? '' : text);
    const kw = String(keyword || '');

    if (!kw) {
      el.appendChild(document.createTextNode(source));
      return;
    }

    const lowerSource = source.toLowerCase();
    const lowerKw = kw.toLowerCase();

    if (lowerKw.length === 0) {
      el.appendChild(document.createTextNode(source));
      return;
    }

    let index = 0;
    let pos = lowerSource.indexOf(lowerKw, index);
    let guard = 0;

    while (pos !== -1 && guard < 2000) {
      guard++;
      if (pos > index) {
        el.appendChild(document.createTextNode(source.slice(index, pos)));
      }
      const mark = document.createElement('mark');
      mark.className = 'hl';
      mark.textContent = source.slice(pos, pos + lowerKw.length);
      el.appendChild(mark);
      index = pos + lowerKw.length;
      pos = lowerSource.indexOf(lowerKw, index);
    }

    if (index < source.length) {
      el.appendChild(document.createTextNode(source.slice(index)));
    }
  }

  /* =====================================================================
   * 12. 渲染
   * =================================================================== */

  function makeButton(text, className, onClick, ariaLabel) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ' + className;
    b.textContent = text;
    if (ariaLabel) {
      b.setAttribute('aria-label', ariaLabel);
      b.title = ariaLabel;
    } else {
      b.title = text;
    }
    b.addEventListener('click', onClick);
    return b;
  }

  function hideAllViews() {
    ['dashboardView', 'noteView', 'pomodoroView', 'timerView'].forEach(function (id) {
      const el = byId(id);
      if (el) el.classList.add('hidden');
    });
  }

  function render() {
    renderSidebar();
    renderSidebarActive();
    hideAllViews();
    if (state.currentView === 'dashboard') {
      renderDashboard();
    } else if (state.currentView === 'note') {
      renderNoteView(state.currentNoteId);
    } else if (state.currentView === 'pomodoro') {
      const v = byId('pomodoroView');
      if (v) v.classList.remove('hidden');
      updatePomodoroDisplay();
    } else if (state.currentView === 'timer') {
      const v = byId('timerView');
      if (v) v.classList.remove('hidden');
      updateTimerDisplay();
    }
    renderStats();
    renderCategorySelects();
  }

  function renderSidebarActive() {
    const map = { dashboard: 'sideToolDashboard', pomodoro: 'sideToolPomodoro', timer: 'sideToolTimer' };
    ['sideToolDashboard', 'sideToolPomodoro', 'sideToolTimer'].forEach(function (id) {
      const el = byId(id);
      if (el) el.classList.remove('active');
    });
    if (map[state.currentView]) {
      const el = byId(map[state.currentView]);
      if (el) el.classList.add('active');
    }
  }

  /* ============ 时钟：每秒从系统时间读取一次 ============ */
  function updateClock() {
    const now = new Date();
    const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const timeEl = byId('currentTime');
    const dateEl = byId('currentDate');
    if (timeEl) {
      timeEl.textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    }
    if (dateEl) {
      dateEl.textContent = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 ' + days[now.getDay()];
    }
  }

  /* ============ 番茄钟 ============ */
  function updatePomodoroDisplay() {
    const el = byId('pomodoroDisplay');
    if (el) {
      const m = String(Math.floor(toolState.pomodoroTime / 60)).padStart(2, '0');
      const s = String(toolState.pomodoroTime % 60).padStart(2, '0');
      el.textContent = m + ':' + s;
    }
    const cEl = byId('pomodoroCount');
    if (cEl) cEl.textContent = String(toolState.pomodoroCount);
  }

  function startPomodoro() {
    if (toolState.pomodoroTimer) return;
    if (toolState.pomodoroTime <= 0) toolState.pomodoroTime = toolState.pomodoroTotal;
    toolState.pomodoroTimer = setInterval(function () {
      toolState.pomodoroTime--;
      updatePomodoroDisplay();
      if (toolState.pomodoroTime <= 0) {
        clearInterval(toolState.pomodoroTimer);
        toolState.pomodoroTimer = null;
        toolState.pomodoroCount++;
        try { localStorage.setItem('pomodoroCount', String(toolState.pomodoroCount)); } catch (e) {}
        toolState.pomodoroTime = toolState.pomodoroTotal;
        updatePomodoroDisplay();
        notify('success', '🍅 番茄钟时间到！休息一下吧。', 10000);
      }
    }, 1000);
  }

  function pausePomodoro() {
    if (toolState.pomodoroTimer) {
      clearInterval(toolState.pomodoroTimer);
      toolState.pomodoroTimer = null;
    }
  }

  function resetPomodoro() {
    pausePomodoro();
    toolState.pomodoroTime = toolState.pomodoroTotal;
    updatePomodoroDisplay();
  }

  /* ============ 定时提醒（倒计时） ============ */
  function updateTimerDisplay() {
    const el = byId('timerDisplay');
    if (!el) return;
    const m = String(Math.floor(toolState.timerRemaining / 60)).padStart(2, '0');
    const s = String(toolState.timerRemaining % 60).padStart(2, '0');
    el.textContent = m + ':' + s;
  }

  function startTimer() {
    if (toolState.timerInterval) return;
    if (toolState.timerRemaining <= 0) {
      const minsInput = byId('timerMinutes');
      const mins = parseInt((minsInput && minsInput.value) || '5', 10) || 5;
      toolState.timerRemaining = mins * 60;
    }
    toolState.timerInterval = setInterval(function () {
      toolState.timerRemaining--;
      updateTimerDisplay();
      if (toolState.timerRemaining <= 0) {
        clearInterval(toolState.timerInterval);
        toolState.timerInterval = null;
        toolState.timerRemaining = 0;
        updateTimerDisplay();
        notify('warn', '⏰ 定时提醒时间到！', 15000);
      }
    }, 1000);
  }

  function pauseTimer() {
    if (toolState.timerInterval) {
      clearInterval(toolState.timerInterval);
      toolState.timerInterval = null;
    }
  }

  function resetTimer() {
    pauseTimer();
    toolState.timerRemaining = 0;
    updateTimerDisplay();
  }

  function renderDashboard() {
    byId('dashboardView').classList.remove('hidden');

    const hour = new Date().getHours();
    let greeting = '早上好';
    if (hour >= 12 && hour < 18) greeting = '下午好';
    else if (hour >= 18) greeting = '晚上好';
    byId('greetingText').textContent = greeting + '，欢迎回来';

    if (state.data) {
      byId('statTotalNotes').textContent = state.data.notes.length;
      byId('statMarkedNotes').textContent = state.data.notes.filter(n => n.marked).length;
      byId('statTotalCategories').textContent = state.data.categories.length;
    }

    renderQuickLinks();
  }

  function renderQuickLinks() {
    const grid = byId('quickLinksGrid');
    if (!grid) return;
    grid.textContent = '';

    const links = CONFIG.QUICK_LINKS || [];
    if (links.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = '暂无常用链接。可在 config.js 中修改 QUICK_LINKS 来添加。';
      grid.appendChild(p);
      return;
    }

    links.forEach(function (link) {
      const a = document.createElement('a');
      a.className = 'quick-link-card';
      a.href = link.url || '#';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      const icon = document.createElement('div');
      icon.className = 'quick-link-icon';
      icon.textContent = link.icon || '🔗';
      a.appendChild(icon);
      const name = document.createElement('div');
      name.className = 'quick-link-name';
      name.textContent = link.name || link.url || '未命名';
      a.appendChild(name);
      grid.appendChild(a);
    });
  }

  function renderNoteView(noteId) {
    byId('dashboardView').classList.add('hidden');
    byId('noteView').classList.remove('hidden');
    const note = state.data.notes.find(n => n.id === noteId);
    if (!note) {
      byId('noteViewTitle').textContent = '笔记不存在';
      byId('noteViewContent').textContent = '该笔记可能已被删除，请返回工作台重新加载。';
      return;
    }
    const cat = state.data.categories.find(c => c.id === note.categoryId);
    byId('noteViewTitle').textContent = note.title;
    byId('noteViewMeta').textContent = '所属目录：' + (cat ? cat.name : '未知') + ' · 创建：' + formatTime(note.createdAt) + ' · 最后修改：' + formatTime(note.updatedAt) + (note.marked ? ' · ⭐ 重点笔记' : '');
    byId('noteViewContent').textContent = note.content || '（无正文）';
    const gallery = byId('noteViewGallery');
    gallery.textContent = '';
    if (note.images && note.images.length) {
      note.images.forEach(img => {
        const fig = document.createElement('figure'); fig.className = 'note-figure';
        const a = document.createElement('a'); a.href = assetUrl(img.path); a.target = '_blank'; a.rel = 'noopener noreferrer';
        const im = document.createElement('img'); im.src = assetUrl(img.path); im.alt = img.description || img.originalName;
        a.appendChild(im); fig.appendChild(a);
        const cap = document.createElement('figcaption'); cap.textContent = img.description || img.originalName;
        fig.appendChild(cap); gallery.appendChild(fig);
      });
    }
    const atts = byId('noteViewAttachments');
    atts.textContent = '';
    if (note.attachments && note.attachments.length) {
      note.attachments.forEach(f => {
        const li = document.createElement('li');
        const a = document.createElement('a'); a.href = assetUrl(f.path); a.download = f.originalName; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = '📎 ' + f.originalName;
        li.appendChild(a);
        const size = document.createElement('span'); size.className = 'file-info'; size.textContent = '（' + formatSize(f.size) + '）';
        li.appendChild(size); atts.appendChild(li);
      });
    }
    const markBtn = byId('btnToggleMarkCurrentNote');
    if (markBtn) markBtn.textContent = note.marked ? '取消重点' : '设为重点';
  }

  function renderStats() {
    const keyword = String(state.searchKeyword || '').trim();
    const groups = getVisibleGroups();

    let total = 0;
    groups.forEach(function (g) { total += g.notes.length; });

    const statusEl = byId('searchStatus');
    if (keyword) {
      if (total === 0) {
        statusEl.textContent = '未找到匹配的笔记（关键词：' + keyword + '）';
      } else {
        statusEl.textContent = '搜索结果：' + total + ' 篇笔记（关键词：' + keyword + '）';
      }
    } else {
      let all = 0;
      if (state.data) all = state.data.notes.length;
      statusEl.textContent = '共 ' + all + ' 篇笔记';
    }

    const updEl = byId('dataUpdatedAt');
    if (state.data && state.data.updatedAt) {
      updEl.textContent = '数据最后更新时间：' + formatTime(state.data.updatedAt);
    } else {
      updEl.textContent = '数据最后更新时间：未知';
    }

    const badge = byId('modeBadge');
    if (state.editing) {
      badge.textContent = '编辑模式';
      badge.className = 'mode-badge mode-edit';
    } else {
      badge.textContent = '只读模式';
      badge.className = 'mode-badge mode-readonly';
    }

    document.body.classList.toggle('edit-mode', !!state.editing);
  }

  function renderSidebar() {
    const container = byId('categoryNav');
    container.textContent = '';
    if (!state.data) { container.innerHTML = '<p class="empty-hint">加载中...</p>'; return; }
    const keyword = String(state.searchKeyword || '').trim().toLowerCase();
    const groups = getVisibleGroups();
    if (groups.length === 0) {
      container.innerHTML = '<p class="empty-hint">' + (keyword ? '未找到匹配的笔记' : '暂无目录') + '</p>';
      return;
    }
    groups.forEach(group => {
      const cat = group.category;
      const collapsed = isCategoryCollapsed(cat);
      const item = document.createElement('div'); item.className = 'cat-nav-item';
      const head = document.createElement('div'); head.className = 'cat-nav-head';
      head.addEventListener('click', () => { state.collapsedCategories[cat.id] = !isCategoryCollapsed(cat); renderSidebar(); });
      const toggle = document.createElement('span'); toggle.textContent = collapsed ? '▶' : '▼'; toggle.style.fontSize = '0.7rem'; toggle.style.width = '12px';
      head.appendChild(toggle);
      const nameEl = document.createElement('span'); nameEl.className = 'cat-nav-name'; setHighlightedText(nameEl, cat.name, keyword);
      head.appendChild(nameEl);
      const countEl = document.createElement('span'); countEl.className = 'cat-nav-count'; countEl.textContent = group.notes.length;
      head.appendChild(countEl);
      item.appendChild(head);
      if (!collapsed) {
        const ul = document.createElement('ul'); ul.className = 'cat-nav-notes';
        group.notes.forEach(note => {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.className = 'cat-nav-link' + (state.currentView === 'note' && state.currentNoteId === note.id ? ' active' : '');
          a.href = '#';
          setHighlightedText(a, note.title, keyword);
          if (note.marked) a.textContent += ' ⭐';
          a.addEventListener('click', (e) => {
            e.preventDefault();
            state.currentView = 'note'; state.currentNoteId = note.id; render();
          });
          li.appendChild(a); ul.appendChild(li);
        });
        item.appendChild(ul);
      }
      container.appendChild(item);
    });
  }

    const keyword = String(state.searchKeyword || '').trim();
    const groups = getVisibleGroups();

    if (groups.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = keyword ? '未找到匹配的笔记' : '还没有任何目录，请进入编辑模式后新增目录。';
      container.appendChild(p);
      return;
    }

    groups.forEach(function (group) {
      const cat = group.category;
      const collapsed = isCategoryCollapsed(cat);

      const item = document.createElement('div');
      item.className = 'cat-nav-item' + (cat.marked ? ' marked' : '');

      const head = document.createElement('div');
      head.className = 'cat-nav-head';

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'toggle-btn';
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.setAttribute('aria-label', (collapsed ? '展开目录 ' : '折叠目录 ') + cat.name);
      toggle.title = collapsed ? '展开目录' : '折叠目录';
      toggle.textContent = collapsed ? '▶' : '▼';
      toggle.addEventListener('click', function () {
        state.collapsedCategories[cat.id] = !isCategoryCollapsed(cat);
        render();
      });
      head.appendChild(toggle);

      const nameEl = document.createElement('span');
      nameEl.className = 'cat-nav-name';
      setHighlightedText(nameEl, cat.name, keyword);
      head.appendChild(nameEl);

      const countEl = document.createElement('span');
      countEl.className = 'cat-nav-count';
      countEl.textContent = '（' + group.notes.length + ' 篇）';
      head.appendChild(countEl);

      if (cat.marked) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-marked';
        badge.textContent = '重点';
        head.appendChild(badge);
      }

      const actions = document.createElement('div');
      actions.className = 'cat-nav-actions edit-only';

      actions.appendChild(makeButton('编辑', 'btn-small btn-edit', function () {
        editCategory(cat.id);
      }, '编辑目录 ' + cat.name));

      actions.appendChild(makeButton(cat.marked ? '取消重点' : '设为重点', 'btn-small btn-mark', function () {
        toggleCategoryMarked(cat.id);
      }, (cat.marked ? '取消重点目录 ' : '设为重点目录 ') + cat.name));

      actions.appendChild(makeButton('删除', 'btn-small btn-danger', function () {
        deleteCategory(cat.id);
      }, '删除目录 ' + cat.name));

      head.appendChild(actions);

      item.appendChild(head);

      if (!collapsed) {
        const ul = document.createElement('ul');
        ul.className = 'cat-nav-notes';

        if (group.notes.length === 0) {
          const li = document.createElement('li');
          li.className = 'empty-hint';
          li.textContent = '该目录下暂无笔记';
          ul.appendChild(li);
        } else {
          group.notes.forEach(function (note) {
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.className = 'cat-nav-link';
            a.href = '#note-' + note.id;
            setHighlightedText(a, note.title, keyword);
            if (note.marked) {
              a.textContent = a.textContent + ' ★';
            }
            a.addEventListener('click', function (ev) {
              ev.preventDefault();
              scrollToNote(note.id);
            });
            li.appendChild(a);
            ul.appendChild(li);
          });
        }

        item.appendChild(ul);
      }

      container.appendChild(item);
    });
  }

  function buildNoteCard(note, category, keyword) {
    const card = document.createElement('article');
    card.className = 'note-card' + (note.marked ? ' marked' : '');
    card.id = 'note-' + note.id;

    const collapsed = isNoteCollapsed(note);

    const head = document.createElement('div');
    head.className = 'note-head';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'toggle-btn note-toggle';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', (collapsed ? '展开笔记 ' : '折叠笔记 ') + note.title);
    toggle.title = collapsed ? '展开笔记' : '折叠笔记';
    toggle.textContent = collapsed ? '▶' : '▼';
    toggle.addEventListener('click', function () {
      const bodyWrap = card.querySelector('.note-body-wrap');
      const nowCollapsed = !bodyWrap.hidden;
      state.collapsedNotes[note.id] = nowCollapsed;
      bodyWrap.hidden = nowCollapsed;
      toggle.textContent = nowCollapsed ? '▶' : '▼';
      toggle.setAttribute('aria-expanded', String(!nowCollapsed));
      toggle.setAttribute('aria-label', (nowCollapsed ? '展开笔记 ' : '折叠笔记 ') + note.title);
      toggle.title = nowCollapsed ? '展开笔记' : '折叠笔记';
    });
    head.appendChild(toggle);

    const titleWrap = document.createElement('div');
    titleWrap.className = 'note-title-wrap';

    const h3 = document.createElement('h3');
    h3.className = 'note-title';
    setHighlightedText(h3, note.title, keyword);
    titleWrap.appendChild(h3);

    if (note.marked) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-marked';
      badge.textContent = '重点';
      titleWrap.appendChild(badge);
    }

    head.appendChild(titleWrap);

    const actions = document.createElement('div');
    actions.className = 'note-actions edit-only';

    actions.appendChild(makeButton('编辑', 'btn-small btn-edit', function () {
      openEditNote(note.id);
    }, '编辑笔记 ' + note.title));

    actions.appendChild(makeButton(note.marked ? '取消重点' : '设为重点', 'btn-small btn-mark', function () {
      toggleNoteMarked(note.id);
    }, (note.marked ? '取消重点笔记 ' : '设为重点笔记 ') + note.title));

    actions.appendChild(makeButton('删除', 'btn-small btn-danger', function () {
      deleteNote(note.id);
    }, '删除笔记 ' + note.title));

    head.appendChild(actions);

    card.appendChild(head);

    const meta = document.createElement('p');
    meta.className = 'note-meta';
    meta.textContent = '所属目录：' + category.name +
      ' · 创建：' + formatTime(note.createdAt) +
      ' · 最后修改：' + formatTime(note.updatedAt);
    card.appendChild(meta);

    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'note-body-wrap';
    bodyWrap.hidden = collapsed;

    const bodyEl = document.createElement('p');
    bodyEl.className = 'note-body';
    if (!note.content) {
      bodyEl.classList.add('empty');
      bodyEl.textContent = '（无正文）';
    } else {
      setHighlightedText(bodyEl, note.content, keyword);
    }
    bodyWrap.appendChild(bodyEl);

    if (note.images && note.images.length) {
      const gallery = document.createElement('div');
      gallery.className = 'note-gallery';

      note.images.forEach(function (img) {
        const fig = document.createElement('figure');
        fig.className = 'note-figure';

        const link = document.createElement('a');
        link.href = assetUrl(img.path);
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = '查看图片原图';

        const im = document.createElement('img');
        im.src = assetUrl(img.path);
        im.alt = img.description || img.originalName || '笔记图片';
        im.loading = 'lazy';
        im.addEventListener('error', function () {
          im.classList.add('img-error');
          im.alt = '图片加载失败：' + (img.originalName || img.path);
        });

        link.appendChild(im);
        fig.appendChild(link);

        const cap = document.createElement('figcaption');
        if (keyword && (img.description || img.originalName)) {
          const label = (img.description || img.originalName) + '（' + formatSize(img.size) + '）';
          setHighlightedText(cap, label, keyword);
        } else {
          cap.textContent = (img.description || img.originalName || '未命名图片') +
            '（' + formatSize(img.size) + '）';
        }
        fig.appendChild(cap);

        gallery.appendChild(fig);
      });

      bodyWrap.appendChild(gallery);
    }

    if (note.attachments && note.attachments.length) {
      const ul = document.createElement('ul');
      ul.className = 'note-attachments';

      note.attachments.forEach(function (f) {
        const li = document.createElement('li');

        const a = document.createElement('a');
        a.href = assetUrl(f.path);
        a.download = f.originalName || f.storedName || '附件';
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = '下载附件 ' + (f.originalName || '');
        if (keyword && f.originalName) {
          setHighlightedText(a, f.originalName, keyword);
        } else {
          a.textContent = f.originalName || f.storedName || '未命名附件';
        }

        li.appendChild(a);

        const info = document.createElement('span');
        info.className = 'file-info';
        info.textContent = '（' + formatSize(f.size) + '）';
        li.appendChild(info);

        ul.appendChild(li);
      });

      bodyWrap.appendChild(ul);
    }

    card.appendChild(bodyWrap);

    return card;
  }

  function renderNotes() {
    const container = byId('notesContainer');
    container.textContent = '';

    if (!state.data) {
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = '正在读取数据…';
      container.appendChild(p);
      return;
    }

    const keyword = String(state.searchKeyword || '').trim();
    const groups = getVisibleGroups();

    if (groups.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = keyword ? '未找到匹配的笔记' : '还没有任何笔记。';
      container.appendChild(p);
      return;
    }

    groups.forEach(function (group) {
      const block = document.createElement('section');
      block.className = 'cat-block' + (group.category.marked ? ' marked' : '');

      const h3 = document.createElement('h3');
      h3.className = 'cat-block-title';
      setHighlightedText(h3, group.category.name, keyword);

      const countSpan = document.createElement('span');
      countSpan.className = 'cat-nav-count';
      countSpan.textContent = ' （' + group.notes.length + ' 篇）';
      h3.appendChild(countSpan);

      block.appendChild(h3);

      if (group.notes.length === 0) {
        const p = document.createElement('p');
        p.className = 'empty-hint';
        p.textContent = '该目录下暂无笔记';
        block.appendChild(p);
      } else {
        group.notes.forEach(function (note) {
          block.appendChild(buildNoteCard(note, group.category, keyword));
        });
      }

      container.appendChild(block);
    });
  }

  function renderCategorySelects() {
    if (!state.data) return;

    const newSel = byId('newNoteCategory');
    if (newSel) {
      const prev = newSel.value;
      fillCategorySelect(newSel, prev);
    }

    const editSel = byId('editNoteCategory');
    if (editSel) {
      const prev = editSel.value;
      fillCategorySelect(editSel, prev);
    }
  }

  function fillCategorySelect(select, selectedId) {
    select.textContent = '';
    const cats = getSortedCategories();

    if (cats.length === 0) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '（暂无目录，请先新增目录）';
      select.appendChild(o);
      return;
    }

    cats.forEach(function (c) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name + (c.marked ? '（重点）' : '');
      if (c.id === selectedId) o.selected = true;
      select.appendChild(o);
    });
  }

  function scrollToNote(noteId) {
    const card = byId('note-' + noteId);
    if (!card) return;

    const bodyWrap = card.querySelector('.note-body-wrap');
    const toggle = card.querySelector('.note-toggle');

    if (bodyWrap && bodyWrap.hidden) {
      bodyWrap.hidden = false;
      state.collapsedNotes[noteId] = false;
      if (toggle) {
        toggle.textContent = '▼';
        toggle.setAttribute('aria-expanded', 'true');
      }
    }

    try {
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      card.scrollIntoView();
    }

    card.classList.add('flash');
    setTimeout(function () {
      card.classList.remove('flash');
    }, 1500);
  }

  /* =====================================================================
   * 13. 数据加载
   * =================================================================== */

  async function loadRemoteData(options) {
    options = options || {};
    if (state.busy) return;

    state.busy = true;
    const tip = options.silent ? null : notify('info', '正在读取远端数据…', 0);

    try {
      const result = await fetchRemoteNotes();
      state.data = result.json;
      state.remoteUpdatedAt = result.json.updatedAt;
      state.collapsedCategories = Object.create(null);
      state.collapsedNotes = Object.create(null);

      render();

      if (tip) tip.remove();
      if (!options.silent) {
        notify('success', '远端数据已加载。', 4000);
      }
    } catch (err) {
      if (tip) tip.remove();
      render();
      notify('error', (err && err.message) ? err.message : '读取远端数据失败。', 12000);
    } finally {
      state.busy = false;
    }
  }

  /* =====================================================================
   * 14. 编辑模式
   * =================================================================== */

  async function verifyTokenAndRepo(token) {
    if (!CONFIG.OWNER || !CONFIG.REPO) {
      throw new AppError('config.js 中的 OWNER 或 REPO 未正确填写。', 0);
    }

    const repoInfo = await ghFetch(apiBase(), { token: token });
    if (!repoInfo || !repoInfo.full_name) {
      throw new AppError('无法访问该仓库，请检查用户名、仓库名称和 Token 权限。', 404);
    }

    try {
      await fetchRemoteNotes(token);
    } catch (err) {
      if (err && err.status === 404) {
        throw new AppError(
          '可以访问仓库，但读取 ' + CONFIG.NOTES_PATH +
          ' 失败。请确认该文件已创建、分支名称正确、Token 具有 Contents 读取权限。',
          404
        );
      }
      throw err;
    }

    return true;
  }

  async function confirmEnterEditMode() {
    const input = byId('tokenInput');
    const errEl = byId('tokenError');
    const btn = byId('btnTokenConfirm');

    const token = String(input.value || '').trim();

    errEl.classList.add('hidden');
    errEl.textContent = '';

    if (!token) {
      errEl.textContent = '请输入 GitHub Personal Access Token。';
      errEl.classList.remove('hidden');
      input.focus();
      return;
    }

    btn.disabled = true;
    btn.textContent = '正在验证…';

    try {
      await verifyTokenAndRepo(token);
      state.token = token;
      state.editing = true;

      try {
        sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      } catch (e) { /* 某些浏览器隐私模式可能禁止 sessionStorage */ }

      input.value = '';
      hideModal('tokenModal');
      render();
      notify('success', '已进入编辑模式。Token 只保存在本标签页，关闭标签页后自动失效。', 8000);
      await loadRemoteData({ silent: true });
    } catch (err) {
      errEl.textContent = (err && err.message) ? err.message : 'Token 验证失败。';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = '进入编辑模式';
    }
  }

  function exitEditMode() {
    state.token = null;
    state.editing = false;

    try {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch (e) { /* 忽略 */ }

    const input = byId('tokenInput');
    if (input) input.value = '';

    editNoteCtx.noteId = null;
    editNoteCtx.images = [];
    editNoteCtx.files = [];
    editNoteCtx.removedImages = [];
    editNoteCtx.removedFiles = [];

    newNoteCtx.images = [];
    newNoteCtx.files = [];

    hideModal('editNoteModal');
    hideModal('tokenModal');

    render();
    notify('info', '已退出编辑模式，Token 已从当前页面清除。', 5000);
  }

  /* =====================================================================
   * 15. 目录操作
   * =================================================================== */

  async function addCategory() {
    if (!state.editing) {
      notify('warn', '当前为只读模式，如需编辑请进入编辑模式。', 5000);
      return;
    }

    const input = byId('newCategoryName');
    const name = String(input.value || '').trim();

    if (!name) {
      notify('error', '目录名称不能为空。', 5000);
      input.focus();
      return;
    }

    const exists = state.data.categories.some(function (c) {
      return c.name === name;
    });
    if (exists) {
      notify('error', '已存在同名目录，请使用其他名称。', 5000);
      input.focus();
      return;
    }

    const nowIso = new Date().toISOString();
    const next = deepClone(state.data);
    next.categories.push({
      id: newId('category'),
      name: name,
      marked: false,
      collapsed: false,
      createdAt: nowIso,
      updatedAt: nowIso
    });

    const tip = notify('info', '正在保存…', 0);
    try {
      await commitData(next, '新增目录：' + name);
      input.value = '';
      tip.remove();
      notify('success', '已保存到 GitHub。', 5000);
      render();
    } catch (err) {
      tip.remove();
      notify('error', (err && err.message) ? err.message : '保存失败。', 12000);
    }
  }

  async function editCategory(categoryId) {
    if (!state.editing) return;

    const cat = state.data.categories.find(function (c) { return c.id === categoryId; });
    if (!cat) return;

    const input = window.prompt('请输入新的目录名称：', cat.name);
    if (input === null) return;

    const name = String(input).trim();
    if (!name) {
      notify('error', '目录名称不能为空。', 5000);
      return;
    }

    const dup = state.data.categories.some(function (c) {
      return c.id !== categoryId && c.name === name;
    });
    if (dup) {
      notify('error', '已存在同名目录，请使用其他名称。', 5000);
      return;
    }

    const next = deepClone(state.data);
    const target = next.categories.find(function (c) { return c.id === categoryId; });
    target.name = name;
    target.updatedAt = new Date().toISOString();

    const tip = notify('info', '正在保存…', 0);
    try {
      await commitData(next, '编辑目录：' + name);
      tip.remove();
      notify('success', '已保存到 GitHub。', 5000);
      render();
    } catch (err) {
      tip.remove();
      notify('error', (err && err.message) ? err.message : '保存失败。', 12000);
    }
  }

  async function toggleCategoryMarked(categoryId) {
    if (!state.editing) return;

    const next = deepClone(state.data);
    const cat = next.categories.find(function (c) { return c.id === categoryId; });
    if (!cat) return;

    cat.marked = !cat.marked;
    cat.updatedAt = new Date().toISOString();

    const tip = notify('info', '正在保存…', 0);
    try {
      await commitData(next, (cat.marked ? '设为重点目录：' : '取消重点目录：') + cat.name);
      tip.remove();
      notify('success', '已保存到 GitHub。', 5000);
      render();
    } catch (err) {
      tip.remove();
      notify('error', (err && err.message) ? err.message : '保存失败。', 12000);
    }
  }

  async function deleteCategory(categoryId) {
    if (!state.editing) return;

    const cat = state.data.categories.find(function (c) { return c.id === categoryId; });
    if (!cat) return;

    const notesInCat = state.data.notes.filter(function (n) { return n.categoryId === categoryId; });
    const count = notesInCat.length;

    let message = '确认删除目录「' + cat.name + '」吗？';
    if (count > 0) {
      message += '\n\n该目录下包含 ' + count + ' 篇笔记。' +
        '确认删除将同时删除这 ' + count + ' 篇笔记及其图片和附件（仓库中的实际文件也会被删除）。';
    }

    const ok = await askConfirm({
      title: count > 0 ? '删除目录及其全部笔记' : '删除目录',
      message: message,
      confirmText: count > 0 ? '同时删除目录和全部笔记' : '确认删除',
      danger: true
    });

    if (!ok) return;

    const tip = notify('info', '正在删除，请稍候…', 0);
    const warnings = [];

    try {
      for (let i = 0; i < notesInCat.length; i++) {
        const note = notesInCat[i];
        await deleteNoteMedia(note, warnings);
      }

      const next = deepClone(state.data);
      next.categories = next.categories.filter(function (c) { return c.id !== categoryId; });
      next.notes = next.notes.filter(function (n) { return n.categoryId !== categoryId; });

      await commitData(next, '删除目录：' + cat.name);

      tip.remove();
      notify('success',
        '已保存到 GitHub。' + (warnings.length ? '（部分文件删除存在问题：' + warnings.join('；') + '）' : ''),
        12000);
      render();
    } catch (err) {
      tip.remove();
      notify('error', (err && err.message) ? err.message : '删除失败。', 12000);
    }
  }

  /* =====================================================================
   * 16. 笔记操作
   * =================================================================== */

  async function toggleNoteMarked(noteId) {
    if (!state.editing) return;

    const next = deepClone(state.data);
    const note = next.notes.find(function (n) { return n.id === noteId; });
    if (!note) return;

    note.marked = !note.marked;
    note.updatedAt = new Date().toISOString();

    const tip = notify('info', '正在保存…', 0);
    try {
      await commitData(next, (note.marked ? '设为重点笔记：' : '取消重点笔记：') + note.title);
      tip.remove();
      notify('success', '已保存到 GitHub。', 5000);
      render();
    } catch (err) {
      tip.remove();
      notify('error', (err && err.message) ? err.message : '保存失败。', 12000);
    }
  }

  async function deleteNoteMedia(note, warnings) {
    const images = note.images || [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (!img.path) continue;
      try {
        await deleteRepoFile(img.path, '删除图片：' + (img.originalName || img.storedName || ''));
      } catch (err) {
        if (err && err.status === 404) {
          warnings.push('图片在仓库中已不存在：' + img.path);
        } else {
          warnings.push('图片删除失败：' + img.path + '（' + ((err && err.message) || '') + '）');
        }
      }
    }

    const files = note.attachments || [];
    for (let j = 0; j < files.length; j++) {
      const f = files[j];
      if (!f.path) continue;
      try {
        await deleteRepoFile(f.path, '删除附件：' + (f.originalName || f.storedName || ''));
      } catch (err) {
        if (err && err.status === 404) {
          warnings.push('附件在仓库中已不存在：' + f.path);
        } else {
          warnings.push('附件删除失败：' + f.path + '（' + ((err && err.message) || '') + '）');
        }
      }
    }
  }

  async function deleteNote(noteId) {
    if (!state.editing) return;

    const note = state.data.notes.find(function (n) { return n.id === noteId; });
    if (!note) return;

    const imgCount = (note.images || []).length;
    const fileCount = (note.attachments || []).length;

    let message = '确认删除笔记「' + note.title + '」吗？';
    if (imgCount > 0 || fileCount > 0) {
      message += '\n\n该笔记包含 ' + imgCount + ' 张图片和 ' + fileCount +
        ' 个附件，它们会同时从仓库中删除。';
    }

    const ok = await askConfirm({
      title: '删除笔记',
      message: message,
      confirmText: '确认删除',
      danger: true
    });
    if (!ok) return;

    const tip = notify('info', '正在删除，请稍候…', 0);
    const warnings = [];

    try {
      await deleteNoteMedia(note, warnings);

      const next = deepClone(state.data);
      next.notes = next.notes.filter(function (n) { return n.id !== noteId; });

      await commitData(next, '删除笔记：' + note.title);

      tip.remove();
      notify('success',
        '已保存到 GitHub。' + (warnings.length ? '（部分文件删除存在问题：' + warnings.join('；') + '）' : ''),
        12000);
      render();
    } catch (err) {
      tip.remove();
      notify('error', (err && err.message) ? err.message : '删除失败。', 12000);
    }
  }

  /* =====================================================================
   * 17. 新增笔记表单
   * =================================================================== */

  function handleNewNoteImageSelect(files) {
    const problems = [];
    Array.prototype.forEach.call(files, function (file) {
      const err = validateImageFile(file);
      if (err) {
        problems.push(file.name + '：' + err);
        return;
      }
      const previewUrl = URL.createObjectURL(file);
      newNoteCtx.images.push({
        id: newId('image'),
        file: file,
        description: '',
        previewUrl: previewUrl,
        status: 'waiting',
        statusText: '等待上传'
      });
    });

    if (problems.length) {
      notify('error', '以下图片未通过校验：\n' + problems.join('\n'), 12000);
    }

    renderPendingList(byId('newNoteImagePreview'), newNoteCtx.images, 'image', function (item) {
      removePendingItem(newNoteCtx.images, item);
      renderPendingList(byId('newNoteImagePreview'), newNoteCtx.images, 'image',
        arguments.callee ? null : null);
      bindNewNotePreviews();
    });
  }

  function handleNewNoteFileSelect(files) {
    const problems = [];
    Array.prototype.forEach.call(files, function (file) {
      const err = validateAttachmentFile(file);
      if (err) {
        problems.push(file.name + '：' + err);
        return;
      }
      newNoteCtx.files.push({
        id: newId('file'),
        file: file,
        status: 'waiting',
        statusText: '等待上传'
      });
    });

    if (problems.length) {
      notify('error', '以下附件未通过校验：\n' + problems.join('\n'), 12000);
    }

    bindNewNotePreviews();
  }

  function bindNewNotePreviews() {
    renderPendingList(byId('newNoteImagePreview'), newNoteCtx.images, 'image', function (item) {
      removePendingItem(newNoteCtx.images, item);
      bindNewNotePreviews();
    });
    renderPendingList(byId('newNoteFilePreview'), newNoteCtx.files, 'file', function (item) {
      removePendingItem(newNoteCtx.files, item);
      bindNewNotePreviews();
    });
  }

  function removePendingItem(list, item) {
    const idx = list.indexOf(item);
    if (idx !== -1) list.splice(idx, 1);
    if (item.previewUrl) {
      try { URL.revokeObjectURL(item.previewUrl); } catch (e) { /* 忽略 */ }
    }
  }

  function renderPendingList(container, items, kind, onRemove) {
    if (!container) return;
    container.textContent = '';

    items.forEach(function (item) {
      const row = document.createElement('div');
      row.className = 'pending-item';

      if (kind === 'image') {
        const im = document.createElement('img');
        im.src = item.previewUrl;
        im.alt = '待上传图片预览：' + item.file.name;
        row.appendChild(im);
      }

      const nameEl = document.createElement('span');
      nameEl.className = 'pending-name';
      nameEl.textContent = item.file.name + '（' + formatSize(item.file.size) + '）';
      row.appendChild(nameEl);

      if (kind === 'image') {
        const descWrap = document.createElement('div');
        descWrap.className = 'pending-desc';
        const descLabel = document.createElement('label');
        descLabel.className = 'field-label';
        descLabel.textContent = '图片说明（可选）';
        const descId = 'desc-' + item.id;
        descLabel.setAttribute('for', descId);
        const descInput = document.createElement('input');
        descInput.type = 'text';
        descInput.id = descId;
        descInput.value = item.description || '';
        descInput.maxLength = 200;
        descInput.addEventListener('input', function () {
          item.description = descInput.value;
        });
        descWrap.appendChild(descLabel);
        descWrap.appendChild(descInput);
        row.appendChild(descWrap);
      }

      const status = document.createElement('span');
      status.className = 'pending-status status-' + item.status;
      status.textContent = item.statusText;
      row.appendChild(status);
      item.statusEl = status;

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-small btn-danger';
      del.textContent = '移除';
      del.title = '从待上传列表移除 ' + item.file.name;
      del.setAttribute('aria-label', '移除待上传文件 ' + item.file.name);
      del.addEventListener('click', function () {
        onRemove(item);
      });
      row.appendChild(del);

      container.appendChild(row);
    });
  }

  function updatePendingStatus(item, status, text) {
    item.status = status;
    item.statusText = text || (
      status === 'uploading' ? '正在上传' :
        status === 'done' ? '上传成功' :
          status === 'error' ? '上传失败' : '等待上传'
    );
    if (item.statusEl) {
      item.statusEl.className = 'pending-status status-' + item.status;
      item.statusEl.textContent = item.statusText;
    }
  }

  async function saveNewNote() {
    if (!state.editing) {
      notify('warn', '当前为只读模式，如需编辑请进入编辑模式。', 5000);
      return;
    }

    const titleInput = byId('newNoteTitle');
    const contentInput = byId('newNoteContent');
    const markedInput = byId('newNoteMarked');
    const categorySelect = byId('newNoteCategory');
    const saveBtn = byId('btnSaveNewNote');

    const title = String(titleInput.value || '').trim();
    const content = String(contentInput.value || '');
    const marked = !!markedInput.checked;
    let categoryId = String(categorySelect.value || '');

    if (!title) {
      notify('error', '笔记标题必须填写。', 6000);
      titleInput.focus();
      return;
    }

    if (!categoryId) {
      if (state.data.categories.length === 0) {
        notify('error', '还没有目录，请先新增目录。', 6000);
        return;
      }
      categoryId = state.data.categories[0].id;
    }

    if (!content.trim() && newNoteCtx.images.length === 0 && newNoteCtx.files.length === 0) {
      notify('error', '标题、图片和附件不能全部为空：请填写正文，或至少上传一张图片 / 一个附件。', 8000);
      return;
    }

    if (saveBtn.disabled) return;
    saveBtn.disabled = true;

    const noteId = newId('note');
    const working = notify('info', '正在保存…', 0);

    try {
      const uploadedImages = [];
      const uploadedFiles = [];

      for (let i = 0; i < newNoteCtx.images.length; i++) {
        const item = newNoteCtx.images[i];
        updatePendingStatus(item, 'uploading');
        try {
          const meta = await uploadAttachment('image', noteId, item);
          uploadedImages.push(meta);
          updatePendingStatus(item, 'done');
        } catch (err) {
          updatePendingStatus(item, 'error');
          throw new AppError(
            '图片「' + item.file.name + '」上传失败：' + ((err && err.message) || '') +
            '（已成功上传的文件仍保留在仓库中，请重新加载后检查。）',
            err && err.status
          );
        }
      }

      for (let j = 0; j < newNoteCtx.files.length; j++) {
        const item = newNoteCtx.files[j];
        updatePendingStatus(item, 'uploading');
        try {
          const meta = await uploadAttachment('file', noteId, item);
          uploadedFiles.push(meta);
          updatePendingStatus(item, 'done');
        } catch (err) {
          updatePendingStatus(item, 'error');
          throw new AppError(
            '附件「' + item.file.name + '」上传失败：' + ((err && err.message) || '') +
            '（已成功上传的文件仍保留在仓库中，请重新加载后检查。）',
            err && err.status
          );
        }
      }

      const nowIso = new Date().toISOString();
      const next = deepClone(state.data);
      next.notes.push({
        id: noteId,
        categoryId: categoryId,
        title: title,
        content: content,
        marked: marked,
        collapsed: false,
        images: uploadedImages,
        attachments: uploadedFiles,
        createdAt: nowIso,
        updatedAt: nowIso
      });

      try {
        await commitData(next, '新增笔记：' + title);
      } catch (err) {
        if (uploadedImages.length || uploadedFiles.length) {
          const paths = uploadedImages.concat(uploadedFiles).map(function (m) {
            return m.path;
          }).join('、');
          throw new AppError(
            '附件已上传，但笔记索引保存失败：' + ((err && err.message) || '') +
            ' 已上传的文件路径：' + paths,
            err && err.status
          );
        }
        throw err;
      }

      working.remove();
      notify('success', '已保存到 GitHub。', 6000);

      titleInput.value = '';
      contentInput.value = '';
      markedInput.checked = false;

      newNoteCtx.images.forEach(function (it) {
        if (it.previewUrl) {
          try { URL.revokeObjectURL(it.previewUrl); } catch (e) { /* 忽略 */ }
        }
      });
      newNoteCtx.images = [];
      newNoteCtx.files = [];
      bindNewNotePreviews();

      render();
    } catch (err) {
      working.remove();
      notify('error', (err && err.message) ? err.message : '保存失败，请稍后重试。', 15000);
    } finally {
      saveBtn.disabled = false;
    }
  }

  function cancelNewNote() {
    newNoteCtx.images.forEach(function (it) {
      if (it.previewUrl) {
        try { URL.revokeObjectURL(it.previewUrl); } catch (e) { /* 忽略 */ }
      }
    });
    newNoteCtx.images = [];
    newNoteCtx.files = [];

    byId('newNoteTitle').value = '';
    byId('newNoteContent').value = '';
    byId('newNoteMarked').checked = false;

    bindNewNotePreviews();
    notify('info', '已取消新增笔记，未修改任何数据。', 4000);
  }

  /* =====================================================================
   * 18. 编辑笔记窗口
   * =================================================================== */

  function openEditNote(noteId) {
    if (!state.editing) return;
    if (noteId) {
      const note = state.data.notes.find(function (n) { return n.id === noteId; });
      if (!note) { notify('error', '找不到该笔记，可能已被其他设备删除，请重新加载远端数据。', 8000); return; }
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

    byId('editNoteImages').value = '';
    byId('editNoteFiles').value = '';

    byId('editNoteError').classList.add('hidden');
    byId('editNoteError').textContent = '';

    renderEditExistingMedia();
    bindEditNotePreviews();

    showModal('editNoteModal');
    byId('editNoteTitle').focus();
  }

  function renderEditExistingMedia() {
    const note = state.data.notes.find(function (n) { return n.id === editNoteCtx.noteId; });
    const imgBox = byId('editNoteExistingImages');
    const fileBox = byId('editNoteExistingFiles');

    imgBox.textContent = '';
    fileBox.textContent = '';

    if (!note) return;

    const images = (note.images || []).filter(function (img) {
      return editNoteCtx.removedImages.indexOf(img.id) === -1;
    });

    const files = (note.attachments || []).filter(function (f) {
      return editNoteCtx.removedFiles.indexOf(f.id) === -1;
    });

    if (images.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = '暂无图片';
      imgBox.appendChild(p);
    } else {
      images.forEach(function (img) {
        const row = document.createElement('div');
        row.className = 'pending-item';

        const im = document.createElement('img');
        im.src = assetUrl(img.path);
        im.alt = img.description || img.originalName || '笔记图片';
        row.appendChild(im);

        const name = document.createElement('span');
        name.className = 'pending-name';
        name.textContent = (img.originalName || '未命名图片') + '（' + formatSize(img.size) + '）';
        row.appendChild(name);

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn-small btn-danger';
        del.textContent = '删除';
        del.title = '删除图片 ' + (img.originalName || '');
        del.setAttribute('aria-label', '删除图片 ' + (img.originalName || ''));
        del.addEventListener('click', async function () {
          const ok = await askConfirm({
            title: '删除图片',
            message: '确认删除图片「' + (img.originalName || '') +
              '」吗？\n\n注意：该图片会在你点击“保存修改”时从 GitHub 仓库中真正删除。',
            confirmText: '标记删除',
            danger: true
          });
          if (!ok) return;
          editNoteCtx.removedImages.push(img.id);
          renderEditExistingMedia();
        });
        row.appendChild(del);

        imgBox.appendChild(row);
      });
    }

    if (files.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = '暂无附件';
      fileBox.appendChild(p);
    } else {
      files.forEach(function (f) {
        const row = document.createElement('div');
        row.className = 'pending-item';

        const name = document.createElement('span');
        name.className = 'pending-name';
        name.textContent = (f.originalName || '未命名附件') + '（' + formatSize(f.size) + '）';
        row.appendChild(name);

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn-small btn-danger';
        del.textContent = '删除';
        del.title = '删除附件 ' + (f.originalName || '');
        del.setAttribute('aria-label', '删除附件 ' + (f.originalName || ''));
        del.addEventListener('click', async function () {
          const ok = await askConfirm({
            title: '删除附件',
            message: '确认删除附件「' + (f.originalName || '') +
              '」吗？\n\n注意：该附件会在你点击“保存修改”时从 GitHub 仓库中真正删除。',
            confirmText: '标记删除',
            danger: true
          });
          if (!ok) return;
          editNoteCtx.removedFiles.push(f.id);
          renderEditExistingMedia();
        });
        row.appendChild(del);

        fileBox.appendChild(row);
      });
    }
  }

  function bindEditNotePreviews() {
    renderPendingList(byId('editNoteImagePreview'), editNoteCtx.images, 'image', function (item) {
      removePendingItem(editNoteCtx.images, item);
      bindEditNotePreviews();
    });
    renderPendingList(byId('editNoteFilePreview'), editNoteCtx.files, 'file', function (item) {
      removePendingItem(editNoteCtx.files, item);
      bindEditNotePreviews();
    });
  }

  function handleEditNoteImageSelect(files) {
    const problems = [];
    Array.prototype.forEach.call(files, function (file) {
      const err = validateImageFile(file);
      if (err) {
        problems.push(file.name + '：' + err);
        return;
      }
      editNoteCtx.images.push({
        id: newId('image'),
        file: file,
        description: '',
        previewUrl: URL.createObjectURL(file),
        status: 'waiting',
        statusText: '等待上传'
      });
    });
    if (problems.length) {
      notify('error', '以下图片未通过校验：\n' + problems.join('\n'), 12000);
    }
    bindEditNotePreviews();
  }

  function handleEditNoteFileSelect(files) {
    const problems = [];
    Array.prototype.forEach.call(files, function (file) {
      const err = validateAttachmentFile(file);
      if (err) {
        problems.push(file.name + '：' + err);
        return;
      }
      editNoteCtx.files.push({
        id: newId('file'),
        file: file,
        status: 'waiting',
        statusText: '等待上传'
      });
    });
    if (problems.length) {
      notify('error', '以下附件未通过校验：\n' + problems.join('\n'), 12000);
    }
    bindEditNotePreviews();
  }

  function closeEditNoteModal() {
    editNoteCtx.images.forEach(function (it) {
      if (it.previewUrl) {
        try { URL.revokeObjectURL(it.previewUrl); } catch (e) { /* 忽略 */ }
      }
    });
    editNoteCtx.noteId = null;
    editNoteCtx.images = [];
    editNoteCtx.files = [];
    editNoteCtx.removedImages = [];
    editNoteCtx.removedFiles = [];
    hideModal('editNoteModal');
  }

  async function saveEditNote() {
    if (!state.editing) return;

  const isNew = !editNoteCtx.noteId;
  const noteId = isNew ? newId('note') : editNoteCtx.noteId;
  const note = isNew ? null : state.data.notes.find(function (n) { return n.id === noteId; });
  if (!isNew && !note) {
    notify('error', '找不到要编辑的笔记（可能已被其他设备删除），请重新加载远端数据。', 10000);
    closeEditNoteModal();
    return;
  }

    const title = String(byId('editNoteTitle').value || '').trim();
    const content = String(byId('editNoteContent').value || '');
    const marked = !!byId('editNoteMarked').checked;
    const categoryId = String(byId('editNoteCategory').value || '');
    const saveBtn = byId('btnSaveEditNote');
    const errEl = byId('editNoteError');

    errEl.classList.add('hidden');
    errEl.textContent = '';

    if (!title) {
      errEl.textContent = '笔记标题必须填写。';
      errEl.classList.remove('hidden');
      byId('editNoteTitle').focus();
      return;
    }

    if (!categoryId) {
      errEl.textContent = '请选择所属目录。';
      errEl.classList.remove('hidden');
      return;
    }

    const keptImages = note ? (note.images || []).filter(function (img) {
      return editNoteCtx.removedImages.indexOf(img.id) === -1;
    }) : [];
    const keptFiles = note ? (note.attachments || []).filter(function (f) {
      return editNoteCtx.removedFiles.indexOf(f.id) === -1;
    }) : [];

    if (!content.trim() && keptImages.length === 0 && editNoteCtx.images.length === 0 &&
        keptFiles.length === 0 && editNoteCtx.files.length === 0) {
      errEl.textContent = '标题、图片和附件不能全部为空：请填写正文，或至少保留 / 上传一张图片或一个附件。';
      errEl.classList.remove('hidden');
      return;
    }

    if (saveBtn.disabled) return;
    saveBtn.disabled = true;

    const working = notify('info', '正在保存…', 0);
    const warnings = [];

    try {
      const uploadedImages = [];
      const uploadedFiles = [];

      for (let i = 0; i < editNoteCtx.images.length; i++) {
        const item = editNoteCtx.images[i];
        updatePendingStatus(item, 'uploading');
        try {
          const meta = await uploadAttachment('image', noteId, item);
          uploadedImages.push(meta);
          updatePendingStatus(item, 'done');
        } catch (err) {
          updatePendingStatus(item, 'error');
          throw new AppError(
            '图片「' + item.file.name + '」上传失败：' + ((err && err.message) || '') +
            '（已成功上传的文件仍保留在仓库中，请重新加载后检查。）',
            err && err.status
          );
        }
      }

      for (let j = 0; j < editNoteCtx.files.length; j++) {
        const item = editNoteCtx.files[j];
        updatePendingStatus(item, 'uploading');
        try {
          const meta = await uploadAttachment('file', noteId, item);
          uploadedFiles.push(meta);
          updatePendingStatus(item, 'done');
        } catch (err) {
          updatePendingStatus(item, 'error');
          throw new AppError(
            '附件「' + item.file.name + '」上传失败：' + ((err && err.message) || '') +
            '（已成功上传的文件仍保留在仓库中，请重新加载后检查。）',
            err && err.status
          );
        }
      }

      const reallyRemovedImages = [];
      for (let k = 0; k < (note.images || []).length; k++) {
        const img = note.images[k];
        if (editNoteCtx.removedImages.indexOf(img.id) === -1) continue;
        try {
          await deleteRepoFile(img.path, '删除图片：' + (img.originalName || ''));
          reallyRemovedImages.push(img.id);
        } catch (err) {
          if (err && err.status === 404) {
            reallyRemovedImages.push(img.id);
            warnings.push('图片文件在仓库中已不存在：' + img.path);
          } else {
            warnings.push('图片删除失败（已保留记录）：' + img.path + ' —— ' + ((err && err.message) || ''));
          }
        }
      }

      const reallyRemovedFiles = [];
      for (let m = 0; m < (note.attachments || []).length; m++) {
        const f = note.attachments[m];
        if (editNoteCtx.removedFiles.indexOf(f.id) === -1) continue;
        try {
          await deleteRepoFile(f.path, '删除附件：' + (f.originalName || ''));
          reallyRemovedFiles.push(f.id);
        } catch (err) {
          if (err && err.status === 404) {
            reallyRemovedFiles.push(f.id);
            warnings.push('附件文件在仓库中已不存在：' + f.path);
          } else {
            warnings.push('附件删除失败（已保留记录）：' + f.path + ' —— ' + ((err && err.message) || ''));
          }
        }
      }

      const finalImages = (note.images || [])
        .filter(function (img) { return reallyRemovedImages.indexOf(img.id) === -1; })
        .concat(uploadedImages);

      const finalFiles = (note.attachments || [])
        .filter(function (f) { return reallyRemovedFiles.indexOf(f.id) === -1; })
        .concat(uploadedFiles);

    const next = deepClone(state.data);
    const nowIso = new Date().toISOString();

    if (isNew) {
      // 新建笔记：push 一条新记录
      next.notes.push({
        id: noteId,
        categoryId: categoryId,
        title: title,
        content: content,
        marked: marked,
        collapsed: false,
        images: finalImages,
        attachments: finalFiles,
        createdAt: nowIso,
        updatedAt: nowIso
      });
    } else {
      // 编辑笔记：更新已有记录
      const target = next.notes.find(function (n) { return n.id === noteId; });
      target.categoryId = categoryId;
      target.title = title;
      target.content = content;
      target.marked = marked;
      target.images = finalImages;
      target.attachments = finalFiles;
      target.updatedAt = nowIso;
    }

    try {
      await commitData(next, (isNew ? '新增笔记：' : '编辑笔记：') + title);
    } catch (err) {
        if (uploadedImages.length || uploadedFiles.length) {
          const paths = uploadedImages.concat(uploadedFiles).map(function (x) {
            return x.path;
          }).join('、');
          throw new AppError(
            '附件已上传，但笔记索引保存失败：' + ((err && err.message) || '') +
            ' 已上传的文件路径：' + paths,
            err && err.status
          );
        }
        throw err;
      }

      working.remove();
      notify('success',
        '已保存到 GitHub。' + (warnings.length ? '（注意：' + warnings.join('；') + '）' : ''),
        warnings.length ? 15000 : 6000);

      closeEditNoteModal();
    if (isNew) {                                        // ← 新增
      state.currentView = 'note';                       // ← 新增
      state.currentNoteId = noteId;                     // ← 新增
    }                                                    // ← 新增
      
      render();
    } catch (err) {
      working.remove();
      errEl.textContent = (err && err.message) ? err.message : '保存失败，请稍后重试。';
      errEl.classList.remove('hidden');
      notify('error', errEl.textContent, 15000);
    } finally {
      saveBtn.disabled = false;
    }
  }

  /* =====================================================================
   * 19. 导入与导出
   * =================================================================== */

  function exportBackup() {
    if (!state.data) {
      notify('warn', '数据尚未加载完成，暂时无法导出。', 5000);
      return;
    }
    const text = JSON.stringify(state.data, null, 2);
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = 'notes-backup-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 2000);

    notify('success', '已导出 JSON 备份文件。注意：该文件只包含元数据，不含图片和附件本体。', 9000);
  }

  function validateImportedData(raw) {
    const problems = [];

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push('顶层必须是一个 JSON 对象。');
      return { problems: problems, data: null };
    }

    if (raw.version !== undefined && raw.version !== 1) {
      problems.push('version 字段为 ' + raw.version + '，当前仅支持 version = 1。');
    }

    if (!Array.isArray(raw.categories)) {
      problems.push('categories 必须是一个数组。');
    }

    if (!Array.isArray(raw.notes)) {
      problems.push('notes 必须是一个数组。');
    }

    if (problems.length) {
      return { problems: problems, data: null };
    }

    const catIds = Object.create(null);
    raw.categories.forEach(function (c, i) {
      if (!c || typeof c !== 'object') {
        problems.push('第 ' + (i + 1) + ' 个目录不是对象。');
        return;
      }
      if (!c.id) problems.push('第 ' + (i + 1) + ' 个目录缺少 id。');
      if (!c.name) problems.push('第 ' + (i + 1) + ' 个目录缺少 name。');
      if (c.id) {
        if (catIds[c.id]) problems.push('目录 id 重复：' + c.id);
        catIds[c.id] = true;
      }
    });

    const noteIds = Object.create(null);
    raw.notes.forEach(function (n, i) {
      if (!n || typeof n !== 'object') {
        problems.push('第 ' + (i + 1) + ' 篇笔记不是对象。');
        return;
      }
      if (!n.id) problems.push('第 ' + (i + 1) + ' 篇笔记缺少 id。');
      if (!n.title) problems.push('第 ' + (i + 1) + ' 篇笔记缺少 title。');
      if (n.id) {
        if (noteIds[n.id]) problems.push('笔记 id 重复：' + n.id);
        noteIds[n.id] = true;
      }
      if (n.categoryId && !catIds[n.categoryId]) {
        problems.push('笔记「' + (n.title || n.id) + '」的 categoryId 找不到对应目录：' + n.categoryId);
      }
      if (n.images !== undefined && !Array.isArray(n.images)) {
        problems.push('笔记「' + (n.title || n.id) + '」的 images 必须是数组。');
      }
      if (n.attachments !== undefined && !Array.isArray(n.attachments)) {
        problems.push('笔记「' + (n.title || n.id) + '」的 attachments 必须是数组。');
      }

      (Array.isArray(n.images) ? n.images : []).forEach(function (img) {
        if (!img || typeof img !== 'object') return;
        if (img.path && (String(img.path).indexOf('..') !== -1 || !/^assets\//.test(String(img.path)))) {
          problems.push('图片路径不合法：' + img.path);
        }
      });

      (Array.isArray(n.attachments) ? n.attachments : []).forEach(function (f) {
        if (!f || typeof f !== 'object') return;
        if (f.path && (String(f.path).indexOf('..') !== -1 || !/^assets\//.test(String(f.path)))) {
          problems.push('附件路径不合法：' + f.path);
        }
      });
    });

    let data = null;
    if (problems.length === 0) {
      try {
        data = normalizeData(raw);
      } catch (e) {
        problems.push((e && e.message) ? e.message : '数据结构规范化失败。');
      }
    }

    return { problems: problems, data: data };
  }

  function handleImportFile(file) {
    const reader = new FileReader();

    reader.onload = function () {
      let raw;
      try {
        raw = JSON.parse(String(reader.result));
      } catch (e) {
        notify('error', '导入失败：文件不是合法的 JSON。', 10000);
        return;
      }

      const result = validateImportedData(raw);
      const summaryEl = byId('importSummary');
      const errEl = byId('importError');

      summaryEl.textContent = '';
      errEl.classList.add('hidden');
      errEl.textContent = '';

      if (result.problems.length) {
        summaryEl.textContent = '发现以下问题，导入已中止：\n\n· ' + result.problems.join('\n· ');
        byId('btnImportConfirm').disabled = true;
        importCandidate = null;
        showModal('importModal');
        return;
      }

      importCandidate = result.data;

      const imgCount = result.data.notes.reduce(function (acc, n) {
        return acc + (n.images || []).length;
      }, 0);
      const fileCount = result.data.notes.reduce(function (acc, n) {
        return acc + (n.attachments || []).length;
      }, 0);

      summaryEl.textContent =
        '结构校验通过。\n\n' +
        '· 目录数量：' + result.data.categories.length + '\n' +
        '· 笔记数量：' + result.data.notes.length + '\n' +
        '· 图片记录：' + imgCount + '\n' +
        '· 附件记录：' + fileCount + '\n\n' +
        '确认导入后，会用以上内容覆盖 GitHub 仓库中的 ' + CONFIG.NOTES_PATH + '。';

      byId('btnImportConfirm').disabled = false;
      showModal('importModal');
    };

    reader.onerror = function () {
      notify('error', '读取本地 JSON 文件失败。', 8000);
    };

    reader.readAsText(file, 'utf-8');
  }

  async function confirmImport() {
    if (!importCandidate) return;
    if (!state.editing) {
      notify('warn', '导入并写入需要先进入编辑模式。', 6000);
      return;
    }

    const btn = byId('btnImportConfirm');
    btn.disabled = true;

    const tip = notify('info', '正在保存…', 0);

    try {
      await commitData(importCandidate, '导入并覆盖 notes.json');
      tip.remove();
      hideModal('importModal');
      importCandidate = null;
      notify('success', '已保存到 GitHub。', 6000);
      render();
    } catch (err) {
      tip.remove();
      const errEl = byId('importError');
      errEl.textContent = (err && err.message) ? err.message : '导入失败。';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  }

  /* =====================================================================
   * 20. 初始化与事件绑定
   * =================================================================== */

  function checkConfig() {
    const problems = [];

    if (!CONFIG.OWNER || CONFIG.OWNER === 'YOUR_GITHUB_USERNAME') {
      problems.push('请在 config.js 中把 OWNER 改成你的 GitHub 用户名。');
    }
    if (!CONFIG.REPO || CONFIG.REPO === 'YOUR_REPOSITORY_NAME') {
      problems.push('请在 config.js 中把 REPO 改成你的仓库名称。');
    }
    if (!CONFIG.BRANCH) {
      problems.push('请在 config.js 中填写 BRANCH（默认 main）。');
    }
    if (!CONFIG.NOTES_PATH) {
      problems.push('请在 config.js 中填写 NOTES_PATH（默认 data/notes.json）。');
    }

    if (problems.length) {
      notify('error', '配置尚未完成：\n' + problems.join('\n'), 0);
      return false;
    }
    return true;
  }

  function bindEvents() {
    byId('btnEnterEdit').addEventListener('click', function () {
      if (state.editing) {
        notify('info', '当前已经是编辑模式。', 4000);
        return;
      }
      byId('tokenInput').value = '';
      byId('tokenError').classList.add('hidden');
      byId('tokenError').textContent = '';
      showModal('tokenModal');
      byId('tokenInput').focus();
    });

    byId('btnExitEdit').addEventListener('click', function () {
      exitEditMode();
    });

    byId('btnToggleToken').addEventListener('click', function () {
      const input = byId('tokenInput');
      const btn = byId('btnToggleToken');
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = '隐藏';
        btn.setAttribute('aria-label', '隐藏 Token');
      } else {
        input.type = 'password';
        btn.textContent = '显示';
        btn.setAttribute('aria-label', '显示 Token');
      }
    });

    byId('btnTokenConfirm').addEventListener('click',  () {
      confirmEnterEditMode();
    });

    byId('btnTokenCancel').addEventListener('click',  () {
      byId('tokenInput').value = '';
      hideModal('tokenModal');
    });

    byId('tokenInput').addEventListener('keydown',  (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        confirmEnterEditMode();
      }
    });

    byId('confirmOkBtn').addEventListener('click',  () {
      resolveConfirm(true);
    });

    byId('confirmCancelBtn').addEventListener('click',  () {
      resolveConfirm(false);
    });

    byId('btnSearch').addEventListener('click',  () {
      state.searchKeyword = String(byId('searchInput').value || '');
      render();
    });

    byId('btnClearSearch').addEventListener('click',  () {
      byId('searchInput').value = '';
      state.searchKeyword = '';
      render();
    });

    byId('searchInput').addEventListener('input',  () {
      state.searchKeyword = String(byId('searchInput').value || '');
      render();
    });

    byId('searchInput').addEventListener('keydown',  (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        state.searchKeyword = String(byId('searchInput').value || '');
        render();
      }
    });

    byId('btnExpandAll').addEventListener('click',  () {
      if (!state.data) return;
      state.data.categories.forEach( (c) {
        state.collapsedCategories[c.id] = false;
      });
      state.data.notes.forEach( (n) {
        state.collapsedNotes[n.id] = false;
      });
      render();
    });

    byId('btnCollapseAll').addEventListener('click',  () {
      if (!state.data) return;
      state.data.categories.forEach( (c) {
        state.collapsedCategories[c.id] = true;
      });
      state.data.notes.forEach( (n) {
        state.collapsedNotes[n.id] = true;
      });
      render();
    });

    byId('btnReload').addEventListener('click',  () {
      loadRemoteData({});
    });

    byId('btnExport').addEventListener('click',  () {
      exportBackup();
    });

    byId('btnImportPick').addEventListener('click',  () {
      byId('importFileInput').click();
    });

    byId('importFileInput').addEventListener('change',  (ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      handleImportFile(file);
    });

    byId('btnImportConfirm').addEventListener('click',  () {
      confirmImport();
    });

    byId('btnImportCancel').addEventListener('click',  () {
      importCandidate = null;
      hideModal('importModal');
    });

    byId('btnAddCategory').addEventListener('click',  () {
      addCategory();
    });

    byId('newCategoryName').addEventListener('keydown',  (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        addCategory();
      }
    });

    byId('newNoteImages').addEventListener('change',  (ev) {
      const files = ev.target.files;
      ev.target.value = '';
      if (!files || !files.length) return;
      handleNewNoteImageSelect(files);
    });

    byId('newNoteFiles').addEventListener('change',  (ev) {
      const files = ev.target.files;
      ev.target.value = '';
      if (!files || !files.length) return;
      handleNewNoteFileSelect(files);
    });

    byId('btnSaveNewNote').addEventListener('click',  () {
      saveNewNote();
    });

    byId('btnCancelNewNote').addEventListener('click',  () {
      cancelNewNote();
    });

    byId('editNoteImages').addEventListener('change',  (ev) {
      const files = ev.target.files;
      ev.target.value = '';
      if (!files || !files.length) return;
      handleEditNoteImageSelect(files);
    });

    byId('editNoteFiles').addEventListener('change',  (ev) {
      const files = ev.target.files;
      ev.target.value = '';
      if (!files || !files.length) return;
      handleEditNoteFileSelect(files);
    });

    byId('btnSaveEditNote').addEventListener('click',  () {
      saveEditNote();
    });

    byId('btnCancelEditNote').addEventListener('click', async  () {
      const dirty = editNoteCtx.images.length > 0 || editNoteCtx.files.length > 0 ||
        editNoteCtx.removedImages.length > 0 || editNoteCtx.removedFiles.length > 0;

      if (dirty) {
        const ok = await askConfirm({
          title: '取消编辑',
          message: '你还有未保存的修改，确认取消吗？原始数据不会被修改。',
          confirmText: '确认取消',
          danger: false
        });
        if (!ok) return;
      }
      closeEditNoteModal();
    });

    document.addEventListener('keydown',  (ev) {
      if (ev.key !== 'Escape') return;

      if (!byId('confirmModal').classList.contains('hidden')) {
        resolveConfirm(false);
        return;
      }
      if (!byId('tokenModal').classList.contains('hidden')) {
        byId('tokenInput').value = '';
        hideModal('tokenModal');
        return;
      }
      if (!byId('importModal').classList.contains('hidden')) {
        importCandidate = null;
        hideModal('importModal');
        return;
      }
      if (!byId('editNoteModal').classList.contains('hidden')) {
        closeEditNoteModal();
      }
    });

    window.addEventListener('offline',  () {
      notify('warn', '网络已断开，保存操作会失败，请恢复网络后重试。', 8000);
    });

    window.addEventListener('online',  () {
      notify('info', '网络已恢复，可以继续操作。', 5000);
    });
    // 侧边栏收起/展开
    byId('btnToggleSidebar').addEventListener('click', () => {
      byId('sidebar').classList.toggle('collapsed');
      byId('btnToggleSidebar').textContent = byId('sidebar').classList.contains('collapsed') ? '▶' : '◀';
    });
    // 返回工作台
    byId('btnBackToDash').addEventListener('click', () => { state.currentView = 'dashboard'; state.currentNoteId = null; render(); });
    // 仪表盘快捷操作
    byId('btnQuickAddNote').addEventListener('click', () => { openEditNote(null); });
    byId('btnQuickReload').addEventListener('click', () => { loadRemoteData({}); });
    byId('btnQuickExport').addEventListener('click', () => { exportBackup(); });
    byId('btnImportWordDash').addEventListener('click', () => { byId('wordFileInput').click(); });
    // 笔记详情页操作
    byId('btnEditCurrentNote').addEventListener('click', () => { if (state.currentNoteId) openEditNote(state.currentNoteId); });
    byId('btnDeleteCurrentNote').addEventListener('click', () => { if (state.currentNoteId) deleteNote(state.currentNoteId); });
    byId('btnToggleMarkCurrentNote').addEventListener('click', () => { if (state.currentNoteId) toggleNoteMarked(state.currentNoteId); });

    // 侧边栏固定入口
    ['sideToolDashboard', 'sideToolPomodoro', 'sideToolTimer'].forEach(function (id) {
      const el = byId(id);
      if (!el) return;
      el.addEventListener('click', function () {
        if (id === 'sideToolDashboard') state.currentView = 'dashboard';
        else if (id === 'sideToolPomodoro') state.currentView = 'pomodoro';
        else if (id === 'sideToolTimer') state.currentView = 'timer';
        render();
      });
    });

    // 工具视图返回按钮
    byId('btnBackFromPomodoro').addEventListener('click', function () {
      state.currentView = 'dashboard'; render();
    });
    byId('btnBackFromTimer').addEventListener('click', function () {
      state.currentView = 'dashboard'; render();
    });

    // 番茄钟按钮
    byId('btnPomodoroStart').addEventListener('click', startPomodoro);
    byId('btnPomodoroPause').addEventListener('click', pausePomodoro);
    byId('btnPomodoroReset').addEventListener('click', resetPomodoro);

    // 倒计时按钮
    byId('btnTimerStart').addEventListener('click', startTimer);
    byId('btnTimerPause').addEventListener('click', pauseTimer);
    byId('btnTimerReset').addEventListener('click', resetTimer);

  }

  async  init() {
    if (CONFIG.SITE_TITLE) {
      byId('siteTitle').textContent = CONFIG.SITE_TITLE;
      document.title = CONFIG.SITE_TITLE;
    }

    bindEvents();
    bindNewNotePreviews();

    if (!checkConfig()) {
      renderStats();
      const container = byId('notesContainer');
      container.textContent = '';
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = '请先修改 config.js 中的 OWNER 和 REPO，然后刷新页面。';
      container.appendChild(p);
      return;
    }

    try {
      const savedToken = sessionStorage.getItem(TOKEN_STORAGE_KEY);
      if (savedToken) {
        state.token = savedToken;
        state.editing = true;
      }
    } catch (e) { /* 忽略 */ }

    render();

    await loadRemoteData({ silent: true });

        // 启动时钟（只启动一次）
    updateClock();
    setInterval(updateClock, 1000);

    // 恢复番茄钟计数（从 localStorage）
    try {
      toolState.pomodoroCount = parseInt(localStorage.getItem('pomodoroCount') || '0', 10) || 0;
    } catch (e) {}
    updatePomodoroDisplay();
    updateTimerDisplay();
    
    if (state.editing) {
      notify('info', '已恢复编辑模式（Token 来自本标签页的 sessionStorage）。', 6000);
    }
  }

  /* =====================================================================
   * 21. Word 导入（解析 .docx 并按标题层级生成目录与笔记）
   * =================================================================== */

  const MAMMOTH_CDNS = [
    'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
    'https://unpkg.com/mammoth@1.8.0/mammoth.browser.min.js',
    'https://fastly.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js'
  ];

  let mammothLoadingPromise = null;

  const wordImportCtx = {
    blocks: null,
    fileName: '',
    mode: 'h1-h2',
    preview: null
  };

  function loadScriptOnce(src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        if (s.parentNode) s.parentNode.removeChild(s);
        reject(new Error('加载脚本失败：' + src));
      };
      document.head.appendChild(s);
    });
  }

  function loadMammoth() {
    if (window.mammoth) {
      return Promise.resolve();
    }
    if (mammothLoadingPromise) {
      return mammothLoadingPromise;
    }
    mammothLoadingPromise = (async function () {
      for (let i = 0; i < MAMMOTH_CDNS.length; i++) {
        try {
          await loadScriptOnce(MAMMOTH_CDNS[i]);
          if (window.mammoth) {
            return;
          }
        } catch (e) {
          /* 尝试下一个 CDN */
        }
      }
      mammothLoadingPromise = null;
      throw new AppError('无法加载 Word 解析库（已尝试多个 CDN 均失败）。请检查网络后重试。', 0);
    })();
    return mammothLoadingPromise;
  }

  async function parseWordToBlocks(file) {
    await loadMammoth();

    const ext = getExtension(file.name);
    if (ext !== 'docx') {
      throw new AppError('只支持 .docx 格式（Word 2007 及以上）。如果使用的是 .doc 老格式，请先在 Word 中另存为 .docx 再导入。', 0);
    }

    let arrayBuffer;
    try {
      arrayBuffer = await readFileAsArrayBuffer(file);
    } catch (e) {
      throw new AppError('读取 Word 文件失败：' + ((e && e.message) || ''), 0);
    }

    let result;
    try {
      result = await window.mammoth.convertToHtml({ arrayBuffer: arrayBuffer });
    } catch (e) {
      throw new AppError('解析 Word 文档失败：' + ((e && e.message) || ''), 0);
    }

    const html = (result && result.value) ? result.value : '';
    return extractBlocksFromHtml(html);
  }

  function extractBlocksFromHtml(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const body = doc.body;
    const blocks = [];

    function textOf(node) {
      return String(node.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function walk(node) {
      if (!node || node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();

      if (/^h[1-6]$/.test(tag)) {
        const text = textOf(node);
        if (text) {
          blocks.push({
            type: 'heading',
            level: parseInt(tag.charAt(1), 10),
            text: text
          });
        }
        return;
      }

      if (tag === 'p') {
        const imgs = node.querySelectorAll('img');
        const text = textOf(node);
        if (text) {
          blocks.push({ type: 'paragraph', text: text });
        } else if (imgs.length > 0) {
          blocks.push({ type: 'paragraph', text: '[图片：Word 中的图片不会自动导入，请手动重新上传]' });
        }
        return;
      }

      if (tag === 'ul' || tag === 'ol') {
        const items = [];
        Array.prototype.forEach.call(node.children, function (li) {
          if (li.tagName.toLowerCase() !== 'li') return;
          const t = textOf(li);
          if (t) items.push('· ' + t);
        });
        if (items.length) {
          blocks.push({ type: 'paragraph', text: items.join('\n') });
        }
        return;
      }

      if (tag === 'table') {
        const rows = [];
        Array.prototype.forEach.call(node.querySelectorAll('tr'), function (tr) {
          const cells = [];
          Array.prototype.forEach.call(tr.querySelectorAll('th,td'), function (cell) {
            cells.push(textOf(cell));
          });
          if (cells.length) rows.push(cells.join(' | '));
        });
        if (rows.length) {
          blocks.push({ type: 'paragraph', text: rows.join('\n') });
        }
        return;
      }

      if (tag === 'img') {
        blocks.push({ type: 'paragraph', text: '[图片：Word 中的图片不会自动导入，请手动重新上传]' });
        return;
      }

      if (tag === 'blockquote') {
        const t = textOf(node);
        if (t) blocks.push({ type: 'paragraph', text: '> ' + t });
        return;
      }

      if (tag === 'hr') {
        blocks.push({ type: 'paragraph', text: '———' });
        return;
      }

      Array.prototype.forEach.call(node.childNodes, walk);
    }

    Array.prototype.forEach.call(body.childNodes, walk);
    return blocks;
  }

  function buildWordPreview(blocks, mode, fileName) {
    const fallbackName = fileName || '导入的 Word 文档';

    if (mode === 'single') {
      const lines = [];
      blocks.forEach(function (b) {
        if (b.type === 'heading') {
          lines.push('【' + b.text + '】');
        } else {
          lines.push(b.text);
        }
      });
      return {
        mode: 'single',
        singleNote: {
          title: fallbackName,
          content: lines.join('\n\n')
        }
      };
    }

    const categories = [];
    let currentCategory = null;
    let currentNote = null;
    let buffer = [];

    function ensureCategory(name) {
      let cat = categories.find(function (c) { return c.name === name; });
      if (!cat) {
        cat = { name: name, notes: [] };
        categories.push(cat);
      }
      return cat;
    }

    function flushNote() {
      if (!currentCategory) {
        buffer = [];
        currentNote = null;
        return;
      }
      if (currentNote || buffer.length > 0) {
        const title = currentNote || currentCategory.name;
        currentCategory.notes.push({
          title: title,
          content: buffer.join('\n\n').trim()
        });
      }
      buffer = [];
      currentNote = null;
    }

    blocks.forEach(function (b) {
      if (b.type === 'heading') {
        if (b.level === 1) {
          flushNote();
          currentCategory = ensureCategory(b.text);
        } else if (b.level === 2) {
          flushNote();
          if (!currentCategory) {
            currentCategory = ensureCategory(fallbackName);
          }
          currentNote = b.text;
        } else {
          if (currentNote) {
            buffer.push('【' + b.text + '】');
          } else if (currentCategory) {
            flushNote();
            currentNote = b.text;
          }
        }
      } else {
        buffer.push(b.text);
      }
    });

    flushNote();

    const filtered = categories.filter(function (c) { return c.notes.length > 0; });

    return {
      mode: 'h1-h2',
      categories: filtered
    };
  }

  function renderWordPreviewText(preview) {
    const lines = [];

    if (preview.mode === 'single') {
      lines.push('导入方式：整篇文档作为一篇笔记');
      lines.push('笔记标题：' + preview.singleNote.title);
      lines.push('内容长度：' + preview.singleNote.content.length + ' 字符');
      return lines.join('\n');
    }

    const totalNotes = preview.categories.reduce(function (acc, c) {
      return acc + c.notes.length;
    }, 0);

    lines.push('导入方式：按标题层级');
    lines.push('识别到的目录数量：' + preview.categories.length);
    lines.push('识别到的笔记数量：' + totalNotes);
    lines.push('');
    lines.push('目录结构预览：');

    preview.categories.forEach(function (cat) {
      lines.push('📁 ' + cat.name + '（' + cat.notes.length + ' 篇）');
      cat.notes.forEach(function (n) {
        const preview30 = n.content.slice(0, 30).replace(/\n/g, ' ');
        lines.push('   📄 ' + n.title + (preview30 ? '  —— ' + preview30 + (n.content.length > 30 ? '…' : '') : ''));
      });
    });

    return lines.join('\n');
  }

  function refreshWordPreview() {
    if (!wordImportCtx.blocks) return;

    const mode = byId('wordImportMode').value;
    wordImportCtx.mode = mode;

    const singleRow = byId('wordImportSingleRow');
    if (singleRow) {
      singleRow.style.display = (mode === 'single') ? '' : 'none';
    }

    const preview = buildWordPreview(
      wordImportCtx.blocks,
      mode,
      wordImportCtx.fileName
    );
    wordImportCtx.preview = preview;

    const summaryEl = byId('wordImportSummary');
    if (summaryEl) {
      summaryEl.textContent = renderWordPreviewText(preview);
    }

    const errEl = byId('wordImportError');
    errEl.classList.add('hidden');
    errEl.textContent = '';

    const confirmBtn = byId('btnWordImportConfirm');

    if (mode === 'h1-h2') {
      if (preview.categories.length === 0) {
        confirmBtn.disabled = true;
        errEl.textContent = '未识别到任何标题结构。请确认 Word 文档使用了"标题 1""标题 2"样式，或改用"整篇文档作为一篇笔记"模式。';
        errEl.classList.remove('hidden');
      } else {
        confirmBtn.disabled = false;
      }
    } else {
      const catId = byId('wordImportSingleCategory').value;
      if (!catId) {
        confirmBtn.disabled = true;
        errEl.textContent = '请选择目标目录。';
        errEl.classList.remove('hidden');
      } else {
        confirmBtn.disabled = false;
      }
    }
  }

  function handleWordFileSelected(file) {
    if (!state.editing) {
      notify('warn', '请先进入编辑模式。', 5000);
      return;
    }

    wordImportCtx.fileName = file.name.replace(/\.docx$/i, '');
    wordImportCtx.blocks = null;
    wordImportCtx.preview = null;

    const loading = notify('info', '正在解析 Word 文档…', 0);

    parseWordToBlocks(file)
      .then(function (blocks) {
        loading.remove();
        if (!blocks.length) {
          throw new AppError('Word 文档中未找到任何有效内容。', 0);
        }
        wordImportCtx.blocks = blocks;

        fillCategorySelect(byId('wordImportSingleCategory'), '');

        byId('wordImportMode').value = 'h1-h2';

        refreshWordPreview();
        showModal('wordImportModal');
      })
      .catch(function (err) {
        loading.remove();
        notify('error', (err && err.message) ? err.message : '解析 Word 文档失败。', 12000);
      });
  }

  async function executeWordImport() {
    if (!state.editing) {
      notify('warn', '请先进入编辑模式。', 5000);
      return;
    }

    const preview = wordImportCtx.preview;
    if (!preview) return;

    const btn = byId('btnWordImportConfirm');
    if (btn.disabled) return;
    btn.disabled = true;

    const working = notify('info', '正在保存…', 0);
    const nowIso = new Date().toISOString();

    try {
      const next = deepClone(state.data);

      if (preview.mode === 'single') {
        const categoryId = String(byId('wordImportSingleCategory').value || '');
        if (!categoryId) {
          throw new AppError('请选择目标目录。', 0);
        }
        next.notes.push({
          id: newId('note'),
          categoryId: categoryId,
          title: preview.singleNote.title,
          content: preview.singleNote.content,
          marked: false,
          collapsed: false,
          images: [],
          attachments: [],
          createdAt: nowIso,
          updatedAt: nowIso
        });
      } else {
        preview.categories.forEach(function (catPreview) {
          let cat = next.categories.find(function (c) {
            return c.name === catPreview.name;
          });
          if (!cat) {
            cat = {
              id: newId('category'),
              name: catPreview.name,
              marked: false,
              collapsed: false,
              createdAt: nowIso,
              updatedAt: nowIso
            };
            next.categories.push(cat);
          }
          catPreview.notes.forEach(function (notePreview) {
            next.notes.push({
              id: newId('note'),
              categoryId: cat.id,
              title: notePreview.title,
              content: notePreview.content,
              marked: false,
              collapsed: false,
              images: [],
              attachments: [],
              createdAt: nowIso,
              updatedAt: nowIso
            });
          });
        });
      }

      await commitData(next, '从 Word 导入笔记：' + wordImportCtx.fileName);

      working.remove();
      hideModal('wordImportModal');
      wordImportCtx.blocks = null;
      wordImportCtx.preview = null;
      wordImportCtx.fileName = '';

      notify('success', '已保存到 GitHub。', 6000);
      render();
    } catch (err) {
      working.remove();
      const errEl = byId('wordImportError');
      errEl.textContent = (err && err.message) ? err.message : '导入失败。';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  }

  function bindWordImportEvents() {
    const btnOpen = byId('btnImportWord');
    if (btnOpen) {
      btnOpen.addEventListener('click', function () {
        if (!state.editing) {
          notify('warn', '请先进入编辑模式。', 5000);
          return;
        }
        byId('wordFileInput').click();
      });
    }

    const fileInput = byId('wordFileInput');
    if (fileInput) {
      fileInput.addEventListener('change', function (ev) {
        const file = ev.target.files && ev.target.files[0];
        ev.target.value = '';
        if (!file) return;
        handleWordFileSelected(file);
      });
    }

    const modeSel = byId('wordImportMode');
    if (modeSel) {
      modeSel.addEventListener('change', function () {
        refreshWordPreview();
      });
    }

    const singleCat = byId('wordImportSingleCategory');
    if (singleCat) {
      singleCat.addEventListener('change', function () {
        refreshWordPreview();
      });
    }

    const confirmBtn = byId('btnWordImportConfirm');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', function () {
        executeWordImport();
      });
    }

    const cancelBtn = byId('btnWordImportCancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        wordImportCtx.blocks = null;
        wordImportCtx.preview = null;
        wordImportCtx.fileName = '';
        hideModal('wordImportModal');
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindWordImportEvents);
  } else {
    bindWordImportEvents();
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

/* =========================================================================
 * 独立补丁：时钟 + 侧边栏工具入口 + 番茄钟 + 倒计时
 * 该补丁完全独立，放在 app.js 末尾即可，不会与前面的代码冲突。
 * 使用事件委托（绑定在 document 上），即使按钮是后创建的也能响应。
 * ========================================================================= */
(function () {
  'use strict';

  /* ---------- 工具状态（独立变量，不与前面的代码冲突） ---------- */
  var __pomodoroTimer = null;
  var __pomodoroTotal = 25 * 60;
  var __pomodoroTime = __pomodoroTotal;
  var __pomodoroCount = 0;
  var __timerInterval = null;
  var __timerRemaining = 0;

  try {
    __pomodoroCount = parseInt(localStorage.getItem('pomodoroCount') || '0', 10) || 0;
  } catch (e) { /* 忽略 */ }

  function pad(n) { return String(n).padStart(2, '0'); }

  /* ---------- 时钟：每秒从系统时间读取一次 ---------- */
  function updateClock() {
    var now = new Date();
    var days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    var t = document.getElementById('currentTime');
    var d = document.getElementById('currentDate');
    if (t) {
      t.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
    }
    if (d) {
      d.textContent = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 ' + days[now.getDay()];
    }
  }

  /* ---------- 简易通知：不依赖前面的 notify 函数 ---------- */
  function showLocalNotify(msg, kind) {
    var area = document.getElementById('notifyArea');
    if (!area) { try { alert(msg); } catch (e) {} return; }
    var div = document.createElement('div');
    div.className = 'notify notify-' + (kind || 'info');
    var span = document.createElement('span');
    span.textContent = msg;
    div.appendChild(span);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'notify-close';
    btn.textContent = '×';
    btn.setAttribute('aria-label', '关闭提示');
    btn.addEventListener('click', function () { if (div.parentNode) div.parentNode.removeChild(div); });
    div.appendChild(btn);
    area.appendChild(div);
    setTimeout(function () { if (div.parentNode) div.parentNode.removeChild(div); }, 10000);
  }

  /* ---------- 视图切换 ---------- */
  function showView(name) {
    ['dashboardView', 'noteView', 'pomodoroView', 'timerView'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
    var map = { dashboard: 'dashboardView', pomodoro: 'pomodoroView', timer: 'timerView' };
    var el = document.getElementById(map[name]);
    if (el) el.classList.remove('hidden');
  }

  function highlightSideTool(id) {
    ['sideToolDashboard', 'sideToolPomodoro', 'sideToolTimer'].forEach(function (x) {
      var e = document.getElementById(x);
      if (e) e.classList.remove('active');
    });
    var active = document.getElementById(id);
    if (active) active.classList.add('active');
  }

  /* ---------- 番茄钟 ---------- */
  function updatePomodoroDisplay() {
    var el = document.getElementById('pomodoroDisplay');
    if (el) {
      el.textContent = pad(Math.floor(__pomodoroTime / 60)) + ':' + pad(__pomodoroTime % 60);
    }
    var c = document.getElementById('pomodoroCount');
    if (c) c.textContent = String(__pomodoroCount);
  }

  function startPomodoro() {
    if (__pomodoroTimer) return;
    if (__pomodoroTime <= 0) __pomodoroTime = __pomodoroTotal;
    __pomodoroTimer = setInterval(function () {
      __pomodoroTime--;
      updatePomodoroDisplay();
      if (__pomodoroTime <= 0) {
        clearInterval(__pomodoroTimer);
        __pomodoroTimer = null;
        __pomodoroCount++;
        try { localStorage.setItem('pomodoroCount', String(__pomodoroCount)); } catch (e) {}
        __pomodoroTime = __pomodoroTotal;
        updatePomodoroDisplay();
        showLocalNotify('🍅 番茄钟时间到！休息一下吧。', 'success');
      }
    }, 1000);
  }

  function pausePomodoro() {
    if (__pomodoroTimer) { clearInterval(__pomodoroTimer); __pomodoroTimer = null; }
  }

  function resetPomodoro() {
    pausePomodoro();
    __pomodoroTime = __pomodoroTotal;
    updatePomodoroDisplay();
  }

  /* ---------- 倒计时 ---------- */
  function updateTimerDisplay() {
    var el = document.getElementById('timerDisplay');
    if (!el) return;
    el.textContent = pad(Math.floor(__timerRemaining / 60)) + ':' + pad(__timerRemaining % 60);
  }

  function startTimer() {
    if (__timerInterval) return;
    if (__timerRemaining <= 0) {
      var inp = document.getElementById('timerMinutes');
      var mins = parseInt((inp && inp.value) || '5', 10) || 5;
      __timerRemaining = mins * 60;
    }
    __timerInterval = setInterval(function () {
      __timerRemaining--;
      updateTimerDisplay();
      if (__timerRemaining <= 0) {
        clearInterval(__timerInterval);
        __timerInterval = null;
        __timerRemaining = 0;
        updateTimerDisplay();
        showLocalNotify('⏰ 定时提醒时间到！', 'warn');
      }
    }, 1000);
  }

  function pauseTimer() {
    if (__timerInterval) { clearInterval(__timerInterval); __timerInterval = null; }
  }

  function resetTimer() {
    pauseTimer();
    __timerRemaining = 0;
    updateTimerDisplay();
  }

  /* ---------- 事件委托 1：侧边栏工具入口 ---------- */
  document.addEventListener('click', function (ev) {
    var node = ev.target;
    while (node && node !== document.body) {
      if (node.classList && node.classList.contains('side-tool-item')) {
        var id = node.id;
        if (id === 'sideToolDashboard') {
          showView('dashboard');
          highlightSideTool(id);
        } else if (id === 'sideToolPomodoro') {
          showView('pomodoro');
          highlightSideTool(id);
          updatePomodoroDisplay();
        } else if (id === 'sideToolTimer') {
          showView('timer');
          highlightSideTool(id);
          updateTimerDisplay();
        }
        return;
      }
      node = node.parentNode;
    }
  });

  /* ---------- 事件委托 2：番茄钟 / 倒计时 按钮 ---------- */
  document.addEventListener('click', function (ev) {
    var node = ev.target;
    var id = null;
    while (node && node !== document.body) {
      if (node.id) { id = node.id; break; }
      node = node.parentNode;
    }
    if (!id) return;
    if (id === 'btnPomodoroStart') startPomodoro();
    else if (id === 'btnPomodoroPause') pausePomodoro();
    else if (id === 'btnPomodoroReset') resetPomodoro();
    else if (id === 'btnTimerStart') startTimer();
    else if (id === 'btnTimerPause') pauseTimer();
    else if (id === 'btnTimerReset') resetTimer();
    else if (id === 'btnBackFromPomodoro' || id === 'btnBackFromTimer') {
      showView('dashboard');
      highlightSideTool('sideToolDashboard');
    }
  });

  /* ---------- 启动时钟：立即执行一次，然后每秒刷新 ---------- */
  updateClock();
  setInterval(updateClock, 1000);

  /* ---------- 初始化显示 ---------- */
  updatePomodoroDisplay();
  updateTimerDisplay();

})();
