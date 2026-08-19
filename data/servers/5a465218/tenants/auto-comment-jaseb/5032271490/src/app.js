require('dotenv').config();
const {Telegraf,Markup}=require('telegraf');
const db=require('./db'); const tg=require('./telegram'); const {toPremiumText}=require('./premium-input');
for(const k of ['BOT_TOKEN','API_ID','API_HASH','OWNER_ID'])if(!process.env[k])throw Error(`${k} wajib di .env`);
const bot=new Telegraf(process.env.BOT_TOKEN); const OWNER=String(process.env.OWNER_ID).trim();
const state=new Map(); const logViews=new Map();

function isOwner(id){return String(id)===OWNER}
function access(id){if(isOwner(id))return{ok:true,u:db.ensureUser(id,'owner')};const u=db.getUser(id);return{ok:db.active(u),u}}
function fmt(ts){return !ts?'∞':new Date(Number(ts)*1000).toLocaleString('id-ID')}
function kb(id){const on=!!db.getSender(id)?.enabled;const j=!!db.getJaseb(id)?.enabled;return Markup.inlineKeyboard([[Markup.button.callback('📱 Akun','acc'),Markup.button.callback('🔑 Keyword','kw')],[Markup.button.callback('📌 Target','target'),Markup.button.callback(`${on?'🟢':'🔴'} Auto Comment`,'toggle')],[Markup.button.callback(`${j?'📢':'📤'} Jaseb`,'jaseb'),Markup.button.callback('📋 Log','log')],...(isOwner(id)?[[Markup.button.callback('👑 Premium','premium')]]:[])])}
function dash(id,extra=''){db.disableExpired();const a=access(id),s=db.getSender(id)||{},st=db.stats(id);return`⚡ <b>Auto Comment</b>\n\nStatus: ${a.ok?'✅ AKTIF':'🔒 TERKUNCI'}\nRole: ${isOwner(id)?'👑 OWNER':'⭐ PREMIUM'}\nAkun: ${db.accounts(id).length}\nKeyword: ${db.listKeywords(id).length}\nTarget: ${db.listTargets(id).length}\nAuto Comment: ${s.enabled?'🟢 ON':'🔴 OFF'}\nAkses: ${a.u?fmt(a.u.expires_at):'Belum aktif'}\n\n📊 Sent: <b>${st.sent}</b>  • Match: <b>${st.matched}</b>  • Error: <b>${st.errors}</b>\nJaseb: ${db.getJaseb(id)?.enabled?'🟢 ON':'🔴 OFF'}${extra?`\n\n${extra}`:''}`}
async function panel(ctx,text,keyboard=kb(ctx.from.id)){const m=ctx.callbackQuery?.message;if(!m)return ctx.replyWithHTML(text,keyboard);try{return await ctx.telegram.editMessageText(m.chat.id,m.message_id,undefined,text,{parse_mode:'HTML',...keyboard})}catch(e){if(!/MESSAGE_NOT_MODIFIED/i.test(String(e.message)))return ctx.replyWithHTML(text,keyboard)}}
async function statePanel(ctx,text){const s=state.get(String(ctx.from.id));if(s?.chatId&&s?.panelId){try{return await ctx.telegram.editMessageText(s.chatId,s.panelId,undefined,text,{parse_mode:'HTML',...kb(ctx.from.id)})}catch{}}return ctx.replyWithHTML(text,kb(ctx.from.id))}
async function home(ctx,extra=''){return ctx.replyWithHTML(dash(ctx.from.id,extra),kb(ctx.from.id))}
function guard(id){return access(id).ok}
async function del(ctx,id){try{await ctx.telegram.deleteMessage(ctx.chat.id,id)}catch{}}
function logText(id){
 const st=db.stats(id);
 const rows=db.logs(id,80);
 const nowLabel=new Date().toLocaleTimeString('id-ID',{hour12:false});

 // Keep the UI compact: hide noisy poll/raw diagnostics and show only
 // meaningful monitoring/reply stages. Stored logs are NOT deleted.
 const visible=rows.filter(l=>{
   const m=String(l.message||'');
   if(l.type==='monitor' && /POLL CHECK|RAW CHANNEL UPDATE ignored/.test(m)) return false;
   if(l.type==='monitor' && l.status==='ready' && /POLL BASELINE/.test(m)) return false;
   return true;
 }).slice(0,18);

 const summarize=(l)=>{
   const m=String(l.message||'').replace(/\n+/g,' | ').replace(/\s+/g,' ').trim();
   const post=(m.match(/(?:Post ID|post)=([0-9]+)/i)||[])[1];
   const root=(m.match(/(?:Root ID|replyTo):\s*([0-9]+)/i)||[])[1];
   const target=(m.match(/(?:Target|Discussion Group):\s*([^|]+)/i)||[])[1]?.trim();
   const reason=(m.match(/(?:Reason|alasan)=?\s*([^|]+)/i)||[])[1]?.trim();
   if(/CHANNEL POST/.test(m) && post) return `📤 <b>POST</b> <code>#${post}</code> · ${esc(target||'channel')}`;
   if(/POLL CHANNEL POST/.test(m) && post) return `🌐 <b>POST BARU</b> <code>#${post}</code>`;
   if(l.status==='match') return `📌 <b>MATCH</b> · ${esc(m.replace(/^Keyword match:\s*/i,''))}`;
   if(/GET DISCUSSION ROOT/.test(m) && root) return `🔎 <b>ROOT</b> <code>#${root}</code> · ${esc(target||'discussion')}`;
   if(/VALIDATION PASSED/.test(m)) return `✅ <b>VALID</b> · ${esc(m.replace(/^.*?VALIDATION PASSED\s*\|\s*/i,''))}`;
   if(/SENDING REPLY/.test(m) && root) return `💬 <b>REPLY</b> → <code>#${root}</code> · ${esc(target||'discussion')}`;
   if(/REPLY SENT/.test(m)) return `✅ <b>SENT</b> · post <code>#${post||'?'}</code> → root <code>#${root||'?'}</code>`;
   if(l.status==='skip') return `⏭️ <b>SKIP</b> · ${esc(reason||m.replace(/^.*?alasan=/i,''))}`;
   if(l.status==='error' || /FAILED|ERROR/.test(m)) return `❌ <b>FAILED</b> · ${esc(reason||m)}`;
   if(l.status==='ready') return `🟢 <b>READY</b> · ${esc(m.replace(/\n+/g,' | '))}`;
   return `${l.status==='success'?'✅':'📌'} ${esc(m)}`;
 };

 const lines=visible.map(l=>{
   const t=new Date(l.created_at*1000).toLocaleTimeString('id-ID',{hour12:false});
   return `<code>${t}</code> ${summarize(l)}`;
 }).join('\n');

 return `📋 <b>MONITOR LOG</b>

🟢 Status: <b>${st.ready?'READY':'OFF'}</b>
📤 Sent: <b>${st.sent}</b>  📌 Match: <b>${st.matched}</b>
⏭️ Skip: <b>${st.skipped}</b>  ❌ Error: <b>${st.errors}</b>
🌐 Event: <b>${st.raw}</b>
🕒 <code>${nowLabel}</code>

${lines||'Belum ada aktivitas.'}`;
}
function esc(v){return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function previewPremiumText(v){return String(v||'').replace(/<tg-emoji\b[^>]*?\bemoji-id\s*=\s*[\"']\d+[\"'][^>]*>([\s\S]*?)<\/tg-emoji>/gi,'$1').replace(/!\[([^\]]*)\]\(tg:\/\/emoji\?id=\d+\)/gi,'$1')}
async function renderLog(id){
 const key=String(id); const v=logViews.get(key); if(!v||v.rendering)return;
 v.rendering=true;
 try{
   const text=logText(id);
   if(text===v.lastText){v.lastRenderAt=Date.now();return;}
   await bot.telegram.editMessageText(v.chatId,v.messageId,undefined,text,{parse_mode:'HTML',...logKb()});
   v.lastText=text; v.lastRenderAt=Date.now(); v.failures=0;
 }catch(e){
   const msg=String(e?.message||e);
   if(!/MESSAGE_NOT_MODIFIED|message is not modified/i.test(msg)){
     v.failures=(v.failures||0)+1;
     // Don't kill the live log on a transient Telegram/API error.
     if(v.failures>=8 && /message to edit not found|message_id_invalid|chat not found|bot was blocked|forbidden|not enough rights/i.test(msg)) stopLog(id);
   }
 }finally{v.rendering=false;}
}
function startLog(id,chatId,messageId){
 stopLog(id);
 const key=String(id);
 const view={chatId,messageId,timer:null,rendering:false,lastText:'',lastRenderAt:0,failures:0};
 logViews.set(key,view);
 // Render immediately, then keep a single non-overlapping 1-second refresher alive.
 renderLog(key);
 view.timer=setInterval(()=>renderLog(key),1000);
}
function stopLog(id){const v=logViews.get(String(id));if(v?.timer)clearInterval(v.timer);logViews.delete(String(id))}
function logKb(){return Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh','log'),Markup.button.callback('🧹 Bersihkan','clearlog')],[Markup.button.callback('⬅️ Kembali','home')]])}


function jasebConfigText(id,extra=''){
 const c=db.getJaseb(id);
 if(!c) return `📢 <b>JASEB / JASA SEBAR</b>\n\nBelum ada pengaturan.\n🗑 Pesan tersimpan: <b>0</b>${extra?`\n\n${extra}`:''}`;
 const saved=Array.isArray(c.messages)?c.messages.length:0;
 return `📢 <b>JASEB / JASA SEBAR</b>\n\nStatus: <b>${c.enabled?'🟢 ON':'🔴 OFF'}</b>\nInterval: <b>${c.interval_min||'-'} menit</b>\nGrup dipilih: <b>${Array.isArray(c.groups)?c.groups.length:0}</b>\nPesan Jaseb tersimpan: <b>${saved}</b>\n\nTeks:\n<blockquote>${esc(previewPremiumText(c.text||'-'))}</blockquote>${extra?`\n\n${extra}`:''}`;
}
function jasebMainKb(id){
 const c=db.getJaseb(id); const on=!!c?.enabled; const rows=[];
 rows.push([Markup.button.callback(on?'🟢 Jaseb Aktif':'🔴 Jaseb Mati',on?'jsoff':'json')]);
 rows.push([Markup.button.callback('📝 Atur Pesan & Interval','jsnew')]);
 if(isOwner(id)) rows.push([Markup.button.callback('📤 Broadcast','broadcast')]);
 rows.push([Markup.button.callback('👥 Atur Group','jsgroups')]);
 if((c?.messages||[]).length) rows.push([Markup.button.callback(`🗑 Hapus Pesan Jaseb (${c.messages.length})`,'jsdel')]);
 rows.push([Markup.button.callback('🔄 Refresh Status','jaseb')]);
 rows.push([Markup.button.callback('⬅️ Kembali','home')]);
 return Markup.inlineKeyboard(rows);
}
function jasebIntervalKb(){return Markup.inlineKeyboard([
 [Markup.button.callback('1 Menit','jsi:1'),Markup.button.callback('5 Menit','jsi:5')],
 [Markup.button.callback('10 Menit','jsi:10'),Markup.button.callback('15 Menit','jsi:15')],
 [Markup.button.callback('30 Menit','jsi:30'),Markup.button.callback('60 Menit','jsi:60')],
 [Markup.button.callback('⬅️ Kembali','jaseb')]
])}
function jasebGroupsKb(st){
 const groups=st.groups||[]; const page=Math.max(0,Number(st.page)||0); const size=6; const pages=Math.max(1,Math.ceil(groups.length/size)); const p=Math.min(page,pages-1);
 const selected=new Set(st.selected||[]); const rows=[];
 const slice=groups.slice(p*size,(p+1)*size);
 for(let i=0;i<slice.length;i+=2){
   const row=[];
   for(let j=i;j<i+2;j++){
     const g=slice[j]; if(!g) continue;
     const idx=p*size+j; const mark=selected.has(String(idx))?'✅ ':'✅ ';
     row.push(Markup.button.callback(`${mark}${String(g.title||'Group').slice(0,24)}`,`jsg:${idx}`));
   }
   rows.push(row);
 }
 rows.push([Markup.button.callback(selected.size===groups.length&&groups.length?'✅ Semua dipilih':'⬜ Pilih Semua','jsall')]);
 const nav=[];
 if(p>0) nav.push(Markup.button.callback('⬅️ Sebelumnya',`jsp:${p-1}`));
 nav.push(Markup.button.callback(`${p+1}/${pages}`,'jsnoop'));
 if(p<pages-1) nav.push(Markup.button.callback('Berikutnya ➡',`jsp:${p+1}`));
 rows.push(nav);
 rows.push([Markup.button.callback(`✅ Simpan & Aktifkan (${selected.size})`,'jssave')]);
 rows.push([Markup.button.callback('🔄 Muat Ulang Grup','jsrefresh')],[Markup.button.callback('⬅️ Kembali','jaseb')]);
 return Markup.inlineKeyboard(rows);
}
async function showJasebGroups(ctx,st,extra=''){
 const groups=st.groups||[];
 if(!groups.length) return panel(ctx,jasebConfigText(ctx.from.id,'⚠️ Tidak ada group yang bisa dipilih di akun Telegram.'),jasebMainKb(ctx.from.id));
 return panel(ctx,`📢 <b>PILIH GROUP JASEB</b>\n\n${extra?`${extra}\n\n`:''}Pilih group yang boleh menerima sebaran. Group yang tidak dipilih tidak akan menerima.\nHalaman <b>${(st.page||0)+1}/${Math.max(1,Math.ceil(groups.length/6))}</b> · Terpilih <b>${(st.selected||[]).length}</b>/${groups.length}`,jasebGroupsKb(st));
}

bot.start(ctx=>home(ctx)); bot.command('menu',ctx=>home(ctx)); bot.command('id',ctx=>ctx.reply(`Telegram ID kamu: ${ctx.from.id}`));
bot.action('toggle',async ctx=>{await ctx.answerCbQuery();if(!guard(ctx.from.id))return panel(ctx,dash(ctx.from.id,'🔒 Akses Premium diperlukan.'));const a=db.accounts(ctx.from.id),k=db.listKeywords(ctx.from.id),t=db.listTargets(ctx.from.id);if(!a.length||!k.length||!t.length)return panel(ctx,dash(ctx.from.id,'⚠️ Lengkapi akun, keyword, dan target dulu.'));const s=db.getSender(ctx.from.id)||{};s.enabled=!s.enabled;db.setSender(ctx.from.id,s);return panel(ctx,dash(ctx.from.id,`Auto Comment <b>${s.enabled?'🟢 ON':'🔴 OFF'}</b>`))});
bot.action('acc',async ctx=>{await ctx.answerCbQuery();stopLog(ctx.from.id);if(!guard(ctx.from.id))return panel(ctx,dash(ctx.from.id,'🔒 Akses Premium diperlukan.'));const a=db.accounts(ctx.from.id);return panel(ctx,dash(ctx.from.id,a.length?`📱 ${a.map(x=>`#${x.id} ${esc(x.label||x.phone)}`).join('\n')}`:'📱 Belum ada akun.'),Markup.inlineKeyboard([[Markup.button.callback(a.length?'🗑 Hapus Akun':'➕ Tambah Akun',a.length?'delacc':'addacc')],[Markup.button.callback('⬅️ Kembali','home')]]))});
bot.action('addacc',async ctx=>{await ctx.answerCbQuery();stopLog(ctx.from.id);if(!guard(ctx.from.id))return panel(ctx,dash(ctx.from.id,'🔒 Akses Premium diperlukan.'));if(!isOwner(ctx.from.id)&&db.accounts(ctx.from.id).length>=1)return panel(ctx,dash(ctx.from.id,'User Premium maksimal 1 akun.'));state.set(String(ctx.from.id),{type:'phone',chatId:ctx.callbackQuery.message.chat.id,panelId:ctx.callbackQuery.message.message_id});return panel(ctx,dash(ctx.from.id,'📱 Kirim nomor Telegram.'));});
bot.action('delacc',async ctx=>{await ctx.answerCbQuery();stopLog(ctx.from.id);if(!guard(ctx.from.id))return panel(ctx,dash(ctx.from.id,'🔒 Akses Premium diperlukan.'));const a=db.accounts(ctx.from.id)[0];if(a){await tg.stop(a.id);db.removeAccount(ctx.from.id,a.id)}return panel(ctx,dash(ctx.from.id,'✅ Akun dihapus.'))});
bot.action('kw',async ctx=>{await ctx.answerCbQuery();stopLog(ctx.from.id);if(!guard(ctx.from.id))return panel(ctx,dash(ctx.from.id,'🔒 Akses Premium diperlukan.'));const ks=db.listKeywords(ctx.from.id);return panel(ctx,dash(ctx.from.id,ks.length?ks.map(k=>`#${k.id} <b>${esc(k.word)}</b> → ${esc(previewPremiumText(k.comment))}`).join('\n'):'🔑 Belum ada keyword.'),Markup.inlineKeyboard([[Markup.button.callback('➕ Tambah','addkw'),...(ks.length?[Markup.button.callback('🗑 Hapus terakhir','delkw')]:[])],[Markup.button.callback('⬅️ Kembali','home')]]))});
bot.action('addkw',async ctx=>{await ctx.answerCbQuery();stopLog(ctx.from.id);if(!guard(ctx.from.id))return panel(ctx,dash(ctx.from.id,'🔒 Akses Premium diperlukan.'));state.set(String(ctx.from.id),{type:'kw_word',chatId:ctx.callbackQuery.message.chat.id,panelId:ctx.callbackQuery.message.message_id});return panel(ctx,dash(ctx.from.id,'🔑 Kirim keyword.'))});
bot.action('delkw',async ctx=>{await ctx.answerCbQuery();stopLog(ctx.from.id);if(!guard(ctx.from.id))return;const a=db.listKeywords(ctx.from.id);if(a.length)db.delKeyword(ctx.from.id,a[a.length-1].id);return panel(ctx,dash(ctx.from.id,'✅ Dihapus.'))});
bot.action('target',async ctx=>{await ctx.answerCbQuery();stopLog(ctx.from.id);if(!guard(ctx.from.id))return panel(ctx,dash(ctx.from.id,'🔒 Akses Premium diperlukan.'));const ts=db.listTargets(ctx.from.id);return panel(ctx,dash(ctx.from.id,ts.length?ts.map(t=>`#${t.id} 📢 ${esc(t.channel_title)} → 💬 ${esc(t.discussion_title)}`).join('\n'):'📌 Belum ada target.'),Markup.inlineKeyboard([[Markup.button.callback('➕ Tambah Target','addtarget'),...(ts.length?[Markup.button.callback('🗑 Hapus terakhir','deltarget')]:[])],[Markup.button.callback('⬅️ Kembali','home')]]))});
bot.action('addtarget',async ctx=>{await ctx.answerCbQuery();stopLog(ctx.from.id);if(!guard(ctx.from.id))return panel(ctx,dash(ctx.from.id,'🔒 Akses Premium diperlukan.'));if(!db.accounts(ctx.from.id).length)return panel(ctx,dash(ctx.from.id,'Tambahkan akun dulu.'));state.set(String(ctx.from.id),{type:'target_channel',chatId:ctx.callbackQuery.message.chat.id,panelId:ctx.callbackQuery.message.message_id});return panel(ctx,dash(ctx.from.id,'📢 <b>Pertama</b>, kirim link channel sumber.\nContoh: https://t.me/basewtb'))});
bot.action('deltarget',async ctx=>{await ctx.answerCbQuery();stopLog(ctx.from.id);if(!guard(ctx.from.id))return;const ts=db.listTargets(ctx.from.id);if(ts.length)db.delTarget(ctx.from.id,ts[ts.length-1].id);return panel(ctx,dash(ctx.from.id,'✅ Target dihapus.'))});
bot.action('log',async ctx=>{await ctx.answerCbQuery();if(!guard(ctx.from.id))return;const text=logText(ctx.from.id);const m=await panel(ctx,text,logKb());const msg=m||ctx.callbackQuery?.message;if(msg)startLog(ctx.from.id,msg.chat.id,msg.message_id);});
bot.action('clearlog',async ctx=>{await ctx.answerCbQuery('Log dibersihkan');stopLog(ctx.from.id);if(!guard(ctx.from.id))return;db.clearLogs(ctx.from.id);db.log(ctx.from.id,'system','ready','LOG CLEARED — monitoring tetap aktif');const text=logText(ctx.from.id);await panel(ctx,text,logKb());const msg=ctx.callbackQuery?.message;if(msg)startLog(ctx.from.id,msg.chat.id,msg.message_id);});
bot.action('jaseb',async ctx=>{await ctx.answerCbQuery();stopLog(ctx.from.id);if(!guard(ctx.from.id))return panel(ctx,dash(ctx.from.id,'🔒 Akses Premium diperlukan.'));return panel(ctx,jasebConfigText(ctx.from.id),jasebMainKb(ctx.from.id))});
bot.action('json',async ctx=>{await ctx.answerCbQuery();if(!guard(ctx.from.id))return;const c=db.getJaseb(ctx.from.id)||{};if(!c.text||!c.interval_min||!(Array.isArray(c.groups)&&c.groups.length))return panel(ctx,jasebConfigText(ctx.from.id,'⚠️ Jaseb belum dikonfigurasi. Atur pesan, interval, dan group dulu.'),jasebMainKb(ctx.from.id));await tg.startJaseb(ctx.from.id);db.setJaseb(ctx.from.id,{...c,enabled:true});return panel(ctx,jasebConfigText(ctx.from.id,'✅ Jaseb diaktifkan.'),jasebMainKb(ctx.from.id))});
bot.action('jsdel',async ctx=>{await ctx.answerCbQuery('Menghapus pesan Jaseb...');if(!guard(ctx.from.id))return;try{const r=await tg.deleteJasebMessages(ctx.from.id);const msg=r.total?`🗑 <b>Hapus Pesan Jaseb</b>\n\nTotal tersimpan: <b>${r.total}</b>\nBerhasil dihapus: <b>${r.deleted}</b>\nGagal: <b>${r.failed}</b>${r.failed?'\n\n⚠️ Pesan yang gagal tetap disimpan agar bisa dicoba lagi.':''}`:'ℹ️ Belum ada pesan Jaseb yang tersimpan untuk dihapus.';return panel(ctx,jasebConfigText(ctx.from.id,msg),jasebMainKb(ctx.from.id))}catch(e){return panel(ctx,jasebConfigText(ctx.from.id,`❌ Gagal menghapus pesan: ${esc(e.message)}`),jasebMainKb(ctx.from.id))}});
bot.action('jsoff',async ctx=>{await ctx.answerCbQuery('Jaseb dimatikan');stopLog(ctx.from.id);if(!guard(ctx.from.id))return;tg.stopJaseb(ctx.from.id);const c=db.getJaseb(ctx.from.id)||{};db.setJaseb(ctx.from.id,{...c,enabled:false});return panel(ctx,jasebConfigText(ctx.from.id,'✅ Jaseb dimatikan.'),jasebMainKb(ctx.from.id))});
bot.action('jsnew',async ctx=>{await ctx.answerCbQuery();stopLog(ctx.from.id);if(!guard(ctx.from.id))return;if(!db.accounts(ctx.from.id).length)return panel(ctx,jasebConfigText(ctx.from.id,'⚠️ Tambahkan akun Telegram dulu.'),jasebMainKb(ctx.from.id));state.set(String(ctx.from.id),{type:'jaseb_text',chatId:ctx.callbackQuery.message.chat.id,panelId:ctx.callbackQuery.message.message_id});return panel(ctx,jasebConfigText(ctx.from.id,'📝 Kirim teks yang akan disebarkan ke group.'))});
bot.action('jsgroups',async ctx=>{await ctx.answerCbQuery();stopLog(ctx.from.id);if(!guard(ctx.from.id))return;if(!db.accounts(ctx.from.id).length)return panel(ctx,jasebConfigText(ctx.from.id,'⚠️ Tambahkan akun Telegram dulu.'),jasebMainKb(ctx.from.id));const c=db.getJaseb(ctx.from.id)||{};if(!c.text||!c.interval_min)return panel(ctx,jasebConfigText(ctx.from.id,'⚠️ Atur pesan dan interval dulu.'),jasebMainKb(ctx.from.id));state.set(String(ctx.from.id),{type:'jaseb_groups',chatId:ctx.callbackQuery.message.chat.id,panelId:ctx.callbackQuery.message.message_id,text:c.text,interval_min:c.interval_min,page:0,selected:[],groups:[]});try{const groups=await tg.listGroups(ctx.from.id);const current=new Set((c.groups||[]).map(g=>String(g.peer_key||g.peer_id||g.id)));const selected=groups.map((g,i)=>current.has(String(g.peer_key||g.peer_id||g.id))?String(i):null).filter(Boolean);state.set(String(ctx.from.id),{...state.get(String(ctx.from.id)),groups,selected});return showJasebGroups(ctx,state.get(String(ctx.from.id)))}catch(e){return panel(ctx,jasebConfigText(ctx.from.id,`❌ ${esc(e.message)}`),jasebMainKb(ctx.from.id))}});
bot.action(/^jsi:(\d+)$/,async ctx=>{await ctx.answerCbQuery();stopLog(ctx.from.id);if(!guard(ctx.from.id))return;const mins=Number(ctx.match[1]);const st=state.get(String(ctx.from.id));if(!st||st.type!=='jaseb_interval')return;state.set(String(ctx.from.id),{...st,type:'jaseb_groups',interval_min:mins,page:0,selected:[]});try{const groups=await tg.listGroups(ctx.from.id);state.set(String(ctx.from.id),{...state.get(String(ctx.from.id)),groups});return showJasebGroups(ctx,state.get(String(ctx.from.id)),`⏱️ Interval dipilih: <b>${mins} menit</b>`)}catch(e){return panel(ctx,jasebConfigText(ctx.from.id,`❌ ${esc(e.message)}`),jasebMainKb(ctx.from.id))}});
bot.action('jsall',async ctx=>{await ctx.answerCbQuery();const st=state.get(String(ctx.from.id));if(!st||st.type!=='jaseb_groups')return;const all=Array.from({length:(st.groups||[]).length},(_,i)=>String(i));const cur=new Set(st.selected||[]);const next=cur.size===all.length?[]:all;state.set(String(ctx.from.id),{...st,selected:next});return showJasebGroups(ctx,state.get(String(ctx.from.id)))});
bot.action(/^jsg:(\d+)$/,async ctx=>{await ctx.answerCbQuery();const st=state.get(String(ctx.from.id));if(!st||st.type!=='jaseb_groups')return;const i=String(ctx.match[1]);const set=new Set(st.selected||[]);if(set.has(i))set.delete(i);else set.add(i);state.set(String(ctx.from.id),{...st,selected:[...set]});return showJasebGroups(ctx,state.get(String(ctx.from.id)))});
bot.action(/^jsp:(\d+)$/,async ctx=>{await ctx.answerCbQuery();const st=state.get(String(ctx.from.id));if(!st||st.type!=='jaseb_groups')return;state.set(String(ctx.from.id),{...st,page:Number(ctx.match[1])});return showJasebGroups(ctx,state.get(String(ctx.from.id)))});
bot.action('jsnoop',async ctx=>ctx.answerCbQuery());
bot.action('jsrefresh',async ctx=>{await ctx.answerCbQuery('Memuat ulang...');const st=state.get(String(ctx.from.id));if(!st||st.type!=='jaseb_groups')return;try{const groups=await tg.listGroups(ctx.from.id);const valid=new Set(groups.map((_,i)=>String(i)));const selected=(st.selected||[]).filter(x=>valid.has(x));state.set(String(ctx.from.id),{...st,groups,selected,page:0});return showJasebGroups(ctx,state.get(String(ctx.from.id)))}catch(e){return showJasebGroups(ctx,st,`❌ ${esc(e.message)}`)}});
bot.action('jssave',async ctx=>{await ctx.answerCbQuery();const st=state.get(String(ctx.from.id));if(!st||st.type!=='jaseb_groups')return;if(!(st.selected||[]).length)return panel(ctx,jasebConfigText(ctx.from.id,'⚠️ Pilih minimal 1 group.'));const groups=st.selected.map(i=>st.groups[Number(i)]).filter(Boolean);if(!groups.length)return;await tg.configureJaseb(ctx.from.id,{text:st.text,interval_min:st.interval_min,groups});state.delete(String(ctx.from.id));return panel(ctx,jasebConfigText(ctx.from.id,'✅ Jaseb aktif. Pengiriman pertama dilakukan setelah interval yang dipilih.'),jasebMainKb(ctx.from.id))});

bot.action('broadcast',async ctx=>{await ctx.answerCbQuery();stopLog(ctx.from.id);if(!isOwner(ctx.from.id))return;state.set(String(ctx.from.id),{type:'broadcast'});return panel(ctx,'📤 <b>Broadcast Jaseb</b>\n\nKirim satu pesan untuk dikirim ke semua user Jaseb yang sedang aktif.\nCustom Emoji pada pesan akan dipertahankan.',jasebMainKb(ctx.from.id))});
bot.action('premium',async ctx=>{await ctx.answerCbQuery();stopLog(ctx.from.id);if(!isOwner(ctx.from.id))return;const us=db.listUsers().filter(u=>u.role!=='owner');return panel(ctx,dash(ctx.from.id,us.length?us.map(u=>`${u.telegram_id} • ${u.enabled?'ON':'OFF'} • ${fmt(u.expires_at)}`).join('\n'):'Belum ada user.'),Markup.inlineKeyboard([[Markup.button.callback('➕ Tambah/Perpanjang','addprem')],[Markup.button.callback('⬅️ Kembali','home')]]))});
bot.action('addprem',async ctx=>{await ctx.answerCbQuery();stopLog(ctx.from.id);if(!isOwner(ctx.from.id))return;state.set(String(ctx.from.id),{type:'prem_id',chatId:ctx.callbackQuery.message.chat.id,panelId:ctx.callbackQuery.message.message_id});return panel(ctx,dash(ctx.from.id,'Kirim Telegram ID user.'))});
bot.action('home',async ctx=>{await ctx.answerCbQuery();stopLog(ctx.from.id);state.delete(String(ctx.from.id));return panel(ctx,dash(ctx.from.id))});

bot.on('text',async ctx=>{const id=String(ctx.from.id),st=state.get(id);if(!st)return;await del(ctx,ctx.message.message_id);try{const text=ctx.message.text.trim(); const premiumText=toPremiumText(ctx.message).trim();
 if(st.type==='broadcast'){if(!isOwner(ctx.from.id))throw Error('Akses ditolak.');if(!text)throw Error('Pesan broadcast kosong.');const users=db.listUsers().filter(u=>db.active(u));let ok=0,fail=0;const entities=Array.isArray(ctx.message.entities)&&ctx.message.entities.length?ctx.message.entities.map(e=>({...e})):undefined;for(const u of users){try{await ctx.telegram.sendMessage(Number(u.telegram_id),text,entities?{entities}:{});ok++;}catch{fail++;}}state.delete(id);return statePanel(ctx,dash(ctx.from.id,`✅ <b>Broadcast selesai.</b>\n📤 Berhasil: <b>${ok}</b>\n❌ Gagal: <b>${fail}</b>\n👥 Total aktif: <b>${users.length}</b>`));}
 if(st.type==='phone'){const r=await tg.beginLogin(text);state.set(id,{...st,type:'code',loginId:r.id});return statePanel(ctx,dash(ctx.from.id,'📲 Kode OTP dikirim. Kirim kodenya.'))}
 if(st.type==='code'){const r=await tg.code(st.loginId,text);if(r.status==='password'){state.set(id,{...st,type:'password'});return statePanel(ctx,dash(ctx.from.id,'🔐 Kirim password 2FA.'))}const a=await tg.saveLogin(ctx.from.id,r);state.delete(id);return statePanel(ctx,dash(ctx.from.id,`✅ Akun ${esc(a.label)} tersimpan.`))}
 if(st.type==='password'){const r=await tg.password(st.loginId,text);const a=await tg.saveLogin(ctx.from.id,r);state.delete(id);return statePanel(ctx,dash(ctx.from.id,`✅ Akun ${esc(a.label)} tersimpan.`))}
 if(st.type==='jaseb_text'){if(!premiumText)throw Error('Teks sebar kosong.');state.set(id,{...st,type:'jaseb_interval',text:premiumText});return panel(ctx,`📢 <b>INTERVAL JASEB</b>\n\nTeks:\n<blockquote>${esc(text)}</blockquote>\n\nPilih berapa menit sekali sebar dilakukan.`,jasebIntervalKb())}
 if(st.type==='kw_word'){if(!text)throw Error('Keyword kosong.');state.set(id,{...st,type:'kw_comment',word:text});return statePanel(ctx,dash(ctx.from.id,'💬 Sekarang kirim teks reply.'))}
 if(st.type==='kw_comment'){const ts=db.listTargets(ctx.from.id);const targetId=ts.length===1?ts[0].id:null;db.addKeyword(ctx.from.id,st.word,premiumText,targetId);state.delete(id);return statePanel(ctx,dash(ctx.from.id,targetId?`✅ Keyword + reply tersimpan untuk Target #${targetId}.`:'✅ Keyword + reply tersimpan.'))}
 if(st.type==='target_channel'){const a=db.accounts(ctx.from.id)[0];const ch=await tg.resolveTarget(ctx.from.id,a.id,text);if(ch.kind!=='channel')throw Error('Link pertama harus channel.');state.set(id,{...st,type:'target_discussion',channel:ch});return statePanel(ctx,dash(ctx.from.id,'💬 <b>Kedua</b>, sekarang kirim link group discussion.\nContoh: https://t.me/basewtbchat'))}
 if(st.type==='target_discussion'){const a=db.accounts(ctx.from.id)[0];const dg=await tg.resolveTarget(ctx.from.id,a.id,text);if(dg.kind!=='group')throw Error('Link kedua harus group/supergroup discussion.');const client=await tg.connect(a);const check=await tg.validateLinkedDiscussion(client,st.channel.ref,dg.peer_id);if(!check.ok)throw Error(check.reason);const target=db.addTarget(ctx.from.id,{account_id:a.id,channel_ref:st.channel.ref,channel_peer_id:st.channel.peer_id,channel_title:st.channel.title,discussion_ref:dg.ref,discussion_peer_id:check.linked_peer_id||dg.peer_id,discussion_title:dg.title});await tg.activateTarget(ctx.from.id,target);state.delete(id);return statePanel(ctx,dash(ctx.from.id,`✅ Target #${target.id} siap.\n👀 Channel + discussion dipantau real-time.\n📋 Buka Log untuk melihat setiap event dan jumlah SENT.`))}
 if(st.type==='prem_id'){if(!/^\d+$/.test(text))throw Error('Telegram ID harus angka.');state.set(id,{...st,type:'prem_weeks',premId:text});return statePanel(ctx,dash(ctx.from.id,'Kirim 1, 2, 3, atau 4 minggu.'))}
 if(st.type==='prem_weeks'){const w=Number(text);if(![1,2,3,4].includes(w))throw Error('Pilih 1–4 minggu.');const u=db.addPremium(st.premId,w);state.delete(id);return statePanel(ctx,dash(ctx.from.id,`✅ Premium sampai ${fmt(u.expires_at)}.`))}
}catch(e){db.log(ctx.from.id,'ui','error',e.message);return statePanel(ctx,dash(ctx.from.id,`❌ ${esc(e.message)}`))}});
setInterval(()=>db.disableExpired(),60000);
(async()=>{db.ensureUser(OWNER,'owner');await tg.bootstrap();await bot.launch();console.log('✅ Bot siap')})();
process.once('SIGINT',()=>bot.stop('SIGINT'));process.once('SIGTERM',()=>bot.stop('SIGTERM'));
