const db = require('./db');
const config = require('./config');
const { premium, unicode } = require('./emoji');
const { callbackButton, kb, urlButton, esc, toast, requireGlobalAdmin, requireGroupAdmin } = require('./ui');

const drafts=new Map();
const pendingInput=new Map();
const eventSeen=new Map();

function ensureDraft(groupId,userId){ const key=`${userId}:${groupId}`; if(!drafts.has(key)){ const s=db.groupSettings(groupId); drafts.set(key,{groupId:Number(groupId),enabled:!!s.welcome_enabled,message:s.welcome_message,banner_file_id:s.welcome_banner_file_id,banner_type:s.welcome_banner_type,buttons:JSON.parse(s.welcome_buttons_json||'[]'),autodelete:Number(s.welcome_autodelete)||0,goodbye_enabled:!!s.goodbye_enabled,goodbye_message:s.goodbye_message,goodbye_banner_file_id:s.goodbye_banner_file_id,goodbye_banner_type:s.goodbye_banner_type,goodbye_buttons:JSON.parse(s.goodbye_buttons_json||'[]'),goodbye_autodelete:Number(s.goodbye_autodelete)||0,dirty:false}); } return drafts.get(key); }
function saveDraft(groupId,userId){ const d=ensureDraft(groupId,userId); db.saveGroupSettings(groupId,{welcome_enabled:d.enabled?1:0,welcome_message:d.message,welcome_banner_file_id:d.banner_file_id,welcome_banner_type:d.banner_type,welcome_buttons_json:JSON.stringify(d.buttons),welcome_autodelete:d.autodelete,goodbye_enabled:d.goodbye_enabled?1:0,goodbye_message:d.goodbye_message,goodbye_banner_file_id:d.goodbye_banner_file_id,goodbye_banner_type:d.goodbye_banner_type,goodbye_buttons_json:JSON.stringify(d.goodbye_buttons),goodbye_autodelete:d.goodbye_autodelete}); d.dirty=false; return d; }
function resetDraft(groupId,userId){ const key=`${userId}:${groupId}`; drafts.delete(key); return ensureDraft(groupId,userId); }
function targetTitle(groupId){ const t=db.targets().find(x=>Number(x.chat_id)===Number(groupId)); return t?.title || String(groupId); }
function settingsText(groupId,userId){ const d=ensureDraft(groupId,userId); return `<blockquote>━━━━━━━━━━━━━━━━━━\n${premium('welcome')} <b>Welcome / Goodbye Settings</b>\n\nTarget: <b>${esc(targetTitle(groupId))}</b>\n\n${premium('open')} Welcome: <b>${d.enabled?'ON':'OFF'}</b>\n${premium('banner')} Banner: <b>${d.banner_file_id?'Ada':'Belum ada'}</b>\n${premium('message')} Pesan: <b>${d.message?'Sudah diatur':'Belum diatur'}</b>\n${premium('link')} Tombol: <b>${d.buttons.length}</b>\n${premium('time')} Auto Delete: <b>${d.autodelete?`${d.autodelete}s`:'OFF'}</b>\n\n${premium('goodbye')} Goodbye: <b>${d.goodbye_enabled?'ON':'OFF'}</b>\n${premium('message')} Pesan Goodbye: <b>${d.goodbye_message?'Sudah diatur':'Belum diatur'}</b>\n${premium('banner')} Goodbye Banner: <b>${d.goodbye_banner_file_id?'Ada':'Belum ada'}</b>\n${premium('time')} Goodbye Delete: <b>${d.goodbye_autodelete?`${d.goodbye_autodelete}s`:'OFF'}</b>\n\nStatus draft: <b>${d.dirty?'Belum disimpan':'Tersimpan'}</b>\n━━━━━━━━━━━━━━━━━━</blockquote>`; }
function settingsKeyboard(groupId,index,userId=0){ const d=ensureDraft(groupId,userId); return kb([
  [callbackButton('welcome',`Welcome: ${d.enabled?'ON':'OFF'}`,`wel:toggle:${groupId}:${index}`),callbackButton('goodbye',`Goodbye: ${d.goodbye_enabled?'ON':'OFF'}`,`bye:toggle:${groupId}:${index}`)],
  [callbackButton('message','Set Pesan',`wel:msg:${groupId}:${index}`),callbackButton('banner','Set Banner',`wel:banner:${groupId}:${index}`)],
  [callbackButton('link','Set Tombol',`wel:buttons:${groupId}:${index}`),callbackButton('delete','Hapus Tombol',`wel:clearbuttons:${groupId}:${index}`)],
  [callbackButton('time',`Auto Delete: ${d.autodelete?d.autodelete+'s':'OFF'}`,`wel:auto:${groupId}:${index}`),callbackButton('time',`Goodbye Delete: ${d.goodbye_autodelete?d.goodbye_autodelete+'s':'OFF'}`,`bye:auto:${groupId}:${index}`)],
  [callbackButton('message','Set Goodbye',`bye:msg:${groupId}:${index}`),callbackButton('banner','Set Goodbye Banner',`bye:banner:${groupId}:${index}`)],
  [callbackButton('dashboard','Preview',`wel:preview:${groupId}:${index}`),callbackButton('tagall','Test Welcome',`wel:test:${groupId}:${index}`)],
  [callbackButton('save','Simpan',`wel:save:${groupId}:${index}`),callbackButton('reset','Reset Draft',`wel:reset:${groupId}:${index}`)],
  [callbackButton('back','Kembali','welcome:targets')]
 ]); }
