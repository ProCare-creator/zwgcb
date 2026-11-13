import {mkdir,copyFile,readdir,writeFile} from 'node:fs/promises';
// Explicit allowlist: neither Worker source nor local credentials become public assets.
await mkdir(new URL('./dist/icons/',import.meta.url),{recursive:true});
for(const name of ['index.html','sw.js','manifest.webmanifest'])await copyFile(new URL(name,import.meta.url),new URL('dist/'+name,import.meta.url));
for(const name of await readdir(new URL('icons/',import.meta.url))){
  if(/\.(png|svg|ico)$/.test(name))await copyFile(new URL('icons/'+name,import.meta.url),new URL('dist/icons/'+name,import.meta.url));
}
await writeFile(new URL('dist/_headers',import.meta.url),'/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n/\n  Cache-Control: no-cache\n/index.html\n  Cache-Control: no-cache\n/sw.js\n  Cache-Control: no-cache\n/manifest.webmanifest\n  Cache-Control: no-cache\n');
