// The site behaves like the program: sections on top as tabs (Q/E move between them, as LB/RB
// do), a settings-style menu for the features, captures that play when they come into view.
// The download, the port list and the news still come from the project itself:
// - GitHub's "latest release" gives the installer;
// - catalog.json (copied here when the site is published) gives the ports;
// - the releases give the news.
const REPO = 'recomphub-app/recomphub';
const API = `https://api.github.com/repos/${REPO}`;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mb = (n) => `${(n / 1048576).toFixed(1).replace('.', ',')} MB`;
const date = (iso) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

document.documentElement.classList.add('js');

// ---- Tabs ----
const TABS = $$('.tabs [data-tab]').map((a) => a.dataset.tab);
let current = null;

function markTab(tab) {
  const a = $(`.tabs [data-tab="${tab}"]`);
  const mark = $('.tab-mark');
  if (!a || !mark) return;
  const nav = $('.tabs').getBoundingClientRect();
  const r = a.getBoundingClientRect();
  mark.style.width = `${r.width - 24}px`;
  mark.style.transform = `translateX(${r.left - nav.left + 12 + $('.tabs').scrollLeft}px)`;
}

function showTab(tab, { scroll = true } = {}) {
  if (!TABS.includes(tab)) tab = 'visao';
  if (tab === current) return;
  current = tab;
  $$('.tabs [data-tab]').forEach((a) => a.setAttribute('aria-selected', String(a.dataset.tab === tab)));
  $$('[data-panel]').forEach((p) => {
    const on = p.dataset.panel === tab;
    p.hidden = !on;
    p.classList.toggle('in', on);
  });
  markTab(tab);
  const a = $(`.tabs [data-tab="${tab}"]`);
  if (a) a.scrollIntoView({ block: 'nearest', inline: 'center', behavior: still() ? 'auto' : 'smooth' });
  if (scroll) window.scrollTo({ top: 0, behavior: 'auto' });
  watchVideos();
  watchReveals();
}

function tabFromHash() {
  const h = location.hash.slice(1);
  return TABS.includes(h) ? h : h === 'apoie' ? 'sobre' : 'visao';
}

$$('[data-tab], [data-tab-link]').forEach((a) => a.addEventListener('click', (e) => {
  const tab = a.dataset.tab || a.dataset.tabLink;
  e.preventDefault();
  if (location.hash !== `#${tab}`) history.pushState(null, '', `#${tab}`);
  showTab(tab);
}));
addEventListener('popstate', () => showTab(tabFromHash()));
addEventListener('resize', () => markTab(current));
document.fonts.ready.then(() => markTab(current));

// Q and E move between the tabs, like LB and RB in the program.
addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!$('#viewer').hidden) {
    if (e.key === 'Escape') closeViewer();
    return;
  }
  const k = e.key.toLowerCase();
  if (k !== 'q' && k !== 'e') return;
  const i = TABS.indexOf(current) + (k === 'e' ? 1 : -1);
  const tab = TABS[(i + TABS.length) % TABS.length];
  history.pushState(null, '', `#${tab}`);
  showTab(tab);
});

// ---- Recursos: the menu ----
function showFeature(name, focus = false) {
  $$('.menu-list [data-feature]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.feature === name)));
  $$('.menu-view .feature').forEach((f) => {
    const on = f.dataset.feature === name;
    f.hidden = !on;
    f.classList.toggle('in', on);
  });
  if (focus) $(`.menu-list [data-feature="${name}"]`).focus();
  watchVideos();
}
const FEATURES = $$('.menu-list [data-feature]').map((b) => b.dataset.feature);
$$('.menu-list [data-feature]').forEach((b) => {
  b.addEventListener('click', () => showFeature(b.dataset.feature));
  b.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    const i = (FEATURES.indexOf(b.dataset.feature) + step + FEATURES.length) % FEATURES.length;
    showFeature(FEATURES[i], true);
  });
});

// ---- Captures: videos play only while on screen ----
const videoWatch = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    const v = e.target;
    if (e.isIntersecting && !still()) v.play().catch(() => {});
    else v.pause();
  }
}, { threshold: 0.35 }) : null;

function watchVideos() {
  $$('video').forEach((v) => {
    if (v.dataset.watched) return;
    v.dataset.watched = '1';
    v.removeAttribute('autoplay');
    if (videoWatch) videoWatch.observe(v);
  });
}

// ---- Things that come into view while scrolling ----
const revealWatch = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('seen'); revealWatch.unobserve(e.target); }
}, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }) : null;

function watchReveals() {
  if (!revealWatch) return;
  $$('.sources, .duo, .pillars, .shot, .timeline li, .next li, .port-list, .about, .get').forEach((el, i) => {
    if (el.dataset.revealed) return;
    el.dataset.revealed = '1';
    el.classList.add('reveal');
    // Neighbours in a row arrive a moment apart, never more than a fraction of a second in total.
    el.style.transitionDelay = `${Math.min((i % 4) * 60, 180)}ms`;
    revealWatch.observe(el);
  });
}

