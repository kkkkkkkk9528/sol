const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const web3 = require("@solana/web3.js");
const token = require("@solana/spl-token");

const DEFAULTS = {
  rpcUrl: "https://api.devnet.solana.com",
  programId: "8cozexydPUo9jTBT7PRWVe5Qmi3bpkjgQuPo2ZaTKHus",
  gameState: "3M8a3UeEbSEvcU3Udv8G4q8qg3sHuZXDyfUXiSknksxv",
  poolTokenAccount: "E3U2e7jPtWQwwKGghjfMsyq89swxTRHTjoKtwfPS9T28",
  mint: "Gmt6rNiWverDVtZfHa6pqJwedFfqvhbL7LknZoVBDvFn",
};

function readKeypair(filePath) {
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(filePath, "utf8")));
  return web3.Keypair.fromSecretKey(secret);
}

function parseArgs(argv) {
  const out = { ...DEFAULTS, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rpc") out.rpcUrl = argv[++i];
    else if (a === "--program-id") out.programId = argv[++i];
    else if (a === "--game-state") out.gameState = argv[++i];
    else if (a === "--pool") out.poolTokenAccount = argv[++i];
    else if (a === "--mint") out.mint = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

function printUsage() {
  console.log(
    [
      "用法：node scripts/slot_machine_close_game_devnet.js [选项]",
      "",
      "说明：调用 close_game 指令：",
      "- 把奖池 SPL Token 全部转回 owner",
      "- 关闭 pool_token_account（退回 SOL 租金）",
      "- 关闭 game_state（退回 SOL 租金）",
      "",
      "选项：",
      `  --rpc <url>           默认 ${DEFAULTS.rpcUrl}`,
      `  --program-id <pk>     默认 ${DEFAULTS.programId}`,
      `  --game-state <pk>     默认 ${DEFAULTS.gameState}`,
      `  --pool <pk>           默认 ${DEFAULTS.poolTokenAccount}`,
      `  --mint <pk>           默认 ${DEFAULTS.mint}`,
    ].join("\n")
  );
}

function ixDiscriminator(name) {
  const preimage = Buffer.from(`global:${name}`, "utf8");
  const hash = crypto.createHash("sha256").update(preimage).digest();
  return hash.subarray(0, 8);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const walletPath =
    process.env.ANCHOR_WALLET || path.join(process.env.HOME || "/root", ".config", "solana", "id.json");
  const payer = readKeypair(walletPath);

  const connection = new web3.Connection(args.rpcUrl, { commitment: "confirmed" });

  const programId = new web3.PublicKey(args.programId);
  const gameState = new web3.PublicKey(args.gameState);
  const poolTokenAccount = new web3.PublicKey(args.poolTokenAccount);
  const mint = new web3.PublicKey(args.mint);

  const ownerTokenAccount = await token.getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    payer.publicKey,
    true
  );

  const gameStateInfoBefore = await connection.getAccountInfo(gameState, "confirmed");
  const poolInfoBefore = await connection.getAccountInfo(poolTokenAccount, "confirmed");
  const payerLamportsBefore = await connection.getBalance(payer.publicKey, "confirmed");

  const disc = ixDiscriminator("close_game");
  const ix = new web3.TransactionInstruction({
    programId,
    keys: [
      { pubkey: gameState, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolTokenAccount, isSigner: false, isWritable: true },
      { pubkey: ownerTokenAccount.address, isSigner: false, isWritable: true },
      { pubkey: token.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: disc,
  });

  const tx = new web3.Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  const sig = await web3.sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });

  const gameStateInfoAfter = await connection.getAccountInfo(gameState, "confirmed");
  const poolInfoAfter = await connection.getAccountInfo(poolTokenAccount, "confirmed");
  const payerLamportsAfter = await connection.getBalance(payer.publicKey, "confirmed");

  console.log("中文结果：");
  console.log("  close_game_tx:", sig);
  console.log("  owner:", payer.publicKey.toBase58());
  console.log("  owner_token_account:", ownerTokenAccount.address.toBase58());
  console.log("  game_state_before_exists:", !!gameStateInfoBefore);
  console.log("  pool_before_exists:", !!poolInfoBefore);
  console.log("  game_state_after_exists:", !!gameStateInfoAfter);
  console.log("  pool_after_exists:", !!poolInfoAfter);
  console.log("  owner_sol_before:", payerLamportsBefore);
  console.log("  owner_sol_after:", payerLamportsAfter);
  console.log("  owner_sol_delta:", payerLamportsAfter - payerLamportsBefore);
}

main().catch((e) => {
  console.error(String(e && e.stack ? e.stack : e));
  process.exit(1);
});

