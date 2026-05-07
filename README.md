# Laura Bot

Discord bot automation for relationship channels/modules.

## Project structure

```text
src/
├─ index.js
└─ automations/
   ├─ memory-vault.js
   ├─ boundaries.js
   ├─ check-in.js
   └─ love-actions.js
```

## Environment variables

Required:

- `DISCORD_TOKEN`
- `CLIENT_ID`
- `GUILD_ID`
- `LOVE_ACTIONS_CHANNEL_ID`
- `PARTNER_1_USER_ID`
- `PARTNER_1_NAME`
- `PARTNER_2_USER_ID`
- `PARTNER_2_NAME`

## Discord permissions needed

- Send Messages
- Read Message History
- Use Slash Commands
- View Channels
- Create Public Threads
- Send Messages in Threads

## Commands

- `/addaction`
  - Works only in `LOVE_ACTIONS_CHANNEL_ID`.
  - Saves a private love action into the `Love Actions Archive` thread.

- `/action`
  - Works only in `LOVE_ACTIONS_CHANNEL_ID`.
  - Returns one matching action written by the other partner only.

- `/actiondone`
  - Warm completion acknowledgment.

- `/retireaction`
  - Lets you retire one of your own actions.

- `/myactions`
  - Shows only actions written by you.

## Love Actions behavior

- Love actions are secretly written by each partner for the other.
- The bot only gives users actions written by their partner.
- Actions are stored as Discord messages in `Love Actions Archive` (no database/json/local storage).
- Author ID is stored internally for filtering, but never shown when delivering `/action`.

## Railway deployment notes

- Set all required environment variables in Railway project settings.
- Ensure bot has required channel/thread permissions.
- Deploy from GitHub with startup command `node index.js`.
- Slash commands are registered to the configured guild at startup.
