# Laura Bot

Discord bot automation for the **Memory Vault** channel.

## Project structure

```text
src/
├─ index.js
└─ automations/
   └─ memory-vault.js
```

- `src/index.js`: creates the Discord client, registers Memory Vault automation, logs in.
- `src/automations/memory-vault.js`: all Memory Vault logic in one file.

## Environment variables

Required:

- `DISCORD_TOKEN`
- `CLIENT_ID`
- `GUILD_ID`
- `MEMORY_VAULT_CHANNEL_ID`

Optional:

- `TIMEZONE` (default: `Europe/Rome`)
- `DAILY_MEMORY_REMINDER_HOUR` (default: `22`)
- `DAILY_MEMORY_REMINDER_MINUTE` (default: `0`)
- `ENABLE_MESSAGE_CONTENT_INTENT` (`true` to enable full text memory capture)
- `MEMORY_VAULT_TAG_USER_IDS` (comma-separated Discord user IDs to mention in daily reminder, e.g. `123...,456...`)

## Discord permissions needed

- Send Messages
- Read Message History
- Use Slash Commands
- Add Reactions
- Create Public Threads
- Send Messages in Threads
- View Channels
- Manage Threads (recommended for update/archive fallback behavior)
- Manage Messages (required if you want guided answer messages auto-deleted after save/update/request)

## Commands

- `/addmemory`
  - Works only in `MEMORY_VAULT_CHANNEL_ID`.
  - Lets user choose **Free** or **Guided** flow.
  - Captures only the next message from that same user in that same channel.
  - Confirms with `Memory saved 💛`.

- `/randommemory`
  - Works only in `MEMORY_VAULT_CHANNEL_ID`.
  - Fetches recent channel history (up to around 500 messages).
  - Ignores bot/empty/command-like messages.
  - Posts one random valid memory with author/date/content/attachments/original link.

## Memory Vault behavior

- Daily reminder at configured local time:

```text
💛 Memory Vault Time

What’s one thing from today worth keeping?

Use /addmemory to save it.

Tiny memories count too.
```

- Favorite memories:
  - When someone reacts with `⭐` to a valid memory in Memory Vault channel,
  - Bot copies memory into `Favorite Memories` thread (creates it if needed),
  - Includes favorited by, original author/date/link, text and attachments,
  - Avoids duplicates by checking recent thread messages for the original URL.

## Railway deployment notes

- Set all required environment variables in Railway project settings.
- If you set `ENABLE_MESSAGE_CONTENT_INTENT=true`, also enable **Message Content Intent** in the Discord Developer Portal (`Bot` tab), otherwise login may fail with `Used disallowed intents`.
- Ensure bot has the required permissions in your Discord server/channel.
- Deploy from GitHub as usual; startup command can be default `node index.js`.
- Slash commands are registered to the configured guild at startup.what
