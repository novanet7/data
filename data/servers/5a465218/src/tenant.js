'use strict';
const fs=require('fs');
const path=require('path');
const {spawn}=require('child_process');
const db=require('./db');

const ROOT=path.resolve(process.env.TENANTS_DIR||path.join(__dirname,'..','tenants'));
fs.mkdirSync(ROOT,{recursive:true});
const ROOT_NODE_MODULES=path.join(__dirname,'..','node_modules');
const PREMIUM_RUNTIME=path.join(__dirname,'tenant-premium-runtime.js');
const SOURCES={
  'premium-store':path.join(__dirname,'..','sources','premium-store'),
  'auto-comment-jaseb':path.join(__dirname,'..','sources','auto-comment-jaseb'),
  'tagall':path.join(__dirname,'..','sources','tagall'),
  'archive-store':path.join(__dirname,'..','sources','archive-store')
};

function safe(id){return String(id).replace(/[^a-zA-Z0-9_-]/g,'_')}
function key(t,o){return `${t}:${o}`}
function dir(botType,ownerId){return path.join(ROOT,botType,safe(ownerId));}
function Integer(v){const n=Number(v);return Number.isFinite(n)?n:v}

function writeEnv(type,dirPath,ownerId,token){
  let lines=[];
  if(type==='premium-store') lines=[`BOT_TOKEN=${token}`,`OWNER_IDS=${ownerId}`];
  else if(type==='auto-comment-jaseb') lines=[`BOT_TOKEN=${token}`,`API_ID=${process.env.TELEGRAM_API_ID||''}`,`API_HASH=${process.env.TELEGRAM_API_HASH||''}`,`OWNER_ID=${ownerId}`];
  else if(type==='tagall') lines=[`BOT_TOKEN=${token}`,`BOT_USERNAME=`, `OWNER_ID=${ownerId}`,`API_ID=${process.env.TELEGRAM_API_ID||''}`,`API_HASH=${process.env.TELEGRAM_API_HASH||''}`,`TARGET_GROUP_LINKS=`,`TAGALL_DELAY_SECONDS=${process.env.TAGALL_DELAY_SECONDS||2}`,`PARTNER_TAGALL_TIMER_MINUTES=${process.env.PARTNER_TAGALL_TIMER_MINUTES||3}`,`PARTNER_QUEUE_COOLDOWN_SECONDS=${process.env.PARTNER_QUEUE_COOLDOWN_SECONDS||300}`,`SYNC_INTERVAL_HOURS=${process.env.SYNC_INTERVAL_HOURS||6}`,`ADMIN_IDS=${ownerId}`];
  else lines=[`PLATFORM_BOT_TOKEN=${token}`,`PLATFORM_OWNER_ID=${ownerId}`,`PLATFORM_OWNER_IDS=${ownerId}`,`TG_API_ID=${process.env.TELEGRAM_API_ID||''}`,`TG_API_HASH=${process.env.TELEGRAM_API_HASH||''}`,`STORE_ID=${safe(ownerId)}`,`STORE_NAME=Telegram SaaS`];
  fs.mkdirSync(dirPath,{recursive:true});
  fs.writeFileSync(path.join(dirPath,'.env'),lines.join('\n')+'\n');
}

function cloneDir(src,dst){
  fs.mkdirSync(path.dirname(dst),{recursive:true});
  if(!fs.existsSync(dst)){fs.cpSync(src,dst,{recursive:true});}
  else if(!fs.existsSync(path.join(dst,'src','app.js'))){fs.cpSync(src,dst,{recursive:true});}
  if(fs.existsSync(path.join(dst,'node_modules'))) fs.rmSync(path.join(dst,'node_modules'),{recursive:true,force:true});
}

function readToken(type,ownerId){
  try{
    const envPath=path.join(dir(type,ownerId),'.env');
    const raw=fs.readFileSync(envPath,'utf8');
    const keyName=type==='archive-store'?'PLATFORM_BOT_TOKEN':'BOT_TOKEN';
    const m=raw.match(new RegExp(`^${keyName}=(.*)$`,'m'));
    return m&&m[1] ? m[1].trim() : null;
  }catch{return null}
}

