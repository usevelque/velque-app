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

// ---------------------------------------------------------------- data

async function chainClock() {
  try {
    const slot = await conn.getSlot();
    const t = await conn.getBlockTime(slot);
    if (t) state.clockSkew = t - Math.floor(Date.now() / 1000);
  } catch { /* the chain clock is not critical */ }
}
const chainNow = () => Math.floor(Date.now() / 1000) + state.clockSkew;

async function loadLog(mk) {
  const ids = [];
  for (let i = 1n; i <= BigInt(LOG_DEPTH) && mk.auctionId - i >= 0n; i++) ids.push(mk.auctionId - i);
  const keys = ids.map((id) => V.bookPda(MARKET, id));
  const infos = await conn.getMultipleAccountsInfo(keys);
  const books = [];
  for (let i = 0; i < ids.length; i++) {
    if (!infos[i]) continue;
    const b = await V.readBook({ getAccountInfo: async () => infos[i] }, keys[i]);
    if (b?.cleared) books.push(b);
  }
  return books;
}

async function refresh() {
  try {
    const mk = await V.readMarket(conn, MARKET);
    state.market = mk;
    // ScaledUiAmount multiplier: how many shares one token holds
    state.multiplier = V.scaledMultiplier((await conn.getAccountInfo(BASE))?.data, chainNow());
    [state.book, state.day, state.log] = await Promise.all([
      V.readBook(conn, V.bookPda(MARKET, mk.auctionId)), V.readDay(conn, MARKET), loadLog(mk),
    ]);
    if (state.wallet) await loadBalances();
    render();
  } catch (e) {
    say('Could not reach the network. Retrying…', 'err');
  }
}

async function loadBalances() {
  const w = state.wallet;
  const [b, q, sol] = await Promise.all([
    conn.getTokenAccountBalance(baseAta(w)).then((r) => BigInt(r.value.amount)).catch(() => null),
    conn.getTokenAccountBalance(quoteAta(w)).then((r) => BigInt(r.value.amount)).catch(() => null),
    conn.getBalance(w).catch(() => 0),
  ]);
  state.bal = { base: b, quote: q, sol };
}

// ---------------------------------------------------------------- session

function view() {
  const mk = state.market;
  const now = chainNow();
  const sess = V.session(mk, now);
  const open = V.nasdaqOpen(now);
  const windowLive = state.book ? state.book.orders.filter((o) => o.status === 'live') : [];
  const r = mk.reference;
  const band = { lo: (r * (10_000n - mk.bandBps)) / 10_000n, hi: (r * (10_000n + mk.bandBps)) / 10_000n };
  return { now, sess, open, windowLive, cross: sess === 'day' && windowLive.length > 0, band };
}

const mine = (o) => state.wallet && o.owner.equals(state.wallet);
// orders from the test market's market maker are labelled openly
const who = (o) => (mine(o) ? 'you' : cfg.marketMaker && o.owner.toBase58() === cfg.marketMaker ? 'Velque maker' : short(o.owner.toBase58()));

// ---------------------------------------------------------------- rendering

function render() {
  const mk = state.market;
  if (!mk) return;
  const v = view();
  const shown = v.cross ? 'cross' : v.sess;
  for (const s of $('sess').children) s.classList.toggle('on', s.dataset.s === shown);

  $('w-ref').textContent = usd(mk.reference);
  const mult = state.multiplier || 1;
  const share = usd(BigInt(Math.round(Number(mk.reference) / mult)));
  $('w-ref-src').textContent = `Nasdaq ${M.symbol} ${share}${mult !== 1 ? ` × ${mult.toFixed(4)}` : ''}${v.sess === 'day' && v.open ? '' : ', last'}`;
  $('w-ref-src').title = `Signed on-chain by the oracle key ${cfg.oracle || ''}. Sources: ${(cfg.referenceSource.sources || []).join(', ')}. The token holds ${mult} shares after dividends.`;
  $('w-last').textContent = mk.lastPrice > 0n ? usd(mk.lastPrice) : '–';
  if (v.sess === 'day') {
    $('s4-k').textContent = 'BAND';
    $('s4-v').textContent = `${usd(v.band.lo)} – ${usd(v.band.hi)}`;
    $('s4-h').textContent = `±${Number(mk.bandBps) / 100}% of reference`;
  } else {
    $('s4-k').textContent = 'ORDERS IN WINDOW';
    $('s4-v').textContent = v.windowLive.length;
    $('s4-h').textContent = '';
  }

  renderBook(v);
  renderMine();
  renderLog();

  if (state.wallet && state.bal) {
    const { base, quote, sol } = state.bal;
    $('b-base').textContent = `${SYM} ${base === null ? '0' : qtyFmt(base)}`;
    $('b-quote').textContent = `tUSDC ${quote === null ? '0' : quoteFmt(quote)}`;
    $('b-sol').textContent = `SOL ${(sol / 1e9).toFixed(3)}`;
    $('faucet').hidden = quote !== null;
  }
  updateTicket();
  tick();
}

