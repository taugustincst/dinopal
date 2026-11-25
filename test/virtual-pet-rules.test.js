import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  TICK_MS,
  MAX_CATCHUP_TICKS,
  NAME_MAX,
  MESSAGES,
  SAVE_VERSION,
  STORAGE_KEY,
  HATCH_TICKS,
  JUVENILE_TICKS,
  ADULT_TICKS,
  STAGES,
  FORMS,
  GAME_ROUNDS,
  GAME_WIN,
  REACTION_MS,
  BEHAVIOUR_MIN_MS,
  BEHAVIOUR_MAX_MS,
  validateName,
  createPet,
  tick,
  feed,
  toggleSleep,
  elapsedTicks,
  advance,
  stageOf,
  ageLabel,
  isHatching,
  careScore,
  formFor,
  transitionMessages,
  playBlockReason,
  hideSpots,
  startGame,
  guess,
  gameOver,
  scoreLabel,
  playOutcome,
  gameResultMessage,
  chooseBehaviour,
  behaviourCaption,
  nextBehaviourDelay,
  moodOf,
  statLabel,
  controlsFor,
  serialize,
  parseSave,
  migrateV1,
} from '../examples/virtual-pet/rules.mjs';

const T0 = Date.UTC(2026, 0, 1);
const pet = (overrides = {}) => ({ ...createPet('Mochi', T0), ...overrides });
const hatched = (overrides = {}) => pet({ ticks: HATCH_TICKS, ...overrides });
const tickN = (state, n) => Array.from({ length: n }).reduce((s) => tick(s), state);
const play = (state) => playOutcome(state, GAME_WIN);
const playGame = (spots, picks) => picks.reduce(guess, startGame(spotsRandom(spots)));
// A random source that hides the pet on the given sides, in order.
const spotsRandom = (spots) => {
  const values = spots.map((side) => (side === 'Left' ? 0 : 0.9));
  return () => values.shift();
};
const v1Save = (ticks, overrides = {}) =>
  JSON.stringify({
    name: 'Rex',
    hunger: 61,
    happiness: 42,
    energy: 73,
    health: 88,
    age: Math.floor(ticks / 60),
    asleep: true,
    ticks,
    lastUpdated: T0,
    dead: false,
    ...overrides,
  });

test('validateName trims and enforces 1-20 characters', () => {
  assert.deepEqual(validateName('   '), { ok: false, error: 'name-empty' });
  assert.deepEqual(validateName(''), { ok: false, error: 'name-empty' });
  assert.deepEqual(validateName('a'.repeat(NAME_MAX + 1)), { ok: false, error: 'name-too-long' });
  assert.deepEqual(validateName('a'.repeat(NAME_MAX)), { ok: true, name: 'a'.repeat(NAME_MAX) });
  assert.deepEqual(validateName('  Mochi '), { ok: true, name: 'Mochi' });
  assert.deepEqual(validateName('🐣'.repeat(NAME_MAX)).ok, true);
  assert.deepEqual(validateName(42), { ok: false, error: 'name-empty' });
  assert.ok(MESSAGES['name-empty'] && MESSAGES['name-too-long']);
});

test('createPet starts a version 2 Egg at 80/80/80/100 with no care counted and no form', () => {
  assert.deepEqual(createPet('Mochi', T0), {
    version: SAVE_VERSION,
    name: 'Mochi',
    hunger: 80,
    happiness: 80,
    energy: 80,
    health: 100,
    age: 0,
    asleep: false,
    ticks: 0,
    lastUpdated: T0,
    dead: false,
    juvenileTicks: 0,
    goodTicks: 0,
    form: null,
  });
  assert.equal(SAVE_VERSION, 2);
  assert.equal(STORAGE_KEY, 'virtual-pet.v1', 'the historic key is kept so old saves are found');
  assert.equal(stageOf(0), 'Egg');
});

test('statLabel names the stat and value out of 100', () => {
  assert.equal(statLabel('hunger', 80), 'Hunger 80 of 100');
  assert.equal(statLabel('health', 0), 'Health 0 of 100');
});

test('awake tick lowers hunger 5, happiness 3, energy 2', () => {
  const next = tick(pet());
  assert.deepEqual([next.hunger, next.happiness, next.energy], [75, 77, 78]);
  assert.equal(next.ticks, 1);
});

test('asleep tick lowers hunger 2 and restores energy, clamped at 100', () => {
  const next = tick(pet({ asleep: true, hunger: 50, energy: 95, happiness: 40 }));
  assert.deepEqual([next.hunger, next.energy, next.happiness], [48, 100, 40]);
});

test('tick does not mutate its input', () => {
  const before = pet({ ticks: JUVENILE_TICKS });
  const copy = { ...before };
  tick(before);
  assert.deepEqual(before, copy);
});

test('health drops 10 when a need hits 0 and rises 5 when all are >= 50', () => {
  const starving = tick(pet({ hunger: 3, health: 50 }));
  assert.equal(starving.hunger, 0);
  assert.equal(starving.health, 40);
  assert.equal(tick(pet({ health: 98 })).health, 100);
  assert.equal(tick(pet({ hunger: 40, health: 70 })).health, 70);
});

test('feed raises hunger by 25, clamped, and is refused while asleep', () => {
  assert.equal(feed(pet({ hunger: 60 })).state.hunger, 85);
  assert.equal(feed(pet({ hunger: 90 })).state.hunger, 100);
  const asleep = pet({ asleep: true, hunger: 60 });
  assert.deepEqual(feed(asleep), { state: asleep, error: 'asleep' });
});

test('actions keep lastUpdated so the tick cadence is not reset', () => {
  const start = hatched({ lastUpdated: T0 + 123 });
  for (const action of [feed, play, toggleSleep]) assert.equal(action(start).state.lastUpdated, T0 + 123);
});

test('controls: an awake hatched pet can do everything; asleep has Feed and Play disabled and a Wake toggle', () => {
  assert.deepEqual(controlsFor(hatched()), {
    feedDisabled: false,
    playDisabled: false,
    playReason: '',
    sleepDisabled: false,
    sleepLabel: 'Sleep',
  });
  assert.deepEqual(controlsFor(toggleSleep(hatched()).state), {
    feedDisabled: true,
    playDisabled: true,
    playReason: MESSAGES.asleep,
    sleepDisabled: false,
    sleepLabel: 'Wake',
  });
});

test('AC17: Play is blocked for an Egg, asleep, dead or energy below 10, with a reason', () => {
  assert.equal(playBlockReason(pet()), 'egg');
  assert.equal(playBlockReason(hatched({ asleep: true })), 'asleep');
  assert.equal(playBlockReason(hatched({ dead: true, asleep: true })), 'dead', 'dead wins over asleep');
  assert.equal(playBlockReason(pet({ asleep: true })), 'asleep', 'asleep wins over egg');
  assert.equal(playBlockReason(hatched({ energy: 9 })), 'too-tired');
  assert.equal(playBlockReason(hatched({ energy: 10 })), null);
  assert.equal(MESSAGES.egg, "Eggs can't play yet. Wait for it to hatch.");
  for (const blocked of [pet(), hatched({ asleep: true }), hatched({ dead: true }), hatched({ energy: 9 })]) {
    const controls = controlsFor(blocked);
    assert.equal(controls.playDisabled, true);
    assert.equal(controls.playReason, MESSAGES[playBlockReason(blocked)]);
    assert.notEqual(controls.playReason, '');
  }
  assert.equal(controlsFor(pet()).feedDisabled, false, 'an egg can still be fed');
});

test('AC2: stage comes from game minutes: Egg < 5, Hatchling < 120, Juvenile < 1440, then Adult', () => {
  const cases = [
    [0, 'Egg'],
    [4, 'Egg'],
    [5, 'Hatchling'],
    [119, 'Hatchling'],
    [120, 'Juvenile'],
    [1439, 'Juvenile'],
    [1440, 'Adult'],
    [5000, 'Adult'],
  ];
  for (const [ticks, stage] of cases) assert.equal(stageOf(ticks), stage, `ticks ${ticks}`);
  const minutes = (hours, mins) => hours * 60 + mins;
  assert.deepEqual([minutes(1, 59), minutes(2, 0), minutes(23, 59), minutes(24, 0)].map(stageOf), [
    'Hatchling',
    'Juvenile',
    'Juvenile',
    'Adult',
  ]);
  assert.deepEqual(STAGES, ['Egg', 'Hatchling', 'Juvenile', 'Adult']);
  assert.deepEqual([HATCH_TICKS, JUVENILE_TICKS, ADULT_TICKS], [5, 120, 1440]);
});

test('AC1/AC3: the egg wobbles in its final minute and hatches on the tick that reaches 5 minutes', () => {
  assert.equal(isHatching(pet({ ticks: HATCH_TICKS - 2 })), false);
  const egg = pet({ ticks: HATCH_TICKS - 1 });
  assert.equal(stageOf(egg.ticks), 'Egg');
  assert.equal(isHatching(egg), true);
  const next = tick(egg);
  assert.equal(stageOf(next.ticks), 'Hatchling');
  assert.equal(isHatching(next), false);
});

test('ageLabel shows minutes, then hours and minutes, then days and hours', () => {
  assert.equal(ageLabel(0), '0 min');
  assert.equal(ageLabel(4), '4 min');
  assert.equal(ageLabel(60), '1 h 0 min');
  assert.equal(ageLabel(119), '1 h 59 min');
  assert.equal(ageLabel(1439), '23 h 59 min');
  assert.equal(ageLabel(1440), '1 d 0 h');
  assert.equal(ageLabel(2 * 1440 + 3 * 60 + 59), '2 d 3 h');
});

test('pet age in hours still follows ticks', () => {
  assert.equal(tick(pet({ ticks: 59 })).age, 1);
  assert.equal(tick(pet({ ticks: 179 })).age, 3);
});

test('care score counts only Juvenile ticks, and a tick is good when all four stats end at >= 50', () => {
  const counters = (state) => [state.juvenileTicks, state.goodTicks];
  assert.deepEqual(counters(tick(pet({ ticks: JUVENILE_TICKS - 1 }))), [0, 0], 'the tick into Juvenile is not counted');
  assert.deepEqual(counters(tick(pet({ ticks: JUVENILE_TICKS }))), [1, 1]);
  assert.deepEqual(counters(tick(pet({ ticks: JUVENILE_TICKS, hunger: 54 }))), [1, 0], 'hunger ends at 49');
  assert.deepEqual(counters(tick(pet({ ticks: JUVENILE_TICKS, hunger: 55 }))), [1, 1], 'hunger ends at exactly 50');
  assert.deepEqual(counters(tick(pet({ ticks: JUVENILE_TICKS, health: 49, hunger: 40 }))), [1, 0], 'health counts too');
  assert.deepEqual(counters(tick(pet({ ticks: ADULT_TICKS, juvenileTicks: 3, goodTicks: 2 }))), [3, 2]);
  assert.equal(careScore(pet()), 0);
  assert.equal(careScore(pet({ juvenileTicks: 4, goodTicks: 3 })), 0.75);
});

test('AC10: formFor is Sunback at >= 0.70, Spikeback at >= 0.40, else Grumblesaur', () => {
  assert.deepEqual(FORMS, ['Sunback', 'Spikeback', 'Grumblesaur']);
  assert.equal(formFor(1), 'Sunback');
  assert.equal(formFor(0.7), 'Sunback');
  assert.equal(formFor(0.6999), 'Spikeback');
  assert.equal(formFor(0.4), 'Spikeback');
  assert.equal(formFor(0.3999), 'Grumblesaur');
  assert.equal(formFor(careScore(pet())), 'Grumblesaur', 'no Juvenile ticks at all');
});

// Raises a Juvenile to Adult, keeping all stats >= 50 on `goodTenths` of every ten ticks.
function raiseJuvenile(goodTenths) {
  let state = pet({ ticks: JUVENILE_TICKS, age: 2 });
  for (let i = 0; state.ticks < ADULT_TICKS; i += 1) {
    const good = i % 10 < goodTenths;
    assert.equal(state.form, null, 'no form before Adult');
    state = tick({ ...state, hunger: good ? 80 : 10, happiness: 80, energy: 80 });
  }
  return state;
}

test('AC7/AC8/AC9: the Juvenile care share chooses the adult form at 24 h', () => {
  for (const [tenths, form] of [
    [8, 'Sunback'],
    [5, 'Spikeback'],
    [2, 'Grumblesaur'],
  ]) {
    const adult = raiseJuvenile(tenths);
    assert.equal(stageOf(adult.ticks), 'Adult');
    assert.equal(adult.juvenileTicks, ADULT_TICKS - JUVENILE_TICKS);
    assert.equal(careScore(adult), tenths / 10);
    assert.equal(adult.form, form, `${tenths * 10}% good care`);
  }
});

test('AC11: an Adult form never changes, even after 48 h of neglect and death', () => {
  const sunback = pet({ ticks: ADULT_TICKS, form: 'Sunback', juvenileTicks: 10, goodTicks: 0 });
  const neglected = tickN(sunback, 2 * MAX_CATCHUP_TICKS);
  assert.equal(neglected.dead, true);
  assert.equal(neglected.form, 'Sunback');
});

test('transitionMessages announces a hatch, an offline hatch and an evolution', () => {
  const egg = pet({ ticks: HATCH_TICKS - 1 });
  assert.deepEqual(transitionMessages(egg, tick(egg)), ['Mochi hatched!']);
  assert.deepEqual(transitionMessages(egg, tick(egg), { away: true }), ['Mochi hatched while you were away!']);
  const juvenile = pet({ ticks: ADULT_TICKS - 1, juvenileTicks: 10, goodTicks: 8 });
  assert.deepEqual(transitionMessages(juvenile, tick(juvenile)), ['Mochi evolved into a Sunback!']);
  assert.deepEqual(transitionMessages(egg, { ...egg, ticks: ADULT_TICKS + 4, form: 'Grumblesaur' }, { away: true }), [
    'Mochi hatched while you were away!',
    'Mochi evolved into a Grumblesaur!',
  ]);
  const adult = pet({ ticks: ADULT_TICKS, form: 'Sunback' });
  assert.deepEqual(transitionMessages(adult, tick(adult)), []);
  assert.deepEqual(transitionMessages(pet(), tick(pet())), []);
});

test('AC14: hidden Left every round, 3 Left and 2 Right picks score "3 of 5": happiness 50→70, energy 60→50', () => {
  assert.deepEqual(
    hideSpots(() => 0),
    ['Left', 'Left', 'Left', 'Left', 'Left'],
  );
  assert.deepEqual(
    hideSpots(() => 0.5, 2),
    ['Right', 'Right'],
  );
  const game = playGame(Array(5).fill('Left'), ['Left', 'Right', 'Left', 'Right', 'Left']);
  assert.equal(gameOver(game), true);
  assert.equal(game.correct, 3);
  assert.equal(scoreLabel(game.correct), '3 of 5');
  const { state, error } = playOutcome(hatched({ happiness: 50, energy: 60 }), game.correct);
  assert.equal(error, undefined);
  assert.deepEqual([state.happiness, state.energy], [70, 50]);
  assert.equal(gameResultMessage('Mochi', 3), 'Mochi was found 3 of 5 times!');
});

test('AC15: picking Right every round against Left scores "0 of 5": happiness 50→55, energy 60→50', () => {
  const game = playGame(Array(5).fill('Left'), Array(5).fill('Right'));
  assert.equal(scoreLabel(game.correct), '0 of 5');
  const { state } = playOutcome(hatched({ happiness: 50, energy: 60 }), game.correct);
  assert.deepEqual([state.happiness, state.energy], [55, 50]);
});

test('AC16: Play outcomes clamp to 0-100', () => {
  assert.equal(playOutcome(hatched({ happiness: 95 }), GAME_ROUNDS).state.happiness, 100);
  const tired = playOutcome(hatched({ energy: 10 }), 0).state;
  assert.equal(tired.energy, 0);
  assert.deepEqual([GAME_ROUNDS, GAME_WIN], [5, 3]);
});

test('playOutcome refuses with the block reason and leaves the state unchanged', () => {
  for (const blocked of [pet(), hatched({ asleep: true }), hatched({ dead: true }), hatched({ energy: 9 })]) {
    assert.deepEqual(playOutcome(blocked, GAME_ROUNDS), { state: blocked, error: playBlockReason(blocked) });
  }
});

test('guess records picks in order, counts hits and ignores picks after the last round', () => {
  const start = startGame(spotsRandom(['Right', 'Left', 'Left', 'Right', 'Right']));
  assert.deepEqual(start, { spots: ['Right', 'Left', 'Left', 'Right', 'Right'], picks: [], correct: 0 });
  const one = guess(start, 'Right');
  assert.deepEqual(one, { ...start, picks: ['Right'], correct: 1 });
  assert.deepEqual(start.picks, [], 'guess does not mutate the game');
  assert.equal(gameOver(one), false);
  const done = ['Left', 'Right', 'Right', 'Left'].reduce(guess, one);
  assert.equal(gameOver(done), true);
  assert.equal(done.correct, 3);
  assert.equal(guess(done, 'Left'), done);
});

test('AC18-AC21: behaviour follows energy, then happiness, with sniffing as the default', () => {
  assert.equal(chooseBehaviour(hatched({ happiness: 80, energy: 60 })), 'stomp');
  assert.equal(chooseBehaviour(hatched({ happiness: 50, energy: 20 })), 'yawn');
  assert.equal(chooseBehaviour(hatched({ happiness: 20, energy: 60 })), 'sulk');
  assert.equal(chooseBehaviour(hatched({ happiness: 50, energy: 60 })), 'sniff');
  assert.equal(chooseBehaviour(hatched({ happiness: 80, energy: 29 })), 'yawn', 'tired wins over happy');
  assert.equal(chooseBehaviour(hatched({ happiness: 29, energy: 29 })), 'yawn', 'tired wins over sulky');
  assert.equal(chooseBehaviour(hatched({ happiness: 70, energy: 30 })), 'stomp', 'boundaries are inclusive');
  assert.equal(chooseBehaviour(hatched({ happiness: 30, energy: 30 })), 'sniff');
});

test('AC23: an Egg, a sleeping pet and a dead pet have no idle behaviour', () => {
  for (const still of [pet({ ticks: HATCH_TICKS - 1 }), hatched({ asleep: true }), hatched({ dead: true })]) {
    assert.equal(chooseBehaviour(still), null);
  }
});

test('behaviour captions name the pet and what it is doing', () => {
  assert.equal(behaviourCaption('Rex', 'stomp'), 'Rex is stomping happily');
  assert.equal(behaviourCaption('Rex', 'yawn'), 'Rex is yawning');
  assert.equal(behaviourCaption('Rex', 'sulk'), 'Rex is sulking');
  assert.equal(behaviourCaption('Rex', 'sniff'), 'Rex is sniffing around');
});

test('a new behaviour is due every 10-20 s and reactions last at most 2 s', () => {
  assert.equal(
    nextBehaviourDelay(() => 0),
    BEHAVIOUR_MIN_MS,
  );
  assert.equal(BEHAVIOUR_MIN_MS, 10_000);
  assert.ok(nextBehaviourDelay(() => 0.9999) <= BEHAVIOUR_MAX_MS);
  assert.equal(
    nextBehaviourDelay(() => 1),
    BEHAVIOUR_MAX_MS,
    'clamped even for an out-of-range source',
  );
  assert.equal(BEHAVIOUR_MAX_MS, 20_000);
  assert.ok(REACTION_MS <= 2000);
});

test('mood is sad below 30, happy at happiness and health >= 60, else neutral', () => {
  assert.equal(moodOf(pet({ happiness: 70, health: 80 })), 'happy');
  assert.equal(moodOf(pet({ hunger: 20 })), 'sad');
  assert.equal(moodOf(pet({ happiness: 50 })), 'neutral');
  assert.equal(moodOf(pet({ happiness: 90, health: 90, energy: 10 })), 'sad');
});

