// Builds the site's game pages: ports.html (the showcase: a featured banner, rows of covers),
// todos.html (every game, with search and filters) and one page per game (port-<id>.html for
// the ports Black Flag verifies, jogo-<slug>.html for the community ones). Run when the site is
// published and once a day:
//
//   node tools/site-games.mjs site       (GITHUB_TOKEN raises GitHub's limits; SGDB_KEY adds art)
//
// The games are the same the program shows: its verified catalog, and the Comunidade list (the
// curated awesome-unofficial-pc-ports list plus GitHub topic searches, as community.rs does).
// Pages are plain HTML, readable without JavaScript and by search engines; games.js only adds the
// carousel, the row arrows and the filters. Art comes from SteamGridDB (credited on each page) and
// is kept in img/games/ between runs (the workflow caches it), so each day only new games are
// looked up. A game with no art gets a cover drawn in CSS, as in the program.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] || 'site';
const catalog = JSON.parse(readFileSync(join(out, 'catalog.json'), 'utf8'));
const APP = 'https://github.com/recomphub-app/recomphub';
const SITE = 'https://recomphub-app.github.io/recomphub/';
const LIST_URL = 'https://raw.githubusercontent.com/Sebastrion/awesome-unofficial-pc-ports/main/README.md';
// Word searches, as the program does (community.rs QUERIES): many new ports have no topic.
const QUERIES = ['recomp+in:name,description+stars:>=5', 'recompilation+in:description+stars:>=5', '%22pc+port%22+in:name,description+stars:>=5',
  '%22native+port%22+in:name,description+stars:>=5', '%22static+recompilation%22+in:description+stars:>=5'];
const NOT_A_PORT = ['tracker', 'trackers', 'tools', 'status', 'monitor', 'benchmark', 'archive', 'icons', 'wallpaper', 'website', 'mirror', 'launcher', 'map',
  'tool', 'toolkit', 'template', 'guide', 'awesome', 'list of', 'widget', 'discord', 'bot'];
const looksLikeATool = (name, desc) => {
  const n = String(name).toLowerCase().replace(/[-_]/g, ' ').split(/s+/);
  const d = String(desc || '').toLowerCase();
  return NOT_A_PORT.some((w) => n.some((x) => x === w) || d.startsWith(`${w} `)) || d.includes('tracker') || d.includes('progress of') || d.includes('port status');
};
const TOPICS = ['pc-port', 'native-port', 'game-port', 'n64recomp', 'xenonrecomp', 'rexglue', 'ps3recomp', 'ps2recomp', 'pc-ports', 'unofficial-port'];
const NOTES = 5;
const ART_DIR = join(out, 'img', 'games');
const ART_INDEX = join(ART_DIR, 'index.json');
/// New art lookups per run (each is three SteamGridDB requests); the rest wait for the next day.
const ART_PER_RUN = Number(process.env.ART_PER_RUN || 150);
const ART_RETRY_DAYS = 14;
const DAY = 86400e3;
const now = Date.now();

// ---- Small helpers ----

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const numberPt = (n) => (n >= 1e6 ? `${(n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`
  : n >= 1e4 ? `${Math.round(n / 1e3).toLocaleString('pt-BR')} mil`
  : n >= 1e3 ? `${(n / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : String(n));
const datePt = (t) => (t ? new Date(t).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');
const ago = (t) => {
  if (!t) return '';
  const d = Math.max(0, Math.floor((now - new Date(t).getTime()) / DAY));
  return d === 0 ? 'hoje' : d === 1 ? 'ontem' : d < 30 ? `há ${d} dias` : d < 365 ? `há ${Math.round(d / 30)} ${Math.round(d / 30) === 1 ? 'mês' : 'meses'}` : `há ${Math.round(d / 365)} ${Math.round(d / 365) === 1 ? 'ano' : 'anos'}`;
};
const version = (tag) => String(tag || '').replace(/^[a-z-]*?v(?=\d)/i, 'v');
const plain = (s) => String(s).toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
const slugOf = (repo) => `gh-${repo.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 60)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A word-ish name from a repository's: "mojo-ps2-recomp" -> "mojo ps2 recomp".
const pretty = (name) => name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
// "Em alta": stars that keep counting while the project is alive (the program's own rule).
const trending = (g) => ((g.stars || 0) + 1) / (1 + (g.pushed ? Math.max(0, (now - g.pushed) / DAY) : 3650) / 30);

async function api(path) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'BlackFlag-site' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(path.startsWith('http') ? path : `https://api.github.com/${path}`, { headers });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// Runs `fn` over `list`, `n` at a time.
async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) {
      const k = i++;
      await fn(list[k], k);
    }
  }));
}

// ---- Consoles: one name and one colour each ----

