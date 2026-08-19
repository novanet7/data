'use strict';
require('dotenv').config();
const fs=require('fs');const path=require('path');const {Telegraf,Markup}=require('telegraf');
const db=require('./db');const tenant=require('./tenant');
const catalog=require('../catalog/bots.json');
const backup=require('./backup');
if(!process.env.SAAS_BOT_TOKEN)throw Error('SAAS_BOT_TOKEN belum diisi');
if(!process.env.SAAS_OWNER_ID)throw Error('SAAS_OWNER_ID belum diisi');
const OWNER=Number(process.env.SAAS_OWNER_ID); db.addAdmin(OWNER);
const bot=new Telegraf(process.env.SAAS_BOT_TOKEN);const premiumBridge=require('./premium-bridge');premiumBridge.install(bot);premiumBridge.installContext(require('telegraf'));const state=new Map();
const money=n=>new Intl.NumberFormat('id-ID').format(Number(n)||0);const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function isAdmin(id){return db.isAdmin(id)}
function kb(rows){
  const input=Array.isArray(rows)?rows:[];
  const normalized=input.map(row=>{
    if(Array.isArray(row) && row.length===2 && typeof row[0]==='string' && typeof row[1]==='string'){
      return Markup.button.callback(row[0],row[1]);
    }
    if(Array.isArray(row)){
      return row.map(btn=>{
        if(Array.isArray(btn) && btn.length===2 && typeof btn[0]==='string' && typeof btn[1]==='string'){
          return Markup.button.callback(btn[0],btn[1]);
        }
        return btn;
      });
    }
    return row;
  });
  return Markup.inlineKeyboard(normalized,{columns:1});
}
function panel(ctx,text,rows=[]){const extra={parse_mode:'HTML',...kb(rows)};return ctx.callbackQuery?.message?ctx.editMessageText(text,extra).catch(()=>ctx.reply(text,extra)):ctx.reply(text,extra)}
function homeText(id){const u=db.getUser(id)||{balance:0};const s=db.settings();return `<b>${esc(s.storeName)}</b>\n━━━━━━━━━━━━\n\n${esc(s.welcomeMessage).replace(/\{name\}/g,esc(ctxName(id)))}\n\n━━━━━━━━━━━━\n💰 Saldo: <b>Rp${money(u.balance)}</b>\n━━━━━━━━━━━━`}
function ctxName(id){return db.getUser(id)?.firstName||'Kak'}
function catalogByNumericId(value){const n=Number(value);return Number.isInteger(n)&&n>=1&&n<=catalog.length?catalog[n-1]:catalog.find(b=>b.id===String(value))}
function catalogLabel(b){const i=catalog.findIndex(x=>x.id===b.id)+1;return `${i}. ${b.name}`}
function homeRows(id){return [[`🤖 Pilih Bot`,'bots'],['💰 Deposit','deposit'],['📦 Bot Saya','mybots'],['ℹ️ Bantuan','help'],...(isAdmin(id)?[['🛠️ Admin Panel','admin']]:[])]}
async function home(ctx){db.user(ctx.from.id,{firstName:ctx.from.first_name||'',username:ctx.from.username||''});const s=db.settings();const text=homeText(ctx.from.id);const rows=homeRows(ctx.from.id);if(s.bannerFileId){try{if(s.bannerType==='animation')return ctx.replyWithAnimation(s.bannerFileId,{caption:text,parse_mode:'HTML',...kb(rows)});return ctx.replyWithPhoto(s.bannerFileId,{caption:text,parse_mode:'HTML',...kb(rows)})}catch{}}return ctx.reply(text,{parse_mode:'HTML',...kb(rows)})}
function enabledCatalog(){return catalog.filter(b=>db.isBotEnabled(b.id))}
function botRows(){return enabledCatalog().map(b=>[`🤖 ${b.name}`,`bot:${b.id}`]).concat([['👋 Home','home']])}
bot.start(home);bot.command('menu',home);
bot.action('home',async c=>{await c.answerCbQuery();return home(c)});
bot.action('bots',async c=>{await c.answerCbQuery();return panel(c,'<b>Pilih bot yang ingin dibeli</b>\n\nSetiap pembelian membuat instance terpisah dan memakai Bot Token milikmu sendiri.',botRows())});
bot.action(/^bot:(.+)$/,async c=>{await c.answerCbQuery();const b=catalog.find(x=>x.id===c.match[1]);if(!b||!db.isBotEnabled(b.id))return c.answerCbQuery('Bot tidak tersedia',{show_alert:true});const plan=db.plans()[b.id];const u=db.user(c.from.id);return panel(c,`<b>${esc(b.name)}</b>\n\n${esc(b.description)}\n\n💰 Harga: <b>Rp${money(plan.price)}</b>\n⏱️ Masa aktif: <b>${plan.durationDays} hari</b>\n💳 Saldo kamu: <b>Rp${money(u.balance)}</b>`,[[`✅ Beli Bot`,`buy:${b.id}`],['↩️ Pilih Bot','bots'],['👋 Home','home']])});
bot.action(/^buy:(.+)$/,async c=>{await c.answerCbQuery();const type=c.match[1],b=catalog.find(x=>x.id===type),plan=db.plans()[type];if(!b)return c.answerCbQuery('Bot tidak ada',{show_alert:true});const u=db.user(c.from.id);if(Number(plan.price)>Number(u.balance))return panel(c,`❌ Saldo tidak cukup.\n\nHarga: <b>Rp${money(plan.price)}</b>\nSaldo: <b>Rp${money(u.balance)}</b>\n\nSilakan deposit dulu.`,[['💰 Deposit','deposit'],['↩️ Kembali',`bot:${type}`]]);state.set(String(c.from.id),{type:'token',botType:type,price:Number(plan.price),durationDays:Number(plan.durationDays||30)});return panel(c,`🔐 <b>Masukkan Bot Token ${esc(b.name)}</b>\n\nBuka @BotFather → /newbot → salin token → kirim di chat ini.\n\nToken akan dipakai hanya untuk instance bot milikmu.`,[['❌ Batal','bots']])});
function adminRows(){const closed=db.settings().allStoresClosed===true;return [['🛡️ Backup & Restore','admin:backup'],['💰 Set Harga','admin:price'],['🧾 Set QRIS','admin:qris'],['💳 Deposit Pending','admin:deposits'],['🖼️ Set Banner','admin:banner'],['🎨 Set Sticker','admin:sticker'],['📤 Broadcast','admin:broadcast'],['👑 Tambah Admin','admin:add'],['⚙️ Kelola Daftar Bot','admin:catalog'],['📊 Tenant Aktif','admin:tenants'],[closed?'🟢 Buka Semua Toko':'🔴 Tutup Semua Toko',closed?'admin:stores:open':'admin:stores:close'],['🔎 Tes Emoji Premium','admin:premium-test'],['👋 Home','home']]}
bot.action('admin',async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();const closed=db.settings().allStoresClosed===true;return panel(c,`<b>Admin SaaS</b>\n\nKelola harga, QRIS, banner, sticker, admin, tenant, dan status semua toko.\n\n🏪 Semua toko: <b>${closed?'🔴 DITUTUP':'🟢 TERBUKA'}</b>`,adminRows())});

