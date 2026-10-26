// Builds the site's port pages from the catalog the program uses: ports.html (all of them) and
// port-<id>.html (one each), with the facts sheet read from each project's GitHub (stars,
// downloads, versions, open problems, license, what changed). Run when the site is published
// and once a day, so the numbers stay current:
//
//   node tools/site-ports.mjs site            (GITHUB_TOKEN raises GitHub's request limit)
//
// Pages are plain HTML, readable without JavaScript and by search engines. With SGDB_KEY (a
// SteamGridDB key, a secret of the repository), each port gets a cover and a banner from
// SteamGridDB, kept in img/ports/ and credited to whoever sent them (decision 86); without it,
// or for a port with nothing there, a lettered tile stands in.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] || 'site';
const catalog = JSON.parse(readFileSync(join(out, 'catalog.json'), 'utf8'));
const APP = 'https://github.com/recomphub-app/recomphub';
const SITE = 'https://recomphub-app.github.io/recomphub/';
const NOTES = 5;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const numberPt = (n) => (n >= 1e6 ? `${(n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`
  : n >= 1e4 ? `${Math.round(n / 1e3).toLocaleString('pt-BR')} mil` : n.toLocaleString('pt-BR'));
const datePt = (t) => (t ? new Date(t).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');
const version = (tag) => String(tag || '').replace(/^[a-z-]*?v(?=\d)/i, 'v');

async function api(path) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'BlackFlag-site' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com/${path}`, { headers });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// ---- Art from SteamGridDB (sent by its community; the author is credited on the page) ----

const SGDB = 'https://www.steamgriddb.com/api/v2';
// Ports whose pictures came out at their owner's request: the lettered tile stays.
const SKIP_ART = [];
const FILTERS = 'types=static&nsfw=false&humor=false&epilepsy=false';
const MAX_IMAGE = 8 * 1024 * 1024;

async function sgdb(path) {
  const r = await fetch(`${SGDB}${path}`, { headers: { Authorization: `Bearer ${process.env.SGDB_KEY}` } });
  if (!r.ok) throw new Error(`SteamGridDB ${r.status}`);
  return (await r.json()).data;
}

const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');

// The first image of the list from SteamGridDB's own image server, downloaded to img/ports/.
// Its smaller copy ("thumb"): the full ones reach 4 MB, too heavy for a page.
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
    writeFileSync(join(out, 'img', 'ports', name), bytes);
    return { src: `img/ports/${name}`, author: (it.author && it.author.name) || '' };
  }
  return null;
}

// Cover (square when there is one, art made by fans before scans of the box) and banner.
async function art(port) {
  if (!process.env.SGDB_KEY || SKIP_ART.includes(port.id)) return null;
  try {
    const found = await sgdb(`/search/autocomplete/${encodeURIComponent(port.title)}`);
    const want = plain(port.title);
    const game = (found || []).find((g) => plain(g.name) === want) || (found || [])[0];
    if (!game) return null;
    const square = await sgdb(`/grids/game/${game.id}?dimensions=1024x1024,512x512&styles=alternate,material,no_logo,white_logo&${FILTERS}`);
    const tall = square && square.length ? [] : await sgdb(`/grids/game/${game.id}?dimensions=600x900,660x930&${FILTERS}`);
    const heroes = await sgdb(`/heroes/game/${game.id}?${FILTERS}`);
    return { cover: await keep([...(square || []), ...(tall || [])], `${port.id}-capa`), banner: await keep(heroes, `${port.id}-banner`) };
  } catch (e) {
    console.warn(`sem arte para ${port.title}: ${e.message}`);
    return null;
  }
}

// The sheet, as in the program (facts.rs); the Windows file is the catalog's own asset name.
async function facts(port) {
  try {
    const [repo, list] = await Promise.all([api(`repos/${port.repo}`), api(`repos/${port.repo}/releases?per_page=100`)]);
    const shown = list.filter((r) => !r.draft);
    const stable = shown.find((r) => !r.prerelease) || shown[0];
    const win = stable && stable.assets.find((a) => a.name.startsWith(port.asset_prefix) && a.name.endsWith(port.asset_suffix));
    return {
      description: repo.description || '',
      stars: repo.stargazers_count || 0,
      issues: repo.open_issues_count || 0,
      license: repo.license && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : '',
      releases: shown.length,
      downloads: shown.flatMap((r) => r.assets).reduce((n, a) => n + (a.download_count || 0), 0),
      first: shown.map((r) => r.published_at).filter(Boolean).sort()[0] || '',
      latest: stable ? { tag: stable.tag_name, when: stable.published_at, size: win ? win.size : 0 } : null,
      notes: (shown.some((r) => !r.prerelease) ? shown.filter((r) => !r.prerelease) : shown).slice(0, NOTES).map((r) => ({ tag: r.tag_name, when: r.published_at, body: (r.body || '').trim().slice(0, 3000) })),
    };
  } catch (e) {
    console.warn(`sem ficha para ${port.repo}: ${e.message}`);
    return null;
  }
}

// Markdown from each project, shown as text (its HTML never enters the page).
function notesText(body) {
  return esc(body)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*(.+)$/gm, '<b>$1</b>')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^&gt;\s?/gm, '')
    .replace(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/g, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

const tile = (p, big, a) => (a && a.cover
  ? `<div class="tile art${big ? ' big' : ''}"><img src="${a.cover.src}" alt="" loading="lazy" decoding="async"></div>`
  : `<div class="tile${big ? ' big' : ''}${p.title.length > 22 ? ' long' : ''}" aria-hidden="true"><span class="tile-sys">${esc(p.family)}</span><span class="tile-name">${esc(p.title)}</span></div>`);

// Who sent the pictures, as SteamGridDB asks.
function artCredit(a) {
  if (!a || !(a.cover || a.banner)) return '';
  const by = (x, word) => (x.author ? ` ${word} por ${esc(x.author)}` : '');
  const parts = [a.cover && `capa${by(a.cover, 'enviada')}`, a.banner && `banner${by(a.banner, 'enviado')}`].filter(Boolean);
  return `<p class="muted art-credit">Imagens da <a href="https://www.steamgriddb.com/">SteamGridDB</a>: ${parts.join('; ')}.</p>`;
}

function head(title, description, path, image) {
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
  <link rel="stylesheet" href="ports.css?v=3">
</head>
<body>
  <div class="glow" aria-hidden="true"></div>
  <header class="bar">
    <a class="brand" href="./"><img class="logo" src="img/logo.svg" alt="" width="34" height="34">Black <span>Flag</span></a>
    <nav class="crumbs" aria-label="Seções do site">
      <a href="./#visao">Visão geral</a><a href="./#recursos">Recursos</a><a href="ports.html" aria-current="${path === 'ports.html' ? 'page' : 'false'}">Ports</a><a href="./#sobre">Sobre</a>
    </nav>
    <a class="bar-link" href="${APP}">Código</a>
  </header>`;
}

