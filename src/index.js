require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { setupCheckIn } = require('./automations/check-in');

const REQUIRED_ENV = ['DISCORD_TOKEN'];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(`[startup] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    ...(process.env.ENABLE_MESSAGE_CONTENT_INTENT === 'true' ? [GatewayIntentBits.MessageContent] : []),
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

if (process.env.ENABLE_MESSAGE_CONTENT_INTENT !== 'true') {
  console.warn(
    '[startup] ENABLE_MESSAGE_CONTENT_INTENT is not true. Any text-reading automations will be limited until enabled.',
  );
}

setupCheckIn(client);

client.once('ready', () => {
  console.log(`[startup] Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  if (`${error?.message || ''}`.includes('Used disallowed intents')) {
    console.error(
      '[startup] Login failed: disallowed intents. If you want text memory capture, enable Message Content Intent in the Discord Developer Portal and set ENABLE_MESSAGE_CONTENT_INTENT=true.',
    );
  }
  console.error('[startup] Failed to log in:', error);
  process.exit(1);
});