bot.action('admin:stores:close',async c=>{
  if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});
  await c.answerCbQuery('Menutup semua toko...');
  try{
    const result=await tenant.closeAllStores();
    return panel(c,`🔴 <b>Semua toko ditutup.</b>\n\n🏪 Tenant dihentikan: <b>${result.count}</b>\n🟢 SaaS tetap online.\n\nSaat <b>Buka Semua Toko</b> ditekan, tenant akan dinyalakan kembali otomatis.`,[['🟢 Buka Semua Toko','admin:stores:open'],['↩️ Admin','admin']]);
  }catch(e){
    return panel(c,`❌ <b>Gagal menutup semua toko.</b>\n\n<code>${esc(e.message)}</code>`,[['↩️ Admin','admin']]);
  }
});

bot.action('admin:stores:open',async c=>{
  if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});
  await c.answerCbQuery('Menyalakan semua toko...');
  try{
    const result=await tenant.openAllStores();
    const fail=result.failed?.length||0;
    return panel(c,`🟢 <b>Semua toko dibuka.</b>\n\n🏪 Total tenant: <b>${result.count}</b>\n✅ Dinyalakan: <b>${result.started.length}</b>\n❌ Gagal: <b>${fail}</b>\n\nSaaS tetap online dan tenant yang berhasil akan berjalan dengan auto-restart.`,[['🔴 Tutup Semua Toko','admin:stores:close'],['📊 Tenant Aktif','admin:tenants'],['↩️ Admin','admin']]);
  }catch(e){
    return panel(c,`❌ <b>Gagal membuka semua toko.</b>\n\n<code>${esc(e.message)}</code>`,[['↩️ Admin','admin']]);
  }
});
bot.action('admin:price',async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();const rows=catalog.map((b,i)=>[`#${i+1} ${b.name} • Rp${money(db.plans()[b.id].price)} / ${db.plans()[b.id].durationDays} hari`,`admin:price:bot:${i+1}`]);return panel(c,'<b>Set Harga</b>\n\nPilih nomor bot. Setelah itu kirim harga, lalu jumlah hari masa aktif.',rows.concat([['↩️ Admin','admin']]))});
bot.action(/^admin:price:bot:(\d+)$/,async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();const b=catalogByNumericId(c.match[1]);if(!b)return c.answerCbQuery('Bot tidak ditemukan',{show_alert:true});state.set(String(c.from.id),{type:'price_amount',botId:b.id});return panel(c,`<b>${esc(catalogLabel(b))}</b>\n\nHarga saat ini: <b>Rp${money(db.plans()[b.id].price)}</b>\nMasa aktif saat ini: <b>${db.plans()[b.id].durationDays} hari</b>\n\nKirim <b>harga baru</b> dalam rupiah. Contoh: <code>25000</code>`,[['↩️ Set Harga','admin:price'],['🛠️ Admin','admin']])});