const CONSOLES = [
  [/nintendo 64|n64/i, 'Nintendo 64', '#e3342f'],
  [/gamecube/i, 'GameCube', '#7b5cd6'],
  [/wii u/i, 'Wii U', '#2fa3d6'],
  [/\bwii\b/i, 'Wii', '#9aa5b1'],
  [/switch 2/i, 'Nintendo Switch 2', '#e60012'],
  [/switch/i, 'Nintendo Switch', '#e60012'],
  [/super nintendo|snes/i, 'Super Nintendo', '#8c7ae6'],
  [/game boy advance|gba/i, 'Game Boy Advance', '#5c6bc0'],
  [/game boy/i, 'Game Boy', '#8bac0f'],
  [/nintendo ds|\bnds\b|\bds\b/i, 'Nintendo DS', '#b0b7c3'],
  [/3ds/i, 'Nintendo 3DS', '#d12229'],
  [/\bnes\b|famicom/i, 'NES', '#c0392b'],
  [/playstation 5|ps5/i, 'PlayStation 5', '#3d7be0'],
  [/playstation 4|ps4/i, 'PlayStation 4', '#2f6bd6'],
  [/playstation 3|ps3/i, 'PlayStation 3', '#4a7fd1'],
  [/playstation 2|ps2/i, 'PlayStation 2', '#3657c8'],
  [/psp|portable/i, 'PSP', '#6c7a89'],
  [/vita/i, 'PS Vita', '#3f6fb6'],
  [/playstation|ps1|psx/i, 'PlayStation', '#8e9aaf'],
  [/xbox 360|x360/i, 'Xbox 360', '#5fb33a'],
  [/xbox one|series/i, 'Xbox One', '#3a9a2f'],
  [/xbox/i, 'Xbox', '#2ca02c'],
  [/dreamcast/i, 'Dreamcast', '#f39c12'],
  [/saturn/i, 'Saturn', '#7f8c8d'],
  [/mega drive|genesis|sega/i, 'Mega Drive', '#2980b9'],
  [/arcade|neo ?geo/i, 'Arcade', '#d35400'],
  [/^pc$|windows|dos/i, 'PC', '#95a5a6'],
];
function consoleOf(text) {
  for (const [re, name, color] of CONSOLES) if (re.test(text || '')) return { name, color };
  return { name: '', color: '#8a8378' };
}
const TOPIC_CONSOLE = { n64recomp: 'Nintendo 64', xenonrecomp: 'Xbox 360', rexglue: 'Xbox 360', ps3recomp: 'PlayStation 3', ps2recomp: 'PlayStation 2' };

// ---- The game a repository ports, from its description (as community.rs guess_game) ----

const GAME_KEYS = ['port', 'recompilation', 'recomp', 'decompilation', 'decomp', 'reimplementation', 'remake', 'rewrite'];
const TITLE_STOPS = [' for windows', ' for pc', ' for linux', ' for the ', ' using ', ' via ', ' with ', ' built ', ' running ', ' from ', ' powered ', ' to native', ' into ', ' on pc', ' on windows', ' as a ', ' done', ' game'];
const SENTENCE_STARTS = ['a ', 'an ', 'the original', 'the game', 'the xbox', 'your ', 'native ', 'unofficial', 'experimental', 'pc ', 'play ', 'how ', 'library', 'shared', 'advanced', 'moved', 'here ', 'matching', 'this ', 'my ', 'fully', 'community', 'official', 'static', 'rt64', 'n64modernruntime', 'definitive', 'run ', 'build', 'decomp ', 'native', 'ge'];
function cutTitle(t) {
  let end = t.length;
  for (const e of ['(', '[', ',', ';', '. ', '|', '—', '–', ' - ', ' // ']) { const i = t.indexOf(e); if (i >= 0) end = Math.min(end, i); }
  const l = t.toLowerCase();
  for (const s of TITLE_STOPS) { const i = l.indexOf(s); if (i >= 0) end = Math.min(end, i); }
  return t.slice(0, end).trim().replace(/[.:]+$/, '').trim();
}
function plausible(name) {
  const l = name.toLowerCase();
  // A title starts with a capital or a digit ("the Xbox 360 version of..." is a sentence).
  return name.length >= 2 && name.length <= 50 && /^[A-Z0-9]/.test(name) && !SENTENCE_STARTS.some((b) => l.startsWith(b))
    && !GAME_KEYS.some((k) => l.endsWith(k)) && !/\b(windows|linux|macos)\b/.test(l);
}
function guessGame(desc) {
  const d = String(desc || '').split(/[|\n]/)[0];
  const l = d.toLowerCase();
  for (const k of GAME_KEYS) {
    const at = l.indexOf(k);
    if (at < 0) continue;
    const of = l.indexOf(' of ', at);
    if (of < 0 || of - at > 40) continue;
    let name = cutTitle(d.slice(of + 4));
    // "of the Xbox 360 version of Need for Speed": the game comes after the version.
    const v = name.toLowerCase().indexOf(' version of ');
    if (v >= 0) name = name.slice(v + 12).trim();
    if (plausible(name)) return name;
  }
  // A title at the start: "Gears of War 2 native PC port".
  let end = d.length;
  for (const w of [' native', ' pc port', ' port', ' static', ' running', ' as a ', ' recomp', ' decomp', ': a ', ' (', ' —', ' –', ' - ', '. ']) {
    const i = l.indexOf(w);
    if (i > 0 && i < end) end = i;
  }
  const start = d.slice(0, end).trim().replace(/[.:]+$/, '').trim();
  return plausible(start) ? start : '';
}
const notForPc = (d) => {
  const s = ` ${String(d || '').toLowerCase()} `;
  return ['3ds', 'ps vita', 'psvita', 'nintendo switch', 'wii u', 'android port', 'for android', 'iphone', 'ipad', ' ios'].some((o) => s.includes(o))
    && ![' pc', 'pc ', 'windows', 'linux', 'desktop', 'steam deck'].some((p) => s.includes(p));
};

