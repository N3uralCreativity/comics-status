// The support bot on the status page: scripted, no AI, no server. The conversation is a pure
// reducer (step) over flows.json, sites.json and status.json, so it can be tested on recorded
// conversations; the DOM part at the bottom only draws it. Nothing typed leaves the page until the
// reader opens the GitHub link it builds.

export const ISSUE_REPO = 'https://github.com/N3uralCreativity/comix-status';
const STATE_TEXT = { up: 'working', challenge: 'working, may ask for a browser check', down: 'down', unknown: 'in an unknown state (the site turned the checker away)' };

const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const norm = (s) => s.toLowerCase().replace(/[’']/g, "'");

/** hh:mm:ss mm/dd/yyyy in the reader's own time zone. */
export function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
}

/** The site the text names: its name, id or domain. */
export function matchSite(text, sites) {
  const t = norm(text);
  return sites.find((s) => {
    const host = new URL(s.home).hostname.replace(/^www\./, '');
    return [s.name, s.id, host, host.split('.')[0]].some((w) => new RegExp(`(^|[^a-z0-9])${norm(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(t));
  });
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
export function step(state, input, { flows, sites, status }) {
  const say = [];
  const s = { ...state };
  const site = () => sites.find((x) => x.id === s.site);
  const vars = () => ({ site: site()?.name ?? 'the site', note: site()?.note ?? '' });
  const listed = sites.filter((x) => ['supported', 'beta', 'rework'].includes(x.status));

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
    else say.push(`${meta.name} is ${STATE_TEXT[check.state]}. Last checked ${when(check.checkedAt)}.`);
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
    case 'start': {
      s.text = String(input ?? '').slice(0, 2000);
      const found = matchSite(s.text, sites);
      if (found) {
        s.site = found.id;
        out = afterSite();
      } else {
        s.step = 'site';
        say.push(flows.askSite);
        out = { say, choices: [...choices(listed.map((x) => ({ id: x.id, label: x.name }))), { label: flows.otherSite, value: '__other' }] };
      }
      break;
    }
    case 'site':
      if (input === '__other' || !sites.some((x) => x.id === input)) {
        out = end(flows.notListed);
        break;
      }
      s.site = input;
      out = afterSite();
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
      out = { say, choices: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }] };
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
    log.scrollTop = log.scrollHeight;
    (turn.text ? field : options.querySelector('button'))?.focus({ preventScroll: true });
  };

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

  const get = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
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
