// Checks each site in sites.json once and records the result in the gist's status.json.
// Runs every 30 minutes from GitHub Actions (.github/workflows/probe.yml).
//   node probe.mjs              check, then write the gist (needs GIST_TOKEN)
//   node probe.mjs --dry [out]  check and print; with a file name, also write the result there
// A site's shown state only changes after two identical results in a row, so one bad check
// from GitHub's network never flips a site to "down".
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GIST_ID = 'd7df8d80e3e844114aa9b90c700e2b84';
export const STATUS_URL = `https://gist.githubusercontent.com/N3uralCreativity/${GIST_ID}/raw/status.json`;
const TIMEOUT_MS = 20_000;
// Not "Mozilla/…": MangaDex sends anything calling itself a browser to its human check.
const UA = 'ComicsDownloaderStatus/1.0 (+https://status.n3uralcreativity.top)';

const CHALLENGE = /just a moment|bot challenge|checking your browser|verify you are human|performing security verification|challenge-platform|cf-chl/i;
const PARKED = /domain (?:name )?(?:is |may be )?for sale|buy this domain|this domain has expired|parkingcrew|sedoparking|bodis\.com|domain parking/i;

/**
 * One check's verdict. `answer` is { status, headers, body } or { error }.
 *   up         2xx, and the page names the site
 *   challenge  a browser check stands in front of the page (the site is up)
 *   down       no answer (DNS, TLS, timeout), a server error, or a parked domain
 *   unknown    an answer that says nothing either way, such as a 403 for the probe itself
 */
export function classify(answer, expect) {
  if (answer.error) return 'down';
  const { status, headers, body } = answer;
  if (headers.get('cf-mitigated') === 'challenge') return 'challenge';
  // Sent on to the site's own check page (MangaDex: /edge/challenge).
  if (/\/challenge\b/.test(new URL(answer.url ?? 'about:blank').pathname)) return 'challenge';
  if ((status === 403 || status === 429 || status === 503) && CHALLENGE.test(body)) return 'challenge';
  if (status >= 500) return 'down'; // includes Cloudflare's 52x "origin unreachable" and 530
  if (PARKED.test(body)) return 'down';
  if (status >= 200 && status < 300) {
    if (body.toLowerCase().includes(expect.toLowerCase())) return 'up';
    return CHALLENGE.test(body) ? 'challenge' : 'unknown';
  }
  return 'unknown';
}

/** The site's entry after one more check. */
export function next(prev, verdict, now) {
  if (!prev) return { state: verdict, since: now, checkedAt: now, last: verdict, streak: 1 };
  const streak = verdict === prev.last ? prev.streak + 1 : 1;
  const change = verdict !== prev.state && streak >= 2;
  return { state: change ? verdict : prev.state, since: change ? now : prev.since, checkedAt: now, last: verdict, streak };
}

/**
 * One request with curl, not Node's fetch: from GitHub's network Cloudflare turned fetch away on 10
 * sites while curl reached 9 of them (tested 2026-11-21). The status line, final address and the
 * challenge header go to stderr; the page to stdout.
 */
function ask(url) {
  const meta = '%{stderr}%{http_code}\\n%{url_effective}\\n%header{cf-mitigated}';
  const args = ['-s', '-L', '--max-time', String(TIMEOUT_MS / 1000), '-A', UA, '-H', 'accept: text/html', '-w', meta, url];
  return new Promise((done) => {
    execFile('curl', args, { encoding: 'utf8', maxBuffer: 20_000_000 }, (err, body, info) => {
      // The last three lines: some curl builds print a warning of their own first.
      const [code, final, mitigated] = info.split('\n').slice(-3);
      if (err || code === '000') return done({ error: err?.code === 'ENOENT' ? 'curl not found' : `curl exit ${err?.code ?? 0}` });
      const headers = new Headers(mitigated?.trim() ? { 'cf-mitigated': mitigated.trim() } : {});
      done({ status: Number(code), headers, body: body.slice(0, 200_000), url: final });
    });
  });
}

async function main() {
  const dry = process.argv.includes('--dry');
  const out = dry ? process.argv[process.argv.indexOf('--dry') + 1] : undefined;
  const sites = JSON.parse(readFileSync(new URL('./sites.json', import.meta.url), 'utf8')).filter((s) => s.probe);
  const before = await fetch(STATUS_URL, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const now = new Date().toISOString();
  const result = { v: 1, checkedAt: now, sites: {} };
  for (const s of sites) {
    const answer = await ask(s.probe.url);
    const verdict = classify(answer, s.probe.expect);
    result.sites[s.id] = next(before?.sites?.[s.id], verdict, now);
    console.log(`${s.id.padEnd(12)} ${verdict.padEnd(9)} ${answer.error ?? answer.status}`);
  }
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (dry) {
    if (out) writeFileSync(out, json);
    return;
  }
  const token = process.env.GIST_TOKEN;
  if (!token) throw new Error('GIST_TOKEN is not set');
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify({ files: { 'status.json': { content: json } } }),
  });
  if (!res.ok) throw new Error(`Gist update failed: HTTP ${res.status}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
