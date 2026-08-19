const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const config = require('./config');
const db = require('./db');

let running = false;
function makeClient(sessionString='') { return new TelegramClient(new StringSession(sessionString||''), config.apiId, config.apiHash, { connectionRetries:5 }); }
function entityId(entity){ return Number(entity?.id?.valueOf?.() ?? entity?.id ?? 0); }
function groupDbId(entity){ const id=entityId(entity); if(entity?.className==='Channel') return Number(`-100${id}`); return id ? -Math.abs(id) : id; }
async function targetTotal(client, entity){
  try{
    if(entity?.className==='Channel'){
      const full=await client.invoke(new Api.channels.GetFullChannel({channel:entity}));
      return Number(full?.fullChat?.participantsCount?.valueOf?.() ?? full?.fullChat?.participantsCount ?? 0);
    }
  }catch{}
  return 0;
}
async function syncOne(client, link, progress){
  const entity=await client.getEntity(link);
  const chatId=groupDbId(entity); const total=await targetTotal(client,entity);
  const seen=[]; const rows=[]; let count=0; let last=0;
  await progress({stage:'start',link,chatId,total,current:0,title:entity?.title||''});
  for await(const user of client.iterParticipants(entity,{limit:0})){
    const id=Number(user.id?.valueOf?.() ?? user.id); if(!id) continue;
    seen.push(id); rows.push({user_id:id,username:user.username||'',first_name:user.firstName||'',last_name:user.lastName||'',is_bot:!!user.bot}); count++;
    const t=Date.now(); if(t-last>700){ last=t; await progress({stage:'progress',link,chatId,total,current:count,title:entity?.title||''}); }
  }
  db.setMembers(chatId,rows); if(seen.length) db.markMissingDeleted(chatId,seen);
  let title=entity?.title||'', username=entity?.username||''; try{ const c=await global.__bot.telegram.getChat(chatId); title=c.title||title; username=c.username||username; }catch{}
  db.upsertTarget(link,chatId,title,username); await progress({stage:'done',link,chatId,total,current:count,title});
  return {link,chatId,count,total,title,username};
}
async function syncAll(progress=async()=>{}){
  if(running) throw new Error('Sync sedang berjalan.');
  const a=db.assistant(); if(!a) throw new Error('Belum ada akun assistant.');
  if(!config.apiId||!config.apiHash) throw new Error('API_ID/API_HASH belum diisi di .env');
  running=true; const client=makeClient(a.session_string);
  try{
    await client.connect(); if(!(await client.checkAuthorization())) throw new Error('Session assistant sudah tidak valid. Sambungkan ulang akun.');
    for(const link of config.targetLinks) await syncOne(client,link,progress);
    db.setSetting('last_sync_at',String(db.now())); db.setSetting('last_sync_status','Berhasil'); return true;
  } finally { try{await client.disconnect();}catch{} running=false; }
}

function beginLogin(phone, send){
  if(!config.apiId||!config.apiHash) throw new Error('API_ID/API_HASH belum diisi di .env');
  const client=makeClient('');
  const state={client,phone,codeResolve:null,passwordResolve:null,done:false,promise:null};
  const wait=(slot,msg)=>new Promise(resolve=>{ state[slot]=resolve; send(msg).catch?.(()=>{}); });
  state.promise=(async()=>{
    try{
      await client.start({
        phoneNumber:async()=>phone,
        phoneCode:async()=>wait('codeResolve',{type:'code',text:'Kode OTP dikirim. Kirim kodenya di chat ini.'}),
        password:async()=>wait('passwordResolve',{type:'password',text:'Akun memakai 2FA. Kirim password 2FA di chat ini.'}),
        onError:async(e)=>{ throw e; }
      });
      const me=await client.getMe(); const session=client.session.save(); const t=db.now();
      db.db.prepare('INSERT INTO assistants(label,phone,telegram_id,session_string,active,created_at,updated_at) VALUES(?,?,?,?,1,?,?)').run(me.firstName||'',phone,Number(me.id),session,t,t);
      db.log(Number(me.id),'assistant.login',phone); state.done=true; return {done:true,me};
    } finally { try{await client.disconnect();}catch{} }
  })();
  state.promise.catch(()=>{});
  return state;
}
function submitCode(state, code){ if(state.codeResolve){ const r=state.codeResolve; state.codeResolve=null; r(String(code).trim()); return true;} return false; }
function submitPassword(state, password){ if(state.passwordResolve){ const r=state.passwordResolve; state.passwordResolve=null; r(String(password)); return true;} return false; }
function isRunning(){return running;}
module.exports={syncAll,beginLogin,submitCode,submitPassword,isRunning,groupDbId};
