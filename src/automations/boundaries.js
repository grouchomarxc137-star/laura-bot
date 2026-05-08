const {
  ActionRowBuilder,
  ChannelType,
  Events,
  MessageFlags,
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
const MAX_TIMEOUT_MS = 2_147_483_647;

const ADD_BOUNDARY_COMMAND = new SlashCommandBuilder()
  .setName('addboundary')
  .setDescription('Add a new boundary to the boundaries list');

const BOUNDARY_LIST_COMMAND = new SlashCommandBuilder()
  .setName('boundarylist')
  .setDescription('View boundaries by category');

const UPDATE_BOUNDARY_COMMAND = new SlashCommandBuilder()
  .setName('updateboundary')
  .setDescription('Update an existing boundary and archive the old version');


function setupBoundaries(client) {
  const config = {
    clientId: process.env.CLIENT_ID,
    guildId: process.env.GUILD_ID,
    boundariesChannelId: process.env.BOUNDARIES_CHANNEL_ID,
    timezone: process.env.TIMEZONE || 'Europe/Rome',
    messageContentEnabled: process.env.ENABLE_MESSAGE_CONTENT_INTENT === 'true',
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

    console.log('[boundaries] Ready.');
    if (!config.messageContentEnabled) {
      console.warn(
        '[boundaries] ENABLE_MESSAGE_CONTENT_INTENT is not true. Guided text answers may be empty. Enable Message Content Intent for boundaries flows.',
      );
    }
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

    } catch (error) {
      console.error('[boundaries] Interaction error:', error);
      await safeReply(interaction, {
        content: 'Something went wrong. Please try again in a moment.',
        flags: MessageFlags.Ephemeral,
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
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  activeFlows.add(interaction.user.id);

  try {
    const channel = await getBoundariesChannel(interaction.client, config.boundariesChannelId);
    if (!channel) {
      await interaction.reply({ content: 'Boundaries channel not found. Check BOUNDARIES_CHANNEL_ID.', flags: MessageFlags.Ephemeral });
      return;
    }

    const { listThread } = await ensureBoundariesThreads(channel);

    const category = await askChoice(interaction, {
      prompt: 'Choose a category:',
      customId: 'boundary_add_category',
      values: BOUNDARY_CATEGORIES,
      timeoutMs: null,
    });
    if (!category) return;

    const status = await askChoice(interaction, {
      prompt: 'Choose status:',
      customId: 'boundary_add_status',
      values: BOUNDARY_STATUSES,
      timeoutMs: null,
    });
    if (!status) return;

    const type = await askChoice(interaction, {
      prompt: 'Choose type:',
      customId: 'boundary_add_type',
      values: BOUNDARY_TYPES,
      timeoutMs: null,
    });
    if (!type) return;

    const collected = await askTextQuestions(interaction, config, [
      'What is the boundary?',
      'Why does it matter?',
      'What is okay?',
      'What is not okay?',
      'How should we handle mistakes or misunderstandings?',
      'Any notes or context?',
    ], null);
    if (!collected) return;
    const { answers, messages: responseMessages } = collected;

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
    const cleanupResult = await cleanupCapturedMessages(responseMessages);
    await interaction.followUp({ content: 'Boundary added to the list 💛', flags: MessageFlags.Ephemeral });
    if (!cleanupResult.ok) {
      await interaction.followUp({
        content:
          'I saved the boundary, but I could not remove some answer messages. Check that I have permission to manage messages in this channel.',
        flags: MessageFlags.Ephemeral,
      });
    }
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
    await interaction.reply({ content: 'Boundaries channel not found. Check BOUNDARIES_CHANNEL_ID.', flags: MessageFlags.Ephemeral });
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
    await interaction.followUp({ content: 'Nothing found for this category yet 💛', flags: MessageFlags.Ephemeral });
    return;
  }

  const lines = filtered.slice(-20).map((message, index) => {
    const title = extractBoundaryTitle(message.content) || 'Untitled';
    const category = extractLineValue(message.content, 'Category') || 'Unknown';
    const status = extractLineValue(message.content, 'Status') || 'Unknown';
    const type = extractLineValue(message.content, 'Type') || 'Unknown';

    return [
      `**${index + 1}. 🧭 ${title}**`,
      `Category: ${category} | Status: ${status} | Type: ${type}`,
    ].join('\n');
  });

  await interaction.followUp({
    content: [
      `## Boundary List`,
      `Filter: **${selected}**`,
      `Showing latest ${Math.min(filtered.length, 20)} of ${filtered.length}`,
      '',
      lines.join('\n\n'),
    ].join('\n'),
    flags: MessageFlags.Ephemeral,
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
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  activeFlows.add(interaction.user.id);

  try {
    const channel = await getBoundariesChannel(interaction.client, config.boundariesChannelId);
    if (!channel) {
      await interaction.reply({ content: 'Boundaries channel not found. Check BOUNDARIES_CHANNEL_ID.', flags: MessageFlags.Ephemeral });
      return;
    }

    const { listThread, historyThread } = await ensureBoundariesThreads(channel);
    const messages = await fetchChannelMessages(listThread, 500);
    const boundaries = messages
      .filter((message) => isBoundaryEntry(message.content) && !message.content.includes('ARCHIVED / UPDATED'))
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

    if (boundaries.length === 0) {
      await interaction.reply({ content: 'No boundaries found to update yet 💛', flags: MessageFlags.Ephemeral });
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
      timeoutMs: null,
    });

    if (!selectedId) {
      return;
    }

    const oldBoundaryMessage = boundaries.find((message) => message.id === selectedId);
    if (!oldBoundaryMessage) {
      await interaction.followUp({ content: 'Could not find that boundary anymore. Try again 💛', flags: MessageFlags.Ephemeral });
      return;
    }

    const category = await askChoice(interaction, {
      prompt: 'Choose updated category:',
      customId: 'boundary_update_category',
      values: BOUNDARY_CATEGORIES,
      timeoutMs: null,
    });
    if (!category) return;

    const status = await askChoice(interaction, {
      prompt: 'Choose updated status:',
      customId: 'boundary_update_status',
      values: BOUNDARY_STATUSES,
      timeoutMs: null,
    });
    if (!status) return;

    const type = await askChoice(interaction, {
      prompt: 'Choose updated type:',
      customId: 'boundary_update_type',
      values: BOUNDARY_TYPES,
      timeoutMs: null,
    });
    if (!type) return;

    const collected = await askTextQuestions(interaction, config, [
      'What is the boundary?',
      'Why does it matter?',
      'What is okay?',
      'What is not okay?',
      'How should we handle mistakes or misunderstandings?',
      'Any notes or context?',
    ], null);
    if (!collected) return;
    const { answers, messages: responseMessages } = collected;

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
    const cleanupResult = await cleanupCapturedMessages(responseMessages);

    try {
      await oldBoundaryMessage.delete();
    } catch (error) {
      console.warn('[boundaries] Could not delete old boundary message, marking as archived instead.');
      await oldBoundaryMessage.edit(
        `ARCHIVED / UPDATED\nReplaced by: ${newMessage.url}\n\n${oldBoundaryMessage.content}`,
      );
    }

    await interaction.followUp({ content: 'Boundary updated and old version archived 💛', flags: MessageFlags.Ephemeral });
    if (!cleanupResult.ok) {
      await interaction.followUp({
        content:
          'I updated the boundary, but I could not remove some answer messages. Please give me `Manage Messages` permission in this channel.',
        flags: MessageFlags.Ephemeral,
      });
    }
  } finally {
    activeFlows.delete(interaction.user.id);
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
    flags: MessageFlags.Ephemeral,
  });
}

async function askChoice(interaction, options) {
  const { prompt, customId, values, prebuilt = false, timeoutMs = null } = options;
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
    const collectorOptions = {
      filter: (componentInteraction) => componentInteraction.user.id === interaction.user.id,
    };
    if (typeof timeoutMs === 'number') {
      collectorOptions.time = timeoutMs;
    }

    const selection = await promptMessage.awaitMessageComponent(collectorOptions);

    const value = selection.values[0];
    await selection.update({ content: `${prompt}\nSelected: **${truncate(value, 150)}**`, components: [] });
    return value;
  } catch {
    return null;
  }
}

async function askTextQuestions(interaction, config, questions, timeoutMs = null) {
  if (!config.messageContentEnabled) {
    await sendEphemeralPrompt(interaction, {
      content:
        'I need Message Content Intent enabled to read your text answers. Set `ENABLE_MESSAGE_CONTENT_INTENT=true` and enable it in Discord Developer Portal.',
    });
    return null;
  }

  const answers = [];
  const messages = [];

  for (const question of questions) {
    await sendEphemeralPrompt(interaction, { content: question });

    let collected;
    try {
      const collectorOptions = {
        filter: (message) => message.author.id === interaction.user.id && !message.author.bot,
        max: 1,
      };
      if (typeof timeoutMs === 'number') {
        collectorOptions.time = timeoutMs;
        collectorOptions.errors = ['time'];
      }

      collected = await interaction.channel.awaitMessages(collectorOptions);
    } catch {
      return null;
    }

    const responseMessage = collected.first();
    answers.push(responseMessage?.content || '');
    messages.push(responseMessage);
  }

  return { answers, messages };
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
  const fullPayload = { ...payload, flags: MessageFlags.Ephemeral };
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(fullPayload);
  }
  await interaction.reply(fullPayload);
  return interaction.fetchReply();
}

async function cleanupCapturedMessages(messages) {
  let failed = 0;

  for (const message of messages) {
    if (!message) {
      continue;
    }

    try {
      await message.delete();
    } catch {
      failed += 1;
    }
  }

  return { ok: failed === 0, failed };
}

function scheduleLongTimeout(callback, totalDelayMs) {
  const safeDelay = Math.max(0, Number(totalDelayMs) || 0);
  if (safeDelay <= MAX_TIMEOUT_MS) {
    setTimeout(callback, safeDelay);
    return;
  }

  setTimeout(() => {
    scheduleLongTimeout(callback, safeDelay - MAX_TIMEOUT_MS);
  }, MAX_TIMEOUT_MS);
}

function extractLineValue(content, label) {
  const line = content
    .split('\n')
    .find((candidate) => candidate.toLowerCase().startsWith(`${label.toLowerCase()}:`));
  if (!line) {
    return '';
  }
  return line.slice(label.length + 1).trim();
}


module.exports = {
  setupBoundaries,
};
