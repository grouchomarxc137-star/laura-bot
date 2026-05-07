const {
  ActionRowBuilder,
  ChannelType,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');

const BOUNDARY_CATEGORIES = [
  'Social connections',
  'Clothing and presentation',
  'Exes and past connections',
  'Privacy',
  'Communication and repair',
  'Digital spaces',
  'Health and safety',
  'Sexual boundaries',
  'Family and home',
  'Other',
];

const BOUNDARY_STATUSES = ['🟢 Agreed', '🟡 Needs discussion'];
const BOUNDARY_TYPES = ['Hard boundary', 'Preference / comfort request'];

const LIST_THREAD_NAME = 'List of Boundaries';
const HISTORY_THREAD_NAME = 'Boundary History';

const ADD_BOUNDARY_COMMAND = new SlashCommandBuilder()
  .setName('addboundary')
  .setDescription('Add a new boundary to the boundaries list');

const BOUNDARY_LIST_COMMAND = new SlashCommandBuilder()
  .setName('boundarylist')
  .setDescription('View boundaries by category');

const UPDATE_BOUNDARY_COMMAND = new SlashCommandBuilder()
  .setName('updateboundary')
  .setDescription('Update an existing boundary and archive the old version');

const BOUNDARY_REQUEST_COMMAND = new SlashCommandBuilder()
  .setName('boundaryrequest')
  .setDescription('Create a gentle boundary discussion request');

const REVIEW_BOUNDARIES_COMMAND = new SlashCommandBuilder()
  .setName('reviewboundaries')
  .setDescription('Post a boundaries review prompt');

function setupBoundaries(client) {
  const config = {
    clientId: process.env.CLIENT_ID,
    guildId: process.env.GUILD_ID,
    boundariesChannelId: process.env.BOUNDARIES_CHANNEL_ID,
    timezone: process.env.TIMEZONE || 'Europe/Rome',
  };

  const required = ['CLIENT_ID', 'GUILD_ID', 'BOUNDARIES_CHANNEL_ID'];
  const missing = required.filter((name) => !process.env[name]);
  const isConfigured = missing.length === 0;

  if (!isConfigured) {
    console.error(
      `[boundaries] Missing required environment variables: ${missing.join(', ')}. Boundaries automation is disabled until these are set.`,
    );
  }

  const activeFlows = new Set();

  client.once(Events.ClientReady, async () => {
    if (!isConfigured) {
      console.warn('[boundaries] Skipping setup because required env vars are missing.');
      return;
    }

    await registerBoundaryCommands(config);

    const channel = await getBoundariesChannel(client, config.boundariesChannelId);
    if (channel) {
      await ensureBoundariesThreads(channel);
      console.log('[boundaries] Required threads are ready.');
    } else {
      console.warn('[boundaries] Could not find boundaries channel during startup.');
    }

    scheduleMonthlyReview(client, config);
    console.log('[boundaries] Ready | monthly review=First Sunday 21:00');
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!isConfigured || !interaction.isChatInputCommand()) {
      return;
    }

    try {
      if (interaction.commandName === 'addboundary') {
        await handleAddBoundary(interaction, config, activeFlows);
      }

      if (interaction.commandName === 'boundarylist') {
        await handleBoundaryList(interaction, config);
      }

      if (interaction.commandName === 'updateboundary') {
        await handleUpdateBoundary(interaction, config, activeFlows);
      }

      if (interaction.commandName === 'boundaryrequest') {
        await handleBoundaryRequest(interaction, config, activeFlows);
      }

      if (interaction.commandName === 'reviewboundaries') {
        await handleReviewBoundaries(interaction, config);
      }
    } catch (error) {
      console.error('[boundaries] Interaction error:', error);
      await safeReply(interaction, {
        content: 'Something went wrong. Please try again in a moment.',
        ephemeral: true,
      });
    }
  });
}

