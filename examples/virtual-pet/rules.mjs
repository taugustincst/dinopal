// Pure game rules for the virtual pet. No DOM, no clock: time comes in as `now`, randomness as `random`.
// Every function returns a new state object and never mutates its input.

export const TICK_MS = 60_000;
export const MAX_CATCHUP_TICKS = 1440;
export const TICKS_PER_AGE = 60;
export const STAT_MAX = 100;
export const NAME_MAX = 20;
// Historic name: version 2 saves keep the version 1 key so old saves are still found.
export const STORAGE_KEY = 'virtual-pet.v1';
export const SAVE_VERSION = 2;
export const STATS = ['hunger', 'happiness', 'energy', 'health'];
export const HATCH_TICKS = 5;
export const JUVENILE_TICKS = 120;
export const ADULT_TICKS = 1440;
export const STAGES = ['Egg', 'Hatchling', 'Juvenile', 'Adult'];
export const FORMS = ['Sunback', 'Spikeback', 'Grumblesaur'];
export const GAME_ROUNDS = 5;
export const GAME_WIN = 3;
export const REACTION_MS = 1500;
export const BEHAVIOUR_MIN_MS = 10_000;
export const BEHAVIOUR_MAX_MS = 20_000;
export const MESSAGES = {
  'name-empty': 'Please give your pet a name.',
  'name-too-long': `Names can be at most ${NAME_MAX} characters.`,
  'too-tired': 'Too tired to play. Let it sleep first.',
  asleep: 'Shh, it is asleep. Wake it first.',
  dead: 'Your pet has died.',
  egg: "Eggs can't play yet. Wait for it to hatch.",
};

const NEEDS = ['hunger', 'happiness', 'energy'];
const GOOD_CARE = 50;
const PLAY_ENERGY = 10;
const CAPTIONS = {
  stomp: 'is stomping happily',
  yawn: 'is yawning',
  sulk: 'is sulking',
  sniff: 'is sniffing around',
};
// Version 1 stage starts (in ticks) mapped to the start of the matching version 2 stage.
const V1_STAGE_STARTS = [
  [600, ADULT_TICKS],
  [180, JUVENILE_TICKS],
  [60, HATCH_TICKS],
  [0, 0],
];
const clamp = (value) => Math.min(STAT_MAX, Math.max(0, value));
const isStat = (value) => Number.isInteger(value) && value >= 0 && value <= STAT_MAX;
const isCount = (value) => Number.isInteger(value) && value >= 0;

export function validateName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') return { ok: false, error: 'name-empty' };
  if ([...name].length > NAME_MAX) return { ok: false, error: 'name-too-long' };
  return { ok: true, name };
}

export function createPet(name, now) {
  return {
    version: SAVE_VERSION,
    name,
    hunger: 80,
    happiness: 80,
    energy: 80,
    health: 100,
    age: 0,
    asleep: false,
    ticks: 0,
    lastUpdated: now,
    dead: false,
    juvenileTicks: 0,
    goodTicks: 0,
    form: null,
  };
}

function healthAfter(state) {
  if (NEEDS.some((stat) => state[stat] === 0)) return clamp(state.health - 10);
  if (NEEDS.every((stat) => state[stat] >= 50)) return clamp(state.health + 5);
  return state.health;
}

function countCare(previous, next) {
  if (stageOf(previous.ticks) !== 'Juvenile') return next;
  const good = STATS.every((stat) => next[stat] >= GOOD_CARE);
  return { ...next, juvenileTicks: next.juvenileTicks + 1, goodTicks: next.goodTicks + (good ? 1 : 0) };
}

function evolve(state) {
  if (state.form !== null || stageOf(state.ticks) !== 'Adult') return state;
  return { ...state, form: formFor(careScore(state)) };
}

