const { Markup } = require('telegraf');
const { premium, unicode, customId } = require('./emoji');
const config = require('./config');
const db = require('./db');

function esc(v='') { return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }
function callbackButton(key,text,data) {
  return { text: `${unicode(key)} ${text}`, callback_data: data };
}
function urlButton(key,text,url) { return { text: `${unicode(key)} ${text}`, url }; }
function kb(rows) { return Markup.inlineKeyboard(rows); }
function layout2(items) { const rows=[]; for(let i=0;i<items.length;i+=2) rows.push(items.slice(i,i+2)); return rows; }
async function toast(ctx, text, alert=false) { try { await ctx.answerCbQuery(String(text).slice(0,190), {show_alert:alert}); } catch {} }
function title(text, key='info') { return `${premium(key)} <b>${esc(text)}</b>`; }
function panel(text, second=null) {
  let out = `<blockquote>━━━━━━━━━━━━━━━━━━\n${text}\n━━━━━━━━━━━━━━━━━━</blockquote>`;
  if (second) out += `\n\n<blockquote>${second}</blockquote>`;
  return out;
}
function statusLine(key,label,value) { return `${premium(key)} ${esc(label)}: <b>${esc(value)}</b>`; }
function isOwner(userId) { return Number(userId)===config.ownerId && config.ownerId>0; }
function isGlobalAdmin(userId) { return isOwner(userId) || config.adminIds.includes(Number(userId)) || db.isAdmin(userId); }
async function requireGlobalAdmin(ctx) { if (isGlobalAdmin(ctx.from.id)) return true; await toast(ctx,'Lu bukan admin tol, gausah di pencet rese',true); return false; }
async function requireGroupAdmin(ctx, chatId) {
  const chat = ctx.callbackQuery?.message?.chat || ctx.chat;
  const id = Number(chatId || chat?.id || 0);
  if (!id || !['group','supergroup'].includes(chat?.type)) { await toast(ctx,'Tombol ini hanya bisa dipakai di grup.',true); return false; }
  try { const m=await ctx.telegram.getChatMember(id,ctx.from.id); if(['creator','administrator'].includes(m.status)) return true; } catch {}
  await toast(ctx,'Lu bukan admin tol, gausah di pencet rese',true); return false;
}
function durationKeyboard(prefix, chatId, page=0) {
  const vals=Array.from({length:10},(_,i)=>page*10+i+1).filter(v=>v<=30); const rows=layout2(vals.map(v=>callbackButton('time',String(v),`${prefix}:${chatId}:${v}`)));
  const nav=[]; if(page>0) nav.push(callbackButton('back','Sebelumnya',`${prefix}_page:${chatId}:${page-1}`)); if(page<2) nav.push(callbackButton('info','Berikutnya',`${prefix}_page:${chatId}:${page+1}`)); if(nav.length) rows.push(nav);
  rows.push([callbackButton('back','Kembali',`${prefix}_cancel:${chatId}`)]); return kb(rows);
}
module.exports={esc,sleep,callbackButton,urlButton,kb,layout2,toast,title,panel,statusLine,isOwner,isGlobalAdmin,requireGlobalAdmin,requireGroupAdmin,durationKeyboard,customId};
