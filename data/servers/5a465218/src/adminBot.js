const crypto = require('crypto');
const fs = require('fs');
const { Telegraf, Markup } = require('telegraf');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const store = require('./store');
const { config } = require('./config');

function menu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('👤 Akun', 'accounts'), Markup.button.callback('🎯 Tujuan', 'targets')],
    [Markup.button.callback('🔑 Keyword', 'keywords'), Markup.button.callback('🚫 Ignore', 'ignore')],
    [Markup.button.callback('▶️/⏸️ Monitoring', 'toggle'), Markup.button.callback('📊 Status', 'status')],
  ]);
}

class AdminBot {
  constructor(accountManager) {
    this.accountManager = accountManager;
    this.bot = new Telegraf(config.botToken);
    this.flow = new Map();
  }
  isOwner(ctx) { return String(ctx.from?.id) === config.ownerId; }
  guard(ctx) { if (!this.isOwner(ctx)) { ctx.answerCbQuery?.('Tidak diizinkan'); return false; } return true; }

  setup() {
    this.bot.start(ctx => {
      if (!this.isOwner(ctx)) return ctx.reply('Bot private.');
      return ctx.reply('⚙️ Keyword Forwarder', menu());
    });
    this.bot.command('panel', ctx => this.isOwner(ctx) && ctx.reply('⚙️ Panel', menu()));
    this.bot.action('toggle', async ctx => {
      if (!this.guard(ctx)) return;
      store.mutate(s => { s.running = !s.running; });
      await ctx.answerCbQuery();
      await ctx.editMessageText(`Monitoring: ${store.get().running ? 'ON ✅' : 'OFF ⏸️'}`, menu());
    });
    this.bot.action('status', async ctx => {
      if (!this.guard(ctx)) return;
      const s = store.get();
      await ctx.answerCbQuery();
      const accounts = s.accounts.map(a => `• ${a.id}: ${a.name || a.phone || 'unknown'} ${this.accountManager.clients.has(a.id) ? '🟢' : '🔴'}`).join('\n') || '-';
      const msg = `📊 Status\n\nMonitoring: ${s.running ? 'ON ✅' : 'OFF ⏸️'}\nKeyword: ${s.keywords.length}\nTarget: ${s.targets.length}\nIgnore: ${s.ignoredChats.length}\n\n👤 Akun\n${accounts}`;
      return ctx.editMessageText(msg, menu());
    });
    this.bot.action('keywords', async ctx => { if (!this.guard(ctx)) return; await ctx.answerCbQuery(); await ctx.editMessageText(`🔑 Keyword saat ini:\n${store.get().keywords.map((x,i)=>`${i+1}. ${x}`).join('\n') || '-'}\n\nKirim: /addkeyword kata\nHapus: /delkeyword kata`, menu()); });
    this.bot.action('targets', async ctx => { if (!this.guard(ctx)) return; await ctx.answerCbQuery(); await ctx.editMessageText(`🎯 Target:\n${store.get().targets.map((x,i)=>`${i+1}. ${x}`).join('\n') || '-'}\n\nTambah: /addtarget ID_ATAU_USERNAME\nHapus: /deltarget ID_ATAU_USERNAME`, menu()); });
    this.bot.action('ignore', async ctx => { if (!this.guard(ctx)) return; await ctx.answerCbQuery(); await ctx.editMessageText(`🚫 Ignore chat:\n${store.get().ignoredChats.join('\n') || '-'}\n\nTambah: /ignore ID\nHapus: /unignore ID`, menu()); });
    this.bot.action('accounts', async ctx => { if (!this.guard(ctx)) return; await ctx.answerCbQuery(); await ctx.editMessageText(`👤 Akun terdaftar:\n${store.get().accounts.map(a=>`• ${a.id} ${a.name||a.phone||''} ${this.accountManager.clients.has(a.id)?'🟢':'🔴'}`).join('\n') || '-'}\n\nTambah akun via /addaccount lalu ikuti instruksi.`, menu()); });

    this.bot.command('addkeyword', ctx => {
      if (!this.isOwner(ctx)) return;
      const k = ctx.message.text.split(/\s+/).slice(1).join(' ').trim().toLowerCase();
      if (!k) return ctx.reply('Contoh: /addkeyword gabutan');
      store.mutate(s => { if (!s.keywords.includes(k)) s.keywords.push(k); });
      return ctx.reply(`✅ Keyword ditambah: ${k}`, menu());
    });
    this.bot.command('delkeyword', ctx => {
      if (!this.isOwner(ctx)) return;
      const k = ctx.message.text.split(/\s+/).slice(1).join(' ').trim().toLowerCase();
      store.mutate(s => { s.keywords = s.keywords.filter(x => x !== k); });
      return ctx.reply(`✅ Keyword dihapus: ${k}`, menu());
    });
    this.bot.command('addtarget', ctx => {
      if (!this.isOwner(ctx)) return;
      const t = ctx.message.text.split(/\s+/)[1];
      if (!t) return ctx.reply('Contoh: /addtarget -1001234567890');
      store.mutate(s => { if (!s.targets.includes(t)) s.targets.push(t); });
      return ctx.reply(`✅ Target ditambah: ${t}`, menu());
    });
    this.bot.command('deltarget', ctx => {
      if (!this.isOwner(ctx)) return;
      const t = ctx.message.text.split(/\s+/)[1];
      store.mutate(s => { s.targets = s.targets.filter(x => x !== t); });
      return ctx.reply(`✅ Target dihapus: ${t}`, menu());
    });
    this.bot.command('ignore', ctx => {
      if (!this.isOwner(ctx)) return;
      const id = ctx.message.text.split(/\s+/)[1];
      if (!id) return ctx.reply('Contoh: /ignore -100123');
      store.mutate(s => { if (!s.ignoredChats.map(String).includes(String(id))) s.ignoredChats.push(String(id)); });
      return ctx.reply(`✅ Di-ignore: ${id}`, menu());
    });
    this.bot.command('unignore', ctx => {
      if (!this.isOwner(ctx)) return;
      const id = ctx.message.text.split(/\s+/)[1];
      store.mutate(s => { s.ignoredChats = s.ignoredChats.filter(x => String(x) !== String(id)); });
      return ctx.reply(`✅ Ignore dihapus: ${id}`, menu());
    });

    this.bot.command('addaccount', async ctx => {
      if (!this.isOwner(ctx)) return;
      const userId = String(ctx.from.id);
      const old = this.flow.get(userId);
      if (old?.client) {
        try { await old.client.disconnect(); } catch {}
      }
      const id = crypto.randomBytes(4).toString('hex');
      this.flow.set(userId, { step: 'phone', accountId: id, createdAt: Date.now() });
      return ctx.reply(`Masukkan nomor HP akun Telegram, contoh +628123456789\nID akun: ${id}\n\nKetik /cancel untuk membatalkan.`);
    });

    this.bot.command('cancel', async ctx => {
      if (!this.isOwner(ctx)) return;
      const userId = String(ctx.from.id);
      const f = this.flow.get(userId);
      if (f?.client) {
        try { await f.client.disconnect(); } catch {}
      }
      this.flow.delete(userId);
      return ctx.reply('✅ Proses dibatalkan.', menu());
    });

    this.bot.on('text', async ctx => {
      if (!this.isOwner(ctx)) return;
      const userId = String(ctx.from.id);
      const text = String(ctx.message.text || '').trim();
      const f = this.flow.get(userId);
      if (!f || text.startsWith('/')) return;

      try {
        if (Date.now() - f.createdAt > 10 * 60 * 1000) {
          this.flow.delete(userId);
          if (f.client) { try { await f.client.disconnect(); } catch {} }
          return ctx.reply('❌ Sesi login kedaluwarsa. Jalankan /addaccount lagi.', menu());
        }

        if (f.step === 'phone') {
          const phone = text.replace(/[\s()-]/g, '');
          if (!/^\+?\d{8,15}$/.test(phone)) return ctx.reply('❌ Nomor tidak valid. Contoh: +628123456789');
          f.phone = phone.startsWith('+') ? phone : `+${phone}`;
          f.client = new TelegramClient(new StringSession(''), config.apiId, config.apiHash, {
            connectionRetries: 10,
            autoReconnect: true,
          });
          await ctx.reply('⏳ Mengirim kode OTP...');
          await f.client.connect();
          const result = await f.client.invoke(new Api.auth.SendCode({
            phoneNumber: f.phone,
            apiId: config.apiId,
            apiHash: config.apiHash,
            settings: new Api.CodeSettings({}),
          }));
          f.phoneCodeHash = result.phoneCodeHash;
          f.step = 'code';
          return ctx.reply('Masukkan kode OTP Telegram.');
        }

        if (f.step === 'code') {
          if (!/^\d{4,8}$/.test(text)) return ctx.reply('❌ Kode OTP tidak valid. Kirim angka OTP-nya saja.');
          await ctx.reply('⏳ Memverifikasi OTP...');
          try {
            await f.client.invoke(new Api.auth.SignIn({
              phoneNumber: f.phone,
              phoneCodeHash: f.phoneCodeHash,
              phoneCode: text,
            }));
          } catch (err) {
            const code = String(err?.errorMessage || err?.message || '').toUpperCase();
            if (code.includes('SESSION_PASSWORD_NEEDED')) {
              f.step = 'password';
              return ctx.reply('🔐 Akun memakai 2FA. Masukkan password 2FA Telegram.');
            }
            throw err;
          }
          return this.finishLogin(ctx, f, userId);
        }

        if (f.step === 'password') {
          await ctx.reply('⏳ Memverifikasi password 2FA...');
          await f.client.signInWithPassword({
            password: async () => text,
          });
          return this.finishLogin(ctx, f, userId);
        }
      } catch (err) {
        console.error('[login]', err);
        this.flow.delete(userId);
        if (f?.client) { try { await f.client.disconnect(); } catch {} }
        return ctx.reply(`❌ Gagal login: ${err?.errorMessage || err?.message || err}`, menu());
      }
    });

    this.bot.catch((err, ctx) => {
      console.error('[telegraf]', err);
      try { return ctx.reply('❌ Terjadi error di bot. Cek log server.'); } catch {}
    });
    return this.bot;
  }

  async finishLogin(ctx, f, userId) {
    const me = await f.client.getMe();
    const session = f.client.session.save();
    fs.writeFileSync(store.sessionPath(f.accountId), session, 'utf8');
    const existing = store.get().accounts.find(a => a.id === f.accountId);
    if (existing) {
      Object.assign(existing, {
        phone: f.phone,
        session,
        name: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || 'Unknown',
        username: me.username || '',
      });
      store.save();
    } else {
      store.mutate(s => s.accounts.push({
        id: f.accountId,
        phone: f.phone,
        session,
        name: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || 'Unknown',
        username: me.username || '',
      }));
    }
    this.flow.delete(userId);
    await ctx.reply(`✅ Akun berhasil login.\n👤 ${[me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || 'Unknown'}\n🆔 ${f.accountId}`, menu());
    await this.accountManager.start(store.get().accounts.find(a => a.id === f.accountId));
  }

  async launch() { await this.bot.launch(); console.log('Admin bot started'); }
}

module.exports = { AdminBot };