export function tick(state) {
  if (state.dead) return state;
  const needs = state.asleep
    ? { hunger: clamp(state.hunger - 2), happiness: state.happiness, energy: clamp(state.energy + 10) }
    : { hunger: clamp(state.hunger - 5), happiness: clamp(state.happiness - 3), energy: clamp(state.energy - 2) };
  const health = healthAfter({ ...state, ...needs });
  const ticks = state.ticks + 1;
  const next = { ...state, ...needs, health, ticks, age: Math.floor(ticks / TICKS_PER_AGE), dead: health === 0 };
  return evolve(countCare(state, next));
}

function refusal(state) {
  if (state.dead) return 'dead';
  if (state.asleep) return 'asleep';
  return undefined;
}

export function feed(state) {
  const error = refusal(state);
  if (error) return { state, error };
  return { state: { ...state, hunger: clamp(state.hunger + 25) } };
}

export function toggleSleep(state) {
  if (state.dead) return { state, error: 'dead' };
  return { state: { ...state, asleep: !state.asleep } };
}

export function playBlockReason(state) {
  const error = refusal(state);
  if (error) return error;
  if (stageOf(state.ticks) === 'Egg') return 'egg';
  if (state.energy < PLAY_ENERGY) return 'too-tired';
  return null;
}

export function hideSpots(random, rounds = GAME_ROUNDS) {
  return Array.from({ length: rounds }, () => (random() < 0.5 ? 'Left' : 'Right'));
}

export function startGame(random) {
  return { spots: hideSpots(random), picks: [], correct: 0 };
}

export function gameOver(game) {
  return game.picks.length >= game.spots.length;
}

export function guess(game, side) {
  if (gameOver(game)) return game;
  const found = game.spots[game.picks.length] === side;
  return { ...game, picks: [...game.picks, side], correct: game.correct + (found ? 1 : 0) };
}

export function scoreLabel(correct) {
  return `${correct} of ${GAME_ROUNDS}`;
}

export function playOutcome(state, correct) {
  const error = playBlockReason(state);
  if (error !== null) return { state, error };
  const joy = correct >= GAME_WIN ? 20 : 5;
  return { state: { ...state, happiness: clamp(state.happiness + joy), energy: clamp(state.energy - PLAY_ENERGY) } };
}

export function gameResultMessage(name, correct) {
  return `${name} was found ${scoreLabel(correct)} times!`;
}

export function chooseBehaviour(state) {
  if (state.dead || state.asleep || stageOf(state.ticks) === 'Egg') return null;
  if (state.energy < 30) return 'yawn';
  if (state.happiness < 30) return 'sulk';
  if (state.happiness >= 70) return 'stomp';
  return 'sniff';
}

export function behaviourCaption(name, behaviour) {
  return `${name} ${CAPTIONS[behaviour]}`;
}

export function nextBehaviourDelay(random) {
  const spread = BEHAVIOUR_MAX_MS - BEHAVIOUR_MIN_MS + 1;
  return Math.min(BEHAVIOUR_MAX_MS, BEHAVIOUR_MIN_MS + Math.floor(random() * spread));
}

export function elapsedTicks(lastUpdated, now) {
  return Math.min(MAX_CATCHUP_TICKS, Math.max(0, Math.floor((now - lastUpdated) / TICK_MS)));
}

export function advance(state, now) {
  const ticksApplied = elapsedTicks(state.lastUpdated, now);
  let next = state;
  for (let i = 0; i < ticksApplied; i += 1) next = tick(next);
  const elapsed = now - state.lastUpdated;
  const capped = elapsed >= (MAX_CATCHUP_TICKS + 1) * TICK_MS;
  const lastUpdated = elapsed < 0 || capped ? now : state.lastUpdated + ticksApplied * TICK_MS;
  return { state: { ...next, lastUpdated }, ticksApplied };
}

// One tick is one game minute.
export function stageOf(ticks) {
  if (ticks >= ADULT_TICKS) return 'Adult';
  if (ticks >= JUVENILE_TICKS) return 'Juvenile';
  if (ticks >= HATCH_TICKS) return 'Hatchling';
  return 'Egg';
}

