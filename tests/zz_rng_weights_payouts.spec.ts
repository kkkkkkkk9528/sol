import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import fs from 'fs';
import path from 'path';

type RngState = { x: number; y: number; z: number; w: number };

type Correlation = { corr: number; n: number };

const SHOW_TEST_DATA = process.env.SHOW_TEST_DATA !== "0";
function logTestData(...args: any[]): void {
  if (!SHOW_TEST_DATA) return;
  if (args.length === 0) return;
  const [first, second] = args;
  const tag = typeof first === "string" ? first : String(first);

  const isPlainObject = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
  const compact = (v: any): any => {
    if (Array.isArray(v)) {
      const max = 20;
      const items = v.slice(0, max).map((x) => (typeof x === "number" ? x : String(x)));
      const suffix = v.length > max ? `,...(+${v.length - max})` : "";
      return `[${items.join(",")}${suffix}]`;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return v;
      if (Math.abs(v) >= 1) return Number(v.toFixed(6));
      return Number(v.toPrecision(8));
    }
    if (isPlainObject(v)) {
      const out: Record<string, any> = {};
      for (const [k, vv] of Object.entries(v)) out[k] = compact(vv);
      return out;
    }
    return v;
  };

  const row = isPlainObject(second)
    ? { tag, ...Object.fromEntries(Object.entries(compact(second)).map(([k, v]) => [k, v])) }
    : { tag, value: compact(second) };
  // eslint-disable-next-line no-console
  console.table([row]);
}

class XorshiftRngLocal {
  private x: number;
  private y: number;
  private z: number;
  private w: number;

  constructor(state: RngState) {
    this.x = state.x >>> 0;
    this.y = state.y >>> 0;
    this.z = state.z >>> 0;
    this.w = state.w >>> 0;
  }

  static fromSeed(seed: number): XorshiftRngLocal {
    const s = seed >>> 0;
    return new XorshiftRngLocal({
      x: s,
      y: Math.imul(s, 362436069) >>> 0,
      z: Math.imul(s, 521288629) >>> 0,
      w: Math.imul(s, 88675123) >>> 0,
    });
  }

  nextU32(): number {
    const t = (this.x ^ (this.x << 11)) >>> 0;
    this.x = this.y;
    this.y = this.z;
    this.z = this.w;
    this.w = (this.w ^ (this.w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return this.w;
  }

  nextRange(max: number): number {
    return this.nextU32() % max;
  }
}

function weightToSymbol(weights: number[], rand: number): number {
  let cumulative = 0;
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i];
    if (rand < cumulative) return i;
  }
  return weights.length - 1;
}

function pickThresholdForTwoOfAKind(rands: number[]): number {
  for (let t = 1; t < 10000; t++) {
    const lt = rands.filter((r) => r < t).length;
    if (lt === 2) return t;
  }
  throw new Error(`cannot pick threshold for rands: ${rands.join(",")}`);
}

async function getTokenAmount(connection: anchor.web3.Connection, address: PublicKey): Promise<bigint> {
  const res = await connection.getTokenAccountBalance(address);
  return BigInt(res.value.amount);
}

function correlationAtLag(values: number[], lag: number): Correlation {
  if (lag <= 0) throw new Error("lag must be positive");
  const n = values.length - lag;
  if (n <= 2) throw new Error("not enough samples");

  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;

  for (let i = 0; i < n; i++) {
    const x = values[i];
    const y = values[i + lag];
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumYY += y * y;
    sumXY += x * y;
  }

  const meanX = sumX / n;
  const meanY = sumY / n;
  const varX = sumXX / n - meanX * meanX;
  const varY = sumYY / n - meanY * meanY;
  const cov = sumXY / n - meanX * meanY;
  const denom = Math.sqrt(varX * varY);
  const corr = denom === 0 ? 0 : cov / denom;
  return { corr, n };
}

function chiSquare(counts: number[], expected: number[]): number {
  if (counts.length !== expected.length) throw new Error("length mismatch");
  let chi2 = 0;
  for (let i = 0; i < counts.length; i++) {
    const e = expected[i];
    if (e <= 0) continue;
    const diff = counts[i] - e;
    chi2 += (diff * diff) / e;
  }
  return chi2;
}

