const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');

const MEMORY_TYPES = {
  funny: {
    label: 'Funny',
    prompt: 'What made you laugh or smile today?',
  },
  comforting: {
    label: 'Comforting',
    prompt: 'What made you feel safe, calm, or cared for today?',
  },
  appreciation: {
    label: 'Appreciation',
    prompt: 'What did you appreciate about us today?',
  },
  realization: {
    label: 'Realization',
    prompt: 'What did you realize about us, yourself, or love today?',
  },
  difficult_meaningful: {
    label: 'Difficult but meaningful',
    prompt: 'What was hard today but still meaningful for us?',
  },
  random_little_moment: {
    label: 'Random little moment',
    prompt: 'What tiny random moment do you want future us to remember?',
  },
};

const ADD_MEMORY_COMMAND = new SlashCommandBuilder()
  .setName('addmemory')
  .setDescription('Add a memory to the Memory Vault');

const RANDOM_MEMORY_COMMAND = new SlashCommandBuilder()
  .setName('randommemory')
  .setDescription('Show a random memory from the Memory Vault');

const TEST_WEEKLY_RECAP_COMMAND = new SlashCommandBuilder()
  .setName('testweeklyrecap')
  .setDescription('Force-run the weekly recap now (for testing)');

const TEST_DAILY_REMINDER_COMMAND = new SlashCommandBuilder()
  .setName('testdailyreminder')
  .setDescription('Send the daily reminder now (for testing)');

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

  let dailyTimer = null;
  let weeklyTimer = null;

  client.once(Events.ClientReady, async () => {
    if (!isConfigured) {
      console.warn('[memory-vault] Skipping setup because required env vars are missing.');
      return;
    }

    await registerCommands(client, config);
    scheduleDailyReminder(client, config, () => (dailyTimer = null), (timer) => (dailyTimer = timer));
    scheduleWeeklyRecap(client, config, () => (weeklyTimer = null), (timer) => (weeklyTimer = timer));

    console.log(
      `[memory-vault] Ready | timezone=${config.timezone} daily=${String(config.dailyHour).padStart(2, '0')}:${String(config.dailyMinute).padStart(2, '0')} weekly=Sunday 22:00`,
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

      if (interaction.commandName === 'addmemory') {
        await handleAddMemory(interaction, config);
      }

      if (interaction.commandName === 'randommemory') {
        await handleRandomMemory(interaction, config);
      }

      if (interaction.commandName === 'testweeklyrecap') {
        await handleTestWeeklyRecap(interaction, config);
      }

      if (interaction.commandName === 'testdailyreminder') {
        await handleTestDailyReminder(interaction, config);
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
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
      body: [
        ADD_MEMORY_COMMAND.toJSON(),
        RANDOM_MEMORY_COMMAND.toJSON(),
        TEST_WEEKLY_RECAP_COMMAND.toJSON(),
        TEST_DAILY_REMINDER_COMMAND.toJSON(),
      ],
    });
    console.log(
      '[memory-vault] Slash commands registered: /addmemory, /randommemory, /testweeklyrecap, /testdailyreminder',
    );
  } catch (error) {
    console.error('[memory-vault] Failed to register slash commands:', error);
  }
}

async function handleAddMemory(interaction, config) {
  if (interaction.channelId !== config.memoryVaultChannelId) {
    await interaction.reply({
      content: 'This command is only for the Memory Vault 💛',
      ephemeral: true,
    });
    return;
  }

  const flowButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('memory_flow_free').setLabel('Free').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('memory_flow_guided').setLabel('Guided').setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({
    content: 'Choose your memory flow:',
    components: [flowButtons],
    ephemeral: true,
  });

  const response = await interaction.fetchReply();
  let selectedFlow;

  try {
    const flowInteraction = await response.awaitMessageComponent({
      filter: (componentInteraction) => componentInteraction.user.id === interaction.user.id,
      time: 120000,
    });

    selectedFlow = flowInteraction.customId;

    if (selectedFlow === 'memory_flow_free') {
      await flowInteraction.update({
        content: 'Send your memory as your next message. Tiny memories count too 💛',
        components: [],
      });

      const memoryMessage = await waitForNextMemoryMessage(interaction.channel, interaction.user.id);
      if (!memoryMessage) {
        await interaction.followUp({
          content: 'I did not catch a message in time. Use /addmemory whenever you are ready 💛',
          ephemeral: true,
        });
        return;
      }

      await interaction.followUp({
        content: 'Memory saved 💛',
        ephemeral: true,
      });
      return;
    }

    const selectMenu = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('memory_guided_type')
        .setPlaceholder('Choose a memory type')
        .addOptions(
          Object.entries(MEMORY_TYPES).map(([value, details]) => ({
            label: details.label,
            value,
          })),
        ),
    );

    await flowInteraction.update({
      content: 'Pick your memory type:',
      components: [selectMenu],
    });

    const guidedSelectorMessage = await interaction.fetchReply();
    const guidedTypeInteraction = await guidedSelectorMessage.awaitMessageComponent({
      filter: (componentInteraction) => componentInteraction.user.id === interaction.user.id,
      time: 120000,
    });

    const type = guidedTypeInteraction.values[0];
    const memoryType = MEMORY_TYPES[type];

    if (!memoryType) {
      await guidedTypeInteraction.update({
        content: 'That memory type is not supported. Please run /addmemory again.',
        components: [],
      });
      return;
    }

    await guidedTypeInteraction.update({
      content: `${memoryType.label}: ${memoryType.prompt}`,
      components: [],
    });

    const memoryMessage = await waitForNextMemoryMessage(interaction.channel, interaction.user.id);
    if (!memoryMessage) {
      await interaction.followUp({
        content: 'I did not catch a message in time. Use /addmemory whenever you are ready 💛',
        ephemeral: true,
      });
      return;
    }

    await interaction.followUp({
      content: 'Memory saved 💛',
      ephemeral: true,
    });
  } catch (error) {
    if (error?.name === 'Error' && `${error.message}`.includes('time')) {
      await interaction.followUp({
        content: 'That timed out. Use /addmemory when you want to try again 💛',
        ephemeral: true,
      });
      return;
    }

    throw error;
  }
}

async function waitForNextMemoryMessage(channel, userId) {
  try {
    const collected = await channel.awaitMessages({
      filter: (message) => message.author.id === userId && !message.author.bot,
      max: 1,
      time: 5 * 60 * 1000,
      errors: ['time'],
    });

    return collected.first() ?? null;
  } catch {
    return null;
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

async function handleTestWeeklyRecap(interaction, config) {
  if (interaction.channelId !== config.memoryVaultChannelId) {
    await interaction.reply({
      content: 'This command is only for the Memory Vault 💛',
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: 'Running weekly recap test now. I will create a recap thread from the last 7 days.',
    ephemeral: true,
  });

  await postWeeklyRecap(interaction.client, config, { force: true });
}

async function handleTestDailyReminder(interaction, config) {
  if (interaction.channelId !== config.memoryVaultChannelId) {
    await interaction.reply({
      content: 'This command is only for the Memory Vault 💛',
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: 'Sending daily reminder test now 💛',
    ephemeral: true,
  });

  await sendDailyReminder(interaction.client, config);
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

function scheduleDailyReminder(client, config, clearTimer, storeTimer) {
  const schedule = async () => {
    const delay = millisUntilNextLocalTime(config.timezone, config.dailyHour, config.dailyMinute, null);
    const timer = setTimeout(async () => {
      clearTimer();
      await sendDailyReminder(client, config);
      schedule();
    }, delay);

    storeTimer(timer);
  };

  schedule();
}

function scheduleWeeklyRecap(client, config, clearTimer, storeTimer) {
  const schedule = async () => {
    const delay = millisUntilNextLocalTime(config.timezone, 22, 0, 0);
    const timer = setTimeout(async () => {
      clearTimer();
      await postWeeklyRecap(client, config);
      schedule();
    }, delay);

    storeTimer(timer);
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
      content: `${mentions}💛 Memory Vault Time\n\nWhat’s one thing from today worth keeping?\n\nUse /addmemory to save it.\n\nTiny memories count too.`,
      allowedMentions: { users: config.tagUserIds, parse: [] },
    });
  } catch (error) {
    console.error('[memory-vault] Failed to send daily reminder:', error);
  }
}

async function postWeeklyRecap(client, config, options = {}) {
  const { force = false } = options;

  try {
    const now = new Date();
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: config.timezone }).format(now);
    const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: config.timezone }).format(now));

    if (!force && (weekday !== 'Sunday' || hour !== 22)) {
      return;
    }

    const channel = await getMemoryVaultChannel(client, config.memoryVaultChannelId);
    if (!channel) {
      console.warn('[memory-vault] Weekly recap skipped: Memory Vault channel missing.');
      return;
    }

    const threadName = buildWeeklyThreadName(now, config.timezone);
    const thread = await channel.threads.create({
      name: threadName,
      autoArchiveDuration: 10080,
      reason: 'Weekly Memory Vault recap',
    });

    const oneWeekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const history = await fetchChannelMessages(channel, 500);
    const memories = history
      .filter((message) => message.createdTimestamp >= oneWeekAgo)
      .filter((message) => isValidMemoryMessage(message));

    if (memories.length === 0) {
      await thread.send('No memories were found this week, and that’s okay 💛');
      return;
    }

    const sorted = memories.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    await thread.send(`Weekly recap for the last 7 days (${sorted.length} memories) 💛`);

    for (const memory of sorted) {
      const embed = buildMemoryEmbed(memory, 'Memory');
      const { imageUrls, otherAttachmentLinks } = splitAttachments(memory);
      if (imageUrls.length > 0) {
        embed.setImage(imageUrls[0]);
      }
      const content = [
        `Date: ${formatDateTime(memory.createdAt, config.timezone)}`,
        `Author: **${safeAuthorName(memory.author)}**`,
        `Original message: ${memory.url}`,
        otherAttachmentLinks ? `Attachments:\n${otherAttachmentLinks}` : null,
      ]
        .filter(Boolean)
        .join('\n');

      await thread.send({
        content,
        embeds: [embed],
        allowedMentions: { parse: [] },
      });

      if (imageUrls.length > 1) {
        await thread.send({
          content: imageUrls.slice(1).join('\n'),
          allowedMentions: { parse: [] },
        });
      }
    }
  } catch (error) {
    console.error('[memory-vault] Failed weekly recap:', error);
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

function formatAttachmentLinks(message) {
  if (!message.attachments || message.attachments.size === 0) {
    return '';
  }

  return message.attachments
    .map((attachment) => `${attachment.name || 'attachment'}: ${attachment.url}`)
    .join('\n');
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

function buildWeeklyThreadName(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value || `${date.getUTCFullYear()}`;
  const month = parts.find((part) => part.type === 'month')?.value || 'Unknown';
  const day = Number(parts.find((part) => part.type === 'day')?.value || '1');
  const week = Math.ceil(day / 7);

  return `${year} • ${month} • Week ${week}`;
}

function millisUntilNextLocalTime(timeZone, hour, minute, dayOfWeek) {
  const now = new Date();

  for (let addDays = 0; addDays <= 8; addDays += 1) {
    const candidate = new Date(now.getTime() + addDays * 24 * 60 * 60 * 1000);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(candidate);

    const year = Number(parts.find((p) => p.type === 'year')?.value);
    const month = Number(parts.find((p) => p.type === 'month')?.value);
    const day = Number(parts.find((p) => p.type === 'day')?.value);
    const weekday = parts.find((p) => p.type === 'weekday')?.value;

    if (dayOfWeek !== null && dayOfWeek !== undefined) {
      const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
      if (weekdayIndex !== dayOfWeek) {
        continue;
      }
    }

    const candidateUTC = zonedTimeToUtc({ year, month, day, hour, minute, second: 0 }, timeZone);
    if (candidateUTC.getTime() > now.getTime()) {
      return candidateUTC.getTime() - now.getTime();
    }
  }

  return 60 * 1000;
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
