import { Telegraf, Markup } from 'telegraf';
import { message } from "telegraf/filters";
import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram,
    Transaction,
} from "@solana/web3.js";
import type { Commitment } from "@solana/web3.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const COMMITMENT = (process.env.SOLANA_COMMITMENT ?? "confirmed") as Commitment;

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL, COMMITMENT);

const TRANSFER_FEE_LAMPORTS = 5000;

const USERS: Record<string, Keypair> = {}
interface PendingRequestType {
    type: "SEND_SOL" | "SEND_TOKEN",
    amount?: number,
    to?: string,
    step: "ADDRESS" | "AMOUNT"
}
const PENDING_REQUESTS: Record<string, PendingRequestType> = {};

const keyboard = Markup.inlineKeyboard([
    [
        Markup.button.callback('🔑 Generate Wallet', 'generate_wallet'),
        Markup.button.callback('Show public key', 'show_public_key'),
    ],
])

const onlyGenerateBoard = Markup.inlineKeyboard([
    [
        Markup.button.callback('🔑 Generate Wallet', 'generate_wallet'),
    ],
])

const postWalletCreationKeyboard = Markup.inlineKeyboard([
    [
        Markup.button.callback('Send SOL', 'send_sol'),
        Markup.button.callback('Show public key', 'show_public_key'),
    ],
])

export function formatSol(lamports: number): string {
    return (lamports / LAMPORTS_PER_SOL).toString();
}

export function parsePublicKey(input: string): PublicKey | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    try {
        return new PublicKey(trimmed);
    } catch {
        return null;
    }
}

export function parseSolAmount(input: string): number | null {
    const trimmed = input.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;

    const amount = Number(trimmed);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (!Number.isSafeInteger(Math.round(amount * LAMPORTS_PER_SOL))) return null;

    return amount;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function confirmSignature(
    signature: string,
    lastValidBlockHeight: number,
    timeoutMs = 60_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const { value } = await connection.getSignatureStatuses([signature]);
        const status = value[0];

        if (status?.err) {
            const error = status.err;
            throw new Error(typeof error === "string" ? error : JSON.stringify(error));
        }

        if (status?.confirmationStatus) return;

        const blockHeight = await connection.getBlockHeight(COMMITMENT);
        if (blockHeight > lastValidBlockHeight) {
            throw new Error("the transaction expired before it could be confirmed");
        }

        await sleep(1000);
    }

    throw new Error("timed out waiting for the transaction to be confirmed");
}

export async function sendSolTransfer(keypair: Keypair, to: PublicKey, lamports: number): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(COMMITMENT);

    const transaction = new Transaction({
        feePayer: keypair.publicKey,
        blockhash,
        lastValidBlockHeight,
    }).add(SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: to,
        lamports,
    }));

    transaction.sign(keypair);

    const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
    });

    await confirmSignature(signature, lastValidBlockHeight);

    return signature;
}

bot.start(async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    let welcomeMessage = `Hi there`;

    return ctx.reply(welcomeMessage, {
        parse_mode: 'Markdown',
        ...keyboard
    });
});

bot.action("generate_wallet", (ctx) => {
    ctx.answerCbQuery('Generating new wallet...');
    const keypair = Keypair.generate()
    const userId = ctx.from?.id;
    USERS[userId] = keypair;

    ctx.sendMessage(`New wallet created for you with public key ${keypair.publicKey.toBase58()}`, {
        parse_mode: 'Markdown',
        ...postWalletCreationKeyboard
    })
})

bot.action("show_public_key", (ctx) => {
    ctx.answerCbQuery('Getting your public key...');
    const userId = ctx.from?.id;
    const keypair = USERS[userId];

    if (!keypair) {
        ctx.sendMessage(`You dont have a wallet with us yet, please click generate wallet to create one`, {
            parse_mode: 'Markdown',
            ...onlyGenerateBoard
        })
        return;
    }

    ctx.sendMessage(`This is your public key ${keypair.publicKey.toBase58()}`, {
        parse_mode: 'Markdown',
        ...postWalletCreationKeyboard
    })
})

