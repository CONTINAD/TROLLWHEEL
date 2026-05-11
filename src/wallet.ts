import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config";

export const connection = new Connection(config.rpcUrl, "confirmed");

function decodeKey(secret: string): Keypair {
  // Accept either base58 string OR JSON array of bytes
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

export function loadCreatorWallet(): Keypair {
  return decodeKey(config.creatorPrivateKey);
}

export function loadBuyerWallet(): Keypair {
  return decodeKey(config.buyerPrivateKey);
}

export async function getSolBalance(pk: PublicKey): Promise<number> {
  return (await connection.getBalance(pk)) / LAMPORTS_PER_SOL;
}

export async function getTokenBalance(
  owner: PublicKey,
  mint: PublicKey
): Promise<number> {
  try {
    const accs = await connection.getParsedTokenAccountsByOwner(owner, { mint });
    if (accs.value.length === 0) return 0;
    return accs.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0;
  } catch {
    return 0;
  }
}

export async function getTokenBalanceRaw(
  owner: PublicKey,
  mint: PublicKey
): Promise<bigint> {
  try {
    const accs = await connection.getParsedTokenAccountsByOwner(owner, { mint });
    if (accs.value.length === 0) return 0n;
    return BigInt(accs.value[0].account.data.parsed.info.tokenAmount.amount);
  } catch {
    return 0n;
  }
}
