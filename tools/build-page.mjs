import fs from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {minify} from 'terser';
import {syncLimits} from '../worker/sync-limits.mjs';
const root=new URL('../',import.meta.url);
let html=await fs.readFile(new URL('ui/app.html',root),'utf8');
for(const [tag,files] of [['/* ACCOUNT_BOOT */',['account-boot.js']],['/* ACCOUNT_UI */',['account-crypto.js','accounts.js','vault-sync.js','vault-claim.js']]]){
 const chunks=await Promise.all(files.map(f=>fs.readFile(new URL('ui/'+f,root),'utf8')));html=html.replace(tag,()=>chunks.join('\n'));
}
const journalFiles=['timeline-core.js','timeline.js','memo.js','chat-plan.js'];
html=html.replace('/* CLOUD_SYNC_LIMITS */',()=> 'const syncLimits='+JSON.stringify(syncLimits)+';');
const journal=(await Promise.all(journalFiles.map(f=>fs.readFile(new URL('ui/'+f,root),'utf8')))).join('\n');
html=html.replace('/* AI_UI_START */',()=>journal+'\n/* AI_UI_START */');
const storage=await fs.readFile(new URL('ui/storage.js',root),'utf8');
html=html.replace('/* LOCAL_DOCUMENT_STORE */',()=>storage);
const js=(await fs.readFile(new URL('ui/ai.js',root),'utf8'))+'\n'+(await fs.readFile(new URL('ui/chat.js',root),'utf8')),css=(await fs.readFile(new URL('ui/timeline.css',root),'utf8'))+'\n'+(await fs.readFile(new URL('ui/ai.css',root),'utf8'))+'\n'+(await fs.readFile(new URL('ui/chat.css',root),'utf8'));
html=html.replace('/* AI_CSS_START */',()=>'/* AI_CSS_START */\n'+css).replace('/* AI_UI_START */',()=>'/* AI_UI_START */\n'+js);
for(const match of [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]){
 const result=await minify(match[1],{
  compress:false,
  mangle:{reserved:['render','refresh','A','S','ai','chat']},
  format:{comments:/BOOT_APP/,max_line_len:180}
 });
 html=html.replace(match[0],()=>'<script>\n'+result.code+'\n</script>');
}
html=html.replace(/\r\n/g,'\n'); // Keep byte counts and artifacts identical across checkouts.
if(Buffer.byteLength(html)>450000)throw Error('index.html exceeds the 450 KB limit: '+Buffer.byteLength(html));
await fs.writeFile(new URL('index.html',root),html);
console.log('Built single-file page: '+Buffer.byteLength(html)+' bytes; gzip: '+gzipSync(html).length+' bytes');
