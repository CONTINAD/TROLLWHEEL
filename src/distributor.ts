import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createCloseAccountInstruction,
  getMint,
} from "@solana/spl-token";
import { connection, getSolBalance, getTokenBalanceRaw } from "./wallet";
import { config } from "./config";
import { logger } from "./logger";
import type { Holder } from "./holders";

export interface HolderDistribution {
  owner: string;
  share: number;
  rawAmount: bigint;
  uiAmount: number;
  hops: string[];          // ephemeral wallet pubkeys (length = config.hopCount)
  signatures: string[];    // one per hop, length = hopCount + 1 (last is to holder)
  status: "ok" | "skipped" | "failed";
  error?: string;
}

export interface DistributionResult {
  totalRawDistributed: bigint;
  totalUiDistributed: number;
  successes: number;
  failures: number;
  details: HolderDistribution[];
}

/**
 * Distribute the buyer wallet's full $TROLL balance pro-rata across holders.
 * Every holder receives tokens through `config.hopCount` fresh ephemeral wallets,
 * so on-chain there's no direct buyer→holder edge.
 */
export class Distributor {
  constructor(private buyer: Keypair) {}

  async run(holders: Holder[]): Promise<DistributionResult> {
    const mint = new PublicKey(config.trollMint);

    // Detect which token program owns this mint (classic SPL or Token-2022)
    const mintAcc = await connection.getAccountInfo(mint);
    if (!mintAcc) throw new Error(`$TROLL mint ${config.trollMint} not found on chain`);
    const tokenProgram = mintAcc.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;

    const mintInfo = await getMint(connection, mint, "confirmed", tokenProgram);
    const decimals = mintInfo.decimals;

    const buyerTotalRaw = await getTokenBalanceRaw(this.buyer.publicKey, mint);
    if (buyerTotalRaw === 0n) {
      logger.warn("Buyer wallet holds no $TROLL — nothing to distribute.");
      return { totalRawDistributed: 0n, totalUiDistributed: 0, successes: 0, failures: 0, details: [] };
    }

    // Hold back (100 - distributePercent)% of $TROLL as a permanent bank that
    // accrues in the buyer wallet. Only the remainder is split across holders.
    const distPct = Math.max(0, Math.min(100, config.distributePercent));
    const totalRaw = (buyerTotalRaw * BigInt(distPct)) / 100n;
    if (totalRaw === 0n) {
      logger.warn(
        `Buyer holds ${Number(buyerTotalRaw) / 10 ** decimals} $TROLL but distributePercent=${distPct} rounds to 0 — nothing to send.`
      );
      return { totalRawDistributed: 0n, totalUiDistributed: 0, successes: 0, failures: 0, details: [] };
    }

    const eligible = holders.slice(0, config.maxHoldersPerCycle);
    logger.info(
      `Distributing ${Number(totalRaw) / 10 ** decimals} $TROLL (${distPct}% of ${Number(buyerTotalRaw) / 10 ** decimals}; ${Number(buyerTotalRaw - totalRaw) / 10 ** decimals} retained as bank) across ${eligible.length} holders via ${config.hopCount}-hop chains (program: ${tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? "Token-2022" : "SPL"}).`
    );

    // Pre-flight: ensure buyer has enough SOL to seed every hop1 + create every ATA along every chain.
    const lamportsNeeded = estimateLamportsNeeded(eligible.length);
    const buyerSol = await getSolBalance(this.buyer.publicKey);
    if (buyerSol * LAMPORTS_PER_SOL < lamportsNeeded) {
      logger.warn(
        `Buyer wallet has ${buyerSol.toFixed(6)} SOL but needs ~${(lamportsNeeded / LAMPORTS_PER_SOL).toFixed(4)} SOL to fund hop chains. Continuing — some chains may fail.`
      );
    }

    const details: HolderDistribution[] = new Array(eligible.length);
    let totalDistributed = 0n;
    let successes = 0;
    let failures = 0;

    // Run holder chains with bounded concurrency. Within a chain, hops stay sequential.
    const concurrency = Math.max(1, Math.min(8, config.distributionConcurrency));
    let next = 0;

    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= eligible.length) return;
        const holder = eligible[i];

        const rawAmount =
          (totalRaw * BigInt(Math.floor(holder.share * 1_000_000_000))) / 1_000_000_000n;
        const uiAmount = Number(rawAmount) / 10 ** decimals;

        if (rawAmount === 0n) {
          details[i] = {
            owner: holder.owner, share: holder.share, rawAmount: 0n, uiAmount: 0,
            hops: [], signatures: [], status: "skipped", error: "amount rounds to 0",
          };
          continue;
        }

