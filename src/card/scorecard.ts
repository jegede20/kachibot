/**
 * KACHIBOT share card — the house scorecard design, rendered to PNG.
 *
 * Layout is fixed (1200x675, measured off the house mockups):
 *   top-left   brand mark + KACHIBOT / SOLANASNIPERBOT wordmark
 *   left col   $TOKEN + verdict pill, headline %, multiple, trend chart,
 *              "<TOKEN> : <hold> held" and the tagline
 *   right col  one panel holding six labelled rows
 *
 * One template serves both cards:
 *   - the per-trade scorecard (history → 🏆 card #n)
 *   - the account-wide PnL card (🏆 PnL)
 * Only the values change; labels, order and geometry never do.
 *
 * Text only — no emoji, because the bundled display faces have no colour
 * glyphs and would render as tofu boxes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ------------------------------- geometry -------------------------------- */
/* every number below was measured off the two reference cards */

const W = 1200;
const H = 675;

const BRAND = { mark: { x: 72, y: 108, size: 82 }, name: { x: 174, y: 73, size: 40 }, tag: { x: 172, y: 113, size: 17, ls: 3.8 } };

/* token chip is a fixed slot; the verdict pill grows with its text */
const CHIP = { x: 48, y: 190, w: 131, h: 37 };
const TOKEN = { x: 66, baseline: 214, size: 16, maxWidth: 95 };
const PILL = { x: 190, y: 190, h: 37, baseline: 213, size: 16, minW: 101, padX: 20 };

const PCT = { x: 48, baseline: 334, size: 92 };
const MULT = { x: 48, baseline: 390, size: 54, stretch: 1.15 };

const CHART = { x: 48, right: 613, top: 425, bottom: 553 };

const FOOTER = { x: 49, baseline: 579, size: 15 };
const TAGLINE = { x: 49, baseline: 641, size: 15 };

const PANEL = { x: 700, y: 160, w: 452, h: 431, rx: 18 };
const ROW_LABEL_X = 729;
const ROW_VALUE_X = 1123;
const ROW_LABEL_SIZE = 19;
const ROW_VALUE_SIZE = 21;
const ROW_BASELINES = [238, 298, 355, 415, 475, 535];
const ROW_SEPARATORS = [190, 260, 320, 380, 440, 500];

/* -------------------------------- palette -------------------------------- */

const C = {
  bg: '#0d0d0d',
  panel: '#181816',
  panelEdge: '#2d2d2a',
  rowLine: '#2a2a27',
  label: '#8c8c87',
  value: '#f0f0ec',
  white: '#ffffff',
  footer: '#7a7a75',
  tagline: '#6f6f68',
  brand: '#13d370',
  bull: { ink: '#3ecf6e', pill: '#122e1c' },
  bear: { ink: '#e04a4a', pill: '#301414' },
};

const FONT_DISPLAY = 'Archivo Black';
const FONT_MULT = 'Bebas Neue';
const FONT_BODY = 'DejaVu Sans';

/* --------------------------------- model --------------------------------- */

export interface ScorecardRow {
  label: string;
  value: string;
}

export interface ScorecardModel {
  /** "$MOONK" for a trade, "OVERALL" for the account card */
  token: string;
  verdict: 'Bullish' | 'Bearish';
  /** shown after a dot: "Bearish · Rug" */
  qualifier?: string | null;
  /** "+417%" */
  pct: string;
  /** "5.2X" */
  multiple: string;
  trend: 'up' | 'down';
  /** exactly six rows are drawn, in order */
  rows: ScorecardRow[];
  /** "$MOONK : 2h 14m held" */
  footer: string;
  tagline?: string;
}

export const SCORECARD_TAGLINE = "Snipe with KACHIBOT—Solana's fastest Telegram copy-sniper";

/* ------------------------------- helpers --------------------------------- */

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const DASH = '—';

/** rough advance width so the pill can sit next to the token without overlap */
function estWidth(text: string, size: number, per: number): number {
  return text.length * size * per;
}