async function registerBoundaryCommands(config) {
  if (!process.env.DISCORD_TOKEN || !config.clientId || !config.guildId) {
    console.warn('[boundaries] Skipping command registration due to missing token/client/guild env vars.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const route = Routes.applicationGuildCommands(config.clientId, config.guildId);

  try {
    const existing = await rest.get(route);
    const incoming = [
      ADD_BOUNDARY_COMMAND.toJSON(),
      BOUNDARY_LIST_COMMAND.toJSON(),
      UPDATE_BOUNDARY_COMMAND.toJSON(),
      BOUNDARY_REQUEST_COMMAND.toJSON(),
      REVIEW_BOUNDARIES_COMMAND.toJSON(),
    ];
    const incomingNames = new Set(incoming.map((command) => command.name));
    const merged = [...existing.filter((command) => !incomingNames.has(command.name)), ...incoming];

    await rest.put(route, { body: merged });
    console.log('[boundaries] Slash commands registered.');
  } catch (error) {
    console.error('[boundaries] Failed to register slash commands:', error);
  }
}

async function handleAddBoundary(interaction, config, activeFlows) {
  if (!isInBoundariesChannel(interaction, config)) {
    await onlyBoundariesReply(interaction);
    return;
  }

  if (activeFlows.has(interaction.user.id)) {
    await interaction.reply({
      content: 'You already have an active boundary flow. Finish it first or wait for timeout 💛',
      ephemeral: true,
    });
    return;
  }

  activeFlows.add(interaction.user.id);

  try {
    const channel = await getBoundariesChannel(interaction.client, config.boundariesChannelId);
    if (!channel) {
      await interaction.reply({ content: 'Boundaries channel not found. Check BOUNDARIES_CHANNEL_ID.', ephemeral: true });
      return;
    }

    const { listThread } = await ensureBoundariesThreads(channel);

    const category = await askChoice(interaction, {
      prompt: 'Choose a category:',
      customId: 'boundary_add_category',
      values: BOUNDARY_CATEGORIES,
    });
    if (!category) return;

    const status = await askChoice(interaction, {
      prompt: 'Choose status:',
      customId: 'boundary_add_status',
      values: BOUNDARY_STATUSES,
    });
    if (!status) return;

    const type = await askChoice(interaction, {
      prompt: 'Choose type:',
      customId: 'boundary_add_type',
      values: BOUNDARY_TYPES,
    });
    if (!type) return;

    const answers = await askTextQuestions(interaction, [
      'What is the boundary?',
      'Why does it matter?',
      'What is okay?',
      'What is not okay?',
      'How should we handle mistakes or misunderstandings?',
      'Any notes or context?',
    ]);
    if (!answers) return;

    const boundaryContent = formatBoundaryEntry({
      title: answers[0],
      category,
      status,
      type,
      addedBy: interaction.user.username,
      date: formatDateTime(new Date(), config.timezone),
      why: answers[1],
      okay: answers[2],
      notOkay: answers[3],
      handling: answers[4],
      notes: answers[5],
      originalDiscussion: `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}`,
    });

    await listThread.send({ content: boundaryContent, allowedMentions: { parse: [] } });
    await interaction.followUp({ content: 'Boundary added to the list 💛', ephemeral: true });
  } finally {
    activeFlows.delete(interaction.user.id);
  }
}

async function handleBoundaryList(interaction, config) {
  if (!isInBoundariesChannel(interaction, config)) {
    await onlyBoundariesReply(interaction);
    return;
  }

  const channel = await getBoundariesChannel(interaction.client, config.boundariesChannelId);
  if (!channel) {
    await interaction.reply({ content: 'Boundaries channel not found. Check BOUNDARIES_CHANNEL_ID.', ephemeral: true });
    return;
  }

  const { listThread } = await ensureBoundariesThreads(channel);

  const selected = await askChoice(interaction, {
    prompt: 'Choose a category to view:',
    customId: 'boundary_list_category',
    values: ['All categories', ...BOUNDARY_CATEGORIES],
  });
  if (!selected) {
    return;
  }

  const messages = await fetchChannelMessages(listThread, 500);
  const boundaries = messages
    .filter((message) => isBoundaryEntry(message.content))
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const filtered = selected === 'All categories'
    ? boundaries
    : boundaries.filter((message) => message.content.includes(`Category: ${selected}`));

  if (filtered.length === 0) {
    await interaction.followUp({ content: 'Nothing found for this category yet 💛', ephemeral: true });
    return;
  }

  const lines = filtered.slice(-20).map((message) => {
    const titleLine = (message.content.split('\n').find((line) => line.startsWith('🧭 Boundary:')) || '🧭 Boundary: Untitled').replace('🧭 Boundary:', '').trim();
    const categoryLine = message.content.split('\n').find((line) => line.startsWith('Category:')) || 'Category: Unknown';
    return `• ${titleLine} | ${categoryLine.replace('Category: ', '')} | ${message.url}`;
  });

  await interaction.followUp({
    content: `Boundaries for **${selected}** (showing up to 20 latest):\n${lines.join('\n')}`,
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

async function handleUpdateBoundary(interaction, config, activeFlows) {
  if (!isInBoundariesChannel(interaction, config)) {
    await onlyBoundariesReply(interaction);
    return;
  }

  if (activeFlows.has(interaction.user.id)) {
    await interaction.reply({
      content: 'You already have an active boundary flow. Finish it first or wait for timeout 💛',
      ephemeral: true,
    });
    return;
  }

  activeFlows.add(interaction.user.id);

  try {
    const channel = await getBoundariesChannel(interaction.client, config.boundariesChannelId);
    if (!channel) {
      await interaction.reply({ content: 'Boundaries channel not found. Check BOUNDARIES_CHANNEL_ID.', ephemeral: true });
      return;
    }

    const { listThread, historyThread } = await ensureBoundariesThreads(channel);
    const messages = await fetchChannelMessages(listThread, 500);
    const boundaries = messages
      .filter((message) => isBoundaryEntry(message.content) && !message.content.includes('ARCHIVED / UPDATED'))
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

    if (boundaries.length === 0) {
      await interaction.reply({ content: 'No boundaries found to update yet 💛', ephemeral: true });
      return;
    }

    const options = boundaries.slice(0, 25).map((message, index) => {
      const title = extractBoundaryTitle(message.content) || `Boundary ${index + 1}`;
      return { label: truncate(title, 100), value: message.id };
    });

    const selectedId = await askChoice(interaction, {
      prompt: boundaries.length > 25
        ? 'Choose a boundary to update (latest 25 shown):'
        : 'Choose a boundary to update:',
      customId: 'boundary_update_pick',
      values: options,
      prebuilt: true,
    });

    if (!selectedId) {
      return;
    }

    const oldBoundaryMessage = boundaries.find((message) => message.id === selectedId);
    if (!oldBoundaryMessage) {
      await interaction.followUp({ content: 'Could not find that boundary anymore. Try again 💛', ephemeral: true });
      return;
    }

    const category = await askChoice(interaction, {
      prompt: 'Choose updated category:',
      customId: 'boundary_update_category',
      values: BOUNDARY_CATEGORIES,
    });
    if (!category) return;

    const status = await askChoice(interaction, {
      prompt: 'Choose updated status:',
      customId: 'boundary_update_status',
      values: BOUNDARY_STATUSES,
    });
    if (!status) return;

    const type = await askChoice(interaction, {
      prompt: 'Choose updated type:',
      customId: 'boundary_update_type',
      values: BOUNDARY_TYPES,
    });
    if (!type) return;

    const answers = await askTextQuestions(interaction, [
      'What is the boundary?',
      'Why does it matter?',
      'What is okay?',
      'What is not okay?',
      'How should we handle mistakes or misunderstandings?',
      'Any notes or context?',
    ]);
    if (!answers) return;

    const archiveMessage = [
      '📜 Archived Boundary Version',
      `Archived on: ${formatDateTime(new Date(), config.timezone)}`,
      `Archived by: ${interaction.user.username}`,
      `Original message: ${oldBoundaryMessage.url}`,
      '',
      oldBoundaryMessage.content,
    ].join('\n');

    await historyThread.send({ content: archiveMessage, allowedMentions: { parse: [] } });

    const newBoundaryContent = formatBoundaryEntry({
      title: answers[0],
      category,
      status,
      type,
      addedBy: interaction.user.username,
      date: formatDateTime(new Date(), config.timezone),
      why: answers[1],
      okay: answers[2],
      notOkay: answers[3],
      handling: answers[4],
      notes: answers[5],
      originalDiscussion: `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}`,
    });

    const newMessage = await listThread.send({ content: newBoundaryContent, allowedMentions: { parse: [] } });

    try {
      await oldBoundaryMessage.delete();
    } catch (error) {
      console.warn('[boundaries] Could not delete old boundary message, marking as archived instead.');
      await oldBoundaryMessage.edit(
        `ARCHIVED / UPDATED\nReplaced by: ${newMessage.url}\n\n${oldBoundaryMessage.content}`,
      );
    }

    await interaction.followUp({ content: 'Boundary updated and old version archived 💛', ephemeral: true });
  } finally {
    activeFlows.delete(interaction.user.id);
  }
}

async function handleBoundaryRequest(interaction, config, activeFlows) {
  if (!isInBoundariesChannel(interaction, config)) {
    await onlyBoundariesReply(interaction);
    return;
  }

  if (activeFlows.has(interaction.user.id)) {
    await interaction.reply({
      content: 'You already have an active boundary flow. Finish it first or wait for timeout 💛',
      ephemeral: true,
    });
    return;
  }

  activeFlows.add(interaction.user.id);

  try {
    const channel = await getBoundariesChannel(interaction.client, config.boundariesChannelId);
    if (!channel) {
      await interaction.reply({ content: 'Boundaries channel not found. Check BOUNDARIES_CHANNEL_ID.', ephemeral: true });
      return;
    }

    const { listThread } = await ensureBoundariesThreads(channel);

    const category = await askChoice(interaction, {
      prompt: 'Choose category:',
      customId: 'boundary_request_category',
      values: BOUNDARY_CATEGORIES,
    });
    if (!category) return;

    const type = await askChoice(interaction, {
      prompt: 'Choose boundary type:',
      customId: 'boundary_request_type',
      values: BOUNDARY_TYPES,
    });
    if (!type) return;

    const status = await askChoice(interaction, {
      prompt: 'Choose status:',
      customId: 'boundary_request_status',
      values: ['🟡 Needs discussion', '🟢 Agreed'],
    });
    if (!status) return;

    const answers = await askTextQuestions(interaction, [
      'What situation makes you uncomfortable?',
      'What feeling does it trigger?',
      'What are you afraid this could mean?',
      'What would help you feel respected or safer?',
      'What possible middle ground could exist?',
      'Is there anything you want your partner to understand?',
    ]);
    if (!answers) return;

    const requestMessage = [
      '🟡 Boundary Request',
      `Category: ${category}`,
      `Type: ${type}`,
      `Status: ${status}`,
      `Requested by: ${interaction.user.username}`,
      `Date: ${formatDateTime(new Date(), config.timezone)}`,
      '',
      `Situation: ${toText(answers[0])}`,
      `Feeling triggered: ${toText(answers[1])}`,
      `Fear/meaning: ${toText(answers[2])}`,
      `What would help: ${toText(answers[3])}`,
      `Possible middle ground: ${toText(answers[4])}`,
      `Partner understanding: ${toText(answers[5])}`,
    ].join('\n');

    await interaction.channel.send({ content: requestMessage, allowedMentions: { parse: [] } });

    if (status === '🟢 Agreed') {
      const boundaryContent = formatBoundaryEntry({
        title: answers[0],
        category,
        status,
        type,
        addedBy: interaction.user.username,
        date: formatDateTime(new Date(), config.timezone),
        why: answers[1],
        okay: answers[3],
        notOkay: answers[2],
        handling: answers[4],
        notes: answers[5],
        originalDiscussion: `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}`,
      });

      await listThread.send({ content: boundaryContent, allowedMentions: { parse: [] } });
    }

    await interaction.followUp({
      content: status === '🟢 Agreed'
        ? 'Boundary request posted and added to the list 💛'
        : 'Boundary request posted for discussion 💛',
      ephemeral: true,
    });
  } finally {
    activeFlows.delete(interaction.user.id);
  }
}

async function handleReviewBoundaries(interaction, config) {
  if (!isInBoundariesChannel(interaction, config)) {
    await onlyBoundariesReply(interaction);
    return;
  }

  await interaction.reply({
    content: reviewPrompt(),
    allowedMentions: { parse: [] },
  });
}

function scheduleMonthlyReview(client, config) {
  const schedule = () => {
    const delay = millisUntilNextMonthlyReview(config.timezone);

    setTimeout(async () => {
      await postMonthlyReview(client, config);
      schedule();
    }, delay);
  };

  schedule();
}

async function postMonthlyReview(client, config) {
  try {
    const now = new Date();
    if (!isFirstSundayAtReviewTime(now, config.timezone)) {
      return;
    }

    const channel = await getBoundariesChannel(client, config.boundariesChannelId);
    if (!channel) {
      console.warn('[boundaries] Monthly review skipped: channel not found.');
      return;
    }

    await channel.send({ content: reviewPrompt(), allowedMentions: { parse: [] } });
  } catch (error) {
    console.error('[boundaries] Failed monthly review reminder:', error);
  }
}

async function ensureBoundariesThreads(channel) {
  const listThread = await getOrCreateThread(channel, LIST_THREAD_NAME, 'Active boundaries archive');
  const historyThread = await getOrCreateThread(channel, HISTORY_THREAD_NAME, 'Boundary update archive history');
  return { listThread, historyThread };
}

async function getOrCreateThread(channel, name, reason) {
  const active = await channel.threads.fetchActive();
  let thread = active.threads.find((candidate) => candidate.name === name);
  if (thread) {
    return thread;
  }

  const archived = await channel.threads.fetchArchived({ type: 'public', fetchAll: true });
  thread = archived.threads.find((candidate) => candidate.name === name);
  if (thread) {
    if (thread.archived) {
      await thread.setArchived(false, `Reopen ${name}`);
    }
    return thread;
  }

  return channel.threads.create({
    name,
    autoArchiveDuration: 10080,
    reason,
  });
}

async function getBoundariesChannel(client, channelId) {
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
    console.error('[boundaries] Could not fetch boundaries channel:', error);
    return null;
  }
}

function isInBoundariesChannel(interaction, config) {
  return interaction.channelId === config.boundariesChannelId;
}

async function onlyBoundariesReply(interaction) {
  await interaction.reply({
    content: 'This command is only for the Boundaries channel 💛',
    ephemeral: true,
  });
}

async function askChoice(interaction, options) {
  const { prompt, customId, values, prebuilt = false } = options;
  const choices = prebuilt
    ? values
    : values.map((value) => ({ label: truncate(value, 100), value }));

  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('Select one option')
    .addOptions(choices);

  const row = new ActionRowBuilder().addComponents(select);

  const promptMessage = await sendEphemeralPrompt(interaction, {
    content: prompt,
    components: [row],
  });

  try {
    const selection = await promptMessage.awaitMessageComponent({
      filter: (componentInteraction) => componentInteraction.user.id === interaction.user.id,
      time: 120000,
    });

    const value = selection.values[0];
    await selection.update({ content: `${prompt}\nSelected: **${truncate(value, 150)}**`, components: [] });
    return value;
  } catch {
    await sendEphemeralPrompt(interaction, {
      content: 'Boundary flow timed out. You can start again anytime 💛',
    });
    return null;
  }
}

async function askTextQuestions(interaction, questions) {
  const answers = [];

  for (const question of questions) {
    await sendEphemeralPrompt(interaction, { content: question });

    let collected;
    try {
      collected = await interaction.channel.awaitMessages({
        filter: (message) => message.author.id === interaction.user.id && !message.author.bot,
        max: 1,
        time: 5 * 60 * 1000,
        errors: ['time'],
      });
    } catch {
      await sendEphemeralPrompt(interaction, {
        content: 'Boundary flow timed out. You can start again anytime 💛',
      });
      return null;
    }

    answers.push(collected.first()?.content || '');
  }

  return answers;
}

function formatBoundaryEntry(entry) {
  return [
    `🧭 Boundary: ${toText(entry.title)}`,
    `Category: ${toText(entry.category)}`,
    `Status: ${toText(entry.status)}`,
    `Type: ${toText(entry.type)}`,
    `Added by: ${toText(entry.addedBy)}`,
    `Added on: ${toText(entry.date)}`,
    '',
    'Why it matters:',
    toText(entry.why),
    '',
    'What is okay:',
    toText(entry.okay),
    '',
    'What is not okay:',
    toText(entry.notOkay),
    '',
    'Handling mistakes/misunderstandings:',
    toText(entry.handling),
    '',
    'Notes/context:',
    toText(entry.notes),
    '',
    `Original discussion: ${toText(entry.originalDiscussion)}`,
  ].join('\n');
}

function isBoundaryEntry(content) {
  return typeof content === 'string' && content.startsWith('🧭 Boundary:');
}

function extractBoundaryTitle(content) {
  const line = content.split('\n').find((candidate) => candidate.startsWith('🧭 Boundary:'));
  if (!line) {
    return '';
  }
  return line.replace('🧭 Boundary:', '').trim();
}

async function fetchChannelMessages(channel, max = 500) {
  const messages = [];
  let before;

  while (messages.length < max) {
    const limit = Math.min(100, max - messages.length);
    const fetched = await channel.messages.fetch({ limit, before });
    if (!fetched.size) {
      break;
    }

    messages.push(...fetched.values());
    before = fetched.last().id;
  }

  return messages;
}

function reviewPrompt() {
  return [
    '💛 Boundary Review',
    '',
    'Do any boundaries need:',
    '- clarification',
    '- softening',
    '- strengthening',
    '- removal',
    '- better wording?',
    '',
    'Use:',
    '/boundarylist to view current boundaries',
    '/updateboundary to revise one',
    '/boundaryrequest to propose something new',
  ].join('\n');
}

function millisUntilNextMonthlyReview(timezone) {
  const now = new Date();

  for (let days = 0; days <= 62; days += 1) {
    const candidate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    }).formatToParts(candidate);

    const day = Number(parts.find((p) => p.type === 'day')?.value || '1');
    const weekday = parts.find((p) => p.type === 'weekday')?.value;
    if (weekday !== 'Sun' || day > 7) {
      continue;
    }

    const year = Number(parts.find((p) => p.type === 'year')?.value || '2000');
    const month = Number(parts.find((p) => p.type === 'month')?.value || '1');
    const target = zonedTimeToUtc({ year, month, day, hour: 21, minute: 0, second: 0 }, timezone);

    if (target.getTime() > now.getTime()) {
      return target.getTime() - now.getTime();
    }
  }

  return 60 * 1000;
}

function isFirstSundayAtReviewTime(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const day = Number(parts.find((p) => p.type === 'day')?.value || '1');
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || '0');

  return weekday === 'Sun' && day <= 7 && hour === 21 && minute === 0;
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

  const local = dtf.formatToParts(utcGuess);
  const actual = {
    year: Number(local.find((p) => p.type === 'year')?.value),
    month: Number(local.find((p) => p.type === 'month')?.value),
    day: Number(local.find((p) => p.type === 'day')?.value),
    hour: Number(local.find((p) => p.type === 'hour')?.value),
    minute: Number(local.find((p) => p.type === 'minute')?.value),
    second: Number(local.find((p) => p.type === 'second')?.value),
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

function truncate(value, maxLength) {
  if (!value) {
    return '';
  }
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function toText(value) {
  const trimmed = `${value || ''}`.trim();
  return trimmed.length > 0 ? trimmed : '—';
}

async function safeReply(interaction, payload) {
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
    return;
  }

  await interaction.reply(payload);
}

async function sendEphemeralPrompt(interaction, payload) {
  const fullPayload = { ...payload, ephemeral: true, fetchReply: true };
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(fullPayload);
  }
  return interaction.reply(fullPayload);
}

module.exports = {
  setupBoundaries,
};
