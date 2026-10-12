(function () {
  'use strict';
  var CONFIG = window.APP_CONFIG || {};
  var TOKEN_STORAGE_KEY = 'cloudNotes.githubToken';
  var REMINDER_STORAGE_KEY = 'cloudNotes.reminders';
  var ALLOWED_TAGS = { B:1, STRONG:1, I:1, EM:1, U:1, S:1, STRIKE:1, DEL:1, BR:1, P:1, DIV:1, SPAN:1, IMG:1 };

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
          if(tag==='IMG'&&an==='src')return;
          if(tag==='IMG'&&an==='alt')return;
          if(tag==='SPAN'&&an==='style')return;
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
    var note=isNew?null:state.data.notes