const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const MOOD_COMMAND = new SlashCommandBuilder()
  .setName('mood')
  .setDescription('Log today\'s mood and update the monthly mood chart')
  .addStringOption((option) =>
    option
      .setName('feeling')
      .setDescription('How are you feeling today?')
      .setRequired(true)
      .addChoices(
        { name: 'Awful', value: 'awful' },
        { name: 'Bad', value: 'bad' },
        { name: 'Okay', value: 'okay' },
        { name: 'Good', value: 'good' },
        { name: 'Excellent', value: 'excellent' },
      ),
  );
const MOOD_RESET_COMMAND = new SlashCommandBuilder()
  .setName('moodreset')
  .setDescription('Reset the current monthly mood chart (testing)');

const STORE_PATH = path.resolve(__dirname, '../data/mood-tracker.json');
const ARCHIVE_THREAD_NAME = 'Mood Tracker Archive';
const TRACKER_MESSAGE_TITLE = 'Mood Tracker';
const BUTTON_PREFIX = 'mood_tracker_set_';

const MOOD_WORD_TO_SCORE = {
  awful: 1,
  terrible: 1,
  horrible: 1,
  bad: 2,
  low: 2,
  okay: 3,
  meh: 3,
  neutral: 3,
  good: 4,
  nice: 4,
  great: 5,
  excellent: 5,
  amazing: 5,
};

const SCORE_TO_LABEL = {
  1: 'Awful',
  2: 'Bad',
  3: 'Okay',
  4: 'Good',
  5: 'Excellent',
};

const SCORE_TO_TILE = {
  1: '🟥',
  2: '🟧',
  3: '🟨',
  4: '🟩',
  5: '🟦',
};

function setupMoodTracker(client) {
  const config = {
    clientId: process.env.CLIENT_ID,
    guildId: process.env.GUILD_ID,
    moodChannelId: process.env.MOOD_TRACKER_CHANNEL_ID || '1506639242225385504',
    timezone: process.env.TIMEZONE || 'Europe/Rome',
  };

  const required = ['CLIENT_ID', 'GUILD_ID'];
  const missing = required.filter((name) => !process.env[name]);
  const isConfigured = missing.length === 0 && !!config.moodChannelId;

  if (!isConfigured) {
    const details = [...missing, !config.moodChannelId ? 'MOOD_TRACKER_CHANNEL_ID or CHECKIN_CHANNEL_ID' : null]
      .filter(Boolean)
      .join(', ');
    console.error(`[mood-tracker] Missing required environment values: ${details}. Mood tracker is disabled.`);
  }

  client.once(Events.ClientReady, async () => {
    if (!isConfigured) {
      return;
    }

    await registerMoodCommand(config);
    console.log(`[mood-tracker] Ready | channel=${config.moodChannelId} timezone=${config.timezone}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!isConfigured) {
      return;
    }

    try {
      if (interaction.isChatInputCommand() && interaction.commandName === 'mood') {
        await handleMoodCommand(interaction, config);
        return;
      }
      if (interaction.isChatInputCommand() && interaction.commandName === 'moodreset') {
        await handleMoodResetCommand(interaction, config);
        return;
      }
      if (interaction.isButton() && interaction.customId.startsWith(BUTTON_PREFIX)) {
        await handleMoodButton(interaction, config);
      }
    } catch (error) {
      console.error('[mood-tracker] Failed to handle mood command:', error);
      await safeReply(interaction, {
        content: 'Mood tracker command failed. Please try again in a moment.',
        flags: MessageFlags.Ephemeral,
      });
    }
  });
}

async function registerMoodCommand(config) {
  if (!process.env.DISCORD_TOKEN || !config.clientId || !config.guildId) {
    console.warn('[mood-tracker] Skipping command registration due to missing token/client/guild env vars.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const route = Routes.applicationGuildCommands(config.clientId, config.guildId);

  try {
    const existing = await rest.get(route);
    const incoming = [MOOD_COMMAND.toJSON(), MOOD_RESET_COMMAND.toJSON()];
    const incomingNames = new Set(incoming.map((command) => command.name));
    const merged = [...existing.filter((command) => !incomingNames.has(command.name)), ...incoming];

    await rest.put(route, { body: merged });
    console.log('[mood-tracker] Slash commands registered: /mood, /moodreset');
  } catch (error) {
    console.error('[mood-tracker] Failed to register slash command:', error);
  }
}

async function handleMoodCommand(interaction, config) {
  if (interaction.channelId !== config.moodChannelId) {
    await interaction.reply({
      content: 'Use this command in the mood tracker channel only 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const word = `${interaction.options.getString('feeling', true)}`.trim().toLowerCase();
  const score = moodScoreFromWord(word);
  if (!score) {
    await interaction.reply({
      content: 'Unknown mood word. Use one of: awful, bad, okay, good, excellent.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = await getTextChannel(interaction.client, config.moodChannelId);
  if (!channel) {
    await interaction.reply({
      content: 'Mood channel not found. Check `MOOD_TRACKER_CHANNEL_ID`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const now = new Date();
  const day = getLocalDateParts(now, config.timezone);
  const store = readStore();
  const monthKey = `${day.year}-${String(day.month).padStart(2, '0')}`;

  if (store.monthKey && store.monthKey !== monthKey) {
    await archiveCurrentMonth(channel, store, config.timezone);
    store.monthKey = monthKey;
    store.entries = {};
    store.chartMessageId = null;
  }

  if (!store.monthKey) {
    store.monthKey = monthKey;
  }

  await applyMoodScore(channel, store, score, day, config.timezone);

  writeStore(store);

  await interaction.reply({
    content: `Saved for ${formatLocalDate(now, config.timezone)}: **${SCORE_TO_LABEL[score]}** (${score}/5).`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleMoodResetCommand(interaction, config) {
  if (interaction.channelId !== config.moodChannelId) {
    await interaction.reply({
      content: 'Use this command in the mood tracker channel only 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = await getTextChannel(interaction.client, config.moodChannelId);
  if (!channel) {
    await interaction.reply({
      content: 'Mood channel not found. Check `MOOD_TRACKER_CHANNEL_ID`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const now = new Date();
  const day = getLocalDateParts(now, config.timezone);
  const monthKey = `${day.year}-${String(day.month).padStart(2, '0')}`;
  const existing = readStore();
  const store = {
    monthKey,
    entries: {},
    chartMessageId: existing.chartMessageId || null,
    updatedAt: new Date().toISOString(),
  };
  await ensureTrackerMessage(channel, store, config.timezone);
  await upsertTrackerMessage(channel, store, config.timezone);
  writeStore(store);

  await interaction.reply({
    content: `Mood chart reset for **${monthTitleFromKey(monthKey)}**.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleMoodButton(interaction, config) {
  if (interaction.channelId !== config.moodChannelId) {
    await interaction.reply({
      content: 'Use these mood buttons in the mood tracker channel only 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const scoreText = interaction.customId.replace(BUTTON_PREFIX, '');
  const score = Number(scoreText);
  if (![1, 2, 3, 4, 5].includes(score)) {
    await interaction.reply({
      content: 'Invalid mood button.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = await getTextChannel(interaction.client, config.moodChannelId);
  if (!channel) {
    await interaction.reply({
      content: 'Mood channel not found. Check `MOOD_TRACKER_CHANNEL_ID`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const now = new Date();
  const day = getLocalDateParts(now, config.timezone);
  const monthKey = `${day.year}-${String(day.month).padStart(2, '0')}`;
  const store = readStore();

  if (store.monthKey && store.monthKey !== monthKey) {
    await archiveCurrentMonth(channel, store, config.timezone);
    store.monthKey = monthKey;
    store.entries = {};
    store.chartMessageId = null;
  }

  if (!store.monthKey) {
    store.monthKey = monthKey;
  }

  await applyMoodScore(channel, store, score, day, config.timezone);
  writeStore(store);

  await interaction.reply({
    content: `Saved for ${formatLocalDate(now, config.timezone)}: **${SCORE_TO_LABEL[score]}** (${score}/5).`,
    flags: MessageFlags.Ephemeral,
  });
}

async function applyMoodScore(channel, store, score, day, timezone) {
  store.entries[String(day.day)] = score;
  store.updatedAt = new Date().toISOString();
  await ensureTrackerMessage(channel, store, timezone);
  await upsertTrackerMessage(channel, store, timezone);
}

async function archiveCurrentMonth(channel, store, timezone) {
  if (!store.monthKey) {
    return;
  }

  const archiveThread = await getOrCreateArchiveThread(channel);
  if (!archiveThread) {
    return;
  }

  const embed = buildMonthChartEmbed(store.monthKey, store.entries || {}, timezone);
  await archiveThread.send({
    content: `Archived month: **${monthTitleFromKey(store.monthKey)}**`,
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

async function getOrCreateArchiveThread(channel) {
  try {
    const active = await channel.threads.fetchActive();
    let existing = active.threads.find((thread) => thread.name === ARCHIVE_THREAD_NAME);
    if (existing) {
      return existing;
    }

    const archived = await channel.threads.fetchArchived({ type: 'public', fetchAll: true });
    existing = archived.threads.find((thread) => thread.name === ARCHIVE_THREAD_NAME);
    if (existing) {
      if (existing.archived) {
        await existing.setArchived(false, 'Reopen mood archive thread');
      }
      return existing;
    }

    return await channel.threads.create({
      name: ARCHIVE_THREAD_NAME,
      autoArchiveDuration: 10080,
      reason: 'Archive monthly mood tracker charts',
    });
  } catch (error) {
    console.error('[mood-tracker] Failed to get/create archive thread:', error);
    return null;
  }
}

function buildMonthChartEmbed(monthKey, entries, timezone) {
  const [yearText, monthText] = monthKey.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const daysInMonth = new Date(year, month, 0).getDate();

  const firstWeekday = mondayIndex(new Date(year, month - 1, 1).getDay());
  const cells = Array(firstWeekday).fill(null);

  for (let day = 1; day <= daysInMonth; day += 1) {
    const score = Number(entries[String(day)]);
    cells.push({ day, tile: SCORE_TO_TILE[score] || '⬛' });
  }

  while (cells.length % 7 !== 0) {
    cells.push(null);
  }

  const lines = [];
  for (let i = 0; i < cells.length; i += 7) {
    const week = cells.slice(i, i + 7);
    lines.push(week.map((cell) => (cell ? cell.tile : '⬜')).join(' '));
    lines.push(
      week
        .map((cell) => (cell ? String(cell.day).padStart(2, '0') : '  '))
        .join(' '),
    );
  }

  return new EmbedBuilder()
    .setTitle(`${TRACKER_MESSAGE_TITLE} — ${monthTitleFromKey(monthKey)}`)
    .setDescription([
      '`Mo Tu We Th Fr Sa Su`',
      ...lines,
      '',
      'Legend: 🟥 1 Awful | 🟧 2 Bad | 🟨 3 Okay | 🟩 4 Good | 🟦 5 Excellent (cyan) | ⬛ no entry',
    ].join('\n'))
    .setFooter({ text: `Timezone: ${timezone}` });
}

function buildMoodButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}1`).setLabel('Awful').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}2`).setLabel('Bad').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}3`).setLabel('Okay').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}4`).setLabel('Good').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}5`).setLabel('Excellent').setStyle(ButtonStyle.Success),
    ),
  ];
}

function monthTitleFromKey(monthKey) {
  const [yearText, monthText] = monthKey.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const date = new Date(Date.UTC(year, month - 1, 1));
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function moodScoreFromWord(word) {
  return MOOD_WORD_TO_SCORE[word] || null;
}

function mondayIndex(jsWeekday) {
  return jsWeekday === 0 ? 6 : jsWeekday - 1;
}

function getLocalDateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  return {
    year: Number(parts.find((part) => part.type === 'year')?.value || 0),
    month: Number(parts.find((part) => part.type === 'month')?.value || 0),
    day: Number(parts.find((part) => part.type === 'day')?.value || 0),
  };
}

function formatLocalDate(date, timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

async function getTextChannel(client, channelId) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      return null;
    }
    return channel;
  } catch {
    return null;
  }
}

function readStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      return { monthKey: null, entries: {}, chartMessageId: null };
    }

    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      monthKey: parsed.monthKey || null,
      entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
      chartMessageId: parsed.chartMessageId || null,
      updatedAt: parsed.updatedAt || null,
    };
  } catch {
    return { monthKey: null, entries: {}, chartMessageId: null };
  }
}

function writeStore(store) {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  } catch (error) {
    console.error('[mood-tracker] Failed to write store:', error);
  }
}

async function ensureTrackerMessage(channel, store, timezone) {
  if (store.chartMessageId) {
    try {
      await channel.messages.fetch(store.chartMessageId);
      return;
    } catch {
      store.chartMessageId = null;
    }
  }

  const embed = buildMonthChartEmbed(store.monthKey, store.entries, timezone);
  const sent = await channel.send({
    content: 'Use the buttons below to log today’s mood.',
    embeds: [embed],
    components: buildMoodButtons(),
    allowedMentions: { parse: [] },
  });
  store.chartMessageId = sent.id;
}

async function upsertTrackerMessage(channel, store, timezone) {
  if (!store.chartMessageId) {
    return;
  }

  const embed = buildMonthChartEmbed(store.monthKey, store.entries, timezone);
  try {
    const message = await channel.messages.fetch(store.chartMessageId);
    await message.edit({
      content: 'Use the buttons below to log today’s mood.',
      embeds: [embed],
      components: buildMoodButtons(),
      allowedMentions: { parse: [] },
    });
  } catch {
    store.chartMessageId = null;
    await ensureTrackerMessage(channel, store, timezone);
  }
}

async function safeReply(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload);
    return;
  }
  await interaction.reply(payload);
}

module.exports = {
  setupMoodTracker,
};