// ---- Gathering the games ----

function parseAwesome(md) {
  const items = [];
  let section = '';
  let game = '';
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('## ')) section = line.slice(3).replace(/^[^\p{L}\p{N}]+/u, '').trim();
    else if (line.startsWith('<summary><strong>')) game = line.slice(17).split('</strong>')[0].trim();
    else if (line.startsWith('### ')) {
      let rest = line.slice(4);
      const recommended = rest.startsWith('⭐');
      rest = rest.replace(/^⭐\s*/, '');
      const m = rest.match(/^\[([^\]]+)\]\((https?:\/\/github\.com\/[^)\s]+)\)/);
      if (!m || /utilit/i.test(section)) continue;
      const parts = m[2].replace(/^https?:\/\/github\.com\//, '').split(/[/#?]/);
      if (parts.length < 2 || !parts[0] || !parts[1]) continue;
      items.push({ repo: `${parts[0]}/${parts[1].replace(/\.git$/, '')}`, name: m[1], game, section, recommended });
    }
  }
  return items;
}

async function community() {
  const byRepo = new Map();
  const add = (it) => {
    const key = it.repo.toLowerCase();
    const had = byRepo.get(key);
    byRepo.set(key, had ? { ...it, ...had, game: had.game || it.game, console: had.console || it.console, recommended: had.recommended || it.recommended } : it);
  };
  try {
    const r = await fetch(LIST_URL);
    if (r.ok) for (const it of parseAwesome(await r.text())) add({ repo: it.repo, name: it.name, game: it.game, console: consoleOf(it.section).name || it.section, recommended: it.recommended, fromList: true });
  } catch (e) {
    console.warn(`lista: ${e.message}`);
  }
  const searches = [...QUERIES.map((q) => [`${q}+archived:false`, 'updated', true]), ...QUERIES.map((q) => [`${q}+archived:false`, 'stars', true]),
    ...TOPICS.flatMap((t) => ['stars', 'updated'].map((sort) => [`topic:${t}+fork:true+archived:false`, sort, false]))];
  for (const [query, sort, words] of searches) {
    {
      const topic = words ? '' : query.slice(6, query.indexOf('+'));
      try {
        const res = await api(`search/repositories?q=${query}&sort=${sort}&order=desc&per_page=100`);
        for (const i of res.items || []) {
          if (i.archived || (i.fork && i.stargazers_count < 20) || /awesome/i.test(i.name) || (i.topics || []).some((t) => t.startsWith('awesome'))) continue;
          if (notForPc(i.description) || (words && looksLikeATool(i.name, i.description))) continue;
          add({
            repo: i.full_name, name: i.name, game: guessGame(i.description), description: i.description || '',
            console: TOPIC_CONSOLE[topic] || (i.topics || []).map((t) => consoleOf(t.replace(/-/g, ' ')).name).find(Boolean) || consoleOf(i.description).name,
            stars: i.stargazers_count, pushed: Date.parse(i.pushed_at) || 0, created: Date.parse(i.created_at) || 0,
            license: i.license && i.license.spdx_id !== 'NOASSERTION' ? i.license.spdx_id : '', topics: i.topics || [], owner: i.owner && i.owner.login,
          });
        }
      } catch (e) {
        console.warn(`busca ${topic}/${sort}: ${e.message}`);
      }
      await sleep(process.env.GITHUB_TOKEN ? 2200 : 6500);
    }
  }
  // The list's ports the searches did not show: their numbers, one request each.
  const missing = [...byRepo.values()].filter((g) => g.stars === undefined);
  await pool(missing, 8, async (g) => {
    try {
      const r = await api(`repos/${g.repo}`);
      Object.assign(g, {
        repo: r.full_name, description: r.description || '', stars: r.stargazers_count, pushed: Date.parse(r.pushed_at) || 0, created: Date.parse(r.created_at) || 0,
        license: r.license && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : '', owner: r.owner && r.owner.login, archived: r.archived,
      });
      if (!g.console) g.console = consoleOf(r.description).name;
    } catch {
      g.gone = true;
    }
  });
  return [...byRepo.values()].filter((g) => !g.gone && !g.archived);
}

