import { expect } from "chai";

type RngState = { x: number; y: number; z: number; w: number };

const SYMBOL_COUNT = 6;
const SYMBOL_DOUBLE = 5;
const WEIGHT_TOTAL = 10000;
const PAYOUT_BASE = 100;
const MAX_MULTIPLIER = 1600;

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
      y: (s * 362436069) >>> 0,
      z: (s * 521288629) >>> 0,
      w: (s * 88675123) >>> 0,
    });
  }

  nextU32(): number {
    const t = (this.x ^ ((this.x << 11) >>> 0)) >>> 0;
    this.x = this.y;
    this.y = this.z;
    this.z = this.w;
    this.w = (this.w ^ (this.w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return this.w >>> 0;
  }

  nextRange(maxExclusive: number): number {
    return this.nextU32() % maxExclusive;
  }
}

type GameConfig = {
  weights: number[];
  payoutTriple: number[];
  payoutDouble: number[];
  maxAutoSpins: number;
};

function weightToSymbol(weights: number[], rand: number): number {
  let cumulative = 0;
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i];
    if (rand < cumulative) return i;
  }
  return weights.length - 1;
}

function findPair(symbols: number[]): number | null {
  const counts = new Array<number>(SYMBOL_COUNT).fill(0);
  for (const s of symbols) {
    if (s >= 0 && s < SYMBOL_COUNT) counts[s] += 1;
  }
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] >= 2) return i;
  }
  return null;
}

function calculateBasePayout(cfg: GameConfig, symbols: number[], bet: number): { base: number; triggeredDouble: boolean } {
  const r = calculateBaseOutcome(cfg, symbols, bet);
  return { base: r.base, triggeredDouble: r.triggeredDouble };
}

type BaseOutcome = { base: number; triggeredDouble: boolean; winningSymbol: number | null };

function calculateBaseOutcome(cfg: GameConfig, symbols: number[], bet: number): BaseOutcome {
  const triggeredDouble = symbols.some((s) => s === SYMBOL_DOUBLE);

  if (symbols[0] === symbols[1] && symbols[1] === symbols[2]) {
    if (symbols[0] === SYMBOL_DOUBLE) return { base: 0, triggeredDouble: true, winningSymbol: null };
    const m = cfg.payoutTriple[symbols[0]] ?? 0;
    return { base: Math.floor((bet * m) / PAYOUT_BASE), triggeredDouble, winningSymbol: symbols[0] };
  }

  const nonDouble = symbols.filter((s) => s !== SYMBOL_DOUBLE);
  if (nonDouble.length >= 2) {
    const pair = findPair(nonDouble);
    if (pair !== null) {
      const m = cfg.payoutDouble[pair] ?? 0;
      return { base: Math.floor((bet * m) / PAYOUT_BASE), triggeredDouble, winningSymbol: pair };
    }
  }

  return { base: 0, triggeredDouble, winningSymbol: null };
}

function simulatePlay(cfg: GameConfig, rng: XorshiftRngLocal, bet: number): number {
  let totalPayout = 0;
  let spinsRemaining = 1;
  let multiplier = 100;
  let spinCount = 0;

  while (spinsRemaining > 0 && spinCount < cfg.maxAutoSpins) {
    spinsRemaining -= 1;
    spinCount += 1;

    const symbols = [0, 0, 0].map(() => weightToSymbol(cfg.weights, rng.nextRange(WEIGHT_TOTAL)));
    const { base, triggeredDouble } = calculateBasePayout(cfg, symbols, bet);
    const spinPayout = Math.floor((base * multiplier) / PAYOUT_BASE);
    totalPayout += spinPayout;

    if (triggeredDouble) {
      spinsRemaining += 1;
      multiplier = Math.min(multiplier * 2, MAX_MULTIPLIER);
    }
  }

  return totalPayout;
}

