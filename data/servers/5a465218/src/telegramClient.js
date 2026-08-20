const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const fs = require('fs');
const { config } = require('./config');
const store = require('./store');

class AccountManager {
  constructor() {
    this.clients = new Map();
    this.handles = new Map();
  }

  async startAll() {
    for (const account of store.get().accounts) {
      try { await this.start(account); }
      catch (err) { console.error(`[${account.id}] start failed:`, err.message); }
    }
  }

  async start(account) {
    if (this.clients.has(account.id)) return this.clients.get(account.id);
    const sessionFile = store.sessionPath(account.id);
    let sessionString = '';
    if (fs.existsSync(sessionFile)) sessionString = fs.readFileSync(sessionFile, 'utf8').trim();
    if (!sessionString) throw new Error('Session file missing');

    const client = new TelegramClient(new StringSession(sessionString), config.apiId, config.apiHash, {
      connectionRetries: 10,
      autoReconnect: true,
    });
    await client.connect();
    if (!(await client.checkAuthorization())) throw new Error('Session unauthorized');
    const me = await client.getMe();
    account.username = me.username || '';
    account.name = [me.firstName, me.lastName].filter(Boolean).join(' ') || account.username || 'Unknown';
    store.save();

    const handler = async (event) => {
      if (!store.get().running) return;
      await this.processMessage(account, client, event);
    };
    // Jangan batasi ke `incoming: true`. Pada beberapa jenis chat/update, filter tersebut
    // bisa membuat pesan grup tertentu tidak masuk ke handler. Filter pesan keluar
    // dilakukan sendiri di processMessage().
    client.addEventHandler(handler, new NewMessage({}));
    this.clients.set(account.id, client);
    this.handles.set(account.id, handler);
    console.log(`[${account.id}] monitoring as ${account.name} (@${account.username || '-'})`);
    return client;
  }

  async stop(id) {
    const client = this.clients.get(id);
    if (!client) return false;
    try { await client.disconnect(); } catch {}
    this.clients.delete(id);
    this.handles.delete(id);
    return true;
  }

  async processMessage(account, client, event) {
    const msg = event.message;
    if (!msg) return;

    // Abaikan pesan yang dikirim oleh akun userbot sendiri.
    if (msg.out) return;

    const text = String(msg.message || '');
    if (!text) return;

    // Gunakan entity yang sudah dibawa oleh update terlebih dahulu. Ini lebih
    // stabil daripada selalu melakukan getEntity(peerId), terutama pada grup
    // yang bukan tempat akun menjadi admin.
    let chat = event.chat || null;
    if (!chat && msg.peerId) {
      try { chat = await client.getEntity(msg.peerId); } catch (err) {
        console.error(`[${account.id}] gagal resolve chat:`, err.message);
        return;
      }
    }
    if (!chat) return;

    // Chat biasa = Chat. Supergroup = Channel dengan megagroup=true.
    // Channel broadcast murni tidak dianggap sebagai grup sumber.
    const isGroup =
      chat.className === 'Chat' ||
      (chat.className === 'Channel' && chat.megagroup === true && chat.broadcast !== true);
    if (!isGroup) return;

    const chatId = String(chat.id);
    if (store.get().ignoredChats.map(String).includes(chatId)) return;

    const lower = text.toLowerCase();
    const matched = store.get().keywords.find(k => lower.includes(k.toLowerCase()));
    if (!matched) return;

    const targets = store.get().targets;
    if (!targets.length) return;

    let sender = null;
    let bio = '';
    let senderName = 'Unknown';
    let username = '';
    let senderId = '';
    try {
      sender = await msg.getSender();
      if (sender) {
        senderName = [sender.firstName, sender.lastName].filter(Boolean).join(' ') || sender.title || sender.username || 'Unknown';
        username = sender.username || '';
        senderId = String(sender.id || '');
        if (sender.className === 'User') bio = sender.about || '';
      }
    } catch {}

    const header = [
      `🔎 Keyword: ${matched}`,
      `👤 ${senderName}${username ? ` (@${username})` : ''}`,
      senderId ? `🆔 ${senderId}` : '',
      `📝 Bio: ${bio || '(tidak tersedia)'}`,
      `💬 ${text}`,
      `📂 Sumber: ${chat.title || chat.username || chatId}`,
    ].filter(Boolean).join('\n');

    for (const target of targets) {
      try {
        await client.sendMessage(target, { message: header });
        await client.forwardMessages(target, { messages: [msg.id], fromPeer: chat });
      } catch (err) {
        console.error(`[${account.id}] forward to ${target} failed:`, err.message);
      }
    }
  }

  async resolvePeer(idOrUsername, accountId) {
    const client = this.clients.get(accountId) || await this.start(store.get().accounts.find(a => a.id === accountId));
    return client.getEntity(idOrUsername);
  }
}

module.exports = { AccountManager };