function hasRuntime(type,ownerId){return fs.existsSync(path.join(dir(type,ownerId),'src','app.js'));}

const procs=new Map();
const intentionalStops=new Set();

async function start(type,ownerId,token,options={}){
  if(!SOURCES[type]) throw Error(`Source bot '${type}' tidak ditemukan.`);
  if(!token) throw Error('Bot token kosong.');
  const dirPath=dir(type,ownerId);
  cloneDir(SOURCES[type],dirPath);
  writeEnv(type,dirPath,ownerId,token);
  const k=key(type,ownerId);
  const existing=procs.get(k);
  if(existing) return {dir:dirPath,pid:existing.pid,reused:true};

  const entry=path.join(dirPath,'src','app.js');
  const tenantNodePath=[ROOT_NODE_MODULES,process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  // Semua tenant Telegraf memakai bridge Premium Emoji Archive yang sama.
  // Auto Comment/Jaseb juga aman memakai preloader ini karena bridge hanya
  // menyentuh Telegraf Telegram/Context; logic GramJS tetap terpisah.
  const nodeOptions=[process.env.NODE_OPTIONS,`--require=${PREMIUM_RUNTIME}`].filter(Boolean).join(' ');
  intentionalStops.delete(k);
  const child=spawn(process.execPath,[entry],{
    cwd:dirPath,
    env:{...process.env,NODE_ENV:'production',NODE_PATH:tenantNodePath,NODE_OPTIONS:nodeOptions},
    stdio:['ignore','pipe','pipe']
  });
  let logs='';
  child.stdout.on('data',d=>{logs+=d.toString();process.stdout.write(`[tenant:${type}:${ownerId}] ${d}`)});
  child.stderr.on('data',d=>{logs+=d.toString();process.stderr.write(`[tenant:${type}:${ownerId}] ${d}`)});
  child.on('error',err=>{console.error(`[tenant:${type}:${ownerId}] child error`,err);});
  child.on('exit',(code,signal)=>{
    if(procs.get(k)===child) procs.delete(k);
    else return;

    if(intentionalStops.has(k)){
      intentionalStops.delete(k);
      db.setTenant(k,{status:'stopped',exitCode:code,signal,logs:logs.slice(-4000)});
      return;
    }
    const rec=db.tenant(k)||{};
    db.setTenant(k,{status:'crashed',exitCode:code,signal,logs:logs.slice(-4000)});
    const canRestart=options.autoRestart!==false && rec.autostart!==false && (!rec.expiresAt || Number(rec.expiresAt)>Date.now());
    if(canRestart){
      const delay=Math.max(3000,Number(options.restartDelayMs)||5000);
      setTimeout(()=>{
        const current=db.tenant(k)||{};
        const t=readToken(type,ownerId);
        if(current.autostart!==false && (!current.expiresAt || Number(current.expiresAt)>Date.now()) && t && !procs.has(k)){
          start(type,ownerId,t,{autoRestart:true,restartDelayMs:delay}).catch(err=>console.error(`[tenant:${type}:${ownerId}] auto-restart failed`,err.message));
        }
      },delay);
    }
  });
  procs.set(k,child);
  db.setTenant(k,{status:'running',dir:dirPath,ownerId:Integer(ownerId),type,autostart:true,pid:child.pid});
  return {dir:dirPath,pid:child.pid};
}

async function restoreRunning(){
  if (db.settings?.().allStoresClosed === true) return [];
  const restored=[];
  for(const rec of db.listTenants()){
    const k=key(rec.type,rec.ownerId);
    if(procs.has(k)) continue;
    const exp=Number(rec.expiresAt||0);
    if(exp && exp<=Date.now()){
      db.setTenant(k,{status:'expired',autostart:false});
      continue;
    }
    // Autostart is the source of truth for recovery. Runtime status is only
    // informational because a hard server/VPS failure can terminate the child
    // before its final status is flushed to disk.
    const shouldRestore=rec.autostart!==false;
    if(!shouldRestore) continue;
    const token=readToken(rec.type,rec.ownerId);
    if(!token){
      db.setTenant(k,{status:'failed',error:'Tenant token tidak ditemukan.'});
      continue;
    }
    try{
      await start(rec.type,rec.ownerId,token,{autoRestart:true,restartDelayMs:5000});
      restored.push(k);
    }catch(e){
      db.setTenant(k,{status:'failed',error:e.message});
    }
  }
  return restored;
}

function stop(type,ownerId,options={}){
  const k=key(type,ownerId);
  const child=procs.get(k);
  if(child){
    // Keep the intentional-stop marker until the child emits exit.
    // This prevents the exit handler from treating an admin stop as a crash
    // and accidentally scheduling an auto-restart.
    intentionalStops.add(k);
    try{ child.kill('SIGTERM'); }catch{}
  } else {
    intentionalStops.delete(k);
  }
  const patch={status:'stopped'};
  if(options.preserveAutostart!==true) patch.autostart=false;
  db.setTenant(k,patch);
}

function listStatus(){
  return db.listTenants().map(rec=>{
    const k=key(rec.type,rec.ownerId);
    const child=procs.get(k);
    return {...rec, live:!!child, livePid:child?.pid||null};
  });
}

async function closeAllStores(){
  db.setSetting('allStoresClosed',true);
  const tenants=db.listTenants();
  for(const rec of tenants){
    try{ stop(rec.type,rec.ownerId,{preserveAutostart:true}); }catch{}
  }
  return {count:tenants.length};
}

async function openAllStores(){
  db.setSetting('allStoresClosed',false);
  const tenants=db.listTenants();
  const started=[];
  const failed=[];
  for(const rec of tenants){
    const exp=Number(rec.expiresAt||0);
    if(exp && exp<=Date.now()){
      db.setTenant(key(rec.type,rec.ownerId),{status:'expired',autostart:false});
      continue;
    }
    const token=readToken(rec.type,rec.ownerId);
    if(!token){
      db.setTenant(key(rec.type,rec.ownerId),{status:'failed',autostart:true,error:'Tenant token tidak ditemukan.'});
      failed.push(key(rec.type,rec.ownerId));
      continue;
    }
    try{
      await start(rec.type,rec.ownerId,token,{autoRestart:true,restartDelayMs:5000});
      db.setTenant(key(rec.type,rec.ownerId),{autostart:true});
      started.push(key(rec.type,rec.ownerId));
    }catch(e){
      db.setTenant(key(rec.type,rec.ownerId),{status:'failed',autostart:true,error:e.message});
      failed.push(key(rec.type,rec.ownerId));
    }
  }
  return {count:tenants.length,started,failed};
}

async function replaceToken(type,ownerId,token){
  const k=key(type,ownerId);
  const rec=db.tenant(k);
  if(!rec) throw Error('Bot tenant tidak ditemukan.');
  if(!token) throw Error('Bot token kosong.');
  const d=dir(type,ownerId);
  if(!hasRuntime(type,ownerId)) throw Error('Runtime bot tidak ditemukan.');
  stop(type,ownerId);
  writeEnv(type,d,ownerId,token);
  db.setTenant(k,{status:'restarting',autostart:true,tokenUpdatedAt:Date.now()});
  return start(type,ownerId,token,{autoRestart:true,restartDelayMs:5000});
}

async function remove(type,ownerId){
  stop(type,ownerId);
  const d=dir(type,ownerId);
  if(fs.existsSync(d)) fs.rmSync(d,{recursive:true,force:true});
  db.removeTenant(key(type,ownerId));
  return true;
}

function status(type,ownerId){
  const p=procs.get(key(type,ownerId));
  return {running:!!p,pid:p?.pid||null,record:db.tenant(key(type,ownerId))};
}

async function shutdownAllForParent(){
  const rows=[...procs.entries()];
  for(const [k,child] of rows){
    intentionalStops.add(k);
    try{ child.kill('SIGTERM'); }catch{}
  }
  return rows.length;
}

async function restart(type,ownerId,token){stop(type,ownerId);return start(type,ownerId,token,{autoRestart:true});}

module.exports={start,stop,restart,status,listStatus,remove,replaceToken,restoreRunning,readToken,dir,closeAllStores,openAllStores,shutdownAllForParent};
