const { callbackButton, kb, sleep, esc, requireGroupAdmin, toast, durationKeyboard } = require('./ui');
const { premium, unicode } = require('./emoji');
const db = require('./db');
const config = require('./config');

const activeRuns = new Map();
const partnerDrafts = new Map();
let queueWorker = false;
let lastQueueFinish = 0;

function membersFor(chatId){ return db.members(chatId); }
function botResultLine(){ return `Result by: @${esc(config.botUsername || 'bot')}`; }
function buildChunks(messageText, members){
  const max=3900; const chunks=[]; let current='';
  for(const m of members){
    const name=[m.first_name,m.last_name].filter(Boolean).join(' ').trim() || (m.username?`@${m.username}`:'Member');
    const mention=`<a href="tg://user?id=${Number(m.user_id)}">${esc(name)}</a>`;
    const candidate=current?`${current} ${mention}`:mention;
    const body=`<blockquote>━━━━━━━━━━━━━━━━━━\n${esc(messageText)}\n\n${candidate}\n━━━━━━━━━━━━━━━━━━</blockquote>\n\n<blockquote>${botResultLine()}</blockquote>`;
    if(current && body.length>max){ chunks.push(current); current=mention; } else current=candidate;
  }
  if(current) chunks.push(current); return chunks.length?chunks:[''];
}
function tagMarkup(chatId, runId){ return kb([[callbackButton('stop','Stop Tekal',`tagstop:${chatId}:${runId}`)]]); }
async function sendCycle(bot, chatId, text, runId, deadline){
  const members=membersFor(chatId); if(!members.length) throw new Error('Cache member kosong. Silakan Sync Member terlebih dahulu.');
  const chunks=buildChunks(text,members); let sent=0;
  for(const chunk of chunks){
    if(deadline && Date.now()>=deadline) return {sent,stopped:true};
    const run=activeRuns.get(Number(chatId)); if(!run || run.id!==runId || run.stop) return {sent,stopped:true};
    const body=`<blockquote>━━━━━━━━━━━━━━━━━━\n${esc(text)}\n\n${chunk}\n━━━━━━━━━━━━━━━━━━</blockquote>\n\n<blockquote>${botResultLine()}</blockquote>`;
    await bot.telegram.sendMessage(chatId,body,{parse_mode:'HTML',reply_markup:tagMarkup(chatId,runId),link_preview_options:{is_disabled:false}}); sent++;
    await sleep(config.delaySeconds*1000);
  }
  return {sent,stopped:false};
}
async function startRun(bot, chatId, text, durationMinutes, meta={}){
  chatId=Number(chatId); if(activeRuns.has(chatId)) throw new Error('Tagall sedang berjalan di grup ini.');
  const id=`${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const run={id,chatId,text,durationMinutes:Number(durationMinutes),stop:false,startedAt:Date.now(),meta}; activeRuns.set(chatId,run);
  await bot.telegram.sendMessage(chatId,
    `<blockquote>━━━━━━━━━━━━━━━━━━\n${premium('open')} <b>Tekal dimulai</b>\n\n${premium('time')} Durasi: <b>${durationMinutes} menit</b>\n${premium('tagall')} Data diambil dari cache member.\n${premium('stop')} Setiap pesan Tagall memiliki tombol Stop.\n━━━━━━━━━━━━━━━━━━</blockquote>`,
    {parse_mode:'HTML'});
  const end=Date.now()+Number(durationMinutes)*60*1000; let cycles=0; let sent=0;
  try{
    while(Date.now()<end && !run.stop){ cycles++; const r=await sendCycle(bot,chatId,text,id,end); sent+=r.sent; if(r.stopped) break; }
  } finally {
    activeRuns.delete(chatId);
    await bot.telegram.sendMessage(chatId,`<blockquote>━━━━━━━━━━━━━━━━━━\n${premium('ok')} <b>Tekal selesai.</b>\n\n${premium('group')} Member cache: <b>${membersFor(chatId).length}</b>\n${premium('message')} Pesan terkirim: <b>${sent}</b>\n${premium('time')} Durasi: <b>${durationMinutes} menit</b>\n━━━━━━━━━━━━━━━━━━</blockquote>`,{parse_mode:'HTML'}).catch(()=>{});
  }
  if(meta.queueId){ db.updateQueue(meta.queueId,{status:'done',finished_at:db.now(),stop_requested:run.stop?1:0}); lastQueueFinish=Date.now(); }
  return {sent,stopped:run.stop,cycles};
}
function stopRun(chatId){ const run=activeRuns.get(Number(chatId)); if(!run) return false; run.stop=true; return true; }
function isRunning(chatId){ return activeRuns.has(Number(chatId)); }
function queueSettings(){ return Number(db.getSetting('partner_timer_minutes',String(config.partnerTimerMinutes))) || config.partnerTimerMinutes; }
function setQueueTimer(minutes){ db.setSetting('partner_timer_minutes',String(Math.min(30,Math.max(1,Number(minutes))))); }
function queueCooldown(){ return 300; }
async function processQueue(bot){
  if(queueWorker) return; queueWorker=true;
  try{
    while(true){
      if(Date.now()-lastQueueFinish < queueCooldown()*1000){ await sleep(1000); continue; }
      const item=db.nextQueue(); if(!item){ await sleep(1500); continue; }
      if(activeRuns.size>0 || activeRuns.has(Number(item.target_chat_id))){ await sleep(1500); continue; }
      const duration=Number(item.duration_minutes)||queueSettings();
      db.updateQueue(item.id,{status:'running',started_at:db.now(),duration_minutes:duration});
      try{ await startRun(bot,item.target_chat_id,item.text,duration,{queueId:item.id,requesterId:item.requester_id}); }
      catch(e){ db.updateQueue(item.id,{status:'failed',finished_at:db.now()}); }
      lastQueueFinish=Date.now();
    }
  } finally { queueWorker=false; }
}
function enqueuePartner(requesterId,targetChatId,text){ const duration=queueSettings(); return db.addQueue(requesterId,targetChatId,text,duration); }
function listTargetChoices(){ return db.targets().filter(t=>t.chat_id).map(t=>({chatId:Number(t.chat_id),title:t.title||`Target ${t.chat_id}`})); }
function partnerExists(userId){ return !!db.db.prepare('SELECT 1 FROM partners WHERE user_id=? AND active=1').get(Number(userId)); }
function addPartner(userId,name=''){ db.db.prepare('INSERT INTO partners(user_id,name,active,created_at) VALUES(?,?,1,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,active=1').run(Number(userId),String(name),db.now()); }
function removePartner(userId){ db.db.prepare('UPDATE partners SET active=0 WHERE user_id=?').run(Number(userId)); }
function listPartners(){ return db.db.prepare('SELECT * FROM partners ORDER BY id DESC').all(); }
function createPartnerDraft(userId,text){ const token=Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-4); partnerDrafts.set(`${userId}:${token}`,{text:String(text),createdAt:Date.now()}); setTimeout(()=>partnerDrafts.delete(`${userId}:${token}`),10*60*1000); return token; }
function takePartnerDraft(userId,token){ const key=`${userId}:${token}`; const item=partnerDrafts.get(key); if(item) partnerDrafts.delete(key); return item?.text||null; }
function partnerTargetKeyboard(userId,text){ const token=createPartnerDraft(userId,text); return kb(listTargetChoices().map(t=>[callbackButton('group',t.title,`pqueue:${t.chatId}:${token}`)])); }
module.exports={startRun,stopRun,isRunning,processQueue,enqueuePartner,queueSettings,setQueueTimer,queueCooldown,partnerExists,addPartner,removePartner,listPartners,partnerTargetKeyboard,takePartnerDraft,listTargetChoices,activeRuns};