function targetKeyboard(){ const allowed=new Set(config.targetLinks); const ts=db.targets().filter(t=>allowed.has(t.link) && t.chat_id); const rows=ts.map((t,i)=>[callbackButton('group',`${t.title||'Target'} · ${db.memberCount(t.chat_id)} member`,`wel:edit:${t.chat_id}:${i}`)]); rows.push([callbackButton('assistant','Sync Semua Target','sync')]); rows.push([callbackButton('back','Kembali','admin')]); return kb(rows); }
function setInput(userId,chatId,type,extra={}){ pendingInput.set(Number(userId),{chatId:Number(chatId),type,...extra}); }
function takeInput(userId){ const v=pendingInput.get(Number(userId)); pendingInput.delete(Number(userId)); return v; }
function currentInput(userId){ return pendingInput.get(Number(userId)); }
function vars(user,chat,count){ const first=user.first_name||user.firstName||''; const last=user.last_name||user.lastName||''; const full=[first,last].filter(Boolean).join(' ')||user.username||String(user.id); return {mention:`<a href="tg://user?id=${Number(user.id)}">${esc(full)}</a>`,first_name:esc(first),last_name:esc(last),fullname:esc(full),username:user.username?`@${esc(user.username)}`:'',id:String(user.id),group:esc(chat.title||''),member_count:String(count||0)}; }
function render(template,user,chat,count){ const v=vars(user,chat,count); return String(template||'').replace(/\{(mention|first_name|last_name|fullname|username|id|group|member_count)\}/g,(_,k)=>v[k]??''); }
function parseButtons(jsonText){ const rows=[]; for(const line of String(jsonText||'').split('\n').map(s=>s.trim()).filter(Boolean)){ const i=line.indexOf('|'); if(i<1) continue; const text=line.slice(0,i).trim(); const url=line.slice(i+1).trim(); if(/^https?:\/\//i.test(url)) rows.push({text,url}); if(rows.length>=12) break; } return rows; }
function buttonsMarkup(buttons){ if(!buttons.length)return undefined; const rows=[]; for(let i=0;i<buttons.length;i+=2) rows.push(buttons.slice(i,i+2).map(b=>urlButton('link',b.text,b.url))); return kb(rows); }
async function sendConfigured(bot,groupId,user,type){ const s=db.groupSettings(groupId); const isWelcome=type==='welcome'; const enabled=isWelcome?s.welcome_enabled:s.goodbye_enabled; if(!enabled)return; const template=isWelcome?s.welcome_message:s.goodbye_message; const count=db.memberCount(groupId); const chat=await bot.telegram.getChat(groupId); const body=render(template,user,chat,count); const buttons=JSON.parse((isWelcome?s.welcome_buttons_json:s.goodbye_buttons_json)||'[]'); const banner=isWelcome?s.welcome_banner_file_id:s.goodbye_banner_file_id; const bannerType=isWelcome?s.welcome_banner_type:s.goodbye_banner_type; const autoDelete=Number(isWelcome?s.welcome_autodelete:s.goodbye_autodelete)||0;
  let msg; const extra={parse_mode:'HTML',reply_markup:buttonsMarkup(buttons),link_preview_options:{is_disabled:false}};
  if(banner){ if(bannerType==='photo') msg=await bot.telegram.sendPhoto(groupId,banner,{caption:body,...extra}); else msg=await bot.telegram.sendDocument(groupId,banner,{caption:body,...extra}); }
  else msg=await bot.telegram.sendMessage(groupId,body,extra);
  if(autoDelete) setTimeout(()=>bot.telegram.deleteMessage(groupId,msg.message_id).catch(()=>{}),autoDelete*1000);
}

async function sendDraftPreview(bot, groupId, userId, destinationChatId){
  const d=ensureDraft(groupId,userId);
  const chat=await bot.telegram.getChat(groupId);
  const fake={id:Number(userId),first_name:'Preview',last_name:'User',username:'preview'};
  const body=render(d.message,fake,chat,db.memberCount(groupId));
  const markup=buttonsMarkup(d.buttons);
  const extra={parse_mode:'HTML',reply_markup:markup,link_preview_options:{is_disabled:false}};
  if(d.banner_file_id){ if(d.banner_type==='photo') return bot.telegram.sendPhoto(destinationChatId,d.banner_file_id,{caption:body,...extra}); return bot.telegram.sendDocument(destinationChatId,d.banner_file_id,{caption:body,...extra}); }
  return bot.telegram.sendMessage(destinationChatId,body,extra);
}

function statusIsMember(x){ return ['member','administrator','creator'].includes(x?.status)||(x?.status==='restricted'&&x?.is_member===true); }
function shouldWelcome(oldM,newM){ return !statusIsMember(oldM)&&statusIsMember(newM); }
function shouldGoodbye(oldM,newM){ return statusIsMember(oldM)&&['left','kicked'].includes(newM?.status); }
async function handleChatMember(bot,ctx){ const u=ctx.chatMember; const chat=u.chat; if(!['group','supergroup'].includes(chat.type))return; const groupId=Number(chat.id); if(!db.targets().some(t=>Number(t.chat_id)===groupId)) return; const oldM=u.old_chat_member,newM=u.new_chat_member; const uid=Number(newM?.user?.id||oldM?.user?.id||0); if(!uid || newM?.user?.is_bot) return; const key=`${groupId}:${uid}:${newM.status}:${u.date||0}`; if(eventSeen.has(key)) return; eventSeen.set(key,Date.now()); setTimeout(()=>eventSeen.delete(key),120000); const user={id:uid,first_name:newM?.user?.first_name||oldM?.user?.first_name||'',last_name:newM?.user?.last_name||oldM?.user?.last_name||'',username:newM?.user?.username||oldM?.user?.username||''}; if(shouldWelcome(oldM,newM)) await sendConfigured(bot,groupId,user,'welcome'); else if(shouldGoodbye(oldM,newM)) await sendConfigured(bot,groupId,user,'goodbye'); }
function attach(bot){ bot.on('chat_member',ctx=>handleChatMember(bot,ctx).catch(e=>db.log(null,'welcome.event.error',e.message))); bot.on('chat_join_request',async ctx=>{ db.log(null,'join_request.pending',String(ctx.chatJoinRequest?.from?.id||'')); }); }
module.exports={attach,ensureDraft,saveDraft,resetDraft,settingsText,settingsKeyboard,targetKeyboard,setInput,takeInput,currentInput,render,parseButtons,buttonsMarkup,sendConfigured,sendDraftPreview,targetTitle,pendingInput};