function renderBook(v) {
  if (v.sess === 'day') {
    const { bids, asks } = state.day;
    $('book-k').textContent = 'DAY BOOK';
    $('book-h').textContent = 'price then time, fills at the resting price';
    $('book-head').innerHTML = '<tr><th>PRICE</th><th>QTY</th><th>OWNER</th><th></th></tr>';
    const max = [...bids, ...asks].reduce((m, s) => (s.qty > m ? s.qty : m), 1n);
    const row = (s, cls) => `<tr class="${cls}${mine(s) ? ' me' : ''}"><td class="side-${s.side}">${usd(s.price)}</td>
      <td class="depth"><i style="width:${Math.max(4, Number((s.qty * 100n) / max))}%"></i>${qtyFmt(s.qty)}</td>
      <td>${who(s)}</td>
      <td>${mine(s) ? `<button data-dcancel="${s.index}">Cancel</button>` : ''}</td></tr>`;
    const spread = asks.length && bids.length ? `spread ${usd(asks[0].price - bids[0].price)}` : asks.length ? 'no bids yet' : bids.length ? 'no asks yet' : '';
    const rows = [...asks].reverse().map((s) => row(s, 'ask')).join('')
      + (asks.length || bids.length ? `<tr class="spread"><td colspan="4">${spread}</td></tr>` : '')
      + bids.map((s) => row(s, 'bid')).join('');
    $('book').innerHTML = rows;
    $('book-empty').textContent = 'The day book is empty. The first limit order inside the band opens it.';
    $('book-empty').hidden = bids.length + asks.length > 0;
    $('book').closest('table').hidden = bids.length + asks.length === 0;
    return;
  }
  $('book-k').textContent = 'ORDERS IN THIS WINDOW';
  $('book-h').textContent = 'prices do not match until the window closes';
  $('book-head').innerHTML = '<tr><th>SIDE</th><th>PRICE</th><th>QTY</th><th>TIF</th><th>OWNER</th><th></th></tr>';
  const live = v.windowLive;
  const rows = [...live.filter((o) => o.side === 'sell').sort((a, b) => (a.price < b.price ? 1 : -1)),
    ...live.filter((o) => o.side === 'buy').sort((a, b) => (a.price < b.price ? 1 : -1))];
  $('book').innerHTML = rows.map((o) => `<tr class="${mine(o) ? 'me' : ''}"><td class="side-${o.side}">${o.side.toUpperCase()}</td><td>${usd(o.price)}</td><td>${qtyFmt(o.qty)}</td>
    <td><span class="tag">${o.tif === 'gtc' ? 'GTC' : 'ONE'}</span></td><td>${who(o)}</td>
    <td>${mine(o) && !v.cross ? `<button data-cancel="${o.index}" data-side="${o.side}">Cancel</button>` : ''}</td></tr>`).join('');
  $('book-empty').textContent = 'No orders yet. The first order in a window opens its book.';
  $('book-empty').hidden = rows.length > 0;
  $('book').closest('table').hidden = rows.length === 0;
}

function renderMine() {
  const rows = [];
  if (state.wallet) {
    // current auction window: open orders, cancellable until the window ends
    const cross = V.session(state.market, chainNow()) === 'day';
    for (const o of state.book ? state.book.orders : []) {
      if (!mine(o) || o.status !== 'live') continue;
      rows.push(`<tr><td>#${state.book.auctionId} <span class="tag">${o.tif === 'gtc' ? 'GTC' : 'ONE'}</span></td><td class="side-${o.side}">${o.side.toUpperCase()}</td><td>${usd(o.price)}</td>
        <td>${qtyFmt(o.qty)} waiting for the window</td><td>–</td>
        <td>${cross ? '' : `<button data-cancel="${o.index}" data-side="${o.side}">Cancel</button>`}</td></tr>`);
    }
    // day book: live orders and what they have earned
    for (const s of state.day.slots) {
      if (!mine(s)) continue;
      const owed = s.owed > 0n ? (s.side === 'sell' ? `${usd(s.owed)} tUSDC` : `${qtyFmt(s.owed)} ${SYM}`) : '–';
      const st = s.status === 'moved' ? 'moved to the night auction' : s.qty > 0n ? `${qtyFmt(s.qty)} resting` : 'filled';
      const canClaim = s.owed > 0n || s.status === 'moved' || s.qty === 0n;
      rows.push(`<tr><td>Day book</td><td class="side-${s.side}">${s.side.toUpperCase()}</td><td>${usd(s.price)}</td><td>${st}</td><td>${owed}</td>
        <td class="acts">${canClaim ? `<button data-dclaim="${s.index}">Claim</button>` : ''}${s.status === 'live' && s.qty > 0n ? `<button data-dcancel="${s.index}">Cancel</button>` : ''}</td></tr>`);
    }
    // cleared windows: fills and change
    for (const b of state.log) {
      for (const o of b.orders) {
        if (o.status !== 'live' || !mine(o) || (o.filled === 0n && o.escrow === 0n)) continue;
        const at = b.volume > 0n ? usd(b.clearPrice) : 'no cross';
        const get = o.side === 'buy' ? `${qtyFmt(o.filled)} ${SYM} + change` : `${usd((o.filled * b.clearPrice) / BU)} tUSDC`;
        rows.push(`<tr><td>#${b.auctionId}${b.clearedAt < b.windowEnd ? ' <span class="tag">CROSS</span>' : ''}</td><td class="side-${o.side}">${o.side.toUpperCase()}</td><td>${usd(o.price)}</td>
          <td>${qtyFmt(o.filled)} / ${qtyFmt(o.qty)} at ${at}</td><td>${o.filled > 0n ? get : 'refund'}</td>
          <td><button data-claim="${o.index}" data-book="${b.address.toBase58()}">Claim</button></td></tr>`);
      }
    }
  }
  $('mine').innerHTML = rows.join('');
  $('mine-empty').hidden = rows.length > 0;
  $('mine').closest('table').hidden = rows.length === 0;
}

