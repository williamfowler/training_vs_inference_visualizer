// screenshot.mjs — visual verification harness.
// Serves the site, loads it in headless Chromium, advances the sim clock to a
// requested time (and optionally a walkthrough step), saves a PNG.
//
// Usage:
//   node screenshot.mjs                                  # default suite
//   node screenshot.mjs --mode training --t 20 --out x.png
//   node screenshot.mjs --mode inference --t 5 --step 3  # tour step (1-based)
//   node screenshot.mjs --mode inference --t 30 --then-mode training --t2 15
//                                                        # mode switch (ghost)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serve(root) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const path = req.url.split('?')[0];
      const file = join(root, path === '/' ? 'index.html' : path);
      try {
        const data = await readFile(file);
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404); res.end('not found');
      }
    });
    srv.listen(0, () => resolve(srv));
  });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = val;
    }
  }
  return args;
}

async function capture(page, spec) {
  const { mode = 'inference', t = 0, step = null, thenMode = null, t2 = 0, out, debug, counts = null, model = null } = spec;
  await page.goto(BASE + (debug ? '?debug' : ''));
  await page.waitForFunction(() => window.__viz !== undefined);
  await page.evaluate(({ mode, t, step, thenMode, t2, counts, model }) => {
    const viz = window.__viz;
    viz.setPlaying(false);
    if (viz.state.mode !== mode) viz.setMode(mode);
    if (counts) viz.setCounts(counts);
    if (model) viz.setModelParams(Number(model));
    if (step !== null) {
      viz.walkthrough.show(step - 1);
      viz.state.playing = false;
    }
    viz.advance(t);
    if (thenMode) {
      viz.setMode(thenMode);
      viz.advance(t2);
    }
  }, { mode, t: Number(t), step: step !== null ? Number(step) : null, thenMode, t2: Number(t2), counts, model });
  await page.waitForTimeout(120);
  await page.screenshot({ path: `screenshots/${out}` });
  console.log(`✓ screenshots/${out}`);
}

const args = parseArgs(process.argv);
const server = await serve(process.cwd());
const BASE = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 952 } });
page.on('pageerror', (err) => console.error('PAGE ERROR:', err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.error('CONSOLE:', msg.text());
});

if (args.out) {
  // --counts "prefill=2,decode=5" or "replicas=6"
  let counts = null;
  if (typeof args.counts === 'string') {
    counts = {};
    for (const kv of args.counts.split(',')) {
      const [k, v] = kv.split('=');
      counts[k.trim()] = Number(v);
    }
  }
  await capture(page, {
    mode: args.mode, t: args.t ?? 0,
    step: args.step ?? null,
    thenMode: args['then-mode'] ?? null, t2: args.t2 ?? 0,
    out: args.out, debug: args.debug, counts,
    model: args.model ?? null,   // e.g. --model 1e12
  });
} else {
  // default suite
  const shots = [
    { mode: 'inference', t: 0.01, out: 'inference-static.png' },
    { mode: 'training', t: 0.01, out: 'training-static.png' },
    { mode: 'inference', t: 5, out: 'inference-t5.png' },
    { mode: 'inference', t: 20, out: 'inference-t20.png' },
    { mode: 'training', t: 20, out: 'training-t20.png' },
  ];
  for (const s of shots) await capture(page, s);
}

await browser.close();
server.close();
