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
   * Deliver `rawAmount` of tokens to one holder through a 1-hop chain bundled
   * in a SINGLE atomic transaction (buyer + hop1 co-sign).
   *
   * Why atomic: Solana txs are all-or-nothing. If any instruction fails the
   * whole tx reverts, so we cannot strand tokens in a throwaway hop wallet
   * (the previous failure mode that cost us ~424 $TROLL pre-fix).
   *
   * Cost per holder ≈ tx_fee + holder_ATA_rent ≈ 0.00205 SOL — about 60%
   * cheaper than the old multi-tx approach. The hop1 ATA is created and
   * closed in the same tx, so it leaves no on-chain footprint.
   *
   * NOTE: only the 1-hop topology is supported here. config.hopCount is
   * ignored — the bot is hard-wired to 1 hop. Removing this means changing
   * to a multi-tx (non-atomic) approach which we deliberately moved away from.
   */
  private async sendThroughHops(
    holderOwner: string,
    mint: PublicKey,
    tokenProgram: PublicKey,
    decimals: number,
    rawAmount: bigint
  ): Promise<{ hops: string[]; signatures: string[] }> {
    const hop1 = Keypair.generate();
    const holder = new PublicKey(holderOwner);

    const buyerAta = getAssociatedTokenAddressSync(mint, this.buyer.publicKey, true, tokenProgram);
    const hop1Ata = getAssociatedTokenAddressSync(mint, hop1.publicKey, true, tokenProgram);
    const holderAta = getAssociatedTokenAddressSync(mint, holder, true, tokenProgram);

    const ixs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      // Buyer pays rent for hop1's ATA (recovered via the CloseAccount at the end of this tx).
      createAssociatedTokenAccountIdempotentInstruction(
        this.buyer.publicKey, hop1Ata, hop1.publicKey, mint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID
      ),
      // Buyer pays rent for the holder's ATA (one-time per holder, kept by them as a free token account).
      createAssociatedTokenAccountIdempotentInstruction(
        this.buyer.publicKey, holderAta, holder, mint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID
      ),
      // Buyer → hop1.
      createTransferCheckedInstruction(
        buyerAta, mint, hop1Ata, this.buyer.publicKey, rawAmount, decimals, [], tokenProgram
      ),
      // hop1 → holder.
      createTransferCheckedInstruction(
        hop1Ata, mint, holderAta, hop1.publicKey, rawAmount, decimals, [], tokenProgram
      ),
      // hop1 closes its now-empty ATA; rent refunded straight back to the buyer wallet.
      createCloseAccountInstruction(hop1Ata, this.buyer.publicKey, hop1.publicKey, [], tokenProgram),
    ];

    // Send manually so we can recover the signature even if the confirmer times
    // out. Many "failures" are actually phantom failures — the tx landed on
    // chain but sendAndConfirmTransaction threw before seeing it confirmed.
    const tx = new Transaction().add(...ixs);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = this.buyer.publicKey;
    tx.sign(this.buyer, hop1);

    const rawTx = tx.serialize();
    const sig = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      maxRetries: 5,
    });

    // Poll for confirmation. If the polling itself fails or times out, we
    // still have `sig` and can check whether the tx actually landed before
    // declaring failure.
    let confirmed = false;
    for (let n = 0; n < 30; n++) {
      try {
        const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: false });
        const v = status.value;
        if (v) {
          if (v.err) throw new Error(`tx on chain with error: ${JSON.stringify(v.err)}`);
          if (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized") {
            confirmed = true;
            break;
          }
        }
      } catch (e) {
        // transient RPC issue — keep polling
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!confirmed) {
      // Final check via tx-history search before giving up
      const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
      const v = status.value;
      if (!v || v.err) {
        throw new Error(`tx ${sig} did not confirm`);
      }
    }

    return { hops: [hop1.publicKey.toBase58()], signatures: [sig] };
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
/**
 * Net buyer-wallet SOL cost per holder in the atomic 1-hop model.
 * For a holder whose ATA already exists (repeat delivery), the only cost is
 * 2 sig base fees + priority fee ≈ 10_400 lamports. The ATA rent (2_039_280)
 * is paid only on the FIRST delivery to that holder and never again.
 *
 * Used only for accounting and the spend-cap reserve calculation below.
 */
export function lamportsPerHolder(): number {
  return 10_400;
}

function estimateLamportsNeeded(holderCount: number): number {
  return recommendedReserveLamports(holderCount);
}

/**
 * SOL held back from the buy step to cover this cycle's distribution costs.
 * Worst-case-but-realistic estimate:
 *   - All-repeat-holder tx fees:      10_400 × N lamports
 *   - Up to ~20% might be new holders this cycle (ATA rent each)
 *   - +0.01 SOL pad for fee-market jitter
 * The buyer's idle wallet balance (the 4-SOL safety reserve) provides the
 * real backstop, so we don't need to over-reserve here.
 */
export function recommendedReserveLamports(holderCount: number): number {
  const txFees = 10_400 * holderCount;
  const expectedNewHolders = Math.ceil(holderCount * 0.2);
  const newAtaRent = HOLDER_ATA_RENT * expectedNewHolders;
  return txFees + newAtaRent + 10_000_000; // +0.01 SOL pad
}