test('pet dies at health 0 and then refuses everything', () => {
  const dead = tick(hatched({ health: 10, hunger: 0 }));
  assert.equal(dead.health, 0);
  assert.equal(dead.dead, true);
  assert.deepEqual(controlsFor(dead), {
    feedDisabled: true,
    playDisabled: true,
    playReason: MESSAGES.dead,
    sleepDisabled: true,
    sleepLabel: 'Sleep',
  });
  for (const action of [feed, play, toggleSleep]) assert.deepEqual(action(dead), { state: dead, error: 'dead' });
  assert.equal(tick(dead), dead);
  assert.ok(MESSAGES.dead && MESSAGES.asleep);
});

test('elapsedTicks floors, ignores negative time and caps at 1440', () => {
  assert.equal(elapsedTicks(T0, T0 + TICK_MS - 1), 0);
  assert.equal(elapsedTicks(T0, T0 + 3 * TICK_MS), 3);
  assert.equal(elapsedTicks(T0, T0 - TICK_MS * 5), 0);
  assert.equal(elapsedTicks(T0, T0 + 10 * 24 * 60 * TICK_MS), MAX_CATCHUP_TICKS);
});

test('advance applies elapsed ticks and keeps the partial-tick remainder', () => {
  const saved = pet();
  const tenMin = advance(saved, T0 + 10 * TICK_MS);
  assert.equal(tenMin.ticksApplied, 10);
  assert.equal(tenMin.state.hunger, 30);
  assert.equal(tenMin.state.lastUpdated, T0 + 10 * TICK_MS);

  const withRemainder = advance(saved, T0 + 10.5 * TICK_MS);
  assert.equal(withRemainder.ticksApplied, 10);
  assert.equal(withRemainder.state.lastUpdated, T0 + 10 * TICK_MS);
});

test('advance caps offline catch-up at 1440 ticks', () => {
  const saved = pet();
  const day = 24 * 60 * TICK_MS;
  const threeDays = advance(saved, T0 + 3 * day);
  assert.equal(threeDays.ticksApplied, 1440);
  assert.deepEqual(threeDays.state, { ...tickN(saved, 1440), lastUpdated: T0 + 3 * day });
  assert.deepEqual(advance(saved, T0 + 4 * day).state, { ...threeDays.state, lastUpdated: T0 + 4 * day });
});

test('advance with negative elapsed time applies nothing and resets lastUpdated', () => {
  const saved = pet();
  const back = advance(saved, T0 - TICK_MS);
  assert.equal(back.ticksApplied, 0);
  assert.deepEqual(back.state, { ...saved, lastUpdated: T0 - TICK_MS });
});

test('parseSave rejects corrupt saves without throwing', () => {
  const good = JSON.parse(serialize(pet()));
  const bad = [
    null,
    undefined,
    '{not json',
    '[]',
    'null',
    '42',
    '{"name":""}',
    JSON.stringify({ ...good, name: '   ' }),
    JSON.stringify({ ...good, hunger: 101 }),
    JSON.stringify({ ...good, energy: -1 }),
    JSON.stringify({ ...good, health: 50.5 }),
    JSON.stringify({ ...good, happiness: '80' }),
    JSON.stringify({ ...good, ticks: -1 }),
    JSON.stringify({ ...good, age: 1.5 }),
    JSON.stringify({ ...good, asleep: 'no' }),
    JSON.stringify({ ...good, dead: 0 }),
    JSON.stringify({ ...good, lastUpdated: null }),
  ];
  for (const raw of bad) assert.equal(parseSave(raw), null, `accepted ${raw}`);
});

