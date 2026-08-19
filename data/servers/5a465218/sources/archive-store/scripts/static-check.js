const fs=require('fs'), path=require('path'), cp=require('child_process');
const root=path.join(__dirname,'..'); let files=[];
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name); if(e.isDirectory())walk(p); else if(e.name.endsWith('.js') && !p.includes(path.sep+'node_modules'+path.sep))files.push(p);}})(root);
let bad=0; for(const f of files){const r=cp.spawnSync(process.execPath,['--check',f],{encoding:'utf8'}); if(r.status!==0){bad++; console.error(r.stderr||r.stdout);}}
console.log(`Static JS syntax check: ${files.length-bad}/${files.length} passed`); process.exitCode=bad?1:0;
