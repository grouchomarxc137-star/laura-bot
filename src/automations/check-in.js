const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');
const {
  postRelationshipPlantUpdate,
  getPlantScore,
  setPlantScore,
  relationshipStateFromScore,
} = require('./relationship-plant');

const START_CHECKIN_COMMAND = new SlashCommandBuilder().setName('startcheckin').setDescription('Post today\'s daily check-in panel');
const TEST_SECOND_CHECKIN_COMMAND = new SlashCommandBuilder()
  .setName('testsecondcheckin')
  .setDescription('Test check-in as partner 2');
const CANCEL_CHECKIN_COMMAND = new SlashCommandBuilder()
  .setName('cancelcheckin')
  .setDescription('Cancel all active daily check-in sessions');
const SET_PLANT_SCORE_COMMAND = new SlashCommandBuilder()
  .setName('setplantscore')
  .setDescription('Set the hidden plant score (0-100)')
  .addIntegerOption((option) =>
    option
      .setName('value')
      .setDescription('Desired score value (0-100)')
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(100),
  );
const PLANT_SCORE_COMMAND = new SlashCommandBuilder()
  .setName('plantscore')
  .setDescription('Show the hidden plant score');

const MAX_TIMEOUT_MS = 2_147_483_647;
const CUSTOM_CHOICE_VALUE = '__custom__';

const MOOD_OPTIONS = [
  { label: '😊 Good', value: '😊 Good' },
  { label: '😌 Calm', value: '😌 Calm' },
  { label: '😴 Tired', value: '😴 Tired' },
  { label: '😕 Off / weird', value: '😕 Off / weird' },
  { label: '😰 Anxious', value: '😰 Anxious' },
  { label: '😔 Sad', value: '😔 Sad' },
  { label: '😡 Irritated', value: '😡 Irritated' },
  { label: '💔 Overwhelmed', value: '💔 Overwhelmed' },
  { label: '✍️ Write your own', value: CUSTOM_CHOICE_VALUE },
];

const SUPPORT_OPTIONS = [
  { label: '🫂 Comfort', value: '🫂 Comfort' },
  { label: '💗 Affection', value: '💗 Affection' },
  { label: '💞 Reassurance', value: '💞 Reassurance' },
  { label: '🧠 Perspective', value: '🧠 Perspective' },
  { label: '🛠 Help / solutions', value: '🛠 Help / solutions' },
  { label: '🌫 Just expressing', value: '🌫 Just expressing' },
  { label: '⏳ Space / time', value: '⏳ Space / time' },
  { label: '❌ Skip support preference', value: '❌ Skip support preference' },
  { label: '✍️ Write your own', value: CUSTOM_CHOICE_VALUE },
];

const PLANT_STATE_OPTIONS = [
  { label: '🥀 1 → Wilted', value: 'Wilted' },
  { label: '🍂 2 → Neglected', value: 'Neglected' },
  { label: '🌿 3 → Stable', value: 'Stable' },
  { label: '☀️ 4 → Watered & Sunned', value: 'Watered & Sunned' },
  { label: '🌼 5 → Thriving', value: 'Thriving' },
];

const SUPPORT_IDEA_BY_PREF = {
  '🫂 Comfort': 'Ask softly: “What would feel comforting right now?”',
  '💗 Affection': 'Offer gentle affection: a hug, a hand squeeze, or soft closeness.',
  '💞 Reassurance': 'Offer reassurance without forcing a big discussion.',
  '🧠 Perspective': 'Ask first: “Do you want my honest perspective?”',
  '🛠 Help / solutions': 'Offer practical help or ask: “What can I help solve?”',
  '🌫 Just expressing': 'No fixing needed. Just make them feel heard.',
  '⏳ Space / time': 'Respect space while reassuring them you\'re still there.',
  '❌ Skip support preference': 'No support preference selected. A gentle check-in is enough.',
};