/** the six rows, always six, in the design's fixed order */
function six(rows: ScorecardRow[]): ScorecardRow[] {
  const out: ScorecardRow[] = [];
  for (let i = 0; i < ROW_BASELINES.length; i++) {
    out.push(rows[i] ?? { label: '', value: DASH });
  }
  return out;
}

function trendPath(trend: 'up' | 'down'): { line: string; area: string } {
  const { x: x0, right: x1, top: y0, bottom: y1 } = CHART;
  const span = x1 - x0;
  const pts: Array<[number, number]> = trend === 'up'
    ? [[0, 0.94], [0.16, 0.85], [0.32, 0.88], [0.48, 0.80], [0.62, 0.62], [0.75, 0.46], [0.87, 0.32], [1, 0.03]]
    : [[0, 0.34], [0.14, 0.20], [0.28, 0.11], [0.40, 0.03], [0.52, 0.16], [0.66, 0.42], [0.80, 0.68], [1, 0.94]];
  const p = pts.map(([fx, fy]) => `${(x0 + fx * span).toFixed(1)},${(y0 + fy * (y1 - y0)).toFixed(1)}`);
  return {
    line: `M ${p.join(' L ')}`,
    area: `M ${p.join(' L ')} L ${x1},${y1} L ${x0},${y1} Z`,
  };
}

/* ---------------------------------- svg ---------------------------------- */

