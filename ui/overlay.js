const { invoke } = window.__TAURI__.core;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A short chime made here (no sound file from anyone else): two or three rising notes; a
// controller warning goes down instead.
function chime(complete, warn) {
  try {
    const ctx = new AudioContext();
    ctx.resume().catch(() => {});
    const notes = warn ? [659.25, 493.88] : complete ? [659.25, 783.99, 1046.5, 1318.5] : [783.99, 1174.66];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.11;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.55);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch { /* no audio device */ }
}

// A controller drawn here, for the controller notices.
const PAD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 7.5h9.6a4 4 0 0 1 3.9 3.2l.9 4.4a2.3 2.3 0 0 1-4 1.9l-2-2.3H8.4l-2 2.3a2.3 2.3 0 0 1-4-1.9l.9-4.4a4 4 0 0 1 3.9-3.2z"/><path d="M8.5 10v3M7 11.5h3"/><path d="M15.5 11h.01M17.5 12.5h.01"/></svg>';

async function show(n) {
  const card = document.getElementById('card');
  const pad = n.kind === 'pad' || n.kind === 'pad-ok';
  const label = pad ? 'Controle' : n.kind === 'complete' ? 'Jogo completo' : n.kind === 'test' ? 'Teste' : 'Conquista desbloqueada';
  card.className = 'card' + (n.kind === 'complete' || n.kind === 'pad-ok' ? ' complete' : n.kind === 'pad' ? ' warn' : '');
  card.innerHTML = `
    <div class="badge">${pad ? PAD_ICON : n.picture ? `<img src="${n.picture}" alt="">` : esc(n.badge || '🏆')}</div>
    <div>
      <div class="k">${label}${n.game ? ` · ${esc(n.game)}` : ''}</div>
      <div class="t">${esc(n.title)}</div>
      <div class="d">${esc(n.description)}</div>
    </div>
    ${n.points ? `<div class="p">${n.points} pts</div>` : ''}`;
  await sleep(30);
  card.classList.add('show');
  if (n.sound) chime(n.kind === 'complete', n.kind === 'pad');
  await sleep(5200);
  card.classList.remove('show');
  await sleep(450);
}

(async () => {
  let idle = 0;
  while (idle < 4) {
    const n = await invoke('take_overlay_notice').catch(() => null);
    if (n) { idle = 0; await show(n); } else { idle += 1; await sleep(400); }
  }
  window.__TAURI__.window.getCurrentWindow().close();
})();
