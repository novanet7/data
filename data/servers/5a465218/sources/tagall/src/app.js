const { Telegraf } = require('telegraf');
const config = require('./config');
const db = require('./db');
const handlers = require('./handlers');
const sync = require('./sync');
const tag = require('./tagall');

async function main(){
  const bot=new Telegraf(config.botToken);
  global.__bot=bot;
  if(config.ownerId) db.addAdmin(config.ownerId);
  for(const id of config.adminIds) db.addAdmin(id);
  handlers.setup(bot);
  bot.catch(async(err,ctx)=>{ console.error('[BOT ERROR]',err); try{await ctx.reply('Terjadi error internal. Cek log server.');}catch{} });

  const queueLoop=setInterval(()=>tag.processQueue(bot).catch(e=>console.error('[QUEUE]',e)),1000);
  const syncLoop=setInterval(async()=>{
    if(!db.assistant() || sync.isRunning()) return;
    const last=Number(db.getSetting('last_sync_at','0'))||0;
    if(Date.now()/1000-last < config.syncIntervalHours*3600) return;
    try{ console.log('[SYNC] Auto sync dimulai'); await sync.syncAll(async s=>console.log(`[SYNC] ${s.link}: ${s.current}${s.total?`/${s.total}`:''}`)); console.log('[SYNC] Auto sync selesai'); }
    catch(e){ db.setSetting('last_sync_status',`Gagal: ${e.message}`); console.error('[SYNC]',e.message); }
  },60000);

  process.once('SIGINT',()=>{clearInterval(queueLoop);clearInterval(syncLoop);bot.stop('SIGINT');});
  process.once('SIGTERM',()=>{clearInterval(queueLoop);clearInterval(syncLoop);bot.stop('SIGTERM');});
  console.log('==============================================');
  console.log(' RAXI TAGALL BOT — NODE.JS');
  console.log('==============================================');
  console.log(` Targets : ${config.targetLinks.length}`);
  console.log(` Assistant: ${db.assistant()?'tersedia':'belum ada'}`);
  console.log(` DB      : ${config.dbPath}`);
  console.log(' Starting Bot API...');
  await bot.launch({allowedUpdates:['message','callback_query','chat_member','chat_join_request']});
  console.log(' Bot API ONLINE');
  // Auto-sync immediately when an assistant exists.
  if(db.assistant()){
    setTimeout(()=>sync.syncAll(async s=>console.log(`[SYNC] ${s.link}: ${s.current}${s.total?`/${s.total}`:''}`)).then(()=>console.log('[SYNC] Initial auto-sync selesai')).catch(e=>console.error('[SYNC] Initial:',e.message)),1500);
  }
}
main().catch(err=>{ console.error('[FATAL STARTUP]',err); process.exitCode=1; });
