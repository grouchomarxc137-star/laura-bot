const {
  ChannelType,
  EmbedBuilder,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const RANDOM_MEMORY_COMMAND = new SlashCommandBuilder()
  .setName('randommemory')
  .setDescription('Show a random memory from the Memory Vault');

function setupMemoryVault(client) {
  const config = {
    clientId: process.env.CLIENT_ID,
    guildId: process.env.GUILD_ID,
    memoryVaultChannelId: process.env.MEMORY_VAULT_CHANNEL_ID,
    timezone: process.env.TIMEZONE || 'Europe/Rome',
    dailyHour: toSafeNumber(process.env.DAILY_MEMORY_REMINDER_HOUR, 22),
    dailyMinute: toSafeNumber(process.env.DAILY_MEMORY_REMINDER_MINUTE, 0),
    tagUserIds: parseUserIds(process.env.MEMORY_VAULT_TAG_USER_IDS),
  };

  const required = ['CLIENT_ID', 'GUILD_ID', 'MEMORY_VAULT_CHANNEL_ID'];
  const missing = required.filter((name) => !process.env[name]);
  const isConfigured = missing.length === 0;
  if (missing.length > 0) {
    console.error(
      `[memory-vault] Missing required environment variables: ${missing.join(', ')}. Memory Vault automation is disabled until these are set.`,
    );
  }

  client.once(Events.ClientReady, async () => {
    if (!isConfigured) {
      console.warn('[memory-vault] Skipping setup because required env vars are missing.');
      return;
    }

    await registerCommands(client, config);
    scheduleDailyReminder(client, config);

    console.log(
      `[memory-vault] Ready | timezone=${config.timezone} daily=${String(config.dailyHour).padStart(2, '0')}:${String(config.dailyMinute).padStart(2, '0')}`,
    );
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!isConfigured) {
      return;
    }

    try {
      if (!interaction.isChatInputCommand()) {
        return;
      }

      if (interaction.commandName === 'randommemory') {
        await handleRandomMemory(interaction, config);
      }
    } catch (error) {
      console.error('[memory-vault] Interaction handling error:', error);
      await safeReply(interaction, {
        content: 'I ran into an error while doing that. Please try again in a moment.',
        ephemeral: true,
      });
    }
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (!isConfigured) {
      return;
    }

    await handleFavoriteReaction(reaction, user, config);
  });

  client.on(Events.Error, (error) => {
    console.error('[memory-vault] Discord client error:', error);
  });
}

