require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { setupMemoryVault } = require('./automations/memory-vault');

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
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

setupMemoryVault(client);

client.once('ready', () => {
  console.log(`[startup] Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error('[startup] Failed to log in:', error);
  process.exit(1);
});
