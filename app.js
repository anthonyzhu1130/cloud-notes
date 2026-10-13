(function () {
  'use strict';
  var CONFIG = window.APP_CONFIG || {};
  var TOKEN_STORAGE_KEY = 'cloudNotes.githubToken';
  var REMINDER_STORAGE_KEY = 'cloudNotes.reminders';
  var ALLOWED_TAGS = { B:1, STRONG:1, I:1, EM:1, U:1, S:1, STRIKE:1, DEL:1, BR:1, P:1, DIV:1, SPAN:1, IMG:1, MARK:1, TABLE:1, THEAD:1, TBODY:1, TFOOT:1, TR:1, TH:1, TD:1, CAPTION:1 };

  var state = {
    data: null, remoteUpdatedAt: null, token: null, editing: false,
    searchKeyword: '', busy: false,
    collapsedCategories: {}, collapsedNotes: {},
    currentView: 'dashboard', currentNoteId: null,
    batchMode: false, batchSelected: {}
  };

  var toolState = { pomodoroTimer: null, pomodoroTime: 25*60, pomodoroTotal: 25*60, pomodoroCount: 0 };
  var REMINDER_CATS = [{key:'work',label:'工作'},{key:'study',label:'学习'},{key:'sport',label:'运动'},{key:'food',label:'饮食'},{key:'sleep',label:'睡眠'}];
  var REMINDER_REPEATS = [{key:'once',label:'一次性'},{key:'daily',label:'每天'},{key:'weekly',label:'每周'},{key:'monthly',label:'每月'}];
  var reminderState = { list: [], filter:{search:'',cat:'all',sort:'remaining',dir:'asc'}, editing:null, notified:{} };
  var editNoteCtx = { noteId: null, newImages: [], files: [], removedFiles: [] };
  var importCandidate = null;

  function byId(id){return document.getElementById(id);}
  function deepClone(v){return JSON.parse(JSON.stringify(v));}
  function pad(n){var s=String(n);return s.length<2?'0'+s:s;}
  function newId(p){var id;if(window.crypto&&typeof window.crypto.randomUUID==='function')id=window.crypto.randomUUID();else id=Date.now().toString(36)+Math.random().toString(36).slice(2,10);return p?p+'-'+id:id;}

  function formatSize(b){var n=Number(b)||0;if(n<1024)return n+' B';if(n<1024*1024)return (n/1024).toFixed(1)+' KB';return (n/1024/1024).toFixed(2)+' MB';}
  function formatTime(iso){if(!iso)return '未知';var d=new Date(iso);if(isNaN(d.getTime()))return String(iso);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes());}
  function getExt(n){var m=/\.([A-Za-z0-9]+)$/.exec(String(n||''));return m?m[1].toLowerCase():'';}

  function safeFileName(name){var n=String(name||'file');n=n.replace(/\\/g,'/');var p=n.split('/');n=p[p.length-1];n=n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g,'_');n=n.replace(/\.\./g,'_');n=n.replace(/^[.\s]+/,'_');n=n.replace(/\s+/g,'_');if(!n)n='file';if(n.length>120){var d=n.lastIndexOf('.');n=d>3?n.slice(0,100)+n.slice(d):n.slice(0,120);}return n;}

  function guessMime(n){var e=getExt(n);var m={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',pdf:'application/pdf',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',txt:'text/plain',csv:'text/csv',zip:'application/zip'};return m[e]||'application/octet-stream';}

  function extFromMime(m){m=String(m||'').toLowerCase();if(m.indexOf('jpeg')>=0||m.indexOf('jpg')>=0)return 'jpg';if(m.indexOf('png')>=0)return 'png';if(m.indexOf('gif')>=0)return 'gif';if(m.indexOf('webp')>=0)return 'webp';return 'png';}

  function assetUrl(p){return String(p||'').split('/').map(encodeURIComponent).join('/');}

  function utf8ToBase64(s){var b=new TextEncoder().encode(String(s));var bi='';var c=0x8000;for(var i=0;i<b.length;i+=c)bi+=String.fromCharCode.apply(null,b.subarray(i,i+c));return btoa(bi);}
  function base64ToUtf8(s){var cl=String(s||'').replace(/[\r\n\s]/g,'');var bi=atob(cl);var by=new Uint8Array(bi.length);for(var i=0;i<bi.length;i++)by[i]=bi.charCodeAt(i);return new TextDecoder('utf-8').decode(by);}
  function arrayBufferToBase64(b){var by=new Uint8Array(b);var bi='';var c=0x8000;for(var i=0;i<by.length;i+=c)bi+=String.fromCharCode.apply(null,by.subarray(i,i+c));return btoa(bi);}

  function readFileAsArrayBuffer(f){return new Promise(function(res,rej){var r=new FileReader();r.onload=function(){res(r.result);};r.onerror=function(){rej(new Error('读取文件失败：'+f.name));};r.readAsArrayBuffer(f);});}

  function AppError(m,s,d){this.name='AppError';this.message=m;this.status=s||0;this.detail=d||'';}
  AppError.prototype=Object.create(Error.prototype);

  function apiBase(){return 'https://api.github.com/repos/'+encodeURIComponent(CONFIG.OWNER||'')+'/'+encodeURIComponent(CONFIG.REPO||'');}
  function contentsUrl(p){var c=String(p||'').split('/').filter(Boolean).map(encodeURIComponent).join('/');return apiBase()+'/contents/'+c;}

  function describeError(s,d){var t=d?'（'+d+'）':'';switch(s){case 0:return '网络请求失败。'+t;case 401:return '身份验证失败。'+t;case 403:return /rate limit/i.test(d)?'API 请求受限。'+t:'权限不足（403）。'+t;case 404:return '未找到资源（404）。'+t;case 409:return '远端文件已变化，请重新加载。'+t;case 413:return '请求内容过大（413）。'+t;case 422:return '请求参数错误（422）。'+t;default:return 'GitHub API 请求失败（'+s+'）。'+t;}}

  function ghFetch(url,opt){
    opt=opt||{};
    var headers={'Accept':'application/vnd.github+json','X-GitHub-Api-Version':CONFIG.API_VERSION||'2022-11-28'};
    if(opt.token)headers['Authorization']='Bearer '+opt.token;
    var init={method:opt.method||'GET',headers:headers,cache:'no-store'};
    if(opt.body!==undefined&&opt.body!==null){headers['Content-Type']='application/json; charset=utf-8';init.body=JSON.stringify(opt.body);}
    return fetch(url,init).then(function(r){
      if(!r.ok)return r.text().then(function(t){var d='';try{d=JSON.parse(t).message||'';}catch(e){}throw new AppError(describeError(r.status,d),r.status,d);});
      if(r.status===204)return null;
      return r.text().then(function(t){if(!t)return null;try{return JSON.parse(t);}catch(e){return null;}});
    },function(e){throw new AppError('网络请求失败。',0,String((e&&e.message)||e));});
  }

  function parseNotesJson(t,sha){var j;try{j=JSON.parse(t);}catch(e){throw new AppError('notes.json 不是合法 JSON。',0);}return {json:normalizeData(j),sha:sha||null};}

  function fetchRemoteNotes(token){
    var url=contentsUrl(CONFIG.NOTES_PATH)+'?ref='+encodeURIComponent(CONFIG.BRANCH||'main')+'&t='+Date.now();
    return ghFetch(url,{token:token||state.token||null}).then(function(r){
      if(!r)throw new AppError('远端 notes.json 返回空数据。',0);
      if(r.content&&r.encoding==='base64')return parseNotesJson(base64ToUtf8(r.content),r.sha);
      if(r.download_url)return fetch(r.download_url+'?t='+Date.now(),{cache:'no-store'}).then(function(x){if(!x.ok)throw new AppError('下载失败。',x.status);return x.text();}).then(function(t){return parseNotesJson(t,r.sha);});
      throw new AppError('无法读取远端 notes.json。',0);
    });
  }

  function normalizeImage(r){if(!r||typeof r!=='object')return null;return {id:String(r.id||newId('image')),originalName:String(r.originalName||''),storedName:String(r.storedName||''),path:String(r.path||''),mimeType:String(r.mimeType||''),size:Number(r.size)||0,description:String(r.description||''),sha:String(r.sha||''),createdAt:String(r.createdAt||new Date().toISOString())};}
  function normalizeFile(r){if(!r||typeof r!=='object')return null;return {id:String(r.id||newId('file')),originalName:String(r.originalName||''),storedName:String(r.storedName||''),path:String(r.path||''),mimeType:String(r.mimeType||''),size:Number(r.size)||0,sha:String(r.sha||''),createdAt:String(r.createdAt||new Date().toISOString())};}

  function normalizeData(raw){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new AppError('notes.json 结构不正确。',0);
    if(raw.categories!==undefined&&!Array.isArray(raw.categories))throw new AppError('categories 必须是数组。',0);
    if(raw.notes!==undefined&&!Array.isArray(raw.notes))throw new AppError('notes 必须是数组。',0);
    var now=new Date().toISOString();
    var d={version:(typeof raw.version==='number')?raw.version:2,updatedAt:(typeof raw.updatedAt==='string')?raw.updatedAt:now,categories:[],notes:[]};
    (raw.categories||[]).forEach(function(c){if(!c||typeof c!=='object')return;d.categories.push({id:String(c.id||newId('category')),name:String(c.name||'未命名目录'),parentId:(c.parentId==null)?null:String(c.parentId),marked:!!c.marked,collapsed:!!c.collapsed,createdAt:String(c.createdAt||now),updatedAt:String(c.updatedAt||c.createdAt||now)});});
    (raw.notes||[]).forEach(function(n){if(!n||typeof n!=='object')return;d.notes.push({id:String(n.id||newId('note')),categoryId:String(n.categoryId||''),title:String(n.title||'无标题笔记'),content:(typeof n.content==='string')?n.content:'',marked:!!n.marked,collapsed:!!n.collapsed,images:Array.isArray(n.images)?n.images.map(normalizeImage).filter(Boolean):[],attachments:Array.isArray(n.attachments)?n.attachments.map(normalizeFile).filter(Boolean):[],createdAt:String(n.createdAt||now),updatedAt:String(n.updatedAt||n.createdAt||now)});});
    return d;
  }

  function commitData(next,msg){
    if(!state.token)return Promise.reject(new AppError('当前不是编辑模式。',401));
    return fetchRemoteNotes().catch(function(e){if(e&&e.status===404)return null;throw e;}).then(function(remote){
      if(remote&&state.remoteUpdatedAt&&remote.json.updatedAt&&remote.json.updatedAt!==state.remoteUpdatedAt)throw new AppError('远端文件已变化，请重新加载后再编辑。',409);
      next.version=next.version||2;
      next.updatedAt=new Date().toISOString();
      var body={message:msg,content:utf8ToBase64(JSON.stringify(next,null,2)+'\n'),branch:CONFIG.BRANCH||'main'};
      if(remote&&remote.sha)body.sha=remote.sha;
      return ghFetch(contentsUrl(CONFIG.NOTES_PATH),{method:'PUT',token:state.token,body:body}).then(function(){state.data=next;state.remoteUpdatedAt=next.updatedAt;});
    });
  }

  function putRepoFile(path,b64,msg){
    return ghFetch(contentsUrl(path)+'?ref='+encodeURIComponent(CONFIG.BRANCH||'main')+'&t='+Date.now(),{token:state.token}).catch(function(e){if(e&&e.status===404)return null;throw e;}).then(function(ex){
      var body={message:msg,content:b64,branch:CONFIG.BRANCH||'main'};
      if(ex&&ex.sha)body.sha=ex.sha;
      return ghFetch(contentsUrl(path),{method:'PUT',token:state.token,body:body});
    });
  }

  function deleteRepoFile(path,msg){
    return ghFetch(contentsUrl(path)+'?ref='+encodeURIComponent(CONFIG.BRANCH||'main')+'&t='+Date.now(),{token:state.token}).then(function(info){
      if(!info||!info.sha)throw new AppError('无法获取文件 sha：'+path,404);
      return ghFetch(contentsUrl(path),{method:'DELETE',token:state.token,body:{message:msg,sha:info.sha,branch:CONFIG.BRANCH||'main'}});
    });
  }

  function validateImageFile(f){var e=getExt(f.name);var a=(CONFIG.ALLOWED_IMAGE_EXTENSIONS||[]).map(function(x){return String(x).toLowerCase();});if(a.indexOf(e)===-1)return '不支持的图片格式：.'+e;if(f.type==='image/svg+xml')return '不允许上传 SVG。';if(f.size>(CONFIG.MAX_IMAGE_SIZE||5*1024*1024))return '图片过大（'+formatSize(f.size)+'）';return null;}
  function validateAttachmentFile(f){var e=getExt(f.name);var a=(CONFIG.ALLOWED_FILE_EXTENSIONS||[]).map(function(x){return String(x).toLowerCase();});if(a.indexOf(e)===-1)return '不支持的附件格式：.'+e;if(f.size>(CONFIG.MAX_FILE_SIZE||10*1024*1024))return '附件过大（'+formatSize(f.size)+'）';return null;}

  function uploadAttachment(kind,noteId,item){
    var isImg=kind==='image';
    var root=isImg?(CONFIG.IMAGE_ROOT||'assets/images'):(CONFIG.FILE_ROOT||'assets/files');
    var stored=item.id+'-'+safeFileName(item.file.name);
    var path=root+'/'+noteId+'/'+stored;
    return readFileAsArrayBuffer(item.file).then(function(buf){
      return putRepoFile(path,arrayBufferToBase64(buf),(isImg?'上传图片：':'上传附件：')+item.file.name).then(function(res){
        var sha=(res&&res.content&&res.content.sha)?res.content.sha:'';
        var meta={id:item.id,originalName:item.file.name,storedName:stored,path:path,mimeType:item.file.type||guessMimeType(item.file.name),size:item.file.size,sha:sha,createdAt:new Date().toISOString()};
        if(isImg)meta.description=String(item.description||'');
        return meta;
      });
    });
  }

  function uploadBase64Image(b64,mime,noteId,baseName){
    var id=newId('image');var ext=extFromMime(mime);var stored=id+'-'+(baseName||'word')+'.'+ext;
    var path=(CONFIG.IMAGE_ROOT||'assets/images')+'/'+noteId+'/'+stored;
    return putRepoFile(path,b64,'Word 图片：'+stored).then(function(res){
      var sha=(res&&res.content&&res.content.sha)?res.content.sha:'';
      return {id:id,originalName:stored,storedName:stored,path:path,mimeType:mime,size:Math.ceil(b64.length*3/4),sha:sha,description:'',createdAt:new Date().toISOString()};
    });
  }

  function notify(kind,msg,to){
    var area=byId('notifyArea');if(!area)return null;
    var div=document.createElement('div');div.className='notify notify-'+kind;
    var s=document.createElement('span');s.textContent=String(msg);div.appendChild(s);
    var c=document.createElement('button');c.type='button';c.className='notify-close';c.setAttribute('aria-label','关闭');c.textContent='×';
    c.addEventListener('click',function(){if(div.parentNode)div.parentNode.removeChild(div);});
    div.appendChild(c);area.appendChild(div);
    if(to===undefined)to=6000;
    if(to>0)setTimeout(function(){if(div.parentNode)div.parentNode.removeChild(div);},to);
    return div;
  }

  function showModal(id){var e=byId(id);if(e)e.classList.remove('hidden');}
  function hideModal(id){var e=byId(id);if(e)e.classList.add('hidden');}

  var confirmResolver=null;
  function askConfirm(o){
    o=o||{};
    return new Promise(function(res){
      confirmResolver=res;
      byId('confirmTitle').textContent=o.title||'确认';
      byId('confirmMessage').textContent=o.message||'';
      byId('confirmOkBtn').textContent=o.confirmText||'确认';
      showModal('confirmModal');byId('confirmOkBtn').focus();
    });
  }
  function resolveConfirm(v){hideModal('confirmModal');var r=confirmResolver;confirmResolver=null;if(r)r(v);}

  function updateClock(){try{var n=new Date();var d=['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];var t=byId('currentTime'),de=byId('currentDate');if(t)t.textContent=pad(n.getHours())+':'+pad(n.getMinutes());if(de)de.textContent=n.getFullYear()+'年'+(n.getMonth()+1)+'月'+n.getDate()+'日 '+d[n.getDay()];}catch(e){}}

  function updatePomodoroDisplay(){var e=byId('pomodoroDisplay');if(e)e.textContent=pad(Math.floor(toolState.pomodoroTime/60))+':'+pad(toolState.pomodoroTime%60);var c=byId('pomodoroCount');if(c)c.textContent=String(toolState.pomodoroCount);}
  function startPomodoro(){if(toolState.pomodoroTimer)return;if(toolState.pomodoroTime<=0)toolState.pomodoroTime=toolState.pomodoroTotal;toolState.pomodoroTimer=setInterval(function(){toolState.pomodoroTime--;updatePomodoroDisplay();if(toolState.pomodoroTime<=0){clearInterval(toolState.pomodoroTimer);toolState.pomodoroTimer=null;toolState.pomodoroCount++;try{localStorage.setItem('pomodoroCount',String(toolState.pomodoroCount));}catch(e){}toolState.pomodoroTime=toolState.pomodoroTotal;updatePomodoroDisplay();notify('success','🍅 番茄钟时间到！',10000);}},1000);}
  function pausePomodoro(){if(toolState.pomodoroTimer){clearInterval(toolState.pomodoroTimer);toolState.pomodoroTimer=null;}}
  function resetPomodoro(){pausePomodoro();toolState.pomodoroTime=toolState.pomodoroTotal;updatePomodoroDisplay();}

  function loadReminders(){try{var s=localStorage.getItem(REMINDER_STORAGE_KEY);reminderState.list=s?JSON.parse(s):[];if(!Array.isArray(reminderState.list))reminderState.list=[];}catch(e){reminderState.list=[];}}
  function saveReminders(){try{localStorage.setItem(REMINDER_STORAGE_KEY,JSON.stringify(reminderState.list));}catch(e){}}
  function catLabel(k){for(var i=0;i<REMINDER_CATS.length;i++)if(REMINDER_CATS[i].key===k)return REMINDER_CATS[i].label;return k||'工作';}
  function repeatLabel(k){for(var i=0;i<REMINDER_REPEATS.length;i++)if(REMINDER_REPEATS[i].key===k)return REMINDER_REPEATS[i].label;return k||'一次性';}

  function computeNextAt(r){if(!r||!r.date||!r.time)return null;var dt=new Date(r.date+'T'+r.time+':00');if(isNaN(dt.getTime()))return null;var n=new Date();if(r.repeat==='once')return dt;var g=0;while(dt<=n&&g<1000){g++;if(r.repeat==='daily')dt.setDate(dt.getDate()+1);else if(r.repeat==='weekly')dt.setDate(dt.getDate()+7);else if(r.repeat==='monthly')dt.setMonth(dt.getMonth()+1);else break;}return dt;}

  function formatRemaining(ms){if(ms<=0)return '已到期';var s=Math.floor(ms/1000);var d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60);if(d>0)return '剩余 '+d+' 天 '+h+' 小时';if(h>0)return '剩余 '+h+' 小时 '+m+' 分钟';if(m>0)return '剩余 '+m+' 分钟';return '不到 1 分钟';}
  function formatDateTime(d){if(!d)return '—';return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes());}

  function initReminderSelects(){
    var s1=byId('reminderCat');if(s1){s1.textContent='';REMINDER_CATS.forEach(function(c){var o=document.createElement('option');o.value=c.key;o.textContent=c.label;s1.appendChild(o);});}
    var s2=byId('reminderRepeat');if(s2){s2.textContent='';REMINDER_REPEATS.forEach(function(c){var o=document.createElement('option');o.value=c.key;o.textContent=c.label;s2.appendChild(o);});}
    var s3=byId('reminderCatFilter');if(s3){s3.textContent='';var o0=document.createElement('option');o0.value='all';o0.textContent='全部';s3.appendChild(o0);REMINDER_CATS.forEach(function(c){var o=document.createElement('option');o.value=c.key;o.textContent=c.label;s3.appendChild(o);});}
  }

  function renderReminderCatTabs(){
    var box=byId('reminderCatTabs');if(!box)return;box.textContent='';
    function mk(k,l){var b=document.createElement('button');b.type='button';b.className='reminder-cat-tab'+(reminderState.filter.cat===k?' active':'');b.textContent=l;b.addEventListener('click',function(){reminderState.filter.cat=k;renderReminderCatTabs();renderReminderList();});box.appendChild(b);}
    mk('all','全部');REMINDER_CATS.forEach(function(c){mk(c.key,c.label);});
  }

  function renderReminderList(){
    var tbody=byId('reminderTbody');if(!tbody)return;tbody.textContent='';
    var f=reminderState.filter;var list=reminderState.list.slice();
    if(f.cat&&f.cat!=='all')list=list.filter(function(r){return r.category===f.cat;});
    if(f.search){var kw=f.search.toLowerCase();list=list.filter(function(r){return String(r.name||'').toLowerCase().indexOf(kw)!==-1;});}
    list.sort(function(a,b){
      var va,vb;
      if(f.sort==='name'){va=String(a.name||'');vb=String(b.name||'');return f.dir==='asc'?va.localeCompare(vb,'zh'):vb.localeCompare(va,'zh');}
      if(f.sort==='created'){va=new Date(a.createdAt||0).getTime();vb=new Date(b.createdAt||0).getTime();}
      else{var na=computeNextAt(a),nb=computeNextAt(b);va=na?na.getTime():Infinity;vb=nb?nb.getTime():Infinity;}
      return f.dir==='asc'?va-vb:vb-va;
    });
    if(list.length===0){var tr0=document.createElement('tr');var td0=document.createElement('td');td0.colSpan=7;td0.className='reminder-empty';td0.textContent='暂无提醒事项';tr0.appendChild(td0);tbody.appendChild(tr0);return;}
    list.forEach(function(r){
      var next=computeNextAt(r);var rem=next?(next.getTime()-Date.now()):0;
      var tr=document.createElement('tr');
      var td1=document.createElement('td');td1.textContent=r.name||'未命名';tr.appendChild(td1);
      var td2=document.createElement('td');var sp=document.createElement('span');sp.className='reminder-cat-badge cat-'+(r.category||'work');sp.textContent=catLabel(r.category);td2.appendChild(sp);tr.appendChild(td2);
      var td3=document.createElement('td');td3.textContent=repeatLabel(r.repeat);tr.appendChild(td3);
      var td4=document.createElement('td');td4.textContent=r.emailNotify?'邮件':'—';tr.appendChild(td4);
      var td5=document.createElement('td');td5.className='reminder-remaining';td5.textContent=formatRemaining(rem);tr.appendChild(td5);
      var td6=document.createElement('td');td6.textContent=formatDateTime(next);tr.appendChild(td6);
      var td7=document.createElement('td');
      var pb=document.createElement('button');pb.type='button';pb.className='btn btn-small btn-ghost';pb.textContent=r.pinned?'取消前台':'前台显示';
      pb.addEventListener('click',function(){r.pinned=!r.pinned;saveReminders();renderReminderList();renderDashboard();});
      td7.appendChild(pb);
      var db=document.createElement('button');db.type='button';db.className='btn btn-small btn-danger';db.textContent='删除';db.style.marginLeft='6px';
      db.addEventListener('click',function(){askConfirm({title:'删除提醒',message:'确认删除「'+(r.name||'')+'」吗？',confirmText:'确认删除'}).then(function(ok){if(!ok)return;reminderState.list=reminderState.list.filter(function(x){return x.id!==r.id;});saveReminders();renderReminderList();renderDashboard();notify('success','已删除。',4000);});});
      td7.appendChild(db);tr.appendChild(td7);tbody.appendChild(tr);
    });
  }

  function renderPinnedReminders(){
    var box=byId('pinnedRemindersList'),sec=byId('pinnedRemindersSection');if(!box||!sec)return;
    var list=reminderState.list.filter(function(r){return r.pinned;});
    box.textContent='';
    if(list.length===0){sec.style.display='none';return;}
    sec.style.display='';
    list.forEach(function(r){
      var next=computeNextAt(r);var card=document.createElement('div');card.className='pinned-reminder-card';
      var nm=document.createElement('span');nm.className='pinned-reminder-name';nm.textContent='⏰ '+(r.name||'');card.appendChild(nm);
      var tt=document.createElement('span');tt.className='pinned-reminder-time';tt.textContent=formatDateTime(next)+' · '+formatRemaining(next?(next.getTime()-Date.now()):0);card.appendChild(tt);
      box.appendChild(card);
    });
  }

  function openReminderModal(){
    var r=reminderState.editing;
    byId('reminderModalTitle').textContent=r?'编辑倒计时':'新增倒计时';
    byId('reminderName').value=r?(r.name||''):'';
    byId('reminderDate').value=r?(r.date||''):'';
    byId('reminderTime').value=r?(r.time||''):'';
    byId('reminderCat').value=r?(r.category||'work'):'work';
    byId('reminderRepeat').value=r?(r.repeat||'once'):'once';
    byId('reminderEmail').checked=r?!!r.emailNotify:false;
    byId('reminderError').classList.add('hidden');byId('reminderError').textContent='';
    showModal('reminderModal');byId('reminderName').focus();
  }

  function saveReminderFromModal(){
    var name=String(byId('reminderName').value||'').trim();
    var date=String(byId('reminderDate').value||'');
    var time=String(byId('reminderTime').value||'');
    var cat=String(byId('reminderCat').value||'work');
    var rep=String(byId('reminderRepeat').value||'once');
    var email=!!byId('reminderEmail').checked;
    var errEl=byId('reminderError');errEl.classList.add('hidden');errEl.textContent='';
    if(!name){errEl.textContent='名称不能为空。';errEl.classList.remove('hidden');return;}
    if(!date){errEl.textContent='请选择日期。';errEl.classList.remove('hidden');return;}
    if(!time){errEl.textContent='请选择时间。';errEl.classList.remove('hidden');return;}
    if(reminderState.editing){
      var t=reminderState.list.find(function(x){return x.id===reminderState.editing.id;});
      if(t){t.name=name;t.date=date;t.time=time;t.category=cat;t.repeat=rep;t.emailNotify=email;}
    }else{
      reminderState.list.push({id:newId('reminder'),name:name,date:date,time:time,category:cat,repeat:rep,emailNotify:email,pinned:false,createdAt:new Date().toISOString()});
    }
    saveReminders();hideModal('reminderModal');reminderState.editing=null;
    renderReminderList();renderDashboard();notify('success','已保存。',4000);
  }

  function checkDueReminders(){
    var now=Date.now();
    reminderState.list.forEach(function(r){
      var next=computeNextAt(r);if(!next)return;
      var diff=next.getTime()-now;var key=r.id+'_'+next.getTime();
      if(diff<=0&&diff>-60000&&!reminderState.notified[key]){
        reminderState.notified[key]=true;
        notify('warn','⏰ 提醒：'+(r.name||'')+'（'+catLabel(r.category)+'）',20000);
      }
    });
  }
  /* ================= 天气 ================= */
  var WEATHER_KEY_EXTRA = 'cloudNotes.weather.extraCity';
  var WEATHER_KEY_AUTO = 'cloudNotes.weather.autoCity';
  var WEATHER_REFRESH_INTERVAL = 60 * 60 * 1000; // 1 小时

  var weatherState = {
    autoCity: null,
    extraCity: null,
    data: { auto: null, extra: null },
    lastUpdated: 0,
    loading: false
  };

  var WEATHER_CODE_MAP = {
    0:{icon:'☀️',label:'晴'},1:{icon:'🌤️',label:'基本晴'},2:{icon:'⛅',label:'多云'},3:{icon:'☁️',label:'阴'},
    45:{icon:'🌫️',label:'雾'},48:{icon:'🌫️',label:'霜雾'},
    51:{icon:'🌦️',label:'小毛毛雨'},53:{icon:'🌦️',label:'毛毛雨'},55:{icon:'🌧️',label:'大毛毛雨'},
    56:{icon:'🌧️',label:'冻毛毛雨'},57:{icon:'🌧️',label:'冻毛毛雨'},
    61:{icon:'🌧️',label:'小雨'},63:{icon:'🌧️',label:'中雨'},65:{icon:'🌧️',label:'大雨'},
    66:{icon:'🌧️',label:'冻雨'},67:{icon:'🌧️',label:'冻雨'},
    71:{icon:'🌨️',label:'小雪'},73:{icon:'🌨️',label:'中雪'},75:{icon:'❄️',label:'大雪'},77:{icon:'❄️',label:'雪粒'},
    80:{icon:'🌦️',label:'阵雨'},81:{icon:'🌧️',label:'中阵雨'},82:{icon:'⛈️',label:'强阵雨'},
    85:{icon:'🌨️',label:'阵雪'},86:{icon:'❄️',label:'强阵雪'},
    95:{icon:'⛈️',label:'雷暴'},96:{icon:'⛈️',label:'雷暴冰雹'},99:{icon:'⛈️',label:'强雷暴冰雹'}
  };
  function wIcon(code){var m=WEATHER_CODE_MAP[code];return m?m.icon:'❓';}
  function wLabel(code){var m=WEATHER_CODE_MAP[code];return m?m.label:'未知';}

  function loadWeatherFromStorage(){
    try{var s1=localStorage.getItem(WEATHER_KEY_EXTRA);if(s1)weatherState.extraCity=JSON.parse(s1);}catch(e){}
    try{
      var s2=localStorage.getItem(WEATHER_KEY_AUTO);
      if(s2){var c=JSON.parse(s2);if(c&&c.timestamp&&(Date.now()-c.timestamp<7*24*60*60*1000))weatherState.autoCity=c;}
    }catch(e){}
  }
  function saveWeatherExtraCity(city){
    weatherState.extraCity=city;
    try{if(city)localStorage.setItem(WEATHER_KEY_EXTRA,JSON.stringify(city));else localStorage.removeItem(WEATHER_KEY_EXTRA);}catch(e){}
  }
  function saveWeatherAutoCity(city){
    weatherState.autoCity=city?Object.assign({},city,{timestamp:Date.now()}):null;
    try{if(weatherState.autoCity)localStorage.setItem(WEATHER_KEY_AUTO,JSON.stringify(weatherState.autoCity));else localStorage.removeItem(WEATHER_KEY_AUTO);}catch(e){}
  }

  function fetchGeocode(name){
    var url='https://geocoding-api.open-meteo.com/v1/search?name='+encodeURIComponent(name)+'&count=8&language=zh&format=json';
    return fetch(url,{cache:'no-store'}).then(function(r){
      if(!r.ok)throw new Error('城市搜索失败（'+r.status+'）');
      return r.json();
    }).then(function(data){
      if(!data||!Array.isArray(data.results))return [];
      return data.results.map(function(r){
        return {name:r.name+(r.admin1?'，'+r.admin1:'')+(r.country?'（'+r.country+'）':''),shortName:r.name,latitude:r.latitude,longitude:r.longitude};
      });
    });
  }

  function fetchReverseGeocode(lat,lon){
    var url='https://api.bigdatacloud.net/data/reverse-geocode-client?latitude='+lat+'&longitude='+lon+'&localityLanguage=zh';
    return fetch(url,{cache:'no-store'}).then(function(r){
      if(!r.ok)throw new Error('反查定位失败');
      return r.json();
    }).then(function(d){
      var n=d.city||d.locality||d.principalSubdivision||'当前位置';
      return {name:n,latitude:lat,longitude:lon};
    }).catch(function(){return {name:'当前位置',latitude:lat,longitude:lon};});
  }

  function fetchWeather(lat,lon){
    var url='https://api.open-meteo.com/v1/forecast?latitude='+lat+'&longitude='+lon+'&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=7';
    return fetch(url,{cache:'no-store'}).then(function(r){
      if(!r.ok)throw new Error('天气查询失败（'+r.status+'）');
      return r.json();
    }).then(function(data){
      if(!data||!data.daily)throw new Error('天气数据格式不正确');
      var out=[];
      for(var i=0;i<data.daily.time.length&&i<7;i++){
        out.push({date:data.daily.time[i],code:data.daily.weather_code[i],tMax:data.daily.temperature_2m_max[i],tMin:data.daily.temperature_2m_min[i]});
      }
      return out;
    });
  }

  function locateAutoCity(){
    return new Promise(function(resolve){
      // 兜底：如果 10 秒内定位不成功，直接返回北京
      var finished=false;
      function fallback(){
        if(finished)return;
        finished=true;
        resolve({name:'北京',shortName:'北京',latitude:39.9042,longitude:116.4074,fallback:true});
      }
      var timer=setTimeout(fallback,10000);

      if(!navigator.geolocation){fallback();return;}
      navigator.geolocation.getCurrentPosition(function(pos){
        if(finished)return;
        fetchReverseGeocode(pos.coords.latitude,pos.coords.longitude)
          .then(function(city){
            if(finished)return;
            finished=true;clearTimeout(timer);
            resolve(city);
          })
          .catch(function(){
            if(finished)return;
            finished=true;clearTimeout(timer);
            // 反向地理编码失败，直接用坐标配一个"当前位置"
            resolve({name:'当前位置',shortName:'当前位置',latitude:pos.coords.latitude,longitude:pos.coords.longitude});
          });
      },function(){
        if(finished)return;
        fallback();
      },{timeout:8000,maximumAge:3600000});
    });
  }

  function buildWeatherCard(city,days,tag){
    var card=document.createElement('div');card.className='weather-city-card';
    var header=document.createElement('div');header.className='weather-city-name';
    var nameSpan=document.createElement('span');nameSpan.textContent=city?city.name:'（未设置）';header.appendChild(nameSpan);
    var tagSpan=document.createElement('span');tagSpan.className='city-tag';tagSpan.textContent=tag;header.appendChild(tagSpan);
    card.appendChild(header);
    if(!days||days.length===0){
      var emp=document.createElement('div');emp.className='weather-city-empty';
      emp.textContent=city?'暂无数据':'等待设置…';
      card.appendChild(emp);return card;
    }
    var grid=document.createElement('div');grid.className='weather-days';
    var wk=['日','一','二','三','四','五','六'];
    days.forEach(function(d){
      var dt=new Date(d.date+'T00:00:00');
      var day=document.createElement('div');day.className='weather-day';
      var dL=document.createElement('div');dL.className='wd-date';
      dL.textContent=(dt.getMonth()+1)+'/'+dt.getDate()+' 周'+wk[dt.getDay()];day.appendChild(dL);
      var iL=document.createElement('div');iL.className='wd-icon';iL.textContent=wIcon(d.code);iL.title=wLabel(d.code);day.appendChild(iL);
      var tL=document.createElement('div');tL.className='wd-temp';
      var tMax=document.createElement('span');tMax.textContent=Math.round(d.tMax)+'°';tL.appendChild(tMax);
      var tMin=document.createElement('span');tMin.className='wd-temp-min';tMin.textContent='/'+Math.round(d.tMin)+'°';tL.appendChild(tMin);
      day.appendChild(tL);grid.appendChild(day);
    });
    card.appendChild(grid);return card;
  }

  function renderWeather(){
    var grid=byId('weatherGrid');if(!grid)return;
    grid.textContent='';
    grid.appendChild(buildWeatherCard(weatherState.autoCity,weatherState.data.auto,'定位'));
    grid.appendChild(buildWeatherCard(weatherState.extraCity,weatherState.data.extra,'额外'));
    var upd=byId('weatherUpdatedAt');
    if(upd){
      if(weatherState.lastUpdated)upd.textContent='更新于 '+formatTime(new Date(weatherState.lastUpdated).toISOString());
      else upd.textContent='';
    }
  }

  function loadAllWeather(force){
    if(weatherState.loading)return Promise.resolve();
    var now=Date.now();
    if(!force&&weatherState.lastUpdated&&(now-weatherState.lastUpdated<WEATHER_REFRESH_INTERVAL)){renderWeather();return Promise.resolve();}
    weatherState.loading=true;
    renderWeather(); // 先渲染一次（可能已有缓存城市）

    function ensureAutoCity(){
      if(weatherState.autoCity)return Promise.resolve(weatherState.autoCity);
      return locateAutoCity().then(function(city){
        saveWeatherAutoCity(city);
        // 立刻重绘，让城市名先显示出来
        renderWeather();
        return city;
      });
    }

    return ensureAutoCity().then(function(city){
      return fetchWeather(city.latitude,city.longitude).then(function(d){
        weatherState.data.auto=d;
      }).catch(function(e){
        console.warn('定位天气失败：',e);
      });
    }).catch(function(e){
      console.warn('定位失败：',e);
    }).then(function(){
      if(!weatherState.extraCity)return;
      return fetchWeather(weatherState.extraCity.latitude,weatherState.extraCity.longitude).then(function(d){
        weatherState.data.extra=d;
      }).catch(function(e){
        console.warn('额外城市天气失败：',e);
      });
    }).then(function(){
      weatherState.lastUpdated=Date.now();
      weatherState.loading=false;
      renderWeather();
    }).catch(function(e){
      weatherState.loading=false;
      console.warn('天气加载出错：',e);
      renderWeather();
    });
  }

  function openWeatherCityModal(){
    if(!state.editing){notify('warn','请先进入编辑模式。',5000);return;}
    byId('weatherCityInput').value=weatherState.extraCity?(weatherState.extraCity.shortName||weatherState.extraCity.name):'';
    byId('weatherCityResults').textContent='';
    var autoIn=byId('weatherAutoCityInput');
    if(autoIn)autoIn.value=weatherState.autoCity?(weatherState.autoCity.shortName||weatherState.autoCity.name):'';
    var autoRes=byId('weatherAutoCityResults');
    if(autoRes)autoRes.textContent='';
    byId('weatherCityError').classList.add('hidden');byId('weatherCityError').textContent='';
    showModal('weatherCityModal');byId('weatherCityInput').focus();
  }

  function searchWeatherCity(){
    var q=String(byId('weatherCityInput').value||'').trim();
    var box=byId('weatherCityResults'),errEl=byId('weatherCityError');
    errEl.classList.add('hidden');errEl.textContent='';box.textContent='';
    if(!q){errEl.textContent='请输入城市名称。';errEl.classList.remove('hidden');return;}
    var tip=notify('info','正在搜索…',0);
    fetchGeocode(q).then(function(list){
      tip.remove();
      if(list.length===0){errEl.textContent='未找到该城市，请换个名称试试。';errEl.classList.remove('hidden');return;}
      list.forEach(function(r){
        var btn=document.createElement('button');btn.type='button';btn.className='weather-city-result';btn.textContent=r.name;
        btn.addEventListener('click',function(){
          saveWeatherExtraCity({name:r.name,shortName:r.shortName,latitude:r.latitude,longitude:r.longitude});
          hideModal('weatherCityModal');
          weatherState.data.extra=null;weatherState.lastUpdated=0;
          notify('success','已设置额外城市：'+r.name,5000);
          loadAllWeather(true);
        });
        box.appendChild(btn);
      });
    }).catch(function(e){
      tip.remove();
      errEl.textContent=(e&&e.message)||'搜索失败。';errEl.classList.remove('hidden');
    });
  }

  /* ================= 富文本内容处理 ================= */
  function looksLikeHtml(s){
    return /<(b|strong|i|em|u|s|strike|del|br|p|div|span|img)\b/i.test(String(s||''));
  }

  function sanitizeHtml(html){
    if(!html)return '';
    var d=document.createElement('div');
    d.innerHTML=String(html);
    // 递归清理
    function walk(node){
      var children=Array.prototype.slice.call(node.childNodes);
      children.forEach(function(ch){
        if(ch.nodeType===3)return; // 文本
        if(ch.nodeType!==1){node.removeChild(ch);return;}
        var tag=ch.tagName.toUpperCase();
        if(!ALLOWED_TAGS[tag]){ // 不允许的标签：把子节点提升
          while(ch.firstChild)node.insertBefore(ch.firstChild,ch);
          node.removeChild(ch);
          return;
        }
        // 清理属性
        var attrs=Array.prototype.slice.call(ch.attributes);
        attrs.forEach(function(a){
          var an=a.name.toLowerCase();
          if(tag==='IMG'&&(an==='src'||an==='alt'||an==='data-img-id'))return;
          if(tag==='SPAN'&&an==='style')return;
          if(tag==='MARK'&&an==='style')return;
          if((tag==='TH'||tag==='TD')&&(an==='colspan'||an==='rowspan'))return;
          ch.removeAttribute(a.name);
        });
        // 过滤 style 只保留 color/background-color
        if(tag==='SPAN'){
          var st=ch.getAttribute('style')||'';
          var parts=st.split(';');
          var ok=[];
          parts.forEach(function(p){
            var idx=p.indexOf(':');
            if(idx<=0)return;
            var k=p.slice(0,idx).trim().toLowerCase();
            var v=p.slice(idx+1).trim();
            if((k==='color'||k==='background-color')&&v&&v.indexOf('url(')===-1&&v.indexOf('expression')===-1&&v.indexOf('javascript')===-1)ok.push(k+':'+v);
          });
          if(ok.length)ch.setAttribute('style',ok.join(';'));
          else ch.removeAttribute('style');
        }
        walk(ch);
      });
    }
    walk(d);
    return d.innerHTML;
  }

  /* 把 content 渲染到容器（支持 HTML 子集，图片 ID 替换为真实图片） */
  function renderContent(container,content,images,keyword){
    container.textContent='';
    var imageMap={};
    (images||[]).forEach(function(img){imageMap[img.id]=img;});
    if(!content){
      var p=document.createElement('p');p.style.color='var(--text-muted)';p.style.fontStyle='italic';p.textContent='（无正文）';
      container.appendChild(p);return;
    }
    if(looksLikeHtml(content)){
      // 用临时 div 解析 HTML，然后遍历，把 img 占位替换为真实图片
      var tmp=document.createElement('div');
      tmp.innerHTML=sanitizeHtml(content);
      // 遍历，把 src 为 [[img:ID]] 的 img 处理
      var imgs=tmp.querySelectorAll('img');
      Array.prototype.forEach.call(imgs,function(im){
        var src=im.getAttribute('src')||'';
        var m=/^\[\[img:([a-zA-Z0-9_-]+)\]\]$/.exec(src);
        if(m){
          var real=imageMap[m[1]];
          if(real){im.setAttribute('src',assetUrl(real.path));im.setAttribute('alt',real.description||real.originalName||'');}
          else{var sp=document.createElement('span');sp.className='missing-image';sp.textContent='[图片未找到：'+m[1]+']';im.parentNode.replaceChild(sp,im);}
        }
      });
      // 把 tmp 的孩子搬到 container
      while(tmp.firstChild)container.appendChild(tmp.firstChild);
      if(keyword){
        // 简单高亮：对文本节点做替换
        (function walkHl(node){
          var kids=Array.prototype.slice.call(node.childNodes);
          kids.forEach(function(k){
            if(k.nodeType===3){
              var txt=k.textContent;
              if(txt&&txt.toLowerCase().indexOf(keyword)!==-1){
                var frag=document.createDocumentFragment();
                var ls=txt.toLowerCase(),lk=keyword;
                var idx=0,pos=ls.indexOf(lk,idx),g=0;
                while(pos!==-1&&g<500){g++;
                  if(pos>idx)frag.appendChild(document.createTextNode(txt.slice(idx,pos)));
                  var mEl=document.createElement('mark');mEl.className='hl';mEl.textContent=txt.slice(pos,pos+lk.length);frag.appendChild(mEl);
                  idx=pos+lk.length;pos=ls.indexOf(lk,idx);
                }
                if(idx<txt.length)frag.appendChild(document.createTextNode(txt.slice(idx)));
                node.replaceChild(frag,k);
              }
            }else if(k.nodeType===1&&k.tagName!=='MARK')walkHl(k);
          });
        })(container);
      }
    }else{
      // 纯文本：按换行分段渲染
      var lines=String(content).split(/\n/);
      lines.forEach(function(line){
        var p=document.createElement('p');
        if(keyword)setHighlightedText(p,line,keyword);
        else p.textContent=line;
        container.appendChild(p);
      });
    }
  }

  function setHighlightedText(el,text,keyword){
    el.textContent='';
    var src=String(text===undefined||text===null?'':text);
    var kw=String(keyword||'');
    if(!kw){el.appendChild(document.createTextNode(src));return;}
    var ls=src.toLowerCase(),lk=kw.toLowerCase();
    var idx=0,pos=ls.indexOf(lk,idx),g=0;
    while(pos!==-1&&g<2000){g++;
      if(pos>idx)el.appendChild(document.createTextNode(src.slice(idx,pos)));
      var m=document.createElement('mark');m.className='hl';m.textContent=src.slice(pos,pos+lk.length);el.appendChild(m);
      idx=pos+lk.length;pos=ls.indexOf(lk,idx);
    }
    if(idx<src.length)el.appendChild(document.createTextNode(src.slice(idx)));
  }

  /* ================= 目录/笔记数据结构 ================= */
  function isLevel1(cat){return !cat.parentId;}
  function getLevel1(){if(!state.data)return [];var l=state.data.categories.filter(isLevel1);l.sort(function(a,b){var ma=a.marked?1:0,mb=b.marked?1:0;if(ma!==mb)return mb-ma;return (new Date(b.updatedAt||0).getTime()||0)-(new Date(a.updatedAt||0).getTime()||0);});return l;}
  function getChildren(pid){if(!state.data)return [];var l=state.data.categories.filter(function(c){return c.parentId===pid;});l.sort(function(a,b){return (new Date(b.updatedAt||0).getTime()||0)-(new Date(a.updatedAt||0).getTime()||0);});return l;}
  function getSortedNotes(cid){if(!state.data)return [];var l=state.data.notes.filter(function(n){return n.categoryId===cid;});l.sort(function(a,b){var ma=a.marked?1:0,mb=b.marked?1:0;if(ma!==mb)return mb-ma;return (new Date(b.updatedAt||0).getTime()||0)-(new Date(a.updatedAt||0).getTime()||0);});return l;}
  function getCategory(id){if(!state.data)return null;return state.data.categories.find(function(c){return c.id===id;})||null;}
  function noteMatches(note,keyword){
    if(!keyword)return false;
    if(String(note.title||'').toLowerCase().indexOf(keyword)!==-1)return true;
    var plain=String(note.content||'').replace(/<[^>]+>/g,'').toLowerCase();
    if(plain.indexOf(keyword)!==-1)return true;
    var hit=false;
    (note.images||[]).forEach(function(i){if(String(i.originalName||'').toLowerCase().indexOf(keyword)!==-1)hit=true;if(String(i.description||'').toLowerCase().indexOf(keyword)!==-1)hit=true;});
    (note.attachments||[]).forEach(function(f){if(String(f.originalName||'').toLowerCase().indexOf(keyword)!==-1)hit=true;});
    return hit;
  }

  function isCatCollapsed(cat){if(Object.prototype.hasOwnProperty.call(state.collapsedCategories,cat.id))return !!state.collapsedCategories[cat.id];return !!cat.collapsed;}
  function isNoteCollapsed(note){if(Object.prototype.hasOwnProperty.call(state.collapsedNotes,note.id))return !!state.collapsedNotes[note.id];return !!note.collapsed;}

  /* ================= 侧边栏渲染 ================= */
  function renderSidebar(){
    var container=byId('categoryNav');if(!container)return;container.textContent='';
    if(state.batchMode)container.classList.add('batch-mode');
    else container.classList.remove('batch-mode');
    if(!state.data){var p=document.createElement('p');p.className='empty-hint';p.textContent='加载中...';container.appendChild(p);return;}
    var keyword=String(state.searchKeyword||'').trim().toLowerCase();
    var level1s=getLevel1();
    if(level1s.length===0){var p2=document.createElement('p');p2.className='empty-hint';p2.textContent=keyword?'未找到匹配':'暂无目录';container.appendChild(p2);return;}

    function buildNoteList(notes,kw){
      var ul=document.createElement('ul');ul.className='cat-nav-notes';
      if(notes.length===0){var li0=document.createElement('li');li0.className='empty-hint';li0.style.fontSize='0.8rem';li0.style.padding='4px 12px';li0.textContent='（无笔记）';ul.appendChild(li0);}
      else notes.forEach(function(note){
        var li=document.createElement('li');
        var a=document.createElement('a');
        a.className='cat-nav-link'+(state.currentView==='note'&&state.currentNoteId===note.id?' active':'');
        a.href='#';
        setHighlightedText(a,note.title,kw);
        if(note.marked)a.textContent=a.textContent+' ⭐';
        a.addEventListener('click',function(e){e.preventDefault();if(state.batchMode)return;state.currentView='note';state.currentNoteId=note.id;render();});
        if(state.batchMode){
          var cb=document.createElement('input');cb.type='checkbox';cb.className='batch-checkbox';cb.checked=!!state.batchSelected['note:'+note.id];
          cb.addEventListener('click',function(e){e.stopPropagation();state.batchSelected['note:'+note.id]=cb.checked;updateBatchBar();});
          li.appendChild(cb);
        }
        li.appendChild(a);ul.appendChild(li);
      });
      return ul;
    }

    level1s.forEach(function(cat){
      var children=getChildren(cat.id);
      var l1Notes=getSortedNotes(cat.id);
      var total=l1Notes.length;
      children.forEach(function(ch){total+=getSortedNotes(ch.id).length;});
      if(keyword){
        var has=(String(cat.name||'').toLowerCase().indexOf(keyword)!==-1)||
          children.some(function(ch){return String(ch.name||'').toLowerCase().indexOf(keyword)!==-1;})||
          l1Notes.some(function(n){return noteMatches(n,keyword);})||
          children.some(function(ch){return getSortedNotes(ch.id).some(function(n){return noteMatches(n,keyword);});});
        if(!has)return;
      }
      var collapsed=isCatCollapsed(cat);
      var item=document.createElement('div');item.className='cat-nav-item';
      var head=document.createElement('div');head.className='cat-nav-head level-1';
      if(state.batchMode){
        var cb1=document.createElement('input');cb1.type='checkbox';cb1.className='batch-checkbox';cb1.checked=!!state.batchSelected['cat:'+cat.id];
        cb1.addEventListener('click',function(e){e.stopPropagation();state.batchSelected['cat:'+cat.id]=cb1.checked;updateBatchBar();});
        head.appendChild(cb1);
      }
      head.addEventListener('click',function(e){if(e.target.tagName==='INPUT')return;state.collapsedCategories[cat.id]=!isCatCollapsed(cat);renderSidebar();});
      var tog=document.createElement('span');tog.textContent=collapsed?'▶':'▼';tog.style.fontSize='0.7rem';tog.style.width='12px';head.appendChild(tog);
      var nm=document.createElement('span');nm.className='cat-nav-name';setHighlightedText(nm,cat.name,keyword);head.appendChild(nm);
      var ct=document.createElement('span');ct.className='cat-nav-count';ct.textContent=String(total);head.appendChild(ct);
      item.appendChild(head);

      if(!collapsed){
        var visL1=keyword?l1Notes.filter(function(n){return noteMatches(n,keyword);}):l1Notes;
        if(visL1.length>0){var wrap=document.createElement('div');wrap.className='cat-nav-l1-notes';wrap.appendChild(buildNoteList(visL1,keyword));item.appendChild(wrap);}
        children.forEach(function(child){
          var cNotes=getSortedNotes(child.id);
          if(keyword){
            var cm=(String(child.name||'').toLowerCase().indexOf(keyword)!==-1)||cNotes.some(function(n){return noteMatches(n,keyword);});
            if(!cm)return;
          }
          var cc=isCatCollapsed(child);
          var chItem=document.createElement('div');chItem.className='cat-nav-children';
          var chHead=document.createElement('div');chHead.className='cat-nav-head';
          if(state.batchMode){
            var cb2=document.createElement('input');cb2.type='checkbox';cb2.className='batch-checkbox';cb2.checked=!!state.batchSelected['cat:'+child.id];
            cb2.addEventListener('click',function(e){e.stopPropagation();state.batchSelected['cat:'+child.id]=cb2.checked;updateBatchBar();});
            chHead.appendChild(cb2);
          }
          chHead.addEventListener('click',function(e){if(e.target.tagName==='INPUT')return;state.collapsedCategories[child.id]=!isCatCollapsed(child);renderSidebar();});
          var ctog=document.createElement('span');ctog.textContent=cc?'▶':'▼';ctog.style.fontSize='0.7rem';ctog.style.width='12px';chHead.appendChild(ctog);
          var cnm=document.createElement('span');cnm.className='cat-nav-name';setHighlightedText(cnm,child.name,keyword);chHead.appendChild(cnm);
          var cct=document.createElement('span');cct.className='cat-nav-count';cct.textContent=String(cNotes.length);chHead.appendChild(cct);
          chItem.appendChild(chHead);
          if(!cc){
            var vis=keyword?cNotes.filter(function(n){return noteMatches(n,keyword);}):cNotes;
            chItem.appendChild(buildNoteList(vis,keyword));
          }
          item.appendChild(chItem);
        });
      }
      container.appendChild(item);
    });
    updateBatchBar();
  }

  function renderSidebarActive(){
    var map={dashboard:'sideToolDashboard',pomodoro:'sideToolPomodoro',timer:'sideToolTimer'};
    ['sideToolDashboard','sideToolPomodoro','sideToolTimer'].forEach(function(id){var e=byId(id);if(e)e.classList.remove('active');});
    var aid=map[state.currentView];if(aid){var e2=byId(aid);if(e2)e2.classList.add('active');}
  }

  function renderQuickLinks(){
    var g=byId('quickLinksGrid');if(!g)return;g.textContent='';
    var links=CONFIG.QUICK_LINKS||[];
    if(links.length===0){var p=document.createElement('p');p.className='empty-hint';p.textContent='暂无常用链接。';g.appendChild(p);return;}
    links.forEach(function(l){
      var a=document.createElement('a');a.className='quick-link-card';a.href=l.url||'#';a.target='_blank';a.rel='noopener noreferrer';
      var i=document.createElement('div');i.className='quick-link-icon';i.textContent=l.icon||'🔗';a.appendChild(i);
      var n=document.createElement('div');n.className='quick-link-name';n.textContent=l.name||l.url||'';a.appendChild(n);
      g.appendChild(a);
    });
  }

  function renderDashboard(){
    var dv=byId('dashboardView');if(dv)dv.classList.remove('hidden');
    updateClock();
    var h=new Date().getHours();var g='早上好';if(h>=12&&h<18)g='下午好';else if(h>=18)g='晚上好';
    var ge=byId('greetingText');if(ge)ge.textContent=g+'，欢迎回来';
    if(state.data){
      byId('statTotalNotes').textContent=String(state.data.notes.length);
      byId('statMarkedNotes').textContent=String(state.data.notes.filter(function(n){return n.marked;}).length);
      byId('statTotalCategories').textContent=String(state.data.categories.length);
    }
    renderQuickLinks();renderPinnedReminders();
  }

  function renderNoteView(id){
    byId('noteView').classList.remove('hidden');
    var note=state.data.notes.find(function(n){return n.id===id;});
    if(!note){byId('noteViewTitle').textContent='笔记不存在';byId('noteViewContent').textContent='该笔记可能已被删除。';return;}
    var cat=getCategory(note.categoryId);var parent=cat&&cat.parentId?getCategory(cat.parentId):null;
    byId('noteViewTitle').textContent=note.title;
    var path=parent?(parent.name+' / '+cat.name):(cat?cat.name:'未知');
    byId('noteViewMeta').textContent='所属目录：'+path+' · 创建：'+formatTime(note.createdAt)+' · 最后修改：'+formatTime(note.updatedAt)+(note.marked?' · ⭐ 重点笔记':'');
    renderContent(byId('noteViewContent'),note.content,note.images,'');
    var ats=byId('noteViewAttachments');ats.textContent='';
    (note.attachments||[]).forEach(function(f){
      var li=document.createElement('li');
      var a=document.createElement('a');a.href=assetUrl(f.path);a.download=f.originalName;a.target='_blank';a.rel='noopener noreferrer';a.textContent='📎 '+f.originalName;li.appendChild(a);
      var s=document.createElement('span');s.className='file-info';s.textContent='（'+formatSize(f.size)+'）';li.appendChild(s);ats.appendChild(li);
    });
    var mb=byId('btnToggleMarkCurrentNote');if(mb)mb.textContent=note.marked?'取消重点':'设为重点';
  }

  function hideAllViews(){['dashboardView','noteView','pomodoroView','timerView'].forEach(function(id){var e=byId(id);if(e)e.classList.add('hidden');});}

  function render(){
    renderSidebar();renderSidebarActive();hideAllViews();
    if(state.currentView==='dashboard')renderDashboard();
    else if(state.currentView==='note')renderNoteView(state.currentNoteId);
    else if(state.currentView==='pomodoro'){byId('pomodoroView').classList.remove('hidden');updatePomodoroDisplay();}
    else if(state.currentView==='timer'){byId('timerView').classList.remove('hidden');renderReminderCatTabs();renderReminderList();}
  }

  function fillCategorySelect(select,selectedId){
    if(!select)return;select.textContent='';
    var l1s=getLevel1();
    if(l1s.length===0){var o=document.createElement('option');o.value='';o.textContent='（暂无目录）';select.appendChild(o);return;}
    l1s.forEach(function(p){
      var children=getChildren(p.id);
      if(children.length===0){
        var og=document.createElement('option');og.value=p.id;og.textContent='【一级】'+p.name;
        if(p.id===selectedId)og.selected=true;select.appendChild(og);return;
      }
      var grp=document.createElement('optgroup');grp.label='【一级】'+p.name;
      var optP=document.createElement('option');optP.value=p.id;optP.textContent='（直属 '+p.name+'）';
      if(p.id===selectedId)optP.selected=true;grp.appendChild(optP);
      children.forEach(function(ch){var o2=document.createElement('option');o2.value=ch.id;o2.textContent='　'+ch.name;if(ch.id===selectedId)o2.selected=true;grp.appendChild(o2);});
      select.appendChild(grp);
    });
  }

  function loadRemoteData(opts){
    opts=opts||{};if(state.busy)return Promise.resolve();state.busy=true;
    var tip=opts.silent?null:notify('info','正在读取远端数据…',0);
    return fetchRemoteNotes().then(function(r){
      state.data=r.json;state.remoteUpdatedAt=r.json.updatedAt;
      state.collapsedCategories={};state.collapsedNotes={};
      render();if(tip)tip.remove();if(!opts.silent)notify('success','远端数据已加载。',4000);
    }).catch(function(e){if(tip)tip.remove();render();notify('error',(e&&e.message)||'读取失败。',12000);}).then(function(){state.busy=false;});
  }

  function verifyToken(token){
    if(!CONFIG.OWNER||!CONFIG.REPO)return Promise.reject(new AppError('config.js 未配置。',0));
    return ghFetch(apiBase(),{token:token}).then(function(info){
      if(!info||!info.full_name)throw new AppError('无法访问该仓库。',404);
      return fetchRemoteNotes(token).catch(function(e){if(e&&e.status===404)throw new AppError('可访问仓库，但读取 notes.json 失败。',404);throw e;});
    });
  }

  function enterEditMode(){if(state.editing){notify('info','当前已是编辑模式。',4000);return;}byId('tokenInput').value='';byId('tokenError').classList.add('hidden');byId('tokenError').textContent='';showModal('tokenModal');byId('tokenInput').focus();}

  function confirmEnterEditMode(){
    var input=byId('tokenInput'),errEl=byId('tokenError'),btn=byId('btnTokenConfirm');
    var token=String(input.value||'').trim();
    errEl.classList.add('hidden');errEl.textContent='';
    if(!token){errEl.textContent='请输入 Token。';errEl.classList.remove('hidden');return;}
    btn.disabled=true;btn.textContent='正在验证…';
    verifyToken(token).then(function(){
      state.token=token;state.editing=true;
      try{sessionStorage.setItem(TOKEN_STORAGE_KEY,token);}catch(e){}
      input.value='';hideModal('tokenModal');document.body.classList.add('edit-mode');render();
      notify('success','已进入编辑模式。',8000);
      return loadRemoteData({silent:true});
    }).catch(function(e){errEl.textContent=(e&&e.message)||'Token 验证失败。';errEl.classList.remove('hidden');}).then(function(){btn.disabled=false;btn.textContent='进入编辑模式';});
  }

  function exitEditMode(){
    state.token=null;state.editing=false;
    try{sessionStorage.removeItem(TOKEN_STORAGE_KEY);}catch(e){}
    byId('tokenInput').value='';
    editNoteCtx.noteId=null;editNoteCtx.newImages=[];editNoteCtx.files=[];editNoteCtx.removedFiles=[];
    hideModal('editNoteModal');hideModal('tokenModal');
    document.body.classList.remove('edit-mode');state.batchMode=false;state.batchSelected={};
    render();notify('info','已退出编辑模式。',5000);
  }

  /* ================= 编辑笔记 ================= */
  function openEditNote(noteId){
    if(!state.editing)return;
    editNoteCtx.newImages=[];editNoteCtx.files=[];editNoteCtx.removedFiles=[];
    if(noteId){
      var note=state.data.notes.find(function(n){return n.id===noteId;});
      if(!note){notify('error','找不到该笔记。',8000);return;}
      editNoteCtx.noteId=noteId;
      byId('editNoteModalTitle').textContent='编辑笔记';
      byId('editNoteTitle').value=note.title;
      fillCategorySelect(byId('editNoteCategory'),note.categoryId);
      var editor=byId('editNoteContent');
      // 如果 content 是纯文本，则直接设置 textContent；如果是 HTML，清理后设置 innerHTML
      if(looksLikeHtml(note.content)){
        editor.innerHTML=sanitizeHtml(note.content).replace(/src="\[\[img:([a-zA-Z0-9_-]+)\]\]"/g,function(all,id){
          var im=(note.images||[]).find(function(x){return x.id===id;});
          return im?'src="'+assetUrl(im.path)+'" data-img-id="'+id+'"':'src=""';
        });
      }else{
        editor.textContent=note.content||'';
      }
      editNoteCtx.existingImages=(note.images||[]).slice();
      byId('editNoteMarked').checked=!!note.marked;
    }else{
      editNoteCtx.noteId=newId('note');
      byId('editNoteModalTitle').textContent='新增笔记';
      byId('editNoteTitle').value='';
      byId('editNoteContent').textContent='';
      byId('editNoteMarked').checked=false;
      editNoteCtx.existingImages=[];
      fillCategorySelect(byId('editNoteCategory'),'');
    }
    byId('editNoteFiles').value='';
    byId('editNoteError').classList.add('hidden');byId('editNoteError').textContent='';
    renderEditExistingFiles();
    bindEditNotePreviews();
    showModal('editNoteModal');byId('editNoteTitle').focus();
  }

  function renderEditExistingFiles(){
    var box=byId('editNoteExistingFiles');box.textContent='';
    if(!editNoteCtx.noteId)return;
    var note=state.data?state.data.notes.find(function(n){return n.id===editNoteCtx.noteId;}):null;
    if(!note)return;
    var files=(note.attachments||[]).filter(function(f){return editNoteCtx.removedFiles.indexOf(f.id)===-1;});
    if(files.length===0){var p=document.createElement('p');p.className='empty-hint';p.textContent='暂无附件';box.appendChild(p);return;}
    files.forEach(function(f){
      var row=document.createElement('div');row.className='pending-item';
      var nm=document.createElement('span');nm.className='pending-name';nm.textContent=(f.originalName||'')+'（'+formatSize(f.size)+'）';row.appendChild(nm);
      var d=document.createElement('button');d.type='button';d.className='btn btn-small btn-danger';d.textContent='删除';
      d.addEventListener('click',function(){askConfirm({title:'删除附件',message:'确认删除附件「'+(f.originalName||'')+'」吗？',confirmText:'标记删除'}).then(function(ok){if(!ok)return;editNoteCtx.removedFiles.push(f.id);renderEditExistingFiles();});});
      row.appendChild(d);box.appendChild(row);
    });
  }

  function renderPendingList(box,items,kind,onRemove){
    if(!box)return;box.textContent='';
    items.forEach(function(it){
      var row=document.createElement('div');row.className='pending-item';
      var nm=document.createElement('span');nm.className='pending-name';nm.textContent=it.file.name+'（'+formatSize(it.file.size)+'）';row.appendChild(nm);
      var st=document.createElement('span');st.className='pending-status status-'+it.status;st.textContent=it.statusText;row.appendChild(st);it.statusEl=st;
      var d=document.createElement('button');d.type='button';d.className='btn btn-small btn-danger';d.textContent='移除';
      d.addEventListener('click',function(){onRemove(it);});row.appendChild(d);box.appendChild(row);
    });
  }

  function updateStatus(it,st){it.status=st;it.statusText=st==='uploading'?'正在上传':st==='done'?'上传成功':st==='error'?'上传失败':'等待上传';if(it.statusEl){it.statusEl.className='pending-status status-'+it.status;it.statusEl.textContent=it.statusText;}}

  function bindEditNotePreviews(){
    renderPendingList(byId('editNoteFilePreview'),editNoteCtx.files,'file',function(it){var i=editNoteCtx.files.indexOf(it);if(i!==-1)editNoteCtx.files.splice(i,1);bindEditNotePreviews();});
  }

  function handleEditNoteFileSelect(files){
    var probs=[];
    Array.prototype.forEach.call(files,function(f){
      var e=validateAttachmentFile(f);if(e){probs.push(f.name+'：'+e);return;}
      editNoteCtx.files.push({id:newId('file'),file:f,status:'waiting',statusText:'等待上传'});
    });
    if(probs.length)notify('error','以下附件未通过校验：\n'+probs.join('\n'),12000);
    bindEditNotePreviews();
  }

  /* 插入图片到 contenteditable */
  function insertImageAtCursor(){
    if(!editNoteCtx.noteId){notify('error','请先填写笔记标题并选择目录。',6000);return;}
    byId('editNoteImageInput').value='';
    byId('editNoteImageInput').click();
  }

  function handleInsertImageFile(file){
    var e=validateImageFile(file);
    if(e){notify('error',file.name+'：'+e,8000);return;}
    var working=notify('info','正在上传图片到 GitHub…',0);
    var noteId=editNoteCtx.noteId;var id=newId('image');
    uploadAttachment('image',noteId,{id:id,file:file}).then(function(meta){
      working.remove();
      editNoteCtx.newImages=editNoteCtx.newImages||[];editNoteCtx.newImages.push(meta);
      var editor=byId('editNoteContent');
      var img=document.createElement('img');img.src=assetUrl(meta.path);img.alt=meta.originalName||'';img.setAttribute('data-img-id',meta.id);img.style.maxWidth='100%';
      editor.focus();
      var sel=window.getSelection();
      if(sel&&sel.rangeCount){
        var range=sel.getRangeAt(0);range.deleteContents();range.insertNode(img);
        range.collapse(false);
      }else{editor.appendChild(img);}
      notify('success','图片已上传并插入到光标处。',6000);
    }).catch(function(e){working.remove();notify('error','图片上传失败：'+((e&&e.message)||''),10000);});
  }

  /* 从编辑器读出 content：把 img 替换为占位标记 src="[[img:ID]]" */
  function extractEditorHtml(){
    var editor=byId('editNoteContent');
    var clone=editor.cloneNode(true);
    var imgs=clone.querySelectorAll('img');
    Array.prototype.forEach.call(imgs,function(im){
      var id=im.getAttribute('data-img-id');
      if(!id){
        // 尝试从 src 反推
        var src=im.getAttribute('src')||'';
        var all=(editNoteCtx.existingImages||[]).concat(editNoteCtx.newImages||[]);
        var found=all.find(function(x){return assetUrl(x.path)===src;});
        if(found)id=found.id;
      }
      if(id)im.setAttribute('src','[[img:'+id+']]');
    });
    return sanitizeHtml(clone.innerHTML);
  }

  function closeEditNoteModal(){
    editNoteCtx.noteId=null;editNoteCtx.newImages=[];editNoteCtx.files=[];editNoteCtx.removedFiles=[];
    hideModal('editNoteModal');
  }

  function saveEditNote(){
    if(!state.editing)return;
    var isNew=!state.data.notes.some(function(n){return n.id===editNoteCtx.noteId;});
    var noteId=editNoteCtx.noteId;
    var title=String(byId('editNoteTitle').value||'').trim();
    var content=extractEditorHtml();
    var marked=!!byId('editNoteMarked').checked;
    var categoryId=String(byId('editNoteCategory').value||'');
    var saveBtn=byId('btnSaveEditNote'),errEl=byId('editNoteError');
    errEl.classList.add('hidden');errEl.textContent='';
    if(!title){errEl.textContent='笔记标题必须填写。';errEl.classList.remove('hidden');return;}
    if(!categoryId){errEl.textContent='请选择所属目录。';errEl.classList.remove('hidden');return;}
    var note=isNew?null:state.data.notes.find(function(n){return n.id===noteId;});
    var keptFiles=note?(note.attachments||[]).filter(function(f){return editNoteCtx.removedFiles.indexOf(f.id)===-1;}):[];
    var editorText=String(byId('editNoteContent').textContent||'').trim();
    if(!editorText&&editNoteCtx.newImages.length===0&&keptFiles.length===0&&editNoteCtx.files.length===0){
      errEl.textContent='正文、图片和附件不能全部为空。';errEl.classList.remove('hidden');return;
    }
    if(saveBtn.disabled)return;saveBtn.disabled=true;
    var working=notify('info','正在保存…',0);var warnings=[];
    var uploadedFiles=[],reallyRemovedFiles=[];
    var chain=Promise.resolve();
    editNoteCtx.files.forEach(function(it){
      chain=chain.then(function(){
        updateStatus(it,'uploading');
        return uploadAttachment('file',noteId,it).then(function(m){uploadedFiles.push(m);updateStatus(it,'done');})
          .catch(function(e){updateStatus(it,'error');throw new AppError('附件「'+it.file.name+'」上传失败：'+((e&&e.message)||''),e&&e.status);});
      });
    });
    if(!isNew){
      (note.attachments||[]).forEach(function(f){
        if(editNoteCtx.removedFiles.indexOf(f.id)===-1)return;
        chain=chain.then(function(){
          return deleteRepoFile(f.path,'删除附件：'+(f.originalName||'')).then(function(){reallyRemovedFiles.push(f.id);})
            .catch(function(e){if(e&&e.status===404)reallyRemovedFiles.push(f.id);else warnings.push('附件删除失败：'+f.path);});
        });
      });
    }
    chain.then(function(){
      // 合并图片元数据
      var allImgs=[];
      var seen={};
      (editNoteCtx.existingImages||[]).forEach(function(x){if(!seen[x.id]){seen[x.id]=1;allImgs.push(x);}});
      (editNoteCtx.newImages||[]).forEach(function(x){if(!seen[x.id]){seen[x.id]=1;allImgs.push(x);}});
      // 只保留被 content 引用的
      var usedIds=[];
      var re=/\[\[img:([a-zA-Z0-9_-]+)\]\]/g;var m;
      while((m=re.exec(content))!==null){usedIds.push(m[1]);}
      var finalImgs=allImgs.filter(function(x){return usedIds.indexOf(x.id)!==-1;});
      var next=deepClone(state.data);var now=new Date().toISOString();
      if(isNew){
        next.notes.push({id:noteId,categoryId:categoryId,title:title,content:content,marked:marked,collapsed:false,images:finalImgs,attachments:uploadedFiles,createdAt:now,updatedAt:now});
      }else{
        var t=next.notes.find(function(n){return n.id===noteId;});
        t.categoryId=categoryId;t.title=title;t.content=content;t.marked=marked;
        t.images=finalImgs;
        t.attachments=(note.attachments||[]).filter(function(f){return reallyRemovedFiles.indexOf(f.id)===-1;}).concat(uploadedFiles);
        t.updatedAt=now;
      }
      return commitData(next,(isNew?'新增笔记：':'编辑笔记：')+title);
    }).then(function(){
      working.remove();
      notify('success','已保存到 GitHub。'+(warnings.length?'（'+warnings.join('；')+'）':''),warnings.length?15000:6000);
      closeEditNoteModal();
      if(isNew){state.currentView='note';state.currentNoteId=noteId;}
      render();
    }).catch(function(e){
      working.remove();errEl.textContent=(e&&e.message)||'保存失败。';errEl.classList.remove('hidden');
      notify('error',errEl.textContent,15000);
    }).then(function(){saveBtn.disabled=false;});
  }

  /* ================= 批量操作 ================= */
  function enterBatchMode(){
    if(!state.editing){notify('warn','请先进入编辑模式。',5000);return;}
    state.batchMode=true;state.batchSelected={};
    var bar=byId('batchActionBar');if(bar)bar.classList.remove('hidden');
    var hint=byId('batchModeHint');if(hint)hint.classList.remove('hidden');
    var btn=byId('btnBatchMode');if(btn)btn.textContent='✖ 退出批量';
    renderSidebar();
  }

  function exitBatchMode(){
    state.batchMode=false;state.batchSelected={};
    var bar=byId('batchActionBar');if(bar)bar.classList.add('hidden');
    var hint=byId('batchModeHint');if(hint)hint.classList.add('hidden');
    var btn=byId('btnBatchMode');if(btn)btn.textContent='🔲 批量选择';
    renderSidebar();
  }

  function updateBatchBar(){
    var n=Object.keys(state.batchSelected).filter(function(k){return state.batchSelected[k];}).length;
    var lbl=byId('batchCountLabel');if(lbl)lbl.textContent='已选 '+n+' 项';
  }

  function collectSelected(){
    var cats=[],notes=[];
    Object.keys(state.batchSelected).forEach(function(k){
      if(!state.batchSelected[k])return;
      var idx=k.indexOf(':');var type=k.slice(0,idx);var id=k.slice(idx+1);
      if(type==='cat')cats.push(id);else if(type==='note')notes.push(id);
    });
    return {cats:cats,notes:notes};
  }

  function executeBatchDelete(){
    var sel=collectSelected();
    if(sel.cats.length===0&&sel.notes.length===0){notify('info','请先勾选要删除的项目。',4000);return;}
    var msg='确认批量删除以下内容吗？\n\n· 目录：'+sel.cats.length+' 个（含子目录和笔记）\n· 笔记：'+sel.notes.length+' 篇\n\n删除后无法恢复，相关的图片和附件也会一并从仓库中删除。';
    askConfirm({title:'批量删除',message:msg,confirmText:'确认删除'}).then(function(ok){
      if(!ok)return;
      var working=notify('info','正在删除…',0);var warnings=[];
      // 收集要删除的笔记（含子目录内的）
      var noteIdsToDelete={};
      var catIdsToDelete={};
      var descendants={};
      (sel.cats||[]).forEach(function(cid){
        catIdsToDelete[cid]=1;
        var stack=[cid];
        while(stack.length){
          var cur=stack.pop();
          getChildren(cur).forEach(function(ch){catIdsToDelete[ch.id]=1;stack.push(ch.id);});
        }
      });
      state.data.notes.forEach(function(n){if(catIdsToDelete[n.categoryId])noteIdsToDelete[n.id]=1;});
      (sel.notes||[]).forEach(function(nid){noteIdsToDelete[nid]=1;});
      // 删除所有相关笔记的图片和附件
      var chain=Promise.resolve();
      var deletedFiles=[];
      Object.keys(noteIdsToDelete).forEach(function(nid){
        var note=state.data.notes.find(function(x){return x.id===nid;});if(!note)return;
        (note.images||[]).forEach(function(img){
          if(!img.path)return;
          chain=chain.then(function(){return deleteRepoFile(img.path,'批量删除图片：'+(img.originalName||'')).then(function(){deletedFiles.push(img.path);}).catch(function(e){if(!e||e.status!==404)warnings.push('图片删除失败：'+img.path);});});
        });
        (note.attachments||[]).forEach(function(f){
          if(!f.path)return;
          chain=chain.then(function(){return deleteRepoFile(f.path,'批量删除附件：'+(f.originalName||'')).then(function(){deletedFiles.push(f.path);}).catch(function(e){if(!e||e.status!==404)warnings.push('附件删除失败：'+f.path);});});
        });
      });
      chain.then(function(){
        var next=deepClone(state.data);
        next.notes=next.notes.filter(function(n){return !noteIdsToDelete[n.id];});
        next.categories=next.categories.filter(function(c){return !catIdsToDelete[c.id];});
        return commitData(next,'批量删除 '+sel.cats.length+' 个目录、'+sel.notes.length+' 篇笔记');
      }).then(function(){
        working.remove();
        notify('success','已保存到 GitHub。'+(warnings.length?'（'+warnings.join('；')+'）':''),warnings.length?15000:6000);
        state.batchSelected={};updateBatchBar();
        if(state.currentView==='note'&&noteIdsToDelete[state.currentNoteId]){state.currentView='dashboard';state.currentNoteId=null;}
        render();
      }).catch(function(e){working.remove();notify('error',(e&&e.message)||'批量删除失败。',12000);});
    });
  }

  function executeBatchMark(mark){
    var sel=collectSelected();
    if(sel.cats.length===0&&sel.notes.length===0){notify('info','请先勾选项目。',4000);return;}
    var next=deepClone(state.data);var now=new Date().toISOString();
    sel.cats.forEach(function(cid){var c=next.categories.find(function(x){return x.id===cid;});if(c){c.marked=mark;c.updatedAt=now;}});
    sel.notes.forEach(function(nid){var n=next.notes.find(function(x){return x.id===nid;});if(n){n.marked=mark;n.updatedAt=now;}});
    var tip=notify('info','正在保存…',0);
    commitData(next,(mark?'批量设为重点':'批量取消重点')).then(function(){
      tip.remove();notify('success','已保存到 GitHub。',5000);
      state.batchSelected={};updateBatchBar();render();
    }).catch(function(e){tip.remove();notify('error',(e&&e.message)||'保存失败。',12000);});
  }

  /* ================= 单条操作 ================= */
  function toggleNoteMarked(id){
    if(!state.editing)return;
    var next=deepClone(state.data);var n=next.notes.find(function(x){return x.id===id;});if(!n)return;
    n.marked=!n.marked;n.updatedAt=new Date().toISOString();
    var tip=notify('info','正在保存…',0);
    commitData(next,(n.marked?'设为重点：':'取消重点：')+n.title).then(function(){tip.remove();notify('success','已保存到 GitHub。',5000);render();})
      .catch(function(e){tip.remove();notify('error',(e&&e.message)||'保存失败。',12000);});
  }

  function deleteNote(id){
    if(!state.editing)return;
    var note=state.data.notes.find(function(n){return n.id===id;});if(!note)return;
    var img=(note.images||[]).length,fl=(note.attachments||[]).length;
    var msg='确认删除笔记「'+note.title+'」吗？';
    if(img>0||fl>0)msg+='\n\n该笔记有 '+img+' 张图片和 '+fl+' 个附件，将一并删除。';
    askConfirm({title:'删除笔记',message:msg,confirmText:'确认删除'}).then(function(ok){
      if(!ok)return;
      var tip=notify('info','正在删除…',0);var warns=[];var chain=Promise.resolve();
      (note.images||[]).forEach(function(i){if(!i.path)return;chain=chain.then(function(){return deleteRepoFile(i.path,'删除图片：'+(i.originalName||'')).catch(function(e){if(!e||e.status!==404)warns.push('图片删除失败：'+i.path);});});});
      (note.attachments||[]).forEach(function(f){if(!f.path)return;chain=chain.then(function(){return deleteRepoFile(f.path,'删除附件：'+(f.originalName||'')).catch(function(e){if(!e||e.status!==404)warns.push('附件删除失败：'+f.path);});});});
      chain.then(function(){var next=deepClone(state.data);next.notes=next.notes.filter(function(n){return n.id!==id;});return commitData(next,'删除笔记：'+note.title);})
        .then(function(){tip.remove();notify('success','已保存到 GitHub。'+(warns.length?'（'+warns.join('；')+'）':''),12000);if(state.currentView==='note'&&state.currentNoteId===id){state.currentView='dashboard';state.currentNoteId=null;}render();})
        .catch(function(e){tip.remove();notify('error',(e&&e.message)||'删除失败。',12000);});
    });
  }

  function exportBackup(){
    if(!state.data){notify('warn','数据尚未加载。',5000);return;}
    var text=JSON.stringify(state.data,null,2);
    var blob=new Blob([text],{type:'application/json;charset=utf-8'});
    var url=URL.createObjectURL(blob);var a=document.createElement('a');var st=new Date().toISOString().replace(/[:.]/g,'-');
    a.href=url;a.download='notes-backup-'+st+'.json';document.body.appendChild(a);a.click();document.body.removeChild(a);
    setTimeout(function(){URL.revokeObjectURL(url);},2000);notify('success','已导出 JSON 备份。',9000);
  }

  /* ================= Word 导入 ================= */
  var MAMMOTH_CDNS=['https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js','https://unpkg.com/mammoth@1.8.0/mammoth.browser.min.js'];
  var mammothPromise=null;
  var wordCtx={blocks:null,fileName:'',preview:null};

  function loadScriptOnce(src){return new Promise(function(res,rej){var s=document.createElement('script');s.src=src;s.async=true;s.onload=function(){res();};s.onerror=function(){if(s.parentNode)s.parentNode.removeChild(s);rej(new Error('加载失败'));};document.head.appendChild(s);});}
  function loadMammoth(){
    if(window.mammoth)return Promise.resolve();
    if(mammothPromise)return mammothPromise;
    mammothPromise=(function(){var p=Promise.reject();MAMMOTH_CDNS.forEach(function(url){p=p.catch(function(){return loadScriptOnce(url).then(function(){if(!window.mammoth)throw new Error('mammoth 未加载');});});});return p.catch(function(){mammothPromise=null;throw new AppError('无法加载 Word 解析库。',0);});})();
    return mammothPromise;
  }

    var JSZIP_CDNS=['https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'];
  var jszipPromise=null;
  function loadJSZip(){
    if(window.JSZip)return Promise.resolve();
    if(jszipPromise)return jszipPromise;
    jszipPromise=(function(){var p=Promise.reject();JSZIP_CDNS.forEach(function(url){p=p.catch(function(){return loadScriptOnce(url).then(function(){if(!window.JSZip)throw new Error('JSZip 未加载');});});});return p.catch(function(){jszipPromise=null;throw new Error('无法加载 JSZip');});})();
    return jszipPromise;
  }

  function highlightColorToHex(name){
    var map={
      yellow:'#ffff00',green:'#00ff00',cyan:'#00ffff',magenta:'#ff00ff',
      blue:'#0000ff',red:'#ff0000',
      darkBlue:'#000080',darkCyan:'#008080',darkGreen:'#008000',
      darkMagenta:'#800080',darkRed:'#800000',darkYellow:'#808000',
      darkGray:'#808080',lightGray:'#c0c0c0',black:'#000000'
    };
    return map[name]||'#ffff00';
  }

  function extractHighlightSpans(arrayBuffer){
    if(!window.JSZip)return Promise.resolve([]);
    return window.JSZip.loadAsync(arrayBuffer).then(function(zip){
      var f=zip.file('word/document.xml');
      if(!f)return [];
      return f.async('string');
    }).then(function(xml){
      var parser=new DOMParser();
      var doc=parser.parseFromString(xml,'application/xml');
      var ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
      var result=[];
      var runs=doc.getElementsByTagNameNS(ns,'r');
      for(var i=0;i<runs.length;i++){
        var run=runs[i];
        var rPr=run.getElementsByTagNameNS(ns,'rPr')[0];
        if(!rPr)continue;
        var hs=rPr.getElementsByTagNameNS(ns,'highlight');
        if(hs.length===0)continue;
        var hlVal=hs[0].getAttributeNS(ns,'val')||hs[0].getAttribute('w:val')||'yellow';
        var texts=run.getElementsByTagNameNS(ns,'t');
        var txt='';
        for(var k=0;k<texts.length;k++)txt+=(texts[k].textContent||'');
        if(txt)result.push({text:txt,color:hlVal});
      }
      return result;
    }).catch(function(e){console.warn('提取高亮失败',e);return [];});
  }

  function applyHighlightSpans(html,spans){
    if(!spans||spans.length===0)return html;
    var wrap=document.createElement('div');
    wrap.innerHTML=html;
    spans.forEach(function(span){
      var target=span.text;
      if(!target)return;
      var textNodes=[];
      (function collect(node){
        Array.prototype.forEach.call(node.childNodes,function(ch){
          if(ch.nodeType===3){if(ch.textContent)textNodes.push(ch);}
          else if(ch.nodeType===1){collect(ch);}
        });
      })(wrap);
      for(var i=0;i<textNodes.length;i++){
        var node=textNodes[i];
        var txt=node.textContent;
        var idx=txt.indexOf(target);
        if(idx===-1)continue;
        var before=txt.slice(0,idx);
        var match=txt.slice(idx,idx+target.length);
        var after=txt.slice(idx+target.length);
        var parent=node.parentNode;
        if(!parent)continue;
        var spanEl=document.createElement('span');
        spanEl.setAttribute('style','background-color:'+highlightColorToHex(span.color));
        spanEl.textContent=match;
        if(before)parent.insertBefore(document.createTextNode(before),node);
        parent.insertBefore(spanEl,node);
        if(after)parent.insertBefore(document.createTextNode(after),node);
        parent.removeChild(node);
        break;
      }
    });
    return wrap.innerHTML;
  }
  
  /* mammoth 输出的 HTML 里提取段落、标题、图片（含样式） */
  function extractBlocksFromHtml(html){
    var parser=new DOMParser();
    var doc=parser.parseFromString(html,'text/html');
    var blocks=[];

    function escapeHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

    function inlineHtmlOf(node){
      // 把 node 的子节点转为带样式（b/i/u/s/mark/span[style]/img）的 HTML
      var out='';
      Array.prototype.forEach.call(node.childNodes,function(ch){
        if(ch.nodeType===3){
          out+=escapeHtml(ch.textContent);
          return;
        }
        if(ch.nodeType!==1)return;
        var tag=ch.tagName.toLowerCase();
        if(tag==='strong'||tag==='b'){out+='<b>'+inlineHtmlOf(ch)+'</b>';}
        else if(tag==='em'||tag==='i'){out+='<i>'+inlineHtmlOf(ch)+'</i>';}
        else if(tag==='u'){out+='<u>'+inlineHtmlOf(ch)+'</u>';}
        else if(tag==='s'||tag==='strike'||tag==='del'){out+='<s>'+inlineHtmlOf(ch)+'</s>';}
        else if(tag==='mark'){
          var inner0=inlineHtmlOf(ch);
          var mst=ch.getAttribute('style')||'';
          var bg='yellow';
          var mm=/background-color\s*:\s*([^;]+)/i.exec(mst);
          if(mm)bg=mm[1].trim();
          out+='<span style="background-color:'+bg+'">'+inner0+'</span>';
        }
        else if(tag==='span'){
          var inner=inlineHtmlOf(ch);
          var st=ch.getAttribute('style')||'';
          var keep=[];
          st.split(';').forEach(function(p){
            var i=p.indexOf(':');if(i<=0)return;
            var k=p.slice(0,i).trim().toLowerCase(),v=p.slice(i+1).trim();
            if((k==='color'||k==='background-color')&&v&&v.indexOf('url(')===-1&&v.indexOf('expression')===-1)keep.push(k+':'+v);
          });
          if(keep.length)out+='<span style="'+keep.join(';')+'">'+inner+'</span>';
          else out+=inner;
        }
        else if(tag==='br'){out+='<br>';}
        else if(tag==='img'){
          var src=ch.getAttribute('src')||'';
          var m=/^data:([^;]+);base64,(.+)$/.exec(src);
          if(m)out+='[[IMG_B64:'+m[1]+':'+m[2]+']]';
        }
        else if(tag==='p'||tag==='div'||/^h[1-6]$/.test(tag)){
          // 块级元素在 inline 上下文里转成 <br> 分隔
          var inner2=inlineHtmlOf(ch);
          if(inner2){
            if(out&&!/<br>$/.test(out))out+='<br>';
            out+=inner2;
          }
        }
        else if(tag==='ul'||tag==='ol'){
          var lis=[];
          Array.prototype.forEach.call(ch.children,function(li){
            if(li.tagName.toLowerCase()!=='li')return;
            var lh=inlineHtmlOf(li);
            if(lh)lis.push('· '+lh);
          });
          if(lis.length){
            if(out&&!/<br>$/.test(out))out+='<br>';
            out+=lis.join('<br>');
          }
        }
        else{
          out+=inlineHtmlOf(ch);
        }
      });
      return out;
    }

    function tableToHtml(node){
      var html='<table>';
      var trs=[];
      function collectTr(parent){
        Array.prototype.forEach.call(parent.children||[],function(child){
          var tg=child.tagName.toLowerCase();
          if(tg==='tr')trs.push(child);
          else if(tg==='thead'||tg==='tbody'||tg==='tfoot')collectTr(child);
        });
      }
      collectTr(node);
      trs.forEach(function(tr){
        html+='<tr>';
        Array.prototype.forEach.call(tr.children,function(cell){
          var tg=cell.tagName.toLowerCase();
          if(tg!=='th'&&tg!=='td')return;
          var spanAttrs='';
          var cs=cell.getAttribute('colspan');
          var rs=cell.getAttribute('rowspan');
          if(cs&&parseInt(cs,10)>1)spanAttrs+=' colspan="'+parseInt(cs,10)+'"';
          if(rs&&parseInt(rs,10)>1)spanAttrs+=' rowspan="'+parseInt(rs,10)+'"';
          html+='<'+tg+spanAttrs+'>'+inlineHtmlOf(cell)+'</'+tg+'>';
        });
        html+='</tr>';
      });
      html+='</table>';
      return html;
    }

    function walk(node){
      if(!node||node.nodeType!==1)return;
      var tag=node.tagName.toLowerCase();
      if(/^h[1-6]$/.test(tag)){
        var html=inlineHtmlOf(node);
        var plain=String(node.textContent||'').replace(/\s+/g,' ').trim();
        if(plain||html)blocks.push({type:'heading',level:parseInt(tag.charAt(1),10),text:plain,html:html});
        return;
      }
      if(tag==='p'){
        var inner=inlineHtmlOf(node);
        var txt=String(node.textContent||'').replace(/\s+/g,' ').trim();
        var hasImg=inner.indexOf('[[IMG_B64:')!==-1;
        var hasTable=inner.indexOf('<table')!==-1;
        if(txt||hasImg||hasTable)blocks.push({type:'paragraph',text:txt,html:inner});
        return;
      }
      if(tag==='table'){
        blocks.push({type:'paragraph',text:String(node.textContent||'').replace(/\s+/g,' ').trim(),html:tableToHtml(node)});
        return;
      }
      if(tag==='ul'||tag==='ol'){
        var items=[];
        Array.prototype.forEach.call(node.children,function(li){
          if(li.tagName.toLowerCase()!=='li')return;
          var t=String(li.textContent||'').replace(/\s+/g,' ').trim();
          if(t)items.push('· '+t);
        });
        if(items.length)blocks.push({type:'paragraph',text:items.join('\n'),html:items.map(escapeHtml).join('<br>')});
        return;
      }
      Array.prototype.forEach.call(node.childNodes,walk);
    }

    Array.prototype.forEach.call(doc.body.childNodes,walk);
    return blocks;
  }

  function buildWordPreview(blocks,fileName){
    var tree=[];
    var curL1=null,curL2=null,curNote=null;
    function ensureL1(name){var c=tree.find(function(x){return x.name===name;});if(!c){c={name:name,children:[],notes:[]};tree.push(c);}return c;}
    function ensureL2(p,name){var c=p.children.find(function(x){return x.name===name;});if(!c){c={name:name,notes:[]};p.children.push(c);}return c;}
    function flush(){if(!curNote)return;if(curL2)curL2.notes.push(curNote);else if(curL1)curL1.notes.push(curNote);curNote=null;}
    function curCat(){return curL2||curL1;}
    blocks.forEach(function(b){
      if(b.type==='heading'){
        if(b.level===1){flush();curL1=ensureL1(b.text);curL2=null;}
        else if(b.level===2){flush();if(!curL1)curL1=ensureL1(fileName||'Word');curL2=ensureL2(curL1,b.text);}
        else if(b.level===3){flush();if(!curL1)curL1=ensureL1(fileName||'Word');curNote={title:b.text,segments:[]};}
        else{if(curNote)curNote.segments.push({type:'text',html:'<b>'+escapeHtmlSafe(b.html||b.text)+'</b>'});}
      }else if(b.type==='paragraph'){
        if(curNote)curNote.segments.push({type:'html',html:b.html||escapeHtmlSafe(b.text)});
        else{
          var cat=curCat();
          if(cat&&(b.text||b.html)){
            curNote={title:cat.name,segments:[{type:'html',html:b.html||escapeHtmlSafe(b.text)}]};
            flush();
          }
        }
      }
    });
    flush();
    return {tree:tree.filter(function(c){return c.notes.length>0||c.children.some(function(x){return x.notes.length>0;});})};
  }
  function escapeHtmlSafe(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

  function countStats(pv){
    var tn=0,tl1=pv.tree.length,tl2=0,timg=0;
    function countSegs(segs){segs.forEach(function(s){var m=s.html?s.html.match(/\[\[IMG_B64:/g):null;if(m)timg+=m.length;});}
    pv.tree.forEach(function(l1){
      l1.notes.forEach(function(n){tn++;countSegs(n.segments);});
      l1.children.forEach(function(l2){tl2++;l2.notes.forEach(function(n){tn++;countSegs(n.segments);});});
    });
    return {totalNotes:tn,totalL1:tl1,totalL2:tl2,totalImages:timg};
  }

  function renderWordPreview(){
    if(!wordCtx.preview)return;
    var summary=byId('wordImportSummary'),err=byId('wordImportError');
    err.classList.add('hidden');
    var pv=wordCtx.preview;var st=countStats(pv);
    var lines=['识别方式：标题 1 → 一级目录；标题 2 → 二级目录；标题 3 → 笔记标题',
      '一级目录：'+st.totalL1+' 个','二级目录：'+st.totalL2+' 个','笔记：'+st.totalNotes+' 篇','图片：'+st.totalImages+' 张',''];
    pv.tree.forEach(function(l1){
      lines.push('📁 '+l1.name);
      l1.notes.forEach(function(n){lines.push('   📄 '+n.title+'（直属）');});
      l1.children.forEach(function(l2){lines.push('   📁 '+l2.name);l2.notes.forEach(function(n){lines.push('      📄 '+n.title);});});
    });
    summary.textContent=lines.join('\n');
    byId('btnWordImportConfirm').disabled=(st.totalNotes===0);
    if(st.totalNotes===0){err.textContent='未识别到任何笔记，请检查 Word 是否使用了“标题 1/2/3”样式。';err.classList.remove('hidden');}
  }

  function handleWordFile(file){
    if(!state.editing){notify('warn','请先进入编辑模式。',5000);return;}
    if(getExt(file.name)!=='docx'){notify('error','只支持 .docx 文件。',8000);return;}
    wordCtx.fileName=file.name.replace(/\.docx$/i,'');wordCtx.blocks=null;wordCtx.preview=null;
    var loading=notify('info','正在解析 Word…',0);

    Promise.all([
      loadMammoth(),
      loadJSZip().catch(function(){return null;}),
      readFileAsArrayBuffer(file)
    ]).then(function(results){
      var buf=results[2];
      return extractHighlightSpans(buf).then(function(spans){
        console.log('[Word导入] 提取到高亮片段：',spans.length,spans);
        return window.mammoth.convertToHtml({arrayBuffer:buf}).then(function(res){
          var html=(res&&res.value)||'';
          html=applyHighlightSpans(html,spans);
          console.log('[Word导入] 处理后的 HTML 前 500 字符：',html.slice(0,500));
          return html;
        });
      });
    }).then(function(html){
      loading.remove();
      var blocks=extractBlocksFromHtml(html);
      if(!blocks.length)throw new AppError('Word 中未找到有效内容。',0);
      wordCtx.blocks=blocks;
      wordCtx.preview=buildWordPreview(blocks,wordCtx.fileName);
      renderWordPreview();
      showModal('wordImportModal');
    }).catch(function(e){
      loading.remove();
      notify('error',(e&&e.message)||'解析 Word 失败。',12000);
    });
  }
  
  function executeWordImport(){
    if(!state.editing){notify('warn','请先进入编辑模式。',5000);return;}
    var pv=wordCtx.preview;if(!pv)return;
    var btn=byId('btnWordImportConfirm');if(btn.disabled)return;btn.disabled=true;
    var working=notify('info','正在导入并上传图片…',0);
    var next=deepClone(state.data);var now=new Date().toISOString();
    function findOrCreateL1(name){var c=next.categories.find(function(x){return x.parentId==null&&x.name===name;});if(!c){c={id:newId('category'),name:name,parentId:null,marked:false,collapsed:false,createdAt:now,updatedAt:now};next.categories.push(c);}return c;}
    function findOrCreateL2(pid,name){var c=next.categories.find(function(x){return x.parentId===pid&&x.name===name;});if(!c){c={id:newId('category'),name:name,parentId:pid,marked:false,collapsed:false,createdAt:now,updatedAt:now};next.categories.push(c);}return c;}

    var pending=[];
    pv.tree.forEach(function(l1){
      var cat1=findOrCreateL1(l1.name);
      l1.notes.forEach(function(n){pending.push({note:n,categoryId:cat1.id});});
      l1.children.forEach(function(l2){
        var cat2=findOrCreateL2(cat1.id,l2.name);
        l2.notes.forEach(function(n){pending.push({note:n,categoryId:cat2.id});});
      });
    });

    var chain=Promise.resolve();
    pending.forEach(function(p){
      var noteId=newId('note');
      var images=[];
      var finalHtml='';
      // 处理 segments
      chain=chain.then(function(){
        var idx=0;
        function step(){
          if(idx>=p.note.segments.length){
            next.notes.push({id:noteId,categoryId:p.categoryId,title:p.note.title,content:finalHtml.trim(),marked:false,collapsed:false,images:images,attachments:[],createdAt:now,updatedAt:now});
            return Promise.resolve();
          }
          var seg=p.note.segments[idx++];
          var html=seg.html||'';
          // 找 [[IMG_B64:...]] 逐个上传
          var re=/\[\[IMG_B64:([^:]+):([^\]]+)\]\]/g;
          var pos=0;var parts=[];var mm;var hasImg=false;
          while((mm=re.exec(html))!==null){
            hasImg=true;
            var before=html.slice(pos,mm.index);
            if(before)parts.push(before);
            parts.push({__imgB64:mm[2],__imgMime:mm[1]});
            pos=re.lastIndex;
          }
          var tail=html.slice(pos);
          if(tail)parts.push(tail);
          if(!hasImg){
            finalHtml+=(finalHtml?'<br>':'')+html;
            return step();
          }
          // 逐个上传
          var pi=0;
          function stepPart(){
            if(pi>=parts.length)return step();
            var pp=parts[pi++];
            if(typeof pp==='string'){finalHtml+=(finalHtml?'<br>':'')+pp;return stepPart();}
            return uploadBase64Image(pp.__imgB64,pp.__imgMime,noteId,'word-image.'+extFromMime(pp.__imgMime))
              .then(function(meta){
                images.push(meta);
                finalHtml+=(finalHtml?'<br>':'')+'<img src="[[img:'+meta.id+']]" alt="">';
                return stepPart();
              }).catch(function(err){
                finalHtml+=(finalHtml?'<br>':'')+'[图片上传失败：'+((err&&err.message)||'')+']';
                return stepPart();
              });
          }
          return stepPart();
        }
        return step();
      });
    });

    chain.then(function(){return commitData(next,'从 Word 导入：'+wordCtx.fileName);})
      .then(function(){
        working.remove();hideModal('wordImportModal');
        wordCtx.blocks=null;wordCtx.preview=null;wordCtx.fileName='';
        notify('success','已保存到 GitHub。',6000);
        render();
      }).catch(function(e){
        working.remove();
        var err=byId('wordImportError');err.textContent=(e&&e.message)||'导入失败。';err.classList.remove('hidden');
      }).then(function(){btn.disabled=false;});
  }

  /* ================= 事件绑定 ================= */
  function bindEvents(){
    function safeBind(id,evt,fn){var e=byId(id);if(e)e.addEventListener(evt,fn);}

    safeBind('btnEnterEdit','click',enterEditMode);
    safeBind('btnExitEdit','click',exitEditMode);
    safeBind('btnToggleToken','click',function(){
      var inp=byId('tokenInput'),btn=byId('btnToggleToken');
      if(inp.type==='password'){inp.type='text';btn.textContent='隐藏';}else{inp.type='password';btn.textContent='显示';}
    });
    safeBind('btnTokenConfirm','click',confirmEnterEditMode);
    safeBind('btnTokenCancel','click',function(){byId('tokenInput').value='';hideModal('tokenModal');});
    safeBind('tokenInput','keydown',function(ev){if(ev.key==='Enter'){ev.preventDefault();confirmEnterEditMode();}});
    safeBind('confirmOkBtn','click',function(){resolveConfirm(true);});
    safeBind('confirmCancelBtn','click',function(){resolveConfirm(false);});

    // 侧边栏折叠
    function toggleSidebarCollapse(){
      var sb=byId('sidebar');
      var isCol=sb.classList.toggle('collapsed');
      var ob=byId('btnOpenSidebar');
      if(ob){if(isCol)ob.classList.remove('hidden');else ob.classList.add('hidden');}
    }
    safeBind('btnToggleSidebar','click',toggleSidebarCollapse);
    safeBind('btnOpenSidebar','click',toggleSidebarCollapse);

    ['sideToolDashboard','sideToolPomodoro','sideToolTimer'].forEach(function(id){
      safeBind(id,'click',function(){
        if(id==='sideToolDashboard')state.currentView='dashboard';
        else if(id==='sideToolPomodoro')state.currentView='pomodoro';
        else if(id==='sideToolTimer')state.currentView='timer';
        render();
      });
    });
    safeBind('btnBackFromPomodoro','click',function(){state.currentView='dashboard';render();});
    safeBind('btnBackFromTimer','click',function(){state.currentView='dashboard';render();});
    safeBind('btnPomodoroStart','click',startPomodoro);
    safeBind('btnPomodoroPause','click',pausePomodoro);
    safeBind('btnPomodoroReset','click',resetPomodoro);

    safeBind('btnReminderAdd','click',function(){reminderState.editing=null;openReminderModal();});
    safeBind('btnReminderCancel','click',function(){reminderState.editing=null;hideModal('reminderModal');});
    safeBind('btnReminderSave','click',saveReminderFromModal);
    safeBind('btnReminderSearch','click',function(){
      reminderState.filter.search=String(byId('reminderSearch').value||'');
      reminderState.filter.cat=String(byId('reminderCatFilter').value||'all');
      reminderState.filter.sort=String(byId('reminderSort').value||'remaining');
      renderReminderCatTabs();renderReminderList();
    });
    safeBind('btnReminderSortDir','click',function(){
      reminderState.filter.dir=reminderState.filter.dir==='asc'?'desc':'asc';
      byId('btnReminderSortDir').textContent=reminderState.filter.dir==='asc'?'↑ 升序':'↓ 降序';
      renderReminderList();
    });
    safeBind('btnReminderReset','click',function(){
      byId('reminderSearch').value='';byId('reminderCatFilter').value='all';byId('reminderSort').value='remaining';
      reminderState.filter={search:'',cat:'all',sort:'remaining',dir:'asc'};
      byId('btnReminderSortDir').textContent='↑ 升序';
      renderReminderCatTabs();renderReminderList();
    });

    safeBind('searchInput','input',function(){state.searchKeyword=String(byId('searchInput').value||'');renderSidebar();});
    safeBind('btnClearSearch','click',function(){byId('searchInput').value='';state.searchKeyword='';renderSidebar();});
    safeBind('btnQuickAddNote','click',function(){openEditNote(null);});
    safeBind('btnQuickReload','click',function(){loadRemoteData({});});
    safeBind('btnQuickExport','click',exportBackup);
    safeBind('btnImportWordDash','click',function(){byId('wordFileInput').click();});
    // 天气相关
    safeBind('btnWeatherRefresh','click',function(){
      weatherState.lastUpdated=0;
      notify('info','正在刷新天气…',3000);
      loadAllWeather(true).then(function(){notify('success','天气已更新。',4000);});
    });
    safeBind('btnEditExtraCity','click',openWeatherCityModal);
    safeBind('btnWeatherCitySearch','click',searchWeatherCity);
        safeBind('btnWeatherAutoCitySearch','click',function(){
      var q=String(byId('weatherAutoCityInput').value||'').trim();
      var box=byId('weatherAutoCityResults');
      box.textContent='';
      if(!q){notify('warn','请输入定位城市名称。',4000);return;}
      var tip=notify('info','正在搜索…',0);
      fetchGeocode(q).then(function(list){
        tip.remove();
        if(list.length===0){notify('error','未找到该城市。',6000);return;}
        list.forEach(function(r){
          var btn=document.createElement('button');btn.type='button';btn.className='weather-city-result';btn.textContent=r.name;
          btn.addEventListener('click',function(){
            saveWeatherAutoCity({name:r.name,shortName:r.shortName,latitude:r.latitude,longitude:r.longitude});
            weatherState.data.auto=null;weatherState.lastUpdated=0;
            hideModal('weatherCityModal');
            notify('success','已设置定位城市：'+r.name,5000);
            loadAllWeather(true);
          });
          box.appendChild(btn);
        });
      }).catch(function(e){
        tip.remove();notify('error',(e&&e.message)||'搜索失败。',6000);
      });
    });
    safeBind('weatherCityInput','keydown',function(ev){if(ev.key==='Enter'){ev.preventDefault();searchWeatherCity();}});
    safeBind('btnWeatherCityClear','click',function(){
      askConfirm({title:'清除额外城市',message:'确认清除额外城市设置吗？',confirmText:'清除'}).then(function(ok){
        if(!ok)return;
        saveWeatherExtraCity(null);
        weatherState.data.extra=null;
        hideModal('weatherCityModal');
        renderWeather();
        notify('info','已清除额外城市。',4000);
      });
    });
    safeBind('btnWeatherCityCancel','click',function(){hideModal('weatherCityModal');});
    
    safeBind('btnBackToDash','click',function(){state.currentView='dashboard';state.currentNoteId=null;render();});
    safeBind('btnEditCurrentNote','click',function(){if(state.currentNoteId)openEditNote(state.currentNoteId);});
    safeBind('btnDeleteCurrentNote','click',function(){if(state.currentNoteId)deleteNote(state.currentNoteId);});
    safeBind('btnToggleMarkCurrentNote','click',function(){if(state.currentNoteId)toggleNoteMarked(state.currentNoteId);});

    // 编辑笔记里的格式化按钮
    document.querySelectorAll('.fmt-btn').forEach(function(b){
      b.addEventListener('click',function(e){
        e.preventDefault();
        var cmd=b.getAttribute('data-cmd');
        try{document.execCommand(cmd,false,null);}catch(err){}
        byId('editNoteContent').focus();
      });
    });
    safeBind('editTextColor','input',function(){
      var c=byId('editTextColor').value;
      try{document.execCommand('foreColor',false,c);}catch(e){}
      byId('editNoteContent').focus();
    });
    safeBind('editBgColor','input',function(){
      var c=byId('editBgColor').value;
      try{
        // 用 hiliteColor 或 backColor
        if(!document.execCommand('hiliteColor',false,c)){
          document.execCommand('backColor',false,c);
        }
      }catch(e){}
      byId('editNoteContent').focus();
    });
    safeBind('btnInsertImage','click',insertImageAtCursor);
    safeBind('editNoteImageInput','change',function(ev){var f=ev.target.files&&ev.target.files[0];ev.target.value='';if(f)handleInsertImageFile(f);});
    safeBind('editNoteFiles','change',function(ev){var files=ev.target.files;ev.target.value='';if(files&&files.length)handleEditNoteFileSelect(files);});
    safeBind('btnSaveEditNote','click',saveEditNote);
    safeBind('btnCancelEditNote','click',closeEditNoteModal);

    safeBind('wordFileInput','change',function(ev){var f=ev.target.files&&ev.target.files[0];ev.target.value='';if(f)handleWordFile(f);});
    safeBind('btnWordImportConfirm','click',executeWordImport);
    safeBind('btnWordImportCancel','click',function(){wordCtx.blocks=null;wordCtx.preview=null;wordCtx.fileName='';hideModal('wordImportModal');});

    // 批量操作
    safeBind('btnBatchMode','click',function(){
      if(state.batchMode)exitBatchMode();else enterBatchMode();
    });
    safeBind('btnBatchMark','click',function(){executeBatchMark(true);});
    safeBind('btnBatchUnmark','click',function(){executeBatchMark(false);});
    safeBind('btnBatchDelete','click',executeBatchDelete);
    safeBind('btnBatchClear','click',function(){state.batchSelected={};updateBatchBar();renderSidebar();});
    safeBind('btnBatchExit','click',exitBatchMode);

    document.addEventListener('keydown',function(ev){
      if(ev.key!=='Escape')return;
      if(!byId('confirmModal').classList.contains('hidden')){resolveConfirm(false);return;}
      if(!byId('tokenModal').classList.contains('hidden')){byId('tokenInput').value='';hideModal('tokenModal');return;}
      if(!byId('editNoteModal').classList.contains('hidden')){closeEditNoteModal();return;}
      if(!byId('reminderModal').classList.contains('hidden')){reminderState.editing=null;hideModal('reminderModal');return;}
      if(!byId('weatherCityModal').classList.contains('hidden')){hideModal('weatherCityModal');return;}
      if(!byId('wordImportModal').classList.contains('hidden')){hideModal('wordImportModal');return;}
    });
  }

  function init(){
    if(CONFIG.SITE_TITLE)document.title=CONFIG.SITE_TITLE;
    updateClock();setInterval(updateClock,1000);
    try{var s=sessionStorage.getItem(TOKEN_STORAGE_KEY);if(s){state.token=s;state.editing=true;document.body.classList.add('edit-mode');}}catch(e){}
    try{toolState.pomodoroCount=parseInt(localStorage.getItem('pomodoroCount')||'0',10)||0;}catch(e){}
    loadReminders();initReminderSelects();
    try{bindEvents();}catch(e){console.error('bindEvents 出错：',e);}
    try{render();}catch(e){console.error('render 出错：',e);}
    updatePomodoroDisplay();renderReminderList();
    setInterval(checkDueReminders,30000);
   // 天气：读取配置并加载
    loadWeatherFromStorage();
    loadAllWeather(false);
    setInterval(function(){loadAllWeather(true);},WEATHER_REFRESH_INTERVAL);
    loadRemoteData({silent:true});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);
  else init();
})();
