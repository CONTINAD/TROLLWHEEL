import * as fs from "fs";
import * as path from "path";

export interface CycleEvent {
  ts: number;
  type:
    | "info"
    | "claim"
    | "forward"
    | "buy"
    | "snapshot"
    | "distribute-start"
    | "distribute-holder"
    | "distribute-done"
    | "error";
  message: string;
  txSignature?: string;
  amountSol?: number;
  amountTokens?: number;
  holder?: string;
  hops?: string[];
  signatures?: string[];
}

export interface DashboardState {
  status: "idle" | "running" | "error" | "stopped" | "watching";
  startedAt: number;
  lastCycleAt: number;
  nextCycleAt: number;
  cycleCount: number;

  creatorWallet: string;
  buyerWallet: string;
  trollwheelMint: string;
  trollMint: string;

  totals: {
    solClaimed: number;
    solSpent: number;
    trollBought: number;
    trollDistributed: number;
    holdersReached: number;       // unique wallets ever paid
    distributionsCount: number;   // total successful holder transfers (cumulative)
  };

  // Lamports the bot is allowed to spend. Only grows from claim revenue.
  // Never spends from the dev wallet's pre-existing balance.
  claimPoolLamports: number;

  current: {
    creatorSol: number;
    buyerSol: number;
    buyerTroll: number;
    holderCount: number;
  };

  events: CycleEvent[];   // ring buffer, newest last
  perHolder: Record<
    string,
    { totalReceived: number; lastTs: number; lastTx: string; cycles: number }
  >;
}

// STATE_DIR env var lets the host point state at a persistent volume
// (e.g. Railway mounts a volume at /data). Falls back to ./data locally.
const DATA_DIR = process.env.STATE_DIR || path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const MAX_EVENTS = 500;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Load persisted state and deep-merge over `emptyState()` defaults.
 *
 * This guarantees:
 *   - Adding a NEW field in code never wipes existing totals (defaults fill in).
 *   - Removing a field in code is harmless (extra keys are ignored downstream).
 *   - A corrupt JSON file falls back to defaults instead of crashing the bot.
 *
 * Only nested objects (totals, current, perHolder) need deep handling — events
 * is an array we always trust as-is.
 */
function loadState(): DashboardState {
  if (!fs.existsSync(STATE_FILE)) return emptyState();

  let parsed: Partial<DashboardState> | null = null;
  try {
    parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    // Last-resort: try to read .tmp leftovers from a crashed write.
    try {
      parsed = JSON.parse(fs.readFileSync(STATE_FILE + ".tmp", "utf-8"));
    } catch {
      return emptyState();
    }
  }
  if (!parsed || typeof parsed !== "object") return emptyState();

  const base = emptyState();
  return {
    ...base,
    ...parsed,
    totals: { ...base.totals, ...(parsed.totals || {}) },
    current: { ...base.current, ...(parsed.current || {}) },
    perHolder: { ...(parsed.perHolder || {}) },
    events: Array.isArray(parsed.events) ? parsed.events : [],
  };
}

function emptyState(): DashboardState {
  return {
    status: "idle",
    startedAt: Date.now(),
    lastCycleAt: 0,
    nextCycleAt: 0,
    cycleCount: 0,
    creatorWallet: "",
    buyerWallet: "",
    trollwheelMint: "",
    trollMint: "",
    totals: {
      solClaimed: 0,
      solSpent: 0,
      trollBought: 0,
      trollDistributed: 0,
      holdersReached: 0,
      distributionsCount: 0,
    },
    claimPoolLamports: 0,
    current: { creatorSol: 0, buyerSol: 0, buyerTroll: 0, holderCount: 0 },
    events: [],
    perHolder: {},
  };
}

class Tracker {
  private state: DashboardState;

  constructor() {
    ensureDir();
    this.state = loadState();
  }

