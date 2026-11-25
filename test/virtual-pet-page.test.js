import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { STAGES, FORMS } from '../examples/virtual-pet/rules.mjs';

const pageUrl = new URL('../examples/virtual-pet/index.html', import.meta.url);
const html = readFileSync(pageUrl, 'utf8');
const rules = readFileSync(new URL('../examples/virtual-pet/rules.mjs', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const BEGIN = '// BEGIN rules.mjs (verbatim copy; checked by test/virtual-pet-page.test.js)\n';
const END = '\n// END rules.mjs';
const STAT_NAMES = ['Hunger', 'Happiness', 'Energy', 'Health'];

function between(text, open, close) {
  const start = text.indexOf(open);
  assert.ok(start >= 0, `missing ${JSON.stringify(open)}`);
  const end = text.indexOf(close, start + open.length);
  assert.ok(end >= 0, `missing ${JSON.stringify(close)}`);
  return text.slice(start + open.length, end);
}

const sha256 = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const script = between(html, '<script type="module">', '</script>');
const style = between(html, '<style>', '</style>');
const csp = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1] ?? '';
const cspDirective = (name) =>
  csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
const countOf = (pattern) => (html.match(pattern) ?? []).length;
const markup = html.replace(style, '').replace(script, '');

test('inlined rules are a verbatim copy of rules.mjs', () => {
  assert.equal(between(script, BEGIN, END).trimEnd(), rules.trimEnd());
});

test('CSP is default-src none and hashes the single inline script and style', () => {
  assert.match(csp, /(^|;\s*)default-src 'none'(;|$)/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.equal(cspDirective('script-src'), `script-src ${sha256(script)}`, `expected script hash ${sha256(script)}`);
  assert.equal(cspDirective('style-src'), `style-src ${sha256(style)}`, `expected style hash ${sha256(style)}`);
});

test('page has exactly one module script and one style block', () => {
  assert.equal(countOf(/<script\b/g), 1);
  assert.equal(countOf(/<style\b/g), 1);
  assert.match(html, /<script type="module">/);
});

test('page uses no HTML injection, eval, network, cookies or inline handlers', () => {
  const forbidden = [
    'innerHTML',
    'outerHTML',
    'insertAdjacentHTML',
    'document.write',
    'eval(',
    'new Function',
    'fetch(',
    'XMLHttpRequest',
    'WebSocket',
    'sendBeacon',
    'document.cookie',
    '<link',
    '<img',
    '<iframe',
    ' style=',
    '<image',
    'href=',
    'url(',
    '@import',
    '@font-face',
  ];
  for (const needle of forbidden) assert.ok(!html.includes(needle), `found ${needle}`);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
});

test('the only URL is the SVG namespace', () => {
  for (const url of html.match(/https?:\/\/[^\s"'<>)]*/g) ?? []) assert.equal(url, 'http://www.w3.org/2000/svg');
});

test('page is a single file under 100 KB', () => {
  assert.ok(statSync(pageUrl).size < 100 * 1024);
});

test('page is responsive, keyboard-friendly and respects reduced motion', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta\s+name="viewport"\s+content="width=device-width, initial-scale=1"\s*\/?>/);
  assert.match(style, /:focus-visible\s*\{[^}]*outline:\s*3px solid/);
  assert.match(style, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(style, /box-sizing: border-box/);
  assert.match(style, /flex-wrap: wrap/);
  for (const [, px] of style.matchAll(/(?:^|[^-])width:\s*(\d+)px/g)) assert.ok(Number(px) <= 320, `fixed width ${px}px`);
});

test('each stat is a labelled progressbar with a text value', () => {
  const bars = html.match(/<div[^>]*role="progressbar"[^>]*>/g) ?? [];
  assert.equal(bars.length, 4);
  for (const name of STAT_NAMES) {
    const bar = bars.find((tag) => tag.includes(`aria-label="${name}"`));
    assert.ok(bar, `no progressbar for ${name}`);
    for (const attr of ['aria-valuemin="0"', 'aria-valuemax="100"', 'aria-valuenow=', 'aria-valuetext=']) {
      assert.ok(bar.includes(attr), `${name} bar missing ${attr}`);
    }
  }
  assert.match(script, /statLabel\(/);
});

test('all controls are native buttons and the name input is labelled', () => {
  for (const label of ['Feed', 'Play', 'Sleep', 'Start over', 'Left', 'Right', 'Close']) {
    assert.match(html, new RegExp(`<button[^>]*>\\s*${label}\\s*</button>`), `${label} is not a <button>`);
  }
  assert.match(html, /<form[^>]*id="name-form"[\s\S]*<button type="submit"[^>]*>[^<]+<\/button>[\s\S]*<\/form>/);
  const input = between(html, '<input', '>');
  const id = /id="([^"]+)"/.exec(input)?.[1];
  assert.ok(id && html.includes(`<label for="${id}">`), 'name input has no label');
  assert.ok(!/maxlength/i.test(input), 'input must allow typing a 21-character name');
  assert.match(html, /<p[^>]*role="alert"/);
  assert.match(html, /<p[^>]*role="status"[^>]*aria-live="polite"/);
});

test('pet drawing has one group per stage and form, inside the figure, and three mood faces', () => {
  const groupsOf = (attribute, value) => (markup.match(new RegExp(`<g ${attribute}="${value}"`, 'g')) ?? []).length;
  for (const stage of STAGES) assert.equal(groupsOf('data-stage', stage), 1, stage);
  for (const form of FORMS) assert.equal(groupsOf('data-form', form), 1, form);
  for (const mood of ['happy', 'neutral', 'sad']) assert.equal(groupsOf('data-mood', mood), 1, mood);
  assert.equal((markup.match(/data-(stage|form|mood)=/g) ?? []).length, 10, 'no other elements carry these attributes');
  const figure = between(html, '<g id="pet-figure">', '<!-- end pet-figure -->');
  for (const value of [...STAGES, ...FORMS]) assert.match(figure, new RegExp(`data-(stage|form)="${value}"`));
  assert.match(script, /'#pet-figure \[data-stage\]'/);
  assert.match(script, /'#pet-figure \[data-form\]'/);
});

test('AC6: each stage after the egg is drawn larger than the one before; stage and age are text', () => {
  const scaleOf = (stage) => {
    const tag = new RegExp(`<g data-stage="${stage}"[^>]*>`).exec(html)?.[0] ?? '';
    return Number(/transform="translate\([^)]*\) scale\(([\d.]+)\)"/.exec(tag)?.[1]);
  };
  const scales = ['Hatchling', 'Juvenile', 'Adult'].map(scaleOf);
  assert.deepEqual(scales, [0.6, 0.8, 1]);
  assert.match(html, /<span id="pet-stage"><\/span>/);
  assert.match(html, /<span id="pet-age"><\/span>/);
  assert.match(html, /<li id="pet-form-item"[^>]*>Form: <span id="pet-form"><\/span><\/li>/);
});

test('AC35: the game controls are native buttons whose visible text is their accessible name', () => {
  for (const [id, label] of [
    ['game-left', 'Left'],
    ['game-right', 'Right'],
    ['game-close', 'Close'],
  ]) {
    const tag = new RegExp(`<button id="${id}"[^>]*>\\s*${label}\\s*</button>`).exec(html)?.[0];
    assert.ok(tag, `#${id} is not a <button> labelled ${label}`);
    assert.doesNotMatch(tag, /aria-label/);
  }
  assert.match(html, /<button id="play-button" type="button" aria-describedby="play-reason">Play<\/button>/);
  assert.match(html, /<p id="play-reason"[^>]*><\/p>/);
  assert.match(html, /<section id="game-view" aria-labelledby="game-title" hidden>/);
  assert.match(html, /<h3 id="game-title">Which way\?<\/h3>/);
  assert.match(html, /<p id="game-feedback"[^>]*role="status"/);
  assert.match(html, /<div id="actions" class="row">/);
});

test('AC22: the behaviour caption is plain text outside the live region', () => {
  const caption = /<p id="pet-caption"[^>]*>/.exec(html)?.[0];
  assert.ok(caption, 'no #pet-caption paragraph');
  assert.doesNotMatch(caption, /role=|aria-live/);
  const status = /<p id="status"[^>]*>(.*?)<\/p>/s.exec(html);
  assert.ok(status && !status[1].includes('pet-caption'));
});

const withoutBlocks = (css, opener) => {
  let out = css;
  for (let start = out.indexOf(opener); start >= 0; start = out.indexOf(opener)) {
    let depth = 0;
    let end = out.indexOf('{', start);
    for (; end < out.length; end += 1) {
      if (out[end] === '{') depth += 1;
      if (out[end] === '}' && --depth === 0) break;
    }
    out = out.slice(0, start) + out.slice(end + 1);
  }
  return out;
};

test('AC36: reduced motion turns every animation off', () => {
  const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*,\s*\*::before,\s*\*::after\s*\{([^}]*)\}/.exec(style);
  assert.ok(reduced, 'no global reduced-motion rule');
  assert.match(reduced[1], /animation: none !important;/);
  assert.match(reduced[1], /transition: none !important;/);
  assert.doesNotMatch(script, /matchMedia|prefers-reduced-motion/, 'captions and announcements do not depend on motion');
});

test('animations move only transform and opacity', () => {
  const keyframes = [...style.matchAll(/@keyframes ([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g)];
  const names = keyframes.map(([, name]) => name).sort();
  assert.deepEqual(names, ['chomp', 'curl', 'evolve', 'hatch', 'hop', 'sniff', 'stomp', 'sulk', 'wobble', 'yawn']);
  for (const [, name, body] of keyframes) {
    for (const [, property] of body.matchAll(/([a-z-]+)\s*:/g)) {
      assert.ok(['transform', 'opacity'].includes(property), `@keyframes ${name} animates ${property}`);
    }
  }
});

test('AC3/AC36: static poses are plain attribute rules, so they stay when animation is off', () => {
  const plain = withoutBlocks(withoutBlocks(style, '@keyframes'), '@media');
  const rules = [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector, body }));
  for (const pose of [
    '[data-wobble]',
    '[data-event="hatch"]',
    '[data-reaction="chomp"]',
    '[data-reaction="hop"]',
    '[data-reaction="curl"]',
  ]) {
    const posed = rules.some(
      ({ selector, body }) => selector.includes(pose) && /(^|;|\s)(display|transform|opacity|visibility)\s*:/.test(body),
    );
    assert.ok(posed, `no static pose for ${pose}`);
  }
});

test('the example adds no runtime dependency and is not shipped in the npm package', () => {
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
  assert.ok(!pkg.files.some((entry) => entry.startsWith('examples')));
});
