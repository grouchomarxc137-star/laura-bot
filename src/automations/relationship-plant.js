const fs = require('fs');
const path = require('path');
const { ChannelType } = require('discord.js');

const SCORE_MIN = 0;
const SCORE_MAX = 100;
const STARTING_SCORE = 40;

const DAILY_INPUT_LEVEL = {
  Wilted: 1,
  Neglected: 2,
  Stable: 3,
  'Watered & Sunned': 4,
  Thriving: 5,
};

const SCORE_IMPACT_BY_DAILY_INPUT = {
  Wilted: -5,
  Neglected: -2,
  Stable: 0,
  'Watered & Sunned': 2,
  Thriving: 5,
};

const BIRD_MOOD = {
  Critical: 'exhausted, tucked-in birds staying close for safety',
  Struggling: 'quiet birds with low energy, still trying to stay nearby',
  Unstable: 'slightly distant birds, unsure but still connected',
  Healthy: 'calm birds perched together in warm light',
  Thriving: 'affectionate, happy birds chirping side by side',
};

const IMAGE_BY_STATE = {
  Critical: 'critical.png',
  Struggling: 'struggling.png',
  Unstable: 'unstable.png',
  Healthy: 'healthy.png',
  Thriving: 'thriving.png',
};

const STORE_PATH = path.resolve(__dirname, '../data/relationship-plant-score.json');
const ASSETS_DIR = path.resolve(__dirname, '../assets-img');

async function postRelationshipPlantUpdate(input) {
  const {
    client,
    guildId,
    relationshipChannelId,
    relationshipChannelName,
    timezone,
    date,
    partner1Name,
    partner2Name,
    partner1State,
    partner2State,
  } = input;

  try {
    const channel = await getRelationshipChannel(client, guildId, relationshipChannelId, relationshipChannelName);
    if (!channel) {
      console.warn('[relationship-plant] Relationship channel not found. Skipping plant update.');
      return;
    }

    const average = calculateAverageInput(partner1State, partner2State);
    const previousScore = readScore();
    const impact = scoreImpactFromInput(average.input);
    const nextScore = clamp(previousScore + impact, SCORE_MIN, SCORE_MAX);
    writeScore(nextScore);
    const relationshipState = relationshipStateFromScore(nextScore);

    const lines = buildPlantResponseMessage({
      date,
      partner1Name,
      partner2Name,
      partner1State,
      partner2State,
      averageInput: average.input,
      averageLevel: average.level,
      relationshipState,
      nextScore,
      impact,
      timezone,
    });

    const imageFile = imagePathForState(relationshipState);
    const payload = {
      content: lines.join('\n'),
      allowedMentions: { parse: [] },
    };

    if (imageFile) {
      payload.files = [imageFile];
    }

    await channel.send(payload);
  } catch (error) {
    console.error('[relationship-plant] Failed to post plant update:', error);
  }
}

function calculateAverageInput(stateA, stateB) {
  const a = DAILY_INPUT_LEVEL[stateA] || DAILY_INPUT_LEVEL.Stable;
  const b = DAILY_INPUT_LEVEL[stateB] || DAILY_INPUT_LEVEL.Stable;
  const level = Math.round((a + b) / 2);
  return {
    level,
    input: inputFromLevel(level),
  };
}

function inputFromLevel(level) {
  if (level <= 1) {
    return 'Wilted';
  }
  if (level === 2) {
    return 'Neglected';
  }
  if (level === 3) {
    return 'Stable';
  }
  if (level === 4) {
    return 'Watered & Sunned';
  }
  return 'Thriving';
}

function scoreImpactFromInput(input) {
  return SCORE_IMPACT_BY_DAILY_INPUT[input] ?? 0;
}

function relationshipStateFromScore(score) {
  if (score <= 19) {
    return 'Critical';
  }
  if (score <= 39) {
    return 'Struggling';
  }
  if (score <= 59) {
    return 'Unstable';
  }
  if (score <= 79) {
    return 'Healthy';
  }
  return 'Thriving';
}