// ---- Galeria: a capture in full ----
function openViewer(btn) {
  const src = btn.dataset.full;
  const stage = $('#viewer-stage');
  stage.innerHTML = src.endsWith('.webm')
    ? `<video src="${esc(src)}" poster="${esc(btn.dataset.poster || '')}" controls autoplay loop muted playsinline></video>`
    : `<img src="${esc(src)}" alt="">`;
  $('#viewer').hidden = false;
  $('.viewer-close').focus();
  $('#viewer').dataset.from = $$('.gallery .shot').indexOf(btn);
}
function closeViewer() {
  $('#viewer').hidden = true;
  $('#viewer-stage').innerHTML = '';
  const back = $$('.gallery .shot')[Number($('#viewer').dataset.from)];
  if (back) back.focus();
}
$$('.gallery .shot').forEach((b) => b.addEventListener('click', () => openViewer(b)));
$('.viewer-close').addEventListener('click', closeViewer);
$('#viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer') closeViewer(); });

// ---- From the project ----
async function download() {
  try {
    const r = await fetch(`${API}/releases/latest`);
    if (!r.ok) return;
    const rel = await r.json();
    const exe = (rel.assets || []).find((a) => a.name.toLowerCase().endsWith('.exe'));
    if (!exe) return;
    $('#download').href = exe.browser_download_url;
    $('#download-info').textContent = `Instalador para Windows, versão ${rel.tag_name.replace(/^v/, '')}, ${mb(exe.size)}.`;
  } catch { /* offline: the button still goes to the releases page */ }
}

async function ports() {
  const box = $('#port-table');
  try {
    const c = await (await fetch('catalog.json')).json();
    box.innerHTML = `<table class="port-table">
      <thead><tr><th>Jogo</th><th>Port</th><th>Você fornece</th></tr></thead>
      <tbody>${c.ports.map((p) => `
        <tr>
          <td>${esc(p.title)} <span class="sys">${esc(p.family)}</span></td>
          <td><a href="${esc(p.project_url)}">${esc(p.port_name)}</a><span class="by">${esc(p.port_authors)}</span></td>
          <td class="needs">${esc(p.needs)}</td>
        </tr>`).join('')}</tbody></table>`;
  } catch {
    box.innerHTML = '<p class="sub">A lista de ports fica dentro do programa, em Instalar ports.</p>';
  }
}

// Release notes: the commit-style "- item" lines become a list.
function notes(body) {
  const items = String(body || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  return items.length ? `<ul>${items.slice(0, 6).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '';
}

async function news() {
  const box = $('#releases');
  try {
    const r = await fetch(`${API}/releases?per_page=5`);
    if (!r.ok) throw new Error();
    const list = (await r.json()).filter((x) => !x.draft);
    if (!list.length) throw new Error();
    box.innerHTML = list.map((x) => `
      <div class="release">
        <h3>${esc(x.name || x.tag_name)}</h3>
        <span class="date">${date(x.published_at)}</span>
        ${notes(x.body)}
      </div>`).join('') + `<p><a href="https://github.com/${REPO}/releases">Todas as versões</a></p>`;
  } catch {
    box.innerHTML = `<p class="sub">As novidades de cada versão ficam na <a href="https://github.com/${REPO}/releases">página de versões</a>.</p>`;
  }
}

// "Apoie o projeto": filled from doacoes.json; hidden while it has nothing.
async function donations() {
  let d;
  try {
    d = await (await fetch('doacoes.json')).json();
  } catch {
    return;
  }
  const links = (d.links || []).filter((l) => /^https:\/\//.test(l.url || ''));
  const pix = d.pix && d.pix.chave ? d.pix : null;
  if (!links.length && !pix) return;
  $('#apoie-msg').textContent = d.mensagem || '';
  const cards = [];
  if (pix) {
    cards.push(`
      <div class="donate-card pix">
        <b>Pix</b>
        <span class="muted">${esc(pix.nome || 'Chave Pix')}</span>
        <code id="pix-key">${esc(pix.chave)}</code>
        <button class="btn" id="pix-copy">Copiar chave</button>
      </div>`);
  }
  for (const l of links) {
    cards.push(`
      <a class="donate-card" href="${esc(l.url)}" target="_blank" rel="noopener">
        <b>${esc(l.nome)}</b>
        <span class="muted">${esc(l.descricao || '')}</span>
      </a>`);
  }
  $('#apoie-opcoes').innerHTML = cards.join('');
  $('#apoie').hidden = false;
  const copy = $('#pix-copy');
  if (copy) {
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pix.chave);
        copy.textContent = 'Copiada';
      } catch {
        copy.textContent = 'Selecione e copie';
      }
      setTimeout(() => { copy.textContent = 'Copiar chave'; }, 2500);
    });
  }
}

showFeature(FEATURES[0]);
showTab(tabFromHash(), { scroll: false });
download();
ports();
news();
donations();