function bitUniformityStats(u32s: number[]): { bitOneRates: number[]; totalOneRate: number } {
  const bitOnes = new Array(32).fill(0);
  let totalOnes = 0;
  for (const v of u32s) {
    const x = v >>> 0;
    for (let b = 0; b < 32; b++) {
      const one = (x >>> b) & 1;
      bitOnes[b] += one;
      totalOnes += one;
    }
  }
  const n = u32s.length;
  const bitOneRates = bitOnes.map((c) => c / n);
  const totalOneRate = totalOnes / (n * 32);
  return { bitOneRates, totalOneRate };
}

function lsbTransitionChiSquare(u32s: number[]): number {
  if (u32s.length < 3) throw new Error("not enough samples");
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < u32s.length - 1; i++) {
    const a = (u32s[i] >>> 0) & 1;
    const b = (u32s[i + 1] >>> 0) & 1;
    counts[(a << 1) | b] += 1;
  }
  const expected = new Array(4).fill((u32s.length - 1) / 4);
  return chiSquare(counts, expected);
}

describe("rng_weights_payouts", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  let program: Program;
  const programId = new anchor.web3.PublicKey("GtSdwriBEDSUrrdxx1tHA1TV8aAgA9bSKcPmeYCUQhBg");

  before(async () => {
    const idl = JSON.parse(fs.readFileSync(path.join(process.cwd(), "target/idl/slot_machine.json"), "utf8"));
    program = new Program(idl, provider);
  });

  const owner = provider.wallet;
  const player = Keypair.generate();

  let gameState: PublicKey;
  let mint: PublicKey;
  let poolTokenAccount: PublicKey;
  let ownerTokenAccount: PublicKey;
  let playerTokenAccount: PublicKey;

  before(async () => {
    [gameState] = PublicKey.findProgramAddressSync([Buffer.from("game_state")], program.programId);

    let gameStateAccount: any;
    try {
      gameStateAccount = await program.account.gameState.fetch(gameState);
    } catch {
      gameStateAccount = null;
    }

    if (gameStateAccount) {
      mint = gameStateAccount.poolMint as PublicKey;
      poolTokenAccount = (
        await getOrCreateAssociatedTokenAccount(provider.connection, owner.payer, mint, gameState, true)
      ).address;
      ownerTokenAccount = (
        await getOrCreateAssociatedTokenAccount(provider.connection, owner.payer, mint, owner.publicKey)
      ).address;
      playerTokenAccount = (
        await getOrCreateAssociatedTokenAccount(provider.connection, owner.payer, mint, player.publicKey)
      ).address;
    } else {
      mint = await createMint(provider.connection, owner.payer, owner.publicKey, null, 6);
      poolTokenAccount = (
        await getOrCreateAssociatedTokenAccount(provider.connection, owner.payer, mint, gameState, true)
      ).address;
      ownerTokenAccount = (
        await getOrCreateAssociatedTokenAccount(provider.connection, owner.payer, mint, owner.publicKey)
      ).address;
      playerTokenAccount = (
        await getOrCreateAssociatedTokenAccount(provider.connection, owner.payer, mint, player.publicKey)
      ).address;

      await program.methods
        .initialize()
        .accounts({
          gameState,
          user: owner.publicKey,
          tokenMint: mint,
          poolTokenAccount: poolTokenAccount,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    }

    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(player.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
    );

    await mintTo(provider.connection, owner.payer, mint, playerTokenAccount, owner.publicKey, 5_000_000_000);
    await mintTo(provider.connection, owner.payer, mint, poolTokenAccount, owner.publicKey, 50_000_000_000);

    await program.methods
      .syncPoolTotal()
      .accounts({
        gameState,
        owner: owner.publicKey,
        poolTokenAccount,
      })
      .rpc();
  });

  it("Xorshift128 同种子输出一致", async () => {
    const a = XorshiftRngLocal.fromSeed(123456);
    const b = XorshiftRngLocal.fromSeed(123456);
    const outA: number[] = [];
    const outB: number[] = [];
    for (let i = 0; i < 1000; i++) {
      outA.push(a.nextU32());
      outB.push(b.nextU32());
    }
    expect(outA).to.deep.equal(outB);
    logTestData("[rng] deterministic", { seed: 123456, sample: outA.slice(0, 5) });
  });

  it("Xorshift128 bit-level 均匀性（单种子）", async () => {
    const seed = 20250118;
    const rng = XorshiftRngLocal.fromSeed(seed);
    const n = 200_000;
    const values: number[] = [];
    values.length = n;
    for (let i = 0; i < n; i++) values[i] = rng.nextU32();

    const { bitOneRates, totalOneRate } = bitUniformityStats(values);
    const minRate = Math.min(...bitOneRates);
    const maxRate = Math.max(...bitOneRates);
    logTestData("[rng] bit-uniformity", {
      seed,
      n,
      totalOneRate,
      minBitOneRate: minRate,
      maxBitOneRate: maxRate,
    });
    expect(totalOneRate).to.be.greaterThan(0.49);
    expect(totalOneRate).to.be.lessThan(0.51);
    for (let b = 0; b < 32; b++) {
      expect(bitOneRates[b]).to.be.greaterThan(0.49);
      expect(bitOneRates[b]).to.be.lessThan(0.51);
    }
  });

  it("Xorshift128 自相关（lag=1/2）接近 0", async () => {
    const seed = 42;
    const rng = XorshiftRngLocal.fromSeed(seed);
    const n = 120_000;
    const normalized: number[] = [];
    normalized.length = n;
    const inv = 1 / 2 ** 32;
    for (let i = 0; i < n; i++) normalized[i] = (rng.nextU32() >>> 0) * inv;

    const c1 = correlationAtLag(normalized, 1);
    const c2 = correlationAtLag(normalized, 2);
    logTestData("[rng] autocorr", { seed, n, lag1: c1.corr, lag2: c2.corr });
    expect(Math.abs(c1.corr)).to.be.lessThan(0.02);
    expect(Math.abs(c2.corr)).to.be.lessThan(0.02);
  });

  it("Xorshift128 LSB 转移分布接近均匀", async () => {
    const seed = 7;
    const rng = XorshiftRngLocal.fromSeed(seed);
    const n = 200_000;
    const values: number[] = [];
    values.length = n;
    for (let i = 0; i < n; i++) values[i] = rng.nextU32();

    const chi2 = lsbTransitionChiSquare(values);
    logTestData("[rng] lsb-transition-chi2", { seed, n, chi2 });
    expect(chi2).to.be.lessThan(40);
  });

  it("权重映射分布与预期接近（6 类）", async () => {
    const weights = [2500, 2500, 250, 1600, 2150, 1000];
    const rng = XorshiftRngLocal.fromSeed(42);
    const n = 200_000;
    const counts = new Array(weights.length).fill(0);
    for (let i = 0; i < n; i++) {
      const r = rng.nextRange(10000);
      const s = weightToSymbol(weights, r);
      counts[s] += 1;
    }

    const expected = weights.map((w) => (n * w) / 10000);
    const chi2 = chiSquare(counts, expected);

    logTestData("[symbols] weighted-mapping", {
      seed: 42,
      n,
      weights,
      counts,
      expected: expected.map((v) => Math.round(v)),
      chi2,
    });
    expect(chi2).to.be.lessThan(60);
  });

  it("多种子下，各符号出现比例稳定且覆盖所有符号", async () => {
    const weights = [2000, 2000, 500, 1500, 2000, 2000];
    const seeds = [1, 2, 3, 4, 5, 42, 123, 999, 123456789];
    const n = 60_000;
    const expected = weights.map((w) => (n * w) / 10000);
    let combinedChi2 = 0;

    for (const seed of seeds) {
      const rng = XorshiftRngLocal.fromSeed(seed);
      const counts = new Array(weights.length).fill(0);
      for (let i = 0; i < n; i++) {
        const r = rng.nextRange(10000);
        const s = weightToSymbol(weights, r);
        counts[s] += 1;
      }

      for (let i = 0; i < weights.length; i++) {
        if (weights[i] > 0) expect(counts[i]).to.be.greaterThan(0);
      }

      const chi2 = chiSquare(counts, expected);
      combinedChi2 += chi2;
      logTestData("[symbols] multi-seed", {
        seed,
        n,
        weights,
        counts,
        expected: expected.map((v) => Math.round(v)),
        chi2,
      });
      expect(chi2).to.be.lessThan(120);
    }

    logTestData("[symbols] multi-seed summary", { seeds, n, combinedChi2 });
    expect(combinedChi2).to.be.lessThan(700);
  });

  it("修改权重与三连赔率后，play 结算精确符合预期", async () => {
    const weights = [10000, 0, 0, 0, 0, 0];
    const payoutTriple = [500, 0, 0, 0, 0, 0];
    const payoutDouble = [0, 0, 0, 0, 0, 0];

    await program.methods
      .setSymbolWeights(weights)
      .accounts({ gameState, owner: owner.publicKey })
      .rpc();

    await program.methods
      .setPayoutTriple(payoutTriple)
      .accounts({ gameState, owner: owner.publicKey })
      .rpc();

    await program.methods
      .setPayoutDouble(payoutDouble)
      .accounts({ gameState, owner: owner.publicKey })
      .rpc();

    const bets = [new BN(1_000_000), new BN(0), new BN(0), new BN(0), new BN(0), new BN(0)];
    const playerBefore = await getTokenAmount(provider.connection, playerTokenAccount);
    const poolBefore = await getTokenAmount(provider.connection, poolTokenAccount);

    const sig = await program.methods
      .play(bets, null)
      .accounts({
        gameState,
        player: player.publicKey,
        playerTokenAccount,
        poolTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([player])
      .rpc();

    const expectedPayout = new BN(5_000_000);
    const playerAfter = await getTokenAmount(provider.connection, playerTokenAccount);
    const poolAfter = await getTokenAmount(provider.connection, poolTokenAccount);

    logTestData("[onchain] triple payout", {
      weights,
      payoutTriple,
      payoutDouble,
      bet: "1000000",
      expectedPayout: expectedPayout.toString(),
      playerDelta: (playerAfter - playerBefore).toString(),
      poolDelta: (poolAfter - poolBefore).toString(),
    });
    expect(playerAfter - playerBefore).to.equal(BigInt(expectedPayout.toString()) - 1000000n);
    expect(poolAfter - poolBefore).to.equal(1000000n - BigInt(expectedPayout.toString()));
  });

  it("修改权重与两连赔率后，play 按两连赔率结算", async () => {
    const gameStateAccount: any = await program.account.gameState.fetch(gameState);
    const rngState: RngState = {
      x: gameStateAccount.rng.x,
      y: gameStateAccount.rng.y,
      z: gameStateAccount.rng.z,
      w: gameStateAccount.rng.w,
    };

    const rng = new XorshiftRngLocal(rngState);
    const rands = [rng.nextRange(10000), rng.nextRange(10000), rng.nextRange(10000)];
    const t = pickThresholdForTwoOfAKind(rands);
    const weights = [t, 10000 - t, 0, 0, 0, 0];

    const payoutTriple = [0, 0, 0, 0, 0, 0];
    const payoutDouble = [250, 0, 0, 0, 0, 0];

    await program.methods
      .setSymbolWeights(weights)
      .accounts({ gameState, owner: owner.publicKey })
      .rpc();

    await program.methods
      .setPayoutTriple(payoutTriple)
      .accounts({ gameState, owner: owner.publicKey })
      .rpc();

    await program.methods
      .setPayoutDouble(payoutDouble)
      .accounts({ gameState, owner: owner.publicKey })
      .rpc();

    const bets = [new BN(1_000_000), new BN(0), new BN(0), new BN(0), new BN(0), new BN(0)];
    const playerBefore = await getTokenAmount(provider.connection, playerTokenAccount);
    const sig = await program.methods
      .play(bets, null)
      .accounts({
        gameState,
        player: player.publicKey,
        playerTokenAccount,
        poolTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([player])
      .rpc();

    const expectedPayout = new BN(2_500_000);
    const playerAfter = await getTokenAmount(provider.connection, playerTokenAccount);
    logTestData("[onchain] double payout", {
      rands,
      threshold: t,
      weights,
      payoutTriple,
      payoutDouble,
      bet: "1000000",
      expectedPayout: expectedPayout.toString(),
      playerDelta: (playerAfter - playerBefore).toString(),
    });
    expect(playerAfter - playerBefore).to.equal(BigInt(expectedPayout.toString()) - 1000000n);
  });
});
