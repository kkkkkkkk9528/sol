const fs = require("fs");
const path = require("path");

const anchor = require("@coral-xyz/anchor");
const web3 = require("@solana/web3.js");
const crypto = require("crypto");

const SYMBOL_NAMES = ["CHERRY", "LEMON", "SEVEN", "BELL", "STAR", "DOUBLE"];

function parseArgs(argv) {
  const out = { rpcUrl: "https://api.devnet.solana.com", sig: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rpc") out.rpcUrl = argv[++i];
    else if (a === "--sig") out.sig = argv[++i];
    else if (!out.sig) out.sig = a;
  }
  return out;
}

function hydrateIdlForEvents(idl) {
  const types = Array.isArray(idl.types) ? idl.types : [];
  const typesByName = new Map(types.map((t) => [t.name, t.type]));

  const eventNames = new Set(["GameResult", "PoolWithdrawal", "CommissionWithdrawn", "AgentCreated", "AgentRedeemed"]);
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

function formatSymbols(symbols) {
  return symbols.map((n) => SYMBOL_NAMES[Number(n)] ?? String(n)).join(",");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sig) {
    console.log("用法：node scripts/slot_machine_verify_play_tx.js --sig <交易签名> [--rpc <url>]");
    process.exit(1);
  }

  const idlPath = path.join(process.cwd(), "target", "idl", "slot_machine.json");
  const idl = hydrateIdlForEvents(JSON.parse(fs.readFileSync(idlPath, "utf8")));

  const connection = new web3.Connection(args.rpcUrl, { commitment: "confirmed" });
  const tx = await connection.getTransaction(args.sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  if (!tx || !tx.meta || !tx.meta.logMessages) {
    console.log("未拿到交易日志（可能是 RPC 超时/节点未返回）。");
    process.exit(2);
  }

  const message = tx.transaction.message;
  const programId = message.staticAccountKeys ? message.staticAccountKeys[0] : null;
  const candidateProgramIds = new Set();
  if (message.staticAccountKeys) {
    for (const k of message.staticAccountKeys) candidateProgramIds.add(k.toBase58());
  }

  const programIdGuess =
    [...candidateProgramIds].find((k) => k === "8cozexydPUo9jTBT7PRWVe5Qmi3bpkjgQuPo2ZaTKHus") ||
    "8cozexydPUo9jTBT7PRWVe5Qmi3bpkjgQuPo2ZaTKHus";
  const programPk = new web3.PublicKey(programIdGuess);

  const coder = new anchor.BorshCoder(idl);
  const parser = new anchor.EventParser(programPk, coder);

  let found = false;
  for (const ev of parser.parseLogs(tx.meta.logMessages)) {
    if (!ev || ev.name !== "GameResult") continue;
    found = true;
    console.log("中文结果：");
    console.log("  玩家:", ev.data.player.toBase58());
    const totalPayout =
      ev.data.totalPayout ??
      ev.data.total_payout ??
      ev.data.totalPayout?.toString?.() ??
      ev.data.total_payout?.toString?.();
    if (totalPayout !== undefined && totalPayout !== null) {
      console.log("  总赔付(base units):", totalPayout.toString ? totalPayout.toString() : String(totalPayout));
    } else {
      console.log("  总赔付(base units):", "(未解析到字段)");
      console.log("  可用字段:", Object.keys(ev.data));
    }
    const spins = ev.data.spins || [];
    for (let i = 0; i < spins.length; i++) {
      const s = spins[i];
      console.log(
        `  第${i + 1}轮:`,
        "符号=" + formatSymbols(s.symbols),
        "赔付(base units)=" + s.payout.toString(),
        "倍率=" + s.multiplier.toString()
      );
    }
  }

  if (!found) {
    console.log("未解析到 GameResult 事件（可能该笔不是 play，或 IDL/event 结构不匹配）。");
  }
}

main().catch((e) => {
  console.error(String(e && e.stack ? e.stack : e));
  process.exit(1);
});