function setupCheckIn(client) {
  const activeFlowControls = new Map();

  const config = {
    clientId: process.env.CLIENT_ID,
    guildId: process.env.GUILD_ID,
    channelId: process.env.CHECKIN_CHANNEL_ID,
    partner1Id: process.env.PARTNER_1_USER_ID,
    partner1Name: process.env.PARTNER_1_NAME || 'Partner 1',
    partner2Id: process.env.PARTNER_2_USER_ID,
    partner2Name: process.env.PARTNER_2_NAME || 'Partner 2',
    timezone: process.env.TIMEZONE || 'Europe/Rome',
    hour: toSafeNumber(process.env.DAILY_CHECKIN_HOUR, 21),
    minute: toSafeNumber(process.env.DAILY_CHECKIN_MINUTE, 0),
    relationshipChannelId: process.env.RELATIONSHIP_CHANNEL_ID || '1503325092946382868',
    relationshipChannelName: process.env.RELATIONSHIP_CHANNEL_NAME || 'our-plant',
    plantThreadName: process.env.RELATIONSHIP_PLANT_THREAD_NAME || 'Caring for our plant🪴💛',
  };

  const required = ['CLIENT_ID', 'GUILD_ID', 'CHECKIN_CHANNEL_ID', 'PARTNER_1_USER_ID', 'PARTNER_2_USER_ID'];
  const missing = required.filter((key) => !process.env[key]);
  const isConfigured = missing.length === 0;

  if (!isConfigured) {
    console.error(
      `[check-in] Missing required environment variables: ${missing.join(', ')}. Check-in automation is disabled until these are set.`,
    );
  }

  client.once(Events.ClientReady, async () => {
    if (!isConfigured) {
      console.warn('[check-in] Skipping setup because required env vars are missing.');
      return;
    }

    await registerCheckInCommands(config);
    scheduleDailyCheckIn(client, config);

    console.log(
      `[check-in] Ready | channel=${config.channelId} daily=${String(config.hour).padStart(2, '0')}:${String(config.minute).padStart(2, '0')} timezone=${config.timezone}`,
    );
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!isConfigured) {
      return;
    }

    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'startcheckin') {
          await handleStartCheckInCommand(interaction, config);
          return;
        }

        if (interaction.commandName === 'testsecondcheckin') {
          await handleTestSecondCheckInCommand(interaction, config, activeFlowControls);
          return;
        }

        if (interaction.commandName === 'cancelcheckin') {
          await handleCancelAllCheckInCommand(interaction, activeFlowControls);
          return;
        }

        if (interaction.commandName === 'setplantscore') {
          await handleSetPlantScoreCommand(interaction);
          return;
        }
        if (interaction.commandName === 'plantscore') {
          await handlePlantScoreCommand(interaction);
          return;
        }

      }

      if (interaction.isButton() && (interaction.customId === 'checkin_do' || interaction.customId === 'checkin_archive')) {
        await handleCheckInButton(interaction, config, activeFlowControls);
      }
    } catch (error) {
      console.error('[check-in] Interaction error:', error);
      await safeReply(interaction, {
        content: 'Something went wrong. Please try again in a moment.',
        flags: MessageFlags.Ephemeral,
      });
    }
  });
}

