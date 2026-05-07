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

const ARCHIVE_THREAD_NAME = 'Love Actions Archive';

const ACTION_CATEGORIES = [
  '💛 Reassurance',
  '🫂 Comfort',
  '🛡 Safety',
  '👂 Acknowledgment',
  '🤝 Connection',
  '😂 Lighten the mood',
];

const MODE_OPTIONS = ['Together', 'Distance', 'Both'];

const ADD_ACTION_COMMAND = new SlashCommandBuilder().setName('addaction').setDescription('Add a private love action for your partner');
const ACTION_COMMAND = new SlashCommandBuilder().setName('action').setDescription('Get one love action written by your partner');
const ACTION_DONE_COMMAND = new SlashCommandBuilder().setName('actiondone').setDescription('Mark a love action as completed');
const RETIRE_ACTION_COMMAND = new SlashCommandBuilder().setName('retireaction').setDescription('Retire one of your own love actions');
const MY_ACTIONS_COMMAND = new SlashCommandBuilder().setName('myactions').setDescription('View your own saved love actions');

function setupLoveActions(client) {
  const config = {
    clientId: process.env.CLIENT_ID,
    guildId: process.env.GUILD_ID,
    channelId: process.env.LOVE_ACTIONS_CHANNEL_ID,
    partner1Id: process.env.PARTNER_1_USER_ID,
    partner1Name: process.env.PARTNER_1_NAME || 'Partner 1',
    partner2Id: process.env.PARTNER_2_USER_ID,
    partner2Name: process.env.PARTNER_2_NAME || 'Partner 2',
  };

  const required = [
    'CLIENT_ID',
    'GUILD_ID',
    'LOVE_ACTIONS_CHANNEL_ID',
    'PARTNER_1_USER_ID',
    'PARTNER_2_USER_ID',
  ];
  const missing = required.filter((key) => !process.env[key]);
  const isConfigured = missing.length === 0;

  if (!isConfigured) {
    console.error(
      `[love-actions] Missing required environment variables: ${missing.join(', ')}. Love Actions automation is disabled until these are set.`,
    );
  }

  const activeFlows = new Set();

  client.once(Events.ClientReady, async () => {
    if (!isConfigured) {
      console.warn('[love-actions] Skipping setup because required env vars are missing.');
      return;
    }

    await registerCommands(config);
    const channel = await getLoveActionsChannel(client, config.channelId);
    if (channel) {
      await ensureArchiveThread(channel);
    }

    console.log('[love-actions] Ready.');
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!isConfigured || !interaction.isChatInputCommand()) {
      return;
    }

    try {
      if (interaction.commandName === 'addaction') {
        await handleAddAction(interaction, config, activeFlows);
      }

      if (interaction.commandName === 'action') {
        await handleGetAction(interaction, config, activeFlows);
      }

      if (interaction.commandName === 'actiondone') {
        await handleActionDone(interaction, config);
      }

      if (interaction.commandName === 'retireaction') {
        await handleRetireAction(interaction, config, activeFlows);
      }

      if (interaction.commandName === 'myactions') {
        await handleMyActions(interaction, config);
      }
    } catch (error) {
      console.error('[love-actions] Interaction error:', error);
      await safeReply(interaction, {
        content: 'Something went wrong. Please try again in a moment.',
        flags: MessageFlags.Ephemeral,
      });
    }
  });
}