function simulatePlayWithWinningSymbolFilter(
  cfg: GameConfig,
  rng: XorshiftRngLocal,
  bet: number,
  allowedWinningSymbols: Set<number>,
): { totalPayoutAll: number; totalPayoutFiltered: number } {
  let totalPayoutAll = 0;
  let totalPayoutFiltered = 0;
  let spinsRemaining = 1;
  let multiplier = 100;
  let spinCount = 0;

  while (spinsRemaining > 0 && spinCount < cfg.maxAutoSpins) {
    spinsRemaining -= 1;
    spinCount += 1;

    const symbols = [0, 0, 0].map(() => weightToSymbol(cfg.weights, rng.nextRange(WEIGHT_TOTAL)));
    const { base, triggeredDouble, winningSymbol } = calculateBaseOutcome(cfg, symbols, bet);
    const spinPayout = Math.floor((base * multiplier) / PAYOUT_BASE);
    totalPayoutAll += spinPayout;
    if (winningSymbol !== null && allowedWinningSymbols.has(winningSymbol)) {
      totalPayoutFiltered += spinPayout;
    }

    if (triggeredDouble) {
      spinsRemaining += 1;
      multiplier = Math.min(multiplier * 2, MAX_MULTIPLIER);
    }
  }

  return { totalPayoutAll, totalPayoutFiltered };
}

type Estimate = {
  avgPayoutOverBet: number;
  avgNetOverBet: number;
  lossFractionOverBet: number;
  winRate: number;
};

function estimate(cfg: GameConfig, seed: number, n: number, bet: number): Estimate {
  const rng = XorshiftRngLocal.fromSeed(seed);
  let sumPayout = 0;
  let sumNet = 0;
  let sumLoss = 0;
  let winCount = 0;

  for (let i = 0; i < n; i++) {
    const payout = simulatePlay(cfg, rng, bet);
    sumPayout += payout;
    const net = payout - bet;
    sumNet += net;
    if (net < 0) sumLoss += -net;
    if (payout > 0) winCount += 1;
  }

  return {
    avgPayoutOverBet: sumPayout / (n * bet),
    avgNetOverBet: sumNet / (n * bet),
    lossFractionOverBet: sumLoss / (n * bet),
    winRate: winCount / n,
  };
}

type SelfAgentEstimate = {
  avgWealthOverBet: number;
  avgNetOverBet: number;
  avgCommissionDeltaOverBet: number;
};

function estimateSelfAgentOnchainCommission(cfg: GameConfig, seed: number, n: number, bet: number, commissionRatePercent: number): SelfAgentEstimate {
  const rng = XorshiftRngLocal.fromSeed(seed);
  let commissionBalance = 0;
  let sumWealth = 0;
  let sumNet = 0;
  let sumCommissionDelta = 0;

  for (let i = 0; i < n; i++) {
    const payout = simulatePlay(cfg, rng, bet);
    const net = payout - bet;
    sumNet += net;

    const commissionAmount = Math.floor((Math.abs(net) * commissionRatePercent) / 100);
    const prevCommission = commissionBalance;
    if (net < 0) {
      commissionBalance += commissionAmount;
    } else if (net > 0) {
      commissionBalance = Math.max(0, commissionBalance - commissionAmount);
    }
    const deltaCommission = commissionBalance - prevCommission;
    sumCommissionDelta += deltaCommission;
    sumWealth += net + deltaCommission;
  }

  return {
    avgWealthOverBet: sumWealth / (n * bet),
    avgNetOverBet: sumNet / (n * bet),
    avgCommissionDeltaOverBet: sumCommissionDelta / (n * bet),
  };
}

function exactExpectedPayoutOverBetNoDouble(cfg: GameConfig): number {
  const weightsSum = cfg.weights.reduce((a, b) => a + b, 0);
  if (weightsSum !== WEIGHT_TOTAL) throw new Error("weights must sum to 10000");
  if (cfg.weights[SYMBOL_DOUBLE] !== 0) throw new Error("requires SYMBOL_DOUBLE weight = 0");

  const p = cfg.weights.map((w) => w / WEIGHT_TOTAL);
  let expected = 0;

  for (let a = 0; a < SYMBOL_COUNT; a++) {
    for (let b = 0; b < SYMBOL_COUNT; b++) {
      for (let c = 0; c < SYMBOL_COUNT; c++) {
        const prob = p[a] * p[b] * p[c];
        const symbols = [a, b, c];
        const { base } = calculateBasePayout(cfg, symbols, PAYOUT_BASE);
        expected += prob * (base / PAYOUT_BASE);
      }
    }
  }

  return expected;
}