        try {
          const result = await this.sendThroughHops(holder.owner, mint, tokenProgram, decimals, rawAmount);
          details[i] = {
            owner: holder.owner, share: holder.share, rawAmount, uiAmount,
            hops: result.hops, signatures: result.signatures, status: "ok",
          };
          totalDistributed += rawAmount;
          successes++;
          logger.info(
            `✓ ${holder.owner.slice(0, 6)}…${holder.owner.slice(-4)}  ${uiAmount.toFixed(2)} $TROLL  via ${result.hops.length} hops`
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          details[i] = {
            owner: holder.owner, share: holder.share, rawAmount, uiAmount,
            hops: [], signatures: [], status: "failed", error: msg,
          };
          failures++;
          logger.error(`✗ ${holder.owner.slice(0, 6)}…${holder.owner.slice(-4)} failed: ${msg}`);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    return {
      totalRawDistributed: totalDistributed,
      totalUiDistributed: Number(totalDistributed) / 10 ** decimals,
      successes,
      failures,
      details,
    };
  }

  /**
   * Execute one full hop chain for a single holder.
   *
   * Cost-optimized: every hop closes its own ATA after forwarding (refunds the
   * ~0.00204 SOL rent into its system account), then sweeps its full balance
   * to the next destination. The FINAL hop sweeps any leftover SOL back to the
   * buyer wallet, so the only permanent SOL costs per holder are:
   *   - 3× tx fees (~0.000075 SOL)
   *   - 1× holder-ATA rent (~0.00204 SOL, kept by the holder as a free token account)
   *   - tiny dust left in each hop wallet (~0.00001 SOL × hopCount)
   *
   * Total per holder ≈ 0.00213 SOL (vs ~0.0072 SOL without rent recovery).
   */
  private async sendThroughHops(
    holderOwner: string,
    mint: PublicKey,
    tokenProgram: PublicKey,
    decimals: number,
    rawAmount: bigint
  ): Promise<{ hops: string[]; signatures: string[] }> {
    const hopKeypairs: Keypair[] = Array.from(
      { length: config.hopCount },
      () => Keypair.generate()
    );
    const holder = new PublicKey(holderOwner);
    const HOP_FUND = config.hopFundLamports;

    interface Step {
      signer: Keypair;
      tokenTo: PublicKey;       // owner whose ATA receives the tokens
      closeOwnAta: boolean;     // close signer's ATA → recover rent into signer.sys
      solSweepTo: PublicKey;    // where leftover SOL goes
      solSweepAmount: number;   // exact lamports to transfer
    }

    const chain: Step[] = [];

    // Step 0: buyer → hop1. Buyer keeps its own ATA (used every cycle), funds hop1
    // with enough lamports to pay all downstream tx fees.
    chain.push({
      signer: this.buyer,
      tokenTo: hopKeypairs[0].publicKey,
      closeOwnAta: false,
      solSweepTo: hopKeypairs[0].publicKey,
      solSweepAmount: HOP_FUND,
    });

    // Steps 1..hopCount-1: hop_i → hop_{i+1}. Each closes its own ATA and sweeps onward.
    for (let i = 0; i < hopKeypairs.length - 1; i++) {
      const sweep = HOP_FUND - TX_FEE_RESERVE * (i + 1) - DUST_LAMPORTS;
      chain.push({
        signer: hopKeypairs[i],
        tokenTo: hopKeypairs[i + 1].publicKey,
        closeOwnAta: true,
        solSweepTo: hopKeypairs[i + 1].publicKey,
        solSweepAmount: sweep,
      });
    }

    // Final step: lastHop → holder. Tokens go to holder; leftover SOL swept BACK to buyer.
    const finalSweep =
      HOP_FUND - TX_FEE_RESERVE * hopKeypairs.length - DUST_LAMPORTS;
    chain.push({
      signer: hopKeypairs[hopKeypairs.length - 1],
      tokenTo: holder,
      closeOwnAta: true,
      solSweepTo: this.buyer.publicKey,
      solSweepAmount: finalSweep,
    });

    if (finalSweep <= 0) {
      throw new Error(
        `HOP_FUND_LAMPORTS=${HOP_FUND} too small for hopCount=${hopKeypairs.length}; need > ${TX_FEE_RESERVE * hopKeypairs.length + DUST_LAMPORTS}`
      );
    }

    const signatures: string[] = [];

    for (let i = 0; i < chain.length; i++) {
      const step = chain[i];
      const fromOwner = step.signer.publicKey;
      const fromAta = getAssociatedTokenAddressSync(mint, fromOwner, true, tokenProgram);
      const toAta = getAssociatedTokenAddressSync(mint, step.tokenTo, true, tokenProgram);
      const isHop = step.signer !== this.buyer;

      // RPC race fix: after the buyer→hop step funds the hop wallet, the next
      // RPC that simulates the hop's own tx may not have indexed the credit yet,
      // producing "Attempt to debit an account but found no record of a prior
      // credit". Poll until the hop balance is visible to our RPC.
      if (isHop) {
        for (let n = 0; n < 12; n++) {
          const bal = await connection.getBalance(fromOwner, "confirmed");
          if (bal > 0) break;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }

      // Sweep-math fix: whether the destination ATA already exists affects what
      // rent the signer will pay during this tx. Detect it now so we can compute
      // a sweep amount that leaves the hop wallet at exactly 0 lamports.
      const toAtaExists = isHop
        ? (await connection.getAccountInfo(toAta, "confirmed")) !== null
        : false;

      const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        createAssociatedTokenAccountIdempotentInstruction(
          fromOwner, // payer = signer
          toAta,
          step.tokenTo,
          mint,
          tokenProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID
        ),
        createTransferCheckedInstruction(
          fromAta,
          mint,
          toAta,
          fromOwner,
          rawAmount,
          decimals,
          [],
          tokenProgram
        ),
      ];

      // Close own (now-empty) ATA — destination is signer's system account so the
      // rent comes back into the same wallet that's about to sweep.
      if (step.closeOwnAta) {
        ixs.push(
          createCloseAccountInstruction(fromAta, fromOwner, fromOwner, [], tokenProgram)
        );
      }

      // For ephemeral hop wallets, sweep so the account ends at exactly 0 lamports.
      // A non-zero remainder below ~890k lamports trips Solana's "system account
      // must be rent-exempt or 0" rule and the whole tx fails post-execution.
      //
      // Hop's lamport movements within this tx:
      //   −tx_fee (~5k)
      //   −2,039,280  IF the holder ATA is being CREATED (idempotent ix isn't a no-op)
      //   +2,039,280  from closing own ATA (closeOwnAta=true)
      //   −sweepLamports
      // To end at 0: sweep = liveBal − tx_fee − (newAtaRent − closeRefund)
      let sweepLamports = step.solSweepAmount;
      if (isHop && step.solSweepAmount > 0) {
        const liveBal = await connection.getBalance(fromOwner, "confirmed");
        const TX_FEE_PAD = 5_500;
        const ATA_RENT = 2_039_280;
        const newAtaRent = toAtaExists ? 0 : ATA_RENT;
        const closeRefund = step.closeOwnAta ? ATA_RENT : 0;
        sweepLamports = Math.max(0, liveBal - TX_FEE_PAD - newAtaRent + closeRefund);
      }

      if (sweepLamports > 0) {
        ixs.push(
          SystemProgram.transfer({
            fromPubkey: fromOwner,
            toPubkey: step.solSweepTo,
            lamports: sweepLamports,
          })
        );
      }

      const tx = new Transaction().add(...ixs);
      const sig = await sendAndConfirmTransaction(connection, tx, [step.signer], {
        commitment: "confirmed",
        skipPreflight: false,
        maxRetries: 3,
      });
      signatures.push(sig);
    }

    return {
      hops: hopKeypairs.map((k) => k.publicKey.toBase58()),
      signatures,
    };
  }
}

// ─── lamport budget ───────────────────────────────────────────────────────────
// Each tx with our compute budget costs at most ~25k lamports. We pad the
// reserve to 30k so a slightly variable priority-fee market never overshoots
// the wallet's balance. Dust = a tiny floor we leave behind so a small fee
// estimate error doesn't make the sweep tx fail.
const TX_FEE_RESERVE = 30_000;
const DUST_LAMPORTS = 1_000;
const HOLDER_ATA_RENT = 2_039_280; // never recovered — stays with the holder

/**
 * Net cost to the buyer wallet per holder, in lamports.
 *
 * Buyer outflow:
 *   - tx_fee for the buyer→hop1 tx                     (~25k)
 *   - rent for hop1's ATA (refunded down the chain)    (~2.04M)
 *   - HOP_FUND_LAMPORTS forwarded to hop1              (configurable)
 * Buyer inflow (final hop sweeps back):
 *   - HOP_FUND - hopCount × TX_FEE_RESERVE - DUST + 2.04M (refunded hop1-ATA rent)
 *
 * Net = tx_fee_buyer + holder_ATA_rent + hopCount × tx_fee + hopCount × dust
 * The holder-ATA rent (~0.00204 SOL) is the only major sunk cost — and it
 * stays with the holder as a permanent rent-exempt token account.
 */
export function lamportsPerHolder(): number {
  return (
    TX_FEE_RESERVE * (config.hopCount + 1) +
    DUST_LAMPORTS * config.hopCount +
    HOLDER_ATA_RENT
  );
}

function estimateLamportsNeeded(holderCount: number): number {
  return recommendedReserveLamports(holderCount);
}

/**
 * SOL the buyer must hold back from the buy step. Covers:
 *   - Net loss across all N chains (~lamportsPerHolder × N).
 *   - Peak working capital tied up in concurrent in-flight chains
 *     (each chain temporarily ties up upfront — buyer ATA rent + HOP_FUND + fee
 *     until the final hop sweeps back).
 *   - A small safety pad for fee-market jitter.
 */
export function recommendedReserveLamports(holderCount: number): number {
  const upfrontPerHolder = TX_FEE_RESERVE + HOLDER_ATA_RENT + config.hopFundLamports;
  const netCost = lamportsPerHolder() * holderCount;
  const peakInFlight = (upfrontPerHolder - lamportsPerHolder()) *
    Math.min(config.distributionConcurrency, holderCount);
  return netCost + peakInFlight + 5_000_000; // +0.005 SOL pad
}