// The facts sheet of a verified port, as in the program (facts.rs).
async function facts(port) {
  try {
    const [repo, list] = await Promise.all([api(`repos/${port.repo}`), api(`repos/${port.repo}/releases?per_page=100`)]);
    const shown = list.filter((r) => !r.draft);
    const stable = shown.find((r) => !r.prerelease) || shown[0];
    const win = stable && stable.assets.find((a) => a.name.startsWith(port.asset_prefix) && a.name.endsWith(port.asset_suffix));
    return {
      description: repo.description || '', stars: repo.stargazers_count || 0, issues: repo.open_issues_count || 0,
      pushed: Date.parse(repo.pushed_at) || 0, created: Date.parse(repo.created_at) || 0,
      license: repo.license && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : '',
      releases: shown.length, downloads: shown.flatMap((r) => r.assets).reduce((n, a) => n + (a.download_count || 0), 0),
      first: shown.map((r) => r.published_at).filter(Boolean).sort()[0] || '',
      latest: stable ? { tag: stable.tag_name, when: stable.published_at, size: win ? win.size : 0 } : null,
      notes: (shown.some((r) => !r.prerelease) ? shown.filter((r) => !r.prerelease) : shown).slice(0, NOTES).map((r) => ({ tag: r.tag_name, when: r.published_at, body: (r.body || '').trim().slice(0, 3000) })),
    };
  } catch (e) {
    console.warn(`sem ficha para ${port.repo}: ${e.message}`);
    return null;
  }
}

// ---- Art from SteamGridDB, kept between runs ----

const SGDB = 'https://www.steamgriddb.com/api/v2';
const FILTERS = 'types=static&nsfw=false&humor=false&epilepsy=false';
const MAX_IMAGE = 8 * 1024 * 1024;
let artIndex = {};
try { artIndex = JSON.parse(readFileSync(ART_INDEX, 'utf8')); } catch {}

async function sgdb(path) {
  const r = await fetch(`${SGDB}${path}`, { headers: { Authorization: `Bearer ${process.env.SGDB_KEY}` } });
  if (r.status === 429) { await sleep(5000); throw new Error('SteamGridDB 429'); }
  if (!r.ok) throw new Error(`SteamGridDB ${r.status}`);
  return (await r.json()).data;
}

async function keep(list, file) {
  for (const it of list || []) {
    let url;
    try { url = new URL(it.thumb || it.url); } catch { continue; }
    if (url.protocol !== 'https:' || !/(^|\.)steamgriddb\.com$/.test(url.hostname)) continue;
    const ext = (url.pathname.match(/\.(png|jpe?g|webp)$/i) || [])[1];
    if (!ext) continue;
    const r = await fetch(url);
    const bytes = r.ok ? Buffer.from(await r.arrayBuffer()) : null;
    if (!bytes || bytes.length > MAX_IMAGE) continue;
    const name = `${file}.${ext.toLowerCase()}`;
    writeFileSync(join(ART_DIR, name), bytes);
    return { src: `img/games/${name}`, author: (it.author && it.author.name) || '' };
  }
  return null;
}

let lookups = 0;
// Cover (tall, as a box on a shelf) and banner for a game; null when there is none.
async function art(slug, title) {
  const had = artIndex[slug];
  const fresh = had && (had.cover || had.banner || now - (had.tried || 0) < ART_RETRY_DAYS * DAY);
  const present = (a) => a && existsSync(join(out, a.src));
  if (fresh && (!had.cover || present(had.cover)) && (!had.banner || present(had.banner))) return had;
  if (!process.env.SGDB_KEY || !title || lookups >= ART_PER_RUN) return had && (present(had.cover) || present(had.banner)) ? had : null;
  lookups++;
  try {
    const found = await sgdb(`/search/autocomplete/${encodeURIComponent(title)}`);
    const want = plain(title);
    const game = (found || []).find((g) => plain(g.name) === want) || (found || [])[0];
    let got = { tried: now, cover: null, banner: null };
    if (game) {
      const tall = await sgdb(`/grids/game/${game.id}?dimensions=600x900,660x930&${FILTERS}`);
      const heroes = await sgdb(`/heroes/game/${game.id}?${FILTERS}`);
      got = { tried: now, cover: await keep(tall, `${slug}-capa`), banner: await keep(heroes, `${slug}-banner`) };
    }
    artIndex[slug] = got;
    return got;
  } catch (e) {
    console.warn(`sem arte para ${title}: ${e.message}`);
    return had || null;
  }
}

// ---- Markup ----

// Markdown from each project, shown as text (its HTML never enters the page).
function notesText(body) {
  return esc(body)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^#{1,6}\s*(.+)$/gm, '<b>$1</b>')
    .replace(/^\s*[-*]\s+/gm, '• ').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^&gt;\s?/gm, '')
    .replace(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/g, '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n');
}