async function registerCommands(config) {
  if (!process.env.DISCORD_TOKEN || !config.clientId || !config.guildId) {
    console.warn('[love-actions] Skipping command registration due to missing token/client/guild env vars.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const route = Routes.applicationGuildCommands(config.clientId, config.guildId);

  try {
    const existing = await rest.get(route);
    const incoming = [
      ADD_ACTION_COMMAND.toJSON(),
      ACTION_COMMAND.toJSON(),
      ACTION_DONE_COMMAND.toJSON(),
      RETIRE_ACTION_COMMAND.toJSON(),
      MY_ACTIONS_COMMAND.toJSON(),
    ];
    const incomingNames = new Set(incoming.map((command) => command.name));
    const merged = [...existing.filter((command) => !incomingNames.has(command.name)), ...incoming];

    await rest.put(route, { body: merged });
    console.log('[love-actions] Slash commands registered.');
  } catch (error) {
    console.error('[love-actions] Failed to register slash commands:', error);
  }
}

async function handleAddAction(interaction, config, activeFlows) {
  if (!validateChannel(interaction, config)) {
    await onlyLoveActionsReply(interaction);
    return;
  }

  if (!isPartner(interaction.user.id, config)) {
    await interaction.reply({
      content: 'This system is only for the two partners 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (activeFlows.has(interaction.user.id)) {
    await interaction.reply({
      content: 'You already have an active love action flow. Finish it first 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  activeFlows.add(interaction.user.id);

  try {
    const channel = await getLoveActionsChannel(interaction.client, config.channelId);
    if (!channel) {
      await interaction.reply({
        content: 'Love Actions channel not found. Check LOVE_ACTIONS_CHANNEL_ID.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const archiveThread = await ensureArchiveThread(channel);

    const mode = await askChoice(interaction, {
      prompt: 'Is this action for:',
      customId: 'love_action_mode',
      values: MODE_OPTIONS,
    });
    if (!mode) return;

    const category = await askChoice(interaction, {
      prompt: 'What emotional need does this help with?',
      customId: 'love_action_category',
      values: ACTION_CATEGORIES,
    });
    if (!category) return;

    await sendEphemeralPrompt(interaction, {
      content: 'What would you like your partner to do or say? 💛',
    });

    const actionMessage = await waitForNextUserMessage(interaction.channel, interaction.user.id);
    if (!actionMessage) {
      await sendEphemeralPrompt(interaction, { content: 'Love action flow timed out 💛' });
      return;
    }

    const entry = [
      '💛 Love Action',
      `Mode: ${mode}`,
      `Category: ${category}`,
      `Author ID: ${interaction.user.id}`,
      `Date: ${formatDate(new Date())}`,
      '',
      fitText(actionMessage.content, 1500),
    ].join('\n');

    await archiveThread.send({ content: entry, allowedMentions: { parse: [] } });

    try {
      await actionMessage.delete();
    } catch {
      // ignore permission errors
    }

    await interaction.followUp({ content: 'Love action added 💛', flags: MessageFlags.Ephemeral });
  } finally {
    activeFlows.delete(interaction.user.id);
  }
}

async function handleGetAction(interaction, config, activeFlows) {
  if (!validateChannel(interaction, config)) {
    await onlyLoveActionsReply(interaction);
    return;
  }

  if (!isPartner(interaction.user.id, config)) {
    await interaction.reply({ content: 'This system is only for the two partners 💛', flags: MessageFlags.Ephemeral });
    return;
  }

  if (activeFlows.has(interaction.user.id)) {
    await interaction.reply({ content: 'You already have an active love action flow. Finish it first 💛', flags: MessageFlags.Ephemeral });
    return;
  }

  activeFlows.add(interaction.user.id);

  try {
    const channel = await getLoveActionsChannel(interaction.client, config.channelId);
    if (!channel) {
      await interaction.reply({ content: 'Love Actions channel not found. Check LOVE_ACTIONS_CHANNEL_ID.', flags: MessageFlags.Ephemeral });
      return;
    }

    const archiveThread = await ensureArchiveThread(channel);

    const situation = await askChoice(interaction, {
      prompt: 'What situation are you in?',
      customId: 'love_action_situation',
      values: ['Together', 'Distance'],
    });
    if (!situation) return;

    const need = await askChoice(interaction, {
      prompt: 'What feels most needed right now?',
      customId: 'love_action_need',
      values: [...ACTION_CATEGORIES, '🎲 Random'],
    });
    if (!need) return;

    const actions = await fetchParsedActions(archiveThread);
    const partnerId = otherPartnerId(interaction.user.id, config);

    const eligible = actions.filter((action) => {
      if (action.authorId !== partnerId) {
        return false;
      }

      const modeMatches = action.mode === 'Both' || action.mode === situation;
      if (!modeMatches) {
        return false;
      }

      if (need === '🎲 Random') {
        return true;
      }

      return action.category === need;
    });

    if (eligible.length === 0) {
      await interaction.followUp({
        content: 'I could not find a matching love action right now. Ask your partner to add more 💛',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const picked = eligible[Math.floor(Math.random() * eligible.length)];
    const titleCategory = need === '🎲 Random' ? picked.category.replace(/^\S+\s*/, '') : need.replace(/^\S+\s*/, '');

    await interaction.followUp({
      content: `💛 Love Action — ${titleCategory}\n\n${picked.text} 💛`,
      flags: MessageFlags.Ephemeral,
    });
  } finally {
    activeFlows.delete(interaction.user.id);
  }
}

async function handleActionDone(interaction, config) {
  if (!validateChannel(interaction, config)) {
    await onlyLoveActionsReply(interaction);
    return;
  }

  await interaction.reply({ content: '💛 Small acts of love matter.', flags: MessageFlags.Ephemeral });
}

async function handleRetireAction(interaction, config, activeFlows) {
  if (!validateChannel(interaction, config)) {
    await onlyLoveActionsReply(interaction);
    return;
  }

  if (!isPartner(interaction.user.id, config)) {
    await interaction.reply({ content: 'This system is only for the two partners 💛', flags: MessageFlags.Ephemeral });
    return;
  }

  if (activeFlows.has(interaction.user.id)) {
    await interaction.reply({ content: 'You already have an active love action flow. Finish it first 💛', flags: MessageFlags.Ephemeral });
    return;
  }

  activeFlows.add(interaction.user.id);

  try {
    const channel = await getLoveActionsChannel(interaction.client, config.channelId);
    if (!channel) {
      await interaction.reply({ content: 'Love Actions channel not found. Check LOVE_ACTIONS_CHANNEL_ID.', flags: MessageFlags.Ephemeral });
      return;
    }

    const archiveThread = await ensureArchiveThread(channel);
    const actions = await fetchParsedActions(archiveThread);
    const mine = actions.filter((action) => action.authorId === interaction.user.id);

    if (mine.length === 0) {
      await interaction.reply({ content: 'You have no saved love actions yet 💛', flags: MessageFlags.Ephemeral });
      return;
    }

    const options = mine.slice(0, 25).map((action, index) => ({
      label: truncate(`${action.category} | ${action.mode}`, 100),
      description: truncate(action.text, 100),
      value: action.messageId || `${index}`,
    }));

    const selectedId = await askChoice(interaction, {
      prompt: 'Choose one action to retire:',
      customId: 'love_action_retire_pick',
      values: options,
      prebuilt: true,
    });
    if (!selectedId) return;

    const selected = mine.find((action) => action.messageId === selectedId);
    if (!selected) {
      await interaction.followUp({ content: 'Could not find that action anymore. Try again 💛', flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      const msg = await archiveThread.messages.fetch(selected.messageId);
      await msg.delete();
    } catch {
      await interaction.followUp({
        content: 'I could not retire that action due to permissions or missing message.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.followUp({ content: 'Love action retired 💛', flags: MessageFlags.Ephemeral });
  } finally {
    activeFlows.delete(interaction.user.id);
  }
}

async function handleMyActions(interaction, config) {
  if (!validateChannel(interaction, config)) {
    await onlyLoveActionsReply(interaction);
    return;
  }

  if (!isPartner(interaction.user.id, config)) {
    await interaction.reply({ content: 'This system is only for the two partners 💛', flags: MessageFlags.Ephemeral });
    return;
  }

  const channel = await getLoveActionsChannel(interaction.client, config.channelId);
  if (!channel) {
    await interaction.reply({ content: 'Love Actions channel not found. Check LOVE_ACTIONS_CHANNEL_ID.', flags: MessageFlags.Ephemeral });
    return;
  }

  const archiveThread = await ensureArchiveThread(channel);
  const actions = await fetchParsedActions(archiveThread);
  const mine = actions
    .filter((action) => action.authorId === interaction.user.id)
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

  if (mine.length === 0) {
    await interaction.reply({ content: 'You have no saved love actions yet 💛', flags: MessageFlags.Ephemeral });
    return;
  }

  const lines = mine.slice(0, 20).map((action, index) => {
    return [
      `**${index + 1}. ${action.category}**`,
      `Mode: ${action.mode}`,
      `Date: ${action.date || 'Unknown'}`,
      `${action.text}`,
    ].join('\n');
  });

  await interaction.reply({
    content: [`## My Love Actions`, `Showing latest ${lines.length} of ${mine.length}`, '', lines.join('\n\n')].join('\n'),
    flags: MessageFlags.Ephemeral,
  });
}

async function fetchParsedActions(thread) {
  const messages = await fetchChannelMessages(thread, 500);
  return messages
    .map((message) => parseActionMessage(message))
    .filter(Boolean);
}

function parseActionMessage(message) {
  const content = `${message.content || ''}`;
  if (!content.startsWith('💛 Love Action')) {
    return null;
  }

  const mode = extractField(content, 'Mode');
  const category = extractField(content, 'Category');
  const authorId = extractField(content, 'Author ID');
  const date = extractField(content, 'Date');

  const lines = content.split('\n');
  const blankIndex = lines.findIndex((line) => line.trim() === '');
  const text = blankIndex >= 0 ? lines.slice(blankIndex + 1).join('\n').trim() : '';

  if (!mode || !category || !authorId || !text) {
    return null;
  }

  return {
    mode,
    category,
    authorId,
    date,
    text,
    messageId: message.id,
    createdTimestamp: message.createdTimestamp,
  };
}

function extractField(content, key) {
  const regex = new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`, 'm');
  const match = content.match(regex);
  return match ? match[1].trim() : '';
}

async function ensureArchiveThread(channel) {
  const active = await channel.threads.fetchActive();
  let thread = active.threads.find((candidate) => candidate.name === ARCHIVE_THREAD_NAME);
  if (thread) {
    return thread;
  }

  const archived = await channel.threads.fetchArchived({ type: 'public', fetchAll: true });
  thread = archived.threads.find((candidate) => candidate.name === ARCHIVE_THREAD_NAME);
  if (thread) {
    if (thread.archived) {
      await thread.setArchived(false, 'Reopen love actions archive');
    }
    return thread;
  }

  return channel.threads.create({
    name: ARCHIVE_THREAD_NAME,
    autoArchiveDuration: 10080,
    reason: 'Store private love actions in channel-only archive messages',
  });
}

async function askChoice(interaction, options) {
  const { prompt, customId, values, prebuilt = false } = options;
  const optionList = prebuilt
    ? values
    : values.map((value) => ({ label: truncate(value, 100), value }));

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Select one option').addOptions(optionList),
  );

  const promptMessage = await sendEphemeralPrompt(interaction, {
    content: prompt,
    components: [row],
  });

  try {
    const selected = await promptMessage.awaitMessageComponent({
      filter: (componentInteraction) => componentInteraction.user.id === interaction.user.id,
      time: 180000,
    });

    const value = selected.values[0];
    await selected.update({ content: `${prompt}\nSelected: **${truncate(value, 150)}**`, components: [] });
    return value;
  } catch {
    await sendEphemeralPrompt(interaction, { content: 'Love action flow timed out 💛' });
    return null;
  }
}

async function waitForNextUserMessage(channel, userId) {
  try {
    const collected = await channel.awaitMessages({
      filter: (message) => message.author.id === userId && !message.author.bot,
      max: 1,
      time: 5 * 60 * 1000,
      errors: ['time'],
    });

    return collected.first() || null;
  } catch {
    return null;
  }
}

function validateChannel(interaction, config) {
  return interaction.channelId === config.channelId;
}

async function onlyLoveActionsReply(interaction) {
  await interaction.reply({ content: 'This command is only for the Love Actions channel 💛', flags: MessageFlags.Ephemeral });
}

function isPartner(userId, config) {
  return userId === config.partner1Id || userId === config.partner2Id;
}

function otherPartnerId(userId, config) {
  if (userId === config.partner1Id) {
    return config.partner2Id;
  }
  if (userId === config.partner2Id) {
    return config.partner1Id;
  }
  return null;
}

async function getLoveActionsChannel(client, channelId) {
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
    console.error('[love-actions] Could not fetch Love Actions channel:', error);
    return null;
  }
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

function fitText(value, maxLength) {
  const text = `${value || ''}`.trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 14)}...[trimmed]`;
}

function truncate(value, maxLength) {
  const text = `${value || ''}`;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function formatDate(date) {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function escapeRegExp(value) {
  return `${value || ''}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function sendEphemeralPrompt(interaction, payload) {
  const fullPayload = { ...payload, flags: MessageFlags.Ephemeral };
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(fullPayload);
  }

  await interaction.reply(fullPayload);
  return interaction.fetchReply();
}

async function safeReply(interaction, payload) {
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
    return;
  }

  await interaction.reply(payload);
}

module.exports = {
  setupLoveActions,
};
