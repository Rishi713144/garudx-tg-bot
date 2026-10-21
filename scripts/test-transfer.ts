import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { formatSol, parsePublicKey, parseSolAmount, sendSolTransfer } from "../index.ts";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const COMMITMENT = "confirmed" as const;
const TRANSFER_FEE_LAMPORTS = 5000;

const connection = new Connection(RPC_URL, COMMITMENT);

async function confirmOverHttp(signature: string, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const statuses = await connection.getSignatureStatuses([signature]);
        const status = statuses.value[0];
        if (status?.err) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
        if (status?.confirmationStatus) return status;
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`timed out waiting for ${signature}`);
}

function check(label: string, actual: unknown, expected: unknown) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`}`);
    if (!ok) process.exitCode = 1;
}

console.log("--- validators ---");
check("valid address parses", parsePublicKey("So11111111111111111111111111111111111111112")?.toBase58(), "So11111111111111111111111111111111111111112");
check("invalid address rejected", parsePublicKey("not-a-key"), null);
check("empty address rejected", parsePublicKey("   "), null);
check("valid amounts", [parseSolAmount("0.1"), parseSolAmount("1"), parseSolAmount(" 2.5 ")], [0.1, 1, 2.5]);
check("invalid amounts rejected", [parseSolAmount("abc"), parseSolAmount("-1"), parseSolAmount("0"), parseSolAmount("1e5"), parseSolAmount("0.1.2"), parseSolAmount("")], [null, null, null, null, null, null]);
check("sol formatting", [formatSol(0), formatSol(5000), formatSol(1_000_000_000)], ["0", "0.000005", "1"]);

console.log("\n--- live transfer ---");
const sender = Keypair.generate();
const receiver = Keypair.generate();

console.log("airdropping 2 SOL to", sender.publicKey.toBase58());
const airdropSignature = await connection.requestAirdrop(sender.publicKey, 2 * LAMPORTS_PER_SOL);
console.log("airdrop tx:", airdropSignature);
await confirmOverHttp(airdropSignature);

const balance = await connection.getBalance(sender.publicKey, COMMITMENT);
console.log("sender balance:", formatSol(balance));
check("balance reflects airdrop", balance >= 2 * LAMPORTS_PER_SOL, true);

const amount = 0.25;
const lamports = Math.round(amount * LAMPORTS_PER_SOL);
check("balance covers amount + fee", balance >= lamports + TRANSFER_FEE_LAMPORTS, true);

const signature = await sendSolTransfer(sender, receiver.publicKey, lamports);
console.log("tx signature:", signature);

const receiverBalance = await connection.getBalance(receiver.publicKey, COMMITMENT);
console.log("receiver balance:", formatSol(receiverBalance));
check("receiver got the amount", receiverBalance, lamports);

const senderBalance = await connection.getBalance(sender.publicKey, COMMITMENT);
console.log("sender balance after:", formatSol(senderBalance));
check("sender paid amount + fee", senderBalance, balance - lamports - TRANSFER_FEE_LAMPORTS);

const confirmed = await connection.getSignatureStatuses([signature]);
check("transaction confirmed on chain", confirmed.value[0]?.confirmationStatus !== null, true);

console.log("\ndone");
