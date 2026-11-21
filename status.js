// Renders sites.json (built from the extension's own site list) and the probe's status.json, counts
// down to the next check and fetches the new results once they are due.
// Everything from the data goes in as text, never as markup.
'use strict';

/** A local preview: reads the probe's local output and loads the test button (dev.js). */
const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const STATUS_URL = LOCAL
  ? 'status.local.json'
  : 'https://gist.githubusercontent.com/N3uralCreativity/d7df8d80e3e844114aa9b90c700e2b84/raw/status.json';
/** The probe runs on the hour and on the half hour (UTC, which lines up with every time zone's :00 and :30 here). */
const PERIOD_MS = 30 * 60_000;
/** Past this, the checker itself has stopped reporting. */
const STALE_MS = 2 * 60 * 60_000;

const STATE_TEXT = {
  up: 'Working',
  challenge: 'Browser check',
  down: 'Down',
  rework: 'Under rework',
  // Checked, but the answer said nothing either way (the site turned the checker away).
  unknown: 'Couldn’t check',
  // Added after the last run: the next one checks it.
  unchecked: 'Not checked yet',
};
const FEATURES = [
  ['single', 'One chapter'],
  ['select', 'Picked chapters'],
  ['all', 'Download all'],
];

const $ = (id) => document.getElementById(id);
let sites = [];
let status = null;
/** A check is due and its results haven't reached the page yet. */
let running = false;
/** Local test only: true or false overrides the schedule; null follows it. */
let forced = null;

/** hh:mm:ss mm/dd/yyyy in the reader's own time zone. */
function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  e.append(...children.filter((c) => c != null));
  return e;
}

/**
 * What the row shows: the latest result, kept while the next run is out. GitHub starts runs late
 * (often 10 minutes, sometimes an hour), so hiding results until a run reports hid them for long.
 */
const stateOf = (site) => (site.status === 'rework' ? 'rework' : status?.sites?.[site.id]?.state ?? 'unchecked');

function row(site) {
  const check = status?.sites?.[site.id];
  const state = stateOf(site);
  return el(
    'li',
    { class: 'site' },
    el(
      'div',
      { class: 'line' },
      el('span', { class: 'name' }, el('a', { href: site.home, rel: 'noopener noreferrer' }, site.name)),
      site.status === 'beta' ? el('span', { class: 'tag', title: 'Recently added; tell me if something is off' }, 'beta') : null,
      site.adult ? el('span', { class: 'tag', title: 'Adult content' }, '18+') : null,
      el('span', { class: 'state', 'data-state': state }, STATE_TEXT[state]),
    ),
    el(
      'ul',
      { class: 'facts' },
      ...FEATURES.map(([key, label]) =>
        el('li', { class: site.features[key] ? 'feature' : 'feature no' }, label, site.features[key] ? null : el('span', { class: 'visually-hidden' }, ' (not available)')),
      ),
      el('li', {}, site.ui === 'inject' ? 'Buttons on the site’s own pages' : 'From the extension’s panel only'),
      // The page-wide "Last check" covers every site the latest run reached; only older checks are named.
      check?.checkedAt && check.checkedAt !== status.checkedAt ? el('li', {}, `Checked ${when(check.checkedAt)}`) : null,
    ),
    state === 'challenge' ? el('p', { class: 'since' }, 'Online, but it may ask you to pass a browser check on the site before downloads start.') : null,
    state === 'unknown' ? el('p', { class: 'since' }, 'The site answered, but turned the checker away, so this can’t say whether it works right now.') : null,
    state === 'unchecked' && status ? el('p', { class: 'since' }, 'Added after the last check; the next one covers it.') : null,
    check && (state === 'down' || state === 'challenge') && check.since ? el('p', { class: 'since' }, `Since ${when(check.since)}`) : null,
    site.note ? el('p', { class: 'note' }, site.note) : null,
  );
}

