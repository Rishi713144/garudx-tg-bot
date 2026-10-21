const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const COMMITMENT = "confirmed" as const;

const address = process.argv[2];

if (!address) {
    console.error("Usage: bun run scripts/airdrop.ts <wallet address> [amount in SOL]");
    process.exit(1);
}

const { Connection, LAMPORTS_PER_SOL, PublicKey } = await import("@solana/web3.js");

const connection = new Connection(RPC_URL, COMMITMENT);
const publicKey = new PublicKey(address);
const amount = Number(process.argv[3] ?? 1);

console.log(`Requesting ${amount} SOL to ${publicKey.toBase58()} on ${RPC_URL}...`);

try {
    const signature = await connection.requestAirdrop(publicKey, Math.round(amount * LAMPORTS_PER_SOL));
    console.log(`Airdrop tx: ${signature}`);

    const confirmation = await connection.confirmTransaction(signature, COMMITMENT);
    if (confirmation.value.err) {
        console.error("Airdrop failed:", confirmation.value.err);
        process.exit(1);
    }

    const balance = await connection.getBalance(publicKey, COMMITMENT);
    console.log(`Done. Balance: ${balance / LAMPORTS_PER_SOL} SOL`);
} catch (err) {
    console.error("Airdrop failed:", err instanceof Error ? err.message : err);
    console.error("The devnet faucet is rate limited, wait a minute and try again.");
    process.exit(1);
}