export function ageLabel(ticks) {
  const hours = Math.floor(ticks / 60);
  if (hours === 0) return `${ticks} min`;
  if (ticks < ADULT_TICKS) return `${hours} h ${ticks % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

export function isHatching(state) {
  return stageOf(state.ticks) === 'Egg' && state.ticks >= HATCH_TICKS - 1;
}

export function careScore(state) {
  return state.juvenileTicks === 0 ? 0 : state.goodTicks / state.juvenileTicks;
}

export function formFor(score) {
  if (score >= 0.7) return 'Sunback';
  if (score >= 0.4) return 'Spikeback';
  return 'Grumblesaur';
}

export function transitionMessages(previous, next, { away = false } = {}) {
  const messages = [];
  if (stageOf(previous.ticks) === 'Egg' && stageOf(next.ticks) !== 'Egg') {
    messages.push(away ? `${next.name} hatched while you were away!` : `${next.name} hatched!`);
  }
  if (previous.form === null && next.form !== null) messages.push(`${next.name} evolved into a ${next.form}!`);
  return messages;
}

// Sad wins over happy when both conditions hold.
export function moodOf(state) {
  if (STATS.some((stat) => state[stat] < 30)) return 'sad';
  if (state.happiness >= 60 && state.health >= 60) return 'happy';
  return 'neutral';
}

export function statLabel(stat, value) {
  return `${stat[0].toUpperCase()}${stat.slice(1)} ${value} of ${STAT_MAX}`;
}

export function controlsFor(state) {
  const busy = state.dead || state.asleep;
  const playReason = playBlockReason(state);
  return {
    feedDisabled: busy,
    playDisabled: playReason !== null,
    playReason: playReason === null ? '' : MESSAGES[playReason],
    sleepDisabled: state.dead,
    sleepLabel: state.asleep ? 'Wake' : 'Sleep',
  };
}

export function serialize(state) {
  return JSON.stringify(state);
}

function readJson(raw) {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function hasBaseFields(data) {
  const name = validateName(data.name);
  return (
    name.ok &&
    name.name === data.name &&
    STATS.every((stat) => isStat(data[stat])) &&
    isCount(data.age) &&
    isCount(data.ticks) &&
    typeof data.asleep === 'boolean' &&
    typeof data.dead === 'boolean' &&
    Number.isFinite(data.lastUpdated)
  );
}

function hasCareFields(data) {
  const formAllowed = data.form === null || (FORMS.includes(data.form) && stageOf(data.ticks) === 'Adult');
  return isCount(data.juvenileTicks) && isCount(data.goodTicks) && data.goodTicks <= data.juvenileTicks && formAllowed;
}

function baseFields(data, ticks) {
  return {
    version: SAVE_VERSION,
    name: data.name,
    hunger: data.hunger,
    happiness: data.happiness,
    energy: data.energy,
    health: data.health,
    age: Math.floor(ticks / TICKS_PER_AGE),
    asleep: data.asleep,
    ticks,
    lastUpdated: data.lastUpdated,
    dead: data.dead || data.health === 0,
  };
}

// Expects a version 1 save that already passed validation. The care score starts from now.
export function migrateV1(data) {
  const [, ticks] = V1_STAGE_STARTS.find(([oldStart]) => data.ticks >= oldStart);
  const form = stageOf(ticks) === 'Adult' ? 'Spikeback' : null;
  return { ...baseFields(data, ticks), juvenileTicks: 0, goodTicks: 0, form };
}

export function parseSave(raw) {
  const data = readJson(raw);
  if (data === null || typeof data !== 'object' || Array.isArray(data) || !hasBaseFields(data)) return null;
  if (!('version' in data)) return migrateV1(data);
  if (data.version !== SAVE_VERSION || !hasCareFields(data)) return null;
  const pet = { ...baseFields(data, data.ticks), juvenileTicks: data.juvenileTicks, goodTicks: data.goodTicks, form: data.form };
  return evolve(pet);
}
