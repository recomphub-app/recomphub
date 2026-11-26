// The game pages' few moving parts: the featured banner turns every few seconds, the rows get
// arrows, and Todos os jogos filters its cards. Everything here is optional: without it the
// pages show every game and every link works.
(() => {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- The featured banner ----
  const hero = document.querySelector('.hero-carousel');
  if (hero) {
    const slides = [...hero.querySelectorAll('.slide')];
    const dots = [...hero.querySelectorAll('.dots button')];
    let cur = 0;
    let timer = null;
    const show = (i) => {
      cur = (i + slides.length) % slides.length;
      slides.forEach((s, k) => {
        s.classList.toggle('on', k === cur);
        s.setAttribute('aria-hidden', k === cur ? 'false' : 'true');
        s.tabIndex = k === cur ? 0 : -1;
      });
      dots.forEach((d, k) => {
        d.setAttribute('aria-selected', String(k === cur));
        // Restart the gold line under the chosen dot.
        const bar = d.querySelector('span');
        bar.style.animation = 'none';
        void bar.offsetWidth;
        bar.style.animation = '';
      });
    };
    const start = () => {
      clearInterval(timer);
      if (!calm && slides.length > 1) timer = setInterval(() => show(cur + 1), 6000);
    };
    dots.forEach((d) => d.addEventListener('click', () => { show(Number(d.dataset.go)); start(); }));
    hero.addEventListener('mouseenter', () => { clearInterval(timer); hero.classList.add('paused'); });
    hero.addEventListener('mouseleave', () => { hero.classList.remove('paused'); start(); });
    hero.addEventListener('focusin', () => clearInterval(timer));
    document.addEventListener('visibilitychange', () => (document.hidden ? clearInterval(timer) : start()));
    start();
  }

  // ---- Row arrows: shown when the row is wider than the page ----
  document.querySelectorAll('.shelf-row').forEach((row) => {
    const track = row.querySelector('.row-track');
    const arrows = row.querySelector('.row-arrows');
    const [back, fwd] = row.querySelectorAll('.arrow');
    const sync = () => {
      const wide = track.scrollWidth > track.clientWidth + 4;
      arrows.hidden = !wide;
      back.disabled = track.scrollLeft < 4;
      fwd.disabled = track.scrollLeft + track.clientWidth > track.scrollWidth - 4;
    };
    [back, fwd].forEach((b) => b.addEventListener('click', () => {
      track.scrollBy({ left: Number(b.dataset.dir) * track.clientWidth * 0.85, behavior: calm ? 'auto' : 'smooth' });
    }));
    track.addEventListener('scroll', sync, { passive: true });
    addEventListener('resize', sync);
    sync();
  });

  // ---- Todos os jogos: search, console, verified, order ----
  const grid = document.getElementById('grid');
  if (grid) {
    const cards = [...grid.querySelectorAll('.gcard')];
    const q = document.getElementById('q');
    const sort = document.getElementById('sort');
    const more = document.getElementById('more-console');
    const onlyVerified = document.getElementById('only-verified');
    const chips = [...document.querySelectorAll('.fchip[data-console]')];
    const shown = document.getElementById('shown');
    const empty = document.getElementById('empty');
    const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, '');
    const params = new URLSearchParams(location.search);
    let consoleWanted = params.get('console') || '';
    const order = { alta: 'trend', estrelas: 'stars', atualizados: 'pushed', novos: 'created' };
    if (order[params.get('ordem')] || params.get('ordem') === 'nome') sort.value = params.get('ordem');

    const apply = () => {
      const words = plain(q.value).split(/\s+/).filter(Boolean).map((w) => w.replace(/ /g, ''));
      let n = 0;
      for (const c of cards) {
        const ok = (!consoleWanted || c.dataset.console === consoleWanted)
          && (onlyVerified.getAttribute('aria-pressed') !== 'true' || c.dataset.verified === '1')
          && words.every((w) => c.dataset.name.includes(w));
        c.hidden = !ok;
        if (ok) n++;
      }
      shown.textContent = n;
      empty.hidden = n > 0;
      chips.forEach((ch) => ch.classList.toggle('on', ch.dataset.console === consoleWanted));
      if (more) more.value = chips.some((ch) => ch.dataset.console === consoleWanted) ? '' : consoleWanted;
      const url = new URL(location.href);
      consoleWanted ? url.searchParams.set('console', consoleWanted) : url.searchParams.delete('console');
      sort.value !== 'alta' ? url.searchParams.set('ordem', sort.value) : url.searchParams.delete('ordem');
      history.replaceState(null, '', url);
    };
    const reorder = () => {
      const key = order[sort.value];
      const sorted = [...cards].sort((a, b) => (key
        ? Number(b.dataset[key]) - Number(a.dataset[key])
        : a.querySelector('.gc-name').textContent.localeCompare(b.querySelector('.gc-name').textContent, 'pt-BR')));
      grid.append(...sorted);
    };
    q.addEventListener('input', apply);
    sort.addEventListener('change', () => { reorder(); apply(); });
    chips.forEach((ch) => ch.addEventListener('click', () => { consoleWanted = ch.dataset.console; apply(); }));
    if (more) more.addEventListener('change', () => { consoleWanted = more.value; apply(); });
    onlyVerified.addEventListener('click', () => {
      onlyVerified.setAttribute('aria-pressed', String(onlyVerified.getAttribute('aria-pressed') !== 'true'));
      apply();
    });
    reorder();
    apply();
  }
})();