function combinations<T>(items: T[], k: number): T[][] {
  const out: T[][] = [];
  const cur: T[] = [];

  function rec(start: number) {
    if (cur.length === k) {
      out.push(cur.slice());
      return;
    }
    for (let i = start; i < items.length; i++) {
      cur.push(items[i]);
      rec(i + 1);
      cur.pop();
    }
  }

  rec(0);
  return out;
}

describe("strategy_combo_bet_ev", () => {
  const defaultCfg: GameConfig = {
    weights: [2500, 2500, 250, 1600, 2150, 1000],
    payoutTriple: [220, 180, 2000, 360, 450, 0],
    payoutDouble: [65, 50, 100, 75, 85, 0],
    maxAutoSpins: 5,
  };

  it("估算默认参数下的中奖率与期望回报（Monte Carlo）", () => {
    const n = 200_000;
    const bet = 1_000_000;
    const stats = estimate(defaultCfg, 42, n, bet);

    expect(stats.winRate).to.be.greaterThan(0.05);
    expect(stats.winRate).to.be.lessThan(0.8);

    expect(stats.avgPayoutOverBet).to.be.greaterThan(0);
    expect(stats.avgPayoutOverBet).to.be.lessThan(1);
    expect(stats.avgNetOverBet).to.be.lessThan(0);
  });

  it("组合下注（拆分/混合 bet 大小）不会提高期望收益（只会因取整更差或相同）", () => {
    const n = 120_000;
    const seed = 7;

    const betAligned = 1_000_000;
    const betOff = 1_000_000 + 1;

    const aligned = estimate(defaultCfg, seed, n, betAligned);
    const off = estimate(defaultCfg, seed, n, betOff);

    expect(off.avgPayoutOverBet).to.be.at.most(aligned.avgPayoutOverBet + 0.002);

    const mixA = estimate(defaultCfg, seed, n, 500_000);
    const mixB = estimate(defaultCfg, seed, n, 1_500_000);
    const mixAvg = (mixA.avgNetOverBet + mixB.avgNetOverBet) / 2;

    expect(mixAvg).to.be.closeTo(aligned.avgNetOverBet, 0.01);
  });

  it("自有代理房卡的“亏损返佣”会提高期望收益，且佣金率足够高时可转为正收益（风险验证）", () => {
    const n = 250_000;
    const bet = 1_000_000;
    const base = estimate(defaultCfg, 42, n, bet);

    const c10 = estimateSelfAgentOnchainCommission(defaultCfg, 42, n, bet, 10);
    const c30 = estimateSelfAgentOnchainCommission(defaultCfg, 42, n, bet, 30);
    const c100 = estimateSelfAgentOnchainCommission(defaultCfg, 42, n, bet, 100);

    expect(c10.avgWealthOverBet).to.be.greaterThan(base.avgNetOverBet);
    expect(c30.avgWealthOverBet).to.be.greaterThan(c10.avgWealthOverBet);

    expect(c100.avgWealthOverBet).to.be.greaterThan(-0.01);
  });

  it("无翻倍符号时：精确枚举期望值与 Monte Carlo 结果一致（校验模型正确）", () => {
    const cfg: GameConfig = {
      weights: [3000, 3000, 500, 1500, 2000, 0],
      payoutTriple: [220, 180, 2000, 360, 450, 0],
      payoutDouble: [65, 50, 100, 75, 85, 0],
      maxAutoSpins: 5,
    };

    const exact = exactExpectedPayoutOverBetNoDouble(cfg);
    const mc = estimate(cfg, 123, 250_000, 1_000_000).avgPayoutOverBet;
    expect(mc).to.be.closeTo(exact, 0.005);
  });

  it("估算自有代理的盈亏平衡佣金率（默认参数下约为 100%）", () => {
    const bet = 1_000_000;
    const n = 180_000;
    const seed = 42;

    const r0 = estimateSelfAgentOnchainCommission(defaultCfg, seed, n, bet, 0).avgWealthOverBet;
    const r100 = estimateSelfAgentOnchainCommission(defaultCfg, seed, n, bet, 100).avgWealthOverBet;

    const slope = r100 - r0;
    const approxBreakEven = slope === 0 ? Infinity : (-r0 / slope) * 100;

    expect(approxBreakEven).to.be.greaterThan(85);
    expect(approxBreakEven).to.be.lessThan(115);
  });

  it("输出佣金率→期望收益曲线，并给出阈值建议（自有代理房卡）", () => {
    const bet = 1_000_000;
    const seed = 42;
    const n = Number.parseInt(process.env.COMMISSION_CURVE_SAMPLES ?? "50000", 10);
    const rates = Array.from({ length: 21 }, (_, i) => i * 5);

    const rows = rates.map((rate) => {
      const r = estimateSelfAgentOnchainCommission(defaultCfg, seed, n, bet, rate);
      return {
        rate,
        avgWealthOverBet: Number(r.avgWealthOverBet.toFixed(6)),
        avgCommissionDeltaOverBet: Number(r.avgCommissionDeltaOverBet.toFixed(6)),
      };
    });

    const breakEven = rows.find((x) => x.avgWealthOverBet >= 0)?.rate ?? null;
    const recommendedMax = breakEven === null ? 50 : Math.max(0, breakEven - 10);

    console.table(rows);

    expect(breakEven).to.not.equal(null);
    expect((breakEven as number) as number).to.be.greaterThan(80);
  });

  it("符号组合下注（2/3/4/5 个一组）概率/期望测试：不同组合金额不会提高期望收益", () => {
    const symbolNames = ["Cherry(樱桃)", "Lemon(柠檬)", "Seven(七)", "Bell(铃铛)", "Star(星星)", "Double(翻倍)"];
    const symbols = [0, 1, 2, 3, 4, 5];

    const seed = 7;
    const n = Number.parseInt(process.env.SYMBOL_COMBO_SAMPLES ?? "12000", 10);
    const bets = [1_000_000, 1_000_001];

    const baseline = estimate(defaultCfg, seed, n, bets[0]).avgPayoutOverBet;

    for (const k of [2, 3, 4, 5]) {
      const combos = combinations(symbols, k);
      const results: Array<{ k: number; combo: string; bet: number; avgFilteredPayoutOverBet: number }> = [];

      for (const combo of combos) {
        const allowed = new Set<number>(combo);
        for (const bet of bets) {
          const rng = XorshiftRngLocal.fromSeed(seed);
          let sumAll = 0;
          let sumFiltered = 0;
          for (let i = 0; i < n; i++) {
            const r = simulatePlayWithWinningSymbolFilter(defaultCfg, rng, bet, allowed);
            sumAll += r.totalPayoutAll;
            sumFiltered += r.totalPayoutFiltered;
          }
          const avgFiltered = sumFiltered / (n * bet);
          results.push({ k, combo: combo.map((i) => symbolNames[i]).join(" + "), bet, avgFilteredPayoutOverBet: avgFiltered });
        }
      }

      results.sort((a, b) => b.avgFilteredPayoutOverBet - a.avgFilteredPayoutOverBet);
      const top = results.slice(0, 5).map((r) => ({ ...r, avgFilteredPayoutOverBet: Number(r.avgFilteredPayoutOverBet.toFixed(6)) }));
      console.table(top);

      for (const r of results) {
        expect(r.avgFilteredPayoutOverBet).to.be.at.most(baseline + 0.01);
      }
    }
  });
});
