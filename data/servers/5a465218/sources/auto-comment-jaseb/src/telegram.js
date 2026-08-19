const { TelegramClient, Api, utils } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Raw, NewMessage } = require('telegram/events');
const db = require('./db');
const { preparePremiumMessage } = require('./telegram-premium-emoji');

const API_ID = Number(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const clients = new Map();
const pending = new Map();
const attachedClients = new Map();
const monitorPending = new Map();
const processing = new Set();
const pollers = new Map();

const key = x => String(x);
const cleanPhone = v => { const x=String(v||'').trim().replace(/[\s()-]/g,''); if(!x) throw Error('Nomor kosong'); return x.startsWith('+')?x:`+${x}`; };
const kwHit = (body, word) => {
  const normalize = value => String(value || '').replace(/[\u200B\u200C\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const text = normalize(body);
  const keyword = normalize(word);
  return !!keyword && text.includes(keyword);
};
function barePeerId(v){
  try{
    if(v===null||v===undefined) return '';
    if(typeof v==='object'){
      if(v.channelId!==undefined)return String(v.channelId);
      if(v.channel_id!==undefined)return String(v.channel_id);
      if(v.chatId!==undefined)return String(v.chatId);
      if(v.id!==undefined)return barePeerId(v.id);
      const peer=utils.getPeerId(v); if(peer!==undefined) return barePeerId(peer);
    }
    let s=String(v).trim();
    if(s.startsWith('-100'))s=s.slice(4);
    return s.replace(/^\+/,'');
  }catch{return '';}
}
function normId(v){ const b=barePeerId(v); return b?`-100${b}`:''; }
function samePeer(a,b){const aa=barePeerId(a),bb=barePeerId(b);return !!aa&&!!bb&&aa===bb;}
function shortErr(e){return String(e?.errorMessage||e?.message||e).replace(/\s+/g,' ').slice(0,500);}

async function connect(account){
  const id=key(account.id);
  const old=clients.get(id);
  if(old?.client?.connected){ await attachMonitor(account,old.client,old.me); return old.client; }
  if(!account.session) throw Error('Session akun kosong, login ulang diperlukan.');
  const client=new TelegramClient(new StringSession(account.session),API_ID,API_HASH,{connectionRetries:Infinity,requestRetries:3});
  await client.connect();
  const me=await client.getMe();
  clients.set(id,{client,me});
  attachedClients.delete(id);
  await attachMonitor(account,client,me);
  return client;
}

async function beginLogin(rawPhone){const client=new TelegramClient(new StringSession(''),API_ID,API_HASH,{connectionRetries:10,requestRetries:3});await client.connect();const phone=cleanPhone(rawPhone);const sent=await client.sendCode({apiId:API_ID,apiHash:API_HASH},phone);const id=`${Date.now()}_${Math.random().toString(36).slice(2)}`;pending.set(id,{client,phone,hash:sent.phoneCodeHash,at:Date.now()});return{id};}
function getPending(id){const item=pending.get(id);if(!item)throw Error('Login habis, ulangi dari awal.');if(Date.now()-item.at>10*60*1000){pending.delete(id);item.client.disconnect().catch(()=>{});throw Error('OTP expired, ulangi login.');}return item;}
async function code(id,raw){const item=getPending(id);const otp=String(raw).replace(/\s/g,'');if(!/^\d{5,6}$/.test(otp))throw Error('Kode OTP tidak valid.');try{await item.client.invoke(new Api.auth.SignIn({phoneNumber:item.phone,phoneCodeHash:item.hash,phoneCode:otp}));const me=await item.client.getMe();return finish(id,me);}catch(e){if(String(e?.message||e).includes('SESSION_PASSWORD_NEEDED'))return{status:'password'};throw e;}}
async function password(id,pw){const item=getPending(id);const me=await item.client.signInWithPassword({apiId:API_ID,apiHash:API_HASH},{password:async()=>String(pw)});return finish(id,me);}
function finish(id,me){const item=pending.get(id);if(!item)throw Error('Login session tidak ditemukan.');const session=item.client.session.save();pending.delete(id);return{status:'ok',client:item.client,me,session,phone:item.phone};}
async function saveLogin(ownerId,result){const a=db.addAccount(ownerId,{phone:result.phone,session:result.session,telegram_user_id:String(result.me.id),username:result.me.username||'',label:result.me.username?`@${result.me.username}`:(result.me.firstName||'Telegram')});clients.set(key(a.id),{client:result.client,me:result.me});await attachMonitor(a,result.client,result.me);return a;}

async function resolveTarget(ownerId,accountId,raw){
  const account=db.getAccount(ownerId,accountId);if(!account)throw Error('Akun tidak ditemukan.');
  const client=await connect(account);const input=String(raw||'').trim();if(!input)throw Error('Link kosong.');
  const entity=await client.getEntity(input);const peerId=normId(entity);
  const isChannel=entity.className==='Channel'&&!!entity.broadcast;
  const isSupergroup=entity.className==='Channel'&&!entity.broadcast;
  const isBasicGroup=entity.className==='Chat';
  return{ref:input,peer_id:peerId,title:entity.title||entity.username||input,kind:isChannel?'channel':(isSupergroup||isBasicGroup?'group':'other')};
}

async function validateLinkedDiscussion(client,channelRef,discussionPeerId){
  const channel=await client.getEntity(channelRef);
  if(channel.className!=='Channel'||!channel.broadcast)return{ok:false,reason:'Target pertama harus broadcast channel.'};
  const full=await client.invoke(new Api.channels.GetFullChannel({channel}));
  const linked=full?.fullChat?.linkedChatId;
  if(linked===undefined||linked===null)return{ok:false,reason:'Channel ini tidak memiliki linked discussion group.'};
  if(!samePeer(linked,discussionPeerId))return{ok:false,reason:`Group discussion tidak cocok dengan linked discussion channel.`};
  return{ok:true,linked_peer_id:normId(linked)};
}


function peerChannelId(peer) {
  if (!peer) return '';
  if (peer.channelId !== undefined) return String(peer.channelId);
  if (peer.channel_id !== undefined) return String(peer.channel_id);
  return '';
}

function messagePeerId(message) {
  if (!message?.peerId) return '';
  return peerChannelId(message.peerId);
}

function forwardedChannelPostId(message) {
  const fwd = message?.fwdFrom || message?.forwardHeader;
  if (!fwd) return '';
  if (fwd.channelPost !== undefined) return String(fwd.channelPost);
  if (fwd.channel_post !== undefined) return String(fwd.channel_post);
  return '';
}

function chatPeerId(chat) {
  if (!chat) return '';
  if (chat.channelId !== undefined) return String(chat.channelId);
  if (chat.id !== undefined) return barePeerId(chat.id);
  return '';
}

/**
 * messages.getDiscussionMessage() returns messages in reverse chronological
 * order. Telegram's API specifies that the LAST message is the
 * auto-forwarded channel post that starts the discussion thread.
 *
 * We do not blindly trust the array position: the returned message must also
 * belong to the configured linked discussion group and, when available, point
 * back to this exact channel post.
 */
async function findDiscussionRootForPost(client, target, channelEntity, postId) {
  const channelPostId = Number(postId);

  db.log(
    target.owner_id,
    'discussion',
    'lookup',
    `🔎 GET DISCUSSION ROOT\nDiscussion Group: ${target.discussion_ref}\nChannel Post ID: ${channelPostId}`
  );

  // Re-check the channel's CURRENT linked discussion group on every post.
  // This prevents a stale target configuration from being used after the
  // channel owner changes the linked discussion group.
  const full = await client.invoke(new Api.channels.GetFullChannel({
    channel: channelEntity
  }));
  const linkedChatId = full?.fullChat?.linkedChatId;
  if (linkedChatId === undefined || linkedChatId === null) {
    return {
      ok: false,
      reason: 'discussion root tidak ditemukan: channel tidak memiliki linked discussion group',
      channelPostId
    };
  }

  if (!samePeer(linkedChatId, target.discussion_peer_id)) {
    return {
      ok: false,
      reason: `Root entity bukan ${target.discussion_ref}: linked discussion channel berubah`,
      channelPostId
    };
  }

  const result = await client.invoke(new Api.messages.GetDiscussionMessage({
    peer: channelEntity,
    msgId: channelPostId
  }));

  const msgs = Array.isArray(result?.messages) ? result.messages : [];
  const configuredDiscussionBare = barePeerId(target.discussion_peer_id);
  const configuredDiscussionFull = normId(target.discussion_peer_id);

  // Telegram documents the last returned message as the auto-forwarded
  // channel message that started the thread.
  const candidate = msgs.length ? msgs[msgs.length - 1] : null;

  if (!candidate?.id) {
    return {
      ok: false,
      reason: 'discussion root tidak ditemukan',
      channelPostId,
      result
    };
  }

  const rootId = Number(candidate.id);
  const rootPeerBare = messagePeerId(candidate);
  const rootPeerFull = rootPeerBare ? `-100${rootPeerBare}` : '';
  const rootChat = Array.isArray(result?.chats)
    ? result.chats.find(chat => chatPeerId(chat) === rootPeerBare)
    : null;

  const expectedSourcePostId = forwardedChannelPostId(candidate);

  // Prefer the concrete peer on the message; fall back to the returned chat
  // only if GramJS omitted peerId on this object.
  const actualDiscussionBare = rootPeerBare || chatPeerId(rootChat);

  if (!actualDiscussionBare) {
    return {
      ok: false,
      reason: 'root entity discussion tidak dapat ditentukan',
      channelPostId,
      rootId,
      result
    };
  }

  if (
    configuredDiscussionBare &&
    actualDiscussionBare !== configuredDiscussionBare &&
    rootPeerFull !== configuredDiscussionFull
  ) {
    return {
      ok: false,
      reason: `Root entity bukan ${target.discussion_ref}`,
      channelPostId,
      rootId,
      rootPeer: actualDiscussionBare,
      result
    };
  }

  if (rootId === channelPostId) {
    return {
      ok: false,
      reason: 'Root ID sama dengan channel post ID',
      channelPostId,
      rootId,
      rootPeer: actualDiscussionBare,
      result
    };
  }

  if (expectedSourcePostId && expectedSourcePostId !== String(channelPostId)) {
    return {
      ok: false,
      reason: `root bukan auto-forward dari channel post ${channelPostId}`,
      channelPostId,
      rootId,
      rootPeer: actualDiscussionBare,
      expectedSourcePostId,
      result
    };
  }

  const rootEntityName =
    rootChat?.username ? `@${rootChat.username}` :
    rootChat?.title || target.discussion_ref;

  return {
    ok: true,
    rootId,
    rootPeer: actualDiscussionBare,
    rootEntityName,
    rootMessage: candidate,
    result
  };
}

async function getChannelPost(client, target, postId) {
  const got = await client.getMessages(target.channel_ref, { ids: [Number(postId)] });
  return Array.isArray(got) ? got[0] : got;
}

async function sendReplyOnce(account, client, target, discussion, post, keyword, reason) {
  const guard = `${account.id}:${target.id}:${post.id}:${discussion.rootId}:${keyword.id}`;
  if (db.sentKey(account.owner_id, guard)) return false;

  const lock = `${account.id}:${target.id}:${post.id}:${keyword.id}`;
  if (processing.has(lock)) return false;
  processing.add(lock);

  try {
    db.log(
      account.owner_id,
      'comment',
      'attempt',
      `💬 SENDING REPLY\nTarget: ${target.discussion_ref}\nreplyTo: ${discussion.rootId}`
    );

    const premium = preparePremiumMessage(client, String(keyword.comment));
    const sendOptions = {
      message: premium.message,
      replyTo: Number(discussion.rootId)
    };
    if (premium.formattingEntities.length) sendOptions.formattingEntities = premium.formattingEntities;
    let sent;
    try {
      sent = await client.sendMessage(target.discussion_ref, sendOptions);
    } catch (emojiError) {
      const msg = shortErr(emojiError).toLowerCase();
      if (!msg.includes('custom emoji') && !msg.includes('custom_emoji') && !msg.includes('premium')) throw emojiError;
      sent = await client.sendMessage(target.discussion_ref, {
        message: keyword.comment,
        replyTo: Number(discussion.rootId)
      });
    }

    db.markSent(account.owner_id, guard, {
      target_id: target.id,
      account_id: account.id,
      channel_post_id: Number(post.id),
      discussion_message_id: Number(discussion.rootId),
      keyword_id: Number(keyword.id),
      sent_message_id: Number(sent?.id || 0)
    });

    db.log(
      account.owner_id,
      'comment',
      'success',
      `✅ REPLY SENT\nChannel Post ID: ${post.id}\nDiscussion Root ID: ${discussion.rootId}\nTarget: ${target.discussion_ref}\nSent ID: ${sent?.id || '?'}`
    );

    return true;
  } catch (e) {
    db.log(
      account.owner_id,
      'comment',
      'error',
      `SEND FAIL ❌ target=${target.discussion_ref} post=${post.id} root=${discussion.rootId} — ${shortErr(e)}`
    );
    return false;
  } finally {
    processing.delete(lock);
  }
}


async function processChannelPost(account, client, target, message, channelEntity) {
  if (!message?.id) return;
  if (!db.getSender(account.owner_id)?.enabled) return;

  const channelPostId = Number(message.id);
  const body = String(message.message || '');

  db.log(
    account.owner_id,
    'monitor',
    'event',
    `📤 CHANNEL POST\nChannel: ${target.channel_ref}\nPost ID: ${channelPostId}`
  );

  if (!body) {
    db.log(account.owner_id, 'monitor', 'skip', `post=${channelPostId} alasan=post_tanpa_text`);
    return;
  }

  const keywords = db
    .listKeywordsForTarget(account.owner_id, target.id)
    .filter(k => kwHit(body, k.word));

  if (!keywords.length) {
    db.log(account.owner_id, 'monitor', 'skip', `post=${channelPostId} alasan=keyword_tidak_cocok`);
    return;
  }

  db.log(
    account.owner_id,
    'monitor',
    'match',
    `Keyword match: ${keywords.map(k => k.word).join(', ')}`
  );

  try {
    const discussion = await findDiscussionRootForPost(
      client,
      target,
      channelEntity,
      channelPostId
    );

    if (!discussion.ok) {
      db.log(
        account.owner_id,
        'monitor',
        'error',
        `❌ VALIDATION FAILED\nPost ID: ${channelPostId}\nReason: ${discussion.reason}`
      );

      scheduleRetry(
        account,
        client,
        target,
        channelEntity,
        channelPostId,
        0
      );
      return;
    }

    db.log(
      account.owner_id,
      'monitor',
      'success',
      `🔎 GET DISCUSSION ROOT\nDiscussion Group: ${target.discussion_ref}\nRoot ID: ${discussion.rootId}`
    );

    db.log(
      account.owner_id,
      'monitor',
      'success',
      `✅ VALIDATION PASSED\n${channelPostId} !== ${discussion.rootId}\nRoot entity = ${discussion.rootEntityName}`
    );

    for (const kw of keywords) {
      await sendReplyOnce(
        account,
        client,
        target,
        discussion,
        message,
        kw,
        'channel-post'
      );
    }
  } catch (e) {
    db.log(
      account.owner_id,
      'monitor',
      'error',
      `❌ GET DISCUSSION ROOT FAILED\nPost ID: ${channelPostId}\nReason: ${shortErr(e)}`
    );
    scheduleRetry(account, client, target, channelEntity, channelPostId, 0);
  }
}


function scheduleRetry(account, client, target, channelEntity, postId, attempt) {
  const k = `${account.id}:${target.id}:${postId}`;
  if (monitorPending.has(k)) return;

  const delays = [3000, 8000, 20000, 45000, 90000];
  if (attempt >= delays.length) {
    db.log(
      account.owner_id,
      'monitor',
      'skip',
      `post=${postId} alasan=discussion_retry_exhausted`
    );
    return;
  }

  const timer = setTimeout(async () => {
    monitorPending.delete(k);

    try {
      const post = await getChannelPost(client, target, postId);
      if (!post?.id) throw Error('channel post tidak ditemukan lagi');

      const kws = db
        .listKeywordsForTarget(account.owner_id, target.id)
        .filter(x => kwHit(post.message || '', x.word));

      if (!kws.length) {
        db.log(
          account.owner_id,
          'monitor',
          'skip',
          `post=${postId} alasan=keyword_tidak_cocok`
        );
        return;
      }

      // Every retry performs a fresh channel-post -> discussion-root lookup.
      const discussion = await findDiscussionRootForPost(
        client,
        target,
        channelEntity,
        postId
      );

      if (discussion.ok) {
        db.log(
          account.owner_id,
          'monitor',
          'success',
          `✅ VALIDATION PASSED\n${postId} !== ${discussion.rootId}\nRoot entity = ${discussion.rootEntityName}`
        );

        for (const kw of kws) {
          await sendReplyOnce(
            account,
            client,
            target,
            discussion,
            post,
            kw,
            `discussion-retry-${attempt + 1}`
          );
        }
        return;
      }

      db.log(
        account.owner_id,
        'monitor',
        'wait',
        `❌ VALIDATION FAILED\nPost ID: ${postId}\nReason: ${discussion.reason}\nRetry: ${attempt + 1}/${delays.length}`
      );
    } catch (e) {
      db.log(
        account.owner_id,
        'monitor',
        'wait',
        `post=${postId} attempt=${attempt + 1} alasan=retry ${shortErr(e)}`
      );
    }

    scheduleRetry(account, client, target, channelEntity, postId, attempt + 1);
  }, delays[attempt]);

  monitorPending.set(k, timer);
}


async function pollTargetOnce(account, client, resolved) {
  const { target, ch } = resolved;
  try {
    const rows = await client.getMessages(ch, { limit: 1 });
    const latest = Array.isArray(rows) ? rows[0] : rows;
    if (!latest?.id) return;

    const metaKey = `monitor:lastSeen:${target.id}`;
    const previous = Number(db.getMeta(account.owner_id, metaKey) || 0);
    const latestId = Number(latest.id);

    // On startup, establish a baseline and never replay an already-existing post.
    if (!previous) {
      db.setMeta(account.owner_id, metaKey, latestId);
      db.log(account.owner_id, 'monitor', 'ready', `POLL BASELINE channel=${target.channel_ref} lastPost=${latestId}`);
      return;
    }

    if (latestId <= previous) return;

    // Advance the cursor before processing so an exception/restart cannot cause
    // an endless poll loop. sendReplyOnce() has its own persistent dedupe guard.
    db.setMeta(account.owner_id, metaKey, latestId);

    for (let postId = previous + 1; postId <= latestId; postId++) {
      const post = postId === latestId ? latest : await getChannelPost(client, target, postId);
      if (!post?.id) continue;
      db.log(account.owner_id, 'monitor', 'event', `🌐 POLL CHANNEL POST\nChannel: ${target.channel_ref}\nPost ID: ${post.id}`);
      await processChannelPost(account, client, target, post, ch);
    }
  } catch (e) {
    db.log(account.owner_id, 'monitor', 'error', `channel poll target=#${target.id} — ${shortErr(e)}`);
  }
}

function startPoller(account, client, resolvedTargets) {
  const id = key(account.id);
  const old = pollers.get(id);
  if (old) clearInterval(old);
  if (!resolvedTargets.length) return;

  // Polling is a safety net for sessions that do not receive channel updates
  // for a public channel, while NewMessage/RAW remain the primary live paths.
  const timer = setInterval(async () => {
    for (const resolved of resolvedTargets) {
      await pollTargetOnce(account, client, resolved);
    }
  }, 4000);
  pollers.set(id, timer);

  for (const resolved of resolvedTargets) {
    pollTargetOnce(account, client, resolved).catch(() => {});
  }
}

async function attachMonitor(account,client,me,force=false){
  const id=key(account.id);
  const existing=attachedClients.get(id);
  if(existing?.client===client && !force)return;
  if(existing?.client && existing.handlers){
    for(const h of existing.handlers){
      try{ await existing.client.removeEventHandler(h.callback,h.builder); }catch{}
    }
  }

  const targets=()=>db.listTargets(account.owner_id)
    .filter(t=>String(t.account_id)===id);

  const handlers=[];

  // Resolve all configured channel entities first. This lets NewMessage use
  // GramJS' own chat matching instead of waiting for event.getChat().
  const resolvedTargets=[];
  for(const target of targets()){
    try{
      const ch=await client.getEntity(target.channel_ref);
      const dg=await client.getEntity(target.discussion_ref);
      if(ch.className!=='Channel'||!ch.broadcast) throw Error('Target channel bukan broadcast channel.');
      if(!dg || dg.className!=='Channel' || dg.broadcast) throw Error('Target discussion bukan supergroup discussion.');
      target.channel_peer_id=normId(ch);
      target.discussion_peer_id=normId(dg);
      resolvedTargets.push({target,ch,dg});
      db.log(account.owner_id,'monitor','ready',`LISTEN TARGET #${target.id} channel=${target.channel_ref} peer=${target.channel_peer_id} discussion=${target.discussion_ref} discussionPeer=${target.discussion_peer_id}`);
    }catch(e){
      db.log(account.owner_id,'monitor','error',`target=#${target.id} resolve failed — ${shortErr(e)}`);
    }
  }
  db.save();

  const activeTargets=()=>resolvedTargets;

  // Primary path: GramJS NewMessage explicitly bound to the resolved channel
  // entities. This is the normal high-level event path requested by the app.
  for(const {target,ch} of activeTargets()){
    // Do NOT pass the resolved Api.Channel object via `chats` here.
    // GramJS' NewMessage builder resolves `chats` through getInputEntity(),
    // and some GramJS versions reject an Api.Channel object with
    // `Cannot find any entity corresponding to "[object Object]"`.
    // Register a broad NewMessage listener instead and filter by the
    // already-resolved channel peer ID inside the callback.
    const builder=new NewMessage({incoming:true});
    const callback=async event=>{
      try{
        const message=event?.message;
        if(!message?.id) return;
        const p=message.peerId;
        if(!p?.channelId || !samePeer(p.channelId,target.channel_peer_id)) return;
        db.log(account.owner_id,'monitor','event',`📤 NEWMESSAGE CHANNEL POST\nChannel: ${target.channel_ref}\nPost ID: ${message.id}`);
        await processChannelPost(account,client,target,message,ch);
      }catch(e){
        db.log(account.owner_id,'monitor','error',`newMessage listener target=#${target.id} — ${shortErr(e)}`);
      }
    };
    client.addEventHandler(callback,builder);
    handlers.push({callback,builder});
  }

  // Fallback path: inspect the raw MTProto updates. GramJS normally unwraps
  // Updates/UpdatesCombined before dispatching, but we also recursively inspect
  // nested update arrays for compatibility with different update envelopes.
  const extractUpdates=(u,out=[])=>{
    if(!u) return out;
    const name=u.className || u.constructor?.name || '';
    if(name==='UpdateNewChannelMessage') { out.push(u); return out; }
    if(Array.isArray(u.updates)) for(const child of u.updates) extractUpdates(child,out);
    if(u.update && typeof u.update==='object') extractUpdates(u.update,out);
    return out;
  };
  const rawBuilder=new Raw({});
  const rawCallback=async update=>{
    try{
      const candidates=extractUpdates(update);
      for(const candidate of candidates){
        const message=candidate?.message;
        if(!message?.id) continue;
        const peer=message.peerId;
        const eventBare=peer?.channelId!==undefined?String(peer.channelId):'';
        if(!eventBare) continue;
        const matching=activeTargets().filter(x=>samePeer(eventBare,x.target.channel_peer_id));
        if(!matching.length) continue;

        for(const {target,ch} of matching){
          db.log(account.owner_id,'monitor','raw',`🌐 RAW CHANNEL UPDATE matched\nChannel: ${target.channel_ref}\nPost ID: ${message.id}`);
          await processChannelPost(account,client,target,message,ch);
        }
      }
    }catch(e){
      db.log(account.owner_id,'monitor','error',`raw channel listener — ${shortErr(e)}`);
    }
  };
  client.addEventHandler(rawCallback,rawBuilder);
  handlers.push({callback:rawCallback,builder:rawBuilder});

  attachedClients.set(id,{client,handlers});
  startPoller(account, client, resolvedTargets);
  db.log(account.owner_id,'monitor','ready',`MONITOR READY account=${me?.username?`@${me.username}`:account.label||account.id}; listener=NewMessage(peer-filter)+RAW fallback+4s poll; targets=${activeTargets().length}`);
}


// ===== JASEB / JASA SEBAR =====
const jasebTimers = new Map();
const jasebSending = new Set();

function jasebGroupKey(g){return String(g.peer_key||g.peer_id||g.id)}

async function listGroups(ownerId, accountId=null){
  const accs=(accountId?[db.getAccount(ownerId,accountId)]:db.accounts(ownerId)).filter(Boolean);
  if(!accs.length) throw Error('Akun Telegram belum ada.');
  const out=[]; const seen=new Set();
  for(const account of accs){
    const client=await connect(account);
    const dialogs=await client.getDialogs({limit:1000});
    for(const d of dialogs||[]){
      const e=d?.entity;
      if(!e) continue;
      const isBasic=e.className==='Chat';
      const isSuper=e.className==='Channel'&&!e.broadcast;
      if(!isBasic&&!isSuper) continue;
      const id=String(e.id);
      const username=e.username?`@${e.username}`:'';
      const peerKey=username||id;
      const unique=`${account.id}:${peerKey}`;
      if(seen.has(unique)) continue;
      seen.add(unique);
      out.push({peer_key:peerKey,peer_id:id,title:e.title||username||id,username:e.username||'',account_id:account.id});
    }
  }
  out.sort((a,b)=>String(a.title).localeCompare(String(b.title),'id'));
  return out;
}

async function sendJasebOnce(ownerId){
  const cfg=db.getJaseb(ownerId);
  if(!cfg?.enabled||!cfg.text||!Array.isArray(cfg.groups)||!cfg.groups.length) return;
  const lock=String(ownerId); if(jasebSending.has(lock)) return;
  jasebSending.add(lock);
  try{
    for(const g of cfg.groups){
      try{
        const account=db.getAccount(ownerId,g.account_id||cfg.account_id);
        if(!account) throw Error('akun tidak ditemukan');
        const client=await connect(account);
        const entity=await client.getEntity(g.peer_key||g.peer_id);
        const premium = preparePremiumMessage(client, String(cfg.text));
        const sendOptions = { message: premium.message };
        if (premium.formattingEntities.length) sendOptions.formattingEntities = premium.formattingEntities;
        let sent;
        try {
          sent = await client.sendMessage(entity, sendOptions);
        } catch (emojiError) {
          const msg = shortErr(emojiError).toLowerCase();
          if (!msg.includes('custom emoji') && !msg.includes('custom_emoji') && !msg.includes('premium')) throw emojiError;
          // Same Jaseb behavior as before if the sender cannot use Premium emoji.
          sent = await client.sendMessage(entity,{message:String(cfg.text)});
        }
        const sentId=sent?.id;
        if(sentId!=null){
          db.addJasebMessage(ownerId,{account_id:account.id,peer_id:String(g.peer_id||sent?.peerId?.channelId||sent?.peerId?.chatId||g.peer_key||g.peer_id),peer_key:g.peer_key||'',message_id:Number(sentId),title:g.title||g.peer_key||g.peer_id});
        }
        db.log(ownerId,'jaseb','success',`📢 JASEB SENT → ${g.title}`);
      }catch(e){
        db.log(ownerId,'jaseb','error',`JASEB FAIL → ${g.title||g.peer_key}: ${shortErr(e)}`);
      }
    }
  }catch(e){db.log(ownerId,'jaseb','error',`JASEB CONNECTION FAIL: ${shortErr(e)}`)}
  finally{jasebSending.delete(lock)}
}


async function deleteJasebMessages(ownerId){
  const cfg=db.getJaseb(ownerId);
  const rows=db.getJasebMessages(ownerId);
  const fallback=[];
  if(!rows.length && cfg?.text && Array.isArray(cfg.groups)){
    // Recover recent Jaseb messages created before message-id tracking was added.
    for(const g of cfg.groups){
      try{
        const account=db.getAccount(ownerId,g.account_id||cfg.account_id);
        if(!account) continue;
        const client=await connect(account);
        const entity=await client.getEntity(g.peer_key||g.peer_id);
        const history=await client.getMessages(entity,{limit:50});
        for(const m of (history||[])){
          if(m?.out && String(m.message||'')===String(cfg.text)) fallback.push({account_id:account.id,peer_id:String(g.peer_id||g.peer_key),peer_key:g.peer_key||'',message_id:Number(m.id),title:g.title||g.peer_key||g.peer_id});
        }
      }catch{}
    }
  }
  const targets=rows.length?rows:fallback;
  if(!targets.length) return {total:0,deleted:0,failed:0};
  const failedRows=[];
  let deleted=0;
  for(const row of targets){
    try{
      const account=db.getAccount(ownerId,row.account_id);
      if(!account) throw Error('akun tidak ditemukan');
      const client=await connect(account);
      const entity=await client.getEntity(row.peer_key||row.peer_id);
      await client.deleteMessages(entity,[Number(row.message_id)]);
      deleted++;
    }catch(e){
      failedRows.push(row);
      db.log(ownerId,'jaseb','error',`JASEB DELETE FAIL → ${row.title||row.peer_key||row.peer_id}: ${shortErr(e)}`);
    }
  }
  db.setJaseb(ownerId,{messages:failedRows});
  db.log(ownerId,'jaseb','ready',`JASEB DELETE DONE total=${rows.length} deleted=${deleted} failed=${failedRows.length}`);
  return {total:rows.length,deleted,failed:failedRows.length};
}

function stopJaseb(ownerId){
  const k=String(ownerId); const t=jasebTimers.get(k); if(t){clearInterval(t);jasebTimers.delete(k);}
}

function startJaseb(ownerId){
  const k=String(ownerId); stopJaseb(k);
  const cfg=db.getJaseb(ownerId);
  if(!cfg?.enabled||!cfg.text||!Array.isArray(cfg.groups)||!cfg.groups.length) return false;
  const minutes=Math.max(1,Number(cfg.interval_min)||1);
  const timer=setInterval(()=>sendJasebOnce(k).catch(()=>{}),minutes*60*1000);
  jasebTimers.set(k,timer);
  // Do not send immediately when enabling; first send happens after the selected interval.
  db.log(ownerId,'jaseb','ready',`JASEB READY interval=${minutes}m groups=${cfg.groups.length}`);
  return true;
}

async function configureJaseb(ownerId,config){
  stopJaseb(ownerId);
  const next=db.setJaseb(ownerId,{...config,enabled:true});
  startJaseb(ownerId);
  return next;
}

async function activateTarget(ownerId,target){
  const account=db.getAccount(ownerId,target.account_id);
  if(!account) throw Error('Akun target tidak ditemukan.');
  const client=await connect(account);
  const me=clients.get(key(account.id))?.me || await client.getMe();
  // The target is created after the account's initial monitor may already be attached.
  // Rebuild only the monitor wiring so the existing V34 event/filter/reply logic
  // starts watching the newly-created target immediately.
  await attachMonitor(account,client,me,true);
  db.log(ownerId,'monitor','ready',`TARGET READY #${target.id} channel=${target.channel_title}`);
  return true;
}
async function bootstrap(){const owners=new Set();for(const a of db.allAccounts()){if(!db.active(db.getUser(a.owner_id)))continue;try{await connect(a);owners.add(String(a.owner_id));}catch(e){db.log(a.owner_id,'startup','error',`account=${a.id} ${shortErr(e)}`);}}for(const ownerId of owners){const cfg=db.getJaseb(ownerId);if(cfg?.enabled)startJaseb(ownerId);}}
async function stop(accountId){const id=key(accountId);const poll=pollers.get(id);if(poll){clearInterval(poll);pollers.delete(id);}const x=clients.get(id);const a=attachedClients.get(id);if(a){for(const h of (a.handlers||[])){try{await a.client.removeEventHandler(h.callback,h.builder);}catch{}}attachedClients.delete(id);}if(x){try{await x.client.disconnect();}catch{}clients.delete(id);}for(const [k,t] of monitorPending){if(k.startsWith(`${id}:`)){clearTimeout(t);monitorPending.delete(k);}}}
module.exports={beginLogin,code,password,saveLogin,resolveTarget,validateLinkedDiscussion,activateTarget,bootstrap,connect,stop,listGroups,sendJasebOnce,deleteJasebMessages,startJaseb,stopJaseb,configureJaseb};
