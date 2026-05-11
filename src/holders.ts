import { PublicKey, GetProgramAccountsFilter } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { connection } from "./wallet";
import { config } from "./config";
import { logger } from "./logger";

export interface Holder {
  owner: string;
  rawBalance: bigint;
  uiBalance: number;
  share: number;
}

/**
 * Snapshot all $TROLLWHEEL holders.
 * Requires an RPC that allows getProgramAccounts (Helius/QuickNode/Triton).
 *
 * Tries the standard SPL Token program first, then Token-2022, so this works
 * regardless of which program the mint lives under.
 *
 * @param mintAddress base58 string of the $TROLLWHEEL mint. Pass an explicit
 *                    value because the env may be in `auto` mode (config is empty).
 */
export async function snapshotHolders(mintAddress: string): Promise<Holder[]> {
  if (!mintAddress) throw new Error("snapshotHolders called without a mint address");
  const mint = new PublicKey(mintAddress);

  // Detect which token program owns this mint. Prevents silently falling
  // through to Token-2022 when the SPL Token scan legitimately returns 0.
  const mintAcc = await connection.getAccountInfo(mint);
  if (!mintAcc) {
    logger.warn(`Mint ${mintAddress} not found on chain — returning 0 holders.`);
    return [];
  }
  const program = mintAcc.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  try {
    return await fetchHoldersForProgram(mint, program);
  } catch (e) {
    logger.error(
      `Holder snapshot failed: ${e instanceof Error ? e.message : e}. ` +
      `Make sure SOLANA_RPC_URL allows getProgramAccounts.`
    );
    return [];
  }
}

async function fetchHoldersForProgram(
  mint: PublicKey,
  program: PublicKey
): Promise<Holder[]> {
  // Classic SPL Token accounts are exactly 165 bytes. Token-2022 accounts
  // can be 165 OR larger when extensions are enabled (pump.fun token-2022
  // mints typically include immutable-owner / transfer-hook extensions).
  // Drop the dataSize filter for Token-2022 to catch them all.
  const isToken2022 = program.equals(TOKEN_2022_PROGRAM_ID);
  const filters: GetProgramAccountsFilter[] = [
    { memcmp: { offset: 0, bytes: mint.toBase58() } },
  ];
  if (!isToken2022) filters.unshift({ dataSize: 165 });

  const accounts = await connection.getParsedProgramAccounts(program, { filters });

  // Aggregate by owner — a wallet can hold multiple token accounts for one mint.
  const byOwner = new Map<string, bigint>();

  for (const { account } of accounts) {
    const data = account.data;
    if (!("parsed" in data)) continue;
    const info = (data.parsed as { info: { owner: string; tokenAmount: { amount: string } } }).info;
    const owner = info.owner;
    if (config.excludeWallets.has(owner)) continue;

    const amount = BigInt(info.tokenAmount.amount);
    byOwner.set(owner, (byOwner.get(owner) || 0n) + amount);
  }

  // Get decimals for ui formatting
  const mintInfo = await connection.getParsedAccountInfo(mint);
  const decimals =
    mintInfo.value &&
    "parsed" in mintInfo.value.data &&
    (mintInfo.value.data.parsed as { info: { decimals: number } }).info.decimals;
  const div = BigInt(10) ** BigInt(decimals || 6);

  const minRaw = BigInt(Math.floor(config.minHolderBalance)) * div;

  let total = 0n;
  const filtered: { owner: string; raw: bigint }[] = [];
  for (const [owner, raw] of byOwner) {
    if (raw < minRaw) continue;
    filtered.push({ owner, raw });
    total += raw;
  }

  if (total === 0n) return [];

  const holders: Holder[] = filtered
    .map(({ owner, raw }) => ({
      owner,
      rawBalance: raw,
      uiBalance: Number(raw) / Number(div),
      share: Number(raw) / Number(total),
    }))
    .sort((a, b) => b.share - a.share);

  logger.info(
    `Snapshot: ${holders.length} eligible $TROLLWHEEL holders (program ${program.toBase58().slice(0, 6)}...).`
  );
  return holders;
}
