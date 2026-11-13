/* AI UI is embedded in index.html; no external runtime script or real-key mock. */
const AI_ERRORS={bad_request:'这次没发出去，刷新后再试。',unauthorized:'访问口令不对，请在这里重新输入。',forbidden:'这次没发出去，刷新后再试。',too_large:'内容太长了，少勾选几项再试。',rate_limited:'点得太快了，等一分钟。',quota_exceeded:'今天的 AI 额度用完了，明天再试。',upstream_error:'AI 服务暂时连不上。',timeout:'等太久了，可能是网络慢。',not_configured:'AI 尚未完成配置。',offline:'需要联网后才能和 Claude 聊一聊。'};
const AI_GROUPS=[['review','当天复盘'],['preds','预测'],['caps','随手记'],['events','单件复盘'],['archives','对话存档'],['hyps','当天关联的假设']];
const ai={sessions:new Map(),date:null,token:'',needsToken:false,models:null,request:null,pending:null,confirm:null,texts:new Map(),diag:null,authBusy:false,authMessage:'',settingsEdit:false};
try{ai.token=JSON.parse(localStorage.getItem('zwgcb-ai')||'{}').token||'';}catch{}
function aiSession(k=ai.date){
 if(!ai.sessions.has(k)){
  const saved=drafts['ai-explore:'+k]||{},messages=Array.isArray(saved.messages)?saved.messages.filter(m=>['user','assistant'].includes(m.role)&&typeof m.content==='string'):[];
  let input=typeof saved.input==='string'?saved.input:'';if(messages.at(-1)?.role==='user'&&!input)input=messages.pop().content;
  ai.sessions.set(k,{date:k,tab:'summary',messages,input,materials:saved.materials||null,selection:saved.selection||null,contextSummary:saved.contextSummary||'',roundModel:saved.model||'',roundId:saved.id||newId(),consent:null,summaryPreview:null,summaryNotice:'',exploreNotice:messages.length||input?'已恢复本机草稿':'',summaryError:'',exploreError:'',retry:null,tokens:0});
 }
 return ai.sessions.get(k);
}
function aiSelection(){return Object.assign({review:true,preds:true,caps:true,events:false,archives:false,hyps:false},uiPrefs.aiMaterials||{});}
function aiReviewText(d){
 const e=d.evening;if(!e)return '';const r=e.raw||{},lines=[],add=(label,value)=>{if(value)lines.push(label+'：'+String(value));};
 if(e.mode==='min'){add('不一样的一刻',r.q1);add('在乎的',r.q2);}
 else{const a=r.A||{},c=r.C||{},next=r.E||{};add('时间最多的三块',[a.b0,a.b1,a.b2].filter(Boolean).join(' / '));add('主动做的事',a.self);add('意外回看',r.surprise);[['那一刻','fact'],['脑子里的原话','quote'],['身体感觉','body'],['做了什么','did'],['在乎的','care'],['第三人称回看','third']].forEach(([l,f])=>add(l,c[f]));add('明天留意',next.watch);add('明天的预测',next.tmr);}
 add('写下的假设',e.D&&e.D.text);return lines.join('\n');
}
function aiGroups(k){
 const d=S.days[k]||newDay(k),evs=eventsOn(k),arcs=archivesOn(k),ids=new Set();
 (d.preds||[]).forEach(p=>{if(p.hid)ids.add(p.hid);});(d.caps||[]).forEach(c=>{if(c.hyp)ids.add(c.hyp);});
 if(d.evening&&d.evening.D&&d.evening.D.hid)ids.add(d.evening.D.hid);evs.forEach(e=>{if(e.Dres&&e.Dres.hid)ids.add(e.Dres.hid);});
 const hyps=Object.values(S.hyps).filter(h=>ids.has(h.id)||(h.ev||[]).some(e=>e.date===k));
 return {review:aiReviewText(d),preds:(d.preds||[]).map(p=>({text:p.text||'',result:p.result||'',actual:p.actual||''})),caps:(d.caps||[]).filter(c=>captureVisible(k,c)).map(c=>({time:hm(c.at),fact:c.fact||'',emos:c.emos||[],inten:c.inten||0,quote:c.quote||'',care:c.care||''})),events:evs.map(eventText).join('\n\n'),archives:arcs.map(a=>{const x=a.data||{},s=x.summary||{},deep=x.deep_dive||{};return [s.headline,...(s.points||[]),deep.moment,...(deep.timeline||[]),...(x.open_questions||[])].filter(Boolean).join('\n');}).join('\n\n'),hyps:hyps.map(h=>({no:h.no||0,text:hypText(h),sup:evCount(h,'sup'),con:evCount(h,'con')}))};
}
function aiMaterials(k,selection){
 const g=aiGroups(k),parts=[];['review','events','archives'].forEach(key=>{if(selection[key]&&g[key])parts.push(AI_GROUPS.find(x=>x[0]===key)[1]+'\n'+g[key]);});
 return {review:parts.join('\n\n'),preds:selection.preds?g.preds:[],caps:selection.caps?g.caps:[],hyps:selection.hyps?g.hyps:[]};
}
function aiMaterialLabel(s){
 if(s.materials){const m=s.materials;return [m.review?'当天文字材料':'',m.preds.length?'预测 '+m.preds.length+' 条':'',m.caps.length?'随手记 '+m.caps.length+' 条':'',m.hyps.length?'当天关联假设 '+m.hyps.length+' 条':''].filter(Boolean).join('、')+'（本轮已固定）';}
 const selection=s.selection||aiSelection(),g=aiGroups(s.date);return AI_GROUPS.filter(([key])=>selection[key]&&(typeof g[key]==='string'?g[key].length:g[key].length)).map(([key,label])=>label+(Array.isArray(g[key])?' '+g[key].length+' 条':'')).join('、')||'尚未选择材料';
}
function aiSaveDraft(s){
 if(!s.messages.length&&!s.input){delete drafts['ai-explore:'+s.date];return saveDrafts();}
 const live=ai.request&&ai.request.session===s&&ai.request.mode==='explore'&&!ai.request.finished?ai.request.text:'';
 drafts['ai-explore:'+s.date]={id:s.roundId,messages:clone(s.messages).concat(live?[{role:'assistant',content:live}]:[]),input:s.input,materials:clone(s.materials),selection:clone(s.selection),contextSummary:s.contextSummary,model:s.roundModel};
 const ok=saveDrafts();if(!ok)s.exploreNotice='草稿未存成功，请先保留页面。';return ok;
}
function aiHasRecords(k){const d=S.days[k]||{};return !!(d.evening||(d.preds||[]).length||(d.caps||[]).length||eventsOn(k).length||archivesOn(k).length||d.ai);}
function aiEntry(k){
 if(!aiHasRecords(k))return '';const saved=(S.days[k]||{}).ai||{},count=(saved.explores||[]).length,status=(saved.summary?'已总结':'还没总结')+(count?' · 探索 '+count+' 次':'');
 return '<button type="button" class="ai-entry" data-act="aiOpen" data-key="'+k+'"'+(!navigator.onLine?' disabled':'')+'><span>和 Claude 聊一聊</span><small>'+(!navigator.onLine?'需要联网':!saved.summary&&!count?'还没聊过':status)+'</small><span aria-hidden="true">›</span></button>';
}
function aiTextSlot(id,text,cls=''){ai.texts.set(id,String(text||''));return '<div class="ai-prose '+cls+'" id="'+id+'"></div>';}
function aiSummaryBlock(k){const saved=(S.days[k]||{}).ai&&S.days[k].ai.summary;if(!saved||!saved.text)return '';return '<button type="button" class="ai-summary-link" data-act="aiOpen" data-key="'+k+'" aria-label="阅读 AI 总结"><span class="ai-eyebrow">Claude 的总结'+(saved.stopped?' · 已停止':'')+'</span>'+aiTextSlot('ai-card-summary',saved.text,'ai-six-lines')+'<span class="ai-summary-foot">读完整总结 <span aria-hidden="true">›</span></span></button>';}
function aiParagraphs(el,text){if(!el)return;const fragment=document.createDocumentFragment();String(text||'').split(/\n\s*\n/).forEach(part=>{const p=document.createElement('p');p.textContent=part;fragment.append(p);});el.replaceChildren(fragment);}
function aiHydrate(){ai.texts.forEach((text,id)=>aiParagraphs(document.getElementById(id),text));if(route==='ai')aiPaint();}
function aiPaint(){
 const r=ai.request;if(!r||route!=='ai'||r.session.date!==ai.date)return;const el=$('#ai-live-'+r.mode);if(!el)return;
 const near=window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-160;aiParagraphs(el,r.text);el.classList.toggle('is-streaming',true);
 if(near&&r.mode==='explore')$('#ai-stream-anchor')?.scrollIntoView({block:'nearest',behavior:'auto'});
}
function aiRender(){render(true);}
function aiEnter(k,tab='summary'){
 if(!validDate(k))return;if(ai.request)ai.request.ctl.abort();ai.date=k;aiSession(k).tab=tab;sel=k;
 const hash='#ai?day='+k;if(location.hash===hash){route='ai';aiRender();}else location.hash=hash;
}
function aiTokenCard(){return '<section class="card ai-token"><span class="ai-eyebrow">先连接，再慢慢聊</span><h2>只需输入一次访问口令</h2><p class="fine">保存在这台设备，不进入数据导出或云端同步。</p><label for="ai-token">访问口令</label><div class="ai-token-row"><input id="ai-token" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="输入你设置的口令"><button type="button" class="btn" data-act="aiTokenSave"'+(ai.authBusy?' disabled':'')+'>'+(ai.authBusy?'正在测试…':'保存并测试')+'</button></div>'+(ai.authMessage?'<p class="ai-error" role="status">'+esc(ai.authMessage)+'</p>':'')+'</section>';}
function aiErrorHTML(s,mode){const message=s[mode+'Error'];return message?'<div class="ai-error" role="status">'+esc(message)+(mode==='summary'?'<button type="button" class="linkbtn" data-act="aiGenerate">重试</button>':'')+'</div>':'';}
function aiMaterialLine(s){return '<p class="ai-material-line">将发送：'+esc(aiMaterialLabel(s))+' <button type="button" class="linkbtn" data-act="aiMaterials">修改</button></p>';}
function aiSummaryView(s){
 const old=(S.days[s.date]||{}).ai&&S.days[s.date].ai.summary,r=ai.request&&ai.request.session===s&&ai.request.mode==='summary'?ai.request:null;
 let html='<section class="ai-summary-pane" aria-label="总结">';
 if(r)html+='<p class="ai-eyebrow">正在把这一天连起来</p>'+aiTextSlot('ai-live-summary',r.text,'is-streaming')+'<button type="button" class="btn ghost" data-act="aiStop">停止</button>'+(old?'<p class="fine">完整生成后才会替换上次总结。</p>':'');
 else if(old&&old.text)html+='<p class="ai-eyebrow">从今天的材料里，看见一点线索</p>'+aiTextSlot('ai-saved-summary',old.text)+'<p class="ai-generated">'+md(s.date)+' · '+hm(old.at)+' 生成'+(old.stopped?' · 已停止':'')+'</p><div class="ai-summary-actions"><button type="button" class="btn" data-act="aiToExplore">带着总结去探索 <span aria-hidden="true">↗</span></button><button type="button" class="btn ghost" data-act="aiGenerate"'+(ai.request?' disabled':'')+'>重新生成</button></div>';
 else html+='<div class="ai-empty"><span class="ai-date-note">'+md(s.date)+' · 给这一天留一点回声</span><h2>把零散的片段，<br>连成一条线。</h2><p>从你选的记录里，回看发生了什么、<br>什么值得再观察。不急着给自己下结论。</p><button type="button" class="btn" data-act="aiGenerate"'+(ai.request||!navigator.onLine?' disabled':'')+'>生成总结 <span aria-hidden="true">↗</span></button></div>';
 if(!r&&s.summaryPreview)html+='<details class="ai-partial"'+disclosureAttrs('ai:partial:'+s.date)+'><summary>本次未完成的文字</summary>'+aiTextSlot('ai-summary-partial',s.summaryPreview)+'</details>';
 if(s.summaryNotice)html+='<p class="fine" role="status">'+esc(s.summaryNotice)+'</p>';
 return html+aiErrorHTML(s,'summary')+aiMaterialLine(s)+'</section>';
}
function aiExploreView(s){
 const r=ai.request&&ai.request.session===s&&ai.request.mode==='explore'?ai.request:null,saved=(S.days[s.date]||{}).ai||{},history=saved.explores||[];
 let h='<section class="ai-explore-pane" aria-label="探索">';
 if(!s.messages.length){h+='<div class="ai-explore-intro"><p class="ai-eyebrow">不用一次想明白</p><h2>从一个小问题开始。</h2><p class="fine">'+(saved.summary?'会带上当天的总结，和你选的材料一起聊。':'会从你选的当天材料出发，一次只聊一个问题。')+'</p><div class="ai-starters">'+['哪条预测的落空，最值得再看一眼？','有没有一个小细节，和我对自己的判断不同？','明天可以做什么小尝试，验证今天的发现？'].map((q,i)=>'<button type="button" data-act="aiStarter" data-v="'+i+'"><span>'+q+'</span><span aria-hidden="true">↗</span></button>').join('')+'</div></div>';}
 h+='<div class="ai-messages">'+s.messages.map((m,i)=>'<article class="ai-message '+m.role+'"><span class="ai-eyebrow">'+(m.role==='user'?'我':'Claude')+'</span>'+aiTextSlot('ai-message-'+i,m.content)+'</article>').join('')+(r?'<article class="ai-message assistant"><span class="ai-eyebrow">Claude · 正在想</span>'+aiTextSlot('ai-live-explore',r.text,'is-streaming')+'</article>':'')+'</div><div id="ai-stream-anchor"></div>';
 if(s.tokens>=30000||s.messages.length>=58)h+='<p class="ai-error">这轮内容已经很长了。先保存，再开新一轮继续探索。</p>';
 if(s.exploreNotice)h+='<p class="fine" role="status">'+esc(s.exploreNotice)+'</p>';
 h+=aiErrorHTML(s,'explore');
 h+='<div class="ai-composer"><label class="sr-only" for="ai-question">继续探索</label><textarea id="ai-question" rows="2" placeholder="写下你的想法，或一个还没想清楚的问题…"'+(r?' disabled':'')+'>'+esc(s.input)+'</textarea><div class="ai-compose-tools"><span class="fine">仅本机草稿</span><button type="button" class="btn" data-act="'+(r?'aiStop':'aiSend')+'"'+(!r&&(ai.request||!navigator.onLine)?' disabled':'')+'>'+(r?'停止':s.retry&&!s.input?'重试这次追问':'发送')+'</button></div></div>'+aiMaterialLine(s);
 if(s.messages.length)h+='<div class="ai-round-actions"><button type="button" class="btn ghost" data-act="aiSaveExplore"'+(ai.request?' disabled':'')+'>保存这次探索</button><button type="button" class="linkbtn" data-act="aiNewRound"'+(ai.request?' disabled':'')+'>开新一轮</button></div>';
 const historyHTML=history.length?history.slice().reverse().map((x,i)=>'<article class="ai-history-item"><div class="row"><span class="fine">'+md(s.date)+' · '+hm(x.at)+' · '+x.messages.filter(m=>m.role==='user').length+' 次追问</span><button type="button" class="linkbtn" data-act="aiDeleteExplore" data-id="'+esc(x.id)+'">删除</button></div>'+x.messages.map((m,j)=>'<div class="ai-message '+m.role+'"><span class="ai-eyebrow">'+(m.role==='user'?'我':'Claude')+'</span>'+aiTextSlot('ai-history-'+i+'-'+j,m.content)+'</div>').join('')+'</article>').join(''):'<p class="fine">保存后，这一轮会收进当天记录。</p>';
 return h+foldHTML('ai:history:'+s.date,'ai-history','之前的探索（'+history.length+'）',historyHTML,{close:'收起之前的探索（'+history.length+'）',className:'ai-history'})+'</section>';
}
function vAI(){
 if(!ai.date){const k=new URLSearchParams(location.hash.split('?')[1]||'').get('day');ai.date=validDate(k)?k:sel;}const s=aiSession();
 return '<div class="ai-page"><div class="ai-tabs" role="tablist" aria-label="聊天方式">'+[['summary','总结'],['explore','探索']].map(([key,label])=>'<button type="button" role="tab" aria-selected="'+(s.tab===key)+'" data-act="aiTab" data-v="'+key+'">'+label+'</button>').join('')+'</div>'+(!navigator.onLine?'<p class="ai-error" role="status">需要联网。已有内容仍可阅读。</p>':'')+(!ai.token||ai.needsToken?aiTokenCard():'')+(ai.request&&ai.request.mode!==s.tab?'<p class="fine">'+(ai.request.mode==='summary'?'总结':'探索')+'正在生成 <button type="button" class="linkbtn" data-act="aiStop">停止</button></p>':'')+(s.tab==='summary'?aiSummaryView(s):aiExploreView(s))+'</div>';
}
function aiPrepareShell(){
 const active=route==='ai';document.body.classList.toggle('ai-mode',active);$('#ai-shell').hidden=!active;if(!active)return;
 document.body.classList.add('writing-mode');$('#writing-shell').hidden=true;$('#ai-title').textContent='和 Claude 聊一聊 · '+md(ai.date);$('#day-shell').hidden=true;$('#week-shell').hidden=true;
}
function aiDomain(value){return typeof value==='string'&&value.length<=253&&/^[a-z0-9.-]+$/i.test(value)?value:'—';}
function aiDiagnostics(){
 const d=ai.diag;if(!d)return '<p class="fine">还没有请求记录。诊断仅在本次打开期间保留。</p>';
 const rows=[['接口',d.endpoint],['HTTP 状态',d.status??'未收到响应'],['耗时',(d.elapsed/1000).toFixed(1)+' 秒'],['收到结束事件',d.ended?'是':'否'],['input_tokens',d.input_tokens??'未提供'],['output_tokens',d.output_tokens??'未提供'],['cache_read_input_tokens',d.cache_read_input_tokens??'未提供'],['实际节点',d.node==='primary'?'主节点':d.node==='backup'?'备用节点':'未提供 / 未调用'],['发生跳转',d.redirected?'是':'否'],['跳转后的域名',d.redirected?aiDomain(d.domain):'—']];
 return '<dl class="ai-diagnostics">'+rows.map(([label,value])=>'<dt>'+label+'</dt><dd>'+esc(value)+'</dd>').join('')+'</dl><p class="fine">只存在内存，刷新即清空；不进入导出或同步。</p>';
}
function aiSettings(){return '<section class="card" id="settings-ai"><h2 class="stage">AI</h2><p class="fine">'+(ai.models?'总结：'+esc(ai.models.summary)+'<br>探索：'+esc(ai.models.explore):'模型：测试连接后显示')+'</p><div class="row"><button type="button" class="btn ghost sm" data-act="aiEditToken">修改口令</button><button type="button" class="btn ghost sm" data-act="aiHealth"'+(ai.authBusy?' disabled':'')+'>'+(ai.authBusy?'正在测试…':'测试连接')+'</button></div>'+(ai.settingsEdit?aiTokenCard():ai.authMessage?'<p class="fine" role="status">'+esc(ai.authMessage)+'</p>':'')+foldHTML('ai:diagnostic','ai-diagnostic','诊断信息',aiDiagnostics(),{close:'收起诊断信息'})+'</section>';}
function aiNewDiagnostic(endpoint){return ai.diag={endpoint,status:null,elapsed:0,ended:false,input_tokens:null,output_tokens:null,cache_read_input_tokens:null,node:null,redirected:false,domain:null};}
function aiReadHeaders(d,r){d.status=r.status;const node=r.headers.get('x-ai-node');d.node=['primary','backup'].includes(node)?node:null;d.redirected=r.headers.get('x-ai-redirected')==='true';d.domain=d.redirected?aiDomain(r.headers.get('x-ai-redirect-domain')):null;}
function aiReadUsage(d,usage){if(!usage)return;['input_tokens','output_tokens','cache_read_input_tokens'].forEach(key=>{if(Number.isFinite(usage[key])&&usage[key]>=0)d[key]=usage[key];});}
async function aiHealth(saveToken=false){
 if(ai.authBusy||ai.request)return;if(!navigator.onLine){ai.authMessage=AI_ERRORS.offline;aiRender();return;}
 const value=saveToken?($('#ai-token')?.value||'').trim():ai.token;if(!value){ai.settingsEdit=true;ai.needsToken=true;ai.authMessage='请先输入访问口令。';aiRender();return;}
 ai.authBusy=true;ai.authMessage='';const d=aiNewDiagnostic('/api/health'),start=performance.now();aiRender();
 try{
  const r=await fetch('/api/health',{headers:{Authorization:'Bearer '+value},cache:'no-store',signal:AbortSignal.timeout(20000)});aiReadHeaders(d,r);
  if(!r.ok){const j=await r.json().catch(()=>({}));throw {code:r.status===401?'unauthorized':j.error?.code||'upstream_error'};}
  const j=await r.json();if(!j.ok)throw {code:'upstream_error'};
  if(saveToken){try{localStorage.setItem('zwgcb-ai',JSON.stringify({token:value}));}catch{ai.authMessage='口令未能存入本机，请检查浏览器存储设置。';return;}}
  ai.token=value;ai.needsToken=false;ai.settingsEdit=false;ai.models=j.models||null;ai.authMessage='连接正常。';
 }catch(e){if(e.code==='unauthorized'){ai.needsToken=true;ai.settingsEdit=true;}ai.authMessage=AI_ERRORS[e.code]||AI_ERRORS[e.name==='TimeoutError'?'timeout':'upstream_error'];}
 finally{d.elapsed=performance.now()-start;ai.authBusy=false;aiRender();}
 if(!ai.needsToken&&ai.pending&&route==='ai'){const pending=ai.pending;ai.pending=null;if(pending.date===ai.date)aiPrepare(pending.mode);}
}
function aiComposeContext(s){return {selection:s.selection||aiSelection(),materials:s.materials||aiMaterials(s.date,aiSelection())};}
function aiHasMaterial(m){return !!(m.review.trim()||m.preds.length||m.caps.length||m.hyps.length);}
function aiShowConsent(mode=null){
 const s=aiSession(),ctx=aiComposeContext(s),g=aiGroups(s.date),locked=!!s.materials;
 ai.confirm={mode,selection:clone(ctx.selection)};const dialog=$('#ai-confirm');
 dialog.innerHTML='<header class="row"><div><p class="ai-eyebrow">'+md(s.date)+' · 仅这一天</p><h2 id="ai-confirm-title">这次发给 Claude 的内容</h2></div><button type="button" class="icon-button" data-act="aiConsentCancel" aria-label="关闭发送确认">×</button></header><p class="fine">由你选择；本机其他日期的记录不会发送。</p><div class="ai-checklist">'+AI_GROUPS.map(([key,label])=>'<label><input type="checkbox" data-ai-check="'+key+'"'+(ctx.selection[key]?' checked':'')+(locked||!g[key].length?' disabled':'')+'><span>'+label+'</span><small>'+(!g[key].length?'无记录':Array.isArray(g[key])?g[key].length+' 条':'已写')+'</small></label>').join('')+'</div>'+(locked?'<p class="fine">这轮材料已固定。保存后开新一轮，才能更换材料。</p>':'')+'<details class="ai-preview"><summary>查看实际发送的文字</summary><div id="ai-material-preview" class="ai-prose"></div></details><p class="ai-error" id="ai-consent-error" role="status"></p><button type="button" class="btn" data-act="aiConsentAccept">'+(mode?'确认并发送':'保存选择')+'</button>';
 aiPreviewConsent();dialog.showModal();
}
function aiPreviewConsent(){const s=aiSession(),m=s.materials||aiMaterials(s.date,ai.confirm.selection);let text=JSON.stringify({date:s.date,materials:m},null,2);if(ai.confirm.mode==='explore')text+='\n\n已有总结：\n'+(s.materials?s.contextSummary:((S.days[s.date]||{}).ai?.summary?.text||''))+'\n\n本轮对话：\n'+s.messages.map(x=>(x.role==='user'?'我':'Claude')+'：'+x.content).join('\n\n')+'\n\n我：'+(s.input||s.retry?.question||'');$('#ai-material-preview').textContent=text;}
function aiSignature(s,ctx){return JSON.stringify({date:s.date,selection:ctx.selection,materials:ctx.materials});}
function aiPrepare(mode){
 const s=aiSession();if(ai.request||ai.authBusy)return;s[mode+'Error']='';
 if(!navigator.onLine){s[mode+'Error']=AI_ERRORS.offline;aiRender();return;}
 if(mode==='explore'&&!s.input.trim()&&!s.retry){s.exploreError='写下一点想法，再发给 Claude。';aiRender();$('#ai-question')?.focus();return;}
 if(mode==='explore'&&(s.tokens>=30000||s.messages.length>=58)){s.exploreError='这轮内容已经很长了，保存后开新一轮吧。';aiRender();return;}
 if(!ai.token||ai.needsToken){ai.pending={date:s.date,mode};ai.needsToken=true;aiRender();$('#ai-token')?.focus();return;}
 const ctx=aiComposeContext(s);if(!aiHasMaterial(ctx.materials)){aiShowConsent(mode);return;}
 if(s.consent!==aiSignature(s,ctx)){aiShowConsent(mode);return;}
 aiRun(mode,s,ctx);
}
async function aiStoreDay(day){await put('days',day.date,day);if(mode==='local'&&JSON.stringify(lsRead()?.days?.[day.date]?.ai)!==JSON.stringify(day.ai))throw Error('local-save');}
async function aiPersistSummary(s,text,model,stopped){const day=getDay(s.date);day.ai=Object.assign({},day.ai,{summary:{text,at:new Date().toISOString(),model:model||ai.models?.summary||'',stopped}});await aiStoreDay(day);}
async function aiRun(mode,s,ctx){
 let payload={date:s.date,materials:clone(ctx.materials)},baseMessages=null,question='';
 if(mode==='explore'){
  const retry=!s.input.trim()&&s.retry;baseMessages=clone(retry?s.retry.base:s.messages);question=retry?s.retry.question:s.input.trim();
  if(baseMessages.at(-1)?.role==='user')baseMessages.pop();
  payload.summary=s.materials?s.contextSummary:((S.days[s.date]||{}).ai?.summary?.text||'');payload.messages=[...baseMessages,{role:'user',content:question}];
 }
 if(new TextEncoder().encode(JSON.stringify(payload)).length>65536){s[mode+'Error']=AI_ERRORS.too_large;aiRender();return;}
 const r={mode,session:s,ctl:new AbortController(),text:'',model:'',start:performance.now(),stopped:false,ended:false,frame:null};ai.request=r;
 const diagnostic=aiNewDiagnostic('/api/'+mode);s[mode+'Error']='';s[mode+'Notice']='';
 if(mode==='explore'){s.materials=clone(ctx.materials);s.selection=clone(ctx.selection);s.contextSummary=payload.summary;s.messages=clone(payload.messages);s.input='';s.retry=null;aiSaveDraft(s);}else s.summaryPreview=null;
 aiRender();let outcome='error',timeout=false;
 const timer=setTimeout(()=>{timeout=true;r.ctl.abort();},240000);
 try{
  const response=await fetch('/api/'+mode,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+ai.token},body:JSON.stringify(payload),signal:r.ctl.signal});aiReadHeaders(diagnostic,response);
  if(!response.ok){const j=await response.json().catch(()=>({}));throw {code:response.status===401?'unauthorized':j.error?.code||'upstream_error'};}
  if(!response.body||!response.headers.get('content-type')?.includes('text/event-stream'))throw {code:'upstream_error'};
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  const consume=raw=>{
   const data=raw.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data)return;let event;try{event=JSON.parse(data);}catch{throw {code:'upstream_error'};}
   if(event.type==='message_start'){r.model=typeof event.message?.model==='string'?event.message.model:'';r.createdTokens=Number(event.message?.usage?.cache_creation_input_tokens)||0;aiReadUsage(diagnostic,event.message?.usage);}
   if(event.type==='message_delta')aiReadUsage(diagnostic,event.usage);
   if(event.type==='message_stop'){r.ended=true;diagnostic.ended=true;}
   if(event.type==='error')throw {code:'upstream_error'};
   if(event.type==='content_block_delta'&&event.delta?.type==='text_delta'&&typeof event.delta.text==='string'){
    r.text+=event.delta.text;if(!r.frame)r.frame=requestAnimationFrame(()=>{r.frame=null;aiPaint();});
    if(mode==='explore'&&!r.draftTimer)r.draftTimer=setTimeout(()=>{r.draftTimer=null;aiSaveDraft(s);},300);
   }
  };
  try{for(;;){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let match;while((match=/\r?\n\r?\n/.exec(buffer))){consume(buffer.slice(0,match.index));buffer=buffer.slice(match.index+match[0].length);}}buffer+=decoder.decode();if(buffer.trim())consume(buffer);}
  finally{reader.releaseLock();}
  if(!r.ended||!r.text)throw {code:'upstream_error'};outcome='complete';
 }catch(e){
  if(r.stopped)outcome='stopped';else{
   s[mode+'Error']=r.text?'中途断了。已保留屏幕上的文字，可以重试。':AI_ERRORS[timeout?'timeout':e.code]||AI_ERRORS.upstream_error;
   if(e.code==='unauthorized'){ai.needsToken=true;ai.pending={date:s.date,mode};ai.authMessage=AI_ERRORS.unauthorized;}
  }
 }finally{
  clearTimeout(timer);clearTimeout(r.draftTimer);cancelAnimationFrame(r.frame);r.finished=true;r.ctl.abort();diagnostic.elapsed=performance.now()-r.start;
  if(mode==='summary'){
   const previous=(S.days[s.date]||{}).ai?.summary;
   if(outcome==='complete'||outcome==='stopped'&&!previous&&r.text){try{await aiPersistSummary(s,r.text,r.model,outcome==='stopped');}catch{s.summaryError='总结没存成功，请先保留这个页面。';s.summaryPreview=r.text;}}
   else if(r.text)s.summaryPreview=r.text;
   if(outcome==='stopped')s.summaryNotice=previous?'已停止，保留上次总结。':'已停止。';
  }else{
   // A 401 sent no material upstream. Restore the draft so reauthentication can resume once.
   if(diagnostic.status===401){s.messages=baseMessages;s.input=question;}
   else{if(r.text)s.messages.push({role:'assistant',content:r.text});if(outcome!=='complete')s.retry={base:baseMessages,question};}
   s.roundModel=r.model||s.roundModel;s.tokens=(diagnostic.input_tokens||0)+(diagnostic.cache_read_input_tokens||0)+(r.createdTokens||0);s.exploreNotice=outcome==='stopped'?'已停止，文字留在本机草稿。':'草稿已存 · '+hm(new Date());aiSaveDraft(s);
  }
  if(ai.request===r)ai.request=null;if(route==='ai'&&ai.date===s.date)aiRender();
 }
}
async function aiSaveExplore(){
 const s=aiSession();if(ai.request)return false;if(!s.messages.some(m=>m.role==='assistant')){s.exploreError='还没有可保存的回复。';aiRender();return false;}
 const day=getDay(s.date),old=day.ai||{};day.ai=Object.assign({},old,{explores:[...(old.explores||[]).filter(x=>x.id!==s.roundId),{id:s.roundId,at:new Date().toISOString(),model:s.roundModel,messages:s.messages.map(m=>({role:m.role,content:m.content}))}]});
 try{await aiStoreDay(day);}catch{s.exploreError='这次探索没存成功，请先保留草稿。';aiRender();return false;}
 const unsent=s.input;delete drafts['ai-explore:'+s.date];saveDrafts();aiResetRound(s);if(unsent){s.input=unsent;aiSaveDraft(s);}toast('这次探索已收进当天记录。');aiRender();return true;
}
function aiResetRound(s){Object.assign(s,{messages:[],input:'',materials:null,selection:null,contextSummary:'',roundId:newId(),roundModel:'',retry:null,tokens:0,exploreError:'',exploreNotice:''});delete drafts['ai-explore:'+s.date];saveDrafts();}
function aiDialogClose(){const d=$('#ai-confirm');if(d.open)d.close();ai.confirm=null;}
function aiNewRound(){
 const s=aiSession();if(ai.request)return;if(!s.messages.length&&!s.input){aiResetRound(s);aiRender();return;}
 const canSave=s.messages.some(m=>m.role==='assistant');ai.confirm={newRound:true};const d=$('#ai-confirm');d.innerHTML='<h2 id="ai-confirm-title">先收好这一轮？</h2><p class="fine">'+(canSave?'保存后可在“之前的探索”里阅读；新一轮会重新选择材料。':'还没收到回复，输入已保存在本机草稿。可以继续这一轮，或放下它重新开始。')+'</p><div class="ai-dialog-actions"><button type="button" class="btn" data-act="aiSaveAndNew"'+(canSave?'':' disabled')+'>保存并开新一轮</button><button type="button" class="btn ghost" data-act="aiDiscardRound">不保存，开新一轮</button><button type="button" class="linkbtn" data-act="aiConsentCancel">继续这一轮</button></div>';d.showModal();
}
const AI_ACTIONS={
 aiOpen(el){aiEnter(el.dataset.key);},aiBack(){if(ai.request){ai.request.stopped=true;ai.request.ctl.abort();}sel=ai.date;location.hash='#review';},
 aiTab(el){aiSession().tab=el.dataset.v;aiRender();},aiToExplore(){aiSession().tab='explore';aiRender();},
 aiGenerate(){aiPrepare('summary');},aiSend(){aiPrepare('explore');},aiStop(){if(ai.request){ai.request.stopped=true;ai.request.ctl.abort();}},
 aiStarter(el){aiSession().input=el.querySelector('span').textContent;aiSession().tab='explore';aiSaveDraft(aiSession());aiRender();$('#ai-question')?.focus();},
 aiTokenSave(){aiHealth(true);},aiHealth(){aiHealth();},aiEditToken(){ai.settingsEdit=!ai.settingsEdit;ai.authMessage='';aiRender();$('#ai-token')?.focus();},
 aiMaterials(){aiShowConsent();},aiConsentCancel(){aiDialogClose();},
 aiConsentAccept(){const s=aiSession(),c=ai.confirm;if(!c)return;const ctx={selection:c.selection,materials:s.materials||aiMaterials(s.date,c.selection)};if(!aiHasMaterial(ctx.materials)){ $('#ai-consent-error').textContent='至少选择一项有内容的材料。';return;}uiPrefs.aiMaterials=clone(c.selection);saveUIPrefs();s.consent=aiSignature(s,ctx);const mode=c.mode;aiDialogClose();if(mode)aiRun(mode,s,ctx);else aiRender();},
 aiSaveExplore(){aiSaveExplore();},aiNewRound(){aiNewRound();},async aiSaveAndNew(){if(await aiSaveExplore())aiDialogClose();},aiDiscardRound(){aiResetRound(aiSession());aiDialogClose();aiRender();},
 aiDeleteExplore(el){const id=el.dataset.id;ai.confirm={deleteId:id};const d=$('#ai-confirm');d.innerHTML='<h2 id="ai-confirm-title">删除这次探索？</h2><p class="fine">当天复盘和总结会保留。</p><div class="row"><button type="button" class="btn ghost" data-act="aiConsentCancel">取消</button><button type="button" class="btn" data-act="aiDeleteConfirm">删除</button></div>';d.showModal();},
 async aiDeleteConfirm(){const day=getDay(ai.date);if(!day.ai)return;day.ai.explores=(day.ai.explores||[]).filter(x=>x.id!==ai.confirm.deleteId);try{await aiStoreDay(day);aiDialogClose();aiRender();}catch{toast('删除没存成功，请保留页面后再试。');}}
};
document.addEventListener('input',e=>{if(e.target.id==='ai-question'&&ai.date){const s=aiSession();s.input=e.target.value;aiSaveDraft(s);}});
document.addEventListener('change',e=>{if(e.target.dataset.aiCheck&&ai.confirm){ai.confirm.selection[e.target.dataset.aiCheck]=e.target.checked;aiPreviewConsent();}});
document.addEventListener('keydown',e=>{if(e.target.id==='ai-question'&&(e.ctrlKey||e.metaKey)&&e.key==='Enter'&&!e.isComposing){e.preventDefault();aiPrepare('explore');}});
$('#ai-confirm').addEventListener('cancel',e=>{e.preventDefault();aiDialogClose();});
window.addEventListener('pagehide',()=>{if(ai.date)aiSaveDraft(aiSession());if(ai.request){ai.request.stopped=true;ai.request.ctl.abort();}});
window.addEventListener('offline',()=>{if(ai.request){ai.request.ctl.abort();}if(['ai','review'].includes(route))aiRender();});
window.addEventListener('online',()=>{if(['ai','review'].includes(route))aiRender();});