async function registerCheckInCommands(config) {
  if (!process.env.DISCORD_TOKEN || !config.clientId || !config.guildId) {
    console.warn('[check-in] Skipping command registration due to missing token/client/guild env vars.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const route = Routes.applicationGuildCommands(config.clientId, config.guildId);

  try {
    const existing = await rest.get(route);
    const incoming = [
      START_CHECKIN_COMMAND.toJSON(),
      TEST_SECOND_CHECKIN_COMMAND.toJSON(),
      CANCEL_CHECKIN_COMMAND.toJSON(),
      SET_PLANT_SCORE_COMMAND.toJSON(),
      PLANT_SCORE_COMMAND.toJSON(),
    ];
    const incomingNames = new Set(incoming.map((command) => command.name));
    const legacyNames = new Set([
      'checkin',
      'checkinstatus',
      'mycheckin',
      'addboundary',
      'boundarylist',
      'updateboundary',
      'boundaryrequest',
      'reviewboundaries',
      'addaction',
      'action',
      'actiondone',
      'retireaction',
      'myactions',
      'resetplantscore',
    ]);
    const merged = [
      ...existing.filter((command) => !incomingNames.has(command.name) && !legacyNames.has(command.name)),
      ...incoming,
    ];

    await rest.put(route, { body: merged });
    console.log('[check-in] Slash commands registered: /startcheckin, /testsecondcheckin, /cancelcheckin, /setplantscore, /plantscore');
  } catch (error) {
    console.error('[check-in] Failed to register slash commands:', error);
  }
}

async function handleStartCheckInCommand(interaction, config) {
  if (interaction.channelId !== config.channelId) {
    await interaction.reply({
      content: 'This command is only for the check-in channel 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = await getCheckInChannel(interaction.client, config.channelId);
  if (!channel) {
    await interaction.reply({
      content: 'Check-in channel not found. Check CHECKIN_CHANNEL_ID.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const panel = await findTodayPanel(channel, config);
  if (panel) {
    await interaction.reply({
      content: 'Today\'s check-in panel already exists 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await postDailyPanel(channel, config);
  await interaction.reply({ content: 'Today\'s check-in panel posted 💛', flags: MessageFlags.Ephemeral });
}

async function handleMyCheckInCommand(interaction, config, activeFlowControls) {
  if (interaction.channelId !== config.channelId) {
    await interaction.reply({
      content: 'This command is only for the check-in channel 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = await getCheckInChannel(interaction.client, config.channelId);
  if (!channel) {
    await interaction.reply({
      content: 'Check-in channel not found. Check CHECKIN_CHANNEL_ID.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const panel = await findTodayPanel(channel, config);
  if (!panel) {
    await interaction.reply({
      content: 'No check-in panel found for today. Use /startcheckin first 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const partnerKey = partnerKeyByUserId(interaction.user.id, config);
  if (!partnerKey) {
    await interaction.reply({
      content: 'This check-in is only for Principe and Principessa 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const state = parsePanelState(panel.content, config);
  const currentRow = partnerKey === 'partner1' ? state.partner1Row : state.partner2Row;
  if (!isPendingRow(currentRow)) {
    await interaction.reply({
      content: `Your current check-in is: ${currentRow}\nUse the check-in button again only if you want to update it 💛`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await runCheckInFlow(interaction, panel, config, activeFlowControls);
}

async function handleTestSecondCheckInCommand(interaction, config, activeFlowControls) {
  if (interaction.channelId !== config.channelId) {
    await interaction.reply({
      content: 'This command is only for the check-in channel 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = await getCheckInChannel(interaction.client, config.channelId);
  if (!channel) {
    await interaction.reply({
      content: 'Check-in channel not found. Check CHECKIN_CHANNEL_ID.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let panel = await findTodayPanel(channel, config);
  if (!panel) {
    await postDailyPanel(channel, config);
    panel = await findTodayPanel(channel, config);
  }

  if (!panel) {
    await interaction.reply({
      content: 'Could not create or find today\'s check-in panel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const mood = await askSelect(interaction, {
    prompt: `Test as ${config.partner2Name}: choose mood`,
    customId: 'checkin_test_second_mood',
    options: MOOD_OPTIONS,
  }, activeFlowControls);
  if (!mood) {
    return;
  }

  const support = await askSelect(interaction, {
    prompt: `Test as ${config.partner2Name}: choose support`,
    customId: 'checkin_test_second_support',
    options: SUPPORT_OPTIONS,
  }, activeFlowControls);
  if (!support) {
    return;
  }

  const plantState = await askSelect(interaction, {
    prompt: `Test as ${config.partner2Name}: how does your plant feel today?`,
    customId: 'checkin_test_second_plant',
    options: PLANT_STATE_OPTIONS,
  }, activeFlowControls);
  if (!plantState) {
    return;
  }

  await updatePanelMessage(panel, config, 'partner2', mood, support, plantState);
  await sendEphemeralPrompt(interaction, {
    content: `Saved test check-in for ${config.partner2Name} 💛`,
  });
}

async function handleCheckInButton(interaction, config, activeFlowControls) {
  if (interaction.channelId !== config.channelId) {
    await interaction.reply({
      content: 'This check-in is only for Principe and Principessa 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const panelDate = extractPanelDate(interaction.message.content);
  const today = todayISO(config.timezone);
  if (panelDate && panelDate !== today) {
    await interaction.reply({
      content: 'This check-in panel is from another day. Use today\'s panel 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.customId === 'checkin_archive') {
    await handleArchiveCheckInButton(interaction, config);
    return;
  }

  await runCheckInFlow(interaction, interaction.message, config, activeFlowControls);
}

async function runCheckInFlow(interaction, panelMessage, config, activeFlowControls) {
  const partnerKey = partnerKeyByUserId(interaction.user.id, config);
  if (!partnerKey) {
    await safeReply(interaction, {
      content: 'This check-in is only for Principe and Principessa 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (activeFlowControls.has(interaction.user.id)) {
    await sendEphemeralPrompt(interaction, {
      content: 'You already have an active check-in flow. Finish it first, then start again 💛',
    });
    return;
  }

  const control = { cancelled: false, cancelWait: null };
  activeFlowControls.set(interaction.user.id, control);

  try {
    const result = await askMoodSupportAndPlant(interaction, partnerKey, activeFlowControls);
    if (!result) {
      return;
    }

    const { mood, support, plantState } = result;

    await updatePanelMessage(panelMessage, config, partnerKey, mood, support, plantState);

    await sendEphemeralPrompt(interaction, {
      content: 'Check-in saved 💛',
    });
  } finally {
    activeFlowControls.delete(interaction.user.id);
  }
}

async function askSelect(interaction, options, activeFlowControls) {
  const { prompt, customId, options: selectOptions } = options;
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Select one option').addOptions(selectOptions),
  );

  await sendEphemeralPrompt(interaction, {
    content: prompt,
    components: [row],
  });

  const selection = await waitForSelectInteractionAny(
    interaction.client,
    interaction.user.id,
    [customId],
    activeFlowControls,
  );
  if (!selection) {
    return null;
  }

  const value = await resolveSelectValue(interaction, selection, 'answer', activeFlowControls);
  if (!value) {
    return null;
  }

  await sendEphemeralPrompt(interaction, {
    content: `${prompt}\nSelected: **${value}**`,
  });
  return value;
}

async function askMoodSupportAndPlant(interaction, partnerKey, activeFlowControls) {
  const moodId = `checkin_mood_${partnerKey}`;
  const supportId = `checkin_support_${partnerKey}`;
  const plantId = `checkin_plant_${partnerKey}`;

  const moodRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(moodId).setPlaceholder('Mood').addOptions(MOOD_OPTIONS),
  );
  const supportRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(supportId).setPlaceholder('Support').addOptions(SUPPORT_OPTIONS),
  );
  const plantRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(plantId).setPlaceholder('How does our plant feel?').addOptions(PLANT_STATE_OPTIONS),
  );

  await sendEphemeralPrompt(interaction, {
    content: 'How are you feeling right now, what support would help most, and how does our plant feel today? 💛',
    components: [moodRow, supportRow, plantRow],
  });

  const moodSelection = await waitForSelectInteractionAny(
    interaction.client,
    interaction.user.id,
    [moodId],
    activeFlowControls,
  );
  if (!moodSelection) {
    return null;
  }

  const mood = await resolveSelectValue(interaction, moodSelection, 'mood', activeFlowControls);
  if (!mood) {
    return null;
  }

  const supportSelection = await waitForSelectInteractionAny(
    interaction.client,
    interaction.user.id,
    [supportId],
    activeFlowControls,
  );
  if (!supportSelection) {
    return null;
  }

  const support = await resolveSelectValue(interaction, supportSelection, 'support preference', activeFlowControls);
  if (!support) {
    return null;
  }

  const plantSelection = await waitForSelectInteractionAny(
    interaction.client,
    interaction.user.id,
    [plantId],
    activeFlowControls,
  );
  if (!plantSelection) {
    return null;
  }

  const plantState = await resolveSelectValue(interaction, plantSelection, 'plant state', activeFlowControls);
  if (!plantState) {
    return null;
  }

  await sendEphemeralPrompt(interaction, {
    content: `Saved selections:\nMood: **${mood}**\nSupport: **${support}**\nPlant: **${plantState}**`,
  });

  return { mood, support, plantState };
}

async function resolveSelectValue(interaction, selection, label, activeFlowControls) {
  const value = selection.values[0];
  if (value !== CUSTOM_CHOICE_VALUE) {
    await selection.deferUpdate();
    return value;
  }

  await selection.reply({
    content: `Write your own ${label} as your next message in this channel 💛`,
    flags: MessageFlags.Ephemeral,
  });

  const customMessage = await waitForNextUserMessage(interaction.channel, interaction.user.id, activeFlowControls);
  if (!customMessage) {
    return null;
  }

  const customValue = `${customMessage.content || ''}`.trim();
  if (!customValue) {
    return null;
  }

  try {
    await customMessage.delete();
  } catch {
    // ignore when bot lacks manage message permission
  }

  return customValue;
}

async function handleCancelAllCheckInCommand(interaction, activeFlowControls) {
  const controls = [...activeFlowControls.values()];
  for (const control of controls) {
    control.cancelled = true;
    if (typeof control.cancelWait === 'function') {
      control.cancelWait();
    }
  }

  activeFlowControls.clear();

  if (controls.length === 0) {
    await interaction.reply({
      content: 'No active check-in sessions to cancel right now 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: `Cancelled ${controls.length} active check-in session${controls.length === 1 ? '' : 's'} 💛`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCancelCheckInCommand(interaction, activeFlowControls) {
  const control = activeFlowControls.get(interaction.user.id);
  if (!control) {
    await interaction.reply({
      content: 'No active check-in flow to cancel right now 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  control.cancelled = true;
  if (typeof control.cancelWait === 'function') {
    control.cancelWait();
  }

  activeFlowControls.delete(interaction.user.id);
  await interaction.reply({
    content: 'Check-in flow cancelled 💛',
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSetPlantScoreCommand(interaction) {
  const requested = interaction.options.getInteger('value', true);
  const score = setPlantScore(requested);
  const state = relationshipStateFromScore(score);
  await interaction.reply({
    content: `Hidden plant score set to **${score}**\nRelationship state: **${state}**`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handlePlantScoreCommand(interaction) {
  const score = getPlantScore();
  const state = relationshipStateFromScore(score);
  await interaction.reply({
    content: `Hidden plant score: **${score}**\nRelationship state: **${state}**`,
    flags: MessageFlags.Ephemeral,
  });
}

async function updatePanelMessage(message, config, partnerKey, mood, support, plantState) {
  const state = parsePanelState(message.content, config);
  const wasBothDone = !isPendingRow(state.partner1Row) && !isPendingRow(state.partner2Row);

  if (partnerKey === 'partner1') {
    state.partner1Row = `${mood} | ${support} | ${plantState}`;
  } else {
    state.partner2Row = `${mood} | ${support} | ${plantState}`;
  }

  const supportIdeaLine = buildSupportIdeaLine(state, config);
  const careNoteLine = buildCombinedCareNote(state, config);
  const newContent = composePanelContent(config, state.date, state.partner1Row, state.partner2Row, supportIdeaLine, careNoteLine);
  const isBothDone = !isPendingRow(state.partner1Row) && !isPendingRow(state.partner2Row);
  const components = [checkInButtonRow(isBothDone)];

  await message.edit({ content: newContent, components });

  if (isBothDone) {
    await maybePostRelationshipPlantUpdate(message, config, state);
  }

  if (!wasBothDone && isBothDone) {
    await message.channel.send({
      content: newContent,
      components,
      allowedMentions: { parse: [] },
    });

    try {
      await message.delete();
    } catch {
      // ignore if message cannot be deleted
    }
  }
}

async function maybePostRelationshipPlantUpdate(message, config, state) {
  const partner1PlantState = extractPlantState(state.partner1Row);
  const partner2PlantState = extractPlantState(state.partner2Row);
  if (!partner1PlantState || !partner2PlantState) {
    return;
  }

  await postRelationshipPlantUpdate({
    client: message.client,
    guildId: config.guildId,
    relationshipChannelId: config.relationshipChannelId,
    relationshipChannelName: config.relationshipChannelName,
    threadName: config.plantThreadName,
    timezone: config.timezone,
    date: state.date,
    partner1Name: config.partner1Name,
    partner2Name: config.partner2Name,
    partner1State: partner1PlantState,
    partner2State: partner2PlantState,
  });
}

function buildSupportIdeaLine(state, config) {
  const p1Done = !isPendingRow(state.partner1Row);
  const p2Done = !isPendingRow(state.partner2Row);

  if (!p1Done && !p2Done) {
    return '';
  }

  if (p1Done && p2Done) {
    const p1Need = extractSupport(state.partner1Row);
    const p2Need = extractSupport(state.partner2Row);
    return [
      `Support idea for ${config.partner1Name}:`,
      `${SUPPORT_IDEA_BY_PREF[p1Need] || SUPPORT_IDEA_BY_PREF['❌ Skip support preference']}`,
      '',
      `Support idea for ${config.partner2Name}:`,
      `${SUPPORT_IDEA_BY_PREF[p2Need] || SUPPORT_IDEA_BY_PREF['❌ Skip support preference']}`,
    ].join('\n');
  }

  const checkedInPartner = p1Done ? 'partner1' : 'partner2';
  const otherName = checkedInPartner === 'partner1' ? config.partner2Name : config.partner1Name;
  const checkedInRow = checkedInPartner === 'partner1' ? state.partner1Row : state.partner2Row;
  const support = extractSupport(checkedInRow);

  return `Support idea for ${otherName}:\n${SUPPORT_IDEA_BY_PREF[support] || SUPPORT_IDEA_BY_PREF['❌ Skip support preference']}`;
}

function buildCombinedCareNote(state, config) {
  const p1Done = !isPendingRow(state.partner1Row);
  const p2Done = !isPendingRow(state.partner2Row);
  if (!p1Done || !p2Done) {
    return '';
  }

  const p1Mood = extractMood(state.partner1Row);
  const p2Mood = extractMood(state.partner2Row);
  const p1Support = extractSupport(state.partner1Row);
  const p2Support = extractSupport(state.partner2Row);

  if (p1Support === '⏳ Space / time' || p2Support === '⏳ Space / time') {
    return 'Today\'s care note:\nRemember: space is not abandonment when it is communicated kindly.';
  }

  if (
    p1Support === '🫂 Comfort' ||
    p2Support === '🫂 Comfort' ||
    p1Support === '💗 Affection' ||
    p2Support === '💗 Affection' ||
    p1Support === '💞 Reassurance' ||
    p2Support === '💞 Reassurance'
  ) {
    return 'Today\'s care note:\nSmall affection and gentle words may help a lot today.';
  }

  const p1Neg = isNegativeMood(p1Mood);
  const p2Neg = isNegativeMood(p2Mood);

  if (p1Neg && p2Neg) {
    return 'Today\'s care note:\nBoth of you seem emotionally heavy today. Prioritize softness and patience 💛';
  }

  if (p1Neg && !p2Neg) {
    return `Today\'s care note:\n${config.partner1Name} may need a little extra care today.`;
  }

  if (!p1Neg && p2Neg) {
    return `Today\'s care note:\n${config.partner2Name} may need a little extra care today.`;
  }

  return 'Today\'s care note:\nToday seems lighter. Keep nurturing what\'s working 💛';
}

function isNegativeMood(mood) {
  return ['😴 Tired', '😕 Off / weird', '😰 Anxious', '😔 Sad', '😡 Irritated', '💔 Overwhelmed'].includes(mood);
}

function checkInButtonRow(showArchive = false) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('checkin_do').setLabel('Do my check-in').setStyle(ButtonStyle.Primary),
  );

  if (showArchive) {
    row.addComponents(
      new ButtonBuilder().setCustomId('checkin_archive').setLabel('Archive check-in').setStyle(ButtonStyle.Secondary),
    );
  }

  return row;
}

async function postDailyPanel(channel, config) {
  const date = todayISO(config.timezone);
  const content = composePanelContent(
    config,
    date,
    '⏳ Not checked in yet',
    '⏳ Not checked in yet',
    '',
    '',
  );

  await channel.send({
    content,
    components: [checkInButtonRow(false)],
    allowedMentions: { parse: [] },
  });
}

async function handleArchiveCheckInButton(interaction, config) {
  const state = parsePanelState(interaction.message.content, config);
  const isBothDone = !isPendingRow(state.partner1Row) && !isPendingRow(state.partner2Row);
  if (!isBothDone) {
    await interaction.reply({
      content: 'Archive is available after both check-ins are completed 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const archiveThread = await getOrCreateCheckInArchiveThread(interaction.message.channel);
  if (!archiveThread) {
    await interaction.reply({
      content: 'Could not access the check-in archive thread. Please check my thread permissions 💛',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const archivedContent = [
    interaction.message.content,
    '',
    `Archived by: <@${interaction.user.id}>`,
    `Archived at: ${new Date().toISOString()}`,
  ].join('\n');

  await archiveThread.send({
    content: archivedContent,
    allowedMentions: { parse: [] },
  });

  try {
    await interaction.message.delete();
  } catch {
    // ignore delete failures; user still gets confirmation
  }

  await interaction.reply({
    content: 'Check-in archived 💛',
    flags: MessageFlags.Ephemeral,
  });
}

async function getOrCreateCheckInArchiveThread(channel) {
  try {
    const active = await channel.threads.fetchActive();
    let existing = active.threads.find((thread) => thread.name === 'Check-in archive');
    if (existing) {
      return existing;
    }

    const archived = await channel.threads.fetchArchived({ type: 'public', fetchAll: true });
    existing = archived.threads.find((thread) => thread.name === 'Check-in archive');
    if (existing) {
      if (existing.archived) {
        await existing.setArchived(false, 'Reopen check-in archive');
      }
      return existing;
    }

    return await channel.threads.create({
      name: 'Check-in archive',
      autoArchiveDuration: 10080,
      reason: 'Store completed daily check-ins',
    });
  } catch (error) {
    console.error('[check-in] Failed to get or create Check-in archive thread:', error);
    return null;
  }
}

function composePanelContent(config, date, partner1Row, partner2Row, supportIdeaLine, careNoteLine) {
  return [
    `🌤 Daily Check-In — ${date}`,
    '',
    `${config.partner1Name}: ${partner1Row}`,
    `${config.partner2Name}: ${partner2Row}`,
    supportIdeaLine ? `\n${supportIdeaLine}` : '',
    careNoteLine ? `\n${careNoteLine}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function parsePanelState(content, config) {
  const date = extractPanelDate(content) || todayISO(config.timezone);
  return {
    date,
    partner1Row: extractPartnerRow(content, config.partner1Name) || '⏳ Not checked in yet',
    partner2Row: extractPartnerRow(content, config.partner2Name) || '⏳ Not checked in yet',
  };
}

function extractPanelDate(content) {
  const firstLine = `${content || ''}`.split('\n')[0] || '';
  const match = firstLine.match(/—\s*(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function extractPartnerRow(content, name) {
  const escapedName = escapeRegExp(name);
  const regex = new RegExp(`^${escapedName}:\\s*(.+)$`, 'm');
  const match = `${content || ''}`.match(regex);
  return match ? match[1].trim() : '';
}

function extractMood(row) {
  const [mood] = `${row || ''}`.split('|').map((part) => part.trim());
  return mood;
}

function extractSupport(row) {
  const parts = `${row || ''}`.split('|').map((part) => part.trim());
  return parts[1] || '❌ Skip support preference';
}

function extractPlantState(row) {
  const parts = `${row || ''}`.split('|').map((part) => part.trim());
  return parts[2] || '';
}

function isPendingRow(row) {
  return `${row || ''}`.startsWith('⏳ Not checked in yet');
}

function partnerKeyByUserId(userId, config) {
  if (userId === config.partner1Id) {
    return 'partner1';
  }
  if (userId === config.partner2Id) {
    return 'partner2';
  }
  return null;
}

async function handleScheduledPost(client, config) {
  try {
    const channel = await getCheckInChannel(client, config.channelId);
    if (!channel) {
      console.warn('[check-in] Scheduled post skipped: check-in channel not found.');
      return;
    }

    const panel = await findTodayPanel(channel, config);
    if (panel) {
      return;
    }

    await postDailyPanel(channel, config);
  } catch (error) {
    console.error('[check-in] Scheduled post failed:', error);
  }
}

function scheduleDailyCheckIn(client, config) {
  const schedule = () => {
    const delay = millisUntilNextLocalTime(config.timezone, config.hour, config.minute);
    scheduleLongTimeout(async () => {
      await handleScheduledPost(client, config);
      schedule();
    }, delay);
  };

  schedule();
}

async function findTodayPanel(channel, config) {
  const date = todayISO(config.timezone);
  const messages = await fetchChannelMessages(channel, 200);
  return (
    messages.find(
      (message) =>
        message.author?.id === channel.client.user.id &&
        `${message.content || ''}`.includes('🌤 Daily Check-In') &&
        `${message.content || ''}`.includes(date),
    ) || null
  );
}

async function fetchChannelMessages(channel, max = 200) {
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

async function getCheckInChannel(client, channelId) {
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
    console.error('[check-in] Could not fetch check-in channel:', error);
    return null;
  }
}

function todayISO(timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
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

function toSafeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function waitForSelectInteractionAny(client, userId, customIds, activeFlowControls) {
  const allowedCustomIds = new Set(customIds);
  return new Promise((resolve) => {
    let settled = false;

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      client.off(Events.InteractionCreate, handler);
      const control = activeFlowControls.get(userId);
      if (control) {
        control.cancelWait = null;
      }
      resolve(value);
    };

    const handler = (incoming) => {
      if (!incoming.isStringSelectMenu()) {
        return;
      }
      if (incoming.user.id !== userId) {
        return;
      }
      if (!allowedCustomIds.has(incoming.customId)) {
        return;
      }

      finish(incoming);
    };

    const control = activeFlowControls.get(userId);
    if (control) {
      control.cancelWait = () => finish(null);
      if (control.cancelled) {
        finish(null);
        return;
      }
    }

    client.on(Events.InteractionCreate, handler);
  });
}

async function waitForNextUserMessage(channel, userId, activeFlowControls) {
  return new Promise((resolve) => {
    let settled = false;
    const collector = channel.createMessageCollector({
      filter: (message) => message.author.id === userId && !message.author.bot,
      max: 1,
    });

    const finish = (message) => {
      if (settled) {
        return;
      }
      settled = true;
      collector.stop('done');
      const control = activeFlowControls?.get(userId);
      if (control) {
        control.cancelWait = null;
      }
      resolve(message || null);
    };

    const control = activeFlowControls?.get(userId);
    if (control) {
      control.cancelWait = () => finish(null);
      if (control.cancelled) {
        finish(null);
        return;
      }
    }

    collector.on('collect', (message) => finish(message));
    collector.on('end', (collected) => {
      if (!settled) {
        finish(collected.first() || null);
      }
    });
  });
}

module.exports = {
  setupCheckIn,
};
