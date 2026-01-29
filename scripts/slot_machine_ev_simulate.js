const fs = require("fs");
const path = require("path");

const web3 = require("@solana/web3.js");
const anchor = require("@coral-xyz/anchor");

const SYMBOL_NAMES = ["CHERRY", "LEMON", "SEVEN", "BELL", "STAR", "DOUBLE"];

function parseArgs(argv) {
  const out = {
    rpcUrl: "https://api.devnet.solana.com",
    programId: "8cozexydPUo9jTBT7PRWVe5Qmi3bpkjgQuPo2ZaTKHus",
    gameState: "3M8a3UeEbSEvcU3Udv8G4q8qg3sHuZXDyfUXiSknksxv",
    trials: 200000,
    bet: "1",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rpc") out.rpcUrl = argv[++i];
    else if (a === "--program-id") out.programId = argv[++i];
    else if (a === "--game-state") out.gameState = argv[++i];
    else if (a === "--trials") out.trials = Number(argv[++i]);
    else if (a === "--bet") out.bet = String(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function hydrateIdlForAccounts(idl) {
  const types = Array.isArray(idl.types) ? idl.types : [];
  const typesByName = new Map(types.map((t) => [t.name, t.type]));
  if (Array.isArray(idl.accounts)) {
    for (const acc of idl.accounts) {
      if (!acc.type) {
        const t = typesByName.get(acc.name);
        if (t) acc.type = t;
      }
    }
  }
  return idl;
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

function weightToSymbol(weights, rand) {
  let cumulative = 0;
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i];
    if (rand < cumulative) return i;
  }
  return weights.length - 1;
}

function calculateOutcome(symbols, payoutTriple, payoutDouble) {
  const SYMBOL_DOUBLE = 5;
  const triggeredDouble = symbols.some((s) => s === SYMBOL_DOUBLE);

  if (symbols[0] === symbols[1] && symbols[1] === symbols[2]) {
    if (symbols[0] === SYMBOL_DOUBLE) return { triggeredDouble, winningSymbol: null, multiplier: 0 };
    return { triggeredDouble, winningSymbol: symbols[0], multiplier: payoutTriple[symbols[0]] };
  }

  const nonDouble = symbols.filter((s) => s !== SYMBOL_DOUBLE);
  if (nonDouble.length === 2 && nonDouble[0] === nonDouble[1]) {
    return { triggeredDouble, winningSymbol: nonDouble[0], multiplier: payoutDouble[nonDouble[0]] };
  }

  return { triggeredDouble, winningSymbol: null, multiplier: 0 };
}

function simulateSession(cfg, betSymbolIdx, betBaseUnits, trials) {
  const WEIGHT_TOTAL = 10000;
  const PAYOUT_BASE = 100;
  const MAX_MULTIPLIER = 1600;

  let totalReturn = 0n;
  let totalBet = 0n;

  for (let t = 0; t < trials; t++) {
    let spinsRemaining = 1;
    let multiplier = 100;
    let spinCount = 0;
    let sessionPayout = 0n;

    totalBet += betBaseUnits;

    while (spinsRemaining > 0 && spinCount < cfg.maxAutoSpins) {
      spinsRemaining -= 1;
      spinCount += 1;

      const symbols = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        const r = Math.floor(Math.random() * WEIGHT_TOTAL);
        symbols[i] = weightToSymbol(cfg.symbolWeights, r);
      }

      const outcome = calculateOutcome(symbols, cfg.payoutTriple, cfg.payoutDouble);
      let basePayout = 0n;
      if (outcome.winningSymbol !== null) {
        const sym = outcome.winningSymbol;
        if (sym === betSymbolIdx) {
          basePayout = (betBaseUnits * BigInt(outcome.multiplier)) / BigInt(PAYOUT_BASE);
        }
      }

      const spinPayout = (basePayout * BigInt(multiplier)) / BigInt(PAYOUT_BASE);
      sessionPayout += spinPayout;

      if (outcome.triggeredDouble) {
        spinsRemaining += 1;
        multiplier = Math.min(MAX_MULTIPLIER, multiplier * 2);
      }
    }

    totalReturn += sessionPayout;
  }

  return { totalBet, totalReturn };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("用法：node scripts/slot_machine_ev_simulate.js [--trials N] [--bet 金额] [--rpc url]");
    process.exit(0);
  }

  const idlPath = path.join(process.cwd(), "target", "idl", "slot_machine.json");
  const idl = hydrateIdlForAccounts(JSON.parse(fs.readFileSync(idlPath, "utf8")));

  const connection = new web3.Connection(args.rpcUrl, { commitment: "confirmed" });
  const programId = new web3.PublicKey(args.programId);
  const gameStatePk = new web3.PublicKey(args.gameState);

  const coder = new anchor.BorshCoder(idl);
  const raw = await connection.getAccountInfo(gameStatePk, "confirmed");
  if (!raw) throw new Error("game_state 账户不存在或 RPC 未返回");

  const decoded = coder.accounts.decode("GameState", raw.data);

  const symbolWeights = (decoded.symbolWeights || decoded.symbol_weights).map((x) => Number(x));
  const payoutTriple = (decoded.payoutTriple || decoded.payout_triple).map((x) => Number(x));
  const payoutDouble = (decoded.payoutDouble || decoded.payout_double).map((x) => Number(x));
  const maxAutoSpins = Number(decoded.maxAutoSpins ?? decoded.max_auto_spins);

  const decimals = 9;
  const betBaseUnits = parseAmountToBaseUnits(args.bet, decimals);

  const cfg = {
    symbolWeights,
    payoutTriple,
    payoutDouble,
    maxAutoSpins,
  };

  console.log("中文结果：");
  console.log("  program_id:", programId.toBase58());
  console.log("  game_state:", gameStatePk.toBase58());
  console.log("  trials:", args.trials);
  console.log("  单次下注:", args.bet, "(代币)");
  console.log("  decimals:", decimals);

  const results = [];
  for (let sym = 0; sym < 5; sym++) {
    const r = simulateSession(cfg, sym, betBaseUnits, args.trials);
    const ev = Number(r.totalReturn) / Number(r.totalBet);
    results.push({ sym, ev, totalBet: r.totalBet, totalReturn: r.totalReturn });
  }

  results.sort((a, b) => b.ev - a.ev);

  console.log("  预期收益率(模拟)：");
  for (const r of results) {
    console.log(
      `  - ${SYMBOL_NAMES[r.sym]}:`,
      `EV=${r.ev.toFixed(6)}`,
      `总下注=${formatBaseUnits(r.totalBet, decimals)}`,
      `总赔付=${formatBaseUnits(r.totalReturn, decimals)}`
    );
  }

  const best = results[0];
  console.log("  建议（不是预测下一次结果）：");
  console.log(`  - 如果只看长期期望，当前最优单押符号是 ${SYMBOL_NAMES[best.sym]}（EV≈${best.ev.toFixed(6)}）`);
}

main().catch((e) => {
  console.error(String(e && e.stack ? e.stack : e));
  process.exit(1);
});
