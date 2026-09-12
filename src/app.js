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

async function sendTx(ixs, label, units = 150_000) {
  const tx = new Transaction().add(V.computeLimit(units), ...ixs);
  tx.feePayer = state.wallet;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  say(`${label}: confirm in your wallet…`);
  const signed = await state.provider.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize());
  say(`${label}: sent, waiting for confirmation…`);
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  say(`${label}: done.`, 'ok');
  return sig;
}

function friendly(e) {
  const m = String(e?.message || e);
  const codes = {
    '0x3': 'Price must be a multiple of $0.01 and quantity a multiple of 0.001.',
    '0x4': 'This window just closed. Wait a moment for the next one.',
    '0x6': 'This book is full (64 orders). Try again in a moment.',
    '0xc': 'Nasdaq is open, so the market is on the day book now. Refreshing.',
    '0xd': 'The day session just ended. Orders go to the night auction now.',
    '0xe': 'That price is outside the band around the reference.',
    '0x11': `Minimum order is ${usd(MIN_NOTIONAL)}.`,
    '0x1': 'The window moved on. Refresh and try again.',
  };
  const code = m.match(/custom program error: (0x[0-9a-f]+)/i)?.[1]?.toLowerCase();
  if (code && codes[code]) return codes[code];
  if (m.includes('insufficient') || m.includes('0x1771') || m.includes('Attempt to debit')) return 'Not enough balance. Get test tokens first.';
  if (m.toLowerCase().includes('reject')) return 'Rejected in the wallet.';
  if (m.includes('blockhash') || m.includes('network')) return 'Your wallet may be on another network. Switch it to the Solana test network.';
  return m.slice(0, 200);
}