test('AC31: parseSave rejects unknown versions and inconsistent version 2 fields', () => {
  const good = JSON.parse(serialize(pet({ ticks: JUVENILE_TICKS, juvenileTicks: 0 })));
  const adult = { ...good, ticks: ADULT_TICKS, form: 'Sunback' };
  const bad = [
    '{bad',
    JSON.stringify({ ...good, version: 3 }),
    JSON.stringify({ ...good, version: '2' }),
    JSON.stringify({ ...good, version: null }),
    JSON.stringify({ ...good, version: 1 }),
    JSON.stringify({ ...good, juvenileTicks: 4, goodTicks: 5 }),
    JSON.stringify({ ...good, juvenileTicks: -1 }),
    JSON.stringify({ ...good, goodTicks: 0.5 }),
    JSON.stringify({ ...adult, form: 'Rex' }),
    JSON.stringify({ ...good, form: 'Sunback' }),
    v1Save(30, { hunger: 101, version: 2 }),
    v1Save(30, { hunger: 101 }),
  ];
  for (const raw of bad) assert.equal(parseSave(raw), null, `accepted ${raw}`);
  for (const field of ['juvenileTicks', 'goodTicks', 'form']) {
    const { [field]: _omitted, ...rest } = adult;
    assert.equal(parseSave(JSON.stringify(rest)), null, `accepted a version 2 save without ${field}`);
  }
});

test('AC12: a version 2 Sunback survives a save round-trip; an Adult saved without a form gets one', () => {
  const sunback = pet({ ticks: ADULT_TICKS + 30, age: 24, juvenileTicks: 1320, goodTicks: 1000, form: 'Sunback' });
  assert.deepEqual(parseSave(serialize(sunback)), sunback);
  const formless = { ...sunback, juvenileTicks: 10, goodTicks: 5, form: null };
  assert.equal(parseSave(serialize(formless)).form, 'Spikeback');
});

test('AC27-AC30: version 1 saves move to the start of the matching new stage with name and stats kept', () => {
  const cases = [
    [0, 'Egg', 0, null],
    [59, 'Egg', 0, null],
    [60, 'Hatchling', HATCH_TICKS, null],
    [179, 'Hatchling', HATCH_TICKS, null],
    [180, 'Juvenile', JUVENILE_TICKS, null],
    [599, 'Juvenile', JUVENILE_TICKS, null],
    [600, 'Adult', ADULT_TICKS, 'Spikeback'],
    [5000, 'Adult', ADULT_TICKS, 'Spikeback'],
  ];
  for (const [oldTicks, stage, ticks, form] of cases) {
    const migrated = parseSave(v1Save(oldTicks));
    assert.deepEqual(
      migrated,
      {
        version: SAVE_VERSION,
        name: 'Rex',
        hunger: 61,
        happiness: 42,
        energy: 73,
        health: 88,
        age: Math.floor(ticks / 60),
        asleep: true,
        ticks,
        lastUpdated: T0,
        dead: false,
        juvenileTicks: 0,
        goodTicks: 0,
        form,
      },
      `old ticks ${oldTicks}`,
    );
    assert.equal(stageOf(migrated.ticks), stage);
    assert.deepEqual(migrateV1(JSON.parse(v1Save(oldTicks))), migrated);
  }
});

test('AC29: a migrated Child starts its care score from now', () => {
  let juvenile = parseSave(v1Save(300, { asleep: false, hunger: 90, happiness: 90, energy: 90, health: 90 }));
  juvenile = tickN(juvenile, 4);
  assert.deepEqual([juvenile.juvenileTicks, juvenile.goodTicks], [4, 4]);
});

test('a version 1 save that was dead stays dead after migration', () => {
  assert.equal(parseSave(v1Save(200, { health: 0, dead: true })).dead, true);
});

test('parseSave round-trips a saved pet and recomputes age from ticks', () => {
  const saved = tickN(pet({ asleep: true }), 3);
  assert.deepEqual(parseSave(serialize(saved)), saved);
  const restored = parseSave(serialize(pet({ ticks: 130, age: 0 })));
  assert.equal(restored.age, 2);
  assert.equal(parseSave(JSON.stringify({ ...pet(), extra: 'x' })).extra, undefined);
});

test('parseSave treats a save with health 0 as dead so a tick cannot revive it', () => {
  const restored = parseSave(serialize(pet({ health: 0, dead: false })));
  assert.equal(restored.dead, true);
  assert.deepEqual(tick(restored), restored);
});

