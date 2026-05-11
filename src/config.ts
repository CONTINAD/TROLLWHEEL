import dotenv from "dotenv";
dotenv.config();

function req(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

const exclude = (process.env.EXCLUDE_WALLETS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Treat these env values as "not yet configured" so the bot can wait/fall back.
const isAuto = (v: string | undefined) =>
  !v || v.trim() === "" || v.trim().toLowerCase() === "auto";

const creatorKey = req("CREATOR_WALLET_PRIVATE_KEY");
// Single-wallet mode: if no separate buyer key is set, the creator wallet
// doubles as the buyer. The forwarder becomes a no-op.
const buyerKey = process.env.BUYER_WALLET_PRIVATE_KEY?.trim() || creatorKey;

const wheelMintRaw = process.env.TROLLWHEEL_MINT?.trim();

export const config = {
  rpcUrl: req("SOLANA_RPC_URL"),

  creatorPrivateKey: creatorKey,
  buyerPrivateKey: buyerKey,
  singleWalletMode: buyerKey === creatorKey,

  // If empty / "auto", the bot watches the creator wallet for a pump.fun
  // token creation and adopts that mint automatically.
  trollwheelMint: isAuto(wheelMintRaw) ? "" : wheelMintRaw!,
  autoDetectMint: isAuto(wheelMintRaw),
  mintWatchPollSeconds: Number(process.env.MINT_WATCH_POLL_SECONDS || "20"),

  trollMint: req("TROLL_MINT"),

  pumpPortalApiKey: process.env.PUMPPORTAL_API_KEY || "",

  cycleIntervalSeconds: Number(process.env.CYCLE_INTERVAL_SECONDS || "900"),
  minBuybackSol: Number(process.env.MIN_BUYBACK_SOL || "0.05"),
  // % of cumulative claimed fees the bot is allowed to spend per cycle.
  // Default 90 — the other 10% accumulates as a buffer that's never spent.
  buybackPercent: Number(process.env.BUYBACK_PERCENT || "90"),
  maxSlippage: Number(process.env.MAX_SLIPPAGE || "15"),
  priorityFee: Number(process.env.PRIORITY_FEE || "0.0005"),

  minHolderBalance: Number(process.env.MIN_HOLDER_BALANCE || "1"),
  excludeWallets: new Set(exclude),
  // Auto-exclude any wallet holding more than this % of total supply.
  // Catches LP / bonding curve / treasury automatically — no need to know the
  // LP address in advance. A real holder won't hold 20% of supply on a fair launch.
  maxHolderSharePct: Number(process.env.MAX_HOLDER_SHARE_PCT || "20"),
  // % of each cycle's $TROLL balance to distribute. The remainder is kept in
  // the buyer wallet as a permanent bank — over time this accumulates a treasury.
  distributePercent: Number(process.env.DISTRIBUTE_PERCENT || "80"),
  hopCount: Number(process.env.HOP_COUNT || "2"),
  hopFundLamports: Number(process.env.HOP_FUND_LAMPORTS || "2200000"),
  maxHoldersPerCycle: Number(process.env.MAX_HOLDERS_PER_CYCLE || "300"),
  distributionConcurrency: Number(process.env.DISTRIBUTION_CONCURRENCY || "5"),

  port: Number(process.env.PORT || "3000"),
  logLevel: process.env.LOG_LEVEL || "info",
} as const;
