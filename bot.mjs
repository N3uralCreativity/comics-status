// The support bot on the status page: scripted, no AI, no server. The conversation is a pure
// reducer (step) over flows.json, sites.json and status.json, so it can be tested on recorded
// conversations; the DOM part at the bottom only draws it. Nothing typed leaves the page until the
// reader opens the GitHub link it builds.

export const ISSUE_REPO = 'https://github.com/N3uralCreativity/comix-status';
const STATE_TEXT = {
  up: 'working',
  challenge: 'working, may ask for a browser check',
  down: 'down',
  unknown: 'in an unknown state (the site turned the checker away)',
};

const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const norm = (s) => s.toLowerCase().replace(/[’']/g, "'");

/** hh:mm:ss mm/dd/yyyy in the reader's own time zone. */
export function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
}

const collapse = (s) => norm(s).replace(/[^a-z0-9]/g, '');
/** Words that are part of many site names, or of how people talk about them: never a site on their own. */
const COMMON = new Set(
  'manga mangas manhwa manhua comic comics raw raws read reader reading chapter chapters download downloads site sites page pages web online free scan scans toon toons status working broken help please the and'.split(
    ' ',
  ),
);
/** Small words that never belong to a name: a run of words containing one is not read as a name. */
const STOP = new Set('a an the my i is it in on of to for and or at this that what when why how me you can cannot not no do does'.split(' '));
/** Typos allowed for a word of this length. Short words must be exact. */
const slack = (len) => (len <= 4 ? 0 : len <= 7 ? 1 : len <= 11 ? 2 : 3);

/** Edit distance with swapped neighbours counted as one edit ("mangahbu"), stopping once past `max`. */
export function distance(a, b, max = Infinity) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      row.push(v);
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
    [prev2, prev] = [prev, row];
  }
  return prev[b.length];
}

/** How each site can be written: name, id, domain and the domain's first part, without spaces or dots. */
const spellings = (site) => {
  const host = new URL(site.home).hostname.replace(/^www\./, '');
  return [...new Set([site.name, site.id, host, host.split('.')[0]].map(collapse))].filter((w) => w.length >= 3 && !COMMON.has(w));
};

/**
 * The sites the text names, closest first, each with how far off it was (0 = spelled right).
 * Reads single words and runs of two or three ("weeb central"), forgives a typo or two in long
 * names, and accepts the start of a name ("rawdev"). Only the closest tier is returned, so
 * "mangarawjp" is MangaRawJP and not also MangaRaw.
 */
export function findSites(text, sites) {
  const words = (norm(text).match(/[a-z0-9][a-z0-9.-]*/g) ?? []).map((w) => w.replace(/[.-]+$/, ''));
  const grams = new Set();
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 3 && i + n <= words.length; n++) {
      const run = words.slice(i, i + n);
      if (!run.some((w) => STOP.has(w))) grams.add(collapse(run.join('')));
    }
  }
  const scored = [];
  for (const site of sites) {
    let best = Infinity;
    for (const name of spellings(site)) {
      for (const g of grams) {
        if (g === name) best = 0;
        if (best === 0) break;
        if (g.length < 4 || COMMON.has(g)) continue;
        // The start of a name, at least half of it.
        if (name.startsWith(g) && g.length * 2 >= name.length) best = Math.min(best, 1);
        const max = slack(Math.max(g.length, name.length));
        const off = max ? distance(g, name, max) : Infinity;
        if (off <= max) best = Math.min(best, off);
      }
    }
    if (best < Infinity) scored.push({ site, off: best });
  }
  const top = Math.min(...scored.map((x) => x.off));
  return scored.filter((x) => x.off === top).sort((a, b) => a.site.name.localeCompare(b.site.name));
}

/** The one site the text names, if exactly one is closest. */
export function matchSite(text, sites) {
  const found = findSites(text, sites);
  return found.length === 1 ? found[0].site : undefined;
}