function renderLog() {
  $('log').innerHTML = state.log.map((b) => `<tr><td>#${b.auctionId}${b.clearedAt < b.windowEnd ? ' <span class="tag">CROSS</span>' : ''}</td><td>${new Date(b.clearedAt * 1000).toLocaleTimeString()}</td>
    <td>${b.volume > 0n ? usd(b.clearPrice) : 'no cross'}</td><td>${qtyFmt(b.volume)}</td><td>${b.orders.filter((o) => o.status !== 'cancelled').length}</td>
    <td>${state.verified[b.address.toBase58()] ?? `<button data-verify="${b.address.toBase58()}">Verify</button>`}</td></tr>`).join('');
  $('log-empty').hidden = state.log.length > 0;
  $('log').closest('table').hidden = state.log.length === 0;
}

function tick() {
  const mk = state.market;
  if (!mk) return;
  const v = view();
  const st = $('w-state');
  st.classList.remove('hot');
  let left;
  let total;
  if (v.sess === 'day' && v.open) {
    const change = V.nextNasdaqChange(v.now);
    left = change - v.now;
    total = 6.5 * 3600;
    $('s-kicker').textContent = 'DAY SESSION';
    $('s-title').textContent = v.cross ? 'Opening cross' : 'Continuous book';
    $('s-timer-k').textContent = 'NASDAQ CLOSES IN';
    st.textContent = v.cross
      ? 'Nasdaq is open. The night orders clear together at one price now, then the day book takes over.'
      : 'Nasdaq is open. Orders match the moment they arrive, best price first, inside the band around the reference.';
    if (v.cross) st.classList.add('hot');
  } else if (v.sess === 'day') {
    left = mk.refAt + Number(mk.maxAge) - v.now;
    total = Number(mk.maxAge);
    $('s-kicker').textContent = 'DAY SESSION';
    $('s-title').textContent = 'Closing';
    $('s-timer-k').textContent = 'AUCTION STARTS IN';
    st.textContent = 'Nasdaq has closed. When the last reference goes stale, resting orders move into the night auction with their escrow.';
  } else {
    left = mk.windowEnd - v.now;
    total = Number(mk.windowSecs);
    const change = V.nextNasdaqChange(v.now);
    $('s-kicker').textContent = 'AUCTION WINDOW';
    $('s-title').textContent = '#' + mk.auctionId;
    $('s-timer-k').textContent = 'CLEARS IN';
    if (v.open) {
      st.textContent = 'Nasdaq is open. Waking the day book…';
    } else if (left > 0) {
      st.textContent = `Nasdaq is closed. Orders collect until the timer ends, then everyone who crosses fills at one price. The opening cross is in ${human(change - v.now)}.`;
    } else {
      st.textContent = 'Window closed. Clearing at one price…';
      st.classList.add('hot');
    }
  }
  renderGuide(v);
  $('w-timer').textContent = clock(left);
  $('w-bar').style.width = `${Math.min(100, Math.max(0, (1 - left / total) * 100))}%`;

  // crank: keeps the reference fresh by day, clears windows at night, moves the day book into the auction
  const dayLive = state.day ? state.day.bids.length + state.day.asks.length : 0;
  const need = v.open
    ? v.now - mk.refAt > 240 || v.cross
    : v.sess === 'dark' && (v.now >= mk.windowEnd || dayLive > 0);
  if (need) crank();
}

