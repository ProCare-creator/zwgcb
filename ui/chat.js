/* Standalone chat. Embedded by build:page; no additional runtime requests. */
const chat={doc:null,input:'',attachment:null,request:null,error:'',thoughts:new Map(),edits:new Map(),busy:new Set(),queues:new Map(),follow:true,search:'',pending:null,jump:null};
const chatDateLabel=k=>k.slice(5).replace('-','/');
const chatDocs=()=>Object.entries(S.meta).filter(([k,v])=>k.startsWith('chat:')&&v&&typeof v.id==='string'&&Array.isArray(v.messages)).map(([,v])=>v).sort((a,b)=>String(b.updated).localeCompare(String(a.updated)));
function chatNewDoc(){const now=new Date().toISOString();return {id:newId(),title:'新对话',created:now,updated:now,messages:[],cards:{}};}
function chatLoad(){
 const id=new URLSearchParams(location.hash.split('?')[1]||'').get('id');if(chat.doc&&(!id||chat.doc.id===id))return chat.doc;
 const saved=id&&S.meta['chat:'+id],draft=id&&drafts['chat:'+id];
 chat.doc=clone(draft?.doc&&(!saved||draft.doc.updated>=saved.updated)?draft.doc:saved)||chatNewDoc();chat.doc.cards||={};
 chat.input=draft?.input||'';chat.attachment=draft?.attachment||null;chat.error=id&&!saved&&!draft?'这次对话已删除或不在这台设备上。':'';chat.follow=true;chat.scrollTop=0;return chat.doc;
}
function chatDraft(doc=chat.doc){if(!doc)return;const active=doc===chat.doc;drafts['chat:'+doc.id]={doc:clone(doc),input:active?chat.input:drafts['chat:'+doc.id]?.input||'',attachment:active?clone(chat.attachment):drafts['chat:'+doc.id]?.attachment||null};if(chat.request?.doc===doc){const m=drafts['chat:'+doc.id].doc.messages[chat.request.index];if(m)m.partial=true;}saveDrafts();if(active&&route==='chat'&&!new URLSearchParams(location.hash.split('?')[1]||'').has('id'))history.replaceState(null,'','#chat?id='+encodeURIComponent(doc.id));}
async function chatPut(col,id,value){const previous=S[col][id];try{await put(col,id,value);if(mode==='local'&&JSON.stringify(lsRead()?.[col]?.[id])!==JSON.stringify(S[col][id]))throw Error('local-save');}catch(e){if(previous)S[col][id]=previous;else delete S[col][id];throw e;}}
async function chatRemove(col,id){
 const old=S[col][id],mark=mode==='local'?readDel()[col+'/'+id]:null;
 try{await remove(col,id);if(mode==='local'){const saved=lsRead();if(!saved||saved[col]?.[id])throw Error('local-remove');}}
 catch(e){if(old)S[col][id]=old;if(mode==='local'){const del=readDel();if(mark===undefined)delete del[col+'/'+id];else del[col+'/'+id]=mark;writeDel(del);}throw e;}
}
function chatSave(doc){
 doc.updated=new Date().toISOString();const snapshot=clone(doc),id=doc.id;
 const p=(chat.queues.get(id)||Promise.resolve()).catch(()=>{}).then(()=>chatPut('meta','chat:'+id,snapshot));chat.queues.set(id,p);
 return p.then(()=>{const draft=drafts['chat:'+id];if(draft?.doc?.updated<=snapshot.updated){if(draft.input)draft.doc=clone(snapshot);else delete drafts['chat:'+id];saveDrafts();}if(chat.doc?.id===id&&chat.input)chatDraft(doc);});
}
// Parse complete standalone lines. Incomplete streaming tags remain buffered;
// malformed, oversized and unclosed final tags are rendered verbatim as text.
function chatParse(raw,final=true){
 const parts=[],asks=[];let cards=0;const lines=String(raw).split('\n');
 const plain=text=>{if(parts.at(-1)?.type==='text')parts.at(-1).text+=text;else parts.push({type:'text',text});};
 for(let i=0;i<lines.length;i++){
  const line=lines[i],trim=line.trim(),suffix=i<lines.length-1?'\n':'';
  const m=/^<(hyp|pred|ev|ask)(\s[^>]*)?>(.*?)<\/\1>$/.exec(trim);
  if(!m){if(!final&&i===lines.length-1&&(/^<(?:hyp|pred|ev|ask)\b/.test(trim)||['<','<h','<hy','<p','<pr','<pre','<e','<a','<as'].includes(trim)))continue;plain(line+suffix);continue;}
  const [,type,attrs='',text]=m,attr={};let valid=true,left=attrs;
  left=left.replace(/\s+([a-z]+)="([^"]*)"/g,(_,k,v)=>{if(Object.hasOwn(attr,k))valid=false;attr[k]=v;return '';});
  valid=valid&&!left.trim()&&text.trim().length>0&&[...text].length<=300;
  if(type==='hyp'||type==='ask')valid=valid&&!Object.keys(attr).length;
  if(type==='pred')valid=valid&&Object.keys(attr).length===1&&validDate(attr.date);
  if(type==='ev')valid=valid&&Object.keys(attr).length===2&&/^[1-9]\d*$/.test(attr.no||'')&&Number.isSafeInteger(+attr.no)&&['sup','con'].includes(attr.kind);
  if(type==='ask'){
   valid=valid&&asks.length<2&&lines.slice(i+1).every(l=>!l.trim()||/^<ask>[^\n]*<\/ask>$/.test(l.trim()));
   if(valid){asks.push(text.trim());continue;}
  }else if(valid&&cards<2){parts.push({type,text:text.trim(),...attr,index:cards++});continue;}
  plain(line+suffix);
 }
 return {parts,asks};
}
function chatDuplicate(card){
 if(card.type==='hyp')return Object.values(S.hyps).find(h=>sameText(hypText(h),card.text));
 if(card.type==='pred')return (S.days[card.date]?.preds||[]).find(p=>sameText(p.text,card.text));return null;
}
function chatCardAt(key){const [mi,ci]=key.split(':').map(Number),card=chatParse(chat.doc.messages[mi]?.content||'').parts.find(p=>p.type!=='text'&&p.index===ci);if(card&&chat.doc.cards[key]?.text)card.text=chat.doc.cards[key].text;return card;}
function chatCardHTML(card,key,live=false){
 const state=chat.doc.cards[key];if(state?.text)card={...card,text:state.text};const duplicate=chatDuplicate(card),target=card.type==='ev'?Object.values(S.hyps).find(h=>h.no===+card.no):null;
 const label=card.type==='hyp'?'假设':card.type==='pred'?(card.date===addDays(dayKey(),1)?'明天的预测':chatDateLabel(card.date)+' 的预测'):'给 H'+card.no+' 加'+(card.kind==='sup'?'支持证据':'反例');
 const attrs=' data-key="'+key+'"',busy=chat.busy.has(chat.doc.id+':'+key),edit=chat.edits.get(chat.doc.id+':'+key);
 let body='<article class="chat-card '+(state?.status==='added'?'is-added':'')+'" data-card-key="'+key+'"><span class="ai-eyebrow">'+label+'</span>';
 body+=edit!==undefined?'<label class="sr-only" for="chat-edit-'+key+'">编辑卡片文字</label><textarea id="chat-edit-'+key+'" data-chat-edit="'+key+'" rows="3" maxlength="300">'+esc(edit)+'</textarea>':'<p>'+esc(card.text)+'</p>';
 if(state?.status==='added'){
  const text=state.type==='pred'?(state.existing?'已有 ':'已加到 ')+chatDateLabel(state.ref.date)+' 的预测':(state.existing?'已有 H':'已加入 H')+state.ref.no;
  body+='<button class="linkbtn" type="button" data-act="chatCardJump"'+attrs+'>'+text+' ›</button>';
  if(state.undoUntil>Date.now())body+='<button class="linkbtn" type="button" data-act="chatUndo"'+attrs+(busy?' disabled':'')+'>撤销</button>';
 }else if(duplicate&&edit===undefined){body+='<button class="linkbtn" type="button" data-act="chatExisting"'+attrs+'>'+ (card.type==='hyp'?'已有 H'+duplicate.no:'已有 '+chatDateLabel(card.date)+' 的预测')+' ›</button>';}
 else if(card.type==='ev'&&!target)body+='<span class="fine">找不到 H'+card.no+'</span>';
 else body+='<div class="row"><button type="button" class="btn sm" data-act="chatAdd"'+attrs+(busy||live||chat.request?' disabled':'')+'>'+(busy?'正在加入…':'加入')+'</button><button type="button" class="linkbtn" data-act="chatEdit"'+attrs+(busy||live||chat.request?' disabled':'')+'>改一下</button></div>';
 return body+'</article>';
}
function chatThinking(index,live){
 const r=live?chat.request:chat.thoughts.get(chat.doc.id+':'+index);if(!r)return '';
 const thinking=r.thinking||'',seconds=Math.max(1,Math.round(((r.firstText||r.finishedAt||performance.now())-r.start)/1000));
 if(live&&!r.text)return '<div class="chat-thinking is-thinking" role="status"><span>正在想</span><div>'+esc(thinking||'正在读你说的话…')+'</div></div>';
 if(!thinking)return '';return '<details class="chat-thinking"'+(r.open?' open':'')+' data-thought="'+index+'"><summary>想了 '+seconds+' 秒</summary><div>'+esc(thinking)+'</div></details>';
}
function chatMessagesHTML(){
 const doc=chat.doc,last=doc.messages.map(m=>m.role).lastIndexOf('assistant');
 return doc.messages.map((m,i)=>{
  const live=chat.request?.doc===doc&&chat.request.index===i,parsed=m.role==='assistant'?chatParse(m.content,!live):null;
  let content=parsed?parsed.parts.map(p=>p.type==='text'?'<div class="ai-prose">'+esc(p.text)+'</div>':chatCardHTML(p,i+':'+p.index,live)).join(''):'<div class="ai-prose">'+esc(m.content)+'</div>';
  if(parsed&&i===last&&!live)content+='<div class="chat-asks">'+parsed.asks.map(t=>'<button type="button" class="chip" data-act="chatAsk" data-text="'+esc(t)+'">'+esc(t)+'</button>').join('')+'</div>';
  return '<article class="chat-message '+m.role+'" data-message="'+i+'">'+(m.ctx?'<span class="chat-context">带了 '+chatDateLabel(m.ctx.date)+' 的记录</span>':'')+(m.role==='assistant'?chatThinking(i,live):'')+content+(m.stopReason==='max_tokens'?'<p class="fine">回答到上限被截断了</p>':'')+(m.partial?'<p class="fine">这条回复未完成，已保留收到的文字。</p>':'')+'</article>';
 }).join('');
}
function vChat(){
 chatLoad();return '<section class="chat-page"><header class="chat-top"><button type="button" class="linkbtn" data-act="chatList">对话列表</button><button type="button" class="chat-title" data-act="chatRename">'+esc(chat.doc.title)+'</button><button type="button" class="linkbtn" data-act="chatNew">新对话</button></header><div id="chat-feed" tabindex="0" aria-label="聊天消息">'+(!ai.token||ai.needsToken?aiTokenCard():'')+(chat.doc.messages.length?chatMessagesHTML():'<div class="chat-empty"><span class="ai-eyebrow">和 Claude 聊聊</span><h1>从此刻想到的说起。</h1><p>不必先整理好。默认不会发送当天记录。</p>'+['有件事让我反复想，想和你理一理。','我发现自己有个重复的反应。','帮我把一个想法变成可以验证的小尝试。'].map(t=>'<button type="button" data-act="chatAsk" data-text="'+esc(t)+'">'+t+' <span>↗</span></button>').join('')+'</div>')+'</div><button type="button" id="chat-latest" class="chip" data-act="chatLatest"'+(chat.follow?' hidden':'')+'>回到最新 ↓</button><footer class="chat-composer">'+(chat.error?'<p class="ai-error" role="status">'+esc(chat.error)+(chat.doc.messages.at(-1)?.role==='user'?'<button type="button" class="linkbtn" data-act="chatRetry">重试</button>':'')+'</p>':'')+(chat.attachment?'<div class="chat-context">下一条带上 '+chatDateLabel(chat.attachment.date)+' 的记录 <button type="button" class="linkbtn" data-act="chatDetach">移除</button></div>':'')+'<div class="chat-input-row"><button type="button" class="icon-button" data-act="chatOptions" aria-label="添加记录和聊天设置">＋</button><label class="sr-only" for="chat-input">给 Claude 发消息</label><textarea id="chat-input" rows="1" placeholder="聊聊你想到的…">'+esc(chat.input)+'</textarea><button type="button" class="btn sm" data-act="'+(chat.request?'chatStop':'chatSend')+'">'+(chat.request?'停止':'发送')+'</button></div><p class="fine">'+(uiPrefs.chatHyps===false?'未发送假设清单':'会带上假设编号和文字')+' · <button type="button" class="linkbtn" data-act="chatOptions">设置</button></p></footer></section>';
}
function chatHydrate(){
 document.body.classList.toggle('chat-mode',route==='chat');const tab=$('[data-r="chat"]');if(tab)tab.hidden=!AI_ON;
 document.body.classList.toggle('has-chat',AI_ON);if(route!=='chat')return;
 const feed=$('#chat-feed');feed.addEventListener('scroll',()=>{chat.scrollTop=feed.scrollTop;chat.follow=feed.scrollHeight-feed.scrollTop-feed.clientHeight<90;$('#chat-latest').hidden=chat.follow;},{passive:true});chatSizeInput();
 const q=new URLSearchParams(location.hash.split('?')[1]||''),message=q.get('msg');
 if(message!==null&&chat.jump!==location.hash){chat.jump=location.hash;requestAnimationFrame(()=>$('#chat-feed [data-message="'+Number(message)+'"]')?.scrollIntoView({block:'start'}));}
 else feed.scrollTop=chat.follow?feed.scrollHeight:chat.scrollTop||0;
}
function chatPaint(){
 if(route!=='chat'||chat.request?.doc!==chat.doc)return;const feed=$('#chat-feed');if(!feed)return;
 const top=feed.scrollTop,follow=chat.follow,oldCards=new Set(Array.from(feed.querySelectorAll('[data-card-key]'),e=>e.dataset.cardKey));feed.innerHTML=chatMessagesHTML();feed.querySelectorAll('.chat-message').forEach(e=>e.style.animation='none');feed.querySelectorAll('[data-card-key]').forEach(e=>{if(oldCards.has(e.dataset.cardKey))e.style.animation='none';});const thinking=feed.querySelector('.is-thinking>div');if(thinking)thinking.scrollTop=thinking.scrollHeight;feed.scrollTop=follow?feed.scrollHeight:top;$('#chat-latest').hidden=follow;
}
function chatSizeInput(){const input=$('#chat-input');if(!input)return;input.style.height='auto';input.style.height=Math.min(128,input.scrollHeight)+'px';}
async function chatSend(text=chat.input,retry=false){
 if(!AI_ON||chat.request||ai.request||ai.hypRequest||!needReady())return;const doc=chatLoad(),question=String(text||'').trim();
 if(!retry&&!question)return;if(!navigator.onLine){chat.error=AI_ERRORS.offline;render(true);return;}
 if(!ai.token||ai.needsToken){chat.pending={text:question,retry};ai.needsToken=true;render(true);$('#ai-token')?.focus();return;}
 const user=retry?doc.messages.at(-1):{role:'user',content:question,at:new Date().toISOString(),...(chat.attachment?{ctx:{date:chat.attachment.date}}:{})};
 const turns=(retry?doc.messages:[...doc.messages,user]).map(m=>({role:m.role,content:m.content})).filter(m=>m.content.trim());
 const payload={messages:turns,...(uiPrefs.chatHyps===false?{}:{hyps:Object.values(S.hyps).map(h=>({no:h.no,text:hypText(h)}))}),...(chat.attachment?{materials:{date:chat.attachment.date,...chat.attachment.materials}}:{})};
 if(turns.length>200||new TextEncoder().encode(JSON.stringify(payload)).length>256*1024){chat.error='这次对话太长了，开一个新对话继续';render(true);return;}
 if(!retry){doc.messages.push(user);if(doc.title==='新对话')doc.title=[...question].slice(0,20).join('');}chat.input='';chat.error='';chat.follow=true;
 history.replaceState(null,'','#chat?id='+encodeURIComponent(doc.id));chatDraft(doc);
 const r={doc,index:doc.messages.length,ctl:new AbortController(),text:'',thinking:'',model:'',start:performance.now(),ended:false,stopReason:null};chat.request=r;
 const reply={role:'assistant',content:'',at:new Date().toISOString()};doc.messages.push(reply);const diagnostic=aiNewDiagnostic('/api/chat');
 let outcome='error',timedOut=false;const timer=setTimeout(()=>{timedOut=true;r.ctl.abort();},660000),release=aiKeepAwake(r);render(true);
 try{
  const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+ai.token},body:JSON.stringify(payload),signal:r.ctl.signal});aiReadHeaders(diagnostic,response);
  if(!response.ok){const j=await response.json().catch(()=>({}));throw {code:response.status===413?'chat_large':response.status===401?'unauthorized':j.error?.code||'upstream_error'};}
  if(!response.body||!response.headers.get('content-type')?.includes('text/event-stream'))throw {code:'upstream_error'};
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',lastPaint=0;
  const consume=raw=>{const data=raw.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data)return;const e=JSON.parse(data);aiStreamEvent(r,diagnostic,e);if(r.text&&!r.firstText)r.firstText=performance.now();reply.content=r.text;if(performance.now()-lastPaint>80){lastPaint=performance.now();chatPaint();doc.updated=new Date().toISOString();chatDraft(doc);}};
  try{for(;;){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let m;while((m=/\r?\n\r?\n/.exec(buffer))){consume(buffer.slice(0,m.index));buffer=buffer.slice(m.index+m[0].length);}}buffer+=decoder.decode();if(buffer.trim())consume(buffer);}finally{reader.releaseLock();}
  if(r.stopReason==='max_tokens'&&!r.text.trim())throw {code:'thinking_limit'};if(!r.text.trim()||!r.ended&&r.stopReason!=='max_tokens')throw {code:'upstream_error'};outcome='complete';
 }catch(e){if(chat.doc===doc)chat.error=r.stopped?'已停止，收到的文字已保留。':e.code==='chat_large'?'这次对话太长了，开一个新对话继续':e.code==='thinking_limit'?'这次想得太久，没来得及回答，请重试':AI_ERRORS[timedOut?'timeout':e.code]||'连接中断，收到的文字已保留。';if(e.code==='unauthorized')ai.needsToken=true;}
 finally{
  clearTimeout(timer);release();r.finishedAt=performance.now();r.ctl.abort();diagnostic.elapsed=r.finishedAt-r.start;chat.thoughts.set(doc.id+':'+r.index,r);
  reply.content=r.text;if(r.stopReason)reply.stopReason=r.stopReason;if(outcome!=='complete')reply.partial=true;if(!r.text.trim())doc.messages.pop();
  if(chat.doc===doc&&(outcome==='complete'||r.text))chat.attachment=null;
  try{await chatSave(doc);}catch{if(chat.doc===doc)chat.error='聊天没存成功，已保留草稿。请先保留这个页面。';chatDraft(doc);}
  if(chat.request===r)chat.request=null;if(route==='chat'&&chat.doc===doc)render(true);
 }
}
async function chatAddCard(key){
 const doc=chat.doc,card=chatCardAt(key),lock=doc.id+':'+key;if(!card||chat.request||chat.busy.has(lock)||doc.cards[key]?.status==='added'||!needReady())return;
 const edited=chat.edits.get(lock);if(edited!==undefined)card.text=edited.trim();if(!card.text||[...card.text].length>300){toast('请保留 1–300 字的文字。');return;}
 const duplicate=chatDuplicate(card);if(duplicate){doc.cards[key]={status:'added',type:card.type,text:card.text,existing:true,ref:card.type==='hyp'?{id:duplicate.id,no:duplicate.no}:{id:duplicate.id,date:card.date}};chat.edits.delete(lock);try{await chatSave(doc);}catch{chatDraft(doc);}render(true);return;}
 chat.busy.add(lock);render(true);let ref;
 try{
  const now=new Date().toISOString(),today=dayKey();
  if(card.type==='hyp'){const h=makeHyp({text:card.text,src:{type:'chat',chatId:doc.id,date:today}});ref={id:h.id,no:h.no};await chatPut('hyps',h.id,h);}
  else if(card.type==='pred'){const day=clone(getDay(card.date)),p={id:newId(),kind:'specific',text:card.text,hid:null,at:now,src:'chat',chatId:doc.id,result:'',actual:''};day.preds.push(p);ref={id:p.id,date:card.date};await chatPut('days',day.date,day);}
  else{const original=Object.values(S.hyps).find(h=>h.no===+card.no);if(!original){toast('找不到 H'+card.no);return;}const h=clone(original),id='chat:'+doc.id+':'+key;ref={id,hypId:h.id,no:h.no};if(!(h.ev||[]).some(e=>e.id===id)){h.ev=(h.ev||[]).concat({id,date:today,kind:card.kind,note:card.text,str:'weak',src:'chat:'+doc.id});h.updated=now;await chatPut('hyps',h.id,h);}}
  doc.cards[key]={status:'added',type:card.type,text:card.text,ref,undoUntil:Date.now()+10000};chat.edits.delete(lock);await chatSave(doc);
  setTimeout(()=>{if(chat.doc===doc&&route==='chat')render(true);},10100);
 }catch{chat.error='没有保存成功，请保留页面后重试。';chatDraft(doc);}finally{chat.busy.delete(lock);render(true);}
}
async function chatUndoCard(key){
 const doc=chat.doc,state=doc.cards[key],lock=doc.id+':'+key;if(!state||state.status!=='added'||state.existing||!Number.isFinite(state.undoUntil)||Date.now()>state.undoUntil||chat.busy.has(lock))return;chat.busy.add(lock);
 try{
  const ref=state.ref;
  if(state.type==='hyp'){if(S.hyps[ref.id]?.src?.chatId===doc.id)await chatRemove('hyps',ref.id);}
  else if(state.type==='pred'){const day=clone(getDay(ref.date));day.preds=day.preds.filter(p=>p.id!==ref.id);await chatPut('days',day.date,day);}
  else{const h=clone(S.hyps[ref.hypId]);if(h){h.ev=(h.ev||[]).filter(e=>e.id!==ref.id);await chatPut('hyps',h.id,h);}}
  state.status='undone';delete state.undoUntil;await chatSave(doc);
 }catch{chat.error='撤销没存成功，请保留页面重试。';chatDraft(doc);}finally{chat.busy.delete(lock);render(true);}
}
function chatGoto(type,ref){if(type==='pred'){sel=ref.date;chat.target={type,id:ref.id};location.hash='#pred?date='+ref.date;}else{ui.hypFilter='all';chat.target={type:'hyp',id:ref.hypId||ref.id};location.hash='#hyps';}}
function chatSourceLabel(type,item){
 const id=type==='hyp'&&item.src?.type==='chat'?item.src.chatId:type==='pred'&&item.src==='chat'?item.chatId:type==='ev'&&typeof item.src==='string'&&item.src.startsWith('chat:')?item.src.slice(5):null;if(!id)return '';
 const doc=S.meta['chat:'+id];if(!doc)return '<span class="fine chat-source">对话已删除</span>';
 const key=Object.keys(doc.cards||{}).find(k=>doc.cards[k].ref?.id===item.id),date=type==='hyp'?item.src.date:type==='ev'?item.date:ymd(new Date(item.at));
 return '<button type="button" class="linkbtn fine chat-source" data-act="chatSource" data-chat="'+esc(id)+'" data-msg="'+(key?Number(key.split(':')[0]):0)+'">来自 '+chatDateLabel(date)+' 的聊天</button>';
}
function chatStats(){const bytes=x=>new TextEncoder().encode(JSON.stringify(x)).length,docs=chatDocs(),size=bytes(docs),total=bytes(S),per=docs.length?size/docs.length:8192;return {count:docs.length,size,total,days:Math.max(0,Math.floor((3*1024*1024-total)/(2*per)))};}
function chatSettings(){if(!AI_ON)return '';const s=chatStats();return '<section class="card" id="settings-chat"><h2 class="stage">Claude 聊天</h2><p>聊天记录共 '+s.count+' 次、约 '+(s.size/1024).toFixed(1)+' KB</p><p class="fine">全部记录约 '+(s.total/1024).toFixed(1)+' KB。按每天 2 次、'+(s.count?'当前对话平均大小':'每次约 8 KB 的假设')+'估算，约 '+s.days+' 天达到 3 MB。</p>'+(s.total>3*1024*1024?'<p class="ai-error">总数据已超过 3 MB，请导出备份并清理不再需要的聊天；本机存储和云端同步都有容量上限。</p>':'')+'<label class="chat-toggle"><input type="checkbox" data-chat-hyps'+(uiPrefs.chatHyps!==false?' checked':'')+'>让 Claude 看到我的假设清单</label><p class="fine">只带编号和文字，不含证据。</p></section>';}
function chatListHTML(){const q=chat.search.trim().toLowerCase(),docs=chatDocs().filter(d=>!q||(d.title+' '+d.messages.map(m=>m.content).join(' ')).toLowerCase().includes(q));return docs.map(d=>'<article class="chat-list-item"><button type="button" data-act="chatOpen" data-id="'+esc(d.id)+'"><b>'+esc(d.title)+'</b><small>'+chatDateLabel(ymd(new Date(d.updated)))+' · '+d.messages.filter(m=>m.role==='assistant').length+' 轮 · 已加入 '+Object.values(d.cards||{}).filter(c=>c.status==='added'&&!c.existing).length+' 张卡片</small></button><div class="row"><button type="button" class="linkbtn" data-act="chatRename" data-id="'+esc(d.id)+'">改名</button><button type="button" class="linkbtn" data-act="chatDelete" data-id="'+esc(d.id)+'">删除</button></div></article>').join('')||'<p class="fine">'+(q?'没有找到相关对话。':'还没有保存的对话。')+'</p>';}
function chatShowList(){const d=$('#chat-list');d.innerHTML='<header class="row"><h2>对话列表</h2><button type="button" class="icon-button" data-act="chatListClose" aria-label="关闭对话列表">×</button></header><label class="sr-only" for="chat-search">搜索标题和内容</label><input id="chat-search" type="search" placeholder="搜索标题和内容" value="'+esc(chat.search)+'"><div id="chat-list-items">'+chatListHTML()+'</div>';d.showModal();}
function chatOptions(){const d=$('#chat-dialog');d.innerHTML='<h2>记录与聊天设置</h2><p class="fine">默认不发送当天记录。选中的材料只随下一条消息发送。</p><label for="chat-date">带上某一天的记录</label><input id="chat-date" type="date" value="'+dayKey()+'"><button type="button" class="btn" data-act="chatChooseDate">选择材料</button><label class="chat-toggle"><input type="checkbox" data-chat-hyps'+(uiPrefs.chatHyps!==false?' checked':'')+'>让 Claude 看到我的假设清单</label><p class="fine">只发送编号和文字，不含证据。</p><button type="button" class="linkbtn" data-act="chatDialogClose">关闭</button>';d.showModal();}
function chatRename(id=chat.doc?.id){const doc=id===chat.doc?.id?chat.doc:S.meta['chat:'+id];if(!doc)return;$('#chat-list').close();const d=$('#chat-dialog');d.innerHTML='<h2>给对话改个名字</h2><label for="chat-name">对话标题</label><input id="chat-name" maxlength="80" value="'+esc(doc.title)+'"><button type="button" class="btn" data-act="chatRenameSave" data-id="'+esc(doc.id)+'">保存</button><button type="button" class="linkbtn" data-act="chatDialogClose">取消</button>';d.showModal();}
function chatRoute(){
 if(chat.input)chatDraft();
 if(chat.request){chat.request.stopped=true;chat.request.ctl.abort();}for(const id of ['chat-list','chat-dialog'])if($('#'+id).open)$('#'+id).close();
 const q=new URLSearchParams(location.hash.split('?')[1]||'');if(route==='pred'&&validDate(q.get('date')))sel=q.get('date');
}
function chatRevealTarget(){if(!chat.target)return;const target=chat.target;chat.target=null;requestAnimationFrame(()=>{const attr=target.type==='pred'?'data-pred-id':'data-hyp-id',el=Array.from(document.querySelectorAll('['+attr+']')).find(e=>e.getAttribute(attr)===target.id);if(el){el.tabIndex=-1;el.focus({preventScroll:true});el.scrollIntoView({block:'center'});}});}
const CHAT_ACTIONS={
 chatSend(){chatSend();},chatRetry(){chatSend('',true);},chatStop(){if(chat.request){chat.request.stopped=true;chat.request.ctl.abort();}},chatAsk(el){chatSend(el.dataset.text);},
 chatLatest(){chat.follow=true;const feed=$('#chat-feed');feed.scrollTop=feed.scrollHeight;$('#chat-latest').hidden=true;},
 chatNew(){if(chat.request){toast('先停止当前回复，再开新对话。');return;}chat.doc=chatNewDoc();chat.input='';chat.attachment=null;chat.error='';history.replaceState(null,'','#chat?id='+encodeURIComponent(chat.doc.id));render(true);},
 chatList:chatShowList,chatListClose(){const d=$('#chat-list');d.classList.add('closing');setTimeout(()=>{d.close();d.classList.remove('closing');},200);},chatOpen(el){$('#chat-list').close();location.hash='#chat?id='+encodeURIComponent(el.dataset.id);},
 chatRename(el){chatRename(el.dataset.id||chat.doc.id);},async chatRenameSave(el){const title=$('#chat-name').value.trim();if(!title)return;const doc=el.dataset.id===chat.doc?.id?chat.doc:clone(S.meta['chat:'+el.dataset.id]);if(!doc)return;doc.title=title;try{if(doc.messages.length)await chatSave(doc);$('#chat-dialog').close();render(true);}catch{toast('改名没有保存成功。');}},
 chatDelete(el){const d=$('#chat-dialog');$('#chat-list').close();d.innerHTML='<h2>删除这次对话？</h2><p>已加入的假设、预测和证据会保留。</p><button type="button" class="btn" data-act="chatDeleteConfirm" data-id="'+esc(el.dataset.id)+'">删除对话</button><button type="button" class="linkbtn" data-act="chatDialogClose">取消</button>';d.showModal();},
 async chatDeleteConfirm(el){if(chat.request?.doc.id===el.dataset.id){toast('请先停止生成。');return;}try{await chatRemove('meta','chat:'+el.dataset.id);delete drafts['chat:'+el.dataset.id];saveDrafts();if(chat.doc?.id===el.dataset.id)chat.doc=null;$('#chat-dialog').close();history.replaceState(null,'','#chat');render(true);}catch{toast('删除没存成功。');}},
 chatOptions,chatDialogClose(){$('#chat-dialog').close();},chatChooseDate(){const date=$('#chat-date').value;if(!validDate(date))return;$('#chat-dialog').close();aiShowConsent('chat',{date});},chatDetach(){chat.attachment=null;render(true);},
 chatEdit(el){const key=el.dataset.key;if(chat.busy.has(chat.doc.id+':'+key))return;chat.edits.set(chat.doc.id+':'+key,chatCardAt(key).text);render(true);},chatAdd(el){chatAddCard(el.dataset.key);},chatUndo(el){chatUndoCard(el.dataset.key);},
 chatCardJump(el){const state=chat.doc.cards[el.dataset.key];if(state)chatGoto(state.type,state.ref);},chatExisting(el){const card=chatCardAt(el.dataset.key),item=chatDuplicate(card);if(item)chatGoto(card.type,card.type==='pred'?{id:item.id,date:card.date}:{id:item.id});},
 chatSource(el){location.hash='#chat?id='+encodeURIComponent(el.dataset.chat)+'&msg='+el.dataset.msg;}
};
document.addEventListener('input',e=>{if(e.target.id==='chat-input'){chat.input=e.target.value;chatSizeInput();chatDraft();}if(e.target.dataset.chatEdit)chat.edits.set(chat.doc.id+':'+e.target.dataset.chatEdit,e.target.value);if(e.target.id==='chat-search'){chat.search=e.target.value;$('#chat-list-items').innerHTML=chatListHTML();}});
document.addEventListener('change',e=>{if(e.target.hasAttribute('data-chat-hyps')){uiPrefs.chatHyps=e.target.checked;saveUIPrefs();}});
document.addEventListener('keydown',e=>{if(e.target.id==='chat-input'&&(e.ctrlKey||e.metaKey)&&e.key==='Enter'&&!e.isComposing){e.preventDefault();chatSend();}});
document.addEventListener('toggle',e=>{if(e.target.dataset.thought!==undefined){const i=+e.target.dataset.thought,r=chat.request?.index===i?chat.request:chat.thoughts.get(chat.doc.id+':'+i);if(r)r.open=e.target.open;}},true);
window.addEventListener('pagehide',()=>{if(chat.request){chatDraft();chat.request.stopped=true;chat.request.ctl.abort();}else if(chat.input)chatDraft();});