bot.action('admin:qris',async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();state.set(String(c.from.id),{type:'qris'});return panel(c,'📷 Kirim foto QRIS sekarang. Setelah itu QRIS otomatis tersimpan.',[['↩️ Admin','admin']])});
bot.action('admin:banner',async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();state.set(String(c.from.id),{type:'banner'});return panel(c,'🖼️ Kirim foto banner sekarang. GIF/animation bisa dikonfigurasi dari upload terpisah bila diperlukan.',[['↩️ Admin','admin']])});
bot.action('admin:sticker',async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();state.set(String(c.from.id),{type:'sticker'});return panel(c,'🎨 Kirim sticker sekarang untuk disimpan sebagai sticker deposit.',[['↩️ Admin','admin']])});
bot.action('admin:add',async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();state.set(String(c.from.id),{type:'adminadd'});return panel(c,'Kirim Telegram ID admin baru.',[['↩️ Admin','admin']])});
bot.action('admin:backup',async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();const d=backup.backupDestinationInfo();const dest=d.mode==='custom'?`🤖 Bot Backup: <b>@${esc(d.botUsername||'custom')}</b>\n👤 Tujuan: <code>${d.chatId}</code>`:`🤖 Bot SaaS\n👤 Tujuan: <code>${d.chatId}</code>`;const rows=[];if(Number(c.from.id)===OWNER){rows.push(['⚙️ Set Bot Backup','admin:backup:settings']);}if(Number(c.from.id)===OWNER)rows.push(['♻️ Restore dari File Backup','admin:backup:prepare']);if(Number(c.from.id)===OWNER)rows.push(['🚀 Backup Sekarang','admin:backup:now']);rows.push(['📤 Kirim Ulang Backup Terakhir','admin:backup:resend'],['↩️ Admin','admin']);return panel(c,`🛡️ <b>Backup & Restore SaaS</b>\n\nBackup otomatis dibuat setiap ada perubahan data penting pada seluruh store dan digabung menjadi <b>1 file global</b>.\n\n${dest}\n\n✅ Log realtime/volatile tidak dijadikan trigger backup.\n📦 Session Archive ikut snapshot.\n🔐 Restore hanya dapat dijalankan oleh Owner SaaS.`,rows)});
bot.action('admin:backup:prepare',async c=>{if(Number(c.from.id)!==OWNER)return c.answerCbQuery('Hanya Owner SaaS yang boleh restore.',{show_alert:true});await c.answerCbQuery();state.set(String(c.from.id),{type:'restore_backup'});return panel(c,'♻️ <b>Restore Backup SaaS</b>\n\nKirim file <code>telegram-saas-backup-*.zip</code> dari chat/backup Owner lama ke sini.\n\n⚠️ Setelah valid, data SaaS + runtime tenant akan dipulihkan dan proses SaaS akan restart.',[['❌ Batal','admin:backup'],['↩️ Admin','admin']])});