/** A question about whether a site works, rather than a description of a problem. */
export function asksStatus(text, site) {
  const t = norm(text);
  if (/\b(status|up|down|online|offline|alive|dead|available|reachable|outage|works?|working|running)\b/.test(t)) return true;
  // Little more than the site's name: "mangadex?"
  const names = spellings(site);
  const left = (t.match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w) && !/^(about|whats|s|check|site)$/.test(w) && !names.some((n) => n.includes(w)));
  return left.length <= 1;
}

/** The probe runs on the hour and the half hour; a run is due once the last result is older than the current slot. */
const PERIOD_MS = 30 * 60_000;
const STALE_MS = 2 * 60 * 60_000;
export function checkPhase(status, now) {
  const last = Date.parse(status?.checkedAt ?? '');
  if (Number.isNaN(last)) return { known: false, running: false, stale: false };
  const stale = now - last > STALE_MS;
  return { known: true, stale, running: !stale && last < Math.floor(now / PERIOD_MS) * PERIOD_MS };
}

/** The entries whose keywords appear in the text, best match first. */
export function ranked(text, entries) {
  const t = norm(text);
  return entries
    .map((e) => ({ e, score: e.keywords.filter((k) => t.includes(norm(k))).length }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.e);
}

const choices = (list) => list.map((x) => (typeof x === 'string' ? { label: x, value: x } : { label: x.label, value: x.id }));

/**
 * One turn. `input` is the reader's text or chosen value (undefined to start).
 * Returns the new state and what to show: bot lines, then either choices or a text field.
 */
export function step(state, input, { flows, sites, status, now = Date.now() }) {
  const say = [];
  const s = { ...state };
  const site = () => sites.find((x) => x.id === s.site);
  const vars = () => ({ site: site()?.name ?? 'the site', note: site()?.note ?? '' });
  const listed = sites.filter((x) => ['supported', 'beta', 'rework'].includes(x.status));
  const siteChoices = () => [...choices(listed.map((x) => ({ id: x.id, label: x.name }))), { label: flows.otherSite, value: '__other' }];

  /** The site is known: answer its status, or start on the problem. */
  const route = () => (s.intent === 'status' ? statusAnswer() : afterSite());
  /** The reader's words named a site, several, or none. */
  const fromText = (text) => {
    const found = findSites(text, sites);
    if (found.length === 1) {
      s.site = found[0].site.id;
      s.intent = asksStatus(text, found[0].site) ? 'status' : 'problem';
      if (found[0].off > 0) say.push(fill(flows.takenAs, vars()));
      return route();
    }
    s.intent = /\b(status|up|down|online|offline|working|works?)\b/.test(norm(text)) ? 'status' : 'problem';
    if (found.length > 1) {
      s.step = 'pick';
      say.push(flows.whichOne);
      return { say, choices: [...choices(found.map(({ site: x }) => ({ id: x.id, label: x.name }))), { label: flows.noneOfThese, value: '__none' }] };
    }
    s.step = 'site';
    say.push(flows.askSite);
    return { say, choices: siteChoices() };
  };

  const stateLine = (template, check) => fill(template, { ...vars(), state: STATE_TEXT[check.state], when: when(check.checkedAt) });
  const statusDone = () => {
    s.step = 'statusDone';
    return {
      say,
      choices: [
        { label: flows.problem, value: '__problem' },
        { label: flows.anotherSite, value: '__another' },
        { label: flows.restart, value: '__restart' },
      ],
    };
  };
  /** What the last check said, or a wait for the one running now. */
  const statusAnswer = () => {
    const meta = site();
    if (meta.status === 'skipped' || meta.status === 'planned') return end(fill(flows.states.skipped, vars()));
    if (meta.status === 'rework') return end(fill(flows.states.rework, vars()));
    const check = status?.sites?.[meta.id];
    const phase = checkPhase(status, now);
    if (phase.running) {
      s.step = 'waiting';
      s.waitingFor = status.checkedAt;
      say.push(check ? stateLine(flows.statusWaiting, check) : fill(flows.statusWaitingNew, vars()));
      return { say, wait: true, choices: [{ label: flows.stopWaiting, value: '__nowait' }] };
    }
    if (!check) say.push(fill(phase.known ? flows.notCheckedYet : flows.states.unknown, vars()));
    else {
      say.push(stateLine(flows.statusIs, check));
      if (phase.stale) say.push(fill(flows.statusStale, { when: when(status.checkedAt) }));
    }
    return statusDone();
  };

  const askError = () => {
    s.step = 'error';
    say.push(flows.askError);
    return { say, choices: choices(ranked(s.text ?? '', flows.errors)) };
  };
  const afterSite = () => {
    const meta = site();
    if (meta.status === 'skipped' || meta.status === 'planned') return end(fill(flows.states.skipped, vars()));
    if (meta.status === 'rework') return end(fill(flows.states.rework, vars()));
    const check = status?.sites?.[meta.id];
    s.checked = check ? `${STATE_TEXT[check.state]}, checked ${when(check.checkedAt)}` : 'not checked yet';
    if (!check) say.push(fill(flows.states.unknown, vars()));
    else say.push(stateLine(flows.statusIs, check));
    if (check?.state === 'down') return end(fill(flows.states.down, vars()));
    return askError();
  };
  function end(line) {
    say.push(line);
    s.step = 'done';
    return { say, choices: [{ label: flows.restart, value: '__restart' }] };
  }

  let out;
  switch (s.step) {
    case undefined:
      s.step = 'start';
      say.push(flows.greeting);
      out = { say, text: true };
      break;
    case 'start':
      s.text = String(input ?? '').slice(0, 2000);
      out = fromText(s.text);
      break;
    case 'pick':
      if (input === '__none' || !sites.some((x) => x.id === input)) {
        s.step = 'site';
        say.push(flows.askSite);
        out = { say, choices: siteChoices() };
        break;
      }
      s.site = input;
      out = route();
      break;
    case 'site':
      if (input === '__other' || !sites.some((x) => x.id === input)) {
        out = end(flows.notListed);
        break;
      }
      s.site = input;
      out = route();
      break;
    case 'waiting': {
      // The page polls while this step waits and calls back with '__status' once a new check is in.
      const check = status?.sites?.[s.site];
      if (input === '__status' && status?.checkedAt !== s.waitingFor) {
        say.push(check ? stateLine(flows.statusNew, check) : fill(flows.notCheckedYet, vars()));
        out = statusDone();
      } else if (input === '__status') {
        out = { say, wait: true, choices: [{ label: flows.stopWaiting, value: '__nowait' }] };
      } else {
        // The reader stopped waiting, or the check took too long: go by the last result.
        say.push(check ? stateLine(input === '__timeout' ? flows.waitTimeout : flows.statusIs, check) : fill(flows.notCheckedYet, vars()));
        out = statusDone();
      }
      break;
    }
    case 'statusDone':
      if (input === '__problem') {
        s.intent = 'problem';
        out = afterSite();
      } else if (input === '__another') {
        s.step = 'another';
        say.push(flows.askAnother);
        out = { say, text: true };
      } else out = step({}, undefined, { flows, sites, status, now });
      break;
    case 'another':
      s.text = String(input ?? '').slice(0, 2000);
      s.site = undefined;
      out = fromText(s.text);
      break;
    case 'error':
      s.error = flows.errors.find((e) => e.id === input)?.id ?? 'other';
      s.step = 'browser';
      say.push(flows.askBrowser);
      out = { say, choices: choices(flows.browsers) };
      break;
    case 'browser':
      s.browser = String(input);
      s.step = 'system';
      say.push(flows.askSystem);
      out = { say, choices: choices(flows.systems) };
      break;
    case 'system':
      s.system = String(input);
      s.step = 'action';
      say.push(flows.askAction);
      out = { say, choices: choices(ranked(s.text ?? '', flows.actions)) };
      break;
    case 'action': {
      s.action = flows.actions.find((a) => a.id === input)?.id ?? flows.actions[0].id;
      const fixes = flows.errors.find((e) => e.id === s.error).fixes.map((f) => fill(f, vars()));
      s.tried = fixes;
      say.push(...fixes);
      s.step = 'worked';
      say.push(flows.askWorked);
      out = {
        say,
        choices: [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
      };
      break;
    }
    case 'worked':
      if (input === 'yes') {
        out = end(flows.worked);
        break;
      }
      s.step = 'version';
      say.push(flows.askVersion);
      out = { say, text: true };
      break;
    case 'version': {
      const v = String(input ?? '').trim();
      if (!/^\d+(\.\d+){1,3}$/.test(v) && !/^(don'?t know|dunno|no idea|\?)$/i.test(v)) {
        say.push(flows.badVersion);
        out = { say, text: true };
        break;
      }
      s.version = /^\d/.test(v) ? v : 'unknown';
      s.step = 'series';
      say.push(flows.askSeries);
      out = { say, text: true, choices: [{ label: flows.skip, value: '__skip' }] };
      break;
    }
    case 'series': {
      const url = String(input ?? '').trim();
      s.series = /^https?:\/\/\S+$/.test(url) ? url.slice(0, 300) : '';
      s.step = 'done';
      say.push(flows.report);
      out = { say, report: report(s, { flows, sites }), choices: [{ label: flows.restart, value: '__restart' }] };
      break;
    }
    default:
      return step({}, undefined, { flows, sites, status });
  }
  return { state: s, ...out };
}

/** The issue: a prefilled GitHub form link and the same text to copy by hand. */
export function report(s, { flows, sites }) {
  const site = sites.find((x) => x.id === s.site);
  const error = flows.errors.find((e) => e.id === s.error);
  const action = flows.actions.find((a) => a.id === s.action);
  const fields = {
    site: site?.name ?? s.site,
    status: s.checked ?? 'not checked yet',
    action: action?.label ?? '',
    error: error?.label ?? '',
    browser: `${s.browser} on ${s.system}`,
    version: s.version ?? 'unknown',
    tried: (s.tried ?? []).join('\n'),
    series: s.series ?? '',
    details: (s.text ?? '').slice(0, 1000),
  };
  const title = `[${fields.site}] ${fields.error}`;
  const body = [
    'Generated by the support bot on status.n3uralcreativity.top.',
    '',
    `Site: ${fields.site}`,
    `Status at report time: ${fields.status}`,
    `Action: ${fields.action}`,
    `Error: ${fields.error}`,
    `Browser and system: ${fields.browser}`,
    `Extension version: ${fields.version}`,
    `Already tried:\n${fields.tried}`,
    `Series: ${fields.series || 'not given'}`,
    `In their words: ${fields.details}`,
  ].join('\n');
  const params = new URLSearchParams({ template: 'site-problem.yml', title, ...fields });
  return { title, body, url: `${ISSUE_REPO}/issues/new?${params}` };
}

// The page: the launcher in the corner opens the chat window (#bot). Not run in tests.
if (typeof document !== 'undefined') {
  const root = document.getElementById('bot');
  const launcher = document.getElementById('bot-launcher');
  const log = root.querySelector('.log');
  const options = root.querySelector('.options');
  const form = root.querySelector('form');
  const field = form.querySelector('input');
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const STATUS_URL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? 'status.local.json'
    : 'https://gist.githubusercontent.com/N3uralCreativity/d7df8d80e3e844114aa9b90c700e2b84/raw/status.json';
  let data;
  let state = {};
  let opener = null;

  const add = (node) => {
    log.append(node);
    log.scrollTop = log.scrollHeight;
  };
  const line = (who, text) => {
    const p = document.createElement('p');
    p.className = `msg from-${who}`;
    p.textContent = text;
    add(p);
  };
  const pause = (ms) => new Promise((r) => setTimeout(r, calm ? 0 : ms));

  /** Shows the bot's lines one by one, each after a short "typing" moment, then the ways to answer. */
  const show = async (turn) => {
    stopWaiting();
    state = turn.state;
    options.replaceChildren();
    form.hidden = true;
    for (const text of turn.say) {
      const dots = document.createElement('p');
      dots.className = 'typing';
      dots.setAttribute('aria-hidden', 'true');
      dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
      add(dots);
      await pause(Math.min(900, 250 + text.length * 6));
      dots.remove();
      line('bot', text);
    }
    if (turn.report) {
      const box = document.createElement('div');
      box.className = 'report';
      const link = document.createElement('a');
      link.className = 'button';
      link.href = turn.report.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open the report on GitHub';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy the report';
      const text = document.createElement('textarea');
      text.readOnly = true;
      text.rows = 6;
      text.value = `${turn.report.title}\n\n${turn.report.body}`;
      text.setAttribute('aria-label', 'Report text to copy');
      copy.addEventListener('click', () => void navigator.clipboard?.writeText(text.value).then(() => (copy.textContent = 'Copied')));
      box.append(link, copy, text);
      add(box);
    }
    options.replaceChildren(
      ...(turn.choices ?? []).map((c) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = c.label;
        b.addEventListener('click', () => void answer(c.value, c.label));
        return b;
      }),
    );
    form.hidden = !turn.text;
    if (turn.wait) waitForCheck();
    log.scrollTop = log.scrollHeight;
    (turn.text ? field : options.querySelector('button'))?.focus({ preventScroll: true });
  };

  /** A check is running: dots stay up and the result is fetched every 20 s, for up to 25 minutes. */
  let waiting = 0;
  function stopWaiting() {
    clearInterval(waiting);
    waiting = 0;
    log.querySelector('.waiting')?.remove();
  }
  function waitForCheck() {
    const dots = document.createElement('p');
    dots.className = 'typing waiting';
    dots.setAttribute('role', 'status');
    dots.setAttribute('aria-label', 'Waiting for the check');
    dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    add(dots);
    const started = Date.now();
    const poll = async () => {
      if (state.step !== 'waiting') return stopWaiting();
      if (Date.now() - started > 25 * 60_000) return void show(step(state, '__timeout', data));
      const next = await get(`${STATUS_URL}?t=${Date.now()}`);
      if (state.step === 'waiting' && next && next.checkedAt !== state.waitingFor) {
        data = { ...data, status: next };
        void show(step(state, '__status', data));
      }
    };
    void poll();
    waiting = setInterval(poll, 20_000);
  }

  const restart = () => {
    log.replaceChildren();
    return show(step({}, undefined, data));
  };
  const answer = async (value, label) => {
    if (value === '__restart') return restart();
    line('you', label ?? value);
    return show(step(state, value, data));
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = field.value.trim();
    if (!v) return;
    field.value = '';
    void answer(v);
  });

  const get = (url) =>
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  const open = async () => {
    opener = document.activeElement;
    root.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    if (data) return (options.querySelector('button') ?? field).focus();
    const [flows, sites, status] = await Promise.all([get('flows.json'), get('sites.json'), get(STATUS_URL)]);
    if (!flows || !sites) return line('bot', 'The helper couldn’t load. Reload the page to try again.');
    data = { flows, sites, status };
    return restart();
  };
  const close = () => {
    root.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    (opener instanceof HTMLElement && opener !== document.body ? opener : launcher).focus();
  };

  for (const b of document.querySelectorAll('[data-open-bot]')) b.addEventListener('click', () => void open());
  root.querySelector('.bot-close').addEventListener('click', close);
  root.querySelector('.bot-restart').addEventListener('click', () => data && void restart());
  root.addEventListener('keydown', (e) => e.key === 'Escape' && close());
}
