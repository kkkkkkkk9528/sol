const fs = require("fs");
const path = require("path");

const anchor = require("@coral-xyz/anchor");
const web3 = require("@solana/web3.js");
const token = require("@solana/spl-token");

const DEFAULTS = {
  rpcUrl: "https://api.devnet.solana.com",
  programId: "8cozexydPUo9jTBT7PRWVe5Qmi3bpkjgQuPo2ZaTKHus",
  gameState: "3M8a3UeEbSEvcU3Udv8G4q8qg3sHuZXDyfUXiSknksxv",
  poolTokenAccount: "E3U2e7jPtWQwwKGghjfMsyq89swxTRHTjoKtwfPS9T28",
  mint: "Gmt6rNiWverDVtZfHa6pqJwedFfqvhbL7LknZoVBDvFn",
};

const SYMBOLS = {
  CHERRY: 0,
  LEMON: 1,
  SEVEN: 2,
  BELL: 3,
  STAR: 4,
  DOUBLE: 5,
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
};

const SYMBOL_NAMES = ["CHERRY", "LEMON", "SEVEN", "BELL", "STAR", "DOUBLE"];

function readKeypair(filePath) {
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(filePath, "utf8")));
  return web3.Keypair.fromSecretKey(secret);
}

function parseAmountToBaseUnits(amountStr, decimals) {
  if (typeof amountStr !== "string" || amountStr.length === 0) throw new Error("Invalid amount");
  const s = amountStr.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount: ${amountStr}`);
  const parts = s.split(".");
  const whole = parts[0];
  const frac = parts[1] ?? "";
  if (frac.length > decimals) throw new Error(`Too many decimals: ${amountStr}`);
  const fracPadded = frac.padEnd(decimals, "0");
  const base = BigInt(whole) * 10n ** BigInt(decimals) + (fracPadded ? BigInt(fracPadded) : 0n);
  return base;
}

function formatBaseUnits(amount, decimals) {
  const neg = amount < 0n;
  const x = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = x / base;
  const frac = x % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (fracStr.length ? "." + fracStr : "");
}

function parseArgs(argv) {
  const out = {
    rpcUrl: DEFAULTS.rpcUrl,
    programId: DEFAULTS.programId,
    gameState: DEFAULTS.gameState,
    poolTokenAccount: DEFAULTS.poolTokenAccount,
    mint: DEFAULTS.mint,
    roomCard: null,
    topup: null,
    bets: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rpc") out.rpcUrl = argv[++i];
    else if (a === "--program-id") out.programId = argv[++i];
    else if (a === "--game-state") out.gameState = argv[++i];
    else if (a === "--pool") out.poolTokenAccount = argv[++i];
    else if (a === "--mint") out.mint = argv[++i];
    else if (a === "--room-card") out.roomCard = argv[++i];
    else if (a === "--topup") out.topup = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else out.bets.push(a);
  }

  return out;
}

function printUsage() {
  const lines = [
    "用法：node scripts/slot_machine_bet_devnet.js [选项] 符号=金额 ...",
    "",
    "示例：",
    "  node scripts/slot_machine_bet_devnet.js SEVEN=1",
    "  node scripts/slot_machine_bet_devnet.js SEVEN=1 STAR=0.5",
    "  node scripts/slot_machine_bet_devnet.js --room-card 10000 SEVEN=2",
    "",
    "选项：",
    "  --rpc <url>           默认 https://api.devnet.solana.com",
    "  --program-id <pk>     默认 slot_machine program id",
    "  --game-state <pk>     默认当前 game_state PDA",
    "  --pool <pk>           默认当前奖池 token account",
    "  --mint <pk>           默认当前赔付代币 mint",
    "  --room-card <u64>     可选房卡号（不填则 None）",
    "  --topup <amount>      可选：先给玩家 ATA mint 代币（需要你是 mint authority）",
    "",
    "符号：CHERRY, LEMON, SEVEN, BELL, STAR（DOUBLE 禁止下注）",
  ];
  console.log(lines.join("\n"));
}

async function getWalletKeypair() {
  const walletPath =
    process.env.ANCHOR_WALLET ||
    path.join(process.env.HOME || "/root", ".config", "solana", "id.json");
  return readKeypair(walletPath);
}

function buildPlayData(betsBaseUnits, roomCard) {
  const discriminator = Buffer.from([213, 157, 193, 142, 228, 56, 248, 150]);
  const roomCardIsSome = roomCard !== null && roomCard !== undefined;
  const data = Buffer.alloc(8 + 6 * 8 + 1 + (roomCardIsSome ? 8 : 0));
  discriminator.copy(data, 0);
  for (let i = 0; i < 6; i++) {
    data.writeBigUInt64LE(betsBaseUnits[i], 8 + i * 8);
  }
  data.writeUInt8(roomCardIsSome ? 1 : 0, 8 + 6 * 8);
  if (roomCardIsSome) {
    data.writeBigUInt64LE(BigInt(roomCard), 8 + 6 * 8 + 1);
  }
  return data;
}

function buildBetsArray(decimals, betSpecs) {
  const bets = Array(6).fill(0n);
  for (const spec of betSpecs) {
    const m = String(spec).match(/^([A-Za-z0-9_]+)=(\d+(?:\.\d+)?)$/);
    if (!m) throw new Error(`Invalid bet: ${spec}`);
    const symRaw = m[1].toUpperCase();
    const idx = SYMBOLS[symRaw];
    if (idx === undefined) throw new Error(`Unknown symbol: ${m[1]}`);
    if (idx === SYMBOLS.DOUBLE) throw new Error("DOUBLE 禁止下注");
    const amt = parseAmountToBaseUnits(m[2], decimals);
    bets[idx] += amt;
  }
  return bets;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.bets.length === 0) {
    printUsage();
    process.exit(args.bets.length === 0 ? 1 : 0);
  }

  const payer = await getWalletKeypair();
  const connection = new web3.Connection(args.rpcUrl, { commitment: "confirmed" });

  const programId = new web3.PublicKey(args.programId);
  const gameState = new web3.PublicKey(args.gameState);
  const poolTokenAccount = new web3.PublicKey(args.poolTokenAccount);
  const mint = new web3.PublicKey(args.mint);
  const tokenProgramId = token.TOKEN_PROGRAM_ID;

  const mintInfo = await token.getMint(connection, mint);
  const decimals = mintInfo.decimals;

  const bets = buildBetsArray(decimals, args.bets);
  const totalBet = bets.reduce((a, b) => a + b, 0n);
  if (totalBet <= 0n) throw new Error("总下注必须大于 0");

  const playerAta = await token.getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    payer.publicKey,
    true
  );

  const beforePlayer = await token.getAccount(connection, playerAta.address);
  const beforePool = await token.getAccount(connection, poolTokenAccount);

  if (args.topup !== null && args.topup !== undefined) {
    const topupBase = parseAmountToBaseUnits(String(args.topup), decimals);
    const ix = token.createMintToInstruction(mint, playerAta.address, payer.publicKey, topupBase);
    const tx = new web3.Transaction().add(ix);
    tx.feePayer = payer.publicKey;
    const sig = await web3.sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
    console.log("topup_tx:", sig);
  }

  const roomCard = args.roomCard === null || args.roomCard === undefined ? null : String(args.roomCard);
  const data = buildPlayData(bets, roomCard);

  const ix = new web3.TransactionInstruction({
    programId,
    keys: [
      { pubkey: gameState, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: playerAta.address, isSigner: false, isWritable: true },
      { pubkey: poolTokenAccount, isSigner: false, isWritable: true },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new web3.Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  const sig = await web3.sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });

  const afterPlayer = await token.getAccount(connection, playerAta.address);
  const afterPool = await token.getAccount(connection, poolTokenAccount);

  const deltaPlayer = BigInt(afterPlayer.amount) - BigInt(beforePlayer.amount);
  const payout = deltaPlayer + totalBet;

  console.log("program_id:", programId.toBase58());
  console.log("mint:", mint.toBase58());
  console.log("player:", payer.publicKey.toBase58());
  console.log("player_ata:", playerAta.address.toBase58());
  console.log("pool_token_account:", poolTokenAccount.toBase58());
  console.log("decimals:", decimals);
  console.log("play_tx:", sig);
  console.log("bets_base_units:", bets.map((x) => x.toString()).join(","));
  console.log("total_bet:", formatBaseUnits(totalBet, decimals));
  console.log("player_before:", formatBaseUnits(BigInt(beforePlayer.amount), decimals));
  console.log("player_after:", formatBaseUnits(BigInt(afterPlayer.amount), decimals));
  console.log("player_net:", formatBaseUnits(deltaPlayer, decimals));
  console.log("payout:", formatBaseUnits(payout, decimals));
  console.log("pool_before:", formatBaseUnits(BigInt(beforePool.amount), decimals));
  console.log("pool_after:", formatBaseUnits(BigInt(afterPool.amount), decimals));

  const chineseBets = SYMBOL_NAMES.map((name, i) => {
    const amt = bets[i];
    if (!amt || amt === 0n) return null;
    return `${name}=${formatBaseUnits(amt, decimals)}`;
  })
    .filter(Boolean)
    .join(" ");

  const outcomeText =
    payout === 0n
      ? "未中奖（赔付为 0）"
      : payout === totalBet
        ? "回本（赔付等于下注）"
        : payout > totalBet
          ? "中奖（盈利）"
          : "中奖（但仍亏损）";

  console.log("中文结果：");
  console.log("  下注输入:", args.bets.join(" "));
  console.log("  下注拆分:", chineseBets || "（无）");
  console.log("  下注总额:", formatBaseUnits(totalBet, decimals));
  console.log("  玩家余额(前):", formatBaseUnits(BigInt(beforePlayer.amount), decimals));
  console.log("  玩家余额(后):", formatBaseUnits(BigInt(afterPlayer.amount), decimals));
  console.log("  玩家净变化(后-前):", formatBaseUnits(deltaPlayer, decimals));
  console.log("  本局赔付:", formatBaseUnits(payout, decimals));
  console.log("  本局判定:", outcomeText);
  console.log("  奖池余额(前):", formatBaseUnits(BigInt(beforePool.amount), decimals));
  console.log("  奖池余额(后):", formatBaseUnits(BigInt(afterPool.amount), decimals));

  const idlPath = path.join(process.cwd(), "target", "idl", "slot_machine.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  if (idl.events && Array.isArray(idl.events) && idl.events.length) {
    const coder = new anchor.BorshCoder(idl);
    const parser = new anchor.EventParser(programId, coder);
    const txInfo = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const logs = txInfo && txInfo.meta && txInfo.meta.logMessages ? txInfo.meta.logMessages : [];
    for (const ev of parser.parseLogs(logs)) {
      if (ev && ev.name === "GameResult") {
        const spins = ev.data.spins || [];
        const totalPayout = BigInt(ev.data.totalPayout.toString());
        console.log("event.total_payout:", formatBaseUnits(totalPayout, decimals));
        for (let i = 0; i < spins.length; i++) {
          const s = spins[i];
          const symbols = Array.from(s.symbols || []).map((n) => SYMBOL_NAMES[Number(n)] ?? String(n));
          const p = BigInt(s.payout.toString());
          console.log(
            "spin",
            i + 1,
            "symbols:",
            symbols.join(","),
            "payout:",
            formatBaseUnits(p, decimals),
            "multiplier:",
            s.multiplier.toString()
          );
        }
      }
    }
  }
}

main().catch((e) => {
  console.error(String(e && e.stack ? e.stack : e));
  process.exit(1);
});