test('edge: name length is counted after trimming, 20 is the inclusive maximum', () => {
  assert.deepEqual(validateName(` ${'b'.repeat(NAME_MAX)} `), { ok: true, name: 'b'.repeat(NAME_MAX) });
  assert.deepEqual(validateName('🐣'.repeat(NAME_MAX + 1)), { ok: false, error: 'name-too-long' });
  assert.deepEqual(validateName('\t\n '), { ok: false, error: 'name-empty' });
  assert.deepEqual(validateName(undefined), { ok: false, error: 'name-empty' });
});

test('edge: health rule boundaries are exactly 0 and 50, and health clamps at 0', () => {
  // All three land exactly on 50 after an awake tick → +5.
  assert.equal(tick(pet({ hunger: 55, happiness: 53, energy: 52, health: 60 })).health, 65);
  // One lands on 49 → no change.
  assert.equal(tick(pet({ hunger: 54, happiness: 53, energy: 52, health: 60 })).health, 60);
  // Happiness at 1 hits 0 → −10; energy hitting 0 also counts.
  assert.equal(tick(pet({ happiness: 1, health: 60 })).health, 50);
  assert.equal(tick(pet({ energy: 2, health: 60 })).health, 50);
  // Health 5 with a need at 0 clamps to 0 and dies (not −5).
  const dead = tick(pet({ hunger: 0, health: 5 }));
  assert.equal(dead.health, 0);
  assert.equal(dead.dead, true);
  // Asleep: hunger reaching 0 still costs health; happiness is unchanged while asleep.
  const asleep = tick(pet({ asleep: true, hunger: 1, health: 60, happiness: 0 }));
  assert.deepEqual([asleep.hunger, asleep.happiness, asleep.health], [0, 0, 50]);
});

test('edge: mood thresholds are inclusive at 60 and exclusive at 30', () => {
  assert.equal(moodOf(pet({ happiness: 60, health: 60 })), 'happy');
  assert.equal(moodOf(pet({ happiness: 59, health: 60 })), 'neutral');
  assert.equal(moodOf(pet({ happiness: 60, health: 59 })), 'neutral');
  assert.equal(moodOf(pet({ hunger: 30, energy: 30 })), 'happy');
  assert.equal(moodOf(pet({ health: 29 })), 'sad');
});

test('edge: catch-up stops ageing once the pet dies part-way through', () => {
  const dying = pet({ hunger: 0, happiness: 0, energy: 0, health: 20 });
  const { state, ticksApplied } = advance(dying, T0 + 100 * TICK_MS);
  assert.equal(ticksApplied, 100);
  assert.equal(state.dead, true);
  assert.equal(state.health, 0);
  assert.equal(state.ticks, 2, 'ticks freeze at death');
});

test('edge: advance with zero elapsed time is a no-op that keeps lastUpdated', () => {
  const saved = pet();
  assert.deepEqual(advance(saved, T0 + TICK_MS - 1), { state: saved, ticksApplied: 0 });
});

test('edge: parseSave rejects missing fields and names the UI could never create', () => {
  const good = JSON.parse(v1Save(30));
  for (const field of Object.keys(good)) {
    const { [field]: _omitted, ...rest } = good;
    assert.equal(parseSave(JSON.stringify(rest)), null, `accepted save without ${field}`);
  }
  assert.equal(parseSave(JSON.stringify({ ...good, name: 'x'.repeat(NAME_MAX + 1) })), null);
  assert.equal(parseSave(JSON.stringify({ ...good, name: ' Mochi ' })), null);
  assert.equal(parseSave(''), null);
  assert.equal(parseSave('"Mochi"'), null);
});

test('one tick takes under 5 ms and a 1440-tick catch-up through Juvenile to Adult under 100 ms', () => {
  const start = pet();
  const t1 = performance.now();
  tick(start);
  assert.ok(performance.now() - t1 < 5);
  const t2 = performance.now();
  advance(pet({ ticks: JUVENILE_TICKS }), T0 + 3 * 24 * 60 * TICK_MS);
  assert.ok(performance.now() - t2 < 100);
});
