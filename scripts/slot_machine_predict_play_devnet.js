const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const anchor = require("@coral-xyz/anchor");
const web3 = require("@solana/web3.js");
const token = require("@solana/spl-token");

const DEFAULTS = {
  rpcUrl: "https://api.devnet.solana.com",
  programId: "8cozexydPUo9jTBT7PRWVe5Qmi3bpkjgQuPo2ZaTKHus",
  gameState: "3M8a3UeEbSEvcU3Udv8G4q8qg3sHuZXDyfUXiSknksxv",
  poolTokenAccount: "E3U2e7jPtWQwwKGghjfMsyq89swxTRHTjoKtwfPS9T28",
  mint: "Gmt6rNiWverDVtZfHa6pqJwedFfqvhbL7LknZoVBDvFn",
  searchPlays: 80,
  warmupBetBaseUnits: 1,
  targetBet: "0.01",
  topup: null,
  maxWarmupsInTx: 20,
  boostMultiplier: 0,
  restoreAfter: true,
  runs: 1,
  retries: 3,
};

const SYMBOL_NAMES = ["CHERRY", "LEMON", "SEVEN", "BELL", "STAR", "DOUBLE"];
const SYMBOL_DOUBLE = 5;
const WEIGHT_TOTAL = 10000;
const PAYOUT_BASE = 100;
const MAX_MULTIPLIER = 1600;

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
    else if (a === "--search-plays") out.searchPlays = Number(argv[++i]);
    else if (a === "--warmup-bet-base") out.warmupBetBaseUnits = Number(argv[++i]);
    else if (a === "--target-bet") out.targetBet = String(argv[++i]);
    else if (a === "--topup") out.topup = String(argv[++i]);
    else if (a === "--max-warmups") out.maxWarmupsInTx = Number(argv[++i]);
    else if (a === "--boost-multiplier") out.boostMultiplier = Number(argv[++i]);
    else if (a === "--no-restore") out.restoreAfter = false;
    else if (a === "--runs") out.runs = Number(argv[++i]);
    else if (a === "--retries") out.retries = Number(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

function printUsage() {
  console.log(
    [
      "用法：node scripts/slot_machine_predict_play_devnet.js [选项]",
      "",
      "用途：在 devnet 上做“非蒙特卡洛”的可预测性验证：",
      "- 先读链上 game_state.rng",
      "- 本地按合约相同 RNG/权重/赔率，向前推演未来若干次 play 的结果",
      "- 选取第一个会中奖的 play，把前面的 warmup + 目标下注打包成同一笔交易发送",
      "- 上链后解析交易日志/余额变化，验证预测是否完全一致",
      "",
      "选项：",
      `  --rpc <url>              默认 ${DEFAULTS.rpcUrl}`,
      `  --program-id <pk>        默认 ${DEFAULTS.programId}`,
      `  --game-state <pk>        默认 ${DEFAULTS.gameState}`,
      `  --pool <pk>              默认 ${DEFAULTS.poolTokenAccount}`,
      `  --mint <pk>              默认 ${DEFAULTS.mint}`,
      `  --search-plays <n>        默认 ${DEFAULTS.searchPlays}（最多向前推演多少次 play）`,
      `  --warmup-bet-base <n>     默认 ${DEFAULTS.warmupBetBaseUnits}（每次 warmup 的最小下注 base units）`,
      `  --target-bet <amount>     默认 ${DEFAULTS.targetBet}（目标局下注金额，代币单位）`,
      `  --max-warmups <n>          默认 ${DEFAULTS.maxWarmupsInTx}（单笔交易最多包含多少次 warmup）`,
      `  --boost-multiplier <u16>   可选：临时提高目标符号赔率（>0 开启）`,
      "  --no-restore              可选：不在同笔交易末尾恢复原赔率（默认会恢复）",
      `  --topup <amount>          可选：先 mint 给玩家 ATA（需要你是 mint authority）`,
      `  --runs <n>                 默认 ${DEFAULTS.runs}（重复测试次数）`,
      `  --retries <n>              默认 ${DEFAULTS.retries}（每次失败最多重试次数）`,
    ].join("\n")
  );
}

function parseAmountToBaseUnits(amountStr, decimals) {
  const s = String(amountStr).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount: ${amountStr}`);
  const parts = s.split(".");
  const whole = parts[0];
  const frac = parts[1] ?? "";
  if (frac.length > decimals) throw new Error(`Too many decimals: ${amountStr}`);
  const fracPadded = frac.padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + (fracPadded ? BigInt(fracPadded) : 0n);
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

function hydrateIdlForAccountsAndEvents(idl) {
  const typesByName = new Map((idl.types ?? []).map((t) => [t.name, t.type]));
  for (const acc of idl.accounts ?? []) {
    if (!acc.type) {
      const t = typesByName.get(acc.name);
      if (t) acc.type = t;
    }
  }

  const eventNames = new Set(["GameResult"]);
  const events = [];
  for (const name of eventNames) {
    const t = typesByName.get(name);
    if (t && t.kind === "struct" && Array.isArray(t.fields)) {
      const preimage = Buffer.from(`event:${name}`, "utf8");
      const hash = crypto.createHash("sha256").update(preimage).digest();
      const discriminator = Array.from(hash.subarray(0, 8));
      events.push({ name, discriminator, fields: t.fields });
    }
  }
  idl.events = events;
  return idl;
}

function xorshiftNextU32(rng) {
  const t = (rng.x ^ ((rng.x << 11) >>> 0)) >>> 0;
  rng.x = rng.y >>> 0;
  rng.y = rng.z >>> 0;
  rng.z = rng.w >>> 0;
  rng.w = (rng.w ^ (rng.w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
  return rng.w >>> 0;
}

function xorshiftNextRange(rng, max) {
  return xorshiftNextU32(rng) % max;
}

function weightToSymbol(weights, rand) {
  let cumulative = 0;
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i];
    if (rand < cumulative) return i;
  }
  return weights.length - 1;
}

function generateSymbols(rng, weights) {
  const symbols = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const rand = xorshiftNextRange(rng, WEIGHT_TOTAL);
    symbols[i] = weightToSymbol(weights, rand);
  }
  return symbols;
}

function findPair(nonDoubleSymbols) {
  const counts = Array(6).fill(0);
  for (const s of nonDoubleSymbols) {
    if (s >= 0 && s < 6) counts[s] += 1;
  }
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] >= 2) return i;
  }
  return null;
}

function calculateOutcome(symbols, payoutTriple, payoutDouble) {
  const triggeredDouble = symbols.some((s) => s === SYMBOL_DOUBLE);
  if (symbols[0] === symbols[1] && symbols[1] === symbols[2]) {
    if (symbols[0] === SYMBOL_DOUBLE) return { triggeredDouble, winningSymbol: null, multiplier: 0 };
    return { triggeredDouble, winningSymbol: symbols[0], multiplier: payoutTriple[symbols[0]] };
  }

  const nonDouble = symbols.filter((s) => s !== SYMBOL_DOUBLE);
  if (nonDouble.length >= 2) {
    const pair = findPair(nonDouble);
    if (pair !== null) return { triggeredDouble, winningSymbol: pair, multiplier: payoutDouble[pair] };
  }
  return { triggeredDouble, winningSymbol: null, multiplier: 0 };
}

function executePlaySessionSim(rng, cfg, betsBaseUnits) {
  let totalPayout = 0n;
  let spinsRemaining = 1;
  let multiplier = 100;
  let spinCount = 0;
  const spins = [];

  while (spinsRemaining > 0 && spinCount < cfg.maxAutoSpins) {
    spinsRemaining -= 1;
    spinCount += 1;
    const symbols = generateSymbols(rng, cfg.symbolWeights);
    const outcome = calculateOutcome(symbols, cfg.payoutTriple, cfg.payoutDouble);
    const baseBet = outcome.winningSymbol === null ? 0n : betsBaseUnits[outcome.winningSymbol];
    let basePayout = 0n;
    if (baseBet > 0n && outcome.multiplier > 0) {
      basePayout = (baseBet * BigInt(outcome.multiplier)) / BigInt(PAYOUT_BASE);
    }
    const spinPayout = (basePayout * BigInt(multiplier)) / BigInt(PAYOUT_BASE);
    totalPayout += spinPayout;
    spins.push({ symbols, payout: spinPayout, multiplier });
    if (outcome.triggeredDouble) {
      spinsRemaining += 1;
      multiplier = Math.min(MAX_MULTIPLIER, multiplier * 2);
    }
  }

  return { totalPayout, spins };
}

function buildPlayIx(programId, gameState, player, playerAta, poolTokenAccount, betsBaseUnits, roomCard) {
  const disc = Buffer.from([213, 157, 193, 142, 228, 56, 248, 150]);
  const roomCardIsSome = roomCard !== null && roomCard !== undefined;
  const data = Buffer.alloc(8 + 6 * 8 + 1 + (roomCardIsSome ? 8 : 0));
  disc.copy(data, 0);
  for (let i = 0; i < 6; i++) data.writeBigUInt64LE(betsBaseUnits[i], 8 + i * 8);
  data.writeUInt8(roomCardIsSome ? 1 : 0, 8 + 6 * 8);
  if (roomCardIsSome) data.writeBigUInt64LE(BigInt(roomCard), 8 + 6 * 8 + 1);

  return new web3.TransactionInstruction({
    programId,
    keys: [
      { pubkey: gameState, isSigner: false, isWritable: true },
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: playerAta, isSigner: false, isWritable: true },
      { pubkey: poolTokenAccount, isSigner: false, isWritable: true },
      { pubkey: token.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function decodeGameResultEvents(idl, programId, logs) {
  if (!idl.events || !idl.events.length) return [];
  const coder = new anchor.BorshCoder(idl);
  const parser = new anchor.EventParser(programId, coder);
  const out = [];
  for (const ev of parser.parseLogs(logs)) {
    if (ev && ev.name === "GameResult") out.push(ev);
  }
  return out;
}

function sumBets(bets) {
  return bets.reduce((a, b) => a + b, 0n);
}

function ixDiscriminator(name) {
  const preimage = Buffer.from(`global:${name}`, "utf8");
  const hash = crypto.createHash("sha256").update(preimage).digest();
  return hash.subarray(0, 8);
}

function buildSetPayoutIx(programId, gameState, owner, kind, payoutsU16) {
  const name = kind === "double" ? "set_payout_double" : "set_payout_triple";
  const disc = ixDiscriminator(name);
  const data = Buffer.alloc(8 + 6 * 2);
  disc.copy(data, 0);
  for (let i = 0; i < 6; i++) {
    const v = payoutsU16[i];
    if (v < 0 || v > 65535) throw new Error("payout u16 超出范围");
    data.writeUInt16LE(v, 8 + i * 2);
  }
  return new web3.TransactionInstruction({
    programId,
    keys: [
      { pubkey: gameState, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function classifyWin(symbols) {
  if (symbols[0] === symbols[1] && symbols[1] === symbols[2] && symbols[0] !== SYMBOL_DOUBLE) {
    return { kind: "triple", symbol: symbols[0] };
  }
  const nonDouble = symbols.filter((s) => s !== SYMBOL_DOUBLE);
  if (nonDouble.length >= 2) {
    const pair = findPair(nonDouble);
    if (pair !== null && pair !== SYMBOL_DOUBLE) return { kind: "double", symbol: pair };
  }
  return { kind: "none", symbol: null };
}

function isFinitePositiveInt(x) {
  return Number.isFinite(x) && Number.isInteger(x) && x > 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractSignatureFromError(e) {
  if (!e) return null;
  if (typeof e.signature === "string" && e.signature.length) return e.signature;
  const msg = String(e && e.message ? e.message : e);
  const m = msg.match(/Signature\s+([1-9A-HJ-NP-Za-km-z]{43,88})/);
  return m ? m[1] : null;
}

async function sendAndConfirmFast(connection, tx, signer) {
  const latest = await connection.getLatestBlockhash("processed");
  tx.recentBlockhash = latest.blockhash;
  tx.lastValidBlockHeight = latest.lastValidBlockHeight;
  tx.sign(signer);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "processed",
    maxRetries: 3,
  });
  await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "processed"
  );
  return sig;
}

async function getTransactionWithRetry(connection, sig, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tx = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx && tx.meta && tx.meta.logMessages) return tx;
    await sleep(500);
  }
  return null;
}

async function runOnce(args, ctx) {
  const { payer, connection, programId, gameStatePk, poolTokenAccount, mint, idl, coder } = ctx;

  const mintInfo = await token.getMint(connection, mint);
  const decimals = mintInfo.decimals;
  const targetBetBase = parseAmountToBaseUnits(args.targetBet, decimals);
  const playerAta = await token.getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey, true);

  const gsInfo = await connection.getAccountInfo(gameStatePk, "confirmed");
  if (!gsInfo) throw new Error("game_state 账户不存在（先 initialize）");
  const decoded = coder.accounts.decode("GameState", gsInfo.data);

  const cfg = {
    symbolWeights: (decoded.symbolWeights || decoded.symbol_weights).map((x) => Number(x)),
    payoutTriple: (decoded.payoutTriple || decoded.payout_triple).map((x) => Number(x)),
    payoutDouble: (decoded.payoutDouble || decoded.payout_double).map((x) => Number(x)),
    maxAutoSpins: Number(decoded.maxAutoSpins ?? decoded.max_auto_spins),
  };

  const startingRng = {
    x: Number(decoded.rng.x) >>> 0,
    y: Number(decoded.rng.y) >>> 0,
    z: Number(decoded.rng.z) >>> 0,
    w: Number(decoded.rng.w) >>> 0,
  };

  const beforePlayer = await token.getAccount(connection, playerAta.address);
  const beforePool = await token.getAccount(connection, poolTokenAccount);

  const warmupBets = [0n, 0n, 0n, 0n, 0n, 0n];
  warmupBets[0] = BigInt(args.warmupBetBaseUnits);
  const probeBets = [0n, 0n, 0n, 0n, 0n, 0n];

  let chosen = null;
  let simRng = { ...startingRng };
  for (let i = 0; i < args.searchPlays; i++) {
    const probeRng = { ...simRng };
    const probe = executePlaySessionSim(probeRng, cfg, probeBets);
    simRng = probeRng;

    let winSymbol = null;
    for (const sp of probe.spins) {
      const outcome = calculateOutcome(sp.symbols, cfg.payoutTriple, cfg.payoutDouble);
      if (outcome.winningSymbol !== null && outcome.winningSymbol !== SYMBOL_DOUBLE && outcome.multiplier > 0) {
        winSymbol = outcome.winningSymbol;
        break;
      }
    }

    if (winSymbol !== null) {
      chosen = { warmups: i, winningSymbol: winSymbol };
      break;
    }
  }

  if (!chosen) {
    return { ok: false, reason: "search_failed" };
  }

  if (chosen.warmups > args.maxWarmupsInTx) {
    return { ok: false, reason: "warmups_too_many", warmups: chosen.warmups };
  }

  const targetBets = [0n, 0n, 0n, 0n, 0n, 0n];
  targetBets[chosen.winningSymbol] = targetBetBase;

  const requiredBaseUnits = BigInt(chosen.warmups) * sumBets(warmupBets) + sumBets(targetBets);
  if (BigInt(beforePlayer.amount) < requiredBaseUnits) {
    return { ok: false, reason: "insufficient_player_balance", requiredBaseUnits, decimals, beforePlayer: BigInt(beforePlayer.amount) };
  }

  const rngForTx = { ...startingRng };
  let predicted = [];
  for (let i = 0; i < chosen.warmups; i++) {
    const r = executePlaySessionSim(rngForTx, cfg, warmupBets);
    predicted.push({ kind: "warmup", bets: warmupBets, ...r });
  }
  let rTarget = executePlaySessionSim(rngForTx, cfg, targetBets);
  predicted.push({ kind: "target", bets: targetBets, ...rTarget });

  const boostEnabled = Number(args.boostMultiplier) > 0;
  const adminIxs = [];
  const restoreIxs = [];
  if (boostEnabled) {
    const firstPayingSpin = rTarget.spins.find((s) => s.payout > 0n);
    if (!firstPayingSpin) return { ok: false, reason: "boost_no_paying_spin" };
    const win = classifyWin(firstPayingSpin.symbols);
    if (win.kind === "none" || win.symbol === null) return { ok: false, reason: "boost_no_win" };
    if (win.symbol !== chosen.winningSymbol) return { ok: false, reason: "boost_symbol_mismatch" };

    const oldTriple = [...cfg.payoutTriple];
    const oldDouble = [...cfg.payoutDouble];
    const newTriple = [...cfg.payoutTriple];
    const newDouble = [...cfg.payoutDouble];

    const boost = Math.floor(Number(args.boostMultiplier));
    if (boost <= 0 || boost > 65535) return { ok: false, reason: "boost_invalid" };

    if (win.kind === "triple") newTriple[win.symbol] = boost;
    if (win.kind === "double") newDouble[win.symbol] = boost;

    adminIxs.push(
      buildSetPayoutIx(programId, gameStatePk, payer.publicKey, "triple", newTriple),
      buildSetPayoutIx(programId, gameStatePk, payer.publicKey, "double", newDouble)
    );

    if (args.restoreAfter) {
      restoreIxs.push(
        buildSetPayoutIx(programId, gameStatePk, payer.publicKey, "triple", oldTriple),
        buildSetPayoutIx(programId, gameStatePk, payer.publicKey, "double", oldDouble)
      );
    }

    const boostedCfg = { ...cfg, payoutTriple: newTriple, payoutDouble: newDouble };
    const rng2 = { ...startingRng };
    const predicted2 = [];
    for (let i = 0; i < chosen.warmups; i++) {
      const r = executePlaySessionSim(rng2, boostedCfg, warmupBets);
      predicted2.push({ kind: "warmup", bets: warmupBets, ...r });
    }
    const rTarget2 = executePlaySessionSim(rng2, boostedCfg, targetBets);
    predicted2.push({ kind: "target", bets: targetBets, ...rTarget2 });
    predicted = predicted2;
    rTarget = rTarget2;
  }

  let simulatedPool = BigInt(beforePool.amount);
  for (const p of predicted) {
    const bet = sumBets(p.bets);
    simulatedPool = simulatedPool + bet - BigInt(p.totalPayout);
    if (simulatedPool < 0n) return { ok: false, reason: "insufficient_pool_balance" };
  }

  const ixs = [];
  for (const ix of adminIxs) ixs.push(ix);
  for (let i = 0; i < chosen.warmups; i++) {
    ixs.push(buildPlayIx(programId, gameStatePk, payer.publicKey, playerAta.address, poolTokenAccount, warmupBets, null));
  }
  ixs.push(buildPlayIx(programId, gameStatePk, payer.publicKey, playerAta.address, poolTokenAccount, targetBets, null));
  for (const ix of restoreIxs) ixs.push(ix);

  const tx = new web3.Transaction();
  tx.feePayer = payer.publicKey;
  for (const ix of ixs) tx.add(ix);

  let sig = null;
  try {
    sig = await sendAndConfirmFast(connection, tx, payer);
  } catch (e) {
    const extracted = extractSignatureFromError(e);
    if (extracted) sig = extracted;
    if (!sig) return { ok: false, reason: "tx_send_failed" };
  }

  const txInfo = await getTransactionWithRetry(connection, sig, 30_000);
  if (!txInfo) return { ok: false, reason: "tx_not_found", sig };
  const logs = txInfo.meta && txInfo.meta.logMessages ? txInfo.meta.logMessages : [];
  const events = decodeGameResultEvents(idl, programId, logs);

  if (events.length !== predicted.length) return { ok: false, reason: "interference_or_parse", sig };

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const pred = predicted[i];
    const totalPayoutRaw = ev.data.totalPayout ?? ev.data.total_payout;
    const spinsRaw = ev.data.spins ?? [];
    const totalPayoutOnchain = BigInt(totalPayoutRaw.toString());
    const totalPayoutPred = BigInt(pred.totalPayout.toString());
    let ok = totalPayoutOnchain === totalPayoutPred;

    const predSpins = pred.spins || [];
    ok = ok && Array.isArray(spinsRaw) && spinsRaw.length === predSpins.length;
    if (Array.isArray(spinsRaw) && spinsRaw.length === predSpins.length) {
      for (let j = 0; j < predSpins.length; j++) {
        const sOn = spinsRaw[j];
        const sPr = predSpins[j];
        const symOn = Array.from(sOn.symbols || []).map((n) => Number(n));
        const symPr = Array.from(sPr.symbols || []).map((n) => Number(n));
        const payoutOn = BigInt((sOn.payout ?? 0).toString());
        const payoutPr = BigInt(sPr.payout.toString());
        const multOn = Number((sOn.multiplier ?? 0).toString());
        const multPr = Number(sPr.multiplier);
        const sameSymbols = symOn.length === symPr.length && symOn.every((v, k) => v === symPr[k]);
        ok = ok && sameSymbols && payoutOn === payoutPr && multOn === multPr;
      }
    }
    if (!ok) return { ok: false, reason: "mismatch", sig };
  }

  const totalBet = BigInt(chosen.warmups) * sumBets(warmupBets) + sumBets(targetBets);
  const totalPayout = predicted.reduce((a, p) => a + BigInt(p.totalPayout), 0n);

  const afterPlayer = await token.getAccount(connection, playerAta.address);
  const afterPool = await token.getAccount(connection, poolTokenAccount);
  const playerNet = BigInt(afterPlayer.amount) - BigInt(beforePlayer.amount);

  return {
    ok: true,
    sig,
    decimals,
    winningSymbol: chosen.winningSymbol,
    warmups: chosen.warmups,
    bet: totalBet,
    payout: totalPayout,
    playerNet,
    poolDelta: BigInt(afterPool.amount) - BigInt(beforePool.amount),
    targetPayout: BigInt(rTarget.totalPayout),
    targetBet: sumBets(targetBets),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (!isFinitePositiveInt(args.runs)) throw new Error("--runs 必须是正整数");
  if (!isFinitePositiveInt(args.retries)) throw new Error("--retries 必须是正整数");

  const walletPath =
    process.env.ANCHOR_WALLET || path.join(process.env.HOME || "/root", ".config", "solana", "id.json");
  const payer = readKeypair(walletPath);

  const connection = new web3.Connection(args.rpcUrl, { commitment: "confirmed" });

  const programId = new web3.PublicKey(args.programId);
  const gameStatePk = new web3.PublicKey(args.gameState);
  const poolTokenAccount = new web3.PublicKey(args.poolTokenAccount);
  const mint = new web3.PublicKey(args.mint);

  const idlPath = path.join(process.cwd(), "target", "idl", "slot_machine.json");
  const idl = hydrateIdlForAccountsAndEvents(JSON.parse(fs.readFileSync(idlPath, "utf8")));
  const coder = new anchor.BorshCoder(idl);

  if (args.topup !== null && args.topup !== undefined) {
    const mintInfo = await token.getMint(connection, mint);
    const decimals = mintInfo.decimals;
    const playerAta = await token.getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey, true);
    const topupBase = parseAmountToBaseUnits(String(args.topup), decimals);
    const ix = token.createMintToInstruction(mint, playerAta.address, payer.publicKey, topupBase);
    const tx = new web3.Transaction().add(ix);
    tx.feePayer = payer.publicKey;
    const sig = await web3.sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
    console.log("topup_tx:", sig);
  }

  console.log("中文结果：");
  console.log("  说明: 这是“读链上 RNG → 本地推演 → 单笔交易执行 warmup+目标局”的可预测性验证（重复测试版）。");
  console.log("  rpc:", args.rpcUrl);
  console.log("  program_id:", programId.toBase58());
  console.log("  game_state:", gameStatePk.toBase58());
  console.log("  mint:", mint.toBase58());
  console.log("  player:", payer.publicKey.toBase58());
  console.log("  pool_token_account:", poolTokenAccount.toBase58());

  const ctx = { payer, connection, programId, gameStatePk, poolTokenAccount, mint, idl, coder };
  let success = 0;
  let attempts = 0;
  let lastDecimals = 9;

  let totalBet = 0n;
  let totalPayout = 0n;
  let totalNet = 0n;
  let wins = 0;
  const failures = new Map();

  while (success < args.runs) {
    attempts += 1;
    let result = null;
    for (let r = 0; r < args.retries; r++) {
      result = await runOnce(args, ctx);
      if (result.ok) break;
      await sleep(200);
    }

    if (!result || !result.ok) {
      const reason = result && result.reason ? result.reason : "unknown";
      failures.set(reason, (failures.get(reason) ?? 0) + 1);
      console.log(`  第${success + 1}次: 失败 reason=${reason}`);
      if (attempts > args.runs * args.retries) break;
      continue;
    }

    success += 1;
    lastDecimals = result.decimals;
    totalBet += result.bet;
    totalPayout += result.payout;
    totalNet += result.playerNet;
    if (result.targetPayout > 0n) wins += 1;
    console.log(
      `  第${success}次: 预测符号=${SYMBOL_NAMES[result.winningSymbol]} warmups=${result.warmups} 下注=${formatBaseUnits(
        result.bet,
        result.decimals
      )} 赔付=${formatBaseUnits(result.payout, result.decimals)} 净变化=${formatBaseUnits(result.playerNet, result.decimals)} tx=${result.sig}`
    );
    await sleep(200);
  }

  const ev = totalBet > 0n ? Number(totalPayout) / Number(totalBet) : 0;
  console.log("汇总：");
  console.log("  成功次数:", success, "/", args.runs, "尝试次数:", attempts);
  console.log("  命中次数(目标局赔付>0):", wins, "命中率:", success ? (wins / success).toFixed(4) : "0.0000");
  console.log("  总下注:", formatBaseUnits(totalBet, lastDecimals));
  console.log("  总赔付:", formatBaseUnits(totalPayout, lastDecimals));
  console.log("  玩家总净变化:", formatBaseUnits(totalNet, lastDecimals));
  console.log("  赔率/收益率(总赔付/总下注):", ev.toFixed(6));
  if (failures.size) {
    console.log("  失败统计:", JSON.stringify(Object.fromEntries(failures.entries())));
  }
}

main().catch((e) => {
  console.error(String(e && e.stack ? e.stack : e));
  process.exit(1);
});