const foot = (built) => `
  <footer>
    <p><b>Nenhum arquivo de jogo aqui.</b> O Black Flag e os projetos para onde ele aponta trazem só os ports e as
      ferramentas. Todo jogo precisa da sua própria cópia, obtida legalmente. Os ports pertencem aos seus autores; marcas e
      jogos pertencem aos seus donos. O Black Flag não tem ligação com Nintendo, Sony, Microsoft ou outras empresas.</p>
    <p class="muted">Números lidos do GitHub de cada projeto em ${esc(built)}. Capas e banners da SteamGridDB, enviados pela
      comunidade dela, com o crédito em cada página. Se uma imagem é sua ou da sua empresa e você quer que ela saia,
      <a href="${APP}/issues">abra um pedido no GitHub do Black Flag</a> que ela é retirada.</p>
    <p><a href="${APP}">Código no GitHub</a><a href="${APP}/issues">Relatar um problema</a><a href="${APP}/releases">Todas as versões</a></p>
  </footer>
</body>
</html>
`;

function sheet(p, f, a) {
  const row = (k, v) => (v ? `<div><dt>${k}</dt><dd>${v}</dd></div>` : '');
  const rows = f ? `<dl>
      ${row('Versão', f.latest ? esc(version(f.latest.tag)) : 'nenhuma publicada')}
      ${row('Saiu em', f.latest ? datePt(f.latest.when) : '')}
      ${row('Tamanho', f.latest && f.latest.size ? `${Math.max(1, Math.round(f.latest.size / 1048576))} MB` : '')}
      ${row('Downloads', f.releases ? numberPt(f.downloads) : '')}
      ${row('Estrelas', numberPt(f.stars))}
      ${row('Versões', f.releases ? String(f.releases) : '')}
      ${row('Primeira versão', datePt(f.first))}
      ${row('Problemas abertos', numberPt(f.issues))}
      ${row('Licença', esc(f.license || 'não informada'))}
    </dl>` : '<p class="muted">Os números do GitHub não puderam ser lidos agora.</p>';
  return `
    <aside class="sheet" aria-label="Ficha do port">
      <a class="button" href="${APP}/releases/latest">Baixar o Black Flag</a>
      <p class="muted sheet-how">Dentro dele, em Instalar ports, o ${esc(p.port_name)} instala com um clique.</p>
      ${rows}
      <div class="sheet-links">
        <a href="${esc(p.project_url)}">Página do projeto</a>
        <a href="https://github.com/${esc(p.repo)}/releases">Todas as versões do port</a>
        <a href="https://github.com/${esc(p.repo)}/issues">Relatar um problema no port</a>
      </div>
      ${artCredit(a)}
    </aside>`;
}

