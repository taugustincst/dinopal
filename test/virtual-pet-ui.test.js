// Behavioural tests for the page's UI glue: runs the inline script from
// examples/virtual-pet/index.html (the part after the inlined rules) in a vm
// context with a minimal fake DOM, a fake clock, fake timers and an in-memory localStorage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as rules from '../examples/virtual-pet/rules.mjs';

const html = readFileSync(new URL('../examples/virtual-pet/index.html', import.meta.url), 'utf8');
const uiCode = html.slice(html.indexOf('// END rules.mjs'), html.lastIndexOf('</script>'));
const { STORAGE_KEY, TICK_MS, REACTION_MS, HATCH_TICKS, JUVENILE_TICKS, ADULT_TICKS, STAGES, FORMS, MESSAGES } = rules;
const T0 = Date.UTC(2026, 0, 1);
const STEP_MS = 1000;
// Elements the markup starts hidden, so the fake DOM starts in the same state as the browser.
const INITIALLY_HIDDEN = [...html.matchAll(/<[a-z\d]+ id="([\w-]+)"[^>]*\shidden[\s>]/g)].map(([, id]) => id);

class FakeElement {
  constructor(id, attributes = {}) {
    this.id = id;
    this.attributes = new Map(Object.entries(attributes));
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.style = {};
    this.listeners = {};
    this.child = null;
  }
  get hidden() {
    return this.attributes.has('hidden');
  }
  set hidden(value) {
    this.toggleAttribute('hidden', Boolean(value));
  }
  get firstElementChild() {
    this.child ??= new FakeElement(`${this.id}-fill`);
    return this.child;
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  toggleAttribute(name, force) {
    if (force) this.attributes.set(name, '');
    else this.attributes.delete(name);
  }
  addEventListener(type, handler) {
    (this.listeners[type] ??= []).push(handler);
  }
  focus() {
    this.ownerFocus?.(this);
  }
  fire(type) {
    const event = { type, defaultPrevented: false, preventDefault: () => (event.defaultPrevented = true) };
    for (const handler of this.listeners[type] ?? []) handler(event);
    return event;
  }
  click() {
    if (!this.disabled) this.fire('click');
  }
}

function makeStorage(initial = {}, { broken = false } = {}) {
  const data = new Map(Object.entries(initial));
  const guard = () => {
    if (broken) throw Object.assign(new Error('denied'), { name: 'SecurityError' });
  };
  return {
    data,
    getItem: (key) => (guard(), data.has(key) ? data.get(key) : null),
    setItem: (key, value) => (guard(), data.set(key, String(value))),
    removeItem: (key) => (guard(), data.delete(key)),
  };
}

function makeTimers(clock) {
  const pending = new Map();
  let nextId = 1;
  return {
    pending,
    setTimeout: (fn, ms) => {
      pending.set(nextId, { fn, at: clock.now + ms });
      return nextId++;
    },
    clearTimeout: (id) => pending.delete(id),
    runDue() {
      for (const [id, { fn, at }] of [...pending]) {
        if (at > clock.now || !pending.has(id)) continue;
        pending.delete(id);
        fn();
      }
    },
  };
}

function load({ saved, raw, now = T0, broken = false, random = () => 0.5 } = {}) {
  const initial = {};
  if (raw !== undefined) initial[STORAGE_KEY] = raw;
  if (saved) initial[STORAGE_KEY] = JSON.stringify(saved);
  const storage = makeStorage(initial, { broken });
  const clock = { now };
  const timers = makeTimers(clock);
  const elements = new Map();
  let focused = null;
  const el = (id) => {
    if (!elements.has(id)) {
      const element = new FakeElement(id);
      element.ownerFocus = (target) => (focused = target);
      elements.set(id, element);
    }
    return elements.get(id);
  };
  for (const id of INITIALLY_HIDDEN) el(id).hidden = true;
  const groups = {
    stage: STAGES.map((s) => new FakeElement(`stage-${s}`, { 'data-stage': s })),
    form: FORMS.map((f) => new FakeElement(`form-${f}`, { 'data-form': f })),
    mood: ['happy', 'neutral', 'sad'].map((m) => new FakeElement(`mood-${m}`, { 'data-mood': m })),
  };
  const selectors = {
    '#pet-figure [data-stage]': groups.stage,
    '#pet-figure [data-form]': groups.form,
    '[data-mood]': groups.mood,
  };
  const zzz = new FakeElement('zzz', { 'data-asleep': '' });
  const document = new FakeElement('document');
  Object.assign(document, {
    getElementById: el,
    querySelectorAll: (selector) => selectors[selector] ?? [],
    querySelector: (selector) => (selector === '[data-asleep]' ? zzz : null),
  });
  const intervals = [];
  const warnings = [];
  const errors = [];
  const context = vm.createContext({
    ...rules,
    document,
    localStorage: storage,
    Date: { now: () => clock.now },
    Math: Object.assign(Object.create(Math), { random }),
    setInterval: (fn, ms) => intervals.push({ fn, ms }),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    console: { warn: (...args) => warnings.push(args), error: (...args) => errors.push(args), log() {} },
    String,
    Object,
  });
  vm.runInContext(uiCode, context);

  const page = {
    storage,
    clock,
    timers,
    document,
    el,
    zzz,
    intervals,
    warnings,
    errors,
    get focused() {
      return focused;
    },
    get figure() {
      return el('pet-figure');
    },
    visible: (view) => !el(`${view}-view`).hidden,
    shown: (kind) => groups[kind].filter((g) => !g.hidden).map((g) => g.getAttribute(`data-${kind}`)),
    stat: (name) => Number(el(`${name}-value`).textContent),
    stats: () => ['hunger', 'happiness', 'energy', 'health'].map(page.stat),
    saved: () => rules.parseSave(storage.data.get(STORAGE_KEY) ?? null),
    submitName(value) {
      el('pet-name-input').value = value;
      return el('name-form').fire('submit');
    },
    // Moves the clock in steps of at most 1 s, like the browser's 1 s interval, running due timeouts first.
    elapse(ms, afterStep = () => {}) {
      for (let left = ms; left > 0; left -= STEP_MS) {
        clock.now += Math.min(STEP_MS, left);
        timers.runDue();
        for (const { fn } of intervals) fn();
        afterStep();
      }
    },
    pickAll(sides) {
      for (const side of sides) el(`game-${side.toLowerCase()}`).click();
    },
  };
  return page;
}

const savedPet = (overrides = {}) => ({ ...rules.createPet('Mochi', T0), ...overrides });
const hatchedPet = (overrides = {}) => savedPet({ ticks: HATCH_TICKS, ...overrides });
const v1Save = (ticks) =>
  JSON.stringify({
    name: 'Rex',
    hunger: 61,
    happiness: 64,
    energy: 73,
    health: 88,
    age: Math.floor(ticks / 60),
    asleep: false,
    ticks,
    lastUpdated: T0,
    dead: false,
  });

test('AC3: empty storage shows the name prompt; blank and 21-char names are rejected', () => {
  const page = load();
  assert.ok(page.visible('naming'));
  assert.ok(!page.visible('pet'));
  assert.ok(!page.visible('death'));

  for (const bad of ['   ', 'a'.repeat(21)]) {
    const event = page.submitName(bad);
    assert.ok(event.defaultPrevented, 'submit must not navigate');
    assert.notEqual(page.el('name-error').textContent, '', `no error shown for ${JSON.stringify(bad)}`);
    assert.equal(page.el('pet-name-input').getAttribute('aria-invalid'), 'true');
    assert.ok(page.visible('naming'));
    assert.equal(page.storage.data.has(STORAGE_KEY), false, 'no pet may be created');
  }
  assert.equal(page.el('name-error').textContent, rules.MESSAGES['name-too-long']);
});

test('entering "Mochi" creates an Egg at 80/80/80/100, age 0 min, with no form shown', () => {
  const page = load();
  page.submitName('  Mochi ');
  assert.ok(page.visible('pet'));
  assert.ok(!page.visible('naming'));
  assert.equal(page.el('pet-name').textContent, 'Mochi');
  assert.deepEqual(page.stats(), [80, 80, 80, 100]);
  assert.equal(page.el('pet-age').textContent, '0 min');
  assert.equal(page.el('pet-stage').textContent, 'Egg');
  assert.deepEqual(page.shown('stage'), ['Egg']);
  assert.deepEqual(page.shown('form'), []);
  assert.equal(page.el('pet-form-item').hidden, true);
  assert.equal(page.figure.getAttribute('data-stage'), 'Egg');
  assert.equal(page.saved().name, 'Mochi');
  assert.equal(page.saved().version, 2);
  assert.equal(page.saved().lastUpdated, T0);
  assert.equal(page.focused, page.el('feed-button'));
});

test('security: the pet name is rendered as text, never parsed as markup', () => {
  const page = load();
  page.submitName('<b>x</b>');
  assert.equal(page.el('pet-name').textContent, '<b>x</b>');
});

test('each stat bar exposes its name and value to assistive tech', () => {
  const page = load({ saved: savedPet({ hunger: 42 }) });
  const bar = page.el('hunger-bar');
  assert.equal(bar.getAttribute('aria-valuenow'), '42');
  assert.equal(bar.getAttribute('aria-valuetext'), 'Hunger 42 of 100');
  assert.equal(bar.firstElementChild.style.width, '42%');
  assert.equal(page.el('health-bar').getAttribute('aria-valuetext'), 'Health 100 of 100');
});

test('one 1 s interval ticks the pet once per 60 s and saves', () => {
  const page = load({ saved: savedPet() });
  assert.equal(page.intervals.length, 1);
  assert.equal(page.intervals[0].ms, 1000);
  page.elapse(TICK_MS - 1);
  assert.deepEqual(page.stats().slice(0, 3), [80, 80, 80]);
  page.elapse(1);
  assert.deepEqual(page.stats().slice(0, 3), [75, 77, 78]);
  assert.equal(page.saved().ticks, 1);
});

test('Feed updates stats and saves', () => {
  const page = load({ saved: hatchedPet({ hunger: 60 }) });
  page.el('feed-button').click();
  assert.equal(page.stat('hunger'), 85);
  assert.equal(page.saved().hunger, 85);
  assert.equal(page.el('status').textContent, '');
});

test('asleep disables Feed and Play, the toggle reads Wake, and waking enables them again', () => {
  const page = load({ saved: hatchedPet() });
  page.el('sleep-button').click();
  assert.equal(page.el('sleep-button').textContent, 'Wake');
  assert.equal(page.el('feed-button').disabled, true);
  assert.equal(page.el('play-button').disabled, true);
  assert.equal(page.el('play-reason').textContent, MESSAGES.asleep);
  assert.equal(page.zzz.hidden, false);
  assert.equal(page.el('pet-sleep').textContent, 'Asleep');
  assert.equal(page.saved().asleep, true);

  page.el('sleep-button').click();
  assert.equal(page.el('sleep-button').textContent, 'Sleep');
  assert.equal(page.el('feed-button').disabled, false);
  assert.equal(page.el('play-button').disabled, false);
  assert.equal(page.el('play-reason').textContent, '');
  assert.equal(page.zzz.hidden, true);
});

test('AC1: an egg aged 4 min shows a dinosaur Hatchling one tick later', () => {
  const page = load({ saved: savedPet({ ticks: HATCH_TICKS - 1 }) });
  assert.deepEqual(page.shown('stage'), ['Egg']);
  page.elapse(TICK_MS);
  assert.equal(page.el('pet-stage').textContent, 'Hatchling');
  assert.equal(page.el('pet-age').textContent, '5 min');
  assert.deepEqual(page.shown('stage'), ['Hatchling']);
  assert.equal(page.figure.getAttribute('data-stage'), 'Hatchling');
});

test('AC3: an egg in its final minute wobbles; a younger egg does not', () => {
  const wobbling = load({ saved: savedPet({ ticks: HATCH_TICKS - 1, lastUpdated: T0 - 30_000 }) });
  assert.equal(wobbling.figure.getAttribute('data-wobble'), '');
  const resting = load({ saved: savedPet({ ticks: HATCH_TICKS - 2 }) });
  assert.equal(resting.figure.getAttribute('data-wobble'), null);
});

test('AC4: 30 s after 4 min 30 s the live region says "Mochi hatched!" and the hatch event shows briefly', () => {
  const page = load({ saved: savedPet({ ticks: HATCH_TICKS - 1, lastUpdated: T0 - 30_000 }) });
  page.elapse(30_000);
  assert.equal(page.el('status').textContent, 'Mochi hatched!');
  assert.equal(page.figure.getAttribute('data-event'), 'hatch');
  assert.equal(page.figure.getAttribute('data-wobble'), null);
  page.elapse(REACTION_MS);
  assert.equal(page.figure.getAttribute('data-event'), null);
});

test('AC5: an egg saved at 1 min and reopened 10 minutes later hatched while away', () => {
  const page = load({ saved: savedPet({ ticks: 1 }), now: T0 + 10 * TICK_MS });
  assert.equal(page.el('pet-stage').textContent, 'Hatchling');
  assert.equal(page.el('status').textContent, 'Mochi hatched while you were away!');
  assert.equal(page.figure.getAttribute('data-event'), 'hatch');
});

test('AC13: a Juvenile turning Adult announces its evolution and shows the form as text and art', () => {
  const page = load({ saved: savedPet({ ticks: ADULT_TICKS - 1, age: 23, juvenileTicks: 100, goodTicks: 80 }) });
  assert.equal(page.el('pet-form-item').hidden, true);
  page.elapse(TICK_MS);
  assert.equal(page.el('status').textContent, 'Mochi evolved into a Sunback!');
  assert.equal(page.el('pet-form').textContent, 'Sunback');
  assert.equal(page.el('pet-form-item').hidden, false);
  assert.deepEqual(page.shown('stage'), ['Adult']);
  assert.deepEqual(page.shown('form'), ['Sunback']);
  assert.equal(page.figure.getAttribute('data-form'), 'Sunback');
  assert.equal(page.figure.getAttribute('data-event'), 'evolve');
});

test('AC12: reloading an Adult Sunback still shows Sunback, with no announcement', () => {
  const page = load({ saved: savedPet({ ticks: ADULT_TICKS, age: 24, form: 'Sunback' }) });
  assert.equal(page.el('pet-form').textContent, 'Sunback');
  assert.deepEqual(page.shown('form'), ['Sunback']);
  assert.equal(page.el('status').textContent, '');
});

test('AC6 text: stage and age are shown as text for each stage', () => {
  for (const [ticks, stage, age] of [
    [HATCH_TICKS, 'Hatchling', '5 min'],
    [JUVENILE_TICKS, 'Juvenile', '2 h 0 min'],
    [ADULT_TICKS + 61, 'Adult', '1 d 1 h'],
  ]) {
    const page = load({
      saved: savedPet({ ticks, age: Math.floor(ticks / 60), form: stage === 'Adult' ? 'Grumblesaur' : null }),
    });
    assert.equal(page.el('pet-stage').textContent, stage);
    assert.equal(page.el('pet-age').textContent, age);
    assert.deepEqual(page.shown('stage'), [stage]);
  }
});

test('AC37 functional walk: every stage and every form appears as time passes', () => {
  const seen = { stage: new Set(), form: new Set() };
  const record = (page) => {
    for (const kind of ['stage', 'form']) for (const shown of page.shown(kind)) seen[kind].add(shown);
  };
  const walks = [
    savedPet({ ticks: HATCH_TICKS - 1 }),
    savedPet({ ticks: JUVENILE_TICKS - 1, age: 1 }),
    ...[90, 50, 10].map((goodTicks) => savedPet({ ticks: ADULT_TICKS - 1, age: 23, juvenileTicks: 100, goodTicks })),
  ];
  for (const saved of walks) {
    const page = load({ saved });
    record(page);
    page.elapse(TICK_MS);
    record(page);
    assert.equal(page.shown('stage').length, 1);
    assert.ok(page.shown('form').length <= 1);
  }
  assert.deepEqual([...seen.stage].sort(), [...STAGES].sort());
  assert.deepEqual([...seen.form].sort(), [...FORMS].sort());
});

test('AC27-AC30: version 1 saves load into the matching new stage and form with name and stats unchanged', () => {
  for (const [ticks, stage, form] of [
    [30, 'Egg', ''],
    [100, 'Hatchling', ''],
    [300, 'Juvenile', ''],
    [700, 'Adult', 'Spikeback'],
  ]) {
    const page = load({ raw: v1Save(ticks) });
    assert.equal(page.el('pet-stage').textContent, stage, `old ticks ${ticks}`);
    assert.equal(page.el('pet-form').textContent, form);
    assert.equal(page.el('pet-name').textContent, 'Rex');
    assert.deepEqual(page.stats(), [61, 64, 73, 88]);
    assert.equal(page.el('hunger-bar').getAttribute('aria-valuetext'), 'Hunger 61 of 100');
    assert.equal(page.saved().version, 2, 'the migrated pet is saved as version 2');
    assert.deepEqual(page.errors, []);
  }
});

test('mood faces are shown, mood also as text', () => {
  const happy = load({ saved: savedPet({ happiness: 70, health: 80 }) });
  assert.deepEqual(happy.shown('mood'), ['happy']);
  assert.equal(happy.el('pet-mood').textContent, 'happy');
  const sad = load({ saved: savedPet({ hunger: 20 }) });
  assert.deepEqual(sad.shown('mood'), ['sad']);
  assert.equal(sad.el('pet-mood').textContent, 'sad');
});

test('death shows the final age; Start over clears storage and shows the prompt', () => {
  const page = load({ saved: savedPet({ health: 10, hunger: 0, ticks: 179, age: 2 }) });
  assert.ok(page.visible('pet'));
  page.elapse(TICK_MS);
  assert.ok(page.visible('death'));
  assert.ok(!page.visible('pet'));
  assert.equal(page.el('death-message').textContent, 'Mochi has died at age 3 h 0 min.');
  assert.equal(page.saved().dead, true);
  for (const id of ['feed-button', 'play-button', 'sleep-button']) assert.equal(page.el(id).disabled, true, id);
  assert.equal(page.focused, page.el('restart-button'), 'focus moves off the disabled controls');

  page.el('restart-button').click();
  assert.equal(page.storage.data.has(STORAGE_KEY), false);
  assert.ok(page.visible('naming'));
  assert.equal(page.el('pet-name-input').value, '');
  assert.equal(page.focused, page.el('pet-name-input'));
  page.elapse(TICK_MS * 5);
  assert.equal(page.storage.data.has(STORAGE_KEY), false, 'no ticks run after Start over');
});

test('a pet saved dead loads straight into the death view', () => {
  const page = load({ saved: savedPet({ health: 0, dead: true, ticks: 600, age: 10 }) });
  assert.ok(page.visible('death'));
  assert.equal(page.el('death-message').textContent, 'Mochi has died at age 10 h 0 min.');
});

test('reload applies 10 missed ticks', () => {
  const page = load({ saved: savedPet({ hunger: 80 }), now: T0 + 10 * TICK_MS });
  assert.equal(page.stat('hunger'), 30);
  assert.equal(page.saved().ticks, 10);
  assert.equal(page.saved().lastUpdated, T0 + 10 * TICK_MS);
});

test('a save from 3 days ago applies exactly 1440 ticks', () => {
  const now = T0 + 3 * 24 * 60 * TICK_MS;
  const saved = savedPet();
  const page = load({ saved, now });
  // No pet survives a day unattended, so compare with 1440 manual ticks (a no-op once dead).
  let expected = saved;
  for (let i = 0; i < 1440; i += 1) expected = rules.tick(expected);
  assert.deepEqual(page.saved(), { ...expected, lastUpdated: now });
  const fourDays = load({ saved, now: now + 24 * 60 * TICK_MS });
  assert.deepEqual(fourDays.saved(), { ...expected, lastUpdated: now + 24 * 60 * TICK_MS });
  assert.ok(page.visible('death'));
});

test('AC31: invalid JSON or an unknown save version shows the prompt, no console error, key removed', () => {
  for (const raw of ['{not json', '[]', '{"name":""}', '', JSON.stringify(savedPet({ version: 99 }))]) {
    const page = load({ raw });
    assert.ok(page.visible('naming'), `prompt not shown for ${JSON.stringify(raw)}`);
    assert.deepEqual(page.errors, []);
    assert.equal(page.storage.data.has(STORAGE_KEY), false);
  }
});

test('storage that throws (file:// or private mode) still lets the game play in memory', () => {
  const page = load({ broken: true });
  assert.ok(page.visible('naming'));
  assert.equal(page.el('storage-note').hidden, false);
  page.submitName('Mochi');
  assert.ok(page.visible('pet'));
  page.el('feed-button').click();
  assert.equal(page.stat('hunger'), 100);
  assert.deepEqual(page.errors, []);
  assert.ok(page.warnings.length > 0);
});

test('visibilitychange catches up after a throttled background tab', () => {
  const page = load({ saved: savedPet() });
  page.clock.now += 3 * TICK_MS;
  assert.equal(page.stat('hunger'), 80);
  page.document.fire('visibilitychange');
  assert.equal(page.stat('hunger'), 65);
  assert.equal(page.saved().ticks, 3);
});

test('edge: the form accepts exactly 20 characters after trimming and rejects 21', () => {
  const page = load();
  page.submitName(` ${'z'.repeat(21)} `);
  assert.equal(page.el('name-error').textContent, rules.MESSAGES['name-too-long']);
  assert.ok(page.visible('naming'));
  page.submitName(`  ${'z'.repeat(20)}  `);
  assert.ok(page.visible('pet'));
  assert.equal(page.el('pet-name').textContent, 'z'.repeat(20));
  assert.equal(page.saved().name, 'z'.repeat(20));
});

test('edge: a save dated in the future (clock moved back) loads without ticks and resumes from now', () => {
  const page = load({ saved: savedPet({ lastUpdated: T0 + 5 * TICK_MS }), now: T0 });
  assert.deepEqual(page.stats(), [80, 80, 80, 100]);
  assert.equal(page.saved().ticks, 0);
  page.elapse(TICK_MS);
  assert.equal(page.saved().ticks, 1, 'ticks resume one minute after now, not after the future timestamp');
  assert.deepEqual(page.errors, []);
});

test('edge: a dead pet stays frozen while intervals and visibility events keep firing', () => {
  const page = load({ saved: savedPet({ health: 0, dead: true, ticks: 75, age: 1 }) });
  const before = page.storage.data.get(STORAGE_KEY);
  page.elapse(10 * TICK_MS);
  page.document.fire('visibilitychange');
  assert.equal(page.storage.data.get(STORAGE_KEY), before);
  assert.equal(page.el('death-message').textContent, 'Mochi has died at age 1 h 15 min.');
  for (const id of ['feed-button', 'play-button', 'sleep-button']) assert.equal(page.el(id).disabled, true, id);
});

test('edge: a pet that dies while asleep shows the death view and every control is disabled', () => {
  const page = load({ saved: savedPet({ asleep: true, hunger: 1, health: 10 }) });
  page.elapse(TICK_MS);
  assert.ok(page.visible('death'));
  assert.equal(page.saved().dead, true);
  for (const id of ['feed-button', 'play-button', 'sleep-button']) assert.equal(page.el(id).disabled, true, id);
});

test('AC14/AC25/AC34: the keyboard flow plays "Which way?" to "3 of 5", hops, and returns focus to Play', () => {
  const page = load({ saved: hatchedPet({ happiness: 50, energy: 60 }), random: () => 0 });
  assert.equal(page.el('game-view').hidden, true);
  page.el('play-button').click();
  assert.equal(page.el('game-view').hidden, false);
  assert.equal(page.el('actions').hidden, true, 'the action row is hidden while the game is open');
  assert.equal(page.focused, page.el('game-left'));
  assert.equal(page.el('game-round').textContent, 'Round 1 of 5');

  page.el('game-left').click();
  assert.equal(page.el('game-feedback').textContent, 'Found it!');
  assert.equal(page.el('game-round').textContent, 'Round 2 of 5');
  page.el('game-right').click();
  assert.equal(page.el('game-feedback').textContent, 'Not there.');
  assert.equal(page.el('game-score').textContent, '');
  assert.deepEqual(page.stats().slice(1, 3), [50, 60], 'no stat change before the game ends');

  page.pickAll(['Left', 'Right', 'Left']);
  assert.equal(page.el('game-score').textContent, '3 of 5');
  assert.equal(page.el('status').textContent, 'Mochi was found 3 of 5 times!');
  assert.equal(page.figure.getAttribute('data-reaction'), 'hop');
  assert.deepEqual(page.stats().slice(1, 3), [70, 50]);
  assert.deepEqual([page.saved().happiness, page.saved().energy], [70, 50]);
  assert.equal(page.el('game-left').disabled, true);
  assert.equal(page.el('game-right').disabled, true);
  assert.equal(page.focused, page.el('game-close'));

  page.el('game-close').click();
  assert.equal(page.el('game-view').hidden, true);
  assert.equal(page.el('actions').hidden, false);
  assert.equal(page.focused, page.el('play-button'));
});

test('AC15: picking Right every round against Left shows "0 of 5" and gives happiness +5', () => {
  const page = load({ saved: hatchedPet({ happiness: 50, energy: 60 }), random: () => 0 });
  page.el('play-button').click();
  page.pickAll(Array(5).fill('Right'));
  assert.equal(page.el('game-score').textContent, '0 of 5');
  assert.deepEqual(page.stats().slice(1, 3), [55, 50]);
  assert.equal(page.el('status').textContent, 'Mochi was found 0 of 5 times!');
});

test('a new game starts fresh and closing early changes no stats', () => {
  const page = load({ saved: hatchedPet({ happiness: 50, energy: 60 }), random: () => 0 });
  page.el('play-button').click();
  page.pickAll(Array(5).fill('Left'));
  page.el('game-close').click();
  page.el('play-button').click();
  assert.equal(page.el('game-left').disabled, false);
  assert.equal(page.el('game-score').textContent, '');
  assert.equal(page.el('game-feedback').textContent, '');
  assert.equal(page.el('game-round').textContent, 'Round 1 of 5');
  page.pickAll(['Left', 'Left']);
  page.el('game-close').click();
  assert.deepEqual(page.stats().slice(1, 3), [70, 50], 'only the finished game counted');
});

test('the game closes if the pet dies while it is open', () => {
  const page = load({ saved: hatchedPet({ hunger: 0, health: 10 }) });
  page.el('play-button').click();
  page.elapse(TICK_MS);
  assert.ok(page.visible('death'));
  assert.equal(page.el('game-view').hidden, true);
  assert.equal(page.el('actions').hidden, false);
});

test('edge: a game at exactly 10 energy is allowed; afterwards Play is disabled as too tired', () => {
  const page = load({ saved: hatchedPet({ energy: 10, happiness: 50 }), random: () => 0 });
  page.el('play-button').click();
  page.pickAll(Array(5).fill('Left'));
  assert.deepEqual([page.stat('happiness'), page.stat('energy')], [70, 0]);
  page.el('game-close').click();
  assert.equal(page.el('play-button').disabled, true);
  assert.equal(page.el('play-reason').textContent, MESSAGES['too-tired']);
});

test('AC17: Play is disabled with a visible reason for an Egg, asleep, dead or energy 9', () => {
  for (const saved of [
    savedPet(),
    hatchedPet({ asleep: true }),
    hatchedPet({ dead: true, health: 0 }),
    hatchedPet({ energy: 9 }),
  ]) {
    const page = load({ saved });
    assert.equal(page.el('play-button').disabled, true, JSON.stringify(saved));
    assert.notEqual(page.el('play-reason').textContent, '');
    page.el('play-button').click();
    assert.equal(page.el('game-view').hidden, true);
  }
  assert.equal(load({ saved: savedPet() }).el('play-reason').textContent, MESSAGES.egg);
});

test('AC22: an awake hatched pet re-chooses its behaviour within 20 s, captioned outside the live region', () => {
  let calls = 0;
  const random = () => {
    calls += 1;
    return 0;
  };
  const page = load({ saved: hatchedPet({ happiness: 80, energy: 60 }), random });
  assert.equal(page.figure.getAttribute('data-behaviour'), 'stomp');
  const caption = 'Mochi is stomping happily';
  assert.equal(page.el('pet-caption').textContent, caption);
  const choicesAtLoad = calls;
  page.elapse(20_000, () => assert.ok(!page.el('status').textContent.includes(caption)));
  assert.ok(calls > choicesAtLoad, 'behaviour was re-chosen');
  assert.equal(page.figure.getAttribute('data-behaviour'), 'stomp');
  assert.equal(page.intervals.length, 1);
});

test('AC22: the behaviour follows the pet when its state changes', () => {
  const page = load({ saved: hatchedPet({ happiness: 50, energy: 31 }) });
  assert.equal(page.figure.getAttribute('data-behaviour'), 'sniff');
  page.elapse(TICK_MS);
  page.elapse(20_000);
  assert.equal(page.figure.getAttribute('data-behaviour'), 'yawn');
  assert.equal(page.el('pet-caption').textContent, 'Mochi is yawning');
});

test('AC23: an Egg, a sleeping pet and a dead pet have no idle behaviour', () => {
  for (const saved of [savedPet(), hatchedPet({ asleep: true }), hatchedPet({ dead: true, health: 0 })]) {
    const page = load({ saved });
    page.elapse(20_000);
    assert.equal(page.figure.getAttribute('data-behaviour'), null, JSON.stringify(saved));
    assert.equal(page.el('pet-caption').textContent, '');
  }
  const page = load({ saved: hatchedPet() });
  assert.notEqual(page.figure.getAttribute('data-behaviour'), null);
  page.el('sleep-button').click();
  assert.equal(page.figure.getAttribute('data-behaviour'), null, 'falling asleep stops the behaviour');
  assert.equal(page.el('pet-caption').textContent, '');
  page.el('sleep-button').click();
  page.elapse(STEP_MS);
  assert.notEqual(page.figure.getAttribute('data-behaviour'), null, 'waking resumes it within a second');
});

test('AC24: Feed shows a short chomp that never blocks the other controls', () => {
  const page = load({ saved: savedPet({ ticks: JUVENILE_TICKS, age: 2 }) });
  page.el('feed-button').click();
  assert.equal(page.figure.getAttribute('data-reaction'), 'chomp');
  assert.equal(page.el('play-button').disabled, false);
  assert.equal(page.el('sleep-button').disabled, false);
  assert.ok(REACTION_MS <= 2000);
  page.elapse(REACTION_MS);
  assert.equal(page.figure.getAttribute('data-reaction'), null);

  page.el('feed-button').click();
  page.el('sleep-button').click();
  assert.equal(page.saved().asleep, true, 'Sleep works during the chomp');
  assert.equal(page.figure.getAttribute('data-reaction'), 'curl');
  page.elapse(REACTION_MS);
  assert.equal(page.figure.getAttribute('data-reaction'), null);
  assert.equal(page.timers.pending.size, 0, 'the replaced reaction timer was cleared');
});

test('AC26: Sleep shows a curl-up; waking and feeding an Egg show no reaction', () => {
  const page = load({ saved: savedPet({ ticks: JUVENILE_TICKS, age: 2 }) });
  page.el('sleep-button').click();
  assert.equal(page.figure.getAttribute('data-reaction'), 'curl');
  page.elapse(REACTION_MS);
  page.el('sleep-button').click();
  assert.equal(page.figure.getAttribute('data-reaction'), null);

  const egg = load({ saved: savedPet() });
  egg.el('feed-button').click();
  assert.equal(egg.stat('hunger'), 100);
  assert.equal(egg.figure.getAttribute('data-reaction'), null);
});

test('AC25: finishing a game as an awake Juvenile shows the happy hop, which clears within 2 s', () => {
  const page = load({ saved: savedPet({ ticks: JUVENILE_TICKS, age: 2, happiness: 50, energy: 60 }), random: () => 0 });
  assert.equal(page.el('pet-stage').textContent, 'Juvenile');
  page.el('play-button').click();
  page.pickAll(['Left', 'Left', 'Right', 'Right', 'Right']);
  assert.equal(page.el('game-score').textContent, '2 of 5');
  assert.equal(page.figure.getAttribute('data-reaction'), 'hop', 'a lost game still hops');
  assert.deepEqual([page.stat('happiness'), page.stat('energy')], [55, 50]);
  page.elapse(REACTION_MS);
  assert.equal(page.figure.getAttribute('data-reaction'), null);
});

test('AC16 page: a won game at happiness 95 shows 100, not 115', () => {
  const page = load({ saved: hatchedPet({ happiness: 95, energy: 60 }), random: () => 0 });
  page.el('play-button').click();
  page.pickAll(Array(5).fill('Left'));
  assert.equal(page.el('game-score').textContent, '5 of 5');
  assert.equal(page.stat('happiness'), 100);
  assert.equal(page.saved().happiness, 100);
  assert.equal(page.el('happiness-bar').getAttribute('aria-valuetext'), 'Happiness 100 of 100');
});

test('AC11/AC12: a Sunback evolved in the page is saved, reloads as Sunback and stays Sunback after 48 h away', () => {
  const page = load({ saved: savedPet({ ticks: ADULT_TICKS - 1, age: 23, juvenileTicks: 100, goodTicks: 70 }) });
  page.elapse(TICK_MS);
  assert.equal(page.el('pet-form').textContent, 'Sunback', 'a score of exactly 0.70 is Sunback');
  const stored = page.storage.data.get(STORAGE_KEY);
  assert.equal(JSON.parse(stored).form, 'Sunback');

  const reloaded = load({ raw: stored, now: page.clock.now });
  assert.equal(reloaded.el('pet-form').textContent, 'Sunback');
  assert.deepEqual(reloaded.shown('form'), ['Sunback']);
  assert.equal(reloaded.el('status').textContent, '', 'no second evolution announcement');

  const neglected = load({ raw: stored, now: page.clock.now + 48 * 60 * TICK_MS });
  assert.equal(neglected.saved().form, 'Sunback');
  assert.equal(neglected.saved().dead, true, 'two days unattended kills it, but the form is kept');
  assert.equal(neglected.el('status').textContent, '');
});

test('edge: a pet that tires below 10 energy during an open game gets no reward and no hop', () => {
  const page = load({ saved: hatchedPet({ happiness: 50, energy: 10 }), random: () => 0 });
  page.el('play-button').click();
  page.pickAll(['Left', 'Left']);
  page.elapse(TICK_MS);
  assert.equal(page.stat('energy'), 8, 'one awake tick costs 2 energy');
  const happiness = page.stat('happiness');
  page.pickAll(['Left', 'Left', 'Left']);
  assert.equal(page.el('game-score').textContent, '5 of 5');
  assert.equal(page.el('status').textContent, MESSAGES['too-tired']);
  assert.equal(page.figure.getAttribute('data-reaction'), null);
  assert.deepEqual([page.stat('happiness'), page.stat('energy')], [happiness, 8]);
  assert.equal(page.focused, page.el('game-close'));
  page.el('game-close').click();
  assert.equal(page.el('play-button').disabled, true);
  assert.equal(page.el('play-reason').textContent, MESSAGES['too-tired']);
});

test('edge: extra picks after the fifth round change nothing', () => {
  const page = load({ saved: hatchedPet({ happiness: 50, energy: 60 }), random: () => 0 });
  page.el('play-button').click();
  page.pickAll(Array(5).fill('Left'));
  page.el('game-left').fire('click');
  page.el('game-right').fire('click');
  assert.equal(page.el('game-score').textContent, '5 of 5');
  assert.deepEqual([page.stat('happiness'), page.stat('energy')], [70, 50], 'the reward is applied once');
});