bot.action('admin:backup:settings',async c=>{if(Number(c.from.id)!==OWNER)return c.answerCbQuery('Hanya Owner SaaS yang boleh mengubah pengaturan backup.',{show_alert:true});await c.answerCbQuery();const d=backup.backupDestinationInfo();return panel(c,`⚙️ <b>Pengaturan Bot Backup</b>\n\nMode saat ini: <b>${d.mode==='custom'?'Custom Bot':'Bot SaaS'}</b>\n${d.botUsername?`🤖 Bot: <b>@${esc(d.botUsername)}</b>\n`:''}👤 Chat ID tujuan: <code>${d.chatId}</code>\n\nCustom Bot harus sudah di-<b>/start</b> oleh Owner agar dapat menerima file.`,[['🤖 Pakai Bot SaaS','backup:set:saas'],['🧩 Pakai Bot Backup Custom','backup:set:custom'],['↩️ Backup & Restore','admin:backup']])});
bot.action('backup:set:saas',async c=>{if(Number(c.from.id)!==OWNER)return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery('Backup via Bot SaaS');try{await backup.configureBackupDestination({mode:'saas',chatId:OWNER});return panel(c,'✅ <b>Bot SaaS dipilih sebagai pengirim backup.</b>\n\nSemua backup global akan dikirim ke Owner SaaS dari bot utama.',[['🛡️ Backup & Restore','admin:backup'],['↩️ Admin','admin']]);}catch(e){return panel(c,`❌ <b>Gagal mengatur backup.</b>\n\n<code>${esc(e.message)}</code>`,[['↩️ Backup & Restore','admin:backup']])}});
bot.action('backup:set:custom',async c=>{if(Number(c.from.id)!==OWNER)return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();state.set(String(c.from.id),{type:'backup_bot_token'});return panel(c,'🤖 <b>Set Bot Backup Custom</b>\n\nKirim <b>token BotFather</b> bot backup.\n\nSetelah diterima, token akan divalidasi ke Telegram dan disimpan terenkripsi.\n\nBot backup harus sudah kamu /start agar nanti bisa mengirim file ke akunmu.',[['❌ Batal','admin:backup:settings']])});
bot.action('admin:backup:now',async c=>{if(Number(c.from.id)!==OWNER)return c.answerCbQuery('Hanya Owner SaaS yang boleh memaksa backup.',{show_alert:true});await c.answerCbQuery('Membuat backup global...');try{const result=await backup.forceBackup('manual-owner-backup');return panel(c,`✅ <b>Backup global berhasil dikirim.</b>\n\n📦 File: <code>${esc(result.fileName||'backup.zip')}</code>\n💾 Size: <b>${((result.size||0)/1024/1024).toFixed(2)} MB</b>\n🔐 SHA-256: <code>${esc(result.checksum||'-')}</code>\n🤖 Pengirim: <b>${esc(result.senderMode==='custom'?'Bot Backup Custom':'Bot SaaS')}</b>\n🕐 ${new Date().toLocaleString('id-ID')}`,[['🛡️ Backup & Restore','admin:backup'],['↩️ Admin','admin']]);}catch(e){return panel(c,`❌ <b>Backup gagal.</b>\n\n<code>${esc(e.message)}</code>`,[['⚡ Coba Lagi','admin:backup:now'],['🛡️ Backup & Restore','admin:backup'],['↩️ Admin','admin']])}});
bot.action('admin:backup:resend',async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery('Mengirim backup terakhir...');try{await backup.resendLast();return c.answerCbQuery('Backup terakhir dikirim.',{show_alert:true});}catch(e){return c.answerCbQuery(e.message,{show_alert:true})}});
bot.action('admin:broadcast',async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();state.set(String(c.from.id),{type:'broadcast'});return panel(c,'📤 <b>Broadcast SaaS</b>\n\nKirim pesan yang akan diteruskan ke semua user terdaftar.\nCustom Emoji dari pesanmu tetap dipertahankan.',[['↩️ Admin','admin']])});
bot.action('admin:premium-test',async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();const bridge=require('./premium-bridge');try{await bridge.probe(bot.telegram,c.from.id);await bot.telegram.sendMessage(c.from.id,'<b>✨ Tes Archive Premium Emoji</b>\n\n<tg-emoji emoji-id=\"5316743524706698146\">👋</tg-emoji> Pesan premium diambil dari mapping Archive.',{parse_mode:'HTML',...kb([['🤖 Tes Tombol Archive','admin:premium-test:noop'],['💰 Tombol Deposit','deposit'],['↩️ Admin','admin']])});return c.reply('✅ <b>Pesan + tombol Custom Emoji Archive berhasil dikirim.</b>\n\nCek pesan di atas: emoji di pesan harus menjadi Custom Emoji, dan ikon di tombol juga harus Custom Emoji dari Archive.',{parse_mode:'HTML',...kb([['↩️ Admin','admin']])});}catch(e){const msg=String(e?.response?.description||e?.description||e?.message||e);return c.reply(`❌ <b>Telegram menolak Custom Emoji.</b>\n\n<code>${esc(msg.slice(0,700))}</code>\n\nPastikan akun pemilik bot ini masih Premium.`,{parse_mode:'HTML',...kb([['↩️ Admin','admin']])});}});
bot.action('admin:premium-test:noop',async c=>c.answerCbQuery('Custom Emoji button test'));
bot.action('admin:catalog',async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();const rows=catalog.map(b=>{const on=db.isBotEnabled(b.id);return [[`${on?'🟢':'⚪'} ${b.name}`,`catalog:noop:${b.id}`],[on?`🗑️ Hapus dari daftar`:`✅ Kembalikan ke daftar`,`catalog:toggle:${b.id}`]]}).flat();return panel(c,'<b>Kelola Daftar Bot</b>\n\nHapus dari daftar hanya membuat bot tidak muncul untuk pembeli. Source bot dan tenant yang sudah ada tetap aman.',rows.concat([['↩️ Admin','admin']]))});
bot.action(/^catalog:noop:(.+)$/,async c=>c.answerCbQuery());
bot.action(/^catalog:toggle:(.+)$/,async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();const b=catalog.find(x=>x.id===c.match[1]);if(!b)return c.answerCbQuery('Bot tidak ditemukan',{show_alert:true});if(db.isBotEnabled(b.id)){db.disableBot(b.id);return panel(c,`🗑️ <b>${esc(b.name)}</b> dihapus dari daftar pembelian.\n\nTenant yang sudah aktif tidak dihentikan.`,[['⚙️ Kelola Daftar Bot','admin:catalog'],['↩️ Admin','admin']])}db.enableBot(b.id);return panel(c,`✅ <b>${esc(b.name)}</b> dikembalikan ke daftar pembelian.`,[['⚙️ Kelola Daftar Bot','admin:catalog'],['↩️ Admin','admin']])});
bot.action('admin:deposits',async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();const ds=Object.values(db.raw().deposits).filter(x=>x.status==='pending_review').slice(-10).reverse();if(!ds.length)return panel(c,'Tidak ada deposit menunggu verifikasi.',[['↩️ Admin','admin']]);return panel(c,'<b>Deposit Menunggu</b>\n\n'+ds.map(d=>`<code>${d.id}</code> • ${d.buyerId} • Rp${money(d.amount)}`).join('\n'),ds.map(d=>[`${d.id} • Approve`,`dep:approve:${d.id}`]).concat([['↩️ Admin','admin']]));});
bot.action(/^dep:approve:(.+)$/,async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();const d=db.getDeposit(c.match[1]);if(!d)return c.answerCbQuery('Deposit tidak ditemukan',{show_alert:true});if(!d.proofFileId||d.status==='approved')return c.answerCbQuery('Sudah diproses',{show_alert:true});db.updateDeposit(d.id,{status:'approved',approvedBy:c.from.id});db.addBalance(d.buyerId,d.amount,{depositId:d.id});try{await bot.telegram.sendMessage(d.buyerId,`✅ <b>Deposit berhasil diverifikasi</b>\n\n💰 Saldo bertambah: <b>Rp${money(d.amount)}</b>\n💳 Deposit: <code>${d.id}</code>` ,{parse_mode:'HTML'})}catch{};return panel(c,'✅ Deposit disetujui dan saldo buyer ditambahkan.',[['🧾 Deposit','admin:deposits'],['↩️ Admin','admin']]);});
function tenantButtons(arr){return arr.flatMap(t=>[[`🗑️ Hapus ${t.type} • ${t.ownerId}`,`tenant:delete:${t.type}:${t.ownerId}`]]).concat([['🔄 Refresh','admin:tenants'],['↩️ Admin','admin']])}
bot.action('admin:tenants',async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();const arr=tenant.listStatus();const text=`<b>Tenant Aktif</b>\n\n${arr.length?arr.map(t=>`${esc(t.type)} • Owner <code>${t.ownerId}</code> • ${esc(t.status||'unknown')} • PID ${(t.livePid||t.pid)||'-'}`).join('\n'):'Belum ada tenant.'}`;return panel(c,text,tenantButtons(arr))});
bot.action(/^tenant:delete:([^:]+):(\d+)$/,async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();const type=c.match[1],ownerId=c.match[2];const t=db.tenant(`${type}:${ownerId}`);if(!t)return c.answerCbQuery('Tenant sudah tidak ada',{show_alert:true});return panel(c,`<b>Hapus Tenant?</b>\n\nBot: <code>${esc(type)}</code>\nOwner: <code>${ownerId}</code>\n\nInstance akan dihentikan dan folder runtime tenant akan dihapus. Tindakan ini tidak menghapus source bot utama.`,[['⚠️ Ya, Hapus','tenant:confirmdelete:'+type+':'+ownerId],['↩️ Batal','admin:tenants']])});
bot.action(/^tenant:confirmdelete:([^:]+):(\d+)$/,async c=>{if(!isAdmin(c.from.id))return c.answerCbQuery('Akses ditolak',{show_alert:true});await c.answerCbQuery();const type=c.match[1],ownerId=c.match[2];const t=db.tenant(`${type}:${ownerId}`);if(!t)return c.answerCbQuery('Tenant sudah tidak ada',{show_alert:true});await tenant.remove(type,ownerId);if(t.purchaseId&&db.raw().purchases[t.purchaseId]){db.raw().purchases[t.purchaseId].status='deleted';db.raw().purchases[t.purchaseId].deletedAt=Date.now();db.save();}try{await bot.telegram.sendMessage(Number(ownerId),`🗑️ <b>Bot kamu telah dihapus oleh Owner SaaS.</b>\n\n🤖 ${esc(type)}\nFolder/runtime instance dihentikan dan dihapus.`,{parse_mode:'HTML'})}catch{}return panel(c,`✅ Tenant <code>${esc(type)}:${ownerId}</code> berhasil dihapus.`,[['📊 Tenant Aktif','admin:tenants'],['↩️ Admin','admin']])});