// One of four patterns for a game without art, picked by its name (as the program's genCover).
function seed(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

function cover(g, { big = false } = {}) {
  if (g.art && g.art.cover) {
    return `<div class="gc-art${big ? ' big' : ''}"><img src="${esc(g.art.cover.src)}" alt="" loading="lazy" decoding="async"></div>`;
  }
  const h = seed(g.game || g.name);
  return `<div class="gc-art gen m${h % 4}${big ? ' big' : ''}" style="--a:${h % 160 + 10}deg;--x:${h % 70 + 15}%;--c:${g.color}" aria-hidden="true">
      <span class="gen-sys">${esc(g.console || 'Port')}</span><span class="gen-title">${esc(g.game || g.name)}</span></div>`;
}

function card(g, { rank = 0 } = {}) {
  const flags = [g.verified ? '<span class="gc-flag ok" title="Verificado pelo Black Flag">Verificado</span>' : '',
    g.recommended && !g.verified ? '<span class="gc-flag" title="O mais fácil de jogar, segundo a lista da comunidade">Recomendado</span>' : ''].join('');
  return `<a class="gcard" href="${esc(g.page)}" data-name="${esc(plain(`${g.name} ${g.game} ${g.console} ${g.owner || ''}`))}" data-console="${esc(g.console)}" data-stars="${g.stars || 0}" data-pushed="${g.pushed || 0}" data-created="${g.created || 0}" data-trend="${trending(g).toFixed(3)}" data-verified="${g.verified ? 1 : 0}">
    <div class="gc-cover">${cover(g)}${rank ? `<span class="gc-rank">${rank}</span>` : ''}${flags ? `<span class="gc-flags">${flags}</span>` : ''}
      ${g.stars ? `<span class="gc-stars"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z"/></svg>${numberPt(g.stars)}</span>` : ''}</div>
    <b class="gc-name">${esc(g.name)}</b>
    ${g.game && plain(g.game) !== plain(g.name) ? `<span class="gc-game">${esc(g.game)}</span>` : '<span class="gc-game">&nbsp;</span>'}
    <span class="gc-sys"><i style="background:${g.color}"></i>${esc(g.console || 'Console não informado')}</span>
  </a>`;
}

function row(title, list, { more = '', ranks = false, note = '' } = {}) {
  if (!list.length) return '';
  const id = plain(title);
  return `
    <section class="shelf-row" aria-labelledby="r-${id}">
      <div class="row-head">
        <h2 id="r-${id}">${more ? `<a href="${esc(more)}">${esc(title)}<span aria-hidden="true">›</span></a>` : esc(title)}</h2>
        ${note ? `<p class="row-note">${note}</p>` : ''}
        <div class="row-arrows" hidden><button class="arrow" data-dir="-1" aria-label="Voltar">‹</button><button class="arrow" data-dir="1" aria-label="Avançar">›</button></div>
      </div>
      <div class="row-track">${list.map((g, i) => card(g, { rank: ranks ? i + 1 : 0 })).join('')}</div>
    </section>`;
}

function head(title, description, path, image, current) {
  const link = (href, label, key) => `<a href="${href}"${current === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${SITE}${path}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:image" content="${SITE}${image || 'img/biblioteca.jpg'}">
  <meta name="theme-color" content="#08080a">
  <link rel="icon" href="img/icone.png">
  <link rel="preload" href="fonts/archivo.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="style.css?v=4">
  <link rel="stylesheet" href="ports.css?v=4">
  <link rel="stylesheet" href="games.css?v=1">
  <script src="games.js?v=1" defer></script>
</head>
<body class="games-site">
  <div class="glow" aria-hidden="true"></div>
  <header class="bar">
    <a class="brand" href="./"><img class="logo" src="img/logo.svg" alt="" width="34" height="34">Black <span>Flag</span></a>
    <nav class="crumbs" aria-label="Seções do site">
      ${link('./', 'Visão geral', 'home')}${link('ports.html', 'Descobrir', 'discover')}${link('todos.html', 'Todos os jogos', 'all')}${link('todos.html?ordem=novos', 'Novidades', 'new')}
    </nav>
    <a class="button small bar-dl" href="${APP}/releases/latest">Baixar</a>
  </header>`;
}

const foot = (built) => `
  <footer>
    <p><b>Nenhum arquivo de jogo aqui.</b> O Black Flag e os projetos listados trazem só os ports e as ferramentas. Todo jogo
      precisa da sua própria cópia, obtida legalmente. Os ports pertencem aos seus autores; marcas e jogos pertencem aos seus
      donos. O Black Flag não tem ligação com Nintendo, Sony, Microsoft ou outras empresas.</p>
    <p class="muted">Números lidos do GitHub de cada projeto em ${esc(built)}. Os ports da Comunidade vêm da lista
      <a href="https://github.com/Sebastrion/awesome-unofficial-pc-ports">awesome-unofficial-pc-ports</a> e de buscas no GitHub, e
      não são verificados pelo Black Flag. Capas e banners da SteamGridDB, enviados pela comunidade dela, com o crédito em cada
      página. Se uma imagem é sua e você quer que ela saia, <a href="${APP}/issues">abra um pedido no GitHub do Black Flag</a>.</p>
    <p><a href="${APP}">Código no GitHub</a><a href="${APP}/issues">Relatar um problema</a><a href="${APP}/releases">Todas as versões</a></p>
  </footer>
</body>
</html>
`;

function artCredit(a) {
  if (!a || !(a.cover || a.banner)) return '';
  const by = (x, word) => (x.author ? ` ${word} por ${esc(x.author)}` : '');
  const parts = [a.cover && `capa${by(a.cover, 'enviada')}`, a.banner && `banner${by(a.banner, 'enviado')}`].filter(Boolean);
  return `<p class="muted art-credit">Imagens da <a href="https://www.steamgriddb.com/">SteamGridDB</a>: ${parts.join('; ')}.</p>`;
}

// ---- Pages ----

function hero(list) {
  const slides = list.map((g, i) => `
      <a class="slide${i === 0 ? ' on' : ''}" href="${esc(g.page)}" data-i="${i}"${i ? ' aria-hidden="true" tabindex="-1"' : ''}>
        <img class="slide-bg" src="${esc(g.art.banner.src)}" alt="" ${i ? 'loading="lazy"' : 'fetchpriority="high"'} decoding="async">
        <div class="slide-text">
          <span class="slide-pill">${g.verified ? 'Verificado pelo Black Flag' : g.created && now - g.created < 45 * DAY ? 'Novo no GitHub' : 'Em alta'}</span>
          <span class="slide-sys"><i style="background:${g.color}"></i>${esc(g.console || 'Port')}${g.game && plain(g.game) !== plain(g.name) ? ` · ${esc(g.game)}` : ''}</span>
          <strong class="slide-title">${esc(g.name)}</strong>
          ${g.description ? `<span class="slide-desc">${esc(g.description.length > 180 ? `${g.description.slice(0, 177).trimEnd()}…` : g.description)}</span>` : ''}
        </div>
      </a>`).join('');
  return list.length ? `
    <section class="hero-carousel" aria-roledescription="carrossel" aria-label="Destaques">
      <div class="slides">${slides}</div>
      ${list.length > 1 ? `<div class="dots" role="tablist">${list.map((g, i) => `<button role="tab" aria-selected="${i === 0}" aria-label="${esc(g.name)}" data-go="${i}"><span></span></button>`).join('')}</div>` : ''}
    </section>` : '';
}

function discoverPage(all, built) {
  const byTrend = [...all].sort((a, b) => trending(b) - trending(a));
  const featured = [...all.filter((g) => g.verified), ...byTrend].filter((g, i, l) => g.art && g.art.banner && l.indexOf(g) === i).slice(0, 6);
  const consoles = Object.entries(all.reduce((m, g) => { if (g.console) m[g.console] = (m[g.console] || 0) + 1; return m; }, {}))
    .filter(([, n]) => n >= 6).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c]) => c);
  const recent = all.filter((g) => g.created && now - g.created < 90 * DAY && (g.verified || (g.stars || 0) >= 3)).sort((a, b) => b.created - a.created);
  return `${head('Jogos de console nativos no PC | Black Flag', 'Ports e recomps de jogos de console que rodam nativos no Windows: os verificados pelo Black Flag e centenas da comunidade, com o que está em alta, o que saiu agora e o que foi atualizado.', 'ports.html', featured[0] && featured[0].art.banner.src, 'discover')}
  <main class="discover">
    <div class="disc-head">
      <div>
        <p class="eyebrow">Black Flag</p>
        <h1>Jogos de console, nativos no PC.</h1>
        <p class="lead">Ports e recomps feitos a partir do jogo original. Instale e atualize pelo Black Flag; a cópia do jogo é sempre a sua.</p>
      </div>
      <div class="disc-actions"><a class="button ghost" href="todos.html">Ver os ${all.length} jogos</a><a class="button" href="${APP}/releases/latest">Baixar o Black Flag</a></div>
    </div>
    ${hero(featured)}
    ${row('Em alta esta semana', byTrend.slice(0, 12), { more: 'todos.html?ordem=alta', ranks: true })}
    ${row('Verificados pelo Black Flag', all.filter((g) => g.verified), { note: 'Instalam com um clique e o Black Flag confere os arquivos da sua cópia.' })}
    ${row('Atualizados agora', [...all].filter((g) => g.pushed).sort((a, b) => b.pushed - a.pushed).slice(0, 14), { more: 'todos.html?ordem=atualizados' })}
    ${row('Recém-chegados', recent.slice(0, 14), { more: 'todos.html?ordem=novos' })}
    ${row('Os mais estrelados', [...all].sort((a, b) => (b.stars || 0) - (a.stars || 0)).slice(0, 14), { more: 'todos.html?ordem=estrelas' })}
    ${consoles.map((c) => row(c, byTrend.filter((g) => g.console === c).slice(0, 14), { more: `todos.html?console=${encodeURIComponent(c)}` })).join('')}
  </main>${foot(built)}`;
}

function allPage(all, built) {
  const counts = all.reduce((m, g) => { if (g.console) m[g.console] = (m[g.console] || 0) + 1; return m; }, {});
  const consoles = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const list = [...all].sort((a, b) => trending(b) - trending(a));
  return `${head('Todos os jogos | Black Flag', `Os ${all.length} ports e recomps de jogos de console para PC que o Black Flag conhece, com busca e filtro por console.`, 'todos.html', null, 'all')}
  <main class="all-games">
    <p class="eyebrow">Black Flag</p>
    <h1>Todos os jogos</h1>
    <p class="count-pill"><span id="shown">${all.length}</span> de ${all.length} jogos</p>
    <div class="filters">
      <label class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
        <input type="search" id="q" placeholder="Buscar por jogo, port, console ou autor" aria-label="Buscar"></label>
      <div class="chip-row" role="group" aria-label="Console">
        <button class="fchip on" data-console="">Todos os consoles <span>${all.length}</span></button>
        ${consoles.slice(0, 9).map(([c, n]) => `<button class="fchip" data-console="${esc(c)}">${esc(c)} <span>${n}</span></button>`).join('')}
        ${consoles.length > 9 ? `<label class="more-sel"><select id="more-console" aria-label="Outros consoles"><option value="">Mais ${consoles.length - 9}</option>${consoles.slice(9).map(([c, n]) => `<option value="${esc(c)}">${esc(c)} (${n})</option>`).join('')}</select></label>` : ''}
      </div>
      <div class="chip-row">
        <button class="fchip" id="only-verified" aria-pressed="false">Só os verificados</button>
        <label class="sort">Ordem <select id="sort">
          <option value="alta">Em alta</option><option value="estrelas">Mais estrelas</option><option value="atualizados">Atualizados agora</option>
          <option value="novos">Novos no GitHub</option><option value="nome">Nome (A a Z)</option></select></label>
      </div>
    </div>
    <div class="grid-all" id="grid">${list.map((g) => card(g)).join('')}</div>
    <p class="muted empty" id="empty" hidden>Nenhum jogo com essa busca.</p>
  </main>${foot(built)}`;
}

function side(g) {
  const row2 = (k, v) => (v ? `<div><dt>${k}</dt><dd>${v}</dd></div>` : '');
  const f = g.facts;
  return `
    <aside class="game-side" aria-label="Ficha">
      <div class="side-top">${cover(g)}<div><b>${esc(g.name)}</b><span class="muted">${esc(g.console || 'Port')}</span></div></div>
      <a class="button wide" href="${APP}/releases/latest">Baixar o Black Flag</a>
      <p class="muted side-how">${g.verified ? `No Black Flag, em <b>Instalar ports</b>, o ${esc(g.name)} instala com um clique e o programa confere os arquivos da sua cópia.`
        : `No Black Flag, abra <b>Comunidade</b> e procure ${esc(g.name)}. A instalação é experimental: o Black Flag não verificou este port.`}</p>
      <div class="side-links">
        <a href="https://github.com/${esc(g.repo)}">Ver no GitHub</a>
        <a href="https://github.com/${esc(g.repo)}/releases">Todas as versões</a>
        <a href="https://github.com/${esc(g.repo)}/issues">Relatar um problema no port</a>
      </div>
      <dl>
        ${f && f.latest ? row2('Versão', esc(version(f.latest.tag))) : ''}
        ${row2('Atualizado', g.pushed ? `${ago(g.pushed)}<small>${datePt(g.pushed)}</small>` : '')}
        ${f && f.latest && f.latest.size ? row2('Download', `${Math.max(1, Math.round(f.latest.size / 1048576))} MB`) : ''}
        ${f && f.releases ? row2('Downloads', numberPt(f.downloads)) : ''}
        ${row2('Estrelas no GitHub', g.stars ? numberPt(g.stars) : '')}
        ${f && f.releases ? row2('Versões publicadas', String(f.releases)) : ''}
        ${row2('Criado em', datePt(g.created))}
        ${f ? row2('Problemas abertos', numberPt(f.issues)) : ''}
        ${row2('Licença', esc(g.license || (f && f.license) || 'não informada'))}
      </dl>
      ${artCredit(g.art)}
    </aside>`;
}

function gamePage(g, all, built) {
  const more = all.filter((x) => x !== g && x.console && x.console === g.console).sort((a, b) => trending(b) - trending(a)).slice(0, 12);
  const p = g.port;
  const f = g.facts;
  const chips = [`<span><i style="background:${g.color}"></i>${esc(g.console || 'Console não informado')}</span>`,
    g.verified ? '<span class="ok">Verificado pelo Black Flag</span>' : '<span class="warn">Comunidade: não verificado</span>',
    g.recommended ? '<span>Recomendado pela lista</span>' : '',
    ...(p ? (p.tags || []).filter((t) => t.toLowerCase() !== p.family.toLowerCase()).map((t) => `<span>${esc(t)}</span>`) : [])].join('');
  const verifiedBody = p ? `
        <section class="block needs"><h2>Você fornece</h2><p>${esc(p.needs)}</p><p class="muted">O Black Flag nunca baixa arquivos de jogos. ${esc(p.files_help || '')}</p></section>
        <section class="block"><h2>Como jogar</h2><ol class="steps">
          <li><b>Baixe o Black Flag</b> e abra a seção Instalar ports.</li>
          <li><b>Escolha ${esc(p.title)}</b> e clique em Instalar: ele baixa o ${esc(p.port_name)} da página oficial do projeto.</li>
          <li><b>Aponte a sua cópia.</b> O Black Flag confere os arquivos e diz o que falta. Depois é só jogar.</li></ol>
          <p class="muted">Requisitos: ${esc(p.requirements)}</p></section>
        ${(p.guide || []).length ? `<section class="block"><h2>Bom saber</h2><ul class="guide">${p.guide.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
        ${f && f.notes.length ? `<section class="block"><h2>O que mudou</h2>${f.notes.map((n, i) => `
          <details ${i === 0 ? 'open' : ''}><summary><b>${esc(version(n.tag))}</b><span class="muted">${datePt(n.when)}</span></summary>
          <div class="note-body">${n.body ? notesText(n.body) : '<span class="muted">Sem notas nesta versão.</span>'}</div></details>`).join('')}</section>` : ''}` : `
        <section class="block"><h2>Como jogar</h2><ol class="steps">
          <li><b>Baixe o Black Flag</b> e abra a aba Comunidade.</li>
          <li><b>Procure ${esc(g.name)}</b> e clique em Instalar: ele baixa a versão para Windows da página do projeto no GitHub.</li>
          <li><b>Leia o README do projeto</b> para saber que cópia do jogo ele pede. Se o port trouxer instruções para launchers, o Black Flag já pede a cópia certa.</li></ol>
          <p class="muted">Este port não foi verificado pelo Black Flag. Só instale se confiar no projeto.</p></section>`;
  const title = g.verified ? `${g.game} no PC: ${g.name} | Black Flag` : `${g.name}${g.game ? `: ${g.game} no PC` : ''} | Black Flag`;
  const desc = `${g.name}${g.game && plain(g.game) !== plain(g.name) ? `, ${g.game}` : ''} rodando nativo no PC. ${g.description ? g.description.slice(0, 140) : 'Você fornece a sua própria cópia do jogo.'}`;
  return `${head(title, desc, g.page, g.art && (g.art.banner || g.art.cover) && (g.art.banner || g.art.cover).src)}
  ${g.art && g.art.banner ? `<div class="port-banner" aria-hidden="true"><img src="${esc(g.art.banner.src)}" alt=""></div>` : ''}
  <main class="game-page${g.art && g.art.banner ? ' over-banner' : ''}">
    <a class="back" href="todos.html">← Todos os jogos</a>
    <div class="game-grid">
      <div class="game-main">
        <div class="game-head">
          ${cover(g, { big: true })}
          <div>
            <p class="chips">${chips}</p>
            <h1>${esc(g.name)}</h1>
            ${g.game && plain(g.game) !== plain(g.name) ? `<p class="from">Reconstruído a partir de <b>${esc(g.game)}</b></p>` : ''}
            <p class="by">Por <a href="https://github.com/${esc(g.owner || g.repo.split('/')[0])}">${esc(p ? p.port_authors : g.owner || g.repo.split('/')[0])}</a></p>
          </div>
        </div>
        ${g.description ? `<p class="lead game-desc">${esc(g.description)}</p>` : ''}
        ${verifiedBody}
      </div>
      ${side(g)}
    </div>
    ${more.length ? `<div class="more-like">${row(`Mais de ${g.console}`, more, { more: `todos.html?console=${encodeURIComponent(g.console)}` })}</div>` : ''}
  </main>${foot(built)}`;
}

// ---- Build ----

const built = new Date().toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });
mkdirSync(ART_DIR, { recursive: true });

const verified = [];
for (const p of catalog.ports) {
  const f = await facts(p);
  const c = consoleOf(p.family);
  verified.push({
    slug: p.id, page: `port-${p.id}.html`, verified: true, port: p, facts: f, repo: p.repo, name: p.port_name, game: p.title,
    console: c.name || p.family, color: c.color, description: f ? f.description : '', stars: f ? f.stars : 0, pushed: f ? f.pushed : 0, created: f ? f.created : 0,
    license: f ? f.license : '', owner: p.repo.split('/')[0],
  });
}
const verifiedRepos = new Set(verified.map((g) => g.repo.toLowerCase()));
const others = (await community())
  .filter((g) => !verifiedRepos.has(g.repo.toLowerCase()))
  .map((g) => {
    const c = consoleOf(g.console);
    const slug = slugOf(g.repo);
    return { ...g, slug, page: `jogo-${slug.slice(3)}.html`, name: g.name.length > 3 && /[A-Z]/.test(g.name) ? g.name : pretty(g.name), console: c.name || g.console || '', color: c.color };
  });
const all = [...verified, ...others];

// Art: the verified ports and the most watched first, so a capped run spends its lookups well.
for (const g of [...verified, ...[...others].sort((a, b) => trending(b) - trending(a))]) g.art = await art(g.slug, g.game || (g.fromList ? g.name : ''));
writeFileSync(ART_INDEX, JSON.stringify(artIndex));

for (const g of all) writeFileSync(join(out, g.page), gamePage(g, all, built));
writeFileSync(join(out, 'ports.html'), discoverPage(all, built));
writeFileSync(join(out, 'todos.html'), allPage(all, built));
console.log(`${all.length} jogos (${verified.length} verificados), ${all.filter((g) => g.art && g.art.cover).length} com capa, ${all.filter((g) => g.art && g.art.banner).length} com banner, ${lookups} buscas de arte novas`);
