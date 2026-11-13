import fs from 'node:fs/promises';
import {minify} from 'terser';
const root=new URL('../',import.meta.url);
let html=await fs.readFile(new URL('ui/app.html',root),'utf8');
const js=await fs.readFile(new URL('ui/ai.js',root),'utf8'),css=await fs.readFile(new URL('ui/ai.css',root),'utf8');
html=html.replace('/* AI_CSS_START */',()=>'/* AI_CSS_START */\n'+css).replace('/* AI_UI_START */',()=>'/* AI_UI_START */\n'+js);
for(const match of [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]){
 const result=await minify(match[1],{
  compress:false,
  mangle:{reserved:['render','refresh','A','S','ai']},
  format:{comments:/BOOT_APP/,max_line_len:180}
 });
 html=html.replace(match[0],()=>'<script>\n'+result.code+'\n</script>');
}
if(Buffer.byteLength(html)>300000)throw Error('index.html exceeds the 300 KB limit: '+Buffer.byteLength(html));
await fs.writeFile(new URL('index.html',root),html);
console.log('Built single-file page: '+Buffer.byteLength(html)+' bytes');