function render() {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const listed = sites.filter((s) => s.status === 'supported' || s.status === 'beta' || s.status === 'rework').sort(byName);
  $('supported').replaceChildren(...listed.map(row));
  $('supported').setAttribute('aria-busy', String(running));
  const skipped = sites.filter((s) => s.status === 'skipped' || s.status === 'planned').sort(byName);
  $('skipped').replaceChildren(
    ...skipped.map((s) => el('li', { class: 'site' }, el('span', { class: 'name' }, s.name), el('p', { class: 'note' }, s.status === 'planned' ? 'Planned.' : s.note ?? ''))),
  );

  const live = listed.filter((s) => s.status !== 'rework');
  const working = live.filter((s) => ['up', 'challenge'].includes(stateOf(s))).length;
  $('count').textContent = status ? `${working} of ${live.length}` : 'Unknown';
  $('last').textContent = status?.checkedAt ? when(status.checkedAt) : 'Not available';
  clock();
}

/** Where the schedule stands. GitHub often starts a run a few minutes late, so a slot without a result counts as running. */
function phase(now = Date.now()) {
  const last = status?.checkedAt ? Date.parse(status.checkedAt) : NaN;
  const slot = Math.floor(now / PERIOD_MS) * PERIOD_MS;
  const stale = !Number.isNaN(last) && now - last > STALE_MS;
  return { now, stale, running: !stale && !Number.isNaN(last) && last < slot, left: slot + PERIOD_MS - now };
}

/** Every second: redraw the rows when a run starts, otherwise just move the countdown. */
function tick() {
  const want = forced ?? phase().running;
  if (want !== running) {
    running = want;
    render();
  } else clock();
}

/** The countdown and the alert; once a check is due, asks for its result every 20 seconds. */
let polling = 0;
function clock() {
  const { now, stale, left } = phase();
  const mmss = `${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}`;
  $('next').textContent = running ? 'Running now' : stale ? 'Overdue' : `In ${mmss}`;

  const alert = $('alert');
  alert.hidden = !(stale || !status);
  alert.textContent = !status
    ? 'The latest check couldn’t be loaded, so states are missing. What each site supports is still accurate.'
    : `The checker hasn’t reported since ${when(status.checkedAt)}, so these states may be out of date.`;

  if ((running || stale) && now - polling > 20_000) {
    polling = now;
    void refresh();
  }
}

async function json(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function refresh() {
  const next = await json(`${STATUS_URL}?t=${Date.now()}`).catch(() => null);
  if (next && next.checkedAt !== status?.checkedAt) {
    status = next;
    running = forced ?? phase().running;
    render();
  }
}

/** The same notices the extension's panel shows (notices.json, edited in the repo). Expired ones are left out. */
async function notices() {
  const file = await json('notices.json').catch(() => null);
  const list = Array.isArray(file?.notices) ? file.notices : [];
  const now = Date.now();
  for (const n of list) {
    if (typeof n?.text !== 'string' || (n.until && !(Date.parse(n.until) > now))) continue;
    const p = el('p', { class: 'notice' }, n.text);
    if (typeof n.link === 'string' && n.link.startsWith('https://')) p.append(' ', el('a', { href: n.link }, 'More'));
    $('notices').append(p);
  }
}

async function main() {
  void notices();
  sites = await json('sites.json');
  // A fresh query skips the CDN's five-minute copy.
  status = await json(`${STATUS_URL}?t=${Date.now()}`).catch(() => null);
  running = phase().running;
  render();
  setInterval(tick, 1000);
  if (LOCAL) {
    // Hooks for dev.js, which the published site leaves out.
    window.statusDev = {
      force(value, next) {
        forced = value;
        if (next) status = next;
        running = forced ?? phase().running;
        render();
      },
    };
    document.head.append(el('script', { src: 'dev.js' }));
  }
}

main().catch(() => {
  $('last').textContent = 'Not available';
  const alert = $('alert');
  alert.hidden = false;
  alert.textContent = 'This page couldn’t load its site list. Reload to try again.';
});
