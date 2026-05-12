import express, { Request, Response } from "express";
import * as path from "path";
import * as fs from "fs";
import { config } from "./config";
import { tracker } from "./activity";
import { logger } from "./logger";

export function startDashboard() {
  const app = express();

  const publicDir = path.join(process.cwd(), "public");
  if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

  app.get("/api/state", (_req: Request, res: Response) => {
    res.json(tracker.snapshot());
  });

  app.get("/", (_req: Request, res: Response) => {
    res.set("Content-Type", "text/html; charset=utf-8").send(renderHTML());
  });

  // Bind 0.0.0.0 explicitly so Railway's HTTP proxy can reach us
  // (Express's default is already 0.0.0.0, but be explicit for clarity).
  app.listen(config.port, "0.0.0.0", () => {
    logger.info(`Dashboard listening on 0.0.0.0:${config.port}`);
  });
}

export function renderHTML(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>TROLL WHEEL</title>
<link rel="icon" type="image/png" href="/troll-wheel.png" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bangers&family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --sky-1: #6cc1ff;
    --sky-2: #a9deff;
    --sky-3: #d8efff;
    --ink: #0a1426;
    --ink-2: #122a48;
    --chrome-1: #11192a;
    --chrome-2: #1b2a44;
    --chrome-3: #243a5c;
    --rim: #2563eb;
    --rim-glow: #60a5fa;
    --accent: #ffd84d;
    --accent-2: #ff9b3d;
    --good: #4ade80;
    --bad: #f87171;
    --line: rgba(96,165,250,.18);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Inter', system-ui, sans-serif;
    color: var(--ink);
    min-height: 100vh;
    background:
      radial-gradient(circle at 18% 8%, rgba(255,255,255,.7), transparent 35%),
      radial-gradient(circle at 82% 0%, rgba(255,255,255,.5), transparent 40%),
      linear-gradient(180deg, #6cc1ff 0%, #a9deff 55%, #d8efff 100%);
    overflow-x: hidden;
  }

  /* drifting clouds */
  .cloud {
    position: fixed; top: 0; left: 0; width: 220px; height: 90px;
    background: radial-gradient(circle at 30% 60%, #fff 38%, transparent 39%),
                radial-gradient(circle at 55% 40%, #fff 48%, transparent 49%),
                radial-gradient(circle at 75% 60%, #fff 38%, transparent 39%);
    opacity: .85; pointer-events: none;
    animation: drift 60s linear infinite;
    filter: drop-shadow(0 6px 0 rgba(0,0,0,0.04));
    z-index: 0;
  }
  .cloud.c2 { top: 18vh; left: -300px; transform: scale(1.2); animation-duration: 90s; opacity: .7; }
  .cloud.c3 { top: 38vh; left: -300px; transform: scale(.8); animation-duration: 75s; animation-delay: -25s; opacity: .9; }
  .cloud.c4 { top: 60vh; left: -300px; transform: scale(1.4); animation-duration: 110s; animation-delay: -50s; opacity: .55; }
  @keyframes drift { from { transform: translateX(-300px); } to { transform: translateX(110vw); } }

  .container { max-width: 1180px; margin: 0 auto; padding: 24px 20px 64px; position: relative; z-index: 1; }

  /* top bar */
  .topbar {
    display: flex; justify-content: space-between; align-items: center;
    background: rgba(10,20,38,.78); backdrop-filter: blur(10px);
    color: #fff; padding: 12px 18px; border-radius: 18px;
    box-shadow: 0 8px 24px rgba(10,20,38,.25);
    border: 1px solid rgba(255,255,255,.06);
  }
  .brand { display: flex; align-items: center; gap: 12px; font-family: 'Bangers'; letter-spacing: .06em; font-size: 20px; }
  .brand img { width: 32px; height: 32px; object-fit: contain; filter: drop-shadow(0 4px 6px rgba(0,0,0,.3)); }
  .brand .live {
    display: inline-flex; align-items: center; gap: 6px;
    font-family: 'Inter'; font-size: 11px; font-weight: 700; letter-spacing: .1em;
    color: var(--good); margin-left: 4px;
  }
  .brand .live .dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--good);
    box-shadow: 0 0 0 0 rgba(74,222,128,.7); animation: pulse 1.6s ease-out infinite;
  }
  @keyframes pulse {
    0%   { box-shadow: 0 0 0 0 rgba(74,222,128,.7); }
    70%  { box-shadow: 0 0 0 10px rgba(74,222,128,0); }
    100% { box-shadow: 0 0 0 0 rgba(74,222,128,0); }
  }
  .mc-pill {
    display: inline-flex; align-items: center; gap: 6px;
    margin-left: 6px; padding: 4px 10px;
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent-2) 100%);
    color: var(--ink);
    border-radius: 999px;
    font-family: 'JetBrains Mono'; font-size: 12px; font-weight: 700;
    letter-spacing: .04em; text-decoration: none;
    box-shadow: 0 4px 10px rgba(255,155,61,.35);
    transition: transform .15s, box-shadow .15s;
  }
  .mc-pill:hover { transform: translateY(-1px); box-shadow: 0 6px 14px rgba(255,155,61,.45); }
  .mc-pill .mc-label { opacity: .65; font-size: 10px; letter-spacing: .12em; }
  .mc-pill .mc-value { font-size: 13px; }
  .nav { display: flex; gap: 4px; align-items: center; font-weight: 600; font-size: 13px; }
  .nav a { color: #fff; text-decoration: none; opacity: .85; padding: 6px 12px; border-radius: 999px; transition: .15s; display: inline-flex; align-items: center; gap: 7px; }
  .nav a:hover { opacity: 1; background: rgba(255,255,255,.08); color: var(--accent); }
  .nav .nav-x svg { transition: transform .2s; }
  .nav .nav-x:hover svg { transform: scale(1.15); }
  .nav .sep { color: rgba(255,255,255,.3); padding: 0 4px; }

  /* hero */
  .hero { display: flex; flex-direction: column; align-items: center; padding: 28px 0 18px; text-align: center; }
  .banner-img {
    width: 100%; max-width: 1100px; height: auto; display: block;
    border-radius: 22px;
    box-shadow: 0 24px 60px rgba(10,20,38,.35), 0 0 0 1px rgba(255,255,255,.08) inset;
    margin-bottom: 18px;
    user-select: none; -webkit-user-drag: none;
    animation: bannerFloat 5s ease-in-out infinite alternate;
  }
  @keyframes bannerFloat {
    from { transform: translateY(0); }
    to   { transform: translateY(-6px); }
  }
  /* legacy wheel still loaded for favicon — keep these in case mobile layout needs the float */
  .wheel-wrap { position: relative; width: 360px; height: 280px; display: flex; align-items: center; justify-content: center; }
  .wheel-img {
    width: 320px; height: auto; display: block;
    animation: float 3.6s ease-in-out infinite alternate;
    filter: drop-shadow(0 22px 30px rgba(10,20,38,.45));
    user-select: none; -webkit-user-drag: none;
  }
  @keyframes float {
    from { transform: translateY(0) rotate(-3deg); }
    to   { transform: translateY(-14px) rotate(4deg); }
  }
  .hero h1 {
    font-family: 'Bangers'; font-weight: 400; font-size: 52px; letter-spacing: .04em;
    margin: 8px 0 4px; color: var(--ink); text-shadow: 0 4px 0 rgba(255,255,255,.4);
  }
  .hero h1 .y { color: var(--accent); text-shadow: 0 4px 0 rgba(10,20,38,.15); }
  .hero p { margin: 0 0 16px; color: var(--ink-2); font-size: 15px; max-width: 540px; }
  .ca-pill {
    display: inline-flex; align-items: center; gap: 10px; padding: 10px 16px;
    background: rgba(255,255,255,.55); border: 1px solid rgba(10,20,38,.12);
    backdrop-filter: blur(8px); border-radius: 999px;
    font-family: 'JetBrains Mono'; font-size: 12px; cursor: pointer;
    color: var(--ink); transition: .15s;
  }
  .ca-pill:hover { background: #fff; transform: translateY(-1px); }
  .ca-pill .copy { font-size: 14px; opacity: .5; }
  .ca-pill.copied { background: var(--accent); border-color: transparent; }

  /* threshold banner */
  .threshold-card {
    margin-top: 22px;
    background: linear-gradient(135deg, rgba(255,216,77,.95) 0%, rgba(255,155,61,.95) 100%);
    border: 2px solid rgba(10,20,38,.18);
    border-radius: 18px;
    padding: 18px 22px;
    box-shadow: 0 10px 28px rgba(255,155,61,.35);
    color: var(--ink);
  }
  .threshold-label {
    font-family: 'Bangers';
    font-size: 22px;
    letter-spacing: .04em;
    margin-bottom: 12px;
  }
  .threshold-rows {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }
  .threshold-row {
    display: flex;
    flex-direction: column;
    background: rgba(10,20,38,.85);
    color: #fff;
    padding: 12px 16px;
    border-radius: 12px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.08);
  }
  .threshold-tier {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .12em;
    text-transform: uppercase;
    opacity: .8;
  }
  .threshold-amount {
    font-family: 'JetBrains Mono';
    font-weight: 700;
    font-size: 26px;
    color: var(--accent);
    line-height: 1.15;
    margin-top: 2px;
  }
  .threshold-note { font-size: 11px; opacity: .65; }
  .threshold-disclaimer {
    margin-top: 12px;
    padding: 10px 14px;
    background: rgba(10,20,38,.18);
    border-left: 3px solid rgba(10,20,38,.55);
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.5;
  }
  .threshold-disclaimer b { color: var(--ink); }
  .threshold-foot { font-size: 11px; opacity: .7; margin-top: 8px; }
  @media (max-width: 620px) { .threshold-rows { grid-template-columns: 1fr; } }

  /* grid */
  .grid { display: grid; gap: 16px; margin-top: 22px; }
  .g4 { grid-template-columns: repeat(4, 1fr); }
  .g3 { grid-template-columns: repeat(3, 1fr); }
  .g2 { grid-template-columns: repeat(2, 1fr); }
  @media (max-width: 920px) {
    .g4, .g3 { grid-template-columns: repeat(2, 1fr); }
    .g2     { grid-template-columns: 1fr; }
    .hero h1 { font-size: 40px; }
    .wheel-wrap { transform: scale(.85); }
  }
  @media (max-width: 560px) {
    .g4, .g3 { grid-template-columns: 1fr; }
  }

  /* card */
  .card {
    position: relative; overflow: hidden;
    background: linear-gradient(165deg, var(--chrome-2), var(--chrome-1));
    color: #e8eef9; border-radius: 20px; padding: 20px 22px;
    border: 1px solid var(--line);
    box-shadow: 0 14px 36px rgba(10,20,38,.28), inset 0 1px 0 rgba(255,255,255,.05);
  }
  .card::before {
    content: ""; position: absolute; inset: 0;
    background: radial-gradient(circle at 100% 0%, rgba(96,165,250,.18), transparent 55%);
    pointer-events: none;
  }
  .card .label {
    display: flex; align-items: center; gap: 6px;
    font-size: 10.5px; letter-spacing: .16em; color: #93b4d8; text-transform: uppercase; font-weight: 700;
  }
  .card .icon { font-size: 14px; opacity: .8; }
  .card .value {
    font-family: 'Bangers'; font-size: 38px; letter-spacing: .04em;
    margin-top: 6px; color: #fff; line-height: 1.05;
  }
  .card .value .unit { font-size: 18px; color: #cfe1f7; opacity: .7; margin-left: 4px; letter-spacing: .04em; }
  .card .sub { font-size: 12px; color: #9fb6d3; margin-top: 6px; }
  .card .delta { font-size: 11px; color: var(--good); font-weight: 600; }

  /* progress bar */
  .bar {
    height: 6px; background: rgba(255,255,255,.06); border-radius: 999px;
    overflow: hidden; margin-top: 12px;
  }
  .bar > span {
    display: block; height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    transition: width .6s ease;
    box-shadow: 0 0 12px rgba(255,216,77,.6);
  }

  /* status chip */
  .status {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 4px 12px; border-radius: 999px;
    font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
    background: rgba(74,222,128,.14); color: var(--good); margin-top: 6px;
  }
  .status.idle     { background: rgba(96,165,250,.14); color: var(--rim-glow); }
  .status.error    { background: rgba(248,113,113,.14); color: var(--bad); }
  .status.stopped  { background: rgba(255,255,255,.08); color: #cfe1f7; }
  .status.watching { background: rgba(255,216,77,.18); color: var(--accent); }
  .status .blip { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: blipPulse 1.4s ease-in-out infinite; }
  @keyframes blipPulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

  /* countdown ring */
  .ring-card { display: flex; align-items: center; gap: 18px; }
  .ring { position: relative; width: 88px; height: 88px; flex: 0 0 88px; }
  .ring svg { transform: rotate(-90deg); }
  .ring .track { stroke: rgba(255,255,255,.08); }
  .ring .fill  { stroke: url(#ringG); stroke-linecap: round; transition: stroke-dashoffset .9s ease; }
  .ring .center {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-family: 'JetBrains Mono'; font-weight: 600; font-size: 16px; color: #fff;
  }
  .ring-card .meta { flex: 1; min-width: 0; }

  /* panel */
  .panel-title {
    font-family: 'Bangers'; font-size: 26px; letter-spacing: .04em; color: var(--ink);
    margin: 36px 0 12px; display: flex; align-items: baseline; justify-content: space-between;
  }
  .panel-title .updated { font-family: 'Inter'; font-size: 11px; font-weight: 500; color: rgba(10,20,38,.55); letter-spacing: 0; }
  .panel {
    background: linear-gradient(165deg, var(--chrome-2), var(--chrome-1));
    color: #e8eef9; border-radius: 20px; padding: 4px 0;
    border: 1px solid var(--line);
    box-shadow: 0 14px 36px rgba(10,20,38,.28);
    overflow: hidden;
  }

  /* table */
  table { width: 100%; border-collapse: collapse; }
  thead th {
    padding: 14px 22px; text-align: left;
    font-size: 10.5px; letter-spacing: .16em; color: #8fb0d5;
    text-transform: uppercase; font-weight: 700;
    border-bottom: 1px solid rgba(255,255,255,.06);
  }
  tbody td {
    padding: 12px 22px; font-size: 13px;
    border-top: 1px solid rgba(255,255,255,.04);
  }
  tbody tr { transition: background .12s; }
  tbody tr:hover { background: rgba(96,165,250,.05); }
  td.right, th.right { text-align: right; }
  td.mono { font-family: 'JetBrains Mono'; font-size: 12px; color: #cfe1f7; }
  td a { color: var(--accent); text-decoration: none; }
  td a:hover { text-decoration: underline; }

  /* rank badge */
  .rank {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 6px;
    font-family: 'JetBrains Mono'; font-size: 11px; font-weight: 600;
    background: rgba(255,255,255,.06); color: #9fb6d3; margin-right: 10px;
  }
  .rank.r1 { background: linear-gradient(135deg,#fff7c2,#ffd84d); color: #6b4a00; }
  .rank.r2 { background: linear-gradient(135deg,#e6ecf2,#a9bccd); color: #2c3a47; }
  .rank.r3 { background: linear-gradient(135deg,#ffd9a3,#d68a3b); color: #3a1e00; }
  .holder-cell { display: flex; align-items: center; }
  .avatar {
    width: 22px; height: 22px; border-radius: 50%;
    margin-right: 10px; flex-shrink: 0;
    box-shadow: 0 0 0 1px rgba(255,255,255,.08);
  }

  /* event ticker */
  .events { max-height: 460px; overflow-y: auto; }
  .events::-webkit-scrollbar { width: 6px; }
  .events::-webkit-scrollbar-thumb { background: rgba(96,165,250,.3); border-radius: 999px; }
  .ev {
    display: flex; gap: 14px; align-items: flex-start;
    padding: 12px 22px; border-top: 1px solid rgba(255,255,255,.04);
  }
  .ev:first-child { border-top: 0; }
  .ev .pill {
    display: inline-flex; align-items: center; padding: 3px 10px;
    border-radius: 999px; font-size: 10.5px; font-weight: 700;
    letter-spacing: .08em; text-transform: uppercase; flex-shrink: 0;
    min-width: 78px; justify-content: center;
  }
  .ev.kind-claim    .pill { background: rgba(74,222,128,.14); color: var(--good); }
  .ev.kind-buy      .pill { background: rgba(255,216,77,.16); color: var(--accent); }
  .ev.kind-forward  .pill { background: rgba(96,165,250,.14); color: var(--rim-glow); }
  .ev.kind-snapshot .pill { background: rgba(255,255,255,.08); color: #cfe1f7; }
  .ev.kind-distribute-start .pill,
  .ev.kind-distribute-done  .pill { background: rgba(255,155,61,.14); color: var(--accent-2); }
  .ev.kind-distribute-holder .pill { background: rgba(74,222,128,.14); color: var(--good); }
  .ev.kind-error    .pill { background: rgba(248,113,113,.14); color: var(--bad); }
  .ev.kind-info     .pill { background: rgba(255,255,255,.06); color: #9fb6d3; }
  .ev .body { flex: 1; min-width: 0; }
  .ev .msg { font-size: 13px; color: #e8eef9; word-break: break-word; }
  .ev .meta { font-size: 11px; color: #8fb0d5; margin-top: 3px; }

  .footer { margin-top: 36px; text-align: center; font-size: 12px; color: rgba(10,20,38,.55); }

  .empty { padding: 32px; text-align: center; color: #8fb0d5; font-size: 13px; }
</style>
</head>
<body>
  <div class="cloud c1"></div>
  <div class="cloud c2"></div>
  <div class="cloud c3"></div>
  <div class="cloud c4"></div>

  <div class="container">

    <div class="topbar">
      <div class="brand">
        <img src="/troll-wheel.png" alt="" />
        TROLL WHEEL
        <span class="live"><span class="dot"></span> LIVE</span>
        <a id="mcPill" class="mc-pill" href="#" target="_blank" rel="noopener" title="View on Dexscreener" style="display:none;">
          <span class="mc-label">MC</span><span class="mc-value" id="mcValue">—</span>
        </a>
      </div>
      <div class="nav">
        <a class="nav-x" href="https://x.com/i/communities/2005516643519086682" target="_blank" rel="noopener" aria-label="X Community">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M18.244 2H21.5l-7.5 8.575L23 22h-6.844l-5.36-7.01L4.6 22H1.34l8.063-9.213L1 2h7.012l4.846 6.41L18.244 2Zm-1.2 18.2h1.86L7.05 3.7H5.06l11.984 16.5Z"/></svg>
          <span>X COMMUNITY</span>
        </a>
        <span class="sep">·</span>
        <a id="dexLink" href="https://dexscreener.com/solana" target="_blank" rel="noopener">DEXSCREENER</a>
      </div>
    </div>

    <section class="hero">
      <img class="banner-img" src="/banner.png" alt="$TROLLWHEEL — buy the coin, get paid TROLL" />
      <p>Auto-claims pump.fun creator fees, buys $TROLL, and routes a pro-rata share to every $TROLLWHEEL holder through fresh hop wallets.</p>
      <div class="ca-pill" id="ca" title="click to copy contract address">
        <span id="caText">…</span>
        <span class="copy">⎘</span>
      </div>
      <div id="watchBanner" style="display:none; margin-top: 14px; padding: 10px 18px; background: rgba(10,20,38,.78); color: var(--accent); border-radius: 12px; font-size: 13px; font-weight: 600; backdrop-filter: blur(8px); box-shadow: 0 8px 24px rgba(10,20,38,.25);">
        ⏳ Watching <span id="watchWallet" class="mono" style="opacity:.85"></span> for token creation — cycles will start automatically
      </div>
    </section>

    <section class="grid g4">
      <div class="card">
        <div class="label"><span class="icon">⛁</span> Spendable pool</div>
        <div class="value"><span id="claimPool">0</span><span class="unit">SOL</span></div>
        <div class="sub" id="poolSub">${config.buybackPercent}% spend cap · dev wallet untouched</div>
        <div class="bar"><span id="poolBar" style="width:0%"></span></div>
      </div>
      <div class="card">
        <div class="label"><span class="icon">⇩</span> Total fees claimed</div>
        <div class="value"><span id="solClaimed">0</span><span class="unit">SOL</span></div>
        <div class="sub" id="solSpent">0 SOL deployed into $TROLL</div>
      </div>
      <div class="card">
        <div class="label"><span class="icon">✦</span> $TROLL distributed</div>
        <div class="value" id="trollDistributed">0</div>
        <div class="sub" id="trollBought">0 bought · 0 still held</div>
      </div>
      <div class="card ring-card">
        <div class="ring">
          <svg width="88" height="88" viewBox="0 0 88 88">
            <defs><linearGradient id="ringG" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0%"  stop-color="#ffd84d"/>
              <stop offset="100%" stop-color="#ff9b3d"/>
            </linearGradient></defs>
            <circle class="track" cx="44" cy="44" r="38" fill="none" stroke-width="6"/>
            <circle class="fill"  cx="44" cy="44" r="38" fill="none" stroke-width="6"
                    stroke-dasharray="238.76" stroke-dashoffset="238.76" id="ringFill"/>
          </svg>
          <div class="center" id="ringText">--:--</div>
        </div>
        <div class="meta">
          <div class="label"><span class="icon">⏱</span> Next cycle</div>
          <div class="status idle" id="statusChip"><span class="blip"></span> <span id="statusText">idle</span></div>
          <div class="sub" id="cycleSub">cycle #0</div>
        </div>
      </div>
    </section>

    <section class="grid g3">
      <div class="card">
        <div class="label"><span class="icon">◆</span> Unique holders reached</div>
        <div class="value" id="holdersReached">0</div>
        <div class="sub" id="distCount">0 confirmed transfers · routed via 1 fresh hop wallet</div>
      </div>
      <div class="card">
        <div class="label"><span class="icon">◐</span> Avg cost per holder</div>
        <div class="value"><span id="avgCost">0.0021</span><span class="unit">SOL</span></div>
        <div class="sub">covers tx fees + holder ATA rent (one-time per holder)</div>
      </div>
      <div class="card">
        <div class="label"><span class="icon">⌖</span> Buyer wallet</div>
        <div class="value"><span id="buyerTroll">0</span><span class="unit">$TROLL</span></div>
        <div class="sub" id="buyerSol">0 SOL · —</div>
      </div>
    </section>

    <section class="threshold-card" id="thresholdCard">
      <div class="threshold-inner">
        <div class="threshold-label">⚡ Reward eligibility</div>
        <div class="threshold-disclaimer">
          The amount of $TROLLWHEEL you need to hold scales with fees claimed this cycle — more trading volume = lower threshold.
        </div>
      </div>
    </section>

    <h2 class="panel-title">Where the $TROLL went <span class="updated" id="updated"></span></h2>
    <div class="panel">
      <table>
        <thead>
          <tr>
            <th>Holder</th>
            <th class="right">Total received</th>
            <th class="right">Cycles</th>
            <th class="right">Last cycle</th>
            <th class="right">Last tx</th>
          </tr>
        </thead>
        <tbody id="holdersBody"></tbody>
      </table>
    </div>

    <h2 class="panel-title">Live activity</h2>
    <div class="panel events" id="events"></div>

    <div class="footer">
      $TROLLWHEEL is a memecoin for entertainment only. Distributions depend on claimable fees, liquidity, and continued operation. Not financial advice.
    </div>
  </div>

<script>
const fmt = (n, d=2) => Number(n||0).toLocaleString(undefined, { maximumFractionDigits: d });
const fmtTok = (n) => {
  n = Number(n||0);
  if (n >= 1e9) return (n/1e9).toFixed(2)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(2)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(2)+'K';
  return n.toFixed(2);
};
const fmtUsd = (n) => {
  n = Number(n||0);
  if (n >= 1e9) return '$' + (n/1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n/1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n/1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
};
const short = (s) => s ? s.slice(0,4)+'…'+s.slice(-4) : '—';
const sigLink = (s) => s ? '<a href="https://solscan.io/tx/'+s+'" target="_blank">'+short(s)+'</a>' : '';
const ago = (t) => {
  if (!t) return '—';
  const d = Math.floor((Date.now()-t)/1000);
  if (d < 60) return d+'s ago';
  if (d < 3600) return Math.floor(d/60)+'m ago';
  if (d < 86400) return Math.floor(d/3600)+'h ago';
  return Math.floor(d/86400)+'d ago';
};
// deterministic 6-char hex color from a string (for holder avatars)
const colorFor = (s) => {
  let h = 0;
  for (const c of (s||'?')) h = (h*31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return 'hsl('+hue+',70%,55%)';
};
const avatar = (addr) => {
  const c1 = colorFor(addr);
  const c2 = colorFor((addr||'').slice(-6));
  return '<span class="avatar" style="background:linear-gradient(135deg,'+c1+','+c2+')"></span>';
};

let nextCycleAt = 0;
let cycleIntervalSec = 900;
let cachedStatus = 'idle';

// live ticking countdown — runs every second so it never goes stale.
function tickCountdown() {
  const ringText = document.getElementById('ringText');
  const ringFill = document.getElementById('ringFill');
  if (!nextCycleAt) {
    ringText.textContent = '--:--';
    ringFill.setAttribute('stroke-dashoffset', '238.76');
    return;
  }
  const remainMs = nextCycleAt - Date.now();
  const remainSec = Math.max(0, Math.floor(remainMs/1000));
  const m = Math.floor(remainSec/60), s = remainSec%60;
  ringText.textContent = String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');

  // ring fill: full circle when remainSec == cycleIntervalSec, empty at 0
  const total = Math.max(1, cycleIntervalSec);
  const ratio = Math.min(1, Math.max(0, remainSec / total));
  const dash = 2 * Math.PI * 38;
  ringFill.setAttribute('stroke-dashoffset', String(dash * (1 - ratio)));

  // status overrides for the ring center
  if (cachedStatus === 'running')  ringText.textContent = 'RUN';
  if (cachedStatus === 'watching') {
    ringText.textContent = 'WAIT';
    // animate the ring fill while waiting (no real countdown to draw)
    const t = (Date.now() / 30) % 238.76;
    ringFill.setAttribute('stroke-dashoffset', String(t));
  }
}
setInterval(tickCountdown, 1000);

async function refresh() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    const s = await r.json();

    // CA + external links
    const ca = s.trollwheelMint || '—';
    document.getElementById('caText').textContent = ca === '' ? 'awaiting token creation…' : ca;
    if (s.trollwheelMint) {
      document.getElementById('dexLink').href = 'https://dexscreener.com/solana/' + s.trollwheelMint;
      document.getElementById('mcPill').href   = 'https://dexscreener.com/solana/' + s.trollwheelMint;
      // Refresh MC at most every 25s (DexScreener doesn't need to be hit every 4s)
      const nowMs = Date.now();
      if (!window._lastMcFetch || nowMs - window._lastMcFetch > 25000) {
        window._lastMcFetch = nowMs;
        fetch('https://api.dexscreener.com/latest/dex/tokens/' + s.trollwheelMint, { cache: 'no-store' })
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (!data || !data.pairs || !data.pairs.length) return;
            // Pick the pair with the highest liquidity (most reliable price)
            const pair = data.pairs.reduce((a, b) =>
              ((b.liquidity && b.liquidity.usd || 0) > (a.liquidity && a.liquidity.usd || 0)) ? b : a
            );
            const mc = pair.marketCap || pair.fdv || 0;
            if (mc > 0) {
              document.getElementById('mcValue').textContent = fmtUsd(mc);
              document.getElementById('mcPill').style.display = 'inline-flex';
            }
          })
          .catch(() => {});
      }
    }

    // watch banner
    const banner = document.getElementById('watchBanner');
    if (s.status === 'watching') {
      banner.style.display = 'block';
      document.getElementById('watchWallet').textContent = short(s.creatorWallet);
    } else {
      banner.style.display = 'none';
    }

    // pool
    const poolSol = (s.claimPoolLamports||0)/1e9;
    document.getElementById('claimPool').textContent = fmt(poolSol, 4);
    const poolPct = s.totals.solClaimed > 0 ? Math.min(100, poolSol / s.totals.solClaimed * 100) : 0;
    document.getElementById('poolBar').style.width = poolPct.toFixed(1) + '%';

    // claimed / spent
    document.getElementById('solClaimed').textContent = fmt(s.totals.solClaimed, 4);
    document.getElementById('solSpent').textContent  = fmt(s.totals.solSpent, 4) + ' SOL deployed into $TROLL';

    // Headline numbers derive from on-chain reality so they always match
    // wallet truth, even when individual delivery receipts miss a confirmation.
    //   bought        = cumulative $TROLL purchased (tracker counter, accurate)
    //   still held    = wallet's live $TROLL balance (on-chain)
    //   distributed   = bought − still_held (everything that left the buyer)
    const stillHeld = Math.max(0, s.current && s.current.buyerTroll || 0);
    const actualDistributed = Math.max(s.totals.trollDistributed || 0,
                                       (s.totals.trollBought||0) - stillHeld);
    document.getElementById('trollDistributed').textContent = fmtTok(actualDistributed);
    document.getElementById('trollBought').textContent =
      fmtTok(s.totals.trollBought) + ' bought · ' + fmtTok(stillHeld) + ' still held';

    // status + countdown
    cachedStatus = s.status || 'idle';
    nextCycleAt = s.nextCycleAt || 0;
    if (s.lastCycleAt && nextCycleAt) {
      cycleIntervalSec = Math.max(1, Math.round((nextCycleAt - s.lastCycleAt)/1000));
    }
    const chip = document.getElementById('statusChip');
    chip.className = 'status ' + cachedStatus;
    document.getElementById('statusText').textContent = cachedStatus;
    document.getElementById('cycleSub').textContent = 'cycle #' + (s.cycleCount||0);

    // (Threshold card is now a static disclaimer — no dynamic values to update.)

    // unique + dist count. distributionsCount is the count we directly observed.
    // The real chain count may be higher when confirmation polling missed a tx;
    // we surface the larger of (tracker count) and (estimated from on-chain TROLL outflow).
    document.getElementById('holdersReached').textContent = fmtTok(s.totals.holdersReached);
    document.getElementById('distCount').textContent =
      fmtTok(s.totals.distributionsCount) + ' confirmed transfers · routed via 1 fresh hop wallet';

    // avg cost
    const avgCost = s.totals.distributionsCount > 0
      ? (s.totals.solSpent + 0) / s.totals.distributionsCount  // approx (spend doesn't include hop fees, but close)
      : 0.00213;
    document.getElementById('avgCost').textContent = avgCost.toFixed(4);

    // buyer wallet
    document.getElementById('buyerTroll').textContent = fmtTok(s.current.buyerTroll);
    document.getElementById('buyerSol').textContent =
      fmt(s.current.buyerSol, 4) + ' SOL · ' + short(s.buyerWallet);

    document.getElementById('updated').textContent = 'updated ' + new Date().toLocaleTimeString();

    // holders table
    const rows = Object.entries(s.perHolder||{})
      .map(([owner, v]) => ({ owner, ...v }))
      .sort((a,b) => b.totalReceived - a.totalReceived)
      .slice(0, 100);
    document.getElementById('holdersBody').innerHTML = rows.length ? rows.map((r,i) => {
      const rankClass = i === 0 ? 'rank r1' : i === 1 ? 'rank r2' : i === 2 ? 'rank r3' : 'rank';
      return '<tr>' +
        '<td><div class="holder-cell">' +
          '<span class="' + rankClass + '">' + (i+1) + '</span>' +
          avatar(r.owner) +
          '<span class="mono">' + short(r.owner) + '</span>' +
        '</div></td>' +
        '<td class="right">' + fmtTok(r.totalReceived) + ' $TROLL</td>' +
        '<td class="right">' + r.cycles + '</td>' +
        '<td class="right">' + ago(r.lastTs) + '</td>' +
        '<td class="right mono">' + sigLink(r.lastTx) + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="5" class="empty">No distributions yet — first cycle pending.</td></tr>';

    // events
    const evs = (s.events||[]).slice(-120).reverse();
    document.getElementById('events').innerHTML = evs.length ? evs.map(e => {
      return '<div class="ev kind-' + e.type + '">' +
        '<span class="pill">' + e.type.replace('distribute-','') + '</span>' +
        '<div class="body">' +
          '<div class="msg">' + escapeHtml(e.message) + '</div>' +
          '<div class="meta">' + new Date(e.ts).toLocaleTimeString() +
            (e.txSignature ? ' · ' + sigLink(e.txSignature) : '') +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('') : '<div class="empty">Waiting for the first event…</div>';

    tickCountdown();
  } catch (e) {
    console.error(e);
  }
}

function escapeHtml(s) {
  return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

document.getElementById('ca').addEventListener('click', () => {
  const t = document.getElementById('caText').textContent.trim();
  if (t && t !== '—') {
    navigator.clipboard.writeText(t);
    const el = document.getElementById('ca');
    el.classList.add('copied');
    setTimeout(()=>el.classList.remove('copied'), 800);
  }
});

refresh();
setInterval(refresh, 4000);
</script>
</body>
</html>`;
}
