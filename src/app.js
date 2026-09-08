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

