// Writes the Black Flag mark: the gold flag with the V in its fly, the skull cut out of it,
// the controls as its eyes. One scale for the skull so its parts stay in proportion.
const fs = require('fs');
const out = process.argv[2];
const k = 1.16, cx = 200, cy = 252;
const P = (x, y) => [+(cx + (x - cx) * k).toFixed(1), +(cy + (y - cy) * k).toFixed(1)];
const pts = (list) => list.map(([x, y]) => P(x, y).join(' ')).join(' L');
const skull = [[150,146],[250,146],[276,186],[276,256],[254,282],[254,340],[240,356],[160,356],[146,340],[146,282],[124,256],[124,186]];
const rect = (x, y, w, h) => { const [a, b] = P(x, y); return `<rect x="${a}" y="${b}" width="${(w * k).toFixed(1)}" height="${(h * k).toFixed(1)}"/>`; };
const circ = (x, y, r) => { const [a, b] = P(x, y); return `<circle cx="${a}" cy="${b}" r="${(r * k).toFixed(1)}"/>`; };
const poly = (list) => `<path d="M${pts(list)} Z"/>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Black Flag">
  <!-- Black Flag. Built from the program's own mark: the gold flag with the V cut in its fly, in one
       flat gold. The skull is an opening cut out of the flag, so what is behind it shows through;
       inside it the controls are the eyes: the D-pad on the viewer's left, the four face buttons on
       the right, as they sit on a pad. Made by docs/logo/logo-gen.js. -->
  <path fill="#d9b45a" fill-rule="evenodd" d="M56 96 H456 L360 256 L456 416 H56 Z M${pts(skull)} Z"/>
  <g fill="#d9b45a">
    ${poly([[155,195],[173,195],[173,213],[191,213],[191,231],[173,231],[173,249],[155,249],[155,231],[137,231],[137,213],[155,213]])}
    ${circ(236,201,8.5)}
    ${circ(236,243,8.5)}
    ${circ(215,222,8.5)}
    ${circ(257,222,8.5)}
    ${poly([[200,258],[210,278],[190,278]])}
    ${rect(160,306,80,6)}
    ${rect(176,312,5,18)}
    ${rect(197.5,312,5,18)}
    ${rect(219,312,5,18)}
  </g>
</svg>
`;
fs.writeFileSync(out, svg);
