# Telegram Auto Comment — fixed discussion-root flow

Node.js + GramJS project that monitors **broadcast channel posts** and replies in the channel's **linked discussion group**.

## Critical flow

For every new channel post:

```text
NewMessage(TARGET_CHANNEL)
        |
        v
channelPostId = message.id
        |
        v
messages.getDiscussionMessage({
  peer: channelEntity,
  msgId: channelPostId
})
        |
        v
DiscussionMessage.messages (reverse chronological)
        |
        v
LAST message = auto-forwarded channel message that starts the thread
        |
        v
discussionRootId = that message.id
        |
        v
VALIDATE:
- root exists
- root ID !== channel post ID
- root message belongs to configured discussion group
- channel is still linked to configured discussion group
- when available, forwarded channelPost matches channelPostId
        |
        v
client.sendMessage(DISCUSSION_GROUP, {
  message: REPLY_TEXT,
  replyTo: discussionRootId
})
```

The code **never** sends the reply to the source channel and never assumes channel-post IDs equal discussion-root IDs. The live listener matches incoming `message.peerId.channelId` directly against the configured source-channel peer ID; it does not discard events just because `event.getChat()` failed to resolve.

Telegram's API documentation states that `messages.getDiscussionMessage` returns the initial messages of the discussion thread in reverse chronological order, with the last returned message being the auto-forwarded channel message that started the comment section.

## Project

- `.env.example`
- `src/app.js` — Telegraf control panel
- `src/db.js` — JSON persistence
- `src/telegram.js` — GramJS login, monitoring, discussion-root resolution and reply flow
- `package.json`

## Requirements

- Node.js 20+
- A Telegram API ID/hash
- A Telegram user account session (the raw `messages.getDiscussionMessage` flow is performed by the GramJS user session)

The project keeps the existing multi-user control-panel architecture.

## Setup

```bash
cp .env.example .env
```

Fill:

```env
BOT_TOKEN=your_bot_token
API_ID=123456
API_HASH=your_api_hash
OWNER_ID=123456789
```

Install:

```bash
npm install
```

Run:

```bash
npm start
```

Open the control bot, add a Telegram account, add keyword/reply, then create a target:

1. Source: broadcast channel, for example `https://t.me/basewtb`
2. Discussion: linked discussion group, for example `https://t.me/basewtbchat`

The target setup checks that the selected group is the channel's linked discussion group.

## Runtime logging

The listener first identifies the incoming update from `message.peerId`. For a configured channel match it logs the post before keyword filtering. The dashboard Event counter includes these monitor event records.

The monitor records the relationship for every matched post:

```text
📤 CHANNEL POST
Channel: @basewtb
Post ID: 10834513

🔎 GET DISCUSSION ROOT
Discussion Group: @basewtbchat
Root ID: 1536301

✅ VALIDATION PASSED
10834513 !== 1536301
Root entity = @basewtbchat

💬 SENDING REPLY
Target: @basewtbchat
replyTo: 1536301

✅ REPLY SENT
```

If lookup or validation fails, the code logs `❌ VALIDATION FAILED` and does **not** call `sendMessage`. A short retry sequence is used because the discussion root can become available immediately after a channel post.

## Important implementation details

`messages.getDiscussionMessage` is called separately for every channel post and every retry. No channel-post ID or discussion-root ID is hardcoded.

The root is selected from the API result according to Telegram's documented ordering rather than by guessing that the IDs match.

The code additionally checks the current linked discussion group using `channels.getFullChannel`, then validates the returned root message's peer against the configured discussion group.

## GramJS version

The dependency is pinned to the latest official `telegram`/GramJS package currently published on npm: `2.26.22`.

Note: npm currently marks the `telegram` package as deprecated/archived and points to `teleproto` as a maintained compatible fork. This project intentionally remains on the official GramJS package because the requested implementation is specifically GramJS.

## Audit result

The previous implementation already contained a partial `getDiscussionMessage` call, but its safety boundary was too weak: it treated the returned message as sufficient without a complete per-post linked-peer validation path and did not produce the requested explicit validation logs.

This version makes the mapping explicit:

```text
channelPostId -> GetDiscussionMessage -> discussionRootId
              -> linked-group validation
              -> ID inequality validation
              -> replyTo discussionRootId
```


## Channel update fallback

The monitor keeps NewMessage and raw MTProto channel updates as the live paths. It also polls the configured channel every 4 seconds as a safety net when the Telegram session does not deliver a channel update event. The poll cursor is persisted per target and is initialized to the current latest post on startup, so existing old posts are not replayed on startup. Every newly observed post still runs the same `channelPostId -> getDiscussionMessage -> validation -> replyTo=root` flow.

## Jaseb / Jasa Sebar

The control panel includes a separate Jaseb feature. It does not modify the auto-comment keyword/discussion flow.

Flow:

```text
Jaseb -> kirim teks -> pilih interval (1/5/10/15/30/60 menit)
      -> daftar group akun Telegram
      -> pagination 6 group/halaman
      -> pilih satu/lebih group atau Pilih Semua
      -> Simpan & Aktifkan
```

Only selected groups receive the configured Jaseb text. The schedule is persisted in `data/app.json` and restored on bot startup. Jaseb sending uses the configured Telegram user accounts and keeps a per-run lock so a slow send cycle cannot overlap with the next cycle.