export function scorecardSvg(m: ScorecardModel): string {
  const bull = m.verdict === 'Bullish';
  const accent = bull ? C.bull.ink : C.bear.ink;
  const pillBg = bull ? C.bull.pill : C.bear.pill;
  const pillText = m.qualifier ? `${m.verdict} · ${m.qualifier}` : m.verdict;

  // long tickers shrink to fit the chip; the pill grows around its own text
  let tokenSize = TOKEN.size;
  while (tokenSize > 10 && estWidth(m.token, tokenSize, 0.68) > TOKEN.maxWidth) tokenSize -= 1;
  const pillW = Math.round(Math.max(PILL.minW, estWidth(pillText, PILL.size, 0.55) + PILL.padX * 2));

  const { line, area } = trendPath(m.trend);
  const rows = six(m.rows);
  const tagline = m.tagline ?? SCORECARD_TAGLINE;

  const rowSvg = rows
    .map(
      (r, i) =>
        `<text x="${ROW_LABEL_X}" y="${ROW_BASELINES[i]}" font-family="${FONT_BODY}" font-size="${ROW_LABEL_SIZE}" fill="${C.label}">${esc(r.label)}</text>` +
        `<text x="${ROW_VALUE_X}" y="${ROW_BASELINES[i]}" text-anchor="end" font-family="${FONT_BODY}" font-size="${ROW_VALUE_SIZE}" font-weight="bold" fill="${C.value}">${esc(r.value)}</text>`,
    )
    .join('\n  ');

  const seps = ROW_SEPARATORS.map((y) => `<line x1="720" y1="${y}" x2="1132" y2="${y}" stroke="${C.rowLine}" stroke-width="1"/>`).join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${C.bg}"/>

  <!-- brand -->
  <text x="${BRAND.mark.x}" y="${BRAND.mark.y}" font-family="${FONT_DISPLAY}" font-size="${BRAND.mark.size}" fill="${C.brand}">K</text>
  <text x="${BRAND.name.x}" y="${BRAND.name.y}" font-family="${FONT_DISPLAY}" font-size="${BRAND.name.size}" letter-spacing="1" fill="${C.white}">KACHIBOT</text>
  <text x="${BRAND.tag.x}" y="${BRAND.tag.y}" font-family="${FONT_DISPLAY}" font-size="${BRAND.tag.size}" letter-spacing="${BRAND.tag.ls}" fill="${C.tagline}">SOLANASNIPERBOT</text>

  <!-- token chip + verdict pill -->
  <rect x="${CHIP.x}" y="${CHIP.y}" width="${CHIP.w}" height="${CHIP.h}" rx="${(CHIP.h / 2).toFixed(1)}" fill="${C.panel}"/>
  <text x="${TOKEN.x}" y="${TOKEN.baseline}" font-family="${FONT_BODY}" font-size="${tokenSize}" font-weight="bold" fill="${C.white}">${esc(m.token)}</text>
  <rect x="${PILL.x}" y="${PILL.y}" width="${pillW}" height="${PILL.h}" rx="${(PILL.h / 2).toFixed(1)}" fill="${pillBg}"/>
  <text x="${(PILL.x + pillW / 2).toFixed(1)}" y="${PILL.baseline}" text-anchor="middle" font-family="${FONT_BODY}" font-size="${PILL.size}" fill="${accent}">${esc(pillText)}</text>

  <!-- headline numbers -->
  <text x="${PCT.x}" y="${PCT.baseline}" font-family="${FONT_DISPLAY}" font-size="${PCT.size}" fill="${accent}">${esc(m.pct)}</text>
  <g transform="translate(${MULT.x},${MULT.baseline}) scale(${MULT.stretch},1)"><text x="0" y="0" font-family="${FONT_MULT}" font-size="${MULT.size}" fill="${C.white}">${esc(m.multiple)}</text></g>

  <!-- trend -->
  <path d="${area}" fill="url(#area)"/>
  <path d="${line}" fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>

  <!-- footer -->
  <text x="${FOOTER.x}" y="${FOOTER.baseline}" font-family="${FONT_BODY}" font-size="${FOOTER.size}" letter-spacing="0.5" fill="${C.footer}">${esc(m.footer)}</text>
  <text x="${TAGLINE.x}" y="${TAGLINE.baseline}" font-family="${FONT_BODY}" font-size="${TAGLINE.size}" fill="${C.tagline}">${esc(tagline)}</text>

  <!-- stats panel -->
  <rect x="${PANEL.x}" y="${PANEL.y}" width="${PANEL.w}" height="${PANEL.h}" rx="${PANEL.rx}" fill="${C.panel}" stroke="${C.panelEdge}" stroke-width="1.5"/>
  ${seps}
  ${rowSvg}
</svg>`;
}

/* -------------------------------- rendering ------------------------------ */

let fontsReady = false;

/**
 * Point fontconfig at the bundled faces. librsvg ignores @font-face entirely,
 * so without this a container with no system fonts would draw empty boxes.
 */
export function ensureCardFonts(): string | null {
  if (fontsReady) return process.env.FONTCONFIG_FILE ?? null;
  fontsReady = true;
  try {
    const dirs = [
      path.resolve(__dirname, '..', '..', 'assets', 'fonts'),
      path.resolve(process.cwd(), 'assets', 'fonts'),
    ].filter((d) => {
      try {
        return fs.existsSync(d) && fs.readdirSync(d).some((f) => f.toLowerCase().endsWith('.ttf'));
      } catch {
        return false;
      }
    });
    if (!dirs.length) return process.env.FONTCONFIG_FILE ?? null;
    const cache = path.join(os.tmpdir(), 'kachibot-fontcache');
    fs.mkdirSync(cache, { recursive: true });
    const conf = path.join(os.tmpdir(), 'kachibot-fonts.conf');
    const body =
      '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>' +
      '<include ignore_missing="yes">/etc/fonts/fonts.conf</include>' +
      dirs.map((d) => `<dir>${d}</dir>`).join('') +
      `<cachedir>${cache}</cachedir></fontconfig>`;
    fs.writeFileSync(conf, body);
    process.env.FONTCONFIG_FILE = conf;
    return conf;
  } catch {
    return process.env.FONTCONFIG_FILE ?? null;
  }
}

/** render the card to a PNG buffer; throws if sharp is unavailable */
export async function renderScorecard(m: ScorecardModel): Promise<Buffer> {
  ensureCardFonts();
  const sharp = (await import('sharp')).default;
  return sharp(Buffer.from(scorecardSvg(m))).png().toBuffer();
}