  private persist() {
    // Atomic write: serialize → write to temp → fsync → rename.
    // Guarantees that a crash mid-write can never leave a half-written
    // state.json that would cause the next boot to reset totals.
    try {
      const tmp = STATE_FILE + ".tmp";
      const fd = fs.openSync(tmp, "w");
      try {
        fs.writeSync(fd, JSON.stringify(this.state, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, STATE_FILE);
    } catch {
      /* best-effort — never throw from a tracker write */
    }
  }

  private push(event: CycleEvent) {
    this.state.events.push(event);
    if (this.state.events.length > MAX_EVENTS) {
      this.state.events = this.state.events.slice(-MAX_EVENTS);
    }
  }

  // ─── identity / state ───────────────────────────────────────────────────
  setIdentity(p: { creatorWallet: string; buyerWallet: string; trollwheelMint: string; trollMint: string }) {
    Object.assign(this.state, p);
    this.persist();
  }

  /**
   * If the persisted creator wallet differs from the one we're booting with,
   * the operator has switched wallets (e.g. test → real launch). Wipe every
   * coin-specific bit of state so the dashboard counters start fresh for the
   * new wallet/mint. Preserves nothing — totals, mint cache, holder records,
   * events all reset.
   */
  resetIfWalletChanged(currentCreatorWallet: string): boolean {
    const persisted = this.state.creatorWallet;
    if (persisted && persisted !== currentCreatorWallet) {
      const fresh = emptyState();
      this.state = fresh;
      this.persist();
      return true;
    }
    return false;
  }

  /** Unconditionally wipe all persisted state. */
  forceReset() {
    this.state = emptyState();
    this.persist();
  }

  setStatus(status: DashboardState["status"]) {
    this.state.status = status;
    this.persist();
  }

  setNextCycleAt(t: number) {
    this.state.nextCycleAt = t;
    this.persist();
  }

  updateBalances(p: { creatorSol: number; buyerSol: number; buyerTroll: number }) {
    this.state.current.creatorSol = p.creatorSol;
    this.state.current.buyerSol = p.buyerSol;
    this.state.current.buyerTroll = p.buyerTroll;
    this.persist();
  }

  setHolderCount(n: number) {
    this.state.current.holderCount = n;
    this.persist();
  }

  // ─── cycle events ───────────────────────────────────────────────────────
  cycleStart() {
    this.state.cycleCount++;
    this.state.lastCycleAt = Date.now();
    this.state.status = "running";
    this.push({ ts: Date.now(), type: "info", message: `Cycle #${this.state.cycleCount} started` });
    this.persist();
  }

  recordClaim(solAmount: number, txSignature: string) {
    this.state.totals.solClaimed += solAmount;
    this.push({ ts: Date.now(), type: "claim", message: `Claimed ${solAmount.toFixed(6)} SOL`, txSignature, amountSol: solAmount });
    this.persist();
  }

  creditClaimPool(lamports: number) {
    this.state.claimPoolLamports += lamports;
    this.persist();
  }

  debitClaimPool(lamports: number) {
    this.state.claimPoolLamports = Math.max(0, this.state.claimPoolLamports - lamports);
    this.persist();
  }

  getClaimPool(): number {
    return this.state.claimPoolLamports;
  }

  recordForward(solAmount: number, txSignature: string) {
    this.push({ ts: Date.now(), type: "forward", message: `Forwarded ${solAmount.toFixed(6)} SOL → buyer`, txSignature, amountSol: solAmount });
    this.persist();
  }

  recordBuy(solAmount: number, trollAmount: number, txSignature: string) {
    this.state.totals.solSpent += solAmount;
    this.state.totals.trollBought += trollAmount;
    this.push({
      ts: Date.now(), type: "buy",
      message: `Bought ${trollAmount.toFixed(2)} $TROLL for ${solAmount.toFixed(6)} SOL`,
      txSignature, amountSol: solAmount, amountTokens: trollAmount,
    });
    this.persist();
  }

  recordSnapshot(holderCount: number) {
    this.state.current.holderCount = holderCount;
    this.push({ ts: Date.now(), type: "snapshot", message: `Snapshot: ${holderCount} eligible holders` });
    this.persist();
  }

  recordDistributionStart(holderCount: number, totalAmount: number) {
    this.push({
      ts: Date.now(), type: "distribute-start",
      message: `Distributing ${totalAmount.toFixed(2)} $TROLL across ${holderCount} holders`,
      amountTokens: totalAmount,
    });
    this.persist();
  }

  recordHolderDistribution(p: {
    holder: string; amount: number; hops: string[]; signatures: string[]; status: "ok" | "skipped" | "failed"; error?: string;
  }) {
    if (p.status === "ok") {
      this.state.totals.distributionsCount++;
      this.state.totals.trollDistributed += p.amount;
      const prev = this.state.perHolder[p.holder] || { totalReceived: 0, lastTs: 0, lastTx: "", cycles: 0 };
      const isNew = prev.cycles === 0;
      this.state.perHolder[p.holder] = {
        totalReceived: prev.totalReceived + p.amount,
        lastTs: Date.now(),
        lastTx: p.signatures[p.signatures.length - 1] || "",
        cycles: prev.cycles + 1,
      };
      if (isNew) this.state.totals.holdersReached++;
    }
    this.push({
      ts: Date.now(), type: "distribute-holder",
      message: p.status === "ok"
        ? `→ ${p.holder.slice(0, 6)}…${p.holder.slice(-4)}: ${p.amount.toFixed(2)} $TROLL via ${p.hops.length} hops`
        : `${p.status} ${p.holder.slice(0, 6)}…: ${p.error || ""}`,
      holder: p.holder, hops: p.hops, signatures: p.signatures,
      amountTokens: p.amount,
    });
    this.persist();
  }

  recordDistributionDone(successes: number, failures: number, totalDistributed: number) {
    this.push({
      ts: Date.now(), type: "distribute-done",
      message: `Distribution finished — ${successes} ok, ${failures} failed, ${totalDistributed.toFixed(2)} $TROLL sent`,
      amountTokens: totalDistributed,
    });
    this.persist();
  }

  recordInfo(message: string) {
    this.push({ ts: Date.now(), type: "info", message });
    this.persist();
  }

  recordError(message: string) {
    this.state.status = "error";
    this.push({ ts: Date.now(), type: "error", message });
    this.persist();
  }

  snapshot(): DashboardState {
    return this.state;
  }
}

export const tracker = new Tracker();
