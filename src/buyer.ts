import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { connection } from "./wallet";
import { config } from "./config";
import { logger } from "./logger";

/**
 * Buys $TROLL on pump.fun (or auto-routed pool) using the buyer wallet.
 * Returns the signature on success.
 */
export class TrollBuyer {
  constructor(private wallet: Keypair) {}

  async buy(solAmount: number): Promise<string | null> {
    logger.info(`Buying $TROLL with ${solAmount.toFixed(6)} SOL...`);

    try {
      return config.pumpPortalApiKey
        ? await this.viaLightning(solAmount)
        : await this.viaLocal(solAmount);
    } catch (e) {
      logger.error(`Buy error: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  private async viaLightning(solAmount: number): Promise<string | null> {
    const r = await fetch(
      `https://pumpportal.fun/api/trade?api-key=${config.pumpPortalApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "buy",
          mint: config.trollMint,
          amount: solAmount,
          denominatedInSol: "true",
          slippage: config.maxSlippage,
          priorityFee: config.priorityFee,
          pool: "pump-amm",
        }),
      }
    );
    const data = (await r.json()) as { signature?: string; errors?: string };
    if (data.errors) {
      logger.error(`Buy failed: ${data.errors}`);
      return null;
    }
    if (data.signature) {
      logger.info(`Bought $TROLL! TX: ${data.signature}`);
      return data.signature;
    }
    return null;
  }

  private async viaLocal(solAmount: number): Promise<string | null> {
    const r = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey: this.wallet.publicKey.toBase58(),
        action: "buy",
        mint: config.trollMint,
        amount: solAmount,
        denominatedInSol: "true",
        slippage: config.maxSlippage,
        priorityFee: config.priorityFee,
        pool: "auto",
      }),
    });
    if (!r.ok) {
      logger.error(`Buy API ${r.status}: ${await r.text()}`);
      return null;
    }
    const tx = VersionedTransaction.deserialize(Buffer.from(await r.arrayBuffer()));
    const bh = await connection.getLatestBlockhash("confirmed");
    tx.message.recentBlockhash = bh.blockhash;
    tx.signatures = [new Uint8Array(64)];
    tx.sign([this.wallet]);
    const sig = await connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: 5,
    });
    const ok = await pollSig(sig);
    if (!ok) {
      logger.error(`Buy TX did not confirm in time: ${sig}`);
      return null;
    }
    logger.info(`Bought $TROLL! TX: ${sig}`);
    return sig;
  }
}

async function pollSig(sig: string, attempts = 30, intervalMs = 2000): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const s = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
      const v = s.value;
      if (!v) continue;
      if (v.err) return false;
      if (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized") return true;
    } catch {
      /* transient */
    }
  }
  return false;
}