bot.action("send_sol", async (ctx) => {
    const userId = ctx.from?.id;
    await ctx.answerCbQuery();

    if (!USERS[userId]) {
        await ctx.sendMessage(`You dont have a wallet with us yet, please click generate wallet to create one`, {
            parse_mode: 'Markdown',
            ...onlyGenerateBoard
        })
        return;
    }

    PENDING_REQUESTS[userId] = {
        type: "SEND_SOL",
        step: "ADDRESS"
    }

    await ctx.sendMessage("Can u share the address to send to")
});

bot.command("cancel", async (ctx) => {
    const userId = ctx.from?.id;

    if (!PENDING_REQUESTS[userId]) {
        await ctx.reply("There is nothing to cancel");
        return;
    }

    delete PENDING_REQUESTS[userId];
    await ctx.reply("Cancelled, let me know when you want to send again");
});

bot.on(message("text"), async (ctx) => {
    const userId = ctx.from?.id;
    const pending = PENDING_REQUESTS[userId];

    if (!pending || pending.type !== "SEND_SOL") return;

    const text = ctx.message.text;

    if (pending.step === "ADDRESS") {
        const toPubkey = parsePublicKey(text);

        if (!toPubkey) {
            await ctx.reply("That doesnt look like a valid Solana address, please send it again");
            return;
        }

        pending.to = toPubkey.toBase58();
        pending.step = "AMOUNT";

        await ctx.reply(`Got it, sending to ${pending.to}. How much SOL do you want to send?`);
        return;
    }

    const destination = pending.to;

    if (!destination) {
        delete PENDING_REQUESTS[userId];
        await ctx.reply("Something went wrong, please start over");
        return;
    }

    const amount = parseSolAmount(text);

    if (amount === null) {
        await ctx.reply("That doesnt look like a valid amount, please send the amount in SOL (for example 0.1)");
        return;
    }

    pending.amount = amount;

    const keypair = USERS[userId];

    if (!keypair) {
        delete PENDING_REQUESTS[userId];
        await ctx.reply(`You dont have a wallet with us yet, please click generate wallet to create one`, {
            parse_mode: 'Markdown',
            ...onlyGenerateBoard
        })
        return;
    }

    const lamports = Math.round(amount * LAMPORTS_PER_SOL);

    let balanceLamports: number;
    try {
        balanceLamports = await connection.getBalance(keypair.publicKey, COMMITMENT);
    } catch (err) {
        console.error("balance check failed", err);
        await ctx.reply("Couldnt reach Solana right now, please try again in a moment");
        return;
    }

    if (balanceLamports < lamports + TRANSFER_FEE_LAMPORTS) {
        await ctx.reply(
            `Your wallet only has ${formatSol(balanceLamports)} SOL, which is not enough to send ${amount} SOL ` +
            `plus the network fee (${formatSol(TRANSFER_FEE_LAMPORTS)} SOL). Top up your wallet first`
        );
        return;
    }

    try {
        const signature = await sendSolTransfer(keypair, new PublicKey(destination), lamports);
        delete PENDING_REQUESTS[userId];

        await ctx.reply(
            `Sent ${amount} SOL to ${destination}\nSignature: ${signature}\nhttps://solscan.io/tx/${signature}`,
            {
                parse_mode: 'Markdown',
                ...postWalletCreationKeyboard
            }
        );
    } catch (err) {
        console.error("transfer failed", err);
        delete PENDING_REQUESTS[userId];

        await ctx.reply(`The transfer failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
})

if (import.meta.main) {
    if (!BOT_TOKEN) {
        throw new Error("TELEGRAM_BOT_TOKEN is not set, add it to your .env file");
    }

    await bot.launch()
}
