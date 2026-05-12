import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config } from "./config";
import {
  loadCreatorWallet,
  loadBuyerWallet,
  getSolBalance,
  getTokenBalance,
  connection,
} from "./wallet";
import { RewardsClaimer } from "./claim-rewards";
import { forwardLamports } from "./forwarder";
import { TrollBuyer } from "./buyer";
import { snapshotHolders } from "./holders";
import { Distributor, lamportsPerHolder, recommendedReserveLamports } from "./distributor";
import { tracker } from "./activity";
import { startDashboard } from "./dashboard";
import { waitForCreatedMint } from "./mint-watcher";
import { logger } from "./logger";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  logger.info("=== TROLL WHEEL — fee → buy → distribute ===");

  const creator = loadCreatorWallet();
  const buyer = loadBuyerWallet();
  const trollMint = new PublicKey(config.trollMint);

  logger.info(`Creator wallet: ${creator.publicKey.toBase58()}`);
  logger.info(`Buyer wallet:   ${buyer.publicKey.toBase58()}${config.singleWalletMode ? "  (same — single-wallet mode)" : ""}`);
  logger.info(`$TROLL:         ${trollMint.toBase58()}`);
  logger.info(`Cycle interval: ${config.cycleIntervalSeconds}s`);
  logger.info(`Spend cap:      ${config.buybackPercent}% of claimed fees`);

  // If the creator wallet changed since last run, wipe all persisted coin
  // state so the dashboard starts fresh (test→launch swap is the typical case).
  if (tracker.resetIfWalletChanged(creator.publicKey.toBase58())) {
    logger.info("Creator wallet differs from persisted state — wiped dashboard counters for a fresh start.");
  }

  // Manual override: set RESET_STATE=1 in env to force a wipe on next boot,
  // then unset it. Useful when env vars were changed across multiple deploys
  // and the wallet-changed detector missed the transition.
  if (process.env.RESET_STATE === "1") {
    tracker.forceReset();
    logger.info("RESET_STATE=1 — wiped all persisted state. Unset this env var now or it will wipe again on every boot.");
  }

  // Manual top-up: set TOPUP_POOL_LAMPORTS=<lamports> to add SOL to the bot's
  // spendable pool (e.g. 500_000_000 = 0.5 SOL). Applied idempotently — same
  // value won't apply twice. To top up again, change the value.
  {
    const topup = tracker.applyPoolTopup(process.env.TOPUP_POOL_LAMPORTS);
    if (topup.applied) {
      logger.info(`TOPUP_POOL_LAMPORTS applied: +${topup.lamports} lamports (${(topup.lamports/1e9).toFixed(4)} SOL) added to claim pool.`);
    }
  }

  // Resolve $TROLLWHEEL mint: use env value if set, else cached value from
  // state.json (so we don't re-detect on restart), else watch on chain.
  let wheelMintStr = config.trollwheelMint;
  const cachedWheel = tracker.snapshot().trollwheelMint;
  if (!wheelMintStr && cachedWheel && cachedWheel.length > 32) {
    wheelMintStr = cachedWheel;
    logger.info(`Resuming with previously detected $TROLLWHEEL: ${wheelMintStr}`);
  }

  // Set identity early so the dashboard renders the wallet info even while watching.
  tracker.setIdentity({
    creatorWallet: creator.publicKey.toBase58(),
    buyerWallet: buyer.publicKey.toBase58(),
    trollwheelMint: wheelMintStr || "",
    trollMint: trollMint.toBase58(),
  });

  // Start the dashboard immediately so the user can watch progress.
  startDashboard();
  logger.info(`Dashboard live at http://localhost:${config.port}`);

  if (!wheelMintStr) {
    tracker.setStatus("watching");
    tracker.recordInfo(`Watching ${creator.publicKey.toBase58()} for pump.fun token creation…`);
    logger.info(`Auto-detect mode: polling for token creation every ${config.mintWatchPollSeconds}s`);
    wheelMintStr = await waitForCreatedMint(
      connection,
      creator.publicKey,
      config.mintWatchPollSeconds,
      (n) => {
        if (n === 1 || n % 5 === 0) {
          tracker.recordInfo(`Still watching for token creation… (poll #${n})`);
        }
      }
    );
    tracker.recordInfo(`Detected $TROLLWHEEL mint: ${wheelMintStr} — starting cycles.`);
    tracker.setIdentity({
      creatorWallet: creator.publicKey.toBase58(),
      buyerWallet: buyer.publicKey.toBase58(),
      trollwheelMint: wheelMintStr,
      trollMint: trollMint.toBase58(),
    });
  }

  const wheelMint = new PublicKey(wheelMintStr);
  logger.info(`$TROLLWHEEL:    ${wheelMint.toBase58()}`);

  const claimer = new RewardsClaimer(creator);
  const trollBuyer = new TrollBuyer(buyer);
  const distributor = new Distributor(buyer);

  const updateBalances = async () => {
    const [creatorSol, buyerSol, buyerTroll] = await Promise.all([
      getSolBalance(creator.publicKey),
      getSolBalance(buyer.publicKey),
      getTokenBalance(buyer.publicKey, trollMint),
    ]);
    tracker.updateBalances({ creatorSol, buyerSol, buyerTroll });
    return { creatorSol, buyerSol, buyerTroll };
  };

  await updateBalances();

  const runCycle = async () => {
    try {
      tracker.cycleStart();

      // 1. Auto-claim creator fees from pump.fun. Track exact lamports gained.
      const balBeforeLamports = Math.floor(
        (await getSolBalance(creator.publicKey)) * LAMPORTS_PER_SOL
      );
      const claimSig = await claimer.claim();
      let claimedLamports = 0;

      if (claimSig) {
        await sleep(3000);
        const balAfterLamports = Math.floor(
          (await getSolBalance(creator.publicKey)) * LAMPORTS_PER_SOL
        );
        claimedLamports = Math.max(0, balAfterLamports - balBeforeLamports);
        if (claimedLamports > 0) {
          const claimedSol = claimedLamports / LAMPORTS_PER_SOL;
          tracker.recordClaim(claimedSol, claimSig);
          // Credit the spendable pool — the only money the bot is allowed to touch.
          tracker.creditClaimPool(claimedLamports);
          logger.info(`Claim pool now: ${(tracker.getClaimPool() / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
        } else {
          tracker.recordInfo("Claim tx submitted but no SOL delta detected.");
        }
      } else {
        tracker.recordInfo("No creator fees to claim this cycle.");
      }

      // 2. Forward EXACTLY the claimed amount to the buyer wallet.
      //    Never sweeps the dev wallet's pre-existing balance.
      //    In single-wallet mode (creator == buyer), this is a no-op.
      if (claimedLamports > 0 && !config.singleWalletMode) {
        const fwd = await forwardLamports(creator, buyer.publicKey, claimedLamports);
        if (fwd.signature) {
          tracker.recordForward(fwd.lamports / LAMPORTS_PER_SOL, fwd.signature);
        }
      } else if (claimedLamports > 0) {
        tracker.recordInfo("Single-wallet mode — claimed SOL stays in the same wallet (no forward needed).");
      }

      await updateBalances();

      // 3. Snapshot holders (drives the precise distribution reserve calc).
      const holders = await snapshotHolders(wheelMint.toBase58());
      tracker.recordSnapshot(holders.length);
      if (holders.length === 0) {
        tracker.recordInfo("No eligible holders — skipping spend this cycle.");
        return;
      }
      const distributingTo = Math.min(holders.length, config.maxHoldersPerCycle);

      // Estimate the cost-vs-value reward threshold so the dashboard can show
      // holders the minimum $TROLLWHEEL they need to hold to qualify.
      try {
        const snap = tracker.snapshot();
        const avgPriceSol = snap.totals.trollBought > 0
          ? snap.totals.solSpent / snap.totals.trollBought
          : 0.002;
        const expectedBuyTroll = avgPriceSol > 0
          ? (tracker.getClaimPool() / LAMPORTS_PER_SOL) * (config.buybackPercent / 100) / avgPriceSol
          : 0;
        const distPot = (snap.current.buyerTroll + expectedBuyTroll) * (config.distributePercent / 100);
        const totalEligibleWheel = holders.reduce((s, h) => s + h.uiBalance, 0);
        if (distPot > 0 && totalEligibleWheel > 0 && avgPriceSol > 0) {
          const ATA_RENT_SOL = 0.00204;
          const TX_FEE_SOL = 0.0000104;
          const minWheelFirstTime = Math.ceil(((ATA_RENT_SOL + TX_FEE_SOL) / avgPriceSol / distPot) * totalEligibleWheel);
          const minWheelRepeat   = Math.ceil((TX_FEE_SOL / avgPriceSol / distPot) * totalEligibleWheel);
          tracker.setRewardThreshold(minWheelFirstTime, minWheelRepeat);
        }
      } catch { /* dashboard-only — never block the cycle */ }

      // 4. Spend cap: BUYBACK_PERCENT% of accumulated claim pool, never from dev wallet.
      const pool = tracker.getClaimPool();
      const spendCapLamports = Math.floor(pool * (config.buybackPercent / 100));
      const reserveLamports = recommendedReserveLamports(distributingTo);
      const buyLamports = spendCapLamports - reserveLamports;
      const buyAmountSol = buyLamports / LAMPORTS_PER_SOL;

      logger.info(
        `Pool: ${(pool / LAMPORTS_PER_SOL).toFixed(6)} SOL · ` +
        `spendable (${config.buybackPercent}%): ${(spendCapLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL · ` +
        `reserve for ${distributingTo} hops: ${(reserveLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL · ` +
        `buy: ${buyAmountSol.toFixed(6)} SOL`
      );

      if (buyLamports <= 0 || buyAmountSol < config.minBuybackSol) {
        tracker.recordInfo(
          `Skipping buy: spendable ${(spendCapLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL ` +
          `− reserve ${(reserveLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL = ` +
          `${buyAmountSol.toFixed(6)} SOL (below min ${config.minBuybackSol}). Pool carries over.`
        );
        return;
      }

      // 5. Buy $TROLL with the computed amount.
      const trollBefore = await getTokenBalance(buyer.publicKey, trollMint);
      const buySig = await trollBuyer.buy(buyAmountSol);
      if (!buySig) {
        tracker.recordError("Buy failed; pool not deducted, will retry next cycle.");
        return;
      }
      await sleep(4000);
      const trollAfter = await getTokenBalance(buyer.publicKey, trollMint);
      const bought = Math.max(0, trollAfter - trollBefore);
      tracker.recordBuy(buyAmountSol, bought, buySig);
      // Deduct the SOL we actually spent on the buy.
      tracker.debitClaimPool(buyLamports);
      await updateBalances();

      // 6. Distribute through hop chains (each chain closes its ATAs and
      //    sweeps the leftover SOL back to buyer to minimize cost).
      tracker.recordDistributionStart(
        distributingTo,
        await getTokenBalance(buyer.publicKey, trollMint)
      );

      const result = await distributor.run(holders);

      for (const d of result.details) {
        tracker.recordHolderDistribution({
          holder: d.owner,
          amount: d.uiAmount,
          hops: d.hops,
          signatures: d.signatures,
          status: d.status,
          error: d.error,
        });
      }

      // 7. Deduct the actual distribution cost (only successful chains).
      const distCostLamports = lamportsPerHolder() * result.successes;
      tracker.debitClaimPool(distCostLamports);
      logger.info(
        `Distribution net cost: ${(distCostLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL · ` +
        `pool now: ${(tracker.getClaimPool() / LAMPORTS_PER_SOL).toFixed(6)} SOL`
      );

      tracker.recordDistributionDone(result.successes, result.failures, result.totalUiDistributed);
      await updateBalances();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error && e.stack ? `\n${e.stack}` : "";
      tracker.recordError(`Cycle error: ${msg}`);
      logger.error(`Cycle error: ${msg}${stack}`);
    } finally {
      tracker.setStatus("idle");
      const next = Date.now() + config.cycleIntervalSeconds * 1000;
      tracker.setNextCycleAt(next);
    }
  };

  // Run cycles back-to-back, waiting for each to finish before scheduling the
  // next one. Avoids overlap when a long distribution exceeds the interval.
  let stopping = false;
  const loop = async () => {
    while (!stopping) {
      await runCycle();
      await sleep(config.cycleIntervalSeconds * 1000);
    }
  };
  loop().catch((e) => logger.error(`Loop crashed: ${e instanceof Error ? e.message : e}`));

  process.on("SIGINT", () => {
    stopping = true;
    tracker.setStatus("stopped");
    logger.info("Shutting down...");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopping = true;
    tracker.setStatus("stopped");
    process.exit(0);
  });
}

main().catch((e) => {
  logger.error(`Fatal: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
