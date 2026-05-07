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
- `BOUNDARIES_CHANNEL_ID`

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

- `/testweeklyrecap`
  - Works only in `MEMORY_VAULT_CHANNEL_ID`.
  - Force-runs weekly recap immediately for testing.
  - Creates the weekly recap thread and posts last 7 days of memories.

- `/testdailyreminder`
  - Works only in `MEMORY_VAULT_CHANNEL_ID`.
  - Sends the daily reminder message immediately for testing.

- `/addboundary`
  - Works only in `BOUNDARIES_CHANNEL_ID`.
  - Guided boundary flow and saves entry into `List of Boundaries` thread.

- `/boundarylist`
  - Works only in `BOUNDARIES_CHANNEL_ID`.
  - Lets you pick category (or all categories) and lists matching boundaries from `List of Boundaries`.

- `/updateboundary`
  - Works only in `BOUNDARIES_CHANNEL_ID`.
  - Archives old version to `Boundary History`, then posts updated boundary.

- `/boundaryrequest`
  - Works only in `BOUNDARIES_CHANNEL_ID`.
  - Posts a gentle discussion request. If status is `🟢 Agreed`, also adds to `List of Boundaries`.

- `/reviewboundaries`
  - Works only in `BOUNDARIES_CHANNEL_ID`.
  - Posts the guided boundary review prompt in channel.

## Memory Vault behavior

- Daily reminder at configured local time:

```text
💛 Memory Vault Time

What’s one thing from today worth keeping?

Use /addmemory to save it.

Tiny memories count too.
```

- Weekly recap every Sunday at 22:00 (configured timezone):
  - Creates public thread: `YYYY • Month • Week N`
  - Reads last 7 days from Memory Vault channel history.
  - Includes date, author, content, attachment links, original message link.
  - If empty week: `No memories were found this week, and that’s okay 💛`

- Favorite memories:
  - When someone reacts with `⭐` to a valid memory in Memory Vault channel,
  - Bot copies memory into `Favorite Memories` thread (creates it if needed),
  - Includes favorited by, original author/date/link, text and attachments,
  - Avoids duplicates by checking recent thread messages for the original URL.

## Boundaries behavior

- Boundaries are stored as Discord messages inside the `List of Boundaries` thread.
- Old versions are archived in `Boundary History`.
- No database is used.
- Monthly review reminder posts automatically on the first Sunday of each month at 21:00 (`TIMEZONE` or default `Europe/Rome`).

## Railway deployment notes

- Set all required environment variables in Railway project settings.
- If you set `ENABLE_MESSAGE_CONTENT_INTENT=true`, also enable **Message Content Intent** in the Discord Developer Portal (`Bot` tab), otherwise login may fail with `Used disallowed intents`.
- Boundaries guided text flows (`/addboundary`, `/updateboundary`, `/boundaryrequest`) require `ENABLE_MESSAGE_CONTENT_INTENT=true` plus Message Content Intent enabled in the Discord Developer Portal.
- Ensure bot has the required permissions in your Discord server/channel.
- Deploy from GitHub as usual; startup command can be default `node index.js`.
- Slash commands are registered to the configured guild at startup.
