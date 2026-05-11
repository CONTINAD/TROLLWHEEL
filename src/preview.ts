// Standalone dashboard preview — no wallets, no RPC, no cycle loop.
//   npx ts-node src/preview.ts
//
// Stub env BEFORE any module that imports ./config:
process.env.SOLANA_RPC_URL ??= "https://example.invalid";
process.env.CREATOR_WALLET_PRIVATE_KEY ??= "11111111111111111111111111111111";
process.env.BUYER_WALLET_PRIVATE_KEY ??= "11111111111111111111111111111111";
process.env.TROLLWHEEL_MINT ??= "TrLLWhEeL1111111111111111111111111111111pump";
process.env.TROLL_MINT ??= "5UUH9RTDiSpq6HKS6bp4NvtQ9fAvkBjJjjqwz9hp9pump";

import express, { Request, Response } from "express";
import * as path from "path";
import * as fs from "fs";
import { renderHTML } from "./dashboard";

const PORT = Number(process.env.PORT || "3000");
const now = Date.now();

function rng(seed: number) { return () => (seed = (seed * 9301 + 49297) % 233280) / 233280; }
const r = rng(42);

const sampleHolders = [
  "9xQeWvG816bUx9EPjHmaT23QkJN9P7TVm4f1c4Yhk7nL",
  "8FE27ioQh3T7o22QsYVT5Re8NixHvWBHCFssQ1xQHCQT",
  "DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy",
  "FvKr8nVNqVrcyy1Rk9vJtq2KdT3kdF8YzaPe8aR4uqVu",
  "C9GpKMUyx9TkkLBcsAYpL2cwiqQuMD9Xt1JcWQU8RVPa",
  "7yY5n1ub4VCN1g6mPnY8WuxZ7zJ4F7p9V8nUe7g6N3sR",
  "GgB1bbsfdoYx3Krg1eXKktUuwQpQTfGGGxqMhJ8sxnA1",
  "2WzS6f7y9xLZ7v8gXNQNVwk2u3FwY7K2vGwGr9w7Q1Ld",
];

const perHolder: Record<string, { totalReceived: number; lastTs: number; lastTx: string; cycles: number }> = {};
sampleHolders.forEach((h, i) => {
  perHolder[h] = {
    totalReceived: 5000 + r() * 80000,
    lastTs: now - i * 1000 * 60,
    lastTx: "5N" + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8),
    cycles: 1 + Math.floor(r() * 8),
  };
});

const state = {
  status: "idle",
  startedAt: now - 1000 * 60 * 60 * 3,
  lastCycleAt: now - 1000 * 60 * 8,
  nextCycleAt: now + 1000 * 60 * 7,
  cycleCount: 12,
  creatorWallet: "Cr3aTorWa11et" + "x".repeat(30),
  buyerWallet: "Buy3rWa11et" + "x".repeat(32),
  trollwheelMint: "TrLLWhEeL1111111111111111111111111111111pump",
  trollMint: "5UUH9RTDiSpq6HKS6bp4NvtQ9fAvkBjJjjqwz9hp9pump",
  totals: {
    solClaimed: 7.7947,
    solSpent: 7.55,
    trollBought: 67740,
    trollDistributed: 64110,
    holdersReached: 212,
    distributionsCount: 1840,
  },
  claimPoolLamports: 0.244 * 1_000_000_000,
  current: { creatorSol: 0.012, buyerSol: 0.34, buyerTroll: 3630, holderCount: 212 },
  events: [
    { ts: now - 60_000, type: "claim", message: "Claimed 0.4823 SOL", txSignature: "5xKp9abc123def456", amountSol: 0.4823 },
    { ts: now - 55_000, type: "forward", message: "Forwarded 0.4773 SOL → buyer", txSignature: "3kLm8def456ghi789" },
    { ts: now - 50_000, type: "buy", message: "Bought 4,210.55 $TROLL for 0.4773 SOL", txSignature: "8nQr2ghi789jkl012" },
    { ts: now - 48_000, type: "snapshot", message: "Snapshot: 212 eligible holders" },
    { ts: now - 47_000, type: "distribute-start", message: "Distributing 4,210.55 $TROLL across 212 holders" },
    { ts: now - 40_000, type: "distribute-holder", message: "→ 9xQe…k7nL: 198.32 $TROLL via 2 hops", txSignature: "2jKlmnop1xyz" },
    { ts: now - 38_000, type: "distribute-holder", message: "→ 8FE2…HCQT: 187.21 $TROLL via 2 hops", txSignature: "7mNoPqRs456abc" },
    { ts: now - 36_000, type: "distribute-holder", message: "→ DRpb…21hy: 165.04 $TROLL via 2 hops", txSignature: "9sTuVwXy789def" },
    { ts: now - 10_000, type: "distribute-done", message: "Distribution finished — 212 ok, 0 failed, 4,210.55 $TROLL sent" },
  ],
  perHolder,
};

const app = express();
const publicDir = path.join(process.cwd(), "public");
if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

app.get("/api/state", (_req: Request, res: Response) => res.json(state));
app.get("/", (_req: Request, res: Response) => {
  res.set("Content-Type", "text/html; charset=utf-8").send(renderHTML());
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`TROLL WHEEL preview: http://localhost:${PORT}`);
});