function portPage(p, f, a, built) {
  const desc = `${p.port_name}: ${p.title} rodando nativo no Windows. Você fornece a sua própria cópia; o Black Flag instala e confere os arquivos.`;
  const notes = f && f.notes.length ? `
      <section class="block">
        <h2>O que mudou</h2>
        ${f.notes.map((n, i) => `
        <details ${i === 0 ? 'open' : ''}>
          <summary><b>${esc(version(n.tag))}</b><span class="muted">${datePt(n.when)}</span></summary>
          <div class="note-body">${n.body ? notesText(n.body) : '<span class="muted">Sem notas nesta versão.</span>'}</div>
        </details>`).join('')}
      </section>` : '';
  const guide = (p.guide || []).length ? `
      <section class="block">
        <h2>Bom saber</h2>
        <ul class="guide">${p.guide.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
      </section>` : '';
  return `${head(`${p.title} no PC: ${p.port_name} | Black Flag`, desc, `port-${p.id}.html`, a && a.banner && a.banner.src)}
  ${a && a.banner ? `<div class="port-banner" aria-hidden="true"><img src="${a.banner.src}" alt=""></div>` : ''}
  <main class="port-page${a && a.banner ? ' over-banner' : ''}">
    <a class="back" href="ports.html">← Todos os ports</a>
    <div class="port-head">
      ${tile(p, true, a)}
      <div>
        <p class="chips"><span>${esc(p.family)}</span>${(p.tags || []).filter((t) => t.toLowerCase() !== p.family.toLowerCase()).map((t) => `<span>${esc(t)}</span>`).join('')}<span class="ok">Verificado pelo Black Flag</span></p>
        <h1>${esc(p.port_name)}</h1>
        <p class="lead">${esc(p.title)} reconstruído para rodar nativo no Windows, feito por ${esc(p.port_authors)}.</p>
        ${f && f.description ? `<p class="sub">Do projeto: “${esc(f.description)}”</p>` : ''}
      </div>
    </div>
    <div class="port-body">
      <div>
        <section class="block needs">
          <h2>Você fornece</h2>
          <p>${esc(p.needs)}</p>
          <p class="muted">O Black Flag nunca baixa arquivos de jogos. ${esc(p.files_help || '')}</p>
        </section>
        <section class="block">
          <h2>Como jogar</h2>
          <ol class="steps">
            <li><b>Baixe o Black Flag</b> e abra a seção Instalar ports.</li>
            <li><b>Escolha ${esc(p.title)}</b> e clique em Instalar: ele baixa o ${esc(p.port_name)} da página oficial do projeto.</li>
            <li><b>Aponte a sua cópia.</b> O Black Flag confere os arquivos e diz o que falta. Depois é só jogar.</li>
          </ol>
          <p class="muted">Requisitos: ${esc(p.requirements)}</p>
        </section>
        ${guide}
        ${notes}
      </div>
      ${sheet(p, f, a)}
    </div>
  </main>${foot(built)}`;
}

function indexPage(list, built) {
  return `${head('Ports para PC verificados | Black Flag', 'Jogos de console reconstruídos para rodar nativos no Windows, verificados pelo Black Flag: cada um instala com um clique a partir da página oficial do projeto.', 'ports.html')}
  <main class="ports-index">
    <h1>Ports verificados</h1>
    <p class="lead">Jogos de console reconstruídos para rodar nativos no Windows. Cada um foi conferido pelo Black Flag:
      ele baixa da página oficial do projeto, confere os arquivos da sua cópia e explica o que falta.</p>
    <ul class="port-grid">${list.map(({ p, f, a }) => `
      <li><a class="port-card" href="port-${esc(p.id)}.html">
        ${tile(p, false, a)}
        <span class="pc-name">${esc(p.port_name)}</span>
        <span class="pc-game">${esc(p.title)}</span>
        <span class="pc-meta">${f ? [f.stars ? `★ ${numberPt(f.stars)}` : '', f.releases ? `${numberPt(f.downloads)} downloads` : '', f.latest ? esc(version(f.latest.tag)) : ''].filter(Boolean).join(' · ') : ''}</span>
      </a></li>`).join('')}
    </ul>
    <section class="block community-note">
      <h2>E os outros?</h2>
      <p>Dentro do programa, a Comunidade lista mais de 400 ports achados no GitHub, de consoles da Nintendo, PlayStation,
        Xbox e outros. Esses não são verificados pelo Black Flag: cada um tem um aviso e a instalação é experimental.</p>
      <a class="button" href="${APP}/releases/latest">Baixar o Black Flag</a>
    </section>
  </main>${foot(built)}`;
}

const built = new Date().toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });
const list = [];
mkdirSync(join(out, 'img', 'ports'), { recursive: true });
for (const p of catalog.ports) list.push({ p, f: await facts(p), a: await art(p) });
list.sort((a, b) => ((b.f && b.f.stars) || 0) - ((a.f && a.f.stars) || 0));
for (const { p, f, a } of list) writeFileSync(join(out, `port-${p.id}.html`), portPage(p, f, a, built));
writeFileSync(join(out, 'ports.html'), indexPage(list, built));
console.log(`${list.length} páginas de port, ${list.filter((x) => x.f).length} com ficha, ${list.filter((x) => x.a && x.a.cover).length} com capa`);
