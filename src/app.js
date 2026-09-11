// Velque app: a test market across all three sessions.
// Day: a continuous book with a band around the reference. Dark: auction
// windows, one price per window. Cross: night orders clear at the open.
// Bundled by esbuild into site/app/app.js with web3.js, the client and clearing.
import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;

import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import * as V from 'velque-sdk/client';
import { replay } from 'velque-sdk/clearing';
import cfg from './config.json';

const conn = new Connection(cfg.rpc, 'confirmed');
// the market is selected with the ?m=TSLA parameter; defaults to the first one in the config
const MKTS = cfg.markets || [{ symbol: cfg.referenceSource.symbol, baseSymbol: cfg.baseSymbol, market: cfg.market, baseMint: cfg.baseMint,
  baseProg: cfg.baseProg, baseDecimals: cfg.baseDecimals, tick: cfg.tick, lot: cfg.lot, minNotional: cfg.minNotional }];
const M = MKTS.find((x) => x.symbol === new URLSearchParams(location.search).get('m')) || MKTS[0];
const SYM = M.baseSymbol;
const MARKET = new PublicKey(M.market);
const BASE = new PublicKey(M.baseMint);
const QUOTE = new PublicKey(cfg.quoteMint);
const BASE_PROG = new PublicKey(M.baseProg || V.TOKEN);
const QUOTE_PROG = new PublicKey(cfg.quoteProg || V.TOKEN);
const TICK = BigInt(M.tick);
const LOT = BigInt(M.lot);
const U = 1_000_000n; // quote (USDC)
const BDEC = M.baseDecimals ?? 6;
const BU = 10n ** BigInt(BDEC); // base: xStocks use 8 decimals
const MIN_NOTIONAL = BigInt(M.minNotional ?? 0);
const LOG_DEPTH = 8;

const $ = (id) => document.getElementById(id);
const baseAta = (w) => V.ata(w, BASE, BASE_PROG);
const quoteAta = (w) => V.ata(w, QUOTE, QUOTE_PROG);
const usd = (v) => '$' + (Number(v) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = (v) => (Number(v) / Number(BU)).toLocaleString('en-US', { maximumFractionDigits: 3 });
const quoteFmt = (v) => (Number(v) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 });
const short = (k) => k.slice(0, 4) + '…' + k.slice(-4);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clock = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
};
const human = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};

const state = {
  market: null, book: null, day: null, log: [], wallet: null, provider: null, bal: null,
  side: 0, tif: 0, clockSkew: 0, cranking: false, nextCrank: 0, verified: {},
};

// ---------------------------------------------------------------- wallet

function findProvider() {
  const w = window;
  return w.phantom?.solana || w.solflare || w.backpack || (w.solana?.connect ? w.solana : null);
}

async function connect() {
  const p = findProvider();
  if (!p) {
    say('No Solana wallet found. Install Phantom, Solflare or Backpack.', 'err');
    return;
  }
  try {
    const r = await p.connect();
    state.provider = p;
    state.wallet = new PublicKey((r?.publicKey || p.publicKey).toString());
    $('connect').textContent = short(state.wallet.toBase58());
    say('');
    await refresh();
  } catch (e) {
    say(e.message || 'Wallet connection was rejected.', 'err');
  }
}