async function registerCommands(client, config) {
  if (!process.env.DISCORD_TOKEN || !config.clientId || !config.guildId) {
    console.warn('[memory-vault] Skipping command registration due to missing token/client/guild env vars.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    const route = Routes.applicationGuildCommands(config.clientId, config.guildId);
    const existing = await rest.get(route);
    const incoming = [RANDOM_MEMORY_COMMAND.toJSON()];
    const incomingNames = new Set(incoming.map((command) => command.name));
    const removedLegacy = new Set(['testweeklyrecap', 'testdailyreminder']);
    const merged = [
      ...existing.filter((command) => !incomingNames.has(command.name) && !removedLegacy.has(command.name)),
      ...incoming,
    ];

    await rest.put(route, { body: merged });
    console.log('[memory-vault] Slash commands registered: /randommemory');
  } catch (error) {
    console.error('[memory-vault] Failed to register slash commands:', error);
  }
}

async function handleRandomMemory(interaction, config) {
  if (interaction.channelId !== config.memoryVaultChannelId) {
    await interaction.reply({
      content: 'This command is only for the Memory Vault 💛',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const channel = await getMemoryVaultChannel(interaction.client, config.memoryVaultChannelId);
  if (!channel) {
    await interaction.editReply('Memory Vault channel not found. Check MEMORY_VAULT_CHANNEL_ID.');
    return;
  }

  const messages = await fetchChannelMessages(channel, 500);
  const validMemories = messages.filter((message) => isValidMemoryMessage(message));

  if (validMemories.length === 0) {
    await interaction.editReply('I could not find a memory yet in this channel 💛');
    return;
  }

  const selected = validMemories[Math.floor(Math.random() * validMemories.length)];
  const embed = buildMemoryEmbed(selected, 'Random Memory 💛');

  await interaction.editReply({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

async function handleFavoriteReaction(reaction, user, config) {
  try {
    if (user.bot) {
      return;
    }

    if (reaction.partial) {
      await reaction.fetch();
    }

    const message = reaction.message;
    if (!message) {
      return;
    }

    if (message.partial) {
      await message.fetch();
    }

    if (reaction.emoji.name !== '⭐') {
      return;
    }

    if (message.channelId !== config.memoryVaultChannelId) {
      return;
    }

    if (!isValidMemoryMessage(message)) {
      return;
    }

    const memoryVaultChannel = await getMemoryVaultChannel(message.client, config.memoryVaultChannelId);
    if (!memoryVaultChannel) {
      console.warn('[memory-vault] Memory Vault channel missing while processing favorite reaction.');
      return;
    }

    const favoritesThread = await getOrCreateFavoritesThread(memoryVaultChannel);
    if (!favoritesThread) {
      return;
    }

    const originalUrl = message.url;
    const alreadyCopied = await threadContainsLink(favoritesThread, originalUrl);
    if (alreadyCopied) {
      return;
    }

    const embed = buildMemoryEmbed(message, '⭐ Favorite Memory');
    const { imageUrls, otherAttachmentLinks } = splitAttachments(message);
    if (imageUrls.length > 0) {
      embed.setImage(imageUrls[0]);
    }

    const body = [
      `Favorited by: **${safeAuthorName(user)}**`,
      `Original author: **${safeAuthorName(message.author)}**`,
      `Original date: ${formatDateTime(message.createdAt, process.env.TIMEZONE || 'Europe/Rome')}`,
      `Original message: ${originalUrl}`,
      otherAttachmentLinks ? `Attachments:\n${otherAttachmentLinks}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    await favoritesThread.send({
      content: body,
      embeds: [embed],
      allowedMentions: { parse: [] },
    });

    if (imageUrls.length > 1) {
      await favoritesThread.send({
        content: imageUrls.slice(1).join('\n'),
        allowedMentions: { parse: [] },
      });
    }
  } catch (error) {
    console.error('[memory-vault] Failed to handle ⭐ favorite reaction:', error);
  }
}

async function getOrCreateFavoritesThread(channel) {
  try {
    const active = await channel.threads.fetchActive();
    let existing = active.threads.find((thread) => thread.name === 'Favorite Memories');
    if (existing) {
      return existing;
    }

    const archived = await channel.threads.fetchArchived({ type: 'public', fetchAll: true });
    existing = archived.threads.find((thread) => thread.name === 'Favorite Memories');
    if (existing) {
      if (existing.archived) {
        await existing.setArchived(false, 'Reopening Favorite Memories thread');
      }
      return existing;
    }

    return await channel.threads.create({
      name: 'Favorite Memories',
      autoArchiveDuration: 10080,
      reason: 'Store favorited Memory Vault entries',
    });
  } catch (error) {
    console.error('[memory-vault] Failed to get or create Favorite Memories thread:', error);
    return null;
  }
}

async function threadContainsLink(thread, url) {
  try {
    const recent = await fetchChannelMessages(thread, 200);
    return recent.some((message) => message.content.includes(url));
  } catch (error) {
    console.error('[memory-vault] Failed duplicate check in favorites thread:', error);
    return false;
  }
}

function scheduleDailyReminder(client, config) {
  const schedule = () => {
    const delay = millisUntilNextLocalTime(config.timezone, config.dailyHour, config.dailyMinute);
    setTimeout(async () => {
      await sendDailyReminder(client, config);
      schedule();
    }, delay);
  };

  schedule();
}

async function sendDailyReminder(client, config) {
  try {
    const channel = await getMemoryVaultChannel(client, config.memoryVaultChannelId);
    if (!channel) {
      console.warn('[memory-vault] Daily reminder skipped: Memory Vault channel missing.');
      return;
    }

    const mentions =
      config.tagUserIds.length > 0 ? `${config.tagUserIds.map((id) => `<@${id}>`).join(' ')}\n\n` : '';

    await channel.send({
      content: `${mentions}💛 Memory Vault Time\n\nWhat’s one thing from today worth keeping?\n\nShare it here when you feel ready.\n\nTiny memories count too.`,
      allowedMentions: { users: config.tagUserIds, parse: [] },
    });
  } catch (error) {
    console.error('[memory-vault] Failed to send daily reminder:', error);
  }
}

async function getMemoryVaultChannel(client, channelId) {
  if (!channelId) {
    return null;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      return null;
    }

    return channel;
  } catch (error) {
    console.error('[memory-vault] Could not fetch Memory Vault channel:', error);
    return null;
  }
}

async function fetchChannelMessages(channel, max = 500) {
  const messages = [];
  let before;

  while (messages.length < max) {
    const chunkSize = Math.min(100, max - messages.length);
    const fetched = await channel.messages.fetch({ limit: chunkSize, before });

    if (!fetched.size) {
      break;
    }

    messages.push(...fetched.values());
    before = fetched.last().id;
  }

  return messages;
}

function isValidMemoryMessage(message) {
  if (!message || message.author?.bot) {
    return false;
  }

  const content = (message.content || '').trim();
  const hasText = content.length > 0;
  const hasAttachments = message.attachments && message.attachments.size > 0;

  if (!hasText && !hasAttachments) {
    return false;
  }

  if (content.startsWith('/')) {
    return false;
  }

  return true;
}

function buildMemoryEmbed(message, title) {
  const content = (message.content || '').trim();
  const description = content.length > 0 ? content : '*No text content*';

  return new EmbedBuilder()
    .setColor(0xf5c542)
    .setTitle(title)
    .setDescription(description.length > 4000 ? `${description.slice(0, 3990)}...` : description)
    .setFooter({ text: `${safeAuthorName(message.author)} • ${message.id}` })
    .setTimestamp(message.createdAt);
}

function splitAttachments(message) {
  if (!message.attachments || message.attachments.size === 0) {
    return { imageUrls: [], otherAttachmentLinks: '' };
  }

  const imageUrls = [];
  const otherAttachmentLinks = [];

  for (const attachment of message.attachments.values()) {
    const contentType = `${attachment.contentType || ''}`.toLowerCase();
    const isImage = contentType.startsWith('image/');

    if (isImage) {
      imageUrls.push(attachment.url);
      continue;
    }

    otherAttachmentLinks.push(`${attachment.name || 'attachment'}: ${attachment.url}`);
  }

  return {
    imageUrls,
    otherAttachmentLinks: otherAttachmentLinks.join('\n'),
  };
}

function parseUserIds(raw) {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^\d{16,20}$/.test(part));
}

function millisUntilNextLocalTime(timeZone, hour, minute) {
  const now = new Date();

  for (let addDays = 0; addDays <= 2; addDays += 1) {
    const candidate = new Date(now.getTime() + addDays * 24 * 60 * 60 * 1000);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(candidate);

    const year = Number(parts.find((p) => p.type === 'year')?.value);
    const month = Number(parts.find((p) => p.type === 'month')?.value);
    const day = Number(parts.find((p) => p.type === 'day')?.value);

    const target = zonedTimeToUtc({ year, month, day, hour, minute, second: 0 }, timeZone);
    if (target.getTime() > now.getTime()) {
      return target.getTime() - now.getTime();
    }
  }

  return 60_000;
}

function zonedTimeToUtc(parts, timeZone) {
  const utcGuess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0));

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const asLocal = dtf.formatToParts(utcGuess);
  const actual = {
    year: Number(asLocal.find((p) => p.type === 'year')?.value),
    month: Number(asLocal.find((p) => p.type === 'month')?.value),
    day: Number(asLocal.find((p) => p.type === 'day')?.value),
    hour: Number(asLocal.find((p) => p.type === 'hour')?.value),
    minute: Number(asLocal.find((p) => p.type === 'minute')?.value),
    second: Number(asLocal.find((p) => p.type === 'second')?.value),
  };

  const desiredMillis = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  const actualMillis = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
  const offset = actualMillis - desiredMillis;

  return new Date(utcGuess.getTime() - offset);
}

function formatDateTime(date, timezone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function toSafeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeAuthorName(user) {
  return user?.username || user?.tag || 'Unknown';
}

async function safeReply(interaction, payload) {
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
    return;
  }

  await interaction.reply(payload);
}

module.exports = {
  setupMemoryVault,
};