function buildPlantResponseMessage(input) {
  const {
    date,
    partner1Name,
    partner2Name,
    partner1State,
    partner2State,
    averageInput,
    relationshipState,
    nextScore,
    impact,
  } = input;

  const lines = [
    `🌞 Our Relationship Plant — ${date}`,
    '',
    `🌼 ${partner1Name}: **${partner1State}**`,
    `🌼 ${partner2Name}: **${partner2State}**`,
    `🪴 Average daily plant feeling: **${averageInput}**`,
    `🌿 Relationship state: **${relationshipState}**`,
    '',
    `💛🐥 Bird vibe: ${BIRD_MOOD[relationshipState]}`,
    '',
    warmStateMessage(relationshipState, impact),
  ];

  if (nextScore === SCORE_MAX) {
    lines.push('');
    lines.push('🌻 Full bloom milestone (100):');
    lines.push('• You are showing steady care and emotional teamwork.');
    lines.push('• Keep celebrating small moments and gentle repair.');
    lines.push('• Protect this rhythm with regular check-ins and affection.');
  }

  if (nextScore === SCORE_MIN) {
    lines.push('');
    lines.push('🚨 Critical milestone (0):');
    lines.push('• Your bond needs immediate, kind attention.');
    lines.push('• Pause conflict loops and return to safety-first communication.');
    lines.push('• Consider a dedicated talk with clear needs and boundaries.');
  }

  return lines;
}

function warmStateMessage(state, impact) {
  const improved = impact > 0;
  const declined = impact < 0;
  const toughState = ['Critical', 'Struggling', 'Unstable'].includes(state);
  const goodState = ['Healthy', 'Thriving'].includes(state);

  if (toughState && improved) {
    return '🫶 Even in a hard moment, your care is still moving this relationship forward. Keep going gently.';
  }

  if (goodState && improved) {
    return '💛 You are growing stronger and healthier together. This is warm, grounded progress.';
  }

  if (goodState && declined) {
    return '🌤 Gentle check: things look okay on the surface, but there may be emotional distance building underneath.';
  }

  if (state === 'Unstable' && declined) {
    return '🍂 Soft concern: your connection feels shaky today. A calm repair conversation could help.';
  }

  if (state === 'Struggling' && declined) {
    return '🌧 Caring warning: your bond seems strained and needs focused care tonight.';
  }

  if (state === 'Critical' && declined) {
    return '🚨 Serious attention needed: this relationship feels depleted right now and needs immediate tenderness and repair.';
  }

  return '🕯 Keep nurturing each other in small, consistent ways. Cozy care still counts.';
}

async function getRelationshipChannel(client, guildId, channelId, channelName) {
  if (channelId) {
    const direct = await fetchTextChannel(client, channelId);
    if (direct) {
      return direct;
    }
  }

  if (!guildId) {
    return null;
  }

  try {
    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    return (
      channels.find(
        (ch) =>
          ch &&
          ch.type === ChannelType.GuildText &&
          `${ch.name || ''}`.toLowerCase() === `${channelName || 'our-relationship'}`.toLowerCase(),
      ) || null
    );
  } catch (error) {
    console.error('[relationship-plant] Failed to fetch relationship channel by name:', error);
    return null;
  }
}

async function fetchTextChannel(client, channelId) {
  if (!channelId) {
    return null;
  }

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

function imagePathForState(state) {
  const filename = IMAGE_BY_STATE[state];
  if (!filename) {
    return null;
  }

  const fullPath = path.join(ASSETS_DIR, filename);
  if (!fs.existsSync(fullPath)) {
    console.warn(`[relationship-plant] Missing image asset: ${fullPath}`);
    return null;
  }

  return fullPath;
}

function readScore() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      return STARTING_SCORE;
    }

    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const data = JSON.parse(raw);
    const value = Number(data.score);
    if (!Number.isFinite(value)) {
      return STARTING_SCORE;
    }

    return clamp(value, SCORE_MIN, SCORE_MAX);
  } catch {
    return STARTING_SCORE;
  }
}

function writeScore(score) {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify(
        {
          score: clamp(score, SCORE_MIN, SCORE_MAX),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (error) {
    console.error('[relationship-plant] Failed to write score store:', error);
  }
}

function resetPlantScore() {
  writeScore(STARTING_SCORE);
  return STARTING_SCORE;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatSigned(value) {
  if (value > 0) {
    return `+${value}`;
  }
  return `${value}`;
}

module.exports = {
  postRelationshipPlantUpdate,
  calculateAverageInput,
  scoreImpactFromInput,
  buildPlantResponseMessage,
  relationshipStateFromScore,
  resetPlantScore,
};