bot.action('deposit',async c=>{await c.answerCbQuery();const s=db.settings();return panel(c,`<b>Deposit Saldo</b>\n\nMinimum deposit: <b>Rp${money(1000)}</b>\n\n${s.qrisFileId?'QRIS tersedia.':'QRIS belum diset admin.'}\n\nKirim nominal yang ingin dideposit, lalu kirim bukti pembayaran.`,[['💵 Buat Deposit','deposit:create'],['👋 Home','home']])});
bot.action('deposit:create',async c=>{await c.answerCbQuery();state.set(String(c.from.id),{type:'deposit_amount'});return panel(c,'Kirim nominal deposit dalam rupiah. Contoh: <code>50000</code>.',[['❌ Batal','home']])});
bot.action('mybots',async c=>{await c.answerCbQuery();const ts=db.listTenants(c.from.id);if(!ts.length)return panel(c,'<b>Bot Saya</b>\n\nBelum ada bot. Beli bot terlebih dahulu.',[['🤖 Pilih Bot','bots'],['👋 Home','home']]);const text=`<b>Bot Saya</b>\n\n${ts.map(t=>{const b=catalog.find(x=>x.id===t.type);const plan=db.plans()[t.type]||{};const exp=t.expiresAt?new Date(Number(t.expiresAt)).toLocaleString('id-ID'):'-';return `🤖 <b>${esc(b?.name||t.type)}</b>\n🟢 Status: <b>${esc(t.status||'unknown')}</b>\n🆔 Owner: <code>${t.ownerId}</code>\n⏳ Expired: <b>${esc(exp)}</b>`}).join('\n\n')}`;const rows=ts.map(t=>{const b=catalog.find(x=>x.id===t.type);return [`🔄 Ganti Token • ${b?.name||t.type}`,`tenant:token:${t.type}:${t.ownerId}`]});return panel(c,text,rows.concat([['🤖 Pilih Bot','bots'],['👋 Home','home']]))});
bot.action(/^tenant:token:([^:]+):(\d+)$/,async c=>{await c.answerCbQuery();const type=c.match[1],ownerId=c.match[2];const t=db.tenant(`${type}:${ownerId}`);if(!t||String(t.ownerId)!==String(c.from.id))return c.answerCbQuery('Bot tidak ditemukan',{show_alert:true});state.set(String(c.from.id),{type:'replace-token',botType:type});return panel(c,`🔄 <b>Ganti Bot Token</b>\n\nBot: <b>${esc(catalog.find(x=>x.id===type)?.name||type)}</b>\n\nKirim token BotFather yang baru.\n\nToken lama akan dihentikan dan token baru langsung dipakai oleh instance yang sama. Masa aktif tidak berubah.`,[['❌ Batal','mybots'],['👋 Home','home']])});
bot.action('help',async c=>{await c.answerCbQuery();return panel(c,'<b>Bantuan</b>\n\nPilih bot → bayar dengan saldo → kirim Bot Token. Instance bot akan dibuat otomatis dan dijalankan.\n\nUntuk Auto Comment/Tagall, kredensial Telegram API dari SaaS dapat dipakai bersama; login akun Telegram tetap dilakukan lewat bot masing-masing.',[['👋 Home','home']])});
async function notifyAdmins(text){for(const id of db.listAdmins())try{await bot.telegram.sendMessage(id,text,{parse_mode:'HTML'})}catch{}}
async function notifyDepositProof(deposit, proofFileId){
  const caption=`💳 <b>Deposit Baru</b>\n\n🆔 ID: <code>${esc(deposit.id)}</code>\n👤 Buyer: <code>${deposit.buyerId}</code>\n💰 Nominal: <b>Rp${money(deposit.amount)}</b>\n\n📸 Bukti pembayaran terlampir.\nSilakan pilih <b>Approve</b> setelah pembayaran dicek.`;
  const buttons=[[`✅ Approve ${deposit.id}`,`dep:approve:${deposit.id}`],['💳 Deposit Pending','admin:deposits'],['🛠️ Admin','admin']];
  for(const id of db.listAdmins()){
    try{
      await bot.telegram.sendPhoto(id,proofFileId,{caption,parse_mode:'HTML',...kb(buttons)});
    }catch(err){
      try{await bot.telegram.sendMessage(id,caption,{parse_mode:'HTML',...kb(buttons)})}catch{}
    }
  }
}
bot.on('photo',async ctx=>{
  const userId=String(ctx.from.id);
  const s=state.get(userId);
  if(!s)return;
  const fileId=ctx.message.photo.at(-1)?.file_id;
  if(!fileId)return;

  // Admin-only media settings. Deposit proof is intentionally handled for buyers too.
  if(s.type==='qris'){
    if(!isAdmin(ctx.from.id))return;
    db.setSetting('qrisFileId',fileId);
    db.setSetting('qrisCaption',ctx.message.caption||'Scan QRIS lalu kirim bukti pembayaran.');
    state.delete(userId);
    return ctx.reply('✅ QRIS tersimpan dan aktif.',kb([['🛠️ Admin','admin']]));
  }
  if(s.type==='banner'){
    if(!isAdmin(ctx.from.id))return;
    db.setSetting('bannerFileId',fileId);
    db.setSetting('bannerType','photo');
    db.setSetting('bannerCaption',ctx.message.caption||'');
    state.delete(userId);
    return ctx.reply('✅ Banner tersimpan.',kb([['🛠️ Admin','admin']]));
  }
  if(s.type==='deposit_proof'){
    const d=db.getDeposit(s.depositId);
    if(!d)return;
    if(d.status!=='pending'){state.delete(userId);return ctx.reply('⚠️ Deposit ini sudah diproses.',kb([['👋 Home','home']]));}
    db.updateDeposit(d.id,{proofFileId:fileId,proofCaption:ctx.message.caption||'',status:'pending_review'});
    state.delete(userId);
    const fresh=db.getDeposit(d.id);
    await notifyDepositProof(fresh,fileId);
    return ctx.reply('✅ <b>Bukti deposit diterima.</b>\n\n📤 Bukti foto sudah dikirim ke Owner/Admin untuk diperiksa. Setelah disetujui, saldo akan otomatis masuk.',{parse_mode:'HTML',...kb([['👋 Home','home'],['💳 Deposit','deposit']])});
  }
});
bot.on('document',async ctx=>{const id=String(ctx.from.id),s=state.get(id);if(!s||s.type!=='restore_backup'||Number(ctx.from.id)!==OWNER)return;const name=String(ctx.message.document.file_name||'');if(!/telegram-saas-backup-.*\.zip$/i.test(name))return ctx.reply('❌ File bukan backup SaaS yang dikenali. Pastikan file ZIP berasal dari Backup & Restore.');try{await ctx.reply('⏳ Memeriksa dan memulihkan backup...');const result=await backup.restoreFromTelegram(ctx.message.document.file_id);db.reload?.();state.delete(id);await ctx.reply(`✅ <b>Restore selesai.</b>\n\n🏪 Tenant: <b>${result.manifest.tenantCount}</b>\n🕐 Backup: <b>${new Date(result.manifest.createdAt).toLocaleString('id-ID')}</b>\n\n♻️ SaaS akan restart agar semua tenant dipulihkan dari backup.`,{parse_mode:'HTML',...kb([['🛠️ Admin','admin']])});setTimeout(()=>process.exit(0),1500);}catch(e){return ctx.reply(`❌ <b>Restore gagal.</b>\n\n${esc(e.message)}`,{parse_mode:'HTML',...kb([['🛡️ Backup & Restore','admin:backup']])})}});
bot.on('animation',async ctx=>{const s=state.get(String(ctx.from.id));if(!s||!isAdmin(ctx.from.id)||s.type!=='banner')return;db.setSetting('bannerFileId',ctx.message.animation.file_id);db.setSetting('bannerType','animation');db.setSetting('bannerCaption',ctx.message.caption||'');state.delete(String(ctx.from.id));return ctx.reply('✅ GIF banner tersimpan.',kb([['🛠️ Admin','admin']]))});
bot.on('sticker',async ctx=>{const s=state.get(String(ctx.from.id));if(!s||!isAdmin(ctx.from.id)||s.type!=='sticker')return;db.setSetting('stickerFileId',ctx.message.sticker.file_id);state.delete(String(ctx.from.id));return ctx.reply('✅ Sticker tersimpan.',kb([['🛠️ Admin','admin']]))});
bot.on('text',async ctx=>{
  const id=String(ctx.from.id), s=state.get(id);
  if(!s) return;
  const text=ctx.message.text.trim();
  try{

    if(s.type==='backup_bot_token'){
      if(Number(ctx.from.id)!==OWNER) throw Error('Hanya Owner SaaS yang boleh mengatur bot backup.');
      const info=await backup.configureBackupDestination({mode:'custom',token:text,chatId:OWNER});
      state.delete(id);
      return ctx.reply(`✅ <b>Bot backup tersimpan.</b>\n\n🤖 Bot: <b>@${esc(info.botUsername||'custom')}</b>\n👤 Tujuan: <code>${OWNER}</code>\n\nMulai sekarang setiap backup global dikirim melalui bot ini.`,{parse_mode:'HTML',...kb([['🛡️ Backup & Restore','admin:backup'],['↩️ Admin','admin']])});
    }
    if(s.type==='broadcast'){
      if(!isAdmin(ctx.from.id)) throw Error('Akses ditolak.');
      if(!text) throw Error('Pesan broadcast kosong.');
      const users=Object.values(db.raw().users||{});let ok=0,fail=0;
      const entities=Array.isArray(ctx.message.entities)&&ctx.message.entities.length?ctx.message.entities.map(e=>({...e})):undefined;
      for(const u of users){try{await ctx.telegram.sendMessage(Number(u.id),text,entities?{entities}:{});ok++;}catch{fail++;}}
      state.delete(id);
      return ctx.reply(`✅ <b>Broadcast selesai.</b>\n\n📤 Berhasil: <b>${ok}</b>\n❌ Gagal: <b>${fail}</b>\n👥 Total: <b>${users.length}</b>`,{parse_mode:'HTML',...kb([['🛠️ Admin','admin']])});
    }
    if(s.type==='token'){
      if(!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(text)) throw Error('Bot Token tidak valid.');
      const u=db.user(ctx.from.id);
      const plan=db.plans()[s.botType];
      if(['auto-comment-jaseb','tagall'].includes(s.botType)&&(!process.env.TELEGRAM_API_ID||!process.env.TELEGRAM_API_HASH)) throw Error('Bot ini membutuhkan TELEGRAM_API_ID dan TELEGRAM_API_HASH pada .env SaaS.');
      if(Number(u.balance)<Number(plan.price)) throw Error('Saldo berubah/tidak cukup.');
      u.balance-=Number(plan.price); db.save();
      const p=db.purchase({ownerId:ctx.from.id,botType:s.botType,price:Number(plan.price),token:text,durationDays:Number(plan.durationDays||30),status:'provisioning'});
      try{
        const r=await tenant.start(s.botType,ctx.from.id,text,{autoRestart:true});
        db.setTenant(`${s.botType}:${ctx.from.id}`,{purchaseId:p.id,pid:r.pid,tokenStored:false,expiresAt:Date.now()+Number(plan.durationDays||30)*86400000,autostart:true});
        db.user(ctx.from.id,{activeBot:s.botType});
        db.raw().purchases[p.id].status='running'; db.save(); state.delete(id);
        await notifyAdmins(`🟢 <b>Tenant aktif</b>\nBot: ${esc(s.botType)}\nOwner: <code>${ctx.from.id}</code>\nPID: <code>${r.pid}</code>`);
        // Critical SaaS event: a new tenant must always produce a global snapshot.
        // forceBackup() only affects the backup subsystem and does not alter tenant logic.
        try {
          await backup.forceBackup(`tenant-created:${s.botType}:${ctx.from.id}`);
        } catch (backupErr) {
          console.error('[SAAS BACKUP] tenant-created trigger failed:', backupErr.message);
          try { await ctx.reply(`⚠️ <b>Tenant berhasil dibuat, tetapi backup otomatis gagal dikirim.</b>\n\nError: <code>${esc(backupErr.message)}</code>\n\nOwner SaaS perlu membuka 🛡️ Backup & Restore dan menekan 🚀 Backup Sekarang setelah penyebab diperbaiki.`, {parse_mode:'HTML', ...kb([['🛡️ Backup & Restore','admin:backup']])}); } catch {}
        }
        return ctx.reply(`✅ <b>Bot berhasil dibuat!</b>\n\n🤖 ${esc(s.botType)}\n🟢 Status: RUNNING\n🆔 PID: <code>${r.pid}</code>\n\nToken bisa diganti kapan saja dari menu <b>📦 Bot Saya</b>.`,kb([['🤖 Bot Saya','mybots'],['👋 Home','home']]));
      }catch(e){
        db.raw().purchases[p.id].status='failed'; db.save();
        u.balance+=Number(plan.price); db.save();
        throw e;
      }
    }
    if(s.type==='replace-token'){
      if(!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(text)) throw Error('Bot Token tidak valid.');
      const b=catalog.find(x=>x.id===s.botType);
      const r=await tenant.replaceToken(s.botType,ctx.from.id,text);
      const t=db.tenant(`${s.botType}:${ctx.from.id}`);
      if(t?.purchaseId&&db.raw().purchases[t.purchaseId]){
        db.raw().purchases[t.purchaseId].token=text;
        db.raw().purchases[t.purchaseId].tokenChangedAt=Date.now();
        db.save();
      }
      state.delete(id);
      await notifyAdmins(`🔄 <b>Bot Token diganti</b>\nBot: ${esc(b?.name||s.botType)}\nOwner: <code>${ctx.from.id}</code>\nPID: <code>${r.pid}</code>`);
      return ctx.reply(`✅ <b>Bot Token berhasil diganti.</b>\n\n🤖 ${esc(b?.name||s.botType)}\n🟢 Status: RUNNING\n🆔 PID: <code>${r.pid}</code>\n\nMasa aktif tetap menggunakan paket sebelumnya.`,kb([['🤖 Bot Saya','mybots'],['👋 Home','home']]));
    }
    if(s.type==='price_amount'){
      const n=Number(text.replace(/[^0-9]/g,''));
      if(!Number.isInteger(n)||n<0) throw Error('Harga harus berupa angka, minimal 0.');
      state.set(id,{type:'price_days',botId:s.botId,price:n});
      const b=catalog.find(x=>x.id===s.botId);
      return ctx.reply(`💰 Harga <b>${esc(b?.name||s.botId)}</b> diset ke <b>Rp${money(n)}</b>.\n\nSekarang kirim <b>jumlah hari</b> masa aktif. Contoh: <code>30</code>`,{parse_mode:'HTML',...kb([['↩️ Set Harga','admin:price'],['🛠️ Admin','admin']])});
    }
    if(s.type==='price_days'){
      const days=Number(text.replace(/[^0-9]/g,''));
      if(!Number.isInteger(days)||days<1) throw Error('Jumlah hari minimal 1.');
      db.setPlan(s.botId,{price:Number(s.price),durationDays:days}); state.delete(id);
      const b=catalog.find(x=>x.id===s.botId);
      return ctx.reply(`✅ Harga tersimpan.\n\n🤖 ${esc(b?.name||s.botId)}\n💰 Rp${money(s.price)}\n⏱️ ${days} hari`,kb([['💰 Set Harga Lain','admin:price'],['🛠️ Admin','admin']]));
    }
    if(s.type==='adminadd'){
      if(!/^\d+$/.test(text)) throw Error('ID harus angka.');
      db.addAdmin(Number(text)); state.delete(id);
      return ctx.reply('✅ Admin ditambahkan.',kb([['🛠️ Admin','admin']]));
    }
    if(s.type==='deposit_amount'){
      const n=Number(text);
      if(!Number.isInteger(n)||n<1000) throw Error('Nominal minimal Rp1.000.');
      const q=db.settings().qrisFileId;
      if(!q) throw Error('QRIS belum diset admin.');
      const d=db.deposit({buyerId:ctx.from.id,amount:n});
      state.set(id,{type:'deposit_proof',depositId:d.id});
      return ctx.replyWithPhoto(q,{caption:`💳 <b>Deposit Rp${money(n)}</b>\nID: <code>${d.id}</code>\n\n${esc(db.settings().qrisCaption||'Scan QRIS lalu kirim bukti pembayaran.')}\n\nSilakan bayar lalu kirim screenshot bukti pembayaran.`,parse_mode:'HTML',...kb([['❌ Batal','home']])});
    }
  }catch(e){
    return ctx.reply(`❌ ${esc(e.message)}`,{parse_mode:'HTML',...kb([['👋 Home','home']])});
  }
});
bot.catch((e)=>console.error('[SAAS BOT ERROR]',e));
console.log('🚀 Telegram SaaS 4-bot starting...');(async()=>{try{await backup.init({telegramBot:bot,database:db,tenantManager:tenant,owner:OWNER});await bot.launch();console.log('✅ SaaS control bot online');backup.markReady();tenant.restoreRunning().then(restored=>console.log(`♻️ Tenant recovery selesai: ${restored.length} tenant dipulihkan.`)).catch(e=>console.error('❌ Tenant recovery gagal:',e.message));}catch(e){console.error('❌ SaaS startup gagal',e);process.exitCode=1}})();
let shuttingDown=false;
async function gracefulShutdown(signal){
  if(shuttingDown)return;
  shuttingDown=true;
  try{await tenant.shutdownAllForParent?.();}catch{}
  try{await bot.stop(signal);}catch{}
  setTimeout(()=>process.exit(0),1500).unref?.();
}
process.once('SIGINT',()=>gracefulShutdown('SIGINT'));
process.once('SIGTERM',()=>gracefulShutdown('SIGTERM'));
