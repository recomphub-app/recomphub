const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let games = [];
let openId = null;
let tab = 'all';          // 'all', 'port', 'pc_game', 'community', or 'discover' (the catalog, from Adicionar)
let tagFilter = null;     // a tag (the player's, or the catalog's in Descobrir), or null
let search = '';
const progress = {};      // id -> { stage, done, total }
const filesResult = {};   // id -> last check after the player picked files

const STATUS_TEXT = {
  ready: 'Instalado',
  needs_files: 'Precisa de arquivos',
  not_installed: 'Não instalado',
  starting: 'Abrindo…',
  running: 'Jogando',
  installing: 'Instalando',
  missing: 'Programa não encontrado',
  needs_exe: 'Escolher programa',
  needs_emulator: 'Falta o emulador',
};

const IN_GAME = ['starting', 'running'];

function sessionLength(g) {
  if (!g.session_started) return '';
  return playTime(Math.floor(Date.now() / 1000) - g.session_started).toLowerCase();
}

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function versionLabel(tag) {
  return tag ? tag.replace(/^windows-/, '') : null;
}

function playTime(seconds) {
  if (!seconds) return 'Nunca jogado';
  if (seconds < 60) return 'Menos de 1 min';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

function lastPlayed(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

let toastTimer;
// A dialog that opens plays its entrance once; later redraws of its card stay still.
function popIn(el) {
  el.classList.add('pop');
  setTimeout(() => el.classList.remove('pop'), 450);
}

function toast(message, bad = false) {
  const t = $('#toast');
  t.textContent = message;
  t.className = bad ? 'toast bad' : 'toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 9000 : 4000);
}

async function call(cmd, args) {
  try {
    return await invoke(cmd, args);
  } catch (e) {
    toast(String(e), true);
    throw e;
  }
}

function coverHtml(g) {
  if (!g.cover && g.icon) {
    return `<div class="cover"><div class="iconcover"><img src="${g.icon}" alt=""><span>${esc(g.title)}</span></div></div>`;
  }
  if (!g.cover) return `<div class="cover"><div class="placeholder">${esc(g.title)}</div></div>`;
  const contain = g.cover.startsWith('data:image/svg') ? ' contain' : '';
  return `<div class="cover${contain}"><img src="${g.cover}" alt=""></div>`;
}

let settings = { show_hidden: false, store_import: true, version: '' };

function chips(g) {
  let html = g.favorite ? '<span class="chip fav" title="Favorito">★</span>' : '';
  html += `<span class="chip family">${esc(g.family)}</span>`;
  if (g.hidden) html += '<span class="chip family">Oculto</span>';
  html += `<span class="chip ${g.status}">${STATUS_TEXT[g.status]}</span>`;
  if (g.update_available) html += `<span class="chip update">Atualização</span>`;
  return html;
}

// A tab for each store; one with no games stays out of the way.
const STORE_TABS = ['steam', 'epic', 'gog'];
// The game's store as a tab: GameView.store carries the store's name ("Steam", "Epic Games", "GOG").
const STORE_KEYS = { Steam: 'steam', 'Epic Games': 'epic', GOG: 'gog' };
const storeTab = (g) => (g.store ? STORE_KEYS[g.store] || g.store.toLowerCase() : null);

// Library tabs show what the player has; the catalog (Adicionar > Instalar um port) shows the other ports.
function inTab(g, t = tab) {
  if (t === 'discover') return g.kind === 'port' && !g.in_library;
  if (!g.in_library) return false;
  if (g.hidden && !settings.show_hidden) return false;
  if (t === 'port') return g.kind === 'port' || g.kind === 'community';
  if (t === 'emu') return g.kind === 'emulated';
  if (STORE_TABS.includes(t)) return storeTab(g) === t;
  if (t === 'pc_game') return g.kind === 'pc_game' && !g.store;
  return t === 'all';
}

// The tabs show how many games each one has.
function markTabs() {
  document.querySelectorAll('#tabs button').forEach((b) => {
    const t = b.dataset.tab;
    const n = t === 'community' ? (communityData ? communityData.items.length : null) : games.filter((g) => inTab(g, t)).length;
    const look = (profiles && profiles.active && profiles.active.look) || {};
    b.hidden = (look.hidden_tabs || []).includes(t) || ((STORE_TABS.includes(t) || t === 'emu') && !n && tab !== t);
    if (!b.dataset.label) b.dataset.label = b.textContent;
    b.innerHTML = `${esc(b.dataset.label)}${n === null ? '' : ` <span class="count">${n}</span>`}`;
    b.classList.toggle('on', t === tab);
  });
}

// A dropdown filter: [label, current value, options as [value, text], on change].
function selectHtml(id, label, current, options) {
  return `<label class="filter">${label}
    <select id="${id}">${options.map(([v, text]) =>
      `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
}

// Favorites first, then the most recently played (as Ports Launcher), then by name.
function libraryOrder(a, b) {
  if (tab === 'discover') return a.title.localeCompare(b.title, 'pt-BR');
  return (b.favorite - a.favorite)
    || ((b.last_played || 0) - (a.last_played || 0))
    || a.title.localeCompare(b.title, 'pt-BR');
}

const tagsOf = (g) => (tab === 'discover' ? g.catalog_tags : tab === 'emu' ? [g.family] : g.tags);

function matchesSearch(g) {
  if (!search) return true;
  const hay = [g.title, g.port_name, g.family, ...g.tags, ...g.catalog_tags].join(' ').toLowerCase();
  return search.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function visibleGames() {
  return games
    .filter((g) => inTab(g) && matchesSearch(g) && (!tagFilter || tagsOf(g).includes(tagFilter)))
    .sort(libraryOrder);
}

function renderTabs() {
  markTabs();
  const shown = games.filter((g) => inTab(g));
  const tags = [...new Set(shown.flatMap(tagsOf))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  if (tagFilter && !tags.includes(tagFilter)) tagFilter = null;
  const discover = tab === 'discover';
  const count = (t) => shown.filter((g) => tagsOf(g).includes(t)).length;
  const byConsole = discover || tab === 'emu';
  $('#tagbar').innerHTML = tags.length ? selectHtml('tag-select', byConsole ? 'Console' : 'Etiqueta', tagFilter || '',
    [['', byConsole ? 'Todos' : 'Todas'], ...tags.map((t) => [t, `${t} (${count(t)})`])]) : '';
  const sel = $('#tag-select');
  if (sel) sel.addEventListener('change', () => { tagFilter = sel.value || null; render(); });
}

// On top of the library: the profile's wide picture, a greeting and "Continuar jogando" with the
// game played last (and the note left on it).
function renderLibHero() {
  const el = $('#lib-hero');
  if (!el) return;
  const p = profiles && profiles.active;
  const l = (p && p.look) || {};
  const last = p && games.filter((g) => g.in_library && !g.hidden && g.last_played && !['not_installed', 'missing'].includes(g.status))
    .sort((a, b) => b.last_played - a.last_played)[0];
  const art = p && (p.banner || (last && (last.background || last.cover)));
  if (!p || l.banner_home === false || (!art && !last)) {
    el.innerHTML = '';
    el.className = '';
    return;
  }
  const h = new Date().getHours();
  const hello = h < 5 ? 'Boa madrugada' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  el.className = 'lib-hero';
  el.innerHTML = `
    ${art ? `<div class="lib-hero-art" style="background-image:url('${art}');background-position:${p.banner ? bannerPos(p) : 'center'}"></div>` : ''}
    <div class="lib-hero-who">${avatar(p, true)}<div><span class="hello">${hello},</span><b>${esc(p.name)}</b></div></div>
    ${last ? `
      <div class="lib-hero-go">
        <span class="go-label">Continuar jogando</span>
        <b>${esc(last.title)}</b>
        ${last.resume ? `<p>“${esc(last.resume.text)}”</p>` : `<p class="muted">Última vez ${lastPlayed(last.last_played)}</p>`}
        <div class="row">
          <button class="primary" data-hero="play" ${last.status === 'ready' || last.status === 'running' ? '' : 'disabled'}>${last.status === 'running' ? 'Mostrar o jogo' : 'Jogar'}</button>
          <button class="ghost" data-hero="open">Ver o jogo</button>
        </div>
      </div>` : ''}`;
  const play = el.querySelector('[data-hero="play"]');
  if (play) {
    play.addEventListener('click', async () => {
      await call('play', { id: last.id });
      setGame(await call('get_game', { id: last.id }));
    });
  }
  const open = el.querySelector('[data-hero="open"]');
  if (open) open.addEventListener('click', () => openGame(last.id));
}

function renderGrid() {
  // The catalog is a page of its own, opened from Adicionar, with the way back on top.
  const catalog = tab === 'discover';
  const community = tab === 'community';
  $('#lib-title').textContent = catalog ? 'Instalar um port' : community ? 'Comunidade' : 'Biblioteca';
  $('#lib-title').hidden = !catalog && !community;
  $('#lib-back').hidden = true;
  $('#tabs').hidden = catalog || community;
  if (catalog || community) { $('#lib-hero').innerHTML = ''; $('#lib-hero').className = ''; } else renderLibHero();
  renderSetupHint(!catalog && !community);
  if (tab === 'community') return renderCommunityGrid();
  $('#community-head').hidden = true;
  renderTabs();
  const list = visibleGames();
  const empty = $('#empty');
  empty.hidden = list.length > 0;
  if (!list.length) {
    const filtered = tagFilter || search;
    empty.textContent = filtered ? 'Nenhum jogo com esse filtro.'
      : tab === 'pc_game' ? 'Nenhum jogo de PC adicionado por você. Use Adicionar > Jogo de PC e escolha o programa (.exe) de um jogo que você já tem instalado. Os da Steam, Epic e GOG ficam nas abas deles.'
      : STORE_TABS.includes(tab) ? 'Nenhum jogo desta loja instalado neste PC.'
      : tab === 'emu' ? 'Nenhum jogo de console ainda. Abra Adicionar > Jogos de console (emuladores).'
      : tab === 'discover' ? 'Você já tem todos os ports do catálogo na biblioteca.'
      : 'Sua biblioteca está vazia. Use Adicionar para instalar um port, trazer os jogos da Steam, Epic e GOG ou escolher um jogo de PC.';
  }
  $('#grid').innerHTML = list.map((g) => `
    <div class="card" data-id="${g.id}" tabindex="0">
      ${coverHtml(g)}
      <div class="body">
        <div class="title">${esc(g.title)}</div>
        <div>${chips(g)}</div>
        <div class="meta">${g.status === 'running' ? `Jogando há ${sessionLength(g)}`
          : g.in_library ? `${playTime(g.total_seconds)} · última vez ${lastPlayed(g.last_played)}` : `Port ${esc(g.port_name)}`}</div>
      </div>
    </div>`).join('');
  document.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('click', () => openGame(el.dataset.id));
    const g = list.find((x) => x.id === el.dataset.id);
    const art = g && realArt(g);
    if (!art) return;
    el.addEventListener('mouseenter', () => setFocusArt(art));
    el.addEventListener('focus', () => setFocusArt(art));
  });
  $('#grid').onmouseleave = () => setFocusArt(null);
}

const downloadsFound = {};   // id -> 'searching' | 'none' | path found in Downloads

function dropZone(g) {
  const what = g.files_kind === 'folder' ? 'a pasta do dump' : 'o arquivo da ROM';
  if (checkingDrop === g.id) return '<div class="dropzone busy">Conferindo o arquivo…</div>';
  return `<div class="dropzone" id="dropzone">Arraste ${what} e solte aqui</div>`;
}

function downloadsBox(g) {
  if (g.files_kind !== 'file') return '';
  const found = downloadsFound[g.id];
  if (found === 'searching') return '<p class="muted">Procurando na pasta Downloads…</p>';
  if (found === 'none') {
    return '<p class="muted">Nenhuma ROM que sirva para este port na pasta Downloads (nem nas pastas logo abaixo dela).</p>';
  }
  if (found) {
    return `
      <div class="found">
        <p>Encontrei a ROM certa: <b>${esc(found)}</b></p>
        <div class="row">
          <button class="primary" data-act="use-found">Usar este arquivo</button>
          <button class="ghost" data-act="dismiss-found">Não usar</button>
        </div>
      </div>`;
  }
  return '';
}

function filesBox(g) {
  const picked = filesResult[g.id];
  const files = picked && !picked.ok ? picked : g.files;
  const label = g.files_kind === 'folder' ? 'Escolher a pasta do dump' : 'Escolher a ROM';
  const searchBtn = g.files_kind === 'file' && !downloadsFound[g.id]
    ? '<button class="ghost" data-act="find-downloads">Procurar na pasta Downloads</button>' : '';
  if (files && files.ok) {
    return `
      <div class="box ok">
        <h3>Arquivos do jogo: tudo certo</h3>
        <ul>${files.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
        <p class="muted">${esc(files.path)}</p>
        <div class="row"><button data-act="files">${label.replace('Escolher', 'Trocar')}</button></div>
      </div>`;
  }
  const details = files ? files.details : [];
  return `
    <div class="box ${picked ? 'bad' : 'warn'}">
      <h3>${esc(files ? files.summary : 'Faltam os arquivos do jogo')}</h3>
      ${details.length ? `<ul>${details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
      <p><b>O que você precisa:</b> ${esc(g.needs)}</p>
      <p class="muted">${esc(g.files_help)} O Black Flag nunca baixa arquivos de jogos: eles vêm da sua cópia.</p>
      ${dropZone(g)}
      <div class="row"><button class="primary" data-act="files">${label}</button>${searchBtn}</div>
      ${downloadsBox(g)}
    </div>
    ${guideBox(g)}`;
}

// The page whose files box takes a dropped file: an installed catalog port that is open.
function dropTarget() {
  const g = games.find((x) => x.id === openId);
  if (!g || g.kind !== 'port' || !g.files_kind) return null;
  if (['not_installed', 'installing'].includes(g.status)) return null;
  return g;
}

let checkingDrop = null;

async function provideFiles(g, path) {
  const result = await call('provide_files', { id: g.id, path: path || null });
  if (!result) return;
  filesResult[g.id] = result;
  if (result.ok) {
    delete filesResult[g.id];
    delete downloadsFound[g.id];
    toast('Arquivos conferidos. O jogo está pronto.');
  }
  setGame(await call('get_game', { id: g.id }));
}

function guideBox(g) {
  if (!g.guide.length) return '';
  return `
    <div class="box">
      <h3>Como obter seus arquivos</h3>
      <ol>${g.guide.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      ${g.guide_links.length ? `<div class="row">${g.guide_links.map((l) =>
        `<button class="link" data-act="link" data-url="${esc(l.url)}">${esc(l.label)}</button>`).join('')}</div>` : ''}
    </div>`;
}

function tagsBox(g) {
  if (!g.in_library) return '';
  return `
    <div class="box">
      <h3>Etiquetas</h3>
      <div class="tags-edit">
        <input type="text" id="tags-input" placeholder="Ex.: favoritos, zerado, coop" value="${esc(g.tags.join(', '))}">
        <button data-act="tags">Salvar etiquetas</button>
      </div>
      <p class="muted">Separe com vírgulas. Use as etiquetas para filtrar a biblioteca.</p>
    </div>`;
}

// Where the game is on this PC, under Jogar on every game page: the path, "Abrir a pasta" and
// "Copiar caminho". Right after an install it stands out, so the new folder is one click away.
let justInstalled = null;   // id of the game installed in this visit to its page

function folderLine(g) {
  if (!g.in_library || !g.install_dir || g.status === 'installing') return '';
  const fresh = justInstalled === g.id;
  return `
    <div class="folder-line${fresh ? ' fresh' : ''}">
      <span class="k">${fresh ? 'Instalado nesta pasta' : 'Pasta do jogo'}</span>
      <code class="path" title="${esc(g.install_dir)}">${esc(g.install_dir)}</code>
      <button class="small${fresh ? ' primary' : ''}" data-act="folder">Abrir a pasta</button>
      <button class="ghost small" data-act="copy-path">Copiar caminho</button>
      ${g.kind === 'port' || g.kind === 'community' ? '<button class="ghost small danger" data-act="uninstall">Desinstalar</button>' : ''}
    </div>`;
}

// A warning before something that cannot be undone: the OK button works only after `wait`
// seconds, so the text gets read. Resolves to null (Cancelar) or the state of its checkboxes.
function askDanger({ title, html, ok, wait = 2 }) {
  return new Promise((resolve) => {
    const el = $('#ask');
    el.innerHTML = `
      <div class="ask-card" role="alertdialog" aria-modal="true" aria-labelledby="ask-title">
        <h2 id="ask-title">${title}</h2>
        <div class="ask-body">${html}</div>
        <div class="row">
          <span class="grow"></span>
          <button class="ghost" data-ask="no">Cancelar</button>
          <button class="primary danger-fill" data-ask="yes" disabled>${esc(ok)} (${wait})</button>
        </div>
      </div>`;
    el.hidden = false;
    const yes = el.querySelector('[data-ask=yes]');
    let left = wait;
    const timer = setInterval(() => {
      left -= 1;
      yes.textContent = left > 0 ? `${ok} (${left})` : ok;
      if (left <= 0) {
        clearInterval(timer);
        yes.disabled = false;
      }
    }, 1000);
    const done = (answer) => {
      clearInterval(timer);
      document.removeEventListener('keydown', onKey, true);
      el.hidden = true;
      el.innerHTML = '';
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    el.querySelector('[data-ask=no]').addEventListener('click', () => done(null));
    yes.addEventListener('click', () => {
      const boxes = {};
      el.querySelectorAll('input[type=checkbox][id]').forEach((c) => (boxes[c.id] = c.checked));
      done(boxes);
    });
    el.querySelector('[data-ask=no]').focus();
  });
}

// "Desinstalar": first what goes (the folder, files, size), then the whole folder is erased.
async function uninstallGame(g) {
  let info;
  try {
    info = await invoke('uninstall_info', { id: g.id });
  } catch (e) {
    toast(String(e), true);
    return;
  }
  const size = info.bytes >= 1073741824 ? `${(info.bytes / 1073741824).toFixed(1).replace('.', ',')} GB` : sizeLabel(info.bytes);
  const answer = await askDanger({
    title: `Desinstalar ${esc(g.title)}?`,
    ok: 'Desinstalar e apagar',
    html: `
      <p>Todos os arquivos do port vão ser <b>apagados deste PC</b>:</p>
      <code class="ask-path">${esc(info.path)}</code>
      <p class="ask-size">${info.files.toLocaleString('pt-BR')} arquivo${info.files === 1 ? '' : 's'} · ${size}</p>
      ${info.own_folder ? '<p class="bad-text"><b>Esta pasta foi escolhida por você</b>, não foi instalada pelo Black Flag. Tudo o que estiver dentro dela vai junto.</p>' : ''}
      ${info.saves.length ? `<label class="check"><input type="checkbox" id="ask-keep" checked>
        Guardar os saves e configurações (${info.saves.map(esc).join(', ')}) para quando instalar de novo.</label>` : ''}
      <p class="muted">Isto não pode ser desfeito. Os arquivos do seu jogo (ROM, dump) que estiverem fora desta pasta não são tocados.</p>`,
  });
  if (!answer) return;
  try {
    const kept = await invoke('uninstall_game', { id: g.id, keepSaves: !!answer['ask-keep'] });
    openId = null;
    await refresh();
    toast(kept.length ? `${g.title} desinstalado. Guardado para depois: ${kept.join(', ')}.` : `${g.title} desinstalado e apagado do PC.`);
  } catch (e) {
    toast(String(e), true);
  }
}

function playRow(g, what) {
  if (IN_GAME.includes(g.status)) {
    return `
      <div class="row">
        <button class="primary play" disabled>${g.status === 'running' ? `Jogando há ${sessionLength(g)}` : 'Abrindo…'}</button>
        ${g.status === 'running' ? '<button data-act="play">Mostrar o jogo</button><button class="danger" data-act="stop">Fechar jogo</button>' : ''}
      </div>
      <p class="muted">O tempo é contado enquanto ${what} estiver aberto e salvo a cada 30 segundos.</p>`;
  }
  return `
    ${resumeBox(g)}
    <div class="row">
      <button class="primary play" data-act="play" ${g.status !== 'ready' ? 'disabled' : ''}>Jogar</button>
    </div>`;
}

// After "Pular esta versão": which one was skipped, and the way back.
function skippedNote(g) {
  if (!g.skipped_version || g.update_available) return '';
  return `<p class="muted">Você pulou a versão ${esc(g.skipped_version)}. O Black Flag avisa de novo quando sair uma mais nova.
    <button class="link" data-act="unskip-update">Avisar desta também</button></p>`;
}

function shortcutsRow(g) {
  return `
    <div class="box">
      <h3>Atalhos</h3>
      <div class="row">
        <button data-act="shortcut-desktop">Na área de trabalho</button>
        <button data-act="shortcut-start">No menu Iniciar</button>
        <button data-act="steam-add">Na Steam</button>
        ${g.kind === 'port' ? '<button class="ghost" data-act="saves">Abrir pasta de saves</button>' : ''}
      </div>
      <p class="muted">Os atalhos abrem o jogo pelo Black Flag, então o tempo de jogo continua contando. Na Steam ele aparece
        como "jogo não Steam" e funciona no Big Picture; feche a Steam antes.</p>
    </div>`;
}

function renderPcDetail(g) {
  const missing = g.status === 'missing' ? `
    <div class="box bad">
      <h3>${g.kind === 'emulated' ? 'Arquivo do jogo não encontrado' : 'Programa não encontrado'}</h3>
      <p>O Black Flag não achou mais ${esc(g.install_dir)}. Se você moveu o jogo, ${g.kind === 'emulated' ? 'use Procurar jogos em Emuladores' : 'remova-o da biblioteca e adicione de novo'}.</p>
    </div>` : '';
  $('#detail').innerHTML = `
    <button class="ghost back" data-act="back">← Biblioteca</button>
    <div class="detail">
      <div>${coverColumn(g)}</div>
      <div>
        <h2>${esc(g.title)}</h2>
        <div class="credit">${g.kind === 'emulated' ? `Jogo de ${esc(g.family)}, aberto pelo ${esc(g.emulator || 'emulador')}.` : g.store ? storeCredit(g) : 'Jogo de PC adicionado por você.'}</div>
        <div>${chips(g)}</div>
        <div class="stats">
          <div><div class="k">Tempo de jogo</div><div class="v">${playTime(g.total_seconds)}</div></div>
          <div><div class="k">Última sessão</div><div class="v">${lastPlayed(g.last_played)}</div></div>
        </div>
        ${playRow(g, 'o jogo')}
        ${folderLine(g)}
        ${missing}
        ${emuGameBox(g)}
        ${crashBox(g)}
        ${pcCheckBox(g, 'bad')}
        ${pcCheckBox(g, 'warn')}
        ${pageTabs(g.id, [
          ['geral', 'Visão geral', ''],
          ['saves', 'Saves', ''],
          ['conquistas', 'Conquistas', ''],
          ['ajustes', 'Ajustes', `
            ${artBox(g)}
            <div class="box">
              <h3>Nome</h3>
              <div class="tags-edit">
                <input type="text" id="title-input" value="${esc(g.title)}">
                <button data-act="rename">Renomear</button>
              </div>
            </div>
            ${gfxBox(g)}
            ${shortcutsRow(g)}
            ${launchBox(g)}
            ${tagsBox(g)}
            ${g.kind === "emulated" ? "" : crashScan(g)}
            ${manageRow(g)}`],
        ])}
      </div>
    </div>`;
}

function progressBox(g) {
  const p = progress[g.id] || { stage: 'download', done: 0, total: 0 };
  const label = { download: 'Baixando do GitHub do projeto', verify: 'Conferindo o download', extract: 'Descompactando' }[p.stage];
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const mb = (n) => (n / 1048576).toFixed(1);
  const amount = p.stage === 'download' && p.total ? ` · ${mb(p.done)} de ${mb(p.total)} MB` : '';
  return `
    <div class="box">
      <h3>${label}${amount}</h3>
      <div class="progress"><div style="width:${pct}%"></div></div>
    </div>`;
}

const COVER_SOURCE = {
  profile: 'Sua capa neste perfil (Ajustes > Minhas capas)',
  custom: 'Capa escolhida por você',
  own_files: 'Capa dos seus arquivos do jogo',
  downloaded: 'Capa baixada',
  api: 'Capa da SteamGridDB ou da IGDB',
};

// ---- SteamGridDB / IGDB: banner and "Sobre o jogo" on the game page ----

const metaCache = {};   // id -> 'loading' | MetaView | { error }

async function loadMeta(id, { term = null, again = false } = {}) {
  metaCache[id] = 'loading';
  if (openId === id) render();
  try {
    const m = await invoke('game_meta', { id, term, again });
    metaCache[id] = m;
    const i = games.findIndex((x) => x.id === id);
    if (i >= 0) games[i] = m.game;
  } catch (e) {
    metaCache[id] = { error: String(e) };
  }
  if (openId === id) render();
}

function metaCredits(m) {
  const parts = [];
  if (m.cover_from) parts.push(`capa: ${m.cover_from}`);
  if (m.banner_from) parts.push(`banner: ${m.banner_from}`);
  if (m.summary) parts.push('descrição: IGDB');
  return parts.length ? `Fontes: ${parts.join(' · ')}.` : '';
}

function metaSearch(m) {
  return `
    <details class="meta-search">
      <summary>Não é este jogo? Buscar com outro nome</summary>
      <div class="tags-edit">
        <input type="text" id="meta-term" value="${esc(m.term || '')}" maxlength="120">
        <button data-act="meta-search">Buscar</button>
      </div>
    </details>`;
}

function aboutBox(g) {
  const m = metaCache[g.id];
  if (m === 'loading') return '<div class="box"><p class="muted">Carregando capa, banner e descrição…</p></div>';
  if (!m) return '';
  if (m.error) return `<p class="muted">${esc(m.error)}</p>`;
  if (!m.cached) {
    if (m.keys) return '';
    return `
      <div class="box">
        <p class="muted">Para ver capa, banner e descrição deste jogo, coloque sua chave gratuita da SteamGridDB ou da IGDB em Configurações.</p>
        <div class="row"><button class="ghost" data-act="open-settings">Abrir Configurações</button></div>
      </div>`;
  }
  const errors = m.errors.length ? `<p class="muted">${m.errors.map(esc).join(' ')}</p>` : '';
  if (!m.found) {
    return `
      <div class="box warn">
        <h3>Não encontrei "${esc(m.term)}" na SteamGridDB nem na IGDB</h3>
        ${errors}
        <div class="tags-edit">
          <input type="text" id="meta-term" value="${esc(m.term)}" maxlength="120">
          <button data-act="meta-search">Buscar com este nome</button>
        </div>
      </div>`;
  }
  const facts = [
    m.released ? `Lançado em ${new Date(m.released * 1000).getFullYear()}` : '',
    m.genres.length ? m.genres.map(esc).join(', ') : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="box about">
      <h3>Sobre o jogo${m.name && m.name !== g.title ? `: ${esc(m.name)}` : ''}</h3>
      ${facts ? `<p class="muted">${facts}</p>` : ''}
      ${m.summary ? `<p>${esc(m.summary)}</p><p class="muted">Descrição em inglês, da IGDB.</p>` : ''}
      <p class="muted">${esc(metaCredits(m))} Guardado no seu PC; só é buscado de novo quando você pedir.</p>
      ${errors}
      <div class="row">
        ${m.igdb_url ? `<button class="link" data-act="link" data-url="${esc(m.igdb_url)}">Página na IGDB</button>` : ''}
        <button class="ghost" data-act="meta-again">Buscar de novo</button>
      </div>
      ${metaSearch(m)}
    </div>`;
}

// ---- "Seu progresso" (estado, histórico, anotações) and the Estatísticas page ----

const COMPLETION = [
  ['not_played', 'Não jogado'],
  ['planned', 'Na fila'],
  ['playing', 'Jogando'],
  ['on_hold', 'Pausado'],
  ['beaten', 'Zerado'],
  ['completed', 'Completo (100%)'],
  ['abandoned', 'Abandonado'],
];
const completionOf = (g) => (g.completion !== 'none' ? g.completion : g.total_seconds > 0 ? 'playing' : 'not_played');
const completionLabel = (key) => (COMPLETION.find((c) => c[0] === key) || [key, key])[1];
const historyCache = {};   // id -> 'loading' | { sessions, recorded, average_seconds, longest_seconds }

function shortTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  return m ? `${m} min` : `${seconds} s`;
}

function sessionDate(unix) {
  return new Date(unix * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function progressBoxHtml(g) {
  const h = historyCache[g.id];
  let history = '<p class="muted">Carregando o histórico…</p>';
  if (h && h !== 'loading') {
    history = h.sessions.length ? `
      <div class="stats">
        <div><div class="k">Vezes jogado</div><div class="v">${g.play_count}</div></div>
        <div><div class="k">Sessão média</div><div class="v">${shortTime(h.average_seconds)}</div></div>
        <div><div class="k">Maior sessão</div><div class="v">${shortTime(h.longest_seconds)}</div></div>
      </div>
      <details>
        <summary class="muted">Últimas sessões (${Math.min(h.sessions.length, 30)} de ${h.recorded})</summary>
        <ul class="sessions">${h.sessions.map((r) =>
          `<li><span>${sessionDate(r.start)}</span><b>${shortTime(r.seconds)}</b></li>`).join('')}</ul>
      </details>` : '<p class="muted">Nenhuma sessão registrada ainda. O histórico começa a contar a partir desta versão.</p>';
  }
  const current = completionOf(g);
  return `
    <div class="box progress-box">
      <h3>Seu progresso</h3>
      <div class="tags-edit">
        <label for="completion">Estado:</label>
        <select id="completion" data-change="completion">
          ${COMPLETION.map(([k, label]) => `<option value="${k}" ${k === current ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
      ${history}
      <p><b>Anotações</b></p>
      <textarea id="notes" spellcheck="true" placeholder="Onde parou, códigos, o que falta fazer…">${esc(g.notes)}</textarea>
      <div class="row"><button data-act="notes-save">Salvar anotações</button></div>
    </div>`;
}

function decorateProgress(g) {
  if (!g.in_library) return;
  if (historyCache[g.id] === undefined) {
    historyCache[g.id] = 'loading';
    setTimeout(async () => {
      try {
        historyCache[g.id] = await invoke('get_history', { id: g.id });
      } catch {
        delete historyCache[g.id];
        return;
      }
      if (openId === g.id) render();
    }, 0);
  }
  const right = document.querySelector('#pane-geral');
  if (!right) return;
  right.insertAdjacentHTML('beforeend', progressBoxHtml(g));
  const select = document.getElementById('completion');
  if (select) {
    select.addEventListener('change', async () => {
      const updated = await call('set_completion', { id: g.id, completion: select.value });
      if (updated) setGame(updated);
    });
  }
}

// ---- Backups dos saves (automáticos, travar, restaurar; Ludusavi para jogos de PC) ----

const backupCache = {};   // id -> 'loading' | GameBackups
const REASON = { 'ao fechar o jogo': 'ao fechar o jogo', manual: 'manual', 'antes de restaurar': 'antes de restaurar' };

function sizeLabel(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function backupsBoxHtml(g) {
  const b = backupCache[g.id];
  if (!b || b === 'loading') return '<div class="box"><h3>Backups dos saves</h3><p class="muted">Carregando…</p></div>';
  if (g.kind === 'pc_game') {
    if (!b.ludusavi) {
      return `
        <div class="box">
          <h3>Backups dos saves</h3>
          <p class="muted">O Black Flag não sabe onde este jogo guarda os saves. Com o <b>Ludusavi</b> (gratuito, conhece mais de
            19 mil jogos) instalado neste PC, o Black Flag pede o backup a ele.</p>
          <div class="row">
            <button class="link" data-act="link" data-url="https://github.com/mtkennerly/ludusavi">Página do Ludusavi</button>
            <button class="ghost" data-act="open-settings">Configurar em Configurações</button>
          </div>
        </div>`;
    }
    return `
      <div class="box">
        <h3>Backups dos saves (pelo Ludusavi)</h3>
        <p class="muted">Nome do jogo no Ludusavi (deixe vazio para o Black Flag procurar pelo nome da biblioteca):</p>
        <div class="tags-edit">
          <input type="text" id="ludusavi-name" value="${esc(b.ludusavi_name || '')}" placeholder="${esc(g.title)}">
          <button data-act="ludusavi-name">Salvar nome</button>
        </div>
        <div class="row"><button data-act="ludusavi-backup">Fazer backup pelo Ludusavi</button></div>
        <p class="muted">O backup vai para a pasta de backups configurada no próprio Ludusavi; restaure por ele.</p>
      </div>`;
  }
  if (!b.sources.length) {
    return `
      <div class="box">
        <h3>Backups dos saves</h3>
        <p class="muted">Ainda não há pasta de saves deste jogo. Ela aparece depois que você salvar no jogo pela primeira vez.</p>
      </div>`;
  }
  const running = IN_GAME.includes(g.status);
  const list = b.backups.length ? `<ul class="backups">${b.backups.map((x) => `
      <li>
        <span><b>${sessionDate(x.created)}</b> · ${esc(REASON[x.reason] || x.reason)} · ${x.files} arquivo(s), ${sizeLabel(x.bytes)}</span>
        <span class="row">
          <button class="ghost small" data-act="backup-lock" data-file="${esc(x.file)}" data-locked="${x.locked}"
            title="${x.locked ? 'Travado: nunca é apagado automaticamente' : 'Travar para nunca ser apagado'}">${x.locked ? '🔒 Travado' : 'Travar'}</button>
          <button class="small" data-act="backup-restore" data-file="${esc(x.file)}" ${running ? 'disabled' : ''}>Restaurar</button>
        </span>
      </li>`).join('')}</ul>` : '<p class="muted">Nenhum backup ainda.</p>';
  return `
    <div class="box">
      <h3>Backups dos saves</h3>
      <p class="muted">${b.auto_backup
        ? `Backup automático ao fechar o jogo, só quando os saves mudaram. Ficam os ${b.keep} mais recentes, além dos travados.`
        : 'Backup automático desligado em Configurações.'}
        ${b.last_change ? `Último save: <b>${sessionDate(b.last_change)}</b>.` : ''}</p>
      ${list}
      ${profiles && profiles.list.length > 1 || (profiles && profiles.separate_saves.includes(g.id)) ? `
        <label class="check"><input type="checkbox" data-act="separate-saves" data-on="${profiles.separate_saves.includes(g.id)}"
          ${profiles.separate_saves.includes(g.id) ? 'checked' : ''} ${running ? 'disabled' : ''}>
          Saves separados por perfil: cada perfil tem os próprios saves deste jogo (trocados ao trocar de perfil, com backup antes).</label>` : ''}
      <div class="row">
        <button data-act="backup-now">Fazer backup agora</button>
        <button class="ghost" data-act="backup-folder">Abrir pasta dos backups</button>
      </div>
      <p class="muted">Restaurar troca a pasta de saves inteira pela do backup; antes disso, os saves atuais viram um backup
        "antes de restaurar". ${b.sources.map(([, p]) => esc(p)).join(' · ')}</p>
    </div>`;
}

function decorateBackups(g) {
  if (!g.in_library) return;
  if (backupCache[g.id] === undefined) {
    backupCache[g.id] = 'loading';
    setTimeout(async () => {
      try {
        backupCache[g.id] = await invoke('get_backups', { id: g.id });
      } catch {
        delete backupCache[g.id];
        return;
      }
      if (openId === g.id) render();
    }, 0);
  }
  const pane = document.querySelector('#pane-saves');
  if (pane) pane.insertAdjacentHTML('beforeend', backupsBoxHtml(g));
}

async function reloadBackups(id) {
  try {
    backupCache[id] = await invoke('get_backups', { id });
  } catch {
    delete backupCache[id];
  }
  if (openId === id) render();
}

// ---- Minhas capas: the active profile's own pictures for a game ----

const artCache = {};   // id -> 'loading' | ArtView

function artBox(g) {
  if (!g.in_library) return '';
  const a = artCache[g.id];
  if (a === undefined) {
    artCache[g.id] = 'loading';
    invoke('get_game_art', { id: g.id })
      .then((v) => { artCache[g.id] = v; if (openId === g.id) render(); })
      .catch(() => { delete artCache[g.id]; });
    return '';
  }
  if (a === 'loading') return '';
  return `
    <div class="box">
      <h3>Minhas capas</h3>
      <p class="muted">Só do perfil ${esc(a.profile)}: os outros perfis continuam vendo a capa da biblioteca.</p>
      <div class="art-list">
        <div class="art-item${a.active === null ? ' on' : ''}">
          <div class="art-library">Capa da biblioteca</div>
          <div class="row"><button class="small" data-act="art-use" data-v="">Mostrar</button></div>
        </div>
        ${a.covers.map((c, i) => `
          <div class="art-item${a.active === i ? ' on' : ''}">
            ${c.image ? `<img src="${c.image}" alt="">` : '<div class="art-library">imagem sumiu</div>'}
            <input type="text" class="art-caption" data-i="${i}" value="${esc(c.caption)}" placeholder="Legenda (ex.: minha versão)" maxlength="40">
            <div class="row">
              <button class="small" data-act="art-use" data-v="${i}">Mostrar</button>
              <button class="ghost small danger" data-act="art-remove" data-v="${i}">Tirar</button>
            </div>
          </div>`).join('')}
      </div>
      <div class="row"><button data-act="art-add" data-v="cover">Adicionar capa</button></div>
      <h4>Fundo no Modo TV</h4>
      ${a.background ? `<div class="profile-banner-preview" style="background-image:url('${a.background}')"></div>` : '<p class="muted">Sem fundo próprio: o Modo TV usa o banner ou a capa do jogo.</p>'}
      <div class="row">
        <button data-act="art-add" data-v="background">${a.background ? 'Trocar o fundo' : 'Escolher fundo'}</button>
        ${a.background ? '<button class="ghost danger" data-act="art-remove" data-v="">Tirar o fundo</button>' : ''}
      </div>
    </div>`;
}

// The banner preview follows the chosen part right away.
document.addEventListener('change', (e) => {
  if (e.target.id !== 'look-banner-pos') return;
  const prev = $('#banner-preview');
  if (prev) prev.style.backgroundPosition = `center ${e.target.value}`;
});

// A caption is kept when the field loses the focus.
document.addEventListener('change', async (e) => {
  if (!e.target.classList || !e.target.classList.contains('art-caption') || !openId) return;
  try {
    artCache[openId] = await invoke('caption_game_art', { id: openId, index: Number(e.target.dataset.i), caption: e.target.value });
    toast('Legenda salva.');
  } catch (err) {
    toast(String(err), true);
  }
});

async function artChanged(g, view) {
  if (!view) return;
  artCache[g.id] = view;
  setGame(await call('get_game', { id: g.id }));
}

// ---- Onde eu parei: a note when the game closes, shown when you come back ----

const RESUME_CHIPS = ['Num chefe', 'Explorando', 'Começando um capítulo novo', 'Fazendo missões secundárias', 'Juntando itens', 'Perto do fim'];
const RESUME_MIN_SECONDS = 120;
let resumeAsk = null;   // { id, title, seconds } while the question is open

function daysAgo(at) {
  const days = Math.floor((Date.now() / 1000 - at) / 86400);
  return days <= 0 ? 'hoje' : days === 1 ? 'ontem' : `há ${days} dias`;
}

function resumeOpen(g, seconds) {
  resumeAsk = { id: g.id, title: g.title, seconds };
  const el = $('#resume');
  el.innerHTML = `
    <div class="resume-card">
      <h2>Onde você parou?</h2>
      <p class="muted">${esc(g.title)} · sessão de ${playTime(seconds).toLowerCase()}. Um recado para você do futuro, que aparece quando voltar a este jogo.</p>
      <div class="resume-chips">${RESUME_CHIPS.map((c) => `<button class="tag" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <input type="text" id="resume-text" maxlength="140" placeholder="Ex.: no chefe do trem, falta a chave azul" value="${esc((g.resume && g.resume.text) || '')}">
      <div class="row">
        <button class="primary" data-resume="save">Guardar recado</button>
        <button class="ghost" data-resume="skip">Agora não</button>
      </div>
    </div>`;
  el.hidden = false;
  el.querySelectorAll('[data-chip]').forEach((b) => b.addEventListener('click', () => {
    const input = $('#resume-text');
    input.value = input.value ? `${input.value}, ${b.dataset.chip.toLowerCase()}` : b.dataset.chip;
  }));
  el.querySelector('[data-resume="save"]').addEventListener('click', resumeSave);
  el.querySelector('[data-resume="skip"]').addEventListener('click', resumeClose);
  if (document.body.classList.contains('pad-on')) setTimeout(() => padFocus(el.querySelector('[data-chip]')), 0);
}

function resumeClose() {
  resumeAsk = null;
  $('#resume').hidden = true;
}

async function resumeSave() {
  const a = resumeAsk;
  const text = $('#resume-text').value.trim();
  resumeClose();
  if (!a || !text) return;
  try {
    setGame(await invoke('set_resume_note', { id: a.id, text, seconds: a.seconds }));
    toast('Recado guardado.');
  } catch (e) {
    toast(String(e), true);
  }
}

// On the game page: the note, standing out after a few days away.
function resumeBox(g) {
  const r = g.resume;
  if (!r) return '';
  const old = Date.now() / 1000 - r.at > 3 * 86400;
  return `
    <div class="resume-note${old ? ' old' : ''}">
      <span class="k">Onde você parou · ${daysAgo(r.at)}${r.seconds ? ` · sessão de ${playTime(r.seconds).toLowerCase()}` : ''}</span>
      <p>${esc(r.text)}</p>
      <button class="link small-text" data-act="resume-clear">Apagar recado</button>
    </div>`;
}

// ---- Perfis ----

let profiles = null;        // { active, list, ask_on_start, separate_saves, colors }
let profileForm = null;     // { id|null, name, color } while creating or editing

const avatar = (p, big = false) => p.avatar
  ? `<span class="avatar img${big ? ' big' : ''}" style="border-color:${esc(p.color)}"><img src="${p.avatar}" alt=""></span>`
  : `<span class="avatar${big ? ' big' : ''}" style="background:${esc(p.color)}">${esc((p.name || '?').trim().charAt(0).toUpperCase())}</span>`;

// The active profile's look: its color as the accent, cover size, text size, list, motion, tabs.
function applyLook() {
  const p = profiles && profiles.active;
  if (!p) return;
  const root = document.documentElement.style;
  if (p.accent) {
    root.setProperty('--red', p.color);
  } else {
    root.removeProperty('--red');
  }
  const l = p.look || {};
  const body = document.body.classList;
  body.toggle('cards-pequeno', l.cards === 'pequeno');
  body.toggle('cards-grande', l.cards === 'grande');
  body.toggle('big-text', !!l.big_text);
  body.toggle('list-view', !!l.list);
  body.toggle('no-motion', l.motion === false);
  const hidden = l.hidden_tabs || [];
  document.querySelectorAll('#tabs button[data-tab]').forEach((b) => (b.hidden = hidden.includes(b.dataset.tab)));
  if (hidden.includes(tab)) tab = 'all';
}

// Right after a profile is chosen (at start or by switching): its first tab and, at start, the TV.
let startingUp = true;
function profileReady() {
  applyLook();
  const l = (profiles && profiles.active.look) || {};
  if (l.home) tab = l.home;
  openId = null;
  render();
  if (startingUp && l.start_tv) tvOpen();
  startingUp = false;
}

function renderProfileChip() {
  const btn = $('#btn-profile');
  if (!profiles) { btn.hidden = true; return; }
  btn.hidden = false;
  btn.innerHTML = `${avatar(profiles.active)}<span>${esc(profiles.active.name)}</span>`;
}

// Everything cached on screen belongs to the previous profile.
function forgetProfileCaches() {
  for (const c of [historyCache, backupCache, achCache, raCache, modsState, artCache]) for (const id of Object.keys(c)) delete c[id];
  raResult = null;
  statsData = null;
}

async function loadProfiles() {
  profiles = await call('get_profiles');
  renderProfileChip();
  applyLook();
}

async function switchProfile(id) {
  if (profiles && profiles.active.id === id) return true;
  try {
    profiles = await invoke('switch_profile', { id });
  } catch (e) {
    toast(String(e), true);
    return false;
  }
  forgetProfileCaches();
  renderProfileChip();
  applyLook();
  const home = profiles.active.look && profiles.active.look.home;
  if (home) tab = home;
  await refresh();
  toast(`Perfil: ${profiles.active.name}.`);
  return true;
}

function profileFormHtml() {
  const f = profileForm;
  if (!f) return '';
  return `
    <div class="box">
      <h3>${f.id ? 'Editar perfil' : 'Novo perfil'}</h3>
      <div class="tags-edit">
        <input type="text" id="profile-name" maxlength="30" value="${esc(f.name)}" placeholder="Nome">
      </div>
      <div class="swatches">${profiles.colors.map((c) =>
        `<button class="swatch${c === f.color ? ' on' : ''}" style="background:${c}" data-act="profile-color" data-color="${c}" title="Cor"></button>`).join('')}
        <label class="color-pick" title="Qualquer cor"><input type="color" id="profile-color" value="${esc(f.color)}"> outra cor</label></div>
      ${f.id ? profileLookHtml(profiles.list.find((x) => x.id === f.id)) : '<p class="muted">Depois de criar, edite o perfil para pôr foto, capa e escolher a aparência.</p>'}
      <div class="row">
        <button class="primary" data-act="profile-save">${f.id ? 'Salvar' : 'Criar'}</button>
        <button class="ghost" data-act="profile-cancel">Cancelar</button>
        ${f.id && f.id !== profiles.active.id ? `<button data-act="profile-use" data-id="${esc(f.id)}">Usar este perfil</button>` : ''}
        ${f.id ? `<button class="ghost" data-act="profile-export" data-id="${esc(f.id)}">Exportar</button>` : ''}
        ${f.id && f.id !== profiles.active.id ? `<button class="ghost danger" data-act="profile-delete" data-id="${esc(f.id)}">Apagar perfil</button>` : ''}
      </div>
    </div>`;
}

const TAB_NAMES = { all: 'Todos', port: 'Ports', emu: 'Emulados', steam: 'Steam', epic: 'Epic', gog: 'GOG', pc_game: 'Jogos de PC', community: 'Comunidade' };

// Pictures and look of one profile, inside its edit form.
function profileLookHtml(x) {
  if (!x) return '';
  const l = x.look || {};
  const opt = (v, label, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`;
  const withCover = games.filter((g) => g.in_library && g.cover).sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  return `
    <div class="profile-pics">
      <div>
        <h4>Foto</h4>
        ${avatar(x, true)}
        <div class="row">
          <button class="small" data-act="profile-pic" data-v="avatar">Escolher imagem</button>
          ${withCover.length ? `<select id="profile-pic-game"><option value="">ou a capa de um jogo…</option>${withCover.map((g) => `<option value="${esc(g.id)}">${esc(g.title)}</option>`).join('')}</select>
            <button class="small" data-act="profile-pic-game" data-v="avatar">Usar a capa</button>` : ''}
          ${x.avatar ? '<button class="ghost small danger" data-act="profile-pic-clear" data-v="avatar">Tirar</button>' : ''}
        </div>
      </div>
      <div>
        <h4>Capa do perfil</h4>
        <div class="profile-banner-preview" id="banner-preview"${x.banner ? ` style="background-image:url('${x.banner}');background-position:${bannerPos(x)}"` : ''}>${x.banner ? '' : '<span class="muted">sem capa</span>'}</div>
        <div class="row">
          <button class="small" data-act="profile-pic" data-v="banner">Escolher imagem larga</button>
          ${withCover.length ? `<select id="profile-banner-game"><option value="">ou a arte de um jogo…</option>${withCover.map((g) => `<option value="${esc(g.id)}">${esc(g.title)}</option>`).join('')}</select>
            <button class="small" data-act="profile-pic-game" data-v="banner">Usar a arte</button>` : ''}
          ${x.banner ? '<button class="ghost small danger" data-act="profile-pic-clear" data-v="banner">Tirar</button>' : ''}
        </div>
        ${x.banner ? `<label class="inline-field">Parte que aparece
          <select id="look-banner-pos">${opt('top', 'De cima', l.banner_pos)}${opt('center', 'Do meio', l.banner_pos)}${opt('bottom', 'De baixo', l.banner_pos)}</select></label>` : ''}
        <label class="check"><input type="checkbox" id="look-banner-home" ${l.banner_home !== false ? 'checked' : ''}>
          Mostrar a capa no alto da biblioteca, com "Continuar jogando".</label>
        <p class="muted small-text">Aparece também no "Quem vai jogar?", no alto de "Gerenciar perfis" e no fundo do Modo TV.</p>
      </div>
    </div>
    <h4>Aparência</h4>
    <label class="check"><input type="checkbox" id="look-accent" ${x.accent ? 'checked' : ''}>
      Usar a cor deste perfil no programa, no lugar do vermelho.</label>
    <div class="look-grid">
      <label>Capas na biblioteca <select id="look-cards">${opt('pequeno', 'Pequenas', l.cards)}${opt('medio', 'Médias', l.cards)}${opt('grande', 'Grandes', l.cards)}</select></label>
      <label>Fundo do programa <select id="look-page-bg">${opt('perfil', 'A capa do perfil', l.page_bg || 'perfil')}${opt('jogo', 'O último jogo jogado', l.page_bg)}${opt('nenhum', 'Preto, sem imagem', l.page_bg)}</select></label>
      <label>Abrir na aba <select id="look-home">${Object.entries(TAB_NAMES).map(([k, v]) => opt(k, v, l.home)).join('')}</select></label>
    </div>
    <label class="check"><input type="checkbox" id="look-list" ${l.list ? 'checked' : ''}> Biblioteca em lista, em vez de capas.</label>
    <label class="check"><input type="checkbox" id="look-big" ${l.big_text ? 'checked' : ''}> Letras maiores.</label>
    <label class="check"><input type="checkbox" id="look-motion" ${l.motion !== false ? 'checked' : ''}> Animações (capas que crescem, telas que deslizam).</label>
    <label class="check"><input type="checkbox" id="look-sounds" ${l.sounds !== false ? 'checked' : ''}> Sons e vibração do controle no Modo TV.</label>
    <label class="check"><input type="checkbox" id="look-tv" ${l.start_tv ? 'checked' : ''}> Abrir direto no Modo TV.</label>
    <p class="muted">Abas que aparecem:</p>
    <div class="tags-edit">${Object.entries(TAB_NAMES).filter(([k]) => k !== 'all').map(([k, v]) =>
      `<label class="check inline"><input type="checkbox" class="look-tab" value="${k}" ${(l.hidden_tabs || []).includes(k) ? '' : 'checked'}> ${v}</label>`).join('')}</div>`;
}

// The look as the edit form has it now.
function lookFromForm() {
  return {
    cards: $('#look-cards').value,
    home: $('#look-home').value,
    list: $('#look-list').checked,
    big_text: $('#look-big').checked,
    motion: $('#look-motion').checked,
    sounds: $('#look-sounds').checked,
    start_tv: $('#look-tv').checked,
    hidden_tabs: [...document.querySelectorAll('.look-tab')].filter((c) => !c.checked).map((c) => c.value),
    banner_pos: $('#look-banner-pos') ? $('#look-banner-pos').value : 'center',
    banner_home: $('#look-banner-home').checked,
    page_bg: $('#look-page-bg').value,
  };
}

function renderProfiles() {
  const p = profiles;
  $('#detail').innerHTML = `
    <button class="ghost back" data-act="back">← Biblioteca</button>
    <div class="covers-page">
      ${(() => {
        const hp = (profileForm && profileForm.id && p.list.find((x) => x.id === profileForm.id)) || p.active;
        return hp.banner ? `<div class="profile-hero" style="background-image:url('${hp.banner}');background-position:${bannerPos(hp)}">${avatar(hp, true)}<b>${esc(hp.name)}</b></div>` : '';
      })()}
      <h2 class="manage-title">Gerenciar perfis</h2>
      <p class="muted manage-sub">Escolha um perfil para mudar foto, capa, cor e aparência. Cada um tem o próprio tempo de jogo,
        histórico, favoritos, conquistas e recados; os jogos instalados são os mesmos para todos.</p>
      <div class="who-list manage">
        ${p.list.map((x) => `
          <button class="who-item${profileForm && profileForm.id === x.id ? ' sel' : ''}" data-act="profile-edit" data-id="${esc(x.id)}">
            <span class="who-face">${avatar(x, true)}<span class="who-pen">✎</span></span>
            <span class="who-name">${esc(x.name)}${x.id === p.active.id ? '<small>em uso</small>' : ''}</span>
          </button>`).join('')}
        ${p.list.length < MAX_PROFILES ? `
          <button class="who-item who-add${profileForm && !profileForm.id ? ' sel' : ''}" data-act="profile-new">
            <span class="who-face"><span class="who-plus">+</span></span><span class="who-name">Adicionar perfil</span>
          </button>` : ''}
      </div>
      ${profileFormHtml()}
      <div class="box">
        <h3>Levar o perfil para outro PC</h3>
        <p class="muted">"Exportar" salva um arquivo .zip com o nome, a cor, a foto, a capa, a aparência, as suas capas dos jogos e o progresso (tempo, favoritos, anotações, recados). No outro PC, importe esse arquivo: ele vira um perfil novo, sem apagar nenhum.</p>
        <div class="row"><button data-act="profile-import">Importar perfil</button></div>
      </div>
      ${raAccountBox()}
      <div class="box">
        <label class="check"><input type="checkbox" id="profile-ask" ${p.ask_on_start ? 'checked' : ''}>
          Perguntar "Quem vai jogar?" ao abrir o Black Flag (quando houver mais de um perfil).</label>
        <div class="row"><button data-act="profile-options">Salvar</button></div>
      </div>
      <p class="muted">Saves separados por perfil: ligue na caixa "Backups dos saves" da página de cada jogo.
        Trocar de perfil é recusado com um jogo aberto.</p>
    </div>`;
  document.querySelectorAll('#detail [data-act]').forEach((el) =>
    el.addEventListener('click', () => act(el.dataset.act, null, el)));
}

async function openProfiles() {
  await loadProfiles();
  raResult = null;
  profileForm = null;
  openId = '__profiles';
  render();
}

// "Quem vai jogar?", as the Netflix profile screen: big pictures in a row, the name under each,
// "Adicionar perfil" at the end and "Gerenciar perfis" below. Mouse, keyboard (setas + Enter)
// or controller (direcional + A). Opened by the profile button too, to switch at any time.
let whoSel = 0;          // 0..n-1 a profile, n "Adicionar perfil", -1 "Gerenciar perfis"
const whoPad = { held: {}, nextAt: 0 };
const MAX_PROFILES = 12;

// Where a wide picture is cut, as the profile chose (Perfil > Capa do perfil).
function bannerPos(p) {
  const pos = (p && p.look && p.look.banner_pos) || 'center';
  return `center ${pos}`;
}

function whoCanAdd() {
  return profiles.list.length < MAX_PROFILES;
}

function renderWho() {
  const el = $('#who');
  const n = profiles.list.length;
  const chosen = profiles.list[whoSel];
  const tile = (i, face, name, cls = '') => `
    <button class="who-item${cls}${i === whoSel ? ' sel' : ''}" data-i="${i}">
      <span class="who-face">${face}</span><span class="who-name">${name}</span>
    </button>`;
  el.innerHTML = `
    ${chosen && chosen.banner ? `<div class="who-art" style="background-image:url('${chosen.banner}');background-position:${bannerPos(chosen)}"></div>` : ''}
    <h1>Quem vai jogar?</h1>
    <div class="who-list">
      ${profiles.list.map((x, i) => tile(i, avatar(x, true), esc(x.name), x.id === profiles.active.id ? ' current' : '')).join('')}
      ${whoCanAdd() ? tile(n, '<span class="who-plus">+</span>', 'Adicionar perfil', ' who-add') : ''}
    </div>
    <button class="who-manage${whoSel === -1 ? ' sel' : ''}" data-manage>Gerenciar perfis</button>
    ${startingUp ? '' : `<p class="muted who-hint"><b>${padKind !== null ? padName('back') : 'Esc'}</b> volta sem trocar</p>`}`;
  el.querySelectorAll('.who-item').forEach((b) => {
    b.addEventListener('click', () => whoPick(Number(b.dataset.i)));
    b.addEventListener('mouseenter', () => { whoSel = Number(b.dataset.i); whoMark(); });
  });
  el.querySelector('[data-manage]').addEventListener('click', () => whoPick(-1));
}

// Only the marks change on hover, so the picture behind does not blink.
function whoMark() {
  document.querySelectorAll('#who .who-item').forEach((b) => b.classList.toggle('sel', Number(b.dataset.i) === whoSel));
  const m = document.querySelector('#who .who-manage');
  if (m) m.classList.toggle('sel', whoSel === -1);
  const chosen = profiles.list[whoSel];
  const art = document.querySelector('#who .who-art');
  if (chosen && chosen.banner) {
    if (art) {
      art.style.backgroundImage = `url('${chosen.banner}')`;
      art.style.backgroundPosition = bannerPos(chosen);
    } else {
      renderWho();
    }
  } else if (art) {
    art.remove();
  }
}

function whoOpen() {
  whoSel = Math.max(0, profiles.list.findIndex((x) => x.id === profiles.active.id));
  $('#who').hidden = false;
  renderWho();
  requestAnimationFrame(whoPoll);
}

function whoClose() {
  $('#who').hidden = true;
  if (startingUp) profileReady();
}

async function whoPick(i) {
  if (i === -1 || i === profiles.list.length) {
    // "Gerenciar perfis" / "Adicionar perfil": the profiles page, with the new profile form open.
    whoClose();
    await openProfiles();
    if (i !== -1) {
      profileForm = { id: null, name: '', color: profiles.colors[profiles.list.length % profiles.colors.length] };
      render();
    }
    return;
  }
  const p = profiles.list[i];
  if (!p) return;
  if (await switchProfile(p.id)) whoClose();
}

// Left and right go through the profiles (and "Adicionar"); down reaches "Gerenciar perfis".
function whoMove(dx, dy = 0) {
  const last = whoCanAdd() ? profiles.list.length : profiles.list.length - 1;
  if (dy > 0) whoSel = -1;
  else if (dy < 0 && whoSel === -1) whoSel = 0;
  else if (dx && whoSel !== -1) whoSel = Math.max(0, Math.min(last, whoSel + dx));
  whoMark();
}

function whoBack() {
  // At start someone has to be chosen; later the screen closes without switching.
  if (!startingUp) $('#who').hidden = true;
}

function whoPoll(t) {
  if ($('#who').hidden) return;
  const p = readPad();
  if (p) {
    if (p.changed) renderWho();
    const e = padEdges(whoPad, p, t, [400, 160]);
    if (e.ok) whoPick(whoSel);
    if (e.back) whoBack();
    if (e.dx || e.dy) whoMove(e.dx, e.dy);
  }
  requestAnimationFrame(whoPoll);
}

document.addEventListener('keydown', (e) => {
  if ($('#who').hidden) return;
  const keys = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (keys[e.key]) { whoMove(...keys[e.key]); e.preventDefault(); }
  else if (e.key === 'Enter') { whoPick(whoSel); e.preventDefault(); }
  else if (e.key === 'Escape') { whoBack(); e.preventDefault(); }
});

// ---- Conquistas ----

const achCache = {};   // id -> 'loading' | GameAchievements
let achSettings = null;
let achSummary = null;

function achItem(a) {
  const locked = !a.unlocked_at;
  const secret = locked && a.hidden;
  const pct = a.goal ? Math.round((a.value / a.goal) * 100) : 0;
  return `
    <li class="ach${locked ? ' locked' : ''}">
      <span class="ach-badge">${secret ? '❔' : esc(a.badge || '🏆')}</span>
      <span class="ach-text">
        <b>${secret ? 'Conquista secreta' : esc(a.title)}</b>
        <span class="muted">${secret ? 'Continue jogando para descobrir.' : esc(a.description)}</span>
        ${locked && !secret && a.goal > 1 ? `<span class="ach-bar"><span style="width:${pct}%"></span></span>` : ''}
        ${a.unlocked_at ? `<span class="muted small-text">Desbloqueada em ${sessionDate(a.unlocked_at)}</span>` : ''}
      </span>
      <span class="ach-pts">${a.points}</span>
    </li>`;
}

function achievementsBoxHtml(g) {
  const c = achCache[g.id];
  if (!c || c === 'loading') return '<div class="box"><h3>Conquistas</h3><p class="muted">Carregando…</p></div>';
  const own = c.list.filter((a) => a.id && c.source && !['primeira-sessao', 'uma-hora', 'dez-horas', 'cinquenta-horas', 'maratona', 'frequentador'].includes(a.id));
  return `
    <details class="box ach-box" ${c.unlocked ? 'open' : ''}>
      <summary><h3>Conquistas: ${c.unlocked} de ${c.total} · ${c.points} de ${c.total_points} pontos</h3></summary>
      <div class="progress"><div style="width:${c.total ? Math.round((c.unlocked / c.total) * 100) : 0}%"></div></div>
      <ul class="achs">${c.list.map(achItem).join('')}</ul>
      <p class="muted">Conquistas do Black Flag, do perfil ${esc(profiles ? profiles.active.name : '')}: tempo de jogo e sessões${c.source ? `, além do progresso lido do seu save (só leitura; o save nunca é alterado). ${c.save_read ? '' : '<b>O save deste jogo ainda não foi encontrado.</b>'}` : '.'}
        Não são conquistas do RetroAchievements.</p>
      ${own.length && c.source ? `<p class="muted small-text">${esc(c.source)}</p>` : ''}
    </details>`;
}

function decorateAchievements(g) {
  if (!g.in_library) return;
  if (achCache[g.id] === undefined) {
    achCache[g.id] = 'loading';
    setTimeout(async () => {
      try {
        achCache[g.id] = await invoke('get_achievements', { id: g.id });
      } catch {
        delete achCache[g.id];
        return;
      }
      if (openId === g.id) render();
    }, 0);
  }
  const pane = document.querySelector('#pane-conquistas');
  if (pane) pane.insertAdjacentHTML('beforeend', achievementsBoxHtml(g));
}

function achievementSettingsBox() {
  const a = achSettings;
  if (!a) return '';
  return `
    <div class="box">
      <h3>Conquistas</h3>
      <label class="check"><input type="checkbox" id="set-ach-overlay" ${a.overlay ? 'checked' : ''}>
        Mostrar "Conquista desbloqueada" num canto da tela, por cima do jogo.</label>
      <label class="check"><input type="checkbox" id="set-ach-sound" ${a.sound ? 'checked' : ''}>
        Tocar um som junto com o aviso.</label>
      <div class="row">
        <button data-act="ach-settings-save">Salvar</button>
        <button class="ghost" data-act="ach-test">Testar aviso</button>
      </div>
      <p class="muted">O aviso aparece por cima de jogos em janela ou em "tela cheia sem bordas" (borderless). Em tela cheia
        exclusiva o Windows não deixa nenhuma janela aparecer por cima; a conquista fica registrada do mesmo jeito.</p>
    </div>`;
}

function achievementsSummaryHtml() {
  const a = achSummary;
  if (!a) return '<div class="box"><h3>Conquistas</h3><p class="muted">Carregando…</p></div>';
  return `
    <div class="box">
      <h3>Conquistas: ${a.unlocked} de ${a.total} · ${a.points} pontos</h3>
      ${a.recent.length ? `<p><b>Mais recentes</b></p><ul class="achs">${a.recent.map((x) => achItem(x).replace('<b>', `<b>${esc((games.find((g) => g.id === x.game) || {}).title || x.game)}: `)).join('')}</ul>` : '<p class="muted">Nenhuma conquista ainda. Jogue algo!</p>'}
      <ul class="top">${a.games.map(([id, title, done, total]) => `
        <li><span class="name">${esc(title)}</span>
          <span class="track"><span style="width:${total ? Math.round((done / total) * 100) : 0}%"></span></span>
          <span class="muted">${done} de ${total}</span></li>`).join('')}</ul>
    </div>`;
}

// ---- RetroAchievements (só leitura, jogo original em emuladores) ----

const raCache = {};   // id -> 'loading' | RaView | { error }
let raResult = null;  // last "Salvar e testar" on the Perfis page

function raBoxHtml(g) {
  const r = raCache[g.id];
  const emulated = g.kind === 'emulated';
  const head = emulated ? '<h3>RetroAchievements</h3>' : '<h3>RetroAchievements: o jogo original</h3>';
  if (!r || r === 'loading') return `<div class="box">${head}<p class="muted">Carregando…</p></div>`;
  if (r.error) return `<div class="box">${head}<p class="muted">${esc(r.error)}</p>
    <div class="row"><button class="ghost" data-act="ra-refresh">Tentar de novo</button></div></div>`;
  if (!r.linked) {
    return emulated ? `<div class="box">${head}<p class="muted">Jogando pelo PCSX2 com o login do RetroAchievements feito
      nele, cada conquista aparece por cima do jogo. Para ver a lista aqui, ponha o seu usuário e a chave de API em Gerenciar
      perfis.</p></div>` : '';
  }
  if (r.message) return `<div class="box">${head}<p class="muted">${esc(r.message)}</p></div>`;
  const earnedCount = r.achievements.filter((a) => a.earned || a.earned_hardcore).length;
  return `
    <details class="box ra-box">
      <summary>${head}</summary>
      <p><b>${esc(r.user)}</b>: ${r.earned} de ${r.total} conquistas${r.earned_hardcore ? ` (${r.earned_hardcore} no modo hardcore)` : ''}
        ${r.completion ? `· ${esc(r.completion)}` : ''}</p>
      <div class="progress"><div style="width:${r.total ? Math.round((r.earned / r.total) * 100) : 0}%"></div></div>
      <ul class="achs">${r.achievements.map((a) => `
        <li class="ach${a.earned || a.earned_hardcore ? '' : ' locked'}">
          <span class="ach-badge">${a.picture ? `<img src="${a.picture}" alt="">` : '🏆'}</span>
          <span class="ach-text"><b>${esc(a.title)}</b><span class="muted">${esc(a.description)}</span>
            ${a.earned_hardcore ? `<span class="muted small-text">Hardcore em ${esc(a.earned_hardcore)}</span>`
              : a.earned ? `<span class="muted small-text">Em ${esc(a.earned)}</span>` : ''}</span>
          <span class="ach-pts">${a.points}</span>
        </li>`).join('')}</ul>
      <p class="muted">${emulated ? `Conquistas do RetroAchievements neste jogo. Quem desbloqueia é o PCSX2, com o login feito
        nele; o Black Flag mostra cada uma por cima do jogo na hora e atualiza esta lista.`
        : 'Conquistas que você ganhou no RetroAchievements jogando o jogo original em emuladores aprovados por ele. O Black Flag só mostra; jogar o port não desbloqueia nada lá.'}
        Atualizado em ${sessionDate(r.fetched_at)} (no máximo a cada 6 horas). ${earnedCount ? '' : 'Ainda nenhuma ganha.'}</p>
      <div class="row">
        <button class="ghost" data-act="ra-refresh">Atualizar agora</button>
        ${r.page ? `<button class="link" data-act="link" data-url="${esc(r.page)}">Página do jogo no RetroAchievements</button>` : ''}
      </div>
    </details>`;
}

async function loadRa(id, force) {
  raCache[id] = 'loading';
  if (openId === id) render();
  try {
    raCache[id] = await invoke('get_ra', { id, force });
  } catch (e) {
    raCache[id] = { error: String(e) };
  }
  if (openId === id) render();
}

function decorateRa(g) {
  // N64 ports (found by the player's ROM) and PS2 games (by the disc, or what PCSX2 told).
  const ps2 = g.kind === 'emulated' && g.system === 'ps2';
  if (!g.in_library || (!ps2 && (g.kind !== 'port' || g.files_kind !== 'file'))) return;
  if (raCache[g.id] === undefined) {
    raCache[g.id] = 'loading';
    setTimeout(() => loadRa(g.id, false), 0);
  }
  const ach = document.querySelector('#detail .ach-box');
  const pane = document.querySelector('#detail #pane-conquistas');
  if (ach) ach.insertAdjacentHTML('afterend', raBoxHtml(g));
  else if (pane) pane.insertAdjacentHTML('afterbegin', raBoxHtml(g));
}

// ---- Steam achievements: read from the Steam client's files on this PC ----

const steamAchCache = {};   // id -> 'loading' | SteamAchView | { error }
let steamAchShowLocked = false;

async function loadSteamAch(id) {
  steamAchCache[id] = 'loading';
  try {
    steamAchCache[id] = await invoke('get_steam_achievements', { id });
  } catch (e) {
    steamAchCache[id] = { error: String(e) };
  }
  if (openId === id) render();
}

function steamAchHtml(g) {
  const r = steamAchCache[g.id];
  const head = '<h3>Conquistas da Steam</h3>';
  if (!r || r === 'loading') return `<div class="box">${head}<p class="muted">Lendo as conquistas que a Steam guarda neste PC…</p></div>`;
  if (r.error) return `<div class="box">${head}<p class="muted">${esc(r.error)}</p></div>`;
  if (!r.found) {
    return `<div class="box">${head}<p class="muted">A Steam ainda não guardou as conquistas deste jogo neste PC. Elas aparecem
      aqui depois da primeira vez que você abrir o jogo pela Steam (se o jogo tiver conquistas).</p></div>`;
  }
  const done = r.achievements.filter((a) => a.unlocked_at);
  const rest = r.achievements.filter((a) => !a.unlocked_at);
  const item = (a) => {
    const secret = a.hidden && !a.unlocked_at;
    return `<li class="ach${a.unlocked_at ? '' : ' locked'}">
      <span class="ach-badge">${a.picture && !secret ? `<img src="${a.picture}" alt="">` : secret ? '❔' : '🏆'}</span>
      <span class="ach-text"><b>${secret ? 'Conquista secreta' : esc(a.title)}</b>
        <span class="muted">${secret ? 'Ela aparece quando você desbloquear.' : esc(a.description)}</span>
        ${a.unlocked_at ? `<span class="muted small-text">Em ${sessionDate(a.unlocked_at)}</span>` : ''}</span>
    </li>`;
  };
  return `
    <details class="box ach-box steam-ach" open>
      <summary>${head}</summary>
      <p>${r.unlocked} de ${r.total} desbloqueadas</p>
      <div class="progress"><div style="width:${r.total ? Math.round((r.unlocked / r.total) * 100) : 0}%"></div></div>
      <ul class="achs">${done.map(item).join('')}${steamAchShowLocked ? rest.map(item).join('') : ''}</ul>
      ${rest.length ? `<div class="row"><button class="ghost" data-act="steam-ach-locked">${steamAchShowLocked ? 'Esconder as que faltam' : `Ver as ${rest.length} que faltam`}</button></div>` : ''}
      <p class="muted">Lidas dos arquivos que a própria Steam guarda neste PC; o Black Flag só mostra. Durante o jogo, cada
        conquista nova também aparece no aviso por cima do jogo.</p>
    </details>`;
}

function decorateSteamAch(g) {
  if (!g.in_library || storeTab(g) !== 'steam') return;
  if (steamAchCache[g.id] === undefined) {
    steamAchCache[g.id] = 'loading';
    setTimeout(() => loadSteamAch(g.id), 0);
  }
  const pane = document.querySelector('#detail #pane-conquistas');
  if (pane) pane.insertAdjacentHTML('afterbegin', steamAchHtml(g));
}

function raAccountBox() {
  const p = profiles.active;
  return `
    <div class="box">
      <h3>RetroAchievements do perfil ${esc(p.name)} (opcional)</h3>
      <p class="muted">Com seu usuário e sua chave de API (no site, em Configurações → Chaves → Web API Key), a página de cada
        port de N64 e de cada jogo de PS2 mostra as suas conquistas do RetroAchievements. Só leitura.</p>
      <div class="tags-edit">
        <input type="text" id="ra-user" maxlength="40" value="${esc(p.ra_user)}" placeholder="Usuário">
        <input type="password" id="ra-key" maxlength="64" autocomplete="off" placeholder="${p.has_ra_key ? 'Chave guardada (vazio mantém)' : 'Web API Key'}">
      </div>
      <div class="row">
        <button data-act="ra-save">Salvar e testar</button>
        ${p.has_ra_key ? '<button class="ghost danger" data-act="ra-clear">Desconectar</button>' : ''}
        <button class="link" data-act="link" data-url="https://retroachievements.org/settings">Abrir o site</button>
      </div>
      ${raResult ? `<p class="${raResult.ok ? 'ok-text' : 'bad-text'}">${esc(raResult.message)}</p>` : ''}
      <p class="muted">A chave fica só neste PC e só vai para o RetroAchievements.</p>
    </div>`;
}

// ---- Central de Mods (Thunderstore) ----

const modsState = {};   // id -> { view, loading, error, search, filter, sort, shown, busy, progress }

function modsOf(id) {
  if (!modsState[id]) modsState[id] = { view: null, loading: false, search: '', filter: 'all', sort: 'popular', shown: 40, busy: null, progress: null };
  return modsState[id];
}

async function loadMods(id, force) {
  const m = modsOf(id);
  m.loading = true;
  render();
  try {
    m.view = await invoke('get_mods', { id, force });
  } catch (e) {
    toast(String(e), true);
  }
  m.loading = false;
  render();
}

function openModsPage(id) {
  openId = 'm:' + id;
  const m = modsOf(id);
  if (!m.view) loadMods(id, false);
  else render();
}

function modsBox(g) {
  if (!g.has_mods || !g.in_library || ['not_installed', 'installing'].includes(g.status)) return '';
  return `
    <div class="box mods-teaser">
      <h3>Central de Mods</h3>
      <p class="muted">Mods da comunidade para ${esc(g.title)}, direto da Thunderstore: instale com um clique, com as dependências,
        e ligue ou desligue quando quiser. Cada perfil tem os próprios mods ligados.</p>
      <div class="row"><button class="primary" data-act="mods-open">Abrir Central de Mods</button></div>
    </div>`;
}

const fmtCount = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} mil` : String(n));

function modRowHtml(r, m, running) {
  const busy = m.busy === r.full_name;
  const p = busy && m.progress ? m.progress : null;
  const pct = p && p.total ? Math.round((p.done / p.total) * 100) : 0;
  let actions;
  if (busy) {
    actions = `<div class="mod-busy"><span class="muted">${p ? `Baixando ${esc(p.package)} (${p.step} de ${p.steps}) · ${pct}%` : 'Preparando…'}</span>
      <div class="progress"><div style="width:${pct}%"></div></div></div>`;
  } else if (r.installed) {
    actions = `
      <label class="switch" title="Ligar ou desligar para o perfil em uso">
        <input type="checkbox" data-act="mod-toggle" data-pkg="${esc(r.full_name)}" ${r.enabled ? 'checked' : ''} ${running || m.busy ? 'disabled' : ''}>
        <span>${r.enabled ? 'Ligado' : 'Desligado'}</span></label>
      ${r.update ? `<button class="small" data-act="mod-install" data-pkg="${esc(r.full_name)}" ${running || m.busy ? 'disabled' : ''}>Atualizar para ${esc(r.version)}</button>` : ''}
      <button class="ghost small danger" data-act="mod-remove" data-pkg="${esc(r.full_name)}" ${running || m.busy ? 'disabled' : ''}>Desinstalar</button>`;
  } else {
    actions = `<button class="primary small" data-act="mod-install" data-pkg="${esc(r.full_name)}" ${running || m.busy ? 'disabled' : ''}>Instalar</button>`;
  }
  return `
    <li class="mod${r.installed ? ' installed' : ''}">
      ${r.icon ? `<img class="mod-icon" src="${esc(r.icon)}" alt="" loading="lazy">` : '<span class="mod-icon"></span>'}
      <div class="mod-main">
        <div class="mod-title"><b>${esc(r.name.replace(/_/g, ' '))}</b> <span class="muted">por ${esc(r.owner)} · v${esc(r.version)}</span>
          ${r.installed ? `<span class="chip ready">instalado${r.as_dependency ? ' (dependência)' : ''}</span>` : ''}
          ${r.update ? '<span class="chip update">versão nova</span>' : ''}
          ${r.deprecated ? '<span class="chip needs_files">descontinuado</span>' : ''}</div>
        <div class="mod-desc">${esc(r.description)}</div>
        <div class="muted small-text">${sizeLabel(r.file_size)} · ${fmtCount(r.downloads)} downloads · ${r.rating} curtidas
          ${r.dependencies.length ? ` · precisa de: ${r.dependencies.map((d) => esc(d.split('-').slice(1).join('-').replace(/_/g, ' '))).join(', ')}` : ''}
          · <button class="link small-text" data-act="link" data-url="${esc(r.page)}">página na Thunderstore</button></div>
      </div>
      <div class="mod-actions">${actions}</div>
    </li>`;
}

function renderModsPage(id) {
  const g = games.find((x) => x.id === id);
  const m = modsOf(id);
  const v = m.view;
  if (!g) { openId = null; render(); return; }
  let body = '<p class="muted">Buscando os mods na Thunderstore…</p>';
  if (v) {
    const q = m.search.trim().toLowerCase();
    let rows = v.rows.filter((r) => !q || (r.name + ' ' + r.owner + ' ' + r.description).toLowerCase().includes(q));
    if (m.filter === 'installed') rows = rows.filter((r) => r.installed);
    if (m.filter === 'updates') rows = rows.filter((r) => r.update);
    if (m.filter === 'libraries') rows = rows.filter((r) => r.categories.includes('Libraries'));
    const sorters = {
      popular: (a, b) => b.rating - a.rating || b.downloads - a.downloads,
      downloads: (a, b) => b.downloads - a.downloads,
      recent: (a, b) => (b.updated > a.updated ? 1 : -1),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    rows.sort((a, b) => (b.installed ? 1 : 0) - (a.installed ? 1 : 0) || sorters[m.sort](a, b));
    const installedCount = v.rows.filter((r) => r.installed).length;
    const updates = v.rows.filter((r) => r.update).length;
    body = `
      ${v.error ? `<div class="box warn"><p>${esc(v.error)}</p></div>` : ''}
      ${v.running ? '<div class="box warn"><p>O jogo está aberto. Feche o jogo para instalar, ligar ou desligar mods.</p></div>' : ''}
      <div class="mods-bar">
        <input type="text" id="mods-search" placeholder="Buscar mods" value="${esc(m.search)}">
        <select id="mods-filter">
          ${[['all', `Todos (${v.rows.length})`], ['installed', `Instalados (${installedCount})`], ['updates', `Com versão nova (${updates})`], ['libraries', 'Bibliotecas']]
            .map(([k, l]) => `<option value="${k}" ${m.filter === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select id="mods-sort">
          ${[['popular', 'Mais curtidos'], ['downloads', 'Mais baixados'], ['recent', 'Atualizados agora'], ['name', 'Nome']]
            .map(([k, l]) => `<option value="${k}" ${m.sort === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button class="ghost" data-act="mods-refresh">Atualizar lista</button>
      </div>
      <ul class="mods">${rows.slice(0, m.shown).map((r) => modRowHtml(r, m, v.running)).join('') || '<p class="muted">Nenhum mod encontrado.</p>'}</ul>
      ${rows.length > m.shown ? `<div class="row"><button class="ghost" data-act="mods-more">Mostrar mais (${rows.length - m.shown})</button></div>` : ''}
      <div class="box">
        <h3>Coleções</h3>
        <p class="muted">Guarde os mods ligados agora com um nome (por exemplo "Minha run HD") e troque de conjunto com um clique.</p>
        <div class="tags-edit">
          <input type="text" id="collection-name" maxlength="40" placeholder="Nome da coleção">
          <button data-act="collection-save">Salvar mods ligados</button>
        </div>
        ${v.collections.length ? `<ul class="collections">${v.collections.map((c) => `
          <li><b>${esc(c.name)}</b> <span class="muted">${c.packages.length} mod(s)</span>
            <button class="small" data-act="collection-apply" data-name="${esc(c.name)}" ${v.running ? 'disabled' : ''}>Usar</button>
            <button class="ghost small danger" data-act="collection-delete" data-name="${esc(c.name)}">Apagar</button></li>`).join('')}</ul>` : ''}
      </div>
      ${v.gone.length ? `<p class="muted">Instalados mas fora da Thunderstore agora: ${v.gone.map(esc).join(', ')}.</p>` : ''}
      <p class="muted">Mods são programas feitos pela comunidade: o Black Flag só baixa da Thunderstore e confere se cada mod é
        deste jogo, mas não garante o que eles fazem. Antes de instalar ou ligar um mod, ele faz backup dos seus saves.
        Mods nunca trazem arquivos do jogo original. Pasta dos mods: <code>${esc(v.mods_folder)}</code>
        <button class="link small-text" data-act="mods-folder">abrir</button></p>`;
  }
  $('#detail').innerHTML = `
    <button class="ghost back" data-act="mods-back">← ${esc(g.title)}</button>
    <div class="covers-page mods-page">
      <h2>Central de Mods: ${esc(g.title)}</h2>
      <p class="muted">Da comunidade ${esc(v ? v.community : '')} na Thunderstore · perfil ${esc(profiles ? profiles.active.name : '')}
        ${v && v.fetched_at ? ` · lista de ${sessionDate(v.fetched_at)}` : ''}</p>
      ${body}
    </div>`;
  document.querySelectorAll('#detail [data-act]').forEach((el) =>
    el.addEventListener(el.type === 'checkbox' ? 'change' : 'click', () => act(el.dataset.act, g, el)));
  const search = document.getElementById('mods-search');
  if (search) {
    search.addEventListener('input', () => {
      m.search = search.value;
      m.shown = 40;
      const pos = search.selectionStart;
      render();
      const again = document.getElementById('mods-search');
      again.focus();
      again.setSelectionRange(pos, pos);
    });
  }
  const filter = document.getElementById('mods-filter');
  if (filter) filter.addEventListener('change', () => { m.filter = filter.value; m.shown = 40; render(); });
  const sort = document.getElementById('mods-sort');
  if (sort) sort.addEventListener('change', () => { m.sort = sort.value; render(); });
}

listen('mod-progress', (e) => {
  const m = modsState[e.payload.id];
  if (!m) return;
  m.progress = e.payload;
  if (openId === 'm:' + e.payload.id) render();
});

let statsData = null;

async function openStats() {
  openId = '__stats';
  statsData = null;
  achSummary = null;
  render();
  // getTimezoneOffset is minutes WEST of UTC; the backend wants east.
  statsData = await call('get_stats', { offsetMinutes: -new Date().getTimezoneOffset() });
  if (openId === '__stats') render();
  achSummary = await call('get_achievement_summary');
  if (openId === '__stats') render();
}

function bars(buckets, label) {
  const max = Math.max(1, ...buckets.map((b) => b.seconds));
  return `<div class="bars">${buckets.map((b) => `
    <div class="bar" title="${esc(dayDate(b.day).toLocaleDateString('pt-BR', { timeZone: 'UTC' }))}: ${shortTime(b.seconds)}">
      <div class="fill" style="height:${Math.round((b.seconds / max) * 100)}%"></div>
      <span>${esc(label(b))}</span>
    </div>`).join('')}</div>`;
}

// Day number (days since 1970-01-01 in the player's time zone) as a date.
const dayDate = (day) => new Date(day * 86400000);
const dayLabel = (b) => dayDate(b.day).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
const weekdayLabel = (b) => dayDate(b.day).toLocaleDateString('pt-BR', { weekday: 'short', timeZone: 'UTC' }).replace('.', '');

function renderStats() {
  const s = statsData;
  let body = '<p class="muted">Calculando…</p>';
  if (s) {
    const title = (id) => s.titles[id] || id;
    const thisWeek = s.weeks.length ? s.weeks[s.weeks.length - 1].seconds : 0;
    const topMax = Math.max(1, ...s.games.map((g) => g.seconds));
    body = `
      <div class="stats big">
        <div><div class="k">Tempo total na biblioteca</div><div class="v">${playTime(s.library_seconds)}</div></div>
        <div><div class="k">Esta semana</div><div class="v">${shortTime(thisWeek)}</div></div>
        <div><div class="k">Sessões registradas</div><div class="v">${s.sessions}</div></div>
        <div><div class="k">Dias seguidos jogando</div><div class="v">${s.streak_days}</div></div>
      </div>
      <div class="box"><h3>Últimos 14 dias</h3>${bars(s.days, weekdayLabel)}</div>
      <div class="box"><h3>Últimas 12 semanas</h3>${bars(s.weeks, dayLabel)}
        <p class="muted">Cada barra é uma semana, de segunda a domingo, marcada pela segunda-feira.</p></div>
      <div class="box">
        <h3>Mais jogados</h3>
        ${s.games.length ? `<ul class="top">${s.games.slice(0, 10).map((g) => `
          <li>
            <span class="name">${esc(title(g.id))}</span>
            <span class="track"><span style="width:${Math.round((g.seconds / topMax) * 100)}%"></span></span>
            <span class="muted">${shortTime(g.seconds)} · ${g.sessions} sessão(ões)</span>
          </li>`).join('')}</ul>` : '<p class="muted">Ainda não há sessões registradas. Jogue algo pelo Black Flag!</p>'}
        ${s.longest ? `<p class="muted">Maior sessão: ${shortTime(s.longest.seconds)} de ${esc(title(s.longest.id))}, em ${sessionDate(s.longest.start)}.</p>` : ''}
      </div>
      <div class="box">
        <h3>Estado dos ${s.library_games} jogo(s) da biblioteca</h3>
        <div class="tags-edit">${COMPLETION.filter(([k]) => s.completion[k]).map(([k, label]) =>
          `<span class="tag">${label}: ${s.completion[k]}</span>`).join('') || '<span class="muted">Biblioteca vazia.</span>'}</div>
      </div>
      <p class="muted">As estatísticas por dia e semana vêm do histórico de sessões, que começou na versão 0.12.
        O tempo total inclui o que foi jogado antes.</p>
      ${achievementsSummaryHtml()}`;
  }
  $('#detail').innerHTML = `
    <button class="ghost back" data-act="back">← Biblioteca</button>
    <div class="covers-page">
      <h2>Estatísticas</h2>
      ${body}
    </div>`;
  document.querySelectorAll('#detail [data-act]').forEach((el) =>
    el.addEventListener('click', () => act(el.dataset.act, null, el)));
}

// Banner above the page and "Sobre o jogo" under the play time, for games in the library.
function decorateMeta(g) {
  if (!g.in_library) return;
  if (metaCache[g.id] === undefined) {
    // Asked after this render, so the page is not drawn twice inside itself.
    metaCache[g.id] = 'loading';
    setTimeout(() => loadMeta(g.id), 0);
  }
  const detail = document.querySelector('#detail .detail');
  if (!detail) return;
  const m = metaCache[g.id];
  // The profile's own background for the game (Minhas capas) comes before the downloaded banner.
  const hero = g.background || (m && m.banner);
  if (hero) detail.insertAdjacentHTML('beforebegin', `<img class="hero" src="${hero}" alt="">`);
  const geral = document.querySelector('#pane-geral');
  if (geral) geral.insertAdjacentHTML('afterbegin', aboutBox(g));
}

function coverColumn(g) {
  if (!g.in_library) return coverHtml(g);
  return `
    ${coverHtml(g)}
    ${g.cover_source ? `<p class="muted">${COVER_SOURCE[g.cover_source]}</p>` : ''}
    <div class="cover-actions">
      <button data-act="cover-choose">Escolher capa</button>
      ${['custom', 'downloaded'].includes(g.cover_source) ? '<button class="ghost" data-act="cover-clear">Restaurar</button>' : ''}
    </div>`;
}

let coverTemplates = null;   // loaded when the covers page opens
let coverReport = null;      // last "Baixar capas" result

function renderCovers() {
  const report = coverReport ? `
    <div class="box ${coverReport.missing.length ? 'warn' : 'ok'}">
      <h3>${coverReport.downloaded} capa(s) baixada(s)</h3>
      ${coverReport.missing.length ? `<p>Sem capa encontrada: ${coverReport.missing.map(esc).join(', ')}.</p>
        <p class="muted">Para esses, use "Escolher capa" na página do jogo ou adicione um endereço abaixo.</p>` : ''}
    </div>` : '';
  $('#detail').innerHTML = `
    <button class="ghost back" data-act="back">← Biblioteca</button>
    <div class="covers-page">
      <h2>Capas</h2>
      <p>Funciona como o baixador de capas do PCSX2: para cada jogo da biblioteca sem capa, o Black Flag
        tenta os endereços abaixo e guarda a primeira imagem que encontrar. Cada capa é baixada uma vez só.</p>
      <div class="box">
        <h3>Ordem das capas</h3>
        <ol>
          <li>A imagem que você escolheu na página do jogo.</li>
          <li>A imagem dos seus próprios arquivos do jogo (por exemplo, o ícone do dump de PS4).</li>
          <li>Uma capa baixada: primeiro das fontes do catálogo do Black Flag, depois dos seus endereços.</li>
          <li>Uma capa da SteamGridDB ou da IGDB, se você colocou sua chave em Configurações.</li>
          <li>Para jogos de PC sem capa, o ícone do programa.</li>
        </ol>
      </div>
      <div class="row">
        <button class="primary" data-act="covers-download">Baixar capas que faltam</button>
        <button data-act="meta-all">Buscar na SteamGridDB e IGDB</button>
      </div>
      ${report}
      ${metaReport ? `
        <div class="box ${metaReport.found < metaReport.looked_up ? 'warn' : 'ok'}">
          <h3>${metaReport.looked_up ? `${metaReport.found} de ${metaReport.looked_up} jogo(s) encontrado(s)` : 'Todos os jogos já tinham sido buscados'}</h3>
          <p class="muted">Jogos já buscados não são buscados de novo. Para um jogo não encontrado, use "Buscar com outro nome" na página dele.</p>
        </div>` : ''}
      <div class="box">
        <h3>Seus endereços de capas (opcional)</h3>
        <p>Um endereço por linha, começando com <code>https://</code>. Use <code>\${serial}</code> para o código do jogo
          (como <code>CUSA01715</code>) e <code>\${title}</code> para o nome do jogo.</p>
        <textarea id="templates" spellcheck="false" placeholder="https://exemplo.com/capas/\${serial}.jpg">${esc((coverTemplates || []).join('\n'))}</textarea>
        <div class="row"><button data-act="covers-save">Salvar endereços</button></div>
        <p class="muted">As capas ficam só no seu PC. Os endereços são escolhidos por você; o Black Flag só aceita imagens (PNG, JPG ou WEBP) de até 10 MB.</p>
      </div>
    </div>`;
  document.querySelectorAll('#detail [data-act]').forEach((el) =>
    el.addEventListener('click', () => act(el.dataset.act, null, el)));
}

async function openCovers() {
  openId = '__covers';
  coverReport = null;
  metaReport = null;
  coverTemplates = await call('get_cover_templates');
  render();
}

// ---- Seu PC: what stands between this PC and the game, graphics card and API ----

const pcChecks = {};   // id -> 'loading' | [{level, text, link}]
const gfx = {};        // id -> 'loading' | {gpus, preference, api, n64}
let pcInfo = null;     // {info, report} for Configurações

async function loadPcCheck(id) {
  pcChecks[id] = 'loading';
  try {
    pcChecks[id] = await invoke('pc_check', { id });
  } catch {
    pcChecks[id] = [];
  }
  if (openId === id) render();
}

async function loadGfx(id) {
  gfx[id] = 'loading';
  try {
    gfx[id] = await invoke('get_graphics', { id });
  } catch {
    gfx[id] = null;
  }
  if (openId === id) render();
}

const FIX_LABEL = { vc_x64: 'Instalar Visual C++', vc_x86: 'Instalar Visual C++ (x86)', directx: 'Instalar DirectX', hydrate: 'Baixar agora' };

function findingLink(f) {
  const fix = f.fix && FIX_LABEL[f.fix]
    ? ` <button class="small${f.level === 'bad' ? ' primary' : ''}" data-act="${f.fix === 'hydrate' ? 'fix-hydrate' : 'fix-runtime'}" data-v="${esc(f.fix)}">${FIX_LABEL[f.fix]}</button>`
    : '';
  return fix + (f.link ? ` <button class="link" data-act="link" data-url="${esc(f.link[1])}">${esc(f.link[0])}</button>` : '');
}

// After a fix everything is checked again (a runtime counts for every game).
async function recheckAll() {
  for (const k of Object.keys(pcChecks)) delete pcChecks[k];
  pcInfo = openId === '__settings' ? await invoke('get_pc_info', { refresh: false }).catch(() => pcInfo) : null;
  render();
}

// `which`: 'bad' for the top of the page (only when the game cannot run as it is), 'warn' for Ajustes.
function pcCheckBox(g, which = 'bad') {
  const list = pcChecks[g.id];
  if (list === undefined) {
    setTimeout(() => loadPcCheck(g.id), 0);
    return '';
  }
  if (!Array.isArray(list) || !list.length) return '';
  const bad = list.some((x) => x.level === 'bad');
  if ((which === 'bad') !== bad) return '';
  if (list.every((x) => x.level === 'ok')) {
    return `<p class="muted pc-ok">Seu PC: ${esc(list[0].text)}</p>`;
  }
  const items = list.filter((x) => x.level !== 'ok')
    .map((x) => `<li class="${x.level === 'bad' ? 'bad-text' : ''}">${esc(x.text)}${findingLink(x)}</li>`).join('');
  const fixable = list.some((x) => x.level === 'bad' && x.fix);
  const checked = g.kind === 'pc_game'
    ? 'O Black Flag conferiu os arquivos que o jogo usa (DLLs, OneDrive, caminhos longos).'
    : 'O Black Flag conferiu processador, placa de vídeo, driver, Windows, o Visual C++ e os arquivos que o jogo usa. Detalhes em Configurações > Seu PC.';
  return `
    <div class="box ${bad ? 'bad' : 'warn'}">
      <h3>${!bad ? 'Antes de jogar: pode dar problema' : fixable ? 'Antes de jogar: falta uma coisa' : 'Este jogo não deve abrir assim'}</h3>
      <ul>${items}</ul>
      <p class="muted">${checked}</p>
    </div>`;
}

function lostFilesBox(g) {
  if (!g.lost_files) return '';
  return `
    <div class="box bad">
      <h3>Os arquivos do port sumiram da pasta</h3>
      <p>A pasta continua lá, mas o programa do jogo não. Quase sempre é o antivírus. Com programas novos e sem
        assinatura pode ser alarme falso, mas nem sempre é.</p>
      <p>Veja o arquivo em Segurança do Windows > Proteção contra vírus e ameaças > Histórico de proteção. Só restaure se o
        port veio da página oficial do projeto pelo Black Flag; na dúvida, pergunte no GitHub do projeto antes. Depois
        clique em Reinstalar. Seus saves são mantidos.</p>
      <div class="row">
        <button data-act="win-security">Abrir Segurança do Windows</button>
        <button class="ghost" data-act="${g.kind === 'community' ? 'community-update' : 'install'}">Reinstalar</button>
      </div>
    </div>`;
}

const diagnoses = {};   // id -> null | diagnosis (diagnose.rs), shown until dismissed

async function loadDiagnosis(id) {
  diagnoses[id] = null;
  try {
    diagnoses[id] = await invoke('get_diagnosis', { id });
  } catch { /* nothing to show */ }
  if (diagnoses[id] && openId === id) render();
}

listen('crash', (e) => {
  const d = e.payload;
  diagnoses[d.id] = d;
  delete shaderInfo[d.id];
  const g = games.find((x) => x.id === d.id);
  toast(`${g ? g.title : d.id} fechou com erro. A página do jogo diz o que tentar.`, true);
  if (openId === d.id) render();
});

function crashAction(a) {
  const extra = a.value ? (a.act === 'link' ? ` data-url="${esc(a.value)}"` : ` data-v="${esc(a.value)}"`) : '';
  return ` <button class="link" data-act="${a.act}"${extra}>${esc(a.label)}</button>`;
}

function crashBox(g) {
  if (!g.in_library && g.kind !== 'community' && g.kind !== 'pc_game') return '';
  if (diagnoses[g.id] === undefined) {
    setTimeout(() => loadDiagnosis(g.id), 0);
    return '';
  }
  const d = diagnoses[g.id];
  if (!d) return '';
  if (d === 'loading') return '<p class="muted">Procurando o erro nos registros do Windows…</p>';
  const bad = d.findings.some((f) => f.level === 'bad');
  const when = new Date(d.at * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  const items = d.findings.map((f) =>
    `<li class="${f.level === 'bad' ? 'bad-text' : ''}">${esc(f.text)}${f.action ? crashAction(f.action) : ''}</li>`).join('');
  return `
    <div class="box ${bad ? 'bad' : 'warn'}">
      <h3>${d.code || (d.seconds !== null && d.seconds !== undefined) ? 'O jogo fechou com erro' : 'Procura de erros'}</h3>
      <p class="muted">${esc(when)}${d.code ? ` · código ${esc(d.code)}` : ''}${d.module ? ` em ${esc(d.module)}` : ''}</p>
      <ul>${items}</ul>
      <details>
        <summary>Relatório para pedir ajuda</summary>
        <p class="muted">Copie e cole numa issue no GitHub do port. O nome da sua pasta de usuário é escondido; confira o texto antes de enviar.</p>
        <pre class="crash-report">${esc(d.report)}</pre>
      </details>
      <div class="row">
        <button data-act="crash-copy">Copiar relatório</button>
        <button class="ghost" data-act="project">Abrir o GitHub do port</button>
        <button class="ghost" data-act="crash-dismiss">Dispensar</button>
      </div>
    </div>`;
}

const shaderInfo = {};   // id -> 'loading' | null | {bytes, files, first_time, driver_changed, backup}

async function loadShaders(id) {
  shaderInfo[id] = 'loading';
  try {
    shaderInfo[id] = await invoke('get_shader_cache', { id });
  } catch {
    shaderInfo[id] = null;
  }
  if (openId === id) render();
}

function shaderBox(g) {
  if (!g.in_library || ['not_installed', 'installing'].includes(g.status)) return '';
  const v = shaderInfo[g.id];
  if (v === undefined) {
    setTimeout(() => loadShaders(g.id), 0);
    return '';
  }
  if (!v || v === 'loading') return '';
  const running = IN_GAME.includes(g.status);
  const size = v.bytes >= 1073741824 ? `${(v.bytes / 1073741824).toFixed(1).replace('.', ',')} GB` : `${Math.max(1, Math.round(v.bytes / 1048576))} MB`;
  return `
    <details class="box ${v.driver_changed ? 'warn' : ''}" ${v.driver_changed || v.first_time ? 'open' : ''}>
      <summary><h3>Cache de shaders</h3></summary>
      ${v.first_time
        ? `<p>Na primeira vez, o port compila os shaders enquanto você joga: pode haver travadinhas, quedas de FPS e efeitos
            faltando nos primeiros minutos. É normal e melhora sozinho, porque o que já foi compilado fica guardado.</p>`
        : `<p>Guardado: <b>${size}</b> em ${v.files.toLocaleString('pt-BR')} arquivos. Fica guardado ao atualizar ou desinstalar o port.</p>`}
      ${v.driver_changed ? `<p class="bad-text">O driver de vídeo mudou desde a última vez que você jogou. O cache foi feito com o
          driver antigo: se o jogo passar a fechar ao abrir ou mostrar defeitos gráficos, limpe o cache.</p>` : ''}
      <div class="row">
        ${v.first_time ? '' : `<button data-act="shader-clear" ${running ? 'disabled' : ''}>Limpar cache de shaders</button>`}
        ${v.backup ? `<button class="ghost" data-act="shader-undo" ${running ? 'disabled' : ''}>Desfazer limpeza</button>` : ''}
      </div>
      <p class="muted">Limpar não conserta problemas em geral: o port compila tudo de novo, com travadinhas no começo. Vale
        depois de trocar o driver de vídeo ou quando o jogo passou a fechar ao abrir depois de uma atualização.</p>
    </details>`;
}

const GPU_PREFS = [[0, 'Deixar o Windows escolher'], [1, 'Economia de energia'], [2, 'Alto desempenho']];
const APIS = [['Auto', 'Automática'], ['D3D12', 'DirectX 12'], ['Vulkan', 'Vulkan']];

function gfxBox(g) {
  if (!g.in_library || ['not_installed', 'installing', 'missing', 'needs_exe'].includes(g.status)) return '';
  const v = gfx[g.id];
  if (v === undefined) {
    setTimeout(() => loadGfx(g.id), 0);
    return '';
  }
  if (!v || v === 'loading') return '';
  const multi = v.gpus.length >= 2;
  if (!multi && !v.n64) return '';
  const choice = (act, list, current) => list.map(([val, label]) =>
    `<button class="${String(val) === String(current) ? 'primary' : 'ghost'}" data-act="${act}" data-v="${val}">${label}</button>`).join('');
  const running = IN_GAME.includes(g.status);
  return `
    <details class="box" ${v.preference || (v.api && v.api !== 'Auto') ? 'open' : ''}>
      <summary><h3>Vídeo</h3></summary>
      ${multi ? `
        <p><b>Placa de vídeo para este jogo</b></p>
        <div class="row">${choice('gpu-pref', GPU_PREFS, v.preference)}</div>
        <p class="muted">Seu PC tem ${v.gpus.map(esc).join(' e ')}. Em notebook, "Alto desempenho" costuma ser a placa dedicada, a
          mais forte. É a mesma opção de Configurações do Windows > Tela > Gráficos e vale na próxima vez que o jogo abrir.</p>` : ''}
      ${v.n64 ? (v.api ? `
        <p><b>API gráfica</b></p>
        <div class="row">${choice('gfx-api', APIS, v.api)}</div>
        <p class="muted">Se o jogo abre com tela preta, fecha sozinho ou usa a placa integrada, tente Vulkan; se piorar,
          volte para Automática.${running ? ' Feche o jogo para trocar.' : ''}</p>`
        : '<p class="muted">Abra o jogo uma vez para poder escolher a API gráfica (DirectX 12 ou Vulkan) aqui.</p>') : ''}
    </details>`;
}

let fpsStatus = null;   // loaded when Configurações opens
let fpsMessage = null;

function fpsBox() {
  const f = fpsStatus;
  if (!f) return '';
  const done = (ok, text) => `<span class="chip ${ok ? 'ready' : ''}">${text}</span>`;
  const ready = f.tool && f.permission;
  return `
    <div class="box">
      <h3>Contador de FPS</h3>
      <p>Mostra o FPS no canto de cima da tela enquanto você joga. Quem mede é o PresentMon, da Intel, de código aberto e
        usado pelos programas de FPS: ele lê os quadros pelo próprio Windows, sem mexer no jogo, em DirectX e Vulkan.</p>
      <ol class="fps-steps">
        <li>${done(f.tool, f.tool ? 'baixado' : 'falta baixar')} PresentMon
          ${f.tool ? '' : '<button data-act="fps-download">Baixar o PresentMon (1 MB, da página oficial da Intel no GitHub)</button>'}</li>
        <li>${done(f.permission, f.permission ? 'liberado' : f.pending_sign_in ? 'falta sair e entrar' : 'falta liberar')} Permissão do Windows
          ${f.permission ? '' : f.pending_sign_in
            ? '<p class="muted">Já está liberado. Saia da sua conta do Windows e entre de novo (ou reinicie o PC) para valer.</p>'
            : `<button data-act="fps-permission">Liberar (o Windows pede administrador uma vez)</button>
               <p class="muted">Coloca a sua conta no grupo "Usuários de log de desempenho" do Windows, que pode ler as medições de desempenho.
                 É o mesmo que o PresentMon pede. Depois disso, nada mais pede administrador.</p>`}</li>
        <li><label class="check"><input type="checkbox" data-act="fps-toggle" ${f.enabled ? 'checked' : ''} ${ready || f.enabled ? '' : 'disabled'}>
          Mostrar o FPS por cima do jogo</label></li>
      </ol>
      ${fpsMessage ? `<p class="${fpsMessage.ok ? 'ok-text' : 'bad-text'}">${esc(fpsMessage.text)}</p>` : ''}
      ${f.error ? `<p class="bad-text">${esc(f.error)}</p>` : ''}
      <p class="muted">Aparece com o jogo em janela ou em tela cheia sem bordas. Em tela cheia exclusiva o Windows esconde
        qualquer janela por cima; nesse caso, troque o modo de tela nas opções do jogo.</p>
    </div>`;
}

function pcInfoBox() {
  if (!pcInfo) return '<div class="box"><h3>Seu PC</h3><p class="muted">Lendo as informações do PC…</p></div>';
  const i = pcInfo.info;
  const year = (t) => (t ? new Date(t * 1000).toLocaleDateString('pt-BR') : 'data desconhecida');
  const gpus = i.gpus.length ? i.gpus.map((g) => `<li>${esc(g.name)} · driver ${esc(g.driver_version || '?')} de ${year(g.driver_date)}
    ${g.vendor ? ` <button class="link" data-act="link" data-url="${esc(DRIVER_PAGES[g.vendor] || '')}">driver mais novo</button>` : ''}</li>`).join('')
    : '<li class="bad-text">Nenhuma placa de vídeo encontrada.</li>';
  return `
    <div class="box">
      <h3>Seu PC</h3>
      <dl class="pc-info">
        <dt>Sistema</dt><dd>${esc(i.windows)}</dd>
        <dt>Processador</dt><dd>${esc(i.cpu)}<br><span class="muted">Instruções: ${esc(i.cpu_features.join(', ').toUpperCase())}</span></dd>
        <dt>Memória</dt><dd>${i.ram_gb} GB</dd>
        <dt>Vídeo</dt><dd><ul>${gpus}</ul></dd>
        <dt>Visual C++</dt><dd>${i.vc_runtime ? 'instalado' : '<span class="bad-text">não encontrado</span> <button class="small primary" data-act="fix-runtime" data-v="vc_x64">Instalar Visual C++</button> <button class="link" data-act="link" data-url="https://learn.microsoft.com/pt-br/cpp/windows/latest-supported-vc-redist">página da Microsoft</button>'}</dd>
      </dl>
      <div class="row">
        <button data-act="pc-copy">Copiar informações</button>
        <button class="ghost" data-act="pc-refresh">Ler de novo</button>
        <button class="ghost" data-act="win-security">Abrir Segurança do Windows</button>
      </div>
      <p class="muted">Cada port mostra na página dele se algo aqui impede o jogo de rodar. "Copiar informações" ajuda quando
        for pedir ajuda no GitHub do port.</p>
    </div>`;
}

const DRIVER_PAGES = {
  NVIDIA: 'https://www.nvidia.com/pt-br/drivers/',
  AMD: 'https://www.amd.com/pt/support/download/drivers.html',
  Intel: 'https://www.intel.com.br/content/www/br/pt/support/detect.html',
};

function launchBox(g) {
  if (!g.in_library) return '';
  const env = g.env.map((v) => `${v.name}=${v.value}`).join('\n');
  return `
    <details class="box" ${g.launch_args || g.env.length || g.run_as_admin ? 'open' : ''}>
      <summary><h3>Opções de inicialização</h3></summary>
      <label class="check"><input type="checkbox" data-act="run-admin" ${g.run_as_admin ? 'checked' : ''}>
        Abrir como administrador: o Windows pede a sua permissão toda vez que o jogo abrir. O Black Flag liga isto
        sozinho quando o jogo exige administrador. Nesse modo as variáveis de ambiente abaixo não são usadas.</label>
      <p class="muted">Para usuários avançados. Valem quando o jogo é aberto pelo Black Flag (botão Jogar, atalhos e bandeja).</p>
      <p><b>Argumentos</b></p>
      <input type="text" id="launch-args" class="wide" value="${esc(g.launch_args)}" placeholder='Ex.: --fullscreen  ou  --rom "C:\\Meus jogos\\rom.z64"'>
      <p><b>Variáveis de ambiente</b> (uma por linha, NOME=valor)</p>
      <textarea id="launch-env" spellcheck="false" placeholder="DXVK_HUD=fps">${esc(env)}</textarea>
      <div class="row"><button data-act="launch-save">Salvar opções</button></div>
    </details>`;
}

function manageRow(g) {
  return manageBox(g, 'Abrir pasta do jogo', 'Remover da biblioteca não apaga nenhum arquivo.');
}

// "Gerenciar", at the end of Ajustes: folder, favorite, hide, and the two ways out.
function manageBox(g, folderLabel, note) {
  if (!g.in_library) return '';
  return `
    <div class="box">
      <h3>Gerenciar</h3>
      <div class="row">
        <button data-act="folder">${folderLabel}</button>
        <button class="ghost" data-act="favorite">${g.favorite ? '★ Tirar dos favoritos' : '☆ Favoritar'}</button>
        <button class="ghost" data-act="hide">${g.hidden ? 'Mostrar na biblioteca' : 'Ocultar da biblioteca'}</button>
        <button class="ghost" data-act="reset-time">Zerar tempo de jogo</button>
      </div>
      <div class="row">
        ${g.kind === 'port' || g.kind === 'community' ? '<button class="danger" data-act="uninstall">Desinstalar</button>' : ''}
        <button class="ghost danger" data-act="remove">Remover da biblioteca</button>
      </div>
      <p class="muted">${note}</p>
      ${g.install_dir ? `<p class="muted path">${esc(g.install_dir)}</p>` : ''}
    </div>`;
}

// ---- The game page: what matters on top (Jogar and anything wrong), the rest in tabs ----

const pageTab = {};   // page key (game id, '__settings') -> open tab

function pageTabs(key, panes) {
  const cur = panes.some((p) => p[0] === pageTab[key]) ? pageTab[key] : panes[0][0];
  return `
    <nav class="tabs page-tabs">${panes.map(([k, label]) =>
      `<button class="${k === cur ? 'on' : ''}" data-act="page-tab" data-k="${esc(key)}" data-v="${k}">${label}</button>`).join('')}</nav>
    ${panes.map(([k, , html]) => `<div class="pane" id="pane-${k}" ${k === cur ? '' : 'hidden'}>${html}</div>`).join('')}`;
}

function crashScan(g) {
  if (['not_installed', 'installing'].includes(g.status)) return '';
  return `
    <div class="box">
      <h3>O jogo fecha sozinho?</h3>
      <p class="muted">O Black Flag procura o erro nos registros do Windows dos últimos 7 dias, explica o que encontrou e monta
        um relatório para pedir ajuda no GitHub do port.</p>
      <div class="row"><button data-act="crash-scan">Procurar o erro</button></div>
    </div>`;
}

let keyResults = null;   // last "Salvar e testar" of the SteamGridDB / IGDB keys
let metaReport = null;   // last "Buscar na SteamGridDB e IGDB" from the covers page

function keysBox() {
  const saved = (has) => (has ? '<span class="chip ready">chave guardada</span>' : '<span class="chip">sem chave</span>');
  const results = keyResults ? `<ul>${keyResults.map((r) =>
    `<li class="${r.ok ? 'ok-text' : 'bad-text'}">${esc(r.message)}</li>`).join('')}</ul>` : '';
  return `
    <div class="box">
      <h3>Capa, banner e descrição dos jogos</h3>
      <p>Com uma chave gratuita sua, o Black Flag busca na <b>SteamGridDB</b> (capas e banners feitos pela comunidade)
        e na <b>IGDB</b> (descrição, ano, gêneros, capa e arte) as informações dos jogos da sua biblioteca.
        Cada jogo é buscado uma vez e fica guardado no seu PC.</p>
      <p><b>SteamGridDB</b> ${saved(settings.has_steamgriddb)}
        <button class="link" data-act="link" data-url="${esc(settings.sgdb_key_page)}">pegar minha chave</button></p>
      <details class="key-help">
        <summary>Como pegar a chave da SteamGridDB (1 minuto)</summary>
        <ol>
          <li>Clique em "pegar minha chave": abre a página de API da SteamGridDB.</li>
          <li>Entre com a sua conta Steam (botão Login no alto da página).</li>
          <li>Clique em "Generate API Key" e copie a chave que aparece.</li>
          <li>Cole no campo abaixo e clique em "Salvar e testar".</li>
        </ol>
      </details>
      <input type="password" id="key-sgdb" class="wide" autocomplete="off" placeholder="${settings.has_steamgriddb ? 'Deixe vazio para manter a chave guardada' : 'Chave de API da SteamGridDB'}">
      <p><b>IGDB</b> ${saved(settings.has_igdb)}
        <button class="link" data-act="link" data-url="https://dev.twitch.tv/console/apps">abrir o console da Twitch</button></p>
      <details class="key-help">
        <summary>Como pegar a chave da IGDB (5 minutos)</summary>
        <ol>
          <li>A IGDB é da Twitch. Entre no console da Twitch com a sua conta; ela precisa ter a verificação em duas etapas ligada.</li>
          <li>Clique em "Register Your Application". Nome: qualquer um (ex.: Black Flag do Fulano). OAuth Redirect URL:
            <code>http://localhost</code>. Categoria: Application Integration. Tipo: Confidential.</li>
          <li>Depois de criar, clique em "Manage": copie o Client ID e clique em "New Secret" para gerar o Client Secret.</li>
          <li>Cole os dois abaixo e clique em "Salvar e testar".</li>
        </ol>
      </details>
      <input type="text" id="key-igdb-id" class="wide" autocomplete="off" placeholder="${settings.has_igdb ? 'Client ID (vazio mantém o guardado)' : 'Client ID'}">
      <input type="password" id="key-igdb-secret" class="wide" autocomplete="off" placeholder="${settings.has_igdb ? 'Client Secret (vazio mantém o guardado)' : 'Client Secret'}">
      <div class="row">
        <button data-act="keys-save">Salvar e testar</button>
        ${settings.has_steamgriddb || settings.has_igdb ? '<button class="ghost danger" data-act="keys-clear">Apagar as chaves</button>' : ''}
      </div>
      ${results}
      <p class="muted">As chaves ficam só neste PC (no arquivo de configurações do Black Flag) e só são enviadas para os próprios sites.
        Basta uma das duas; com as duas, a capa e o banner vêm primeiro da SteamGridDB e a descrição da IGDB.</p>
    </div>`;
}

let ghTokenResult = null;   // last "Salvar e testar" of the GitHub token

function githubTokenBox() {
  const result = ghTokenResult ? `<p class="${ghTokenResult.ok ? 'ok-text' : 'bad-text'}">${esc(ghTokenResult.message)}</p>` : '';
  return `
    <div class="box">
      <h3>Token do GitHub (opcional)</h3>
      <p>Sem login, o GitHub responde 60 consultas por hora para cada PC. Quem tem muitos jogos ou usa bastante a aba
        Comunidade pode chegar nesse limite. Com um token seu, ele sobe para 5.000 por hora.</p>
      <p>${settings.has_github_token ? '<span class="chip ready">token guardado</span>' : '<span class="chip">sem token</span>'}
        <button class="link" data-act="link" data-url="https://github.com/settings/tokens/new?description=Black%20Flag">criar um token no GitHub</button></p>
      <p class="muted">Na página do GitHub, escolha a validade e clique em Generate token sem marcar nenhuma permissão:
        o Black Flag só lê páginas públicas.</p>
      <input type="password" id="gh-token" class="wide" autocomplete="off" placeholder="${settings.has_github_token ? 'Deixe vazio para manter o token guardado' : 'ghp_… ou github_pat_…'}">
      <div class="row">
        <button data-act="gh-token-save">Salvar e testar</button>
        ${settings.has_github_token ? '<button class="ghost danger" data-act="gh-token-clear">Apagar o token</button>' : ''}
      </div>
      ${result}
      <p class="muted">O token fica só neste PC e só é enviado para a API do GitHub. Não mostre para ninguém.</p>
    </div>`;
}

let backupSettings = null;   // loaded when Configurações opens

function backupSettingsBox() {
  const b = backupSettings;
  if (!b) return '';
  return `
    <div class="box">
      <h3>Backups dos saves</h3>
      <label class="check"><input type="checkbox" id="set-autobackup" ${b.auto_backup ? 'checked' : ''}>
        Fazer backup dos saves quando o jogo fechar (só quando eles mudaram).</label>
      <div class="tags-edit">
        <label for="set-keep">Backups automáticos guardados por jogo:</label>
        <input type="number" id="set-keep" min="1" max="100" value="${b.backup_keep}">
      </div>
      <p class="muted">Os mais antigos são apagados quando passa desse número. Backups travados nunca são apagados.</p>
      <p><b>Ludusavi</b> (para os Outros jogos de PC): ${b.ludusavi
        ? `encontrado em <code>${esc(b.ludusavi)}</code>`
        : 'não encontrado neste PC.'}</p>
      <label class="check"><input type="checkbox" id="set-ludusavi-auto" ${b.ludusavi_auto ? 'checked' : ''} ${b.ludusavi ? '' : 'disabled'}>
        Pedir ao Ludusavi o backup dos jogos de PC quando eles fecharem.</label>
      <div class="row">
        <button data-act="backup-settings-save">Salvar</button>
        <button class="ghost" data-act="choose-ludusavi">Escolher o ludusavi.exe</button>
        <button class="link" data-act="link" data-url="${esc(b.ludusavi_page)}">Página do Ludusavi</button>
      </div>
      <p class="muted">O Black Flag não baixa nem instala o Ludusavi: instale pela página dele (ou pelo winget) e ele é encontrado sozinho.</p>
    </div>`;
}

function renderSettings() {
  $('#detail').innerHTML = `
    <button class="ghost back" data-act="back">← Biblioteca</button>
    <div class="covers-page">
      <h2>Configurações</h2>
      ${pageTabs('__settings', [
        ['geral', 'Geral', `
          <div class="box">
            <label class="check"><input type="checkbox" id="set-hidden" ${settings.show_hidden ? 'checked' : ''}>
              Mostrar jogos ocultos na biblioteca.</label>
            <label class="check"><input type="checkbox" id="set-stores" ${settings.store_import ? 'checked' : ''}>
              Procurar jogos da Steam, da Epic e da GOG sempre que o Black Flag abrir. Ele só lê os arquivos das lojas neste PC, sem login.</label>
            <div class="row"><button data-act="settings-save">Salvar</button>
              <button class="ghost" data-act="stores-unexclude">Trazer de volta os jogos das lojas que removi</button></div>
          </div>
          <div class="box">
            <h3>Tutorial</h3>
            <p class="muted">Um passo a passo curto: como instalar um port, onde fica cada coisa e como ligar as capas.</p>
            <div class="row"><button data-act="tour">Ver o tutorial</button></div>
          </div>
          <p class="muted">Black Flag versão ${esc(settings.version)}.</p>`],
        ['pc', 'Seu PC', pcInfoBox()],
        ['jogo', 'Durante o jogo', fpsBox() + achievementSettingsBox()],
        ['saves', 'Saves', backupSettingsBox()],
        ['contas', 'Capas e GitHub', keysBox() + githubTokenBox()],
      ])}
    </div>`;
  document.querySelectorAll('#detail [data-act]').forEach((el) =>
    el.addEventListener('click', () => act(el.dataset.act, null, el)));
}

function renderDetail() {
  if (openId === '__covers') return renderCovers();
  if (openId === '__settings') return renderSettings();
  if (openId === '__stats') return renderStats();
  if (openId === '__profiles') return renderProfiles();
  if (openId === '__emu') return renderEmulators();
  if (openId && openId.startsWith('c:')) return renderCommunityItem(openId.slice(2));
  if (openId && openId.startsWith('m:')) return renderModsPage(openId.slice(2));
  const g = games.find((x) => x.id === openId);
  if (!g) {
    openId = null;
    render();
    return;
  }
  if (g.kind === 'pc_game' || g.kind === 'emulated') renderPcDetail(g);
  else if (g.kind === 'community') renderCommunityDetail(g);
  else renderPortDetail(g);
  decorateMeta(g);
  decorateProgress(g);
  decorateBackups(g);
  decorateAchievements(g);
  decorateRa(g);
  decorateSteamAch(g);
  document.querySelectorAll('#detail [data-act]').forEach((el) =>
    el.addEventListener('click', () => act(el.dataset.act, g, el)));
  bindEmuGameBox(g);
}

const versions = {};   // id -> 'loading' | [{tag, published, size}] while "Escolher versão" is open

function versionBox(g) {
  if (!g.installed_by_hub) return '';
  const list = versions[g.id];
  let picker = '';
  if (list === 'loading') {
    picker = '<p class="muted">Buscando as versões no GitHub do projeto…</p>';
  } else if (Array.isArray(list)) {
    picker = `
      <ul class="versions">${list.map((v) => `
        <li>
          <span><b>${esc(versionLabel(v.tag))}</b> · ${new Date(v.published * 1000).toLocaleDateString('pt-BR')} · ${(v.size / 1048576).toFixed(0)} MB</span>
          ${v.tag === g.version ? '<span class="muted">instalada</span>'
            : `<button data-act="install" data-tag="${esc(v.tag)}" ${IN_GAME.includes(g.status) ? 'disabled' : ''}>Instalar esta</button>`}
        </li>`).join('')}
      </ul>
      <p class="muted">Escolher uma versão mais antiga desliga o aviso de versão nova deste port. Saves e configurações são mantidos.</p>
      <div class="row"><button class="ghost" data-act="versions-close">Fechar lista</button></div>`;
  }
  return `
    <div class="box">
      <h3>Versão do port</h3>
      <div class="row">
        ${list ? '' : '<button data-act="versions">Escolher versão</button>'}
        <button class="ghost" data-act="ignore-updates">Avisar sobre versões novas: ${g.ignore_updates ? 'desligado' : 'ligado'}</button>
      </div>
      ${picker}
    </div>`;
}

function renderPortDetail(g) {
  const latest = versionLabel(g.latest_version);
  const version = versionLabel(g.version) || (g.status !== 'not_installed' ? 'não identificada (adicionada de uma pasta)' : null);

  let main = '';
  if (g.status === 'installing') {
    main = progressBox(g);
  } else if (g.status === 'not_installed') {
    main = lostFilesBox(g) + pcCheckBox(g, 'bad') + `
      <div class="box">
        <h3>Instalar</h3>
        <p>O Black Flag baixa a versão mais recente do port na página oficial do projeto${latest ? ` (${esc(latest)})` : ''} e depois pede os arquivos da sua cópia.</p>
        <p class="muted">Requisitos: ${esc(g.requirements)}</p>
        ${g.pending_saves ? '<p><b>Seus saves da instalação anterior estão guardados</b> e voltam para o lugar quando você instalar.</p>' : ''}
        <div class="row">
          <button class="primary" data-act="install">Instalar</button>
          <button class="ghost" data-act="add">Já tenho instalado: escolher a pasta</button>
        </div>
      </div>
      ${pcCheckBox(g, 'warn')}
      ${guideBox(g)}`;
  } else {
    const picked = filesResult[g.id];
    const filesOk = g.files && g.files.ok && !(picked && !picked.ok);
    main += playRow(g, 'o port');
    main += folderLine(g);
    if (g.update_available) {
      main += `
        <div class="box warn">
          <h3>Versão nova disponível${latest ? `: ${esc(latest)}` : ''}</h3>
          <p>Seus saves e configurações são mantidos.</p>
          <div class="row"><button data-act="install" ${IN_GAME.includes(g.status) ? 'disabled' : ''}>Atualizar</button>
            <button class="ghost" data-act="skip-update">Pular esta versão</button></div>
        </div>`;
    }
    main += skippedNote(g);
    main += crashBox(g);
    main += pcCheckBox(g, 'bad');
    if (!filesOk) main += filesBox(g);
    main += pageTabs(g.id, [
      ['geral', 'Visão geral', ''],
      ...(g.has_mods ? [['mods', 'Mods', modsBox(g)]] : []),
      ['saves', 'Saves', ''],
      ['conquistas', 'Conquistas', ''],
      ['ajustes', 'Ajustes', pcCheckBox(g, 'warn') + artBox(g) + (filesOk ? filesBox(g) : '') + gfxBox(g) + shaderBox(g) + versionBox(g)
        + shortcutsRow(g) + launchBox(g) + tagsBox(g) + crashScan(g)
        + manageBox(g, 'Abrir pasta do port', g.installed_by_hub
          ? 'Desinstalar apaga a pasta do port, mas guarda seus saves e configurações para a próxima instalação. Remover da biblioteca não apaga nada.'
          : 'Este port foi adicionado de uma pasta sua: o Black Flag nunca apaga esses arquivos. Remover da biblioteca não apaga nada.')],
    ]);
  }

  $('#detail').innerHTML = `
    <button class="ghost back" data-act="back">← Biblioteca</button>
    <div class="detail">
      <div>${coverColumn(g)}</div>
      <div>
        <h2>${esc(g.title)}</h2>
        <div class="credit">Port <b>${esc(g.port_name)}</b>, feito por ${esc(g.port_authors)} ·
          <button class="link" data-act="project">página do projeto</button></div>
        <div>${chips(g)}</div>
        <div class="stats">
          <div><div class="k">Tempo de jogo</div><div class="v">${playTime(g.total_seconds)}</div></div>
          <div><div class="k">Última sessão</div><div class="v">${lastPlayed(g.last_played)}</div></div>
          <div><div class="k">Versão do port</div><div class="v">${esc(version || '—')}</div></div>
        </div>
        ${main}
      </div>
    </div>`;
}

function render() {
  const inDetail = openId !== null;
  $('#library').hidden = inDetail;
  $('#detail').hidden = !inDetail;
  if (inDetail) renderDetail();
  else renderGrid();
  markNav();
  renderBackdrop();
  if (tvOn) renderTv();
}

// Behind every page, blurred and dark, so the sides of a wide window are not plain black: the
// game's own art on its page, elsewhere what the profile chose (Perfil > Aparência > Fundo).
function backdropArt() {
  const art = (g) => g && (g.background || g.cover);
  const open = openId && games.find((g) => g.id === openId);
  if (open && art(open)) return art(open);
  if (!openId && focusArt) return focusArt;
  const p = profiles && profiles.active;
  const want = (p && p.look && p.look.page_bg) || 'perfil';
  if (want === 'nenhum') return null;
  const last = games.filter((g) => g.in_library && !g.hidden && g.last_played && art(g))
    .sort((a, b) => b.last_played - a.last_played)[0];
  if (want === 'perfil' && p && p.banner) return p.banner;
  return art(last) || null;
}

// Two layers, so a new picture fades in over the old one instead of replacing it.
function renderBackdrop() {
  const a = $('#backdrop');
  const b = $('#backdrop2');
  if (!a || !b) return;
  const url = backdropArt() || '';
  const front = a.classList.contains('on') ? a : b.classList.contains('on') ? b : null;
  if ((front ? front.dataset.url : '') === url) return;
  const next = front === a ? b : a;
  if (front) front.classList.remove('on');
  if (!url) return;
  next.dataset.url = url;
  next.style.backgroundImage = `url('${url}')`;
  next.classList.add('on');
}

// The library's one authored moment, as on a console's home: the game under the pointer or the
// controller lights the room with its own art. Short waits keep a pass across the grid calm.
let focusArt = null;
let focusTimer = null;
const realArt = (g) => [g.background, g.cover].find((u) => u && !u.startsWith('data:image/svg')) || null;
function setFocusArt(url) {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    focusArt = url;
    renderBackdrop();
  }, url ? 160 : 700);
}

// Page changes as one movement: the cover of the game being opened travels to its place on the
// game page and back (View Transitions). A plain swap where the WebView lacks them, in the TV
// mode, or when motion is reduced.
function coverOf(id) {
  if (!$('#detail').hidden) return document.querySelector('#detail .detail .cover');
  return id ? document.querySelector(`#grid .card[data-id="${CSS.escape(id)}"] .cover`) : null;
}

function moveTo(change, id) {
  const still = document.body.classList.contains('no-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || still || tvOn) return change();
  const from = coverOf(id);
  if (from) from.style.viewTransitionName = 'capa';
  const t = document.startViewTransition(() => {
    if (from) from.style.viewTransitionName = '';
    change();
    const to = coverOf(id);
    if (to) to.style.viewTransitionName = 'capa';
  });
  t.finished.finally(() => {
    const to = coverOf(id);
    if (to) to.style.viewTransitionName = '';
  });
}

function setGame(g) {
  const i = games.findIndex((x) => x.id === g.id);
  if (i >= 0) games[i] = g;
  else games.push(g);
  render();
}

async function refresh() {
  games = await call('get_library');
  render();
  coversInBackground();
}

// ---- Capas em segundo plano: os jogos sem capa são buscados um por vez, sem abrir a página de cada um ----

const coverTried = new Set();   // asked once per run; a game not found waits for the next start
let coverBusy = false;

function coverKeys() {
  return settings.has_steamgriddb || settings.has_igdb;
}

// PS1 and PS2 discs get their cover by serial (xlenore's collections), with no key.
const serialCovers = (g) => g.kind === 'emulated' && (g.system === 'ps1' || g.system === 'ps2');

function coverTodo() {
  return games.filter((g) => g.in_library && !g.cover && !coverTried.has(g.id) && (coverKeys() || serialCovers(g)));
}

async function coversInBackground() {
  if (coverBusy) return;
  coverBusy = true;
  try {
    for (let g = coverTodo()[0]; g; g = coverTodo()[0]) {
      coverTried.add(g.id);
      coverStatus(g);
      try {
        let got = serialCovers(g) ? await invoke('emu_cover', { id: g.id }) : null;
        if (!(got && got.cover) && coverKeys()) {
          const m = await invoke('game_meta', { id: g.id, term: null, again: false });
          if (metaCache[g.id] === undefined) metaCache[g.id] = m;
          got = m.game;
        }
        const i = games.findIndex((x) => x.id === g.id);
        if (got && i >= 0) {
          games[i] = got;
          coverPaint(got);
        }
      } catch { /* offline: tried again on the next start */ }
    }
  } finally {
    coverBusy = false;
    coverStatus(null);
  }
}

// Only the card changes, so the page does not jump while the covers arrive.
function coverPaint(g) {
  if (!g.cover) return;
  const c = document.querySelector(`#grid .card[data-id="${CSS.escape(g.id)}"] .cover`);
  if (c) c.outerHTML = coverHtml(g);
  if (tvOn) renderTv();
}

function coverStatus(g) {
  const el = $('#cover-status');
  if (!el) return;
  el.hidden = !g;
  if (g) el.innerHTML = `<span class="spin" aria-hidden="true"></span> Buscando capas: ${esc(g.title)} · faltam ${coverTodo().length + 1}`;
}

function openGame(id) {
  if (id !== justInstalled) justInstalled = null;
  focusArt = null;
  moveTo(() => {
    openId = id;
    render();
    window.scrollTo(0, 0);
  }, id);
}

async function act(action, g, el) {
  switch (action) {
    case 'link':
      await call('open_link', { url: el.dataset.url });
      break;
    case 'steam-ach-locked':
      steamAchShowLocked = !steamAchShowLocked;
      render();
      break;
    case 'cover-choose': {
      const updated = await call('choose_cover', { id: g.id });
      if (updated) setGame(updated);
      break;
    }
    case 'cover-clear':
      setGame(await call('clear_cover', { id: g.id }));
      break;
    case 'covers-save': {
      const lines = $('#templates').value.split('\n');
      coverTemplates = await call('set_cover_templates', { lines });
      toast(coverTemplates.length ? 'Endereços salvos.' : 'Nenhum endereço salvo.');
      render();
      break;
    }
    case 'covers-download': {
      el.disabled = true;
      el.textContent = 'Baixando capas…';
      try {
        coverReport = await call('download_covers');
        games = coverReport.library;
      } finally {
        render();
      }
      break;
    }
    case 'tags': {
      const tags = $('#tags-input').value.split(',');
      setGame(await call('set_tags', { id: g.id, tags }));
      toast('Etiquetas salvas.');
      break;
    }
    case 'rename':
      setGame(await call('rename_game', { id: g.id, title: $('#title-input').value }));
      toast('Nome salvo.');
      break;
    case 'back': {
      const was = openId;
      moveTo(() => {
        openId = null;
        render();
      }, was);
      break;
    }
    case 'emulators':
      await openEmulators();
      break;
    case 'project':
      if (g.kind === 'community') await call('open_link', { url: g.project_url });
      else await call('open_project', { id: g.id });
      break;
    case 'exe-list':
      exeChoices[g.id] = await call('list_executables', { id: g.id });
      render();
      break;
    case 'exe-set':
      setGame(await call('set_executable', { id: g.id, exe: el.dataset.exe }));
      delete exeChoices[g.id];
      render();
      toast('Programa escolhido. Agora é só jogar.');
      break;
    case 'community-update':
      progress[g.id] = { id: g.id, stage: 'download', done: 0, total: 0 };
      g.status = 'installing';
      render();
      try {
        justInstalled = g.id;
        setGame(await invoke('install_community', { repo: g.repo, asset: null, title: g.title }));
        toast(`${g.title} atualizado.`);
      } catch (e) {
        toast(String(e), true);
        await refresh();
      }
      break;
    case 'folder':
      await call('open_folder', { id: g.id });
      break;
    case 'copy-path':
      try {
        await navigator.clipboard.writeText(g.install_dir);
        toast('Caminho copiado.');
      } catch {
        toast(g.install_dir);
      }
      break;
    case 'add':
      await addExisting();
      break;
    case 'install': {
      const tag = el && el.dataset.tag ? el.dataset.tag : null;
      progress[g.id] = { stage: 'download', done: 0, total: 0 };
      g.status = 'installing';
      delete versions[g.id];
      render();
      try {
        justInstalled = g.id;
        setGame(await invoke('install_game', { id: g.id, tag }));
        toast(tag ? `${g.title}: versão ${versionLabel(tag)} instalada.` : `${g.title} instalado.`);
      } catch (e) {
        toast(String(e), true);
        await refresh();
      }
      break;
    }
    case 'files':
      await provideFiles(g, null);
      break;
    case 'find-downloads': {
      downloadsFound[g.id] = 'searching';
      render();
      let found = null;
      try {
        found = await invoke('find_rom_in_downloads', { id: g.id });
      } catch (e) {
        toast(String(e), true);
      }
      downloadsFound[g.id] = found || 'none';
      render();
      break;
    }
    case 'use-found': {
      const path = downloadsFound[g.id];
      delete downloadsFound[g.id];
      await provideFiles(g, path);
      break;
    }
    case 'dismiss-found':
      delete downloadsFound[g.id];
      render();
      break;
    case 'play':
      await call('play', { id: g.id });
      setGame(await call('get_game', { id: g.id }));
      break;
    case 'stop':
      if (!confirm(`Fechar ${g.title}? O progresso que não foi salvo no jogo será perdido.`)) break;
      await call('stop_game', { id: g.id });
      break;
    case 'saves':
      await call('open_saves', { id: g.id });
      break;
    case 'shortcut-desktop':
    case 'shortcut-start': {
      const location = action === 'shortcut-desktop' ? 'desktop' : 'start_menu';
      await call('create_shortcut', { id: g.id, location });
      toast(location === 'desktop' ? 'Atalho criado na área de trabalho.' : 'Atalho criado no menu Iniciar (pasta Black Flag).');
      break;
    }
    case 'remove':
      await call('remove_game', { id: g.id });
      await refresh();
      break;
    case 'favorite':
      setGame(await call('set_favorite', { id: g.id, favorite: !g.favorite }));
      break;
    case 'hide':
      setGame(await call('set_hidden', { id: g.id, hidden: !g.hidden }));
      if (!g.hidden && !settings.show_hidden) toast(`${g.title} foi ocultado. Para ver ocultos, use Configurações.`);
      break;
    case 'launch-save': {
      const env = $('#launch-env').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const i = l.indexOf('=');
        return i < 0 ? { name: l, value: '' } : { name: l.slice(0, i), value: l.slice(i + 1) };
      });
      setGame(await call('set_launch_options', { id: g.id, args: $('#launch-args').value, env }));
      toast('Opções de inicialização salvas.');
      break;
    }
    case 'notes-save': {
      const updated = await call('set_notes', { id: g.id, notes: $('#notes').value });
      if (updated) {
        setGame(updated);
        toast('Anotações salvas.');
      }
      break;
    }
    case 'backup-now':
      el.disabled = true;
      try {
        toast(await invoke('backup_now', { id: g.id }));
      } catch (e) {
        toast(String(e), true);
      }
      await reloadBackups(g.id);
      break;
    case 'backup-folder':
      await call('open_game_backups', { id: g.id });
      break;
    case 'backup-lock':
      await call('set_backup_locked', { id: g.id, file: el.dataset.file, locked: el.dataset.locked !== 'true' });
      await reloadBackups(g.id);
      break;
    case 'backup-restore': {
      const when = el.closest('li').querySelector('b').textContent;
      if (!confirm(`Restaurar o backup de ${when}? Os saves atuais de ${g.title} serão trocados por ele `
        + '(antes, eles viram um backup "antes de restaurar").')) break;
      el.disabled = true;
      try {
        toast(await invoke('restore_backup', { id: g.id, file: el.dataset.file }));
      } catch (e) {
        toast(String(e), true);
      }
      await reloadBackups(g.id);
      break;
    }
    case 'ludusavi-name': {
      const updated = await call('set_ludusavi_name', { id: g.id, name: $('#ludusavi-name').value });
      if (updated) {
        toast('Nome salvo.');
        await reloadBackups(g.id);
      }
      break;
    }
    case 'ludusavi-backup':
      el.disabled = true;
      el.textContent = 'Fazendo backup…';
      try {
        toast(await invoke('ludusavi_backup', { id: g.id }));
      } catch (e) {
        toast(String(e), true);
      }
      await reloadBackups(g.id);
      break;
    case 'open-settings':
      $('#btn-settings').click();
      break;
    case 'meta-again':
      await loadMeta(g.id, { again: true });
      break;
    case 'meta-search': {
      const term = $('#meta-term').value.trim();
      if (!term) break;
      await loadMeta(g.id, { term });
      break;
    }
    case 'keys-save':
    case 'keys-clear': {
      const clear = action === 'keys-clear';
      if (clear && !confirm('Apagar as chaves da SteamGridDB e da IGDB deste PC? As capas e descrições já guardadas continuam.')) break;
      el.disabled = true;
      try {
        keyResults = await invoke('set_api_keys', {
          steamgriddb: clear ? '' : $('#key-sgdb').value,
          igdbClientId: clear ? '' : $('#key-igdb-id').value,
          igdbClientSecret: clear ? '' : $('#key-igdb-secret').value,
          clear,
        });
        if (clear) keyResults = [{ ok: true, message: 'Chaves apagadas.' }];
        settings = await call('get_settings');
        if (!clear) refreshAllCovers();
      } catch (e) {
        keyResults = [{ ok: false, message: String(e) }];
      }
      render();
      break;
    }
    case 'gh-token-save':
    case 'gh-token-clear': {
      const clear = action === 'gh-token-clear';
      if (clear && !confirm('Apagar o token do GitHub deste PC?')) break;
      const token = clear ? '' : $('#gh-token').value.trim();
      if (!clear && !token) {
        ghTokenResult = { ok: false, message: settings.has_github_token ? 'O token guardado continua. Para trocar, cole o novo.' : 'Cole o token primeiro.' };
        render();
        break;
      }
      el.disabled = true;
      try {
        ghTokenResult = { ok: true, message: await invoke('set_github_token', { token, clear }) };
        settings = await call('get_settings');
      } catch (e) {
        ghTokenResult = { ok: false, message: String(e) };
      }
      render();
      break;
    }
    case 'meta-all': {
      el.disabled = true;
      el.textContent = 'Buscando…';
      try {
        const r = await invoke('fetch_meta_all');
        games = r.library;
        metaReport = r;
        for (const id of Object.keys(metaCache)) delete metaCache[id];
      } catch (e) {
        toast(String(e), true);
      }
      render();
      break;
    }
    case 'backup-settings-save':
      backupSettings = await call('set_backup_settings', {
        autoBackup: $('#set-autobackup').checked,
        backupKeep: Math.max(1, Math.min(100, parseInt($('#set-keep').value, 10) || 10)),
        ludusaviAuto: $('#set-ludusavi-auto').checked,
      });
      for (const id of Object.keys(backupCache)) delete backupCache[id];
      toast('Configurações de backup salvas.');
      render();
      break;
    case 'choose-ludusavi': {
      const updated = await call('choose_ludusavi');
      if (updated) {
        backupSettings = updated;
        for (const id of Object.keys(backupCache)) delete backupCache[id];
        render();
      }
      break;
    }
    case 'profile-new':
      profileForm = { id: null, name: '', color: profiles.colors[profiles.list.length % profiles.colors.length] };
      render();
      break;
    case 'profile-edit': {
      const p = profiles.list.find((x) => x.id === el.dataset.id);
      profileForm = { id: p.id, name: p.name, color: p.color };
      render();
      break;
    }
    case 'profile-color':
      // No new drawing: what was changed below the colors stays as it is.
      profileForm.color = el.dataset.color;
      $('#profile-color').value = el.dataset.color;
      document.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b === el));
      break;
    case 'profile-pic':
    case 'profile-pic-game': {
      const game = action === 'profile-pic-game' ? $(el.dataset.v === 'banner' ? '#profile-banner-game' : '#profile-pic-game').value : null;
      if (action === 'profile-pic-game' && !game) {
        toast('Escolha um jogo na lista.', true);
        break;
      }
      const updated = await call('choose_profile_picture', { id: profileForm.id, which: el.dataset.v, game });
      if (updated) {
        profiles = updated;
        renderProfileChip();
        render();
      }
      break;
    }
    case 'profile-pic-clear':
      profiles = await call('clear_profile_picture', { id: profileForm.id, which: el.dataset.v });
      renderProfileChip();
      render();
      break;
    case 'profile-export': {
      const name = await call('export_profile', { id: el.dataset.id });
      if (name) toast(`Perfil ${name} salvo. No outro PC, use "Importar perfil" com esse arquivo.`);
      break;
    }
    case 'profile-import': {
      const updated = await call('import_profile');
      if (updated) {
        profiles = updated;
        render();
        toast('Perfil importado. Use "Usar este perfil" para jogar com ele.');
      }
      break;
    }
    case 'profile-cancel':
      profileForm = null;
      render();
      break;
    case 'profile-save': {
      const name = $('#profile-name').value;
      const color = $('#profile-color').value;
      let updated = profileForm.id
        ? await call('edit_profile', { id: profileForm.id, name, color })
        : await call('create_profile', { name, color });
      if (updated && profileForm.id) {
        updated = await call('set_profile_look', { id: profileForm.id, accent: $('#look-accent').checked, look: lookFromForm() });
      }
      if (updated) {
        profiles = updated;
        profileForm = null;
        renderProfileChip();
        applyLook();
        render();
      }
      break;
    }
    case 'profile-use':
      if (await switchProfile(el.dataset.id)) render();
      break;
    case 'profile-delete': {
      const p = profiles.list.find((x) => x.id === el.dataset.id);
      if (!confirm(`Apagar o perfil ${p.name}? O tempo de jogo, o histórico, as anotações e os saves separados dele serão apagados. Os jogos continuam instalados.`)) break;
      const updated = await call('delete_profile', { id: p.id });
      if (updated) { profiles = updated; render(); }
      break;
    }
    case 'profile-options': {
      const updated = await call('set_profile_options', { askOnStart: $('#profile-ask').checked });
      if (updated) { profiles = updated; toast('Salvo.'); }
      break;
    }
    case 'separate-saves': {
      const on = el.dataset.on !== 'true';
      if (on && !confirm(`Separar os saves de ${g.title} por perfil? Os saves que estão lá agora ficam com o perfil ${profiles.active.name}; os outros perfis começam sem saves neste jogo.`)) { render(); break; }
      const updated = await call('set_separate_saves', { id: g.id, on });
      if (updated) { profiles = updated; render(); }
      break;
    }
    case 'ach-settings-save':
      achSettings = await call('set_achievement_settings', {
        overlay: $('#set-ach-overlay').checked,
        sound: $('#set-ach-sound').checked,
      });
      toast('Configurações de conquistas salvas.');
      break;
    case 'ach-test':
      await call('test_achievement_notice');
      break;
    case 'ra-refresh':
      await loadRa(g.id, true);
      break;
    case 'ra-save':
    case 'ra-clear': {
      const clear = action === 'ra-clear';
      el.disabled = true;
      try {
        const message = await invoke('set_ra_account', {
          user: clear ? '' : $('#ra-user').value,
          key: clear ? '' : $('#ra-key').value,
          clear,
        });
        raResult = { ok: true, message };
      } catch (e) {
        raResult = { ok: false, message: String(e) };
      }
      await loadProfiles();
      for (const id of Object.keys(raCache)) delete raCache[id];
      render();
      break;
    }
    case 'run-admin': {
      const updated = await call('set_run_as_admin', { id: g.id, on: el.checked });
      if (updated) setGame(updated);
      break;
    }
    case 'mods-open':
      openModsPage(g.id);
      break;
    case 'mods-back':
      openId = g.id;
      render();
      break;
    case 'mods-refresh':
      await loadMods(g.id, true);
      break;
    case 'mods-more':
      modsOf(g.id).shown += 40;
      render();
      break;
    case 'mods-folder':
      await call('open_mods_folder', { id: g.id });
      break;
    case 'mod-install': {
      const m = modsOf(g.id);
      const found = m.view.rows.find((x) => x.full_name === el.dataset.pkg);
      const r = { ...found, name: found.name.replace(/_/g, ' ') };
      const deps = r.dependencies.filter((d) => !m.view.rows.some((x) => x.full_name === d && x.installed));
      const big = r.file_size > 500 * 1048576 ? '\n\nÉ um pacote grande: o download pode demorar.' : '';
      const msg = r.installed
        ? `Atualizar ${r.name} para a versão ${r.version}?`
        : `Instalar ${r.name}, de ${r.owner} (${sizeLabel(r.file_size)})?${deps.length ? `\n\nTambém serão instalados: ${deps.join(', ')}.` : ''}${big}\n\nMods são feitos pela comunidade. Antes, o Black Flag faz backup dos seus saves.`;
      if (!confirm(msg)) break;
      m.busy = r.full_name;
      m.progress = null;
      render();
      try {
        m.view = await invoke('install_mod', { id: g.id, package: r.full_name });
        toast(`${r.name} instalado e ligado. Abra o jogo para usar.`);
      } catch (e) {
        toast(String(e), true);
      }
      m.busy = null;
      m.progress = null;
      render();
      break;
    }
    case 'mod-toggle': {
      const m = modsOf(g.id);
      try {
        m.view = await invoke('set_mod_enabled', { id: g.id, package: el.dataset.pkg, on: el.checked });
      } catch (e) {
        toast(String(e), true);
      }
      render();
      break;
    }
    case 'mod-remove': {
      const m = modsOf(g.id);
      if (!confirm(`Desinstalar ${el.dataset.pkg}? Os arquivos do mod saem da pasta de mods (seus saves ficam).`)) break;
      try {
        m.view = await invoke('uninstall_mod', { id: g.id, package: el.dataset.pkg });
        toast('Mod desinstalado.');
      } catch (e) {
        toast(String(e), true);
      }
      render();
      break;
    }
    case 'collection-save': {
      const m = modsOf(g.id);
      const list = await call('save_mod_collection', { id: g.id, name: $('#collection-name').value });
      if (list) { m.view.collections = list; toast('Coleção salva.'); render(); }
      break;
    }
    case 'collection-apply': {
      const m = modsOf(g.id);
      try {
        const [view, missing] = await invoke('apply_mod_collection', { id: g.id, name: el.dataset.name });
        m.view = view;
        toast(missing.length ? `Coleção aplicada. Não instalados: ${missing.join(', ')}.` : 'Coleção aplicada.', missing.length > 0);
      } catch (e) {
        toast(String(e), true);
      }
      render();
      break;
    }
    case 'collection-delete': {
      const m = modsOf(g.id);
      if (!confirm(`Apagar a coleção ${el.dataset.name}? Os mods continuam instalados.`)) break;
      const list = await call('delete_mod_collection', { id: g.id, name: el.dataset.name });
      if (list) { m.view.collections = list; render(); }
      break;
    }
    case 'stores-unexclude': {
      const n = await call('clear_store_exclusions');
      await importStores(false);
      toast(n ? `${n} jogo${n > 1 ? 's' : ''} das lojas volta${n > 1 ? 'm' : ''} para a biblioteca, se ainda estiver${n > 1 ? 'em' : ''} instalado${n > 1 ? 's' : ''}.` : 'Nenhum jogo das lojas tinha sido removido.');
      break;
    }
    case 'settings-save':
      settings = await call('set_settings', {
        showHidden: $('#set-hidden').checked,
        storeImport: $('#set-stores').checked,
      });
      toast('Configurações salvas.');
      break;
    case 'versions':
      versions[g.id] = 'loading';
      render();
      try {
        versions[g.id] = await call('list_versions', { id: g.id });
      } catch {
        delete versions[g.id];
      }
      render();
      break;
    case 'versions-close':
      delete versions[g.id];
      render();
      break;
    case 'steam-add': {
      el.disabled = true;
      try {
        toast(await invoke('add_to_steam', { id: g.id }));
      } catch (e) {
        toast(String(e), true);
      }
      el.disabled = false;
      break;
    }
    case 'fps-download':
      el.disabled = true;
      el.textContent = 'Baixando…';
      try {
        fpsMessage = { ok: true, text: await invoke('fps_download') };
      } catch (e) {
        fpsMessage = { ok: false, text: String(e) };
      }
      fpsStatus = await invoke('fps_status').catch(() => fpsStatus);
      render();
      break;
    case 'fps-permission':
      el.disabled = true;
      try {
        await invoke('fps_request_permission');
        fpsMessage = { ok: true, text: 'Liberado. Saia da sua conta do Windows e entre de novo (ou reinicie o PC) para o contador funcionar.' };
      } catch (e) {
        fpsMessage = { ok: false, text: String(e) };
      }
      fpsStatus = await invoke('fps_status').catch(() => fpsStatus);
      render();
      break;
    case 'fps-toggle':
      await call('set_fps_overlay', { enabled: el.checked });
      fpsStatus = await invoke('fps_status').catch(() => fpsStatus);
      toast(el.checked ? 'O FPS aparece na próxima vez que um jogo abrir.' : 'Contador de FPS desligado.');
      render();
      break;
    case 'art-use':
      await artChanged(g, await call('set_game_art', { id: g.id, active: el.dataset.v === '' ? null : Number(el.dataset.v) }));
      break;
    case 'art-add':
      await artChanged(g, await call('add_game_art', { id: g.id, kind: el.dataset.v }));
      break;
    case 'art-remove':
      await artChanged(g, await call('remove_game_art', { id: g.id, index: el.dataset.v === '' ? null : Number(el.dataset.v) }));
      break;
    case 'resume-clear':
      setGame(await call('set_resume_note', { id: g.id, text: '', seconds: 0 }));
      break;
    case 'win-security':
      await call('open_windows_security');
      break;
    case 'fix-runtime': {
      document.querySelectorAll('[data-act="fix-runtime"]').forEach((b) => (b.disabled = true));
      toast('Baixando da Microsoft… o Windows vai pedir permissão de administrador para instalar.');
      try {
        toast(await call('install_runtime', { which: el.dataset.v }));
      } finally {
        recheckAll();
      }
      break;
    }
    case 'fix-hydrate': {
      el.disabled = true;
      toast('Baixando os arquivos do OneDrive…');
      try {
        const n = await call('hydrate_game', { id: g.id });
        toast(n ? `${n} arquivo${n > 1 ? 's' : ''} baixado${n > 1 ? 's' : ''} do OneDrive.` : 'Os arquivos já estavam no PC.');
      } finally {
        recheckAll();
      }
      break;
    }
    case 'page-tab':
      pageTab[el.dataset.k] = el.dataset.v;
      render();
      break;
    case 'tour':
      openTour();
      break;
    case 'crash-scan':
      diagnoses[g.id] = 'loading';
      render();
      try {
        diagnoses[g.id] = await call('diagnose_now', { id: g.id });
      } catch {
        diagnoses[g.id] = null;
      }
      render();
      break;
    case 'crash-copy':
      try {
        await navigator.clipboard.writeText(diagnoses[g.id].report);
        toast('Relatório copiado.');
      } catch {
        toast('Não consegui copiar.', true);
      }
      break;
    case 'crash-dismiss':
      await call('dismiss_diagnosis', { id: g.id });
      diagnoses[g.id] = null;
      render();
      break;
    case 'open-dumps':
    case 'open-logs':
      await call('open_crash_folder', { id: g.id, what: action === 'open-dumps' ? 'dumps' : 'logs' });
      break;
    case 'pc-copy':
      try {
        await navigator.clipboard.writeText(pcInfo.report);
        toast('Informações do PC copiadas.');
      } catch {
        toast('Não consegui copiar.', true);
      }
      break;
    case 'pc-refresh':
      el.disabled = true;
      pcInfo = await call('get_pc_info', { refresh: true });
      for (const k of Object.keys(pcChecks)) delete pcChecks[k];
      for (const k of Object.keys(gfx)) delete gfx[k];
      render();
      break;
    case 'shader-clear':
      if (!confirm(`Limpar o cache de shaders de ${g.title}? Na próxima vez o port compila tudo de novo, com travadinhas no começo. Uma cópia fica guardada para desfazer.`)) break;
      el.disabled = true;
      await call('clear_shader_cache', { id: g.id });
      delete shaderInfo[g.id];
      toast('Cache de shaders limpo.');
      render();
      break;
    case 'shader-undo':
      if (!confirm('Devolver o cache de antes da limpeza? O que o port compilou desde então é descartado.')) break;
      el.disabled = true;
      await call('undo_shader_clear', { id: g.id });
      delete shaderInfo[g.id];
      toast('Cache de shaders devolvido.');
      render();
      break;
    case 'gpu-pref':
      await call('set_gpu_preference', { id: g.id, preference: Number(el.dataset.v) });
      gfx[g.id].preference = Number(el.dataset.v);
      toast('Vale na próxima vez que o jogo abrir.');
      render();
      break;
    case 'gfx-api':
      await call('set_graphics_api', { id: g.id, api: el.dataset.v });
      if (gfx[g.id]) gfx[g.id].api = el.dataset.v;
      toast(`API gráfica: ${el.textContent}. Vale na próxima vez que o jogo abrir.`);
      render();
      break;
    case 'skip-update':
    case 'unskip-update':
      setGame(await call('skip_update', { id: g.id, skip: action === 'skip-update' }));
      break;
    case 'ignore-updates':
      setGame(await call('set_ignore_updates', { id: g.id, ignore: !g.ignore_updates }));
      break;
    case 'reset-time':
      if (!confirm(`Zerar o tempo de jogo de ${g.title}? Isso não pode ser desfeito.`)) break;
      setGame(await call('reset_playtime', { id: g.id }));
      toast('Tempo de jogo zerado.');
      break;
    case 'uninstall':
      await uninstallGame(g);
      break;
  }
}

async function backupSaves() {
  const btn = $('#btn-backup');
  btn.disabled = true;
  btn.textContent = 'Fazendo backup…';
  try {
    const r = await call('backup_saves');
    toast(`Backup feito: ${r.files} arquivo(s) de ${r.games} jogo(s) em ${r.path}`);
    await call('open_backups');
  } catch {
    // the toast already shows why
  } finally {
    btn.disabled = false;
    btn.textContent = 'Backup dos saves';
  }
}

async function addExisting() {
  const g = await call('add_existing');
  if (!g) return;
  await refresh();
  openGame(g.id);
  toast(`${g.title} adicionado à biblioteca.`);
}

// ---- Jogos das lojas (Steam, Epic, GOG) ----

function storeCredit(g) {
  return g.store === 'GOG'
    ? 'Jogo da GOG, achado pelo Black Flag no seu PC. O Black Flag abre o jogo direto e conta o tempo.'
    : `Jogo da ${esc(g.store)}, achado pelo Black Flag no seu PC. A ${esc(g.store)} abre o jogo (com as atualizações e os saves na nuvem dela) e o Black Flag conta o tempo.`;
}

function storeReport(r) {
  const parts = [];
  if (r.added.length) parts.push(`${r.added.length} jogo${r.added.length > 1 ? 's' : ''} novo${r.added.length > 1 ? 's' : ''} das lojas: ${r.added.slice(0, 3).join(', ')}${r.added.length > 3 ? '…' : ''}.`);
  if (r.gone.length) parts.push(`Desinstalado${r.gone.length > 1 ? 's' : ''} na loja: ${r.gone.slice(0, 3).join(', ')}.`);
  return parts.join(' ');
}

async function importStores(asked) {
  if (asked) toast('Procurando jogos da Steam, da Epic e da GOG…');
  const r = await call('import_store_games');
  await refresh();
  if (!asked) return;
  if (r.added.length || r.gone.length) toast(storeReport(r));
  else if (r.found) toast(`Nenhum jogo novo: os ${r.found} jogos das lojas (${r.stores.join(', ')}) já estão na biblioteca.`);
  else toast('Não achei jogos da Steam, da Epic nem da GOG neste PC.');
}

async function addPcGame() {
  const g = await call('add_pc_game');
  if (!g) return;
  await refresh();
  openGame(g.id);
  toast(g.kind === 'port'
    ? `Esse programa é do port ${g.port_name}: ${g.title} foi adicionado como port.`
    : `${g.title} adicionado em "Outros jogos de PC". Você pode renomear na página do jogo.`);
}

$('#btn-add').addEventListener('click', addExisting);
$('#btn-add-pc').addEventListener('click', addPcGame);
$('#btn-stores').addEventListener('click', () => importStores(true));
$('#btn-covers').addEventListener('click', openCovers);
$('#btn-backup').addEventListener('click', backupSaves);
document.querySelectorAll('#tabs button[data-tab]').forEach((b) => b.addEventListener('click', () => {
  tab = b.dataset.tab;
  tagFilter = null;
  render();
}));
$('#search').addEventListener('input', (e) => {
  search = e.target.value.trim();
  renderGrid();
});
$('#btn-updates').addEventListener('click', async () => {
  games = await call('check_updates');
  render();
  const n = games.filter((g) => g.update_available).length;
  toast(n ? `${n} jogo(s) com versão nova.` : 'Tudo atualizado.');
});

listen('install-progress', (e) => {
  progress[e.payload.id] = e.payload;
  if (e.payload.id.startsWith('emu-')) {
    if (openId === '__emu' || games.some((g) => g.id === openId && g.kind === 'emulated')) render();
    return;
  }
  const onItem = openId && openId.startsWith('c:') && communityId(openId.slice(2)) === e.payload.id;
  if (openId === e.payload.id || onItem) renderDetail();
});

listen('session', async (e) => {
  const { id, state, seconds } = e.payload;
  if (state === 'ended') delete historyCache[id];
  try {
    setGame(await invoke('get_game', { id }));
  } catch {
    return; // removed from the library meanwhile
  }
  // "Abrindo…" ends after a minute if the port never showed up.
  if (state === 'starting') setTimeout(async () => setGame(await invoke('get_game', { id })), 61000);
  if (state === 'ended' && seconds > 0) {
    const g = games.find((x) => x.id === id);
    toast(`Sessão de ${playTime(seconds).toLowerCase()} somada a ${g ? g.title : id}.`);
    if (g && seconds >= RESUME_MIN_SECONDS) resumeOpen(g, seconds);
  }
});

listen('open-game', (e) => openGame(e.payload));
listen('steam-ach', (e) => {
  delete steamAchCache[e.payload.id];
  if (openId === e.payload.id) render();
});
listen('ra-unlock', (e) => {
  delete raCache[e.payload.id];
  if (openId === e.payload.id) render();
});
// A game put in a watched games folder (Emuladores) showed up by itself.
listen('emu-games', async (e) => {
  const { added, unknown } = e.payload;
  games = await invoke('get_library');
  render();
  coversInBackground();
  if (added) toast(`${added} jogo${added > 1 ? 's' : ''} de console novo${added > 1 ? 's' : ''} na biblioteca.`);
  else if (unknown && openId !== '__emu') toast(`Um jogo novo precisa que você escolha o console: veja em Emuladores.`);
  if (openId === '__emu') loadEmu();
});
// The search at start found games installed or uninstalled in the stores.
listen('stores', async (e) => {
  await refresh();
  toast(storeReport(e.payload));
});
listen('achievement', (e) => {
  const { id, game, unlocked, complete } = e.payload;
  for (const a of unlocked) toast(`🏆 Conquista: ${a.title} (${game}, ${a.points} pts)`);
  if (complete) toast(`💯 Todas as conquistas de ${game}!`);
  delete achCache[id];
  if (openId === id) render();
});
listen('backup', (e) => {
  const { id, result, message } = e.payload;
  toast(message, result === 'error');
  reloadBackups(id);
});
listen('save-changed', (e) => {
  if (backupCache[e.payload.id] && backupCache[e.payload.id] !== 'loading') {
    backupCache[e.payload.id].last_change = e.payload.at;
    if (openId === e.payload.id) render();
  }
});

// Dropping the ROM (or the dump folder) on the window; the zone lights up while dragging.
const dropHighlight = (on) => {
  const zone = document.getElementById('dropzone');
  if (zone) zone.classList.toggle('over', on);
};
listen('tauri://drag-enter', () => dropHighlight(!!dropTarget()));
listen('tauri://drag-leave', () => dropHighlight(false));
listen('tauri://drag-drop', async (e) => {
  dropHighlight(false);
  const g = dropTarget();
  const paths = (e.payload && e.payload.paths) || [];
  if (!g) {
    if (paths.length) toast('Abra a página do jogo e solte o arquivo na caixa "Arquivos do jogo".', true);
    return;
  }
  if (!paths.length || checkingDrop) return;
  if (paths.length > 1) toast('Solte um arquivo de cada vez. Conferindo só o primeiro.');
  checkingDrop = g.id;
  render();
  try {
    await provideFiles(g, paths[0]);
  } finally {
    checkingDrop = null;
    render();
  }
});
listen('notify', (e) => toast(String(e.payload), true));

// ---- Aba Comunidade: ports from the awesome list and GitHub topics, not verified ----

let communityData = null;      // { items, fetched_at, errors, list_page }
let communityAsked = false;    // asked once by itself; after a failure, only Atualizar asks again
let communityArt = null;       // id -> [data URL, source], filled as pictures are found
let artRender = null;

async function loadCommunityArt() {
  communityArt = {};
  try {
    communityArt = (await invoke('get_community_art')) || {};
  } catch { /* the cards show the name */ }
  render();
}

// Pictures arrive a few at a time; the page is drawn again at most every 600 ms.
listen('community-art', (e) => {
  if (!communityArt) communityArt = {};
  communityArt[e.payload.id] = [e.payload.url, e.payload.source];
  const showing = tab === 'community' || (openId && openId.startsWith('c:'));
  if (showing && !artRender) {
    artRender = setTimeout(() => { artRender = null; render(); }, 600);
  }
});

function communityCover(i) {
  const art = communityArt && communityArt[communityId(i.repo)];
  return art
    ? `<div class="cover"><img src="${art[0]}" alt="" loading="lazy"></div>`
    : `<div class="cover"><div class="placeholder">${esc(i.game || i.name)}</div></div>`;
}

const ART_SOURCE = { README: 'Imagem do README do projeto', SteamGridDB: 'Capa da SteamGridDB', IGDB: 'Capa da IGDB' };
let communityLoading = false;
const communityRelease = {};   // repo -> 'loading' | null | { tag, published, prerelease, assets }

// Same as community::id_for in Rust.
const communityId = (repo) => 'gh-' + repo.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 60);

async function loadCommunity(force) {
  communityLoading = true;
  render();
  try {
    communityData = await call('get_community', { force });
  } finally {
    communityLoading = false;
    render();
  }
}

let communitySort = 'recommended';
const COMMUNITY_SORTS = [
  ['recommended', 'Recomendados'],
  ['trending', 'Em alta'],
  ['stars', 'Mais estrelas'],
  ['updated', 'Atualizados há pouco'],
  ['name', 'Nome (A–Z)'],
];
const byName = (a, b) => (a.game || a.name).localeCompare(b.game || b.name, 'pt-BR');
// "Em alta": stars that keep counting while the project is alive. A project pushed today keeps
// all of them; one untouched for a month, half; for a year, about a twelfth.
function trending(i) {
  const days = i.pushed ? Math.max(0, (Date.now() / 1000 - i.pushed) / 86400) : 3650;
  return ((i.stars || 0) + 1) / (1 + days / 30);
}
const COMMUNITY_ORDER = {
  recommended: (a, b) => (b.recommended - a.recommended) || ((b.stars || 0) - (a.stars || 0)) || byName(a, b),
  trending: (a, b) => trending(b) - trending(a) || byName(a, b),
  stars: (a, b) => ((b.stars || 0) - (a.stars || 0)) || byName(a, b),
  updated: (a, b) => ((b.pushed || 0) - (a.pushed || 0)) || byName(a, b),
  name: byName,
};

function communityMatches(i) {
  if (tagFilter && i.console !== tagFilter) return false;
  if (!search) return true;
  const hay = [i.name, i.game, i.console, i.description, i.repo].join(' ').toLowerCase();
  return search.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function renderCommunityGrid() {
  markTabs();
  const head = $('#community-head');
  head.hidden = false;
  if (!communityData && !communityLoading && !communityAsked) {
    communityAsked = true;
    loadCommunity(false).catch(() => {});
  }
  if (!communityArt) loadCommunityArt();
  const data = communityData || { items: [], errors: [], fetched_at: 0 };
  head.innerHTML = `
    <div class="trust-warn" role="note">
      <span class="trust-icon" aria-hidden="true">!</span>
      <div>
        <b>Estes ports não foram verificados pelo Black Flag</b>
        <p>São projetos da comunidade achados no GitHub. Qualquer pessoa pode publicar um, e o Black Flag não confere o que
          vem dentro. Instale só de projetos em que você confia e leia o README de cada um antes.</p>
        <p class="muted">Os marcados <span class="chip ready">No catálogo</span> têm uma versão conferida na seção Instalar ports.</p>
      </div>
    </div>
    <div class="row community-meta">
      ${data.fetched_at ? `<span class="muted">Lista de ${lastPlayed(data.fetched_at)}</span>` : ''}
      <button class="ghost" data-cact="refresh" ${communityLoading ? 'disabled' : ''}>${communityLoading ? 'Buscando no GitHub…' : 'Atualizar'}</button>
      <details class="sources">
        <summary>De onde vem esta lista?</summary>
        <p class="muted">Da lista <button class="link" data-clink="${esc(data.list_page || '')}">awesome-unofficial-pc-ports</button>
          e dos projetos do GitHub com os tópicos <code>pc-port</code>, <code>native-port</code>, <code>game-port</code>,
          <code>pc-ports</code>, <code>unofficial-port</code>, <code>n64recomp</code>, <code>xenonrecomp</code>, <code>rexglue</code>,
          <code>ps3recomp</code> e <code>ps2recomp</code>. Forks entram quando têm 20 estrelas ou mais. Sem token do GitHub, a
          última busca pode passar do limite por minuto; com token, todas entram.</p>
      </details>
    </div>
    ${data.errors.length ? `<p class="muted">Não consegui ler: ${data.errors.map(esc).join('; ')}.</p>` : ''}`;
  head.querySelector('[data-cact=refresh]').addEventListener('click', () => loadCommunity(true));
  const lp = head.querySelector('[data-clink]');
  if (lp && lp.dataset.clink) lp.addEventListener('click', () => call('open_link', { url: lp.dataset.clink }));

  const consoles = [...new Set(data.items.map((i) => i.console).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  if (tagFilter && !consoles.includes(tagFilter)) tagFilter = null;
  const perConsole = (c) => data.items.filter((i) => i.console === c).length;
  $('#tagbar').innerHTML = selectHtml('console-select', 'Console', tagFilter || '',
    [['', `Todos (${data.items.length})`], ...consoles.map((c) => [c, `${c} (${perConsole(c)})`])])
    + selectHtml('sort-select', 'Ordenar', communitySort, COMMUNITY_SORTS);
  $('#console-select').addEventListener('change', (e) => { tagFilter = e.target.value || null; render(); });
  $('#sort-select').addEventListener('change', (e) => { communitySort = e.target.value; render(); });

  const list = data.items.filter(communityMatches).sort(COMMUNITY_ORDER[communitySort] || COMMUNITY_ORDER.recommended);
  const empty = $('#empty');
  empty.hidden = list.length > 0 || communityLoading;
  empty.textContent = data.items.length ? 'Nenhum port com esse filtro.' : 'Nenhum port carregado. Verifique a internet e clique em "Atualizar".';
  $('#grid').innerHTML = list.map((i) => `
    <div class="card" data-repo="${esc(i.repo)}" tabindex="0">
      ${communityCover(i)}
      <div class="body">
        <div class="title">${esc(i.game || i.name)}</div>
        <div>
          ${i.console ? `<span class="chip family">${esc(i.console)}</span>` : ''}
          ${i.recommended ? '<span class="chip fav">⭐ Recomendado</span>' : ''}
          ${i.catalog_id ? '<span class="chip ready">No catálogo</span>' : ''}
          ${i.installed_id ? '<span class="chip running">Na biblioteca</span>' : ''}
        </div>
        <div class="meta">${[i.game && i.game !== i.name ? esc(i.name) : '', i.stars != null ? `★ ${i.stars}` : '', i.pushed ? `atualizado em ${new Date(i.pushed * 1000).toLocaleDateString('pt-BR')}` : ''].filter(Boolean).join(' · ')}</div>
      </div>
    </div>`).join('');
  document.querySelectorAll('#grid .card').forEach((el) => el.addEventListener('click', () => openGame('c:' + el.dataset.repo)));
}

function communityWarning() {
  return `
    <div class="box warn">
      <h3>Instalação experimental: port não verificado</h3>
      <ul>
        <li>O Black Flag baixa o .zip para Windows da página de releases deste projeto, mas não conferiu o port nem os arquivos que ele pede.</li>
        <li>É um programa feito pela comunidade: só instale se confiar no projeto.</li>
        <li>Siga o README do projeto para colocar os arquivos da sua própria cópia do jogo. O Black Flag nunca baixa arquivos de jogos.</li>
      </ul>
    </div>`;
}

function renderCommunityItem(repo) {
  const i = communityData && communityData.items.find((x) => x.repo === repo);
  if (!i) { openId = null; render(); return; }
  const id = communityId(repo);
  const rel = communityRelease[repo];
  let install = '';
  if (i.catalog_id) {
    install = `
      <div class="box ok">
        <h3>Este port está no catálogo verificado</h3>
        <p>Use a versão do catálogo: o Black Flag confere os arquivos do jogo e explica o que falta.</p>
        <div class="row"><button class="primary" data-cact="catalog">Abrir no catálogo</button></div>
      </div>`;
  } else if (i.installed_id) {
    install = `<div class="row"><button class="primary" data-cact="library">Abrir na biblioteca</button></div>`;
  } else if (progress[id] && games.every((g) => g.id !== id)) {
    install = progressBox({ id });
  } else {
    let files = '';
    if (rel === 'loading') files = '<p class="muted">Procurando a versão para Windows no GitHub…</p>';
    else if (rel === null) {
      files = `<p>Este projeto ainda não publicou nenhuma versão para baixar: por enquanto existe só o código. Para jogar, é
        preciso compilar seguindo as instruções da página do projeto, ou esperar a primeira versão pronta.</p>
        <div class="row"><button data-cact="page">Abrir a página do projeto</button></div>`;
    } else if (rel && !rel.assets.length && rel.installers && rel.installers.length) {
      files = `
        <p>A versão <b>${esc(rel.tag)}</b> vem com instalador próprio:</p>
        <ul class="versions">${rel.installers.map((a) => `<li><span>${esc(a.name)} · ${(a.size / 1048576).toFixed(0)} MB</span></li>`).join('')}</ul>
        <p class="muted">O Black Flag não roda instaladores de outros projetos. Baixe e instale pela página de versões; depois use
          "Adicionar jogo de PC" na biblioteca para ter tempo de jogo, atalhos e backup dos saves.</p>
        <div class="row"><button data-cact="releases">Abrir a página de versões</button></div>`;
    } else if (rel && !rel.assets.length) {
      files = `<p>A versão <b>${esc(rel.tag)}</b> só tem arquivos para outros sistemas (Linux, Mac, Steam Deck…), nenhum para Windows.
        Veja na página do projeto se há outro jeito de rodar no Windows.</p>
        <div class="row"><button data-cact="page">Abrir a página do projeto</button></div>`;
    } else if (rel) {
      files = `
        <p>Versão <b>${esc(rel.tag)}</b>${rel.prerelease ? ' (pré-lançamento)' : ''} · ${new Date(rel.published * 1000).toLocaleDateString('pt-BR')}</p>
        <ul class="versions">${rel.assets.map((a) => `
          <li><span>${esc(a.name)} · ${(a.size / 1048576).toFixed(0)} MB${/\.exe$/i.test(a.name) ? ' · programa portátil' : ''}</span>
            <button data-cact="install" data-asset="${esc(a.name)}">Instalar (experimental)</button></li>`).join('')}
        </ul>`;
    }
    install = `
      ${communityWarning()}
      <div class="box">
        <h3>Versão para Windows</h3>
        ${files || '<div class="row"><button data-cact="release">Ver versão para Windows</button></div>'}
      </div>`;
  }
  $('#detail').innerHTML = `
    <button class="ghost back" data-act="back">← Comunidade</button>
    <div class="covers-page">
      <h2>${esc(i.game || i.name)}</h2>
      <div class="credit">${i.game && i.game !== i.name ? `${esc(i.name)} · ` : ''}${i.console ? `${esc(i.console)} · ` : ''}
        <button class="link" data-cact="page">${esc(i.repo)} no GitHub</button></div>
      <div>
        ${i.recommended ? '<span class="chip fav">⭐ Recomendado pela lista</span>' : ''}
        <span class="chip family">Fonte: ${i.sources.map(esc).join(' e ')}</span>
        ${i.stars != null ? `<span class="chip family">★ ${i.stars}</span>` : ''}
      </div>
      ${(() => {
        const art = communityArt && communityArt[id];
        return art ? `<figure class="community-shot"><img src="${art[0]}" alt=""><figcaption class="muted">${esc(ART_SOURCE[art[1]] || '')}</figcaption></figure>` : '';
      })()}
      ${i.description ? `<p>${esc(i.description)}</p>` : ''}
      ${install}
    </div>`;
  const on = (sel, fn) => document.querySelectorAll(`#detail [data-cact=${sel}]`).forEach((el) => el.addEventListener('click', () => fn(el)));
  document.querySelector('#detail [data-act=back]').addEventListener('click', () => { openId = null; render(); });
  on('page', () => call('open_link', { url: `https://github.com/${repo}` }));
  on('releases', () => call('open_link', { url: `https://github.com/${repo}/releases/latest` }));
  on('catalog', () => { tab = 'discover'; openGame(i.catalog_id); });
  on('library', () => openGame(i.installed_id));
  on('release', async () => {
    communityRelease[repo] = 'loading';
    render();
    try {
      communityRelease[repo] = await call('community_release', { repo });
    } catch {
      delete communityRelease[repo];
    }
    render();
  });
  on('install', async (el) => {
    const ok = confirm(`Instalar ${i.name} em modo experimental?\n\nEste port não foi verificado pelo Black Flag. Ele será baixado da página de releases de ${repo} no GitHub. Só continue se confiar no projeto.`);
    if (!ok) return;
    progress[id] = { id, stage: 'download', done: 0, total: 0 };
    render();
    try {
      const g = await invoke('install_community', { repo, asset: el.dataset.asset, title: i.game || i.name });
      justInstalled = g.id;
      setGame(g);
      delete progress[id];
      communityData = await invoke('get_community', { force: false });
      openGame(g.id);
      toast(g.status === 'needs_exe'
        ? `${g.title} instalado. Escolha qual programa o botão Jogar deve abrir.`
        : `${g.title} instalado. Leia o README do projeto para colocar os arquivos do jogo.`);
    } catch (e) {
      delete progress[id];
      toast(String(e), true);
      render();
    }
  });
}

const exeChoices = {};   // id -> list of .exe paths while choosing

function renderCommunityDetail(g) {
  const choices = exeChoices[g.id];
  const exeBox = g.status === 'needs_exe' || choices ? `
    <div class="box ${g.status === 'needs_exe' ? 'warn' : ''}">
      <h3>Qual programa o botão Jogar abre?</h3>
      ${Array.isArray(choices) ? `<ul class="versions">${choices.map((x) => `
        <li><span>${esc(x)}</span><button data-act="exe-set" data-exe="${esc(x)}">Usar este</button></li>`).join('')}</ul>`
        : '<div class="row"><button data-act="exe-list">Mostrar programas da pasta</button></div>'}
    </div>` : '';
  const update = g.update_available ? `
    <div class="box warn">
      <h3>Versão nova no GitHub: ${esc(g.latest_version)}</h3>
      <p>Arquivos em saves, save, savedata, user e config são mantidos.</p>
      <div class="row"><button data-act="community-update">Atualizar</button>
        <button class="ghost" data-act="skip-update">Pular esta versão</button></div>
    </div>` : skippedNote(g);
  $('#detail').innerHTML = `
    <button class="ghost back" data-act="back">← Biblioteca</button>
    <div class="detail">
      <div>${coverColumn(g)}</div>
      <div>
        <h2>${esc(g.title)}</h2>
        <div class="credit">Port da comunidade <b>${esc(g.port_name)}</b>, de ${esc(g.port_authors)} ·
          <button class="link" data-act="project">página do projeto</button></div>
        <div>${chips(g)}<span class="chip needs_files">Não verificado</span></div>
        <div class="stats">
          <div><div class="k">Tempo de jogo</div><div class="v">${playTime(g.total_seconds)}</div></div>
          <div><div class="k">Última sessão</div><div class="v">${lastPlayed(g.last_played)}</div></div>
          <div><div class="k">Versão</div><div class="v">${esc(g.version || '—')}</div></div>
        </div>
        ${g.status === 'installing' ? progressBox(g) : ''}
        ${playRow(g, 'o port')}
        ${folderLine(g)}
        ${update}
        ${lostFilesBox(g)}
        ${crashBox(g)}
        ${pcCheckBox(g, 'bad')}
        ${exeBox}
        ${pageTabs(g.id, [
          ['geral', 'Visão geral', '<p class="muted">Port não verificado pelo Black Flag: os arquivos do jogo seguem o README do projeto.</p>'],
          ['saves', 'Saves', ''],
          ['conquistas', 'Conquistas', ''],
          ['ajustes', 'Ajustes', `
            ${pcCheckBox(g, 'warn')}
            ${artBox(g)}
            ${g.status !== 'needs_exe' && !choices ? '<div class="box"><h3>Programa do botão Jogar</h3><div class="row"><button data-act="exe-list">Trocar o programa</button></div></div>' : ''}
            ${gfxBox(g)}
            ${shortcutsRow(g)}
            ${launchBox(g)}
            ${tagsBox(g)}
            ${crashScan(g)}
            ${manageBox(g, 'Abrir pasta do port', 'Desinstalar apaga a pasta do port, mas guarda saves, save, savedata, user e config para a próxima instalação.')}`],
        ])}
      </div>
    </div>`;
}

// ---- Controle: which controller, its button names, and the whole program with it ----

// Standard mapping: 0 bottom, 1 right, 2 left, 3 top, 4/5 shoulders, 8 View/Share, 9 Menu/Options,
// 12-15 d-pad; left stick on axes 0/1. Nintendo confirms with the right button (A).
const PAD_NAMES = {
  playstation: { ok: '✕', back: '○', y: '△', lb: 'L1', rb: 'R1', menu: 'Options' },
  xbox: { ok: 'A', back: 'B', y: 'Y', lb: 'LB', rb: 'RB', menu: 'Menu' },
  nintendo: { ok: 'A', back: 'B', y: 'X', lb: 'L', rb: 'R', menu: '+' },
};
let padKind = null;   // family of the controller last used; null before any

function padFamily(pad) {
  const id = ((pad && pad.id) || '').toLowerCase();
  if (/054c|playstation|dualsense|dualshock|wireless controller/.test(id)) return 'playstation';
  if (/057e|nintendo|pro controller|joy-con/.test(id)) return 'nintendo';
  return 'xbox';
}

function padName(which) {
  return PAD_NAMES[padKind || 'xbox'][which];
}

// The first connected controller, its family remembered; `changed` when the family is new.
function readPad() {
  // Only while Black Flag is the window in front: with a game on top, the controller is the game's.
  if (!document.hasFocus()) return null;
  const pad = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find(Boolean);
  if (!pad) return null;
  const fam = padFamily(pad);
  const changed = fam !== padKind;
  padKind = fam;
  const b = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
  const swap = fam === 'nintendo';
  const ax = pad.axes[0] || 0;
  const ay = pad.axes[1] || 0;
  return {
    changed,
    ok: b(swap ? 1 : 0), back: b(swap ? 0 : 1), y: b(3), lb: b(4), rb: b(5), menu: b(9),
    left: b(14) || ax < -0.5, right: b(15) || ax > 0.5, up: b(12) || ay < -0.5, down: b(13) || ay > 0.5,
  };
}

// Press once, repeat while held (first repeat slower).
function padEdges(state, p, t, delays = [380, 120]) {
  const press = (name) => {
    const was = state.held[name];
    state.held[name] = p[name];
    return p[name] && !was;
  };
  const out = { ok: press('ok'), back: press('back'), y: press('y'), lb: press('lb'), rb: press('rb'), menu: press('menu'), dx: 0, dy: 0 };
  const any = p.left || p.right || p.up || p.down;
  if (any && (!state.held.dir || t >= state.nextAt)) {
    out.dx = p.right - p.left;
    out.dy = p.down - p.up;
    state.nextAt = t + (state.held.dir ? delays[1] : delays[0]);
  }
  state.held.dir = any;
  return out;
}

const navPad = { held: {}, nextAt: 0 };
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]';

function isShown(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

// What the controller can reach: the open dialog only, when there is one.
function padTargets() {
  const tour = $('#tour');
  const resume = $('#resume');
  const ask = $('#ask');
  const root = ask && !ask.hidden ? ask : resume && !resume.hidden ? resume : tour && !tour.hidden ? tour : document;
  return [...root.querySelectorAll(FOCUSABLE)].filter(isShown);
}

function padFocus(el) {
  document.body.classList.add('pad-on');
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  renderPadHints();
}

// Moves to the nearest element in that direction, preferring ones in line with this one.
function padMove(dx, dy) {
  const all = padTargets();
  if (!all.length) return;
  const cur = all.includes(document.activeElement) ? document.activeElement : null;
  if (!cur) {
    padFocus(all.find((el) => el.matches('#detail .play')) || all.find((el) => el.closest('#grid, #detail')) || all[0]);
    return;
  }
  const c = cur.getBoundingClientRect();
  const cx = c.left + c.width / 2;
  const cy = c.top + c.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const el of all) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const along = dx ? (x - cx) * dx : (y - cy) * dy;
    if (along <= 2) continue;
    const across = dx ? Math.abs(y - cy) : Math.abs(x - cx);
    const score = along + across * 2.5;
    if (score < bestScore) {
      best = el;
      bestScore = score;
    }
  }
  if (best) padFocus(best);
}

// A click re-renders the page; the same button (or card) gets the focus back.
function padKey(el) {
  const d = el.dataset || {};
  return { act: d.act, id: d.id, v: d.v, k: d.k, elId: el.id, text: el.textContent.trim() };
}

function padRefocus(key) {
  const all = padTargets();
  const same = (el) => {
    const k = padKey(el);
    if (key.elId) return k.elId === key.elId;
    if (key.act || key.id) return k.act === key.act && k.id === key.id && k.v === key.v && k.k === key.k;
    return k.text === key.text;
  };
  const el = all.find(same);
  if (el) padFocus(el);
}

function padOk() {
  const el = document.activeElement;
  if (!el || el === document.body || !isShown(el)) {
    padMove(0, 1);
    return;
  }
  if (el.tagName === 'SELECT') {
    el.selectedIndex = (el.selectedIndex + 1) % el.options.length;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  // Typing needs a keyboard; the field just stays selected.
  if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(el.type))) return;
  const key = padKey(el);
  el.click();
  setTimeout(() => {
    const lost = () => !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected || !isShown(document.activeElement);
    if (lost()) padRefocus(key);
    if (lost()) padMove(0, 1);
  }, 60);
}

function padBack() {
  if (!$('#ask').hidden) {
    $('#ask [data-ask=no]').click();
    return;
  }
  if (resumeAsk) {
    resumeClose();
    return;
  }
  const menu = document.querySelector('.menu-list:not([hidden])');
  if (menu) {
    menu.hidden = true;
    padFocus(menu.previousElementSibling);
    return;
  }
  if (!$('#tour').hidden) {
    closeTour();
    return;
  }
  if (!$('#setup').hidden) {
    closeSetup();
    return;
  }
  const back = [...document.querySelectorAll('[data-act="back"]')].find(isShown);
  if (back) {
    // Back on the library, the game just left keeps the focus.
    const was = openId;
    back.click();
    setTimeout(() => {
      padRefocus({ id: was });
      if (!isShown(document.activeElement)) padMove(0, 1);
    }, 60);
    return;
  }
  if (isShown($('#lib-back'))) {
    $('#lib-back').click();
    return;
  }
  if (!openId && (tab === 'discover' || tab === 'community')) {
    goNav('library');
    return;
  }
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
}

// LB/RB: the tabs of the page (Visão geral, Ajustes…) or of the library; where there are none,
// the sections on top (Biblioteca, Emuladores…), as on a console.
function padTab(step) {
  const bar = [...document.querySelectorAll('.page-tabs, #tabs')].find(isShown) || $('#nav');
  if (!bar) return;
  const tabs = [...bar.querySelectorAll('button')].filter(isShown);
  const on = tabs.findIndex((b) => b.classList.contains('on'));
  const next = tabs[(on + step + tabs.length) % tabs.length];
  if (!next) return;
  const key = padKey(next);
  next.click();
  setTimeout(() => padRefocus(key), 60);
}

function renderPadHints() {
  const el = $('#pad-hints');
  if (!el) return;
  document.querySelectorAll('#nav .nav-key').forEach((k) => (k.textContent = padName(k.dataset.pad)));
  el.innerHTML = `<span><b>${padName('ok')}</b> Escolher</span><span><b>${padName('back')}</b> Voltar</span>
    <span><b>${padName('lb')}</b> <b>${padName('rb')}</b> Abas</span><span><b>${padName('menu')}</b> Modo TV</span>`;
}

function padPoll(t) {
  const p = readPad();
  if (p && padtestOn) {
    // Testar controle reads the controller itself: every press there is a test.
    padEdges(navPad, p, t);
  } else if (p && (resumeAsk || (!tvOn && $('#who').hidden))) {
    const e = padEdges(navPad, p, t);
    if (p.changed) renderPadHints();
    if (e.dx || e.dy) padMove(e.dx, e.dy);
    if (e.ok) padOk();
    if (e.back) padBack();
    if (e.lb) padTab(-1);
    if (e.rb) padTab(1);
    if (e.menu) tvOpen();
  } else if (p) {
    // TV and "Quem vai jogar?" read the controller themselves; these presses are theirs.
    padEdges(navPad, p, t);
  }
  requestAnimationFrame(padPoll);
}

// The hints go away when the mouse is back.
document.addEventListener('mousemove', (e) => {
  if (e.movementX || e.movementY) document.body.classList.remove('pad-on');
});
requestAnimationFrame(padPoll);

// A card chosen with Tab or the controller opens with Enter like a button.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('card') && e.target.tabIndex === 0) {
    e.target.click();
    e.preventDefault();
  }
});

// ---- Modo TV: full screen, for a controller (Gamepad API) or the keyboard ----

// A row of games (the chosen one grows, its art fills the screen), sections switched with LB/RB,
// a bar saying what each button does now, and a Guide panel on Menu/Options. Ideas from the PS4
// home screen and the Xbox 360 dashboard, drawn in Black Flag's own look.

let tvOn = false;
let tvPad = { held: {}, nextAt: 0 };
// Ports and Emulados get sections of their own when the library has both.
const TV_ALL_SECTIONS = [
  ['jogos', 'Jogos'],
  ['ports', 'Ports'],
  ['emulados', 'Emulados'],
  ['conquistas', 'Conquistas'],
  ['sistema', 'Sistema'],
];
let TV_SECTIONS = TV_ALL_SECTIONS.filter(([k]) => k !== 'ports' && k !== 'emulados');
const TV_PLAYABLE = ['jogos', 'ports', 'emulados'];
let tvSection = 0;
const tvSel = { jogos: 0, ports: 0, emulados: 0, conquistas: 0, sistema: 0 };
const tvIsPort = (g) => g.kind === 'port' || g.kind === 'community';

function tvSectionsNow() {
  const all = tvGames();
  const both = all.some(tvIsPort) && all.some((g) => g.kind === 'emulated');
  const key = TV_SECTIONS[tvSection] && TV_SECTIONS[tvSection][0];
  TV_SECTIONS = TV_ALL_SECTIONS.filter(([k]) => both || (k !== 'ports' && k !== 'emulados'));
  tvSection = Math.max(0, TV_SECTIONS.findIndex(([k]) => k === key));
}
let tvGuide = null;      // index of the Guide item in focus, null when closed
let tvClock = null;
let tvSlide = '';        // 'l' / 'r' right after changing section, for the slide-in


// Part of the profile's look (Perfil > Aparência).
function tvSoundOn() {
  const l = profiles && profiles.active && profiles.active.look;
  return !l || l.sounds !== false;
}

let tvAudio = null;
// Short tones made here (no sound file from anyone else): a tick to move, two notes to choose.
function tvSound(kind) {
  if (!tvSoundOn()) return;
  try {
    tvAudio = tvAudio || new AudioContext();
    const notes = { move: [[1320, 0.025]], ok: [[880, 0.05], [1320, 0.07]], back: [[990, 0.05], [660, 0.07]], section: [[740, 0.04], [990, 0.05]] }[kind] || [];
    let t = tvAudio.currentTime;
    for (const [f, d] of notes) {
      const o = tvAudio.createOscillator();
      const g = tvAudio.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(kind === 'move' ? 0.03 : 0.06, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(tvAudio.destination);
      o.start(t);
      o.stop(t + d + 0.02);
      t += d * 0.8;
    }
  } catch { /* no audio device */ }
}

function tvRumble() {
  if (!tvSoundOn()) return;
  const pad = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find(Boolean);
  try {
    if (pad && pad.vibrationActuator) pad.vibrationActuator.playEffect('dual-rumble', { duration: 45, strongMagnitude: 0.25, weakMagnitude: 0.35 });
  } catch { /* no rumble */ }
}

function tvGames() {
  return games
    .filter((g) => g.in_library && !g.hidden && !['not_installed', 'missing'].includes(g.status))
    .sort((a, b) => (b.favorite - a.favorite) || ((b.last_played || 0) - (a.last_played || 0)) || a.title.localeCompare(b.title, 'pt-BR'));
}

function tvSystemItems() {
  return [
    { id: 'perfil', title: 'Trocar perfil', icon: '☺', text: `Quem está jogando: ${profiles && profiles.active ? profiles.active.name : '—'}.` },
    { id: 'som', title: `Som: ${tvSoundOn() ? 'ligado' : 'desligado'}`, icon: '♪', text: 'Sons curtos ao navegar e vibração do controle ao escolher.' },
    { id: 'estatisticas', title: 'Estatísticas', icon: '▤', text: 'Tempo de jogo por semana e os jogos mais jogados.' },
    { id: 'config', title: 'Configurações', icon: '⚙', text: 'Sai do Modo TV e abre as Configurações.' },
    { id: 'sair', title: 'Sair do Modo TV', icon: '⏻', text: 'Volta para a biblioteca na janela normal.' },
  ];
}

// What the row shows in the section open now: [{ key, title, cover, game?, item? }].
function tvItems() {
  const s = TV_SECTIONS[tvSection][0];
  if (s === 'jogos') return tvGames().map((g) => ({ key: g.id, game: g }));
  if (s === 'ports') return tvGames().filter(tvIsPort).map((g) => ({ key: g.id, game: g }));
  if (s === 'emulados') return tvGames().filter((g) => g.kind === 'emulated').map((g) => ({ key: g.id, game: g }));
  if (s === 'conquistas') {
    if (!achSummary) return [];
    return achSummary.games.filter(([, , , total]) => total > 0).map(([id, , done, total]) => ({ key: id, game: games.find((g) => g.id === id), done, total }))
      .filter((x) => x.game);
  }
  return tvSystemItems().map((x) => ({ key: x.id, item: x }));
}

function tvTile(x, i, sel) {
  const cls = `tv-tile${i === sel ? ' sel' : ''}${i < sel ? ' past' : ''}`;
  if (x.item) return `<div class="${cls} tv-fn" data-i="${i}"><span class="tv-icon">${x.item.icon}</span><span>${esc(x.item.title)}</span></div>`;
  const g = x.game;
  const art = g.cover ? `<img src="${g.cover}" alt="">` : `<span class="tv-name">${esc(g.title)}</span>`;
  const bar = x.total ? `<span class="tv-progress"><span style="width:${Math.round((x.done / x.total) * 100)}%"></span></span>` : '';
  return `<div class="${cls}" data-i="${i}">${art}${g.status === 'running' ? '<span class="tv-live">jogando</span>' : ''}${bar}</div>`;
}

function tvMeta(pairs) {
  return `<div class="tv-meta">${pairs.map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>`;
}

// The text above the row: what is chosen and the facts that matter for it.
function tvInfo(x) {
  if (!x) {
    const empty = {
      jogos: ['Nenhum jogo instalado', 'Saia do Modo TV e use Adicionar para trazer os seus jogos.'],
      conquistas: [achSummary ? 'Nenhuma conquista ainda' : 'Carregando conquistas…', achSummary ? 'Os jogos com conquistas aparecem aqui.' : ''],
    }[TV_SECTIONS[tvSection][0]] || ['', ''];
    return `<h1>${esc(empty[0])}</h1><p class="tv-sub">${esc(empty[1])}</p>`;
  }
  if (x.item) return `<div class="tv-fam">Sistema</div><h1>${esc(x.item.title)}</h1><p class="tv-sub">${esc(x.item.text)}</p>`;
  const g = x.game;
  const fam = `<div class="tv-fam">${esc(g.family || '')}${g.port_name ? ` · ${esc(g.port_name)}` : ''}</div>`;
  const s = TV_SECTIONS[tvSection][0];
  if (s === 'conquistas') {
    return `${fam}<h1>${esc(g.title)}</h1>${tvMeta([['Conquistas', `${x.done} de ${x.total}`], ['Completo', `${x.total ? Math.round((x.done / x.total) * 100) : 0}%`]])}`;
  }
  const ach = achSummary && achSummary.games.find(([id]) => id === g.id);
  const pairs = [
    [g.status === 'running' ? 'Jogando há' : 'Tempo de jogo', g.status === 'running' ? sessionLength(g) : playTime(g.total_seconds)],
    ['Última vez', lastPlayed(g.last_played)],
  ];
  if (ach && ach[3]) pairs.push(['Conquistas', `${ach[2]} de ${ach[3]}`]);
  const note = g.resume ? `<p class="tv-resume">“${esc(g.resume.text)}” · ${daysAgo(g.resume.at)}</p>` : '';
  return `${fam}<h1>${esc(g.title)}</h1>${tvMeta(pairs)}${note}`;
}

// The art of the chosen game behind everything: its banner, else its cover.
function tvArt(x) {
  // Nothing chosen (Sistema, an empty section): the profile's own wide picture.
  if (!x || !x.game) return (profiles && profiles.active.banner) || '';
  const g = x.game;
  if (g.background) return g.background;
  if (g.in_library && metaCache[g.id] === undefined) {
    metaCache[g.id] = 'loading';
    setTimeout(() => loadMeta(g.id).then(() => { if (tvOn) renderTv(); }), 0);
  }
  const m = metaCache[g.id];
  if (m && m.banner) return m.banner;
  return g.cover || '';
}

// The bar at the bottom: each button and what it does on the item chosen now.
function tvTray(x) {
  const pad = padKind !== null;
  const key = (p, k) => `<b>${pad ? padName(p) : k}</b>`;
  const s = TV_SECTIONS[tvSection][0];
  let main = '';
  if (x && x.item) main = x.item.title.startsWith('Som') ? (tvSoundOn() ? 'Desligar o som' : 'Ligar o som') : x.item.title;
  else if (x && TV_PLAYABLE.includes(s)) main = x.game.status === 'running' ? `Mostrar ${x.game.title}` : `Jogar ${x.game.title}`;
  else if (x && s === 'conquistas') main = 'Ver conquistas';
  const parts = [];
  if (main) parts.push(`<span class="tv-main" data-tv="ok">${key('ok', 'Enter')} ${esc(main)}</span>`);
  if (x && x.game) parts.push(`<span data-tv="details">${key('y', 'I')} Detalhes</span>`);
  parts.push(`<span data-tv="back">${key('back', 'Esc')} Sair</span>`);
  parts.push(`<span data-tv="guide">${key('menu', 'G')} Guia</span>`);
  return parts.join('');
}

function tvGuideItems() {
  return [
    ['perfil', 'Trocar perfil'],
    ['config', 'Configurações'],
    ['som', tvSoundOn() ? 'Desligar o som' : 'Ligar o som'],
    ['sair', 'Sair do Modo TV'],
    ['fechar', 'Fechar o guia'],
  ];
}

function tvClockText() {
  return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function renderTv() {
  tvSectionsNow();
  const list = tvItems();
  const s = TV_SECTIONS[tvSection][0];
  tvSel[s] = Math.max(0, Math.min(tvSel[s], list.length - 1));
  const sel = tvSel[s];
  const x = list[sel];
  const art = tvArt(x);
  const p = profiles && profiles.active;
  const ach = achSummary ? `<span class="tv-trophy">🏆 ${achSummary.unlocked}</span>` : '';
  const shoulder = (k, kb) => `<span class="tv-key">${padKind !== null ? padName(k) : kb}</span>`;
  $('#tv').innerHTML = `
    <div class="tv-art"${art ? ` style="background-image:url('${art.replace(/'/g, '%27')}')${p && art === p.banner ? `;background-position:${bannerPos(p)}` : ''}"` : ''}></div>
    <div class="tv-scrim"></div>
    <header class="tv-top">
      <div class="brand">Black <span>Flag</span></div>
      <nav class="tv-sections">${shoulder('lb', 'Q')}${TV_SECTIONS.map(([k, label], i) =>
        `<span class="tv-sec${i === tvSection ? ' on' : ''}" data-sec="${i}">${label}</span>`).join('')}${shoulder('rb', 'E')}</nav>
      <div class="tv-me">${p ? `${avatar(p)}<span>${esc(p.name)}</span>` : ''}${ach}</div>
      <div class="tv-clock">${tvClockText()}</div>
    </header>
    <section class="tv-stage${tvSlide ? ` slide-${tvSlide}` : ''}">
      <div class="tv-info">${tvInfo(x)}</div>
      <div class="tv-row" style="--sel:${sel}">${list.map((y, i) => tvTile(y, i, sel)).join('')}</div>
    </section>
    <footer class="tv-tray">${tvTray(x)}</footer>
    ${tvGuide === null ? '' : `
      <aside class="tv-guide">
        <div class="tv-guide-who">${p ? avatar(p, true) : ''}<div><h3>${p ? esc(p.name) : ''}</h3>
          <p class="muted">${achSummary ? `${achSummary.unlocked} conquistas · ${achSummary.points} pontos` : ''}</p></div></div>
        <ul>${tvGuideItems().map(([k, label], i) => `<li class="${i === tvGuide ? 'on' : ''}" data-g="${i}">${esc(label)}</li>`).join('')}</ul>
      </aside>`}`;
  tvSlide = '';
  document.querySelectorAll('#tv .tv-tile').forEach((el) => el.addEventListener('click', () => {
    const i = Number(el.dataset.i);
    if (i === tvSel[TV_SECTIONS[tvSection][0]]) tvOk();
    else tvMove(i - tvSel[TV_SECTIONS[tvSection][0]]);
  }));
  document.querySelectorAll('#tv [data-sec]').forEach((el) => el.addEventListener('click', () => tvGoSection(Number(el.dataset.sec) - tvSection)));
  document.querySelectorAll('#tv [data-tv]').forEach((el) => el.addEventListener('click', () => tvAction(el.dataset.tv)));
  document.querySelectorAll('#tv [data-g]').forEach((el) => el.addEventListener('click', () => { tvGuide = Number(el.dataset.g); tvGuideOk(); }));
}

function tvAction(what) {
  if (what === 'ok') tvOk();
  else if (what === 'details') tvDetails();
  else if (what === 'back') tvBack();
  else if (what === 'guide') tvToggleGuide();
}

function tvMove(step) {
  const n = tvItems().length;
  const s = TV_SECTIONS[tvSection][0];
  if (!n) return;
  const next = Math.max(0, Math.min(n - 1, tvSel[s] + step));
  if (next === tvSel[s]) return;
  tvSel[s] = next;
  tvSound('move');
  renderTv();
}

function tvGoSection(step) {
  if (!step) return;
  tvSection = (tvSection + step + TV_SECTIONS.length) % TV_SECTIONS.length;
  tvSlide = step > 0 ? 'r' : 'l';
  tvSound('section');
  if (TV_SECTIONS[tvSection][0] === 'conquistas' && !achSummary) {
    invoke('get_achievement_summary').then((a) => { achSummary = a; if (tvOn) renderTv(); }).catch(() => {});
  }
  renderTv();
}

// Leaves the TV for a page of the normal window (install, settings…).
async function tvLeaveTo(fn) {
  await tvClose();
  fn();
}

async function tvOk() {
  const x = tvItems()[tvSel[TV_SECTIONS[tvSection][0]]];
  if (!x) return;
  tvSound('ok');
  tvRumble();
  if (x.item) {
    tvSystem(x.item.id);
    return;
  }
  const s = TV_SECTIONS[tvSection][0];
  const g = x.game;
  if (s === 'conquistas') {
    return tvLeaveTo(() => {
      pageTab[g.id] = 'conquistas';
      openGame(g.id);
    });
  }
  if (g.status === 'running') {
    // Brings the open game to the front.
    await invoke('play', { id: g.id }).catch(() => toast(`${g.title} já está aberto.`, true));
    return;
  }
  if (g.status !== 'ready') {
    toast(`${g.title}: ${STATUS_TEXT[g.status]}. Aperte ${padKind !== null ? padName('y') : 'I'} para ver os detalhes.`, true);
    return;
  }
  try {
    await invoke('play', { id: g.id });
    setGame(await invoke('get_game', { id: g.id }));
  } catch (e) {
    toast(String(e), true);
  }
}

function tvDetails() {
  const x = tvItems()[tvSel[TV_SECTIONS[tvSection][0]]];
  if (!x || !x.game) return;
  tvSound('ok');
  tvLeaveTo(() => openGame(x.game.id));
}

function tvSystem(id) {
  if (id === 'perfil') whoOpen();
  else if (id === 'som') {
    const p = profiles.active;
    invoke('set_profile_look', { id: p.id, accent: p.accent, look: { ...p.look, sounds: !tvSoundOn() } })
      .then((v) => { profiles = v; tvSound('ok'); renderTv(); })
      .catch((e) => toast(String(e), true));
  } else if (id === 'estatisticas') tvLeaveTo(openStats);
  else if (id === 'config') tvLeaveTo(() => $('#btn-settings').click());
  else if (id === 'sair') tvClose();
}

function tvToggleGuide() {
  tvGuide = tvGuide === null ? 0 : null;
  tvSound(tvGuide === null ? 'back' : 'section');
  renderTv();
}

function tvGuideOk() {
  const [id] = tvGuideItems()[tvGuide] || [];
  tvGuide = null;
  if (id && id !== 'fechar') tvSystem(id);
  else renderTv();
}

function tvBack() {
  if (tvGuide !== null) {
    tvToggleGuide();
    return;
  }
  tvSound('back');
  tvClose();
}

async function tvOpen() {
  tvOn = true;
  tvSection = 0;
  tvSel.jogos = 0;
  tvGuide = null;
  $('#tv').hidden = false;
  renderTv();
  if (!achSummary) invoke('get_achievement_summary').then((a) => { achSummary = a; if (tvOn) renderTv(); }).catch(() => {});
  clearInterval(tvClock);
  tvClock = setInterval(() => {
    const c = document.querySelector('#tv .tv-clock');
    if (c) c.textContent = tvClockText();
  }, 10000);
  try { await invoke('set_fullscreen', { on: true }); } catch { /* windowed is fine */ }
  requestAnimationFrame(tvPoll);
}

async function tvClose() {
  tvOn = false;
  tvGuide = null;
  clearInterval(tvClock);
  $('#tv').hidden = true;
  try { await invoke('set_fullscreen', { on: false }); } catch { /* ignore */ }
}

function tvPoll(t) {
  if (!tvOn) return;
  const p = readPad();
  if (p) {
    const e = padEdges(tvPad, p, t);
    // "Quem vai jogar?" and the "Onde você parou?" question on top read the controller themselves.
    if (!$('#who').hidden || resumeAsk) {
      requestAnimationFrame(tvPoll);
      return;
    }
    // The bar shows the buttons of the controller in use (✕ ○ on PlayStation).
    if (p.changed) renderTv();
    if (tvGuide !== null) {
      if (e.dy) {
        tvGuide = Math.max(0, Math.min(tvGuideItems().length - 1, tvGuide + e.dy));
        tvSound('move');
        renderTv();
      }
      if (e.ok) tvGuideOk();
      if (e.back || e.menu) tvToggleGuide();
    } else {
      if (e.dx) tvMove(e.dx);
      if (e.lb) tvGoSection(-1);
      if (e.rb) tvGoSection(1);
      if (e.ok) tvOk();
      if (e.y) tvDetails();
      if (e.menu) tvToggleGuide();
      if (e.back) tvBack();
    }
  }
  requestAnimationFrame(tvPoll);
}

document.addEventListener('keydown', (e) => {
  if (!tvOn || !$('#who').hidden || resumeAsk) return;
  const k = e.key.toLowerCase();
  let done = true;
  if (tvGuide !== null) {
    if (k === 'arrowup' || k === 'arrowdown') {
      tvGuide = Math.max(0, Math.min(tvGuideItems().length - 1, tvGuide + (k === 'arrowdown' ? 1 : -1)));
      renderTv();
    } else if (k === 'enter') tvGuideOk();
    else if (k === 'escape' || k === 'g') tvToggleGuide();
    else done = false;
  } else if (k === 'arrowleft' || k === 'arrowright') tvMove(k === 'arrowright' ? 1 : -1);
  else if (k === 'q' || k === 'pageup') tvGoSection(-1);
  else if (k === 'e' || k === 'pagedown') tvGoSection(1);
  else if (k === 'enter') tvOk();
  else if (k === 'i') tvDetails();
  else if (k === 'g') tvToggleGuide();
  else if (k === 'escape') tvBack();
  else done = false;
  if (done) e.preventDefault();
});

$('#btn-tv').addEventListener('click', tvOpen);

// "Mais" and "Adicionar": one list open at a time; any click closes it.
document.querySelectorAll('.menu > [data-menu]').forEach((b) => b.addEventListener('click', (e) => {
  e.stopPropagation();
  const list = b.nextElementSibling;
  const opening = list.hidden;
  closeMenus();
  list.hidden = !opening;
  b.setAttribute('aria-expanded', String(opening));
}));
function closeMenus() {
  document.querySelectorAll('.menu-list').forEach((l) => (l.hidden = true));
  document.querySelectorAll('.menu > [data-menu]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}
document.addEventListener('click', closeMenus);
$('#btn-tour').addEventListener('click', () => openTour());
$('#btn-emu').addEventListener('click', openEmulators);
$('#btn-discover').addEventListener('click', () => {
  openId = null;
  tab = 'discover';
  render();
});
// The sections on top, as on a console: Biblioteca, Emuladores, Instalar ports, Comunidade and
// Estatísticas. The one you are in stays lit; a game page belongs to Biblioteca.
function navNow() {
  if (openId === '__emu') return 'emu';
  if (openId === '__stats') return 'stats';
  if (openId && openId.startsWith('c:')) return 'community';
  if (openId && openId.startsWith('__')) return null;
  if (!openId && (tab === 'discover' || tab === 'community')) return tab;
  return 'library';
}

function markNav() {
  const now = navNow();
  document.querySelectorAll('#nav [data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === now));
}

function goNav(where) {
  if (where === 'emu') return moveTo(openEmulators);
  if (where === 'stats') return moveTo(openStats);
  moveTo(() => {
    openId = null;
    tagFilter = null;
    if (where === 'library') {
      const home = profiles && profiles.active.look && profiles.active.look.home;
      tab = home && home !== 'community' ? home : 'all';
    } else {
      tab = where;
    }
    render();
    window.scrollTo(0, 0);
  });
}

document.querySelectorAll('#nav [data-nav]').forEach((b) => b.addEventListener('click', () => goNav(b.dataset.nav)));

function tickClock() {
  const el = $('#clock');
  if (el) el.textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
tickClock();
setInterval(tickClock, 15000);

$('#lib-back').addEventListener('click', () => {
  tab = (profiles && profiles.active.look && profiles.active.look.home) || 'all';
  render();
});

// ---- Emuladores: every console, its emulator (installed from the official page, or the
// player's own), what it needs (BIOS, firmware) and its games. Decided with Codex: install only
// official builds, prepare only what Black Flag installed, never download games or BIOS. ----

let emuData = null;        // emu_overview, or null while loading
let emuBusy = false;       // a search or an install answer pending
let emuScanResult = null;  // { added, total, unknown } of the last "Procurar jogos"
let emuLoading = false;

async function loadEmu() {
  if (emuLoading) return;
  emuLoading = true;
  try {
    emuData = await invoke('emu_overview');
  } catch (e) {
    toast(String(e), true);
    emuData = emuData || { root: '', emulators: [], systems: [], folders: [], unknown: [] };
  }
  emuLoading = false;
  if (openId === '__emu') render();
  else if (openId && games.some((g) => g.id === openId && g.kind === 'emulated')) render();
}

async function openEmulators() {
  openId = '__emu';
  render();
  await loadEmu();
}

const emuById = (id) => emuData && emuData.emulators.find((e) => e.id === id);
const consoleName = (id) => (emuData && (emuData.systems.find((s) => s.id === id) || {}).name) || id;

function emuStatusLine(e) {
  if (!e) return '';
  if (e.installing) {
    const p = progress[`emu-${e.id}`] || { stage: 'download', done: 0, total: 0 };
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    const label = { download: 'Baixando da página oficial', verify: 'Conferindo o download', extract: 'Descompactando' }[p.stage] || 'Instalando';
    return `<p class="emu-line">${label}${p.total ? ` · ${pct}%` : '…'}</p><div class="progress"><div style="width:${pct}%"></div></div>`;
  }
  if (!e.found) return `<p class="emu-line off">${esc(e.name)} não está neste PC.</p>`;
  const how = e.found.managed ? `instalado pelo Black Flag${e.found.version ? ` · versão ${esc(e.found.version)}` : ''}`
    : e.found.how === 'pointed' ? 'o seu, escolhido por você' : 'o seu, encontrado neste PC';
  return `<p class="emu-line on">${esc(e.name)}: ${how}</p>`;
}

function emuButtons(e, s) {
  if (!e || e.installing) return '';
  const b = [];
  if (!e.found) {
    if (e.can_install) b.push(`<button class="primary small" data-emu="install" data-id="${e.id}">Instalar o ${esc(e.name)}</button>`);
    else b.push(`<button class="small" data-emu="page" data-url="${esc(e.id === 'ryujinx' ? 'https://ryujinx.app/download' : e.page)}">Página oficial</button>`);
    b.push(`<button class="ghost small" data-emu="locate" data-id="${e.id}">Já tenho</button>`);
  } else {
    if (e.update) b.push(`<button class="small" data-emu="install" data-id="${e.id}">Atualizar para ${esc(e.latest)}</button>`);
    b.push(`<button class="ghost small" data-emu="run" data-id="${e.id}" title="Abre o emulador sem jogo, para mudar as configurações dele">Abrir o emulador</button>`);
    if (!e.found.managed && e.found.how === 'pointed') b.push(`<button class="ghost small" data-emu="forget" data-id="${e.id}">Esquecer</button>`);
  }
  if (s && s.needs.action === 'install-firmware') b.push('<button class="primary small" data-emu="firmware">Instalar o firmware</button>');
  if (s && s.needs.folder) b.push(`<button class="ghost small" data-emu="open" data-what="bios" data-id="${s.id}">Pasta da BIOS</button>`);
  if (s) b.push(`<button class="ghost small" data-emu="open" data-what="games" data-id="${s.id}">Pasta de jogos</button>`);
  return `<div class="row">${b.join('')}</div>`;
}

// RetroAchievements in PCSX2: the login is made in PCSX2 (the password never passes through
// Black Flag); Black Flag reads its log while you play and shows each unlock over the game.
function pcsx2RaLine(e) {
  if (!e || e.id !== 'pcsx2' || !e.found || !e.ra) return '';
  const r = e.ra;
  const mine = profiles && profiles.active.ra_user;
  if (r.enabled && r.user) {
    const other = mine && mine.toLowerCase() !== r.user.toLowerCase();
    return `<p class="emu-need ok-text">✓ RetroAchievements ligado no PCSX2, conta ${esc(r.user)}. As conquistas aparecem
        por cima do jogo e na página dele.</p>
      ${other ? `<p class="emu-need muted">O perfil ${esc(profiles.active.name)} usa a conta ${esc(mine)} no Black Flag: a lista da página
        do jogo é dessa conta.</p>` : ''}
      ${mine ? '' : '<p class="emu-need muted">Para ver a lista de conquistas na página do jogo, ponha o seu usuário e a chave de API em Gerenciar perfis.</p>'}`;
  }
  return `<p class="emu-need muted">Conquistas do RetroAchievements: ${r.enabled ? 'ligadas, falta entrar com a sua conta'
      : 'desligadas'}. ${e.found.managed && !r.enabled ? 'Clique em Ligar as conquistas e depois' : 'No PCSX2,'} abra
      <b>Configurações > Conquistas</b> e clique em <b>Entrar</b> (login e senha ficam só no PCSX2).</p>
    <div class="row">
      ${e.found.managed && !r.enabled ? '<button class="small" data-emu="ra-enable">Ligar as conquistas</button>' : ''}
      <button class="ghost small" data-emu="run" data-id="pcsx2">Abrir o PCSX2 para entrar</button>
      <button class="ghost small" data-emu="refresh">Já entrei</button>
    </div>`;
}

function needsLine(n) {
  if (!n || !n.asks) return '';
  const cls = n.ok ? 'ok-text' : n.blocks ? 'bad-text' : 'muted';
  return `<p class="emu-need ${cls}">${n.ok ? '✓ ' : n.blocks ? '✗ ' : ''}${esc(n.text)}</p>`;
}

function consoleCard(s) {
  const e = emuById(s.emulator);
  const state = !e || !e.found ? 'off' : s.needs.blocks ? 'warn' : 'on';
  const choose = s.choices.length > 1 ? `
    <label class="inline-field">Emulador
      <select data-emu-choose="${s.id}">${s.choices.map(([id, name]) => `<option value="${id}" ${id === s.emulator ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>` : '';
  return `
    <div class="emu-card ${state}">
      <div class="emu-head"><b>${esc(s.name)}</b><span class="chip family">${s.games} jogo${s.games === 1 ? '' : 's'}</span></div>
      ${choose}
      ${emuStatusLine(e)}
      ${needsLine(s.needs)}
      ${pcsx2RaLine(e)}
      ${e && !e.full && e.found ? '<p class="muted small-text">As configurações ficam no próprio emulador (Abrir o emulador).</p>' : ''}
      ${emuButtons(e, s)}
    </div>`;
}

function unknownBox(d) {
  if (!d.unknown.length) return '';
  const opts = (u) => u.options.map((o) => `<option value="${o}" ${o === u.guess ? 'selected' : ''}>${esc(consoleName(o))}</option>`).join('');
  return `
    <div class="box warn">
      <h3>${d.unknown.length} arquivo${d.unknown.length === 1 ? '' : 's'} sem console certo</h3>
      <p>O Black Flag não teve certeza de qual console ${d.unknown.length === 1 ? 'é este jogo' : 'são estes jogos'}. Escolha e confirme; nada é movido.</p>
      <ul class="emu-unknown">${d.unknown.slice(0, 60).map((u, i) => `
        <li><span class="path" title="${esc(u.path)}">${esc(u.path.split(/[\\/]/).pop())}</span>
          <select data-unknown="${i}">${opts(u)}</select>
          <button class="small" data-emu="assign" data-i="${i}">Confirmar</button></li>`).join('')}</ul>
      <div class="row"><button data-emu="assign-all">Confirmar todos como estão</button></div>
    </div>`;
}

function renderEmulators() {
  const d = emuData;
  let body = '<p class="muted">Procurando os emuladores neste PC…</p>';
  if (d) {
    const scan = emuScanResult ? `<p class="${emuScanResult.added ? 'ok-text' : 'muted'}">${emuScanResult.total} jogo${emuScanResult.total === 1 ? '' : 's'} nas pastas · ${emuScanResult.added} novo${emuScanResult.added === 1 ? '' : 's'} na biblioteca${emuScanResult.unknown ? ` · ${emuScanResult.unknown} para você escolher o console` : ''}.</p>` : '';
    body = `
      <div class="box">
        <h3>Seus jogos</h3>
        <p>Coloque cada jogo na pasta do console dele (por exemplo <code>Jogos\\ps2</code> para PlayStation 2) ou
          aponte uma pasta que você já tem. O Black Flag reconhece o console pelo arquivo e nunca move nada. As pastas ficam
          vigiadas: um jogo colocado nelas aparece sozinho na biblioteca, em alguns segundos.</p>
        <div class="folder-line"><span class="k">Pasta do Black Flag</span><code class="path" title="${esc(d.root)}">${esc(d.root)}</code>
          <button class="small" data-emu="open" data-what="root">Abrir</button>
          <button class="ghost small" data-emu="root">Mudar</button></div>
        <div class="row">
          <button class="primary" data-emu="scan" ${emuBusy ? 'disabled' : ''}>${emuBusy ? 'Procurando…' : 'Procurar jogos'}</button>
          <label class="inline-field">Adicionar uma pasta de
            <select id="emu-folder-system"><option value="">vários consoles</option>${d.systems.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
          <button data-emu="add-folder" ${emuBusy ? 'disabled' : ''}>Escolher a pasta</button>
        </div>
        ${d.folders.length ? `<ul class="emu-folders">${d.folders.map((f) => `
          <li><code class="path">${esc(f.path)}</code><span class="muted">${f.system ? esc(consoleName(f.system)) : 'vários consoles'}</span>
            <button class="ghost small" data-emu="remove-folder" data-path="${esc(f.path)}">Tirar</button></li>`).join('')}</ul>` : ''}
        ${scan}
      </div>
      ${unknownBox(d)}
      <h3 class="emu-title">Consoles</h3>
      <div class="emu-grid">${d.systems.map(consoleCard).join('')}</div>
      <div class="row"><button class="ghost" data-emu="updates">Procurar atualizações dos emuladores</button></div>
      <p class="muted small-text">Os emuladores vêm só das páginas oficiais de cada projeto. O Black Flag nunca baixa jogos, BIOS, firmware
        ou chaves: esses arquivos precisam vir dos seus consoles e discos. Nos emuladores que ele instala, ele já deixa o controle
        no jogador 1 e a pasta da BIOS apontada; nos que você já tinha, ele não muda nada.</p>`;
  }
  $('#detail').innerHTML = `
    <button class="ghost back" data-act="back">← Biblioteca</button>
    <div class="emu-page">
      <h2>Emuladores</h2>
      <p class="muted">Jogos de console no PC: o Black Flag instala o emulador certo, prepara o controle e abre o jogo em tela cheia.</p>
      ${body}
    </div>`;
  document.querySelectorAll('#detail [data-act]').forEach((el) => el.addEventListener('click', () => act(el.dataset.act, null, el)));
  document.querySelectorAll('#detail [data-emu]').forEach((el) => el.addEventListener('click', () => emuAct(el.dataset.emu, el)));
  document.querySelectorAll('#detail [data-emu-choose]').forEach((el) => el.addEventListener('change', async () => {
    await call('emu_choose', { system: el.dataset.emuChoose, emulator: el.value });
    await loadEmu();
  }));
}

async function emuScan(kind, system) {
  emuBusy = true;
  render();
  try {
    const r = kind === 'folder' ? await invoke('emu_add_folder', { system: system || null }) : await invoke('emu_scan');
    if (r) emuScanResult = r;
    games = await invoke('get_library');
    coversInBackground();
  } catch (e) {
    toast(String(e), true);
  }
  emuBusy = false;
  await loadEmu();
}

async function emuAct(what, el) {
  const id = el.dataset.id;
  try {
    switch (what) {
      case 'install': {
        progress[`emu-${id}`] = { stage: 'download', done: 0, total: 0 };
        const e = emuById(id);
        if (e) e.installing = true;
        render();
        await invoke('emu_install', { id });
        toast(`${e ? e.name : id} instalado. Ele já está pronto para os jogos.`);
        delete progress[`emu-${id}`];
        await loadEmu();
        games = await invoke('get_library');
        break;
      }
      case 'locate':
        if (await invoke('emu_locate', { id })) await loadEmu();
        break;
      case 'forget':
        await invoke('emu_forget', { id });
        await loadEmu();
        break;
      case 'run':
        await invoke('emu_run', { id });
        break;
      case 'ra-enable':
        await invoke('emu_ra_enable');
        toast('Conquistas ligadas no PCSX2. Agora entre com a sua conta nele: Configurações > Conquistas > Entrar.');
        await loadEmu();
        break;
      case 'refresh':
        await loadEmu();
        break;
      case 'page':
        await call('open_link', { url: el.dataset.url });
        break;
      case 'firmware':
        await invoke('emu_install_firmware');
        toast('O RPCS3 abriu para instalar o firmware. Quando terminar, feche-o e volte aqui.');
        break;
      case 'open':
        await invoke('emu_open', { what: el.dataset.what, id: id || null });
        break;
      case 'root':
        if (await invoke('emu_set_root')) await loadEmu();
        break;
      case 'scan':
        await emuScan('all');
        break;
      case 'add-folder':
        await emuScan('folder', $('#emu-folder-system').value);
        break;
      case 'remove-folder':
        await invoke('emu_remove_folder', { path: el.dataset.path });
        await loadEmu();
        break;
      case 'assign': {
        const u = emuData.unknown[Number(el.dataset.i)];
        const sel = document.querySelector(`[data-unknown="${el.dataset.i}"]`);
        await invoke('emu_assign', { path: u.path, system: sel.value });
        games = await invoke('get_library');
        await loadEmu();
        break;
      }
      case 'assign-all': {
        const picks = emuData.unknown.slice(0, 60).map((u, i) => [u.path, document.querySelector(`[data-unknown="${i}"]`).value]);
        for (const [path, system] of picks) await invoke('emu_assign', { path, system });
        games = await invoke('get_library');
        await loadEmu();
        break;
      }
      case 'updates': {
        el.disabled = true;
        const n = await invoke('emu_check_updates');
        toast(n ? `${n} emulador${n > 1 ? 'es têm' : ' tem'} versão nova.` : 'Os emuladores instalados estão na versão mais nova.');
        await loadEmu();
        break;
      }
      default:
    }
  } catch (e) {
    if (what === 'install') {
      delete progress[`emu-${id}`];
      await loadEmu();
    }
    toast(String(e), true);
  }
}

// The console and emulator box on an emulated game's page.
function emuGameBox(g) {
  if (g.kind !== 'emulated') return '';
  if (!emuData) {
    loadEmu();
    return '<div class="box"><h3>Console e emulador</h3><p class="muted">Conferindo o emulador…</p></div>';
  }
  const s = emuData.systems.find((x) => x.id === g.system);
  if (!s) return '';
  const chosenId = (s.choices.find(([, name]) => name === g.emulator) || [s.emulator])[0];
  const e = emuById(chosenId);
  const choose = s.choices.length > 1 ? `
    <label class="inline-field">Emulador deste jogo
      <select id="emu-game-choice"><option value="">o do console (${esc((emuById(s.emulator) || {}).name || '')})</option>
        ${s.choices.map(([id, name]) => `<option value="${id}" ${name === g.emulator && id !== s.emulator ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>` : '';
  return `
    <div class="box ${!e || !e.found || s.needs.blocks ? 'warn' : ''}">
      <h3>${esc(s.name)}</h3>
      ${choose}
      ${emuStatusLine(e)}
      ${needsLine(s.needs)}
      ${emuButtons(e, s)}
      <p class="muted small-text"><button class="link" data-act="emulators">Ver todos os emuladores</button></p>
    </div>`;
}

function bindEmuGameBox(g) {
  if (g.kind !== 'emulated') return;
  document.querySelectorAll('#detail [data-emu]').forEach((el) => el.addEventListener('click', async () => {
    await emuAct(el.dataset.emu, el);
    games = await invoke('get_library');
    render();
  }));
  const sel = $('#emu-game-choice');
  if (sel) sel.addEventListener('change', async () => {
    setGame(await call('emu_set_game_emulator', { id: g.id, emulator: sel.value || null }));
  });
}

// ---- Tutorial: shown once, the first time; again from Mais > Tutorial ----

const TOUR_SEEN = 'recomphub-tutorial-1';
const TOUR_WAIT = 2;     // seconds before Próximo and Pular work on a step, so it gets read
let tourStep = 0;
let tourWait = 0;        // seconds left on the step shown now
let tourTimer = null;
const tourRead = new Set();   // steps already waited on, which open at once when shown again

// The covers step shows one of the player's games as it looks now, and with a real cover if it has one.
function tourCoverSample() {
  const g = games.find((x) => x.in_library && x.cover && !x.cover.startsWith('data:image/svg'))
    || games.find((x) => x.in_library);
  if (!g) return '';
  const before = `<div class="cover"><div class="placeholder">${esc(g.title)}</div></div>`;
  const after = g.cover && !g.cover.startsWith('data:image/svg') ? `<div class="cover"><img src="${g.cover}" alt=""></div>` : '';
  if (!after) return '';
  return `<div class="tour-compare">
      <figure>${before}<figcaption>Sem capa</figcaption></figure>
      <span class="tour-arrow" aria-hidden="true">→</span>
      <figure>${after}<figcaption>Com capa</figcaption></figure>
    </div>`;
}

function tourSteps() {
  const sgdb = settings.has_steamgriddb;
  return [
    {
      title: 'Bem-vindo ao Black Flag',
      html: `<p class="tour-lead">Os seus jogos num lugar só: os da Steam, da Epic e da GOG, os ports e qualquer outro jogo de PC.</p>
        <p>Antes de abrir um jogo, o Black Flag confere se falta alguma coisa no PC, como o Visual C++, e resolve com um
          clique. Ele também conta o tempo jogado e guarda backup dos saves.</p>
        <p class="muted">Ele nunca baixa jogos. Os arquivos vêm da sua própria cópia.</p>`,
    },
    {
      title: 'Tudo fica no alto da tela',
      html: `<p class="tour-lead">O programa é dividido em seções, como num console. Clique numa delas para ir até lá.</p>
        <div class="tour-sections" aria-hidden="true">
          <span class="on">Biblioteca</span><span>Emuladores</span><span>Instalar ports</span><span>Comunidade</span><span>Estatísticas</span>
        </div>
        <ul>
          <li><b>Biblioteca</b>: os seus jogos. As abas logo abaixo separam Ports, Emulados, Steam, Epic, GOG e Jogos de PC.</li>
          <li><b>Emuladores</b>: os jogos de console (PlayStation, Nintendo, Xbox) e os emuladores para rodá-los.</li>
          <li><b>Instalar ports</b>: a lista de ports conferidos pelo Black Flag.</li>
          <li><b>Comunidade</b>: outros ports achados no GitHub, que ninguém conferiu.</li>
          <li><b>Estatísticas</b>: quanto você jogou, por jogo e por dia.</li>
        </ul>
        <p class="muted">Com controle, LB e RB trocam de seção (ou de aba, onde houver abas).</p>`,
    },
    {
      title: 'Trazer os seus jogos',
      html: `<p>Tudo começa no botão dourado <b>+ Adicionar</b>, no alto à direita:</p>
        <ul>
          <li><b>Jogos da Steam, Epic e GOG</b>: o Black Flag acha os que já estão instalados, e procura de novo sempre que abre.</li>
          <li><b>Instalar um port</b>: a lista de ports conferidos. Escolha um, clique em Instalar e arraste o arquivo da sua
            cópia (a ROM ou a pasta do dump) para a página do jogo.</li>
          <li><b>Port que já está no PC</b> e <b>Jogo de PC</b>: para o que você já tem numa pasta.</li>
        </ul>
        <p class="muted">A seção Comunidade mostra outros ports achados no GitHub. Eles não foram conferidos: instale só de
          projetos em que você confia.</p>`,
    },
    {
      title: 'Jogos de console',
      html: `<p>Na seção <b>Emuladores</b> cada console tem um cartão com o emulador dele:</p>
        <ol>
          <li>Clique em <b>Instalar</b> no cartão do console: o Black Flag baixa o emulador da página oficial e já deixa ele configurado para o
            controle. Se você já tem um emulador, clique em <b>Já tenho</b>.</li>
          <li>Coloque os seus jogos na pasta <b>Jogos</b> do console (o botão <b>Pasta de jogos</b> leva até ela), ou aponte
            uma pasta que você já tem.</li>
          <li>Pronto: em alguns segundos o jogo aparece sozinho na Biblioteca, com capa, e abre com <b>Jogar</b> como
            qualquer outro.</li>
        </ol>
        <p class="muted">Alguns consoles pedem a BIOS ou o firmware do seu aparelho. O cartão diz o que falta e onde colocar.
          O Black Flag nunca baixa jogos, BIOS ou firmware.</p>`,
    },
    {
      title: 'A página do jogo',
      html: `<p><b>Jogar</b> fica sempre no alto. Logo abaixo aparecem só os avisos que importam agora, como versão nova ou
          algo faltando no PC. O resto fica em abas:</p>
        <ul>
          <li><b>Visão geral</b>: descrição, tempo de jogo e anotações.</li>
          <li><b>Saves</b>: backups automáticos, restaurar e travar.</li>
          <li><b>Conquistas</b>: as do Black Flag e as do RetroAchievements.</li>
          <li><b>Ajustes</b>: vídeo, versão, atalhos, as suas capas e desinstalar.</li>
        </ul>
        <p class="muted">Se o jogo fechar com erro, o Black Flag mostra o motivo provável e o que tentar.</p>`,
    },
    {
      title: 'Um perfil para cada um',
      html: `<p>Cada pessoa da casa pode ter o seu perfil, com tempo de jogo, saves e conquistas separados. Na tela
          <b>Quem vai jogar?</b> você escolhe quem está jogando. Para trocar depois, clique no seu nome, no canto direito do alto.</p>
        <p>Em <b>Gerenciar perfis</b> dá para pôr foto, capa, cor e mudar a aparência da biblioteca.</p>
        <p>Quando você fecha um jogo, o Black Flag pergunta <b>onde você parou</b>. O recado aparece na próxima vez que
          você abrir o jogo.</p>`,
    },
    {
      title: 'Controle e Modo TV',
      html: `<p>O programa inteiro funciona com controle de Xbox ou PlayStation: o direcional anda, A ou ✕ escolhe, B ou ○
          volta, LB e RB trocam de aba ou de seção. A barra no rodapé mostra os botões do seu controle.</p>
        <p>O botão <b>Modo TV</b>, no alto, mostra a biblioteca em tela cheia, para jogar do sofá.</p>
        <p class="muted">No meio de um jogo, segure o botão Guide (ou Back + Start) para trazer o Black Flag de volta.</p>`,
    },
    {
      title: 'Pronto',
      html: `<p class="tour-lead">Isso é o básico.</p>
        <p>Para rever este tutorial, use <b>Mais > Tutorial</b>, no alto.</p>
        ${setupMissing() ? '<p><b>Logo depois:</b> as chaves grátis para as capas e as conquistas, num passo à parte.</p>' : ''}
        <p class="muted">Se o GitHub disser que você passou do limite de consultas (comum com muitos jogos), crie um token
          grátis em Configurações > Capas e GitHub.</p>`,
    },
  ];
}

function renderTour() {
  const steps = tourSteps();
  const s = steps[tourStep];
  const last = tourStep === steps.length - 1;
  $('#tour').innerHTML = `
    <div class="tour-card${s.feature ? ' tour-feature' : ''}" role="dialog" aria-modal="true" aria-labelledby="tour-title" tabindex="-1">
      <div class="tour-dots" aria-hidden="true">${steps.map((x, i) =>
        `<span class="${i === tourStep ? 'on' : i < tourStep ? 'done' : ''}${x.feature ? ' star' : ''}"></span>`).join('')}</div>
      <p class="tour-count">${s.feature ? 'Passo especial · ' : ''}${tourStep + 1} de ${steps.length}</p>
      <h2 id="tour-title">${s.title}</h2>
      <div class="tour-body">${s.html}</div>
      <div class="tour-nav">
        <div class="tour-wait" ${tourWait > 0 ? '' : 'hidden'}><span style="animation-duration:${TOUR_WAIT}s;animation-delay:-${TOUR_WAIT - tourWait}s"></span></div>
        <div class="row">
          ${tourStep ? '<button class="ghost" data-tour="back">Voltar</button>' : ''}
          <span class="grow"></span>
          ${last ? '' : '<button class="ghost" data-tour="close" data-wait>Pular tutorial</button>'}
          <button class="primary" data-tour="${last ? 'close' : 'next'}" data-wait>${last ? 'Começar' : 'Próximo'}</button>
        </div>
      </div>
    </div>`;
  $('#tour').querySelectorAll('[data-tour]').forEach((el) => el.addEventListener('click', () => tourAct(el.dataset.tour)));
  tourButtons();
}

// Próximo and Pular stay off, with the seconds left, until the step had time to be read.
function tourButtons() {
  const card = $('#tour .tour-card');
  if (!card) return;
  const locked = tourWait > 0;
  card.querySelectorAll('[data-wait]').forEach((b) => {
    b.disabled = locked;
    if (!b.dataset.label) b.dataset.label = b.textContent;
    b.textContent = locked && b.classList.contains('primary') ? `${b.dataset.label} (${tourWait})` : b.dataset.label;
  });
  const bar = card.querySelector('.tour-wait');
  if (bar) bar.hidden = !locked;
  const main = card.querySelector('[data-tour=next], [data-tour=close].primary');
  if (!locked && main) main.focus();
  else if (locked) card.focus();
}

// Called when a step comes on screen.
function tourLock() {
  clearInterval(tourTimer);
  tourWait = tourRead.has(tourStep) ? 0 : TOUR_WAIT;
  if (!tourWait) return;
  const step = tourStep;
  tourTimer = setInterval(() => {
    if (step !== tourStep) return clearInterval(tourTimer);
    tourWait -= 1;
    if (tourWait <= 0) {
      clearInterval(tourTimer);
      tourRead.add(step);
    }
    tourButtons();
  }, 1000);
}

function tourAct(what) {
  if ((what === 'next' || what === 'close') && tourWait > 0) return;
  if (what === 'next') {
    tourStep += 1;
    tourLock();
  } else if (what === 'back') {
    tourStep = Math.max(0, tourStep - 1);
    tourLock();
  } else if (what === 'close') {
    return closeTour();
  }
  renderTour();
}

function openTour() {
  tourStep = 0;
  tourRead.clear();
  $('#tour').hidden = false;
  popIn($('#tour'));
  tourLock();
  renderTour();
}

// Esc and B close it too, but only once Pular could.
function tourCanClose() {
  return tourWait <= 0;
}

function closeTour() {
  if (!tourCanClose()) return;
  clearInterval(tourTimer);
  $('#tour').hidden = true;
  try { localStorage.setItem(TOUR_SEEN, '1'); } catch { /* shown again next time */ }
  // Finished or skipped, the keys come next while one is missing.
  if (setupMissing()) openSetup();
}

// ---- Capas e conquistas: the free keys, a step of its own after the tutorial ----
// It opens when the tutorial ends (even by Pular) while a key is missing, again from
// Mais > Capas e conquistas, and the library keeps a notice until both are in.

const SETUP_SNOOZE = 'blackflag-chaves-depois';   // when "Agora não" was clicked on the notice
const SETUP_WAIT = 2;
let setupResult = { sgdb: null, ra: null };
let setupWait = 0;
let setupTimer = null;

const raLinked = () => !!(profiles && profiles.active && profiles.active.ra_user && profiles.active.has_ra_key);
const setupMissing = () => !settings.has_steamgriddb || !raLinked();

function setupResultHtml(r) {
  return r ? `<ul>${r.map((x) => `<li class="${x.ok ? 'ok-text' : 'bad-text'}">${esc(x.message)}</li>`).join('')}</ul>` : '';
}

function renderSetup() {
  const sgdb = settings.has_steamgriddb;
  const ra = raLinked();
  const p = profiles && profiles.active;
  $('#setup').innerHTML = `
    <div class="tour-card tour-feature setup-card" role="dialog" aria-modal="true" aria-labelledby="setup-title" tabindex="-1">
      <h2 id="setup-title">Capas e conquistas</h2>
      <p class="tour-lead">Duas chaves grátis deixam o Black Flag completo. Leva uns minutos e é feito uma vez só.</p>
      <section class="setup-part${sgdb ? ' done' : ''}">
        <h3>Capas de todos os jogos <span class="chip family">SteamGridDB</span>${sgdb ? '<span class="ok-text">✓ Pronta</span>' : ''}</h3>
        <p>Sem capa, cada jogo aparece só com o nome. Com a chave, o Black Flag busca capas e banners para a biblioteca inteira,
          na hora.</p>
        ${tourCoverSample()}
        <ol class="tour-big">
          <li><button class="link" data-setup-link="${esc(settings.sgdb_key_page || 'https://www.steamgriddb.com/profile/preferences/api')}">Abra a página de API da SteamGridDB</button>.</li>
          <li>Entre com a sua conta Steam (botão Login no alto da página).</li>
          <li>Clique em <b>Generate API Key</b>, copie a chave e cole aqui:</li>
        </ol>
        <div class="tour-key">
          <input type="password" id="setup-sgdb" autocomplete="off" placeholder="${sgdb ? 'Chave já guardada (cole outra para trocar)' : 'Chave de API da SteamGridDB'}">
          <button class="primary" data-setup="sgdb">Salvar e testar</button>
        </div>
        ${setupResultHtml(setupResult.sgdb)}
      </section>
      <section class="setup-part${ra ? ' done' : ''}">
        <h3>Conquistas do RetroAchievements${ra ? '<span class="ok-text">✓ Conectado</span>' : ''}</h3>
        <p>Mostra as suas conquistas nos ports de N64 e nos jogos de PS2 do PCSX2, com a lista na página de cada jogo.</p>
        <ol class="tour-big">
          <li><button class="link" data-setup-link="https://retroachievements.org/settings">Abra as configurações do RetroAchievements</button>
            (crie uma conta grátis se ainda não tiver).</li>
          <li>Em <b>Keys</b>, copie a <b>Web API Key</b>.</li>
          <li>Ponha o seu usuário e a chave aqui:</li>
        </ol>
        <div class="tour-key">
          <input type="text" id="setup-ra-user" maxlength="40" autocomplete="off" placeholder="Usuário" value="${esc((p && p.ra_user) || '')}">
          <input type="password" id="setup-ra-key" maxlength="64" autocomplete="off" placeholder="${p && p.has_ra_key ? 'Chave guardada (vazio mantém)' : 'Web API Key'}">
          <button class="primary" data-setup="ra">Salvar e testar</button>
        </div>
        ${setupResultHtml(setupResult.ra)}
        <p class="muted">Fica no perfil ${esc((p && p.name) || '')}. As conquistas da Steam não precisam de chave.</p>
      </section>
      <p class="muted">As chaves ficam só neste PC. Dá para trocar depois em Configurações e em Gerenciar perfis.</p>
      <div class="tour-nav">
        <div class="tour-wait" ${setupWait > 0 ? '' : 'hidden'}><span style="animation-duration:${SETUP_WAIT}s"></span></div>
        <div class="row">
          <span class="grow"></span>
          ${sgdb && ra ? '' : '<button class="ghost" data-setup="later" data-wait>Fazer depois</button>'}
          <button class="${sgdb && ra ? 'primary' : ''}" data-setup="done" data-wait>${sgdb && ra ? 'Pronto' : 'Concluir'}</button>
        </div>
      </div>
    </div>`;
  $('#setup').querySelectorAll('[data-setup]').forEach((el) => el.addEventListener('click', () => setupAct(el.dataset.setup, el)));
  $('#setup').querySelectorAll('[data-setup-link]').forEach((el) =>
    el.addEventListener('click', () => call('open_link', { url: el.dataset.setupLink })));
  setupButtons();
}

function setupButtons() {
  $('#setup').querySelectorAll('[data-wait]').forEach((b) => (b.disabled = setupWait > 0));
  const bar = $('#setup .tour-wait');
  if (bar) bar.hidden = setupWait <= 0;
}

function openSetup() {
  setupResult = { sgdb: null, ra: null };
  $('#setup').hidden = false;
  popIn($('#setup'));
  clearInterval(setupTimer);
  setupWait = SETUP_WAIT;
  setupTimer = setInterval(() => {
    setupWait -= 1;
    if (setupWait <= 0) clearInterval(setupTimer);
    setupButtons();
  }, 1000);
  renderSetup();
  const card = $('#setup .tour-card');
  if (card) card.focus();
}

function closeSetup() {
  if (setupWait > 0) return;
  $('#setup').hidden = true;
  render();
}

// A new SteamGridDB key: every game without a cover is looked up again, at once.
// Games looked up before keys existed are asked again, on their page and in the background; so
// are the Comunidade pictures taken from a README (get_community starts that search).
function refreshAllCovers() {
  for (const id of Object.keys(metaCache)) if (!metaCache[id].cached) delete metaCache[id];
  coverTried.clear();
  coversInBackground();
  invoke('get_community', { force: false }).then((d) => { communityData = d; }).catch(() => {});
}

async function setupAct(what, el) {
  if (what === 'later' || what === 'done') return closeSetup();
  el.disabled = true;
  if (what === 'sgdb') {
    const key = $('#setup-sgdb').value.trim();
    if (!key) {
      setupResult.sgdb = [{ ok: false, message: 'Cole a chave no campo primeiro.' }];
    } else {
      try {
        setupResult.sgdb = await invoke('set_api_keys', { steamgriddb: key, igdbClientId: '', igdbClientSecret: '', clear: false });
        settings = await invoke('get_settings');
        if (settings.has_steamgriddb) {
          refreshAllCovers();
          toast('Chave guardada. Buscando as capas de todos os jogos…');
        }
      } catch (e) {
        setupResult.sgdb = [{ ok: false, message: String(e) }];
      }
    }
  } else if (what === 'ra') {
    try {
      const message = await invoke('set_ra_account', { user: $('#setup-ra-user').value, key: $('#setup-ra-key').value, clear: false });
      setupResult.ra = [{ ok: true, message }];
    } catch (e) {
      setupResult.ra = [{ ok: false, message: String(e) }];
    }
    await loadProfiles();
    for (const id of Object.keys(raCache)) delete raCache[id];
  }
  renderSetup();
}

// The notice on top of the library while a key is missing.
function setupHintHtml() {
  if (!('has_steamgriddb' in settings) || !profiles || !setupMissing()) return '';
  try {
    const later = Number(localStorage.getItem(SETUP_SNOOZE) || 0);
    if (Date.now() - later < 3 * 86_400_000) return '';
  } catch { /* shown */ }
  const missing = [!settings.has_steamgriddb && 'as capas (SteamGridDB)', !raLinked() && 'as conquistas (RetroAchievements)'].filter(Boolean);
  return `
    <div><b>Deixe a sua biblioteca completa</b>
      <p class="muted">Falta pôr a chave grátis para ${missing.join(' e ')}. São uns minutos, uma vez só.</p></div>
    <div class="row"><button class="primary small" data-hint="open">Configurar agora</button>
      <button class="ghost small" data-hint="later">Agora não</button></div>`;
}

function renderSetupHint(show) {
  const el = $('#setup-hint');
  if (!el) return;
  const html = show ? setupHintHtml() : '';
  el.hidden = !html;
  el.innerHTML = html;
  el.querySelectorAll('[data-hint]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.hint === 'open') return openSetup();
    try { localStorage.setItem(SETUP_SNOOZE, String(Date.now())); } catch { /* shown again */ }
    renderSetupHint(false);
  }));
}

function tourSeen() {
  try { return localStorage.getItem(TOUR_SEEN) === '1'; } catch { return true; }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#tour').hidden) closeTour();
  else if (e.key === 'Escape' && !$('#setup').hidden) closeSetup();
});
$('#btn-setup').addEventListener('click', openSetup);

$('#btn-profile').addEventListener('click', () => (profiles ? whoOpen() : openProfiles()));
$('#btn-settings').addEventListener('click', async () => {
  settings = await call('get_settings');
  keyResults = null;
  backupSettings = await call('get_backup_settings');
  achSettings = await call('get_achievement_settings');
  openId = '__settings';
  render();
  fpsMessage = null;
  fpsStatus = await invoke('fps_status').catch(() => null);
  if (openId === '__settings') render();
  if (!pcInfo) {
    try { pcInfo = await invoke('get_pc_info', { refresh: false }); } catch { /* the box says it is loading */ }
    if (openId === '__settings') render();
  }
});

async function checkAppUpdate() {
  try {
    const u = await invoke('check_app_update');
    if (!u) return;
    const bar = $('#app-update');
    bar.innerHTML = `<span>Versão nova do Black Flag: <b>${esc(u.version)}</b></span><button class="primary">Baixar</button>`;
    bar.hidden = false;
    bar.querySelector('button').addEventListener('click', () => call('open_app_update', { url: u.url }));
  } catch { /* offline */ }
}

// Keeps "Jogando há …" current.
setInterval(() => {
  // Not on the covers page: it would erase addresses being typed.
  if (openId !== '__covers' && games.some((g) => g.status === 'running')) render();
}, 20000);

// Show the library at once, then ask GitHub for new versions in the background.
invoke('get_settings').then((s) => { settings = s; render(); coversInBackground(); }).catch(() => {});
checkAppUpdate();

refresh()
  .then(async () => {
    const pending = await invoke('take_pending_open');
    if (pending) openGame(pending);
    await loadProfiles();
    // A shortcut opening a game skips the question: it is already clear who is playing.
    if (!pending && profiles && profiles.ask_on_start && profiles.list.length > 1) whoOpen();
    else {
      if (!pending) profileReady();
      startingUp = false;
      if (!pending && !tourSeen()) openTour();
    }
  })
  .then(() => invoke('check_updates').then((list) => { games = list; render(); }).catch(() => {}));

// ---- Testar controle: buttons, sticks and triggers live (Gamepad API), battery (XInput) ----

// The controller is drawn here (no maker's art). Elements carry data-b = the button's index in
// the standard Gamepad mapping, so pressing lights them.
const PADTEST_LABELS = {
  xbox: ['A', 'B', 'X', 'Y'],
  playstation: ['✕', '○', '□', '△'],
  nintendo: ['B', 'A', 'Y', 'X'],
};
const PADTEST_EXIT = 1500;          // holding Back/B this long leaves the screen
let padtestOn = false;
let padtestStatus = null;           // get_pad_status
let padtestTimer = null;
let padtestBack = 0;                // when Back started being held
let padtestFam = null;
let padtestRumble = 0;

// LT/RT, which PAD_NAMES does not have.
function padNameFor(fam, which) {
  const more = { playstation: { lt: 'L2', rt: 'R2' }, nintendo: { lt: 'ZL', rt: 'ZR' }, xbox: { lt: 'LT', rt: 'RT' } };
  return (more[fam] && more[fam][which]) || PAD_NAMES[fam || 'xbox'][which];
}

function padtestSvg(fam) {
  const [a, b, x, y] = PADTEST_LABELS[fam] || PADTEST_LABELS.xbox;
  // PlayStation's symbols are drawn as shapes: as text, □ and ○ come out too small.
  const shapes = {
    '✕': (cx, cy) => `<path d="M${cx - 5} ${cy - 5}l10 10M${cx + 5} ${cy - 5}l-10 10"/>`,
    '○': (cx, cy) => `<circle cx="${cx}" cy="${cy}" r="5.5"/>`,
    '□': (cx, cy) => `<rect x="${cx - 5}" y="${cy - 5}" width="10" height="10"/>`,
    '△': (cx, cy) => `<path d="M${cx} ${cy - 6}l6 10.5h-12z"/>`,
  };
  const face = (i, cx, cy, t) => `<g data-b="${i}"><circle cx="${cx}" cy="${cy}" r="13"/>${shapes[t]
    ? `<g class="pt-shape">${shapes[t](cx, cy)}</g>` : `<text class="pt-face" x="${cx}" y="${cy + 5}">${t}</text>`}</g>`;
  const stick = (side, cx, cy, i) => `
    <g class="pt-stick" data-b="${i}"><circle cx="${cx}" cy="${cy}" r="30"/><circle class="pt-dead" cx="${cx}" cy="${cy}" r="4.5"/>
      <circle class="pt-dot" id="pt-${side}" cx="${cx}" cy="${cy}" r="12"/></g>`;
  const trigger = (side, x0) => `
    <g class="pt-trigger"><rect x="${x0}" y="6" width="76" height="22" rx="7"/><rect class="pt-fill" id="pt-${side}" x="${x0}" y="6" width="0" height="22" rx="7"/>
      <text x="${x0 + 38}" y="21.5">${esc(padNameFor(fam, side))}</text></g>`;
  return `
  <svg class="pt-pad" viewBox="0 0 480 300" role="img" aria-label="Desenho do controle; o que você aperta acende">
    ${trigger('lt', 92)}${trigger('rt', 312)}
    <g data-b="4"><rect x="86" y="36" width="88" height="16" rx="8"/><text x="130" y="48">${esc(padNameFor(fam, 'lb'))}</text></g>
    <g data-b="5"><rect x="306" y="36" width="88" height="16" rx="8"/><text x="350" y="48">${esc(padNameFor(fam, 'rb'))}</text></g>
    <path class="pt-body" d="M122 62H358c46 0 76 28 88 76l20 88c8 38-34 60-62 34l-50-46H136l-50 46c-28 26-70 4-62-34l20-88c12-48 42-76 78-76z"/>
    ${stick('ls', 150, 122, 10)}
    ${stick('rs', 292, 190, 11)}
    <g data-b="12"><rect x="179" y="160" width="18" height="22" rx="3"/></g>
    <g data-b="13"><rect x="179" y="198" width="18" height="22" rx="3"/></g>
    <g data-b="14"><rect x="158" y="181" width="22" height="18" rx="3"/></g>
    <g data-b="15"><rect x="196" y="181" width="22" height="18" rx="3"/></g>
    ${face(0, 332, 148, a)}${face(1, 360, 122, b)}${face(2, 304, 122, x)}${face(3, 332, 96, y)}
    <g data-b="8"><rect x="200" y="112" width="22" height="12" rx="6"/></g>
    <g data-b="9"><rect x="258" y="112" width="22" height="12" rx="6"/></g>
    <g data-b="16"><circle cx="240" cy="86" r="11"/></g>
  </svg>`;
}

const PADTEST_FAMILY = { xbox: 'Controle de Xbox (ou compatível)', playstation: 'Controle de PlayStation', nintendo: 'Controle Nintendo' };
const BATTERY_TEXT = ['acabando', 'fraca', 'média', 'cheia'];

function padtestBattery(p) {
  if (!p.wireless) return 'com fio';
  if (p.battery == null) return 'sem fio (não informa a bateria)';
  const bars = [0, 1, 2].map((i) => `<i${i < p.battery ? ' class="on"' : ''}></i>`).join('');
  return `<span class="pt-batt${p.battery <= 1 ? ' low' : ''}" aria-hidden="true">${bars}</span>bateria ${BATTERY_TEXT[p.battery]}`;
}

function padtestPadsHtml() {
  const s = padtestStatus;
  if (!s) return '<p class="muted">Lendo os controles…</p>';
  if (!s.pads.length) {
    return `<p class="muted">O Windows não vê nenhum controle de Xbox agora. Controles de PlayStation ligados direto não informam
      bateria nem queda; pelo Steam ou pelo DS4Windows, informam.</p>`;
  }
  return `<ul class="pt-list">${s.pads.map((p) => `<li><b>Controle ${p.number}</b><span>${padtestBattery(p)}</span></li>`).join('')}</ul>`;
}

function renderPadtest() {
  const s = padtestStatus;
  $('#padtest').innerHTML = `
    <div class="tour-card padtest-card" role="dialog" aria-modal="true" aria-labelledby="padtest-title" tabindex="-1">
      <h2 id="padtest-title">Testar controle</h2>
      <p class="pt-name" id="pt-name">Aperte qualquer botão do controle.</p>
      <div class="pt-stage" id="pt-stage">${padtestSvg(padtestFam || 'xbox')}</div>
      <div class="pt-read">
        <div><span class="muted">Analógico esquerdo</span><b id="pt-ls-v">0%</b></div>
        <div><span class="muted">Analógico direito</span><b id="pt-rs-v">0%</b></div>
        <div><span class="muted">Gatilhos</span><b id="pt-tr-v">0% e 0%</b></div>
      </div>
      <p class="muted pt-tip">Solte os analógicos: parados, devem ficar perto de 0%. Mais de 10% sem você tocar é folga.
        Apertar os gatilhos faz o controle vibrar.</p>
      <section class="setup-part">
        <h3>Conexão e bateria</h3>
        <div id="pt-pads">${padtestPadsHtml()}</div>
        <label class="check"><input type="checkbox" id="pt-alerts" ${!s || s.alerts ? 'checked' : ''}>
          Avisar por cima do jogo quando o controle cair ou a bateria ficar fraca</label>
        <div class="row"><button class="ghost small" id="pt-sample">Ver aviso de exemplo</button></div>
      </section>
      <div class="tour-nav">
        <div class="pt-exit" aria-hidden="true"><span id="pt-exit"></span></div>
        <div class="row">
          <span class="muted" id="pt-exit-hint">Segure <b>${esc(padName('back'))}</b> para sair</span>
          <span class="grow"></span>
          <button class="primary" id="pt-close">Fechar</button>
        </div>
      </div>
    </div>`;
  $('#pt-close').addEventListener('click', closePadtest);
  $('#pt-sample').addEventListener('click', () => {
    call('test_pad_notice').catch(() => {});
    toast('O aviso aparece no canto da tela, por cima do jogo.');
  });
  $('#pt-alerts').addEventListener('change', (e) => call('set_pad_alerts', { on: e.target.checked }).catch(() => {}));
}

async function padtestRefresh() {
  try { padtestStatus = await invoke('get_pad_status'); } catch { return; }
  const el = $('#pt-pads');
  if (el) el.innerHTML = padtestPadsHtml();
  const box = $('#pt-alerts');
  if (box) box.checked = padtestStatus.alerts;
}

function openPadtest() {
  closeMenus();
  padtestOn = true;
  padtestBack = 0;
  padtestFam = null;
  $('#padtest').hidden = false;
  renderPadtest();
  popIn($('#padtest'));
  $('#padtest .tour-card').focus();
  padtestRefresh();
  clearInterval(padtestTimer);
  padtestTimer = setInterval(padtestRefresh, 2000);
  requestAnimationFrame(padtestFrame);
}

function closePadtest() {
  padtestOn = false;
  clearInterval(padtestTimer);
  $('#padtest').hidden = true;
  // The press that closed it must not count on the page below.
  navPad.held = { back: true, ok: true };
}

// The controller moved last (each one has its own timestamp).
function padtestPad() {
  const pads = [...(navigator.getGamepads ? navigator.getGamepads() : [])].filter(Boolean);
  return pads.sort((p, q) => q.timestamp - p.timestamp)[0] || null;
}

function padtestFrame(t) {
  if (!padtestOn) return;
  requestAnimationFrame(padtestFrame);
  const pad = padtestPad();
  if (!pad) return;
  const fam = padFamily(pad);
  if (fam !== padtestFam) {
    padtestFam = fam;
    padKind = fam;
    $('#pt-stage').innerHTML = padtestSvg(fam);
    $('#pt-exit-hint').innerHTML = `Segure <b>${esc(padName('back'))}</b> para sair`;
    const many = navigator.getGamepads().filter(Boolean).length > 1;
    $('#pt-name').textContent = PADTEST_FAMILY[fam] + (many ? ', o último que você mexeu' : '');
  }
  const pressed = (i) => !!(pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > 0.1));
  $('#pt-stage').querySelectorAll('[data-b]').forEach((g) => g.classList.toggle('on', pressed(Number(g.dataset.b))));
  const stick = (side, x, y) => {
    $(`#pt-${side}`).style.transform = `translate(${(x * 20).toFixed(1)}px, ${(y * 20).toFixed(1)}px)`;
    const off = Math.min(100, Math.round(Math.hypot(x, y) * 100));
    const v = $(`#pt-${side}-v`);
    v.textContent = `${off}%`;
  };
  stick('ls', pad.axes[0] || 0, pad.axes[1] || 0);
  stick('rs', pad.axes[2] || 0, pad.axes[3] || 0);
  const lt = pad.buttons[6] ? pad.buttons[6].value : 0;
  const rt = pad.buttons[7] ? pad.buttons[7].value : 0;
  $('#pt-lt').setAttribute('width', (76 * lt).toFixed(1));
  $('#pt-rt').setAttribute('width', (76 * rt).toFixed(1));
  $('#pt-tr-v').textContent = `${Math.round(lt * 100)}% e ${Math.round(rt * 100)}%`;
  if ((lt > 0.05 || rt > 0.05) && t >= padtestRumble) {
    padtestRumble = t + 110;
    try {
      if (pad.vibrationActuator) pad.vibrationActuator.playEffect('dual-rumble', { duration: 140, strongMagnitude: lt, weakMagnitude: rt });
    } catch { /* no rumble */ }
  }
  // Leaving with the controller: hold Back, as every press here is a test.
  const back = pressed(fam === 'nintendo' ? 0 : 1);
  if (!back) padtestBack = 0;
  else if (!padtestBack) padtestBack = t;
  const held = padtestBack ? Math.min(1, (t - padtestBack) / PADTEST_EXIT) : 0;
  $('#pt-exit').style.width = `${held * 100}%`;
  if (held >= 1) closePadtest();
}

$('#btn-padtest').addEventListener('click', openPadtest);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && padtestOn) closePadtest();
});

// A controller that dropped or is low, told while Black Flag is on screen too.
listen('pad-alert', (e) => {
  toast(`${e.payload.title}. ${e.payload.description}`, e.payload.kind === 'pad');
  if (padtestOn) padtestRefresh();
});
