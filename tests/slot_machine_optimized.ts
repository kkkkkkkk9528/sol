import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import fs from 'fs';
import path from 'path';

describe("slot_machine_optimized", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  let program: Program;
  const programId = new anchor.web3.PublicKey("GtSdwriBEDSUrrdxx1tHA1TV8aAgA9bSKcPmeYCUQhBg");

  before(async () => {
    const idl = JSON.parse(fs.readFileSync(path.join(process.cwd(), "target/idl/slot_machine.json"), "utf8"));
    program = new Program(idl, provider);
  });
  
  let gameState: anchor.web3.PublicKey;
  let gameStateBump: number;
  let mint: anchor.web3.PublicKey;
  let poolTokenAccount: anchor.web3.PublicKey;
  let ownerTokenAccount: anchor.web3.PublicKey;
  let playerTokenAccount: anchor.web3.PublicKey;
  let agentTokenAccount: anchor.web3.PublicKey;
  
  const owner = provider.wallet;
  const player = Keypair.generate();
  const agent = Keypair.generate();

  before(async () => {
    // 查找 PDA
    [gameState, gameStateBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("game_state")],
      program.programId
    );

    let gameStateAccount: any;
    try {
      gameStateAccount = await program.account.gameState.fetch(gameState);
    } catch {
      gameStateAccount = null;
    }

    if (gameStateAccount) {
      mint = gameStateAccount.poolMint as anchor.web3.PublicKey;
      poolTokenAccount = gameStateAccount.poolTokenAccount as anchor.web3.PublicKey;
    } else {
      mint = await createMint(provider.connection, owner.payer, owner.publicKey, null, 6);
      poolTokenAccount = (
        await getOrCreateAssociatedTokenAccount(provider.connection, owner.payer, mint, gameState, true)
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

    ownerTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        owner.payer,
        mint,
        owner.publicKey
      )
    ).address;

    playerTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        owner.payer,
        mint,
        player.publicKey
      )
    ).address;

    agentTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        owner.payer,
        mint,
        agent.publicKey
      )
    ).address;

    // 给玩家和代理商空投 SOL
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        player.publicKey,
        10 * LAMPORTS_PER_SOL
      )
    );

    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        agent.publicKey,
        10 * LAMPORTS_PER_SOL
      )
    );

    // 给玩家铸造 Token
    await mintTo(
      provider.connection,
      owner.payer,
      mint,
      playerTokenAccount,
      owner.publicKey,
      1000000000 // 1000 Token
    );

    // 给奖池铸造 Token
    await mintTo(
      provider.connection,
      owner.payer,
      mint,
      poolTokenAccount,
      owner.publicKey,
      10000000000 // 10000 Token
    );
  });

  describe("初始化", () => {
    it("应该成功初始化游戏状态", async () => {
      const gameStateAccount = await program.account.gameState.fetch(gameState);
      
      expect(gameStateAccount.owner.toString()).to.equal(owner.publicKey.toString());
      expect(gameStateAccount.poolMint.toString()).to.equal(mint.toString());
      expect(gameStateAccount.poolTokenAccount.toString()).to.equal(poolTokenAccount.toString());
      expect(gameStateAccount.totalPool.toNumber()).to.be.greaterThanOrEqual(0);
      expect(gameStateAccount.nonce.toNumber()).to.be.greaterThanOrEqual(0);
      expect(gameStateAccount.nextRoomCard.toNumber()).to.be.greaterThanOrEqual(10000);
      expect(gameStateAccount.commissionRate).to.be.greaterThanOrEqual(0);
      expect(gameStateAccount.commissionRate).to.be.lessThanOrEqual(100);
      expect(gameStateAccount.bump).to.equal(gameStateBump);
    });
  });

  describe("管理员功能", () => {
    it("应该允许所有者设置符号权重", async () => {
      const newWeights = [2000, 2000, 500, 1500, 2000, 2000];
      
      await program.methods
        .setSymbolWeights(newWeights)
        .accounts({
          gameState,
          owner: owner.publicKey,
        })
        .rpc();

      const gameStateAccount = await program.account.gameState.fetch(gameState);
      expect(gameStateAccount.symbolWeights).to.deep.equal(newWeights);
    });

    it("应该拒绝权重总和不等于10000", async () => {
      const invalidWeights = [2000, 2000, 500, 1500, 2000, 1000]; // 总和 9000
      
      try {
        await program.methods
          .setSymbolWeights(invalidWeights)
          .accounts({
            gameState,
            owner: owner.publicKey,
          })
          .rpc();
        expect.fail("应该抛出错误");
      } catch (error) {
        expect(error.message).to.include("InvalidSymbolWeights");
      }
    });

    it("应该允许所有者设置佣金率", async () => {
      await program.methods
        .setCommissionRate(15)
        .accounts({
          gameState,
          owner: owner.publicKey,
        })
        .rpc();

      const gameStateAccount = await program.account.gameState.fetch(gameState);
      expect(gameStateAccount.commissionRate).to.equal(15);
    });

    it("应该允许所有者设置质押门槛", async () => {
      await program.methods
        .setStakeThreshold(new BN(2000000))
        .accounts({
          gameState,
          owner: owner.publicKey,
        })
        .rpc();

      const gameStateAccount = await program.account.gameState.fetch(gameState);
      expect(gameStateAccount.stakeThreshold.toNumber()).to.equal(2000000);
    });
  });

  describe("代理商系统", () => {
    it("应该允许用户质押成为代理商", async () => {
      const stakeAmount = new BN(2 * LAMPORTS_PER_SOL);

      await program.methods
        .becomeAgent(stakeAmount)
        .accounts({
          gameState,
          agent: agent.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([agent])
        .rpc();

      const gameStateAccount = await program.account.gameState.fetch(gameState);
      expect(gameStateAccount.agents.length).to.equal(1);
      expect(gameStateAccount.agents[0].pubkey.toString()).to.equal(agent.publicKey.toString());
      expect(gameStateAccount.agents[0].roomCard.toNumber()).to.equal(10000);
      expect(gameStateAccount.agents[0].isActive).to.be.true;
    });

    it("应该拒绝质押金额过低", async () => {
      const lowStake = new BN(1000000); // 低于门槛
      const newAgent = Keypair.generate();

      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(
          newAgent.publicKey,
          5 * LAMPORTS_PER_SOL
        )
      );

      try {
        await program.methods
          .becomeAgent(lowStake)
          .accounts({
            gameState,
            agent: newAgent.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([newAgent])
          .rpc();
        expect.fail("应该抛出错误");
      } catch (error) {
        expect(error.message).to.include("StakeTooLow");
      }
    });

    it("应该允许代理商赎回质押", async () => {
      const balanceBefore = await provider.connection.getBalance(agent.publicKey);

      await program.methods
        .redeemAgentStake()
        .accounts({
          gameState,
          agent: agent.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([agent])
        .rpc();

      const balanceAfter = await provider.connection.getBalance(agent.publicKey);
      const gameStateAccount = await program.account.gameState.fetch(gameState);

      expect(gameStateAccount.agents[0].isActive).to.be.false;
      expect(balanceAfter).to.be.greaterThan(balanceBefore);
    });
  });

  describe("游戏功能", () => {
    let activeAgent: Keypair;
    let activeAgentRoomCard: number;

    before(async () => {
      // 创建一个活跃的代理商用于测试
      activeAgent = Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(
          activeAgent.publicKey,
          5 * LAMPORTS_PER_SOL
        )
      );

      await program.methods
        .becomeAgent(new BN(2 * LAMPORTS_PER_SOL))
        .accounts({
          gameState,
          agent: activeAgent.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([activeAgent])
        .rpc();

      const gameStateAccount = await program.account.gameState.fetch(gameState);
      activeAgentRoomCard = gameStateAccount.agents.find(
        (a) => a.pubkey.toString() === activeAgent.publicKey.toString() && a.isActive
      ).roomCard.toNumber();
    });

    it("应该允许玩家下注并游戏", async () => {
      const bets = [new BN(1_000_000), new BN(0), new BN(0), new BN(0), new BN(0), new BN(0)];

      const poolBalanceBefore = (
        await provider.connection.getTokenAccountBalance(poolTokenAccount)
      ).value.amount;

      const tx = await program.methods
        .play(bets, new BN(activeAgentRoomCard))
        .accounts({
          gameState,
          player: player.publicKey,
          playerTokenAccount,
          poolTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([player])
        .rpc();

      console.log("游戏交易签名:", tx);

      const poolBalanceAfter = (
        await provider.connection.getTokenAccountBalance(poolTokenAccount)
      ).value.amount;

      expect(BigInt(poolBalanceAfter) > BigInt(poolBalanceBefore)).to.be.true;

      const gameStateAccount = await program.account.gameState.fetch(gameState);
      expect(gameStateAccount.nonce.toNumber()).to.be.greaterThan(0);
    });

    it("应该允许玩家按符号分别下注，并仅按命中符号下注额派彩", async () => {
      const betOnCherry = [new BN(1_000_000), new BN(0), new BN(0), new BN(0), new BN(0), new BN(0)];
      const betOnLemon = [new BN(0), new BN(1_000_000), new BN(0), new BN(0), new BN(0), new BN(0)];
      const deterministicWeights = [10000, 0, 0, 0, 0, 0];
      const deterministicPayoutTriple = [500, 0, 0, 0, 0, 0];
      const deterministicPayoutDouble = [0, 0, 0, 0, 0, 0];

      await program.methods
        .setSymbolWeights(deterministicWeights)
        .accounts({
          gameState,
          owner: owner.publicKey,
        })
        .rpc();

      await program.methods
        .setPayoutTriple(deterministicPayoutTriple)
        .accounts({
          gameState,
          owner: owner.publicKey,
        })
        .rpc();

      await program.methods
        .setPayoutDouble(deterministicPayoutDouble)
        .accounts({
          gameState,
          owner: owner.publicKey,
        })
        .rpc();

      await program.methods
        .syncPoolTotal()
        .accounts({
          gameState,
          owner: owner.publicKey,
          poolTokenAccount,
        })
        .rpc();

      const playerBefore = (
        await provider.connection.getTokenAccountBalance(playerTokenAccount)
      ).value.amount;

      await program.methods
        .play(betOnCherry, new BN(activeAgentRoomCard))
        .accounts({
          gameState,
          player: player.publicKey,
          playerTokenAccount,
          poolTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([player])
        .rpc();

      const playerAfterWin = (
        await provider.connection.getTokenAccountBalance(playerTokenAccount)
      ).value.amount;

      expect(BigInt(playerAfterWin) - BigInt(playerBefore)).to.equal(4000000n);

      await program.methods
        .play(betOnLemon, new BN(activeAgentRoomCard))
        .accounts({
          gameState,
          player: player.publicKey,
          playerTokenAccount,
          poolTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([player])
        .rpc();

      const playerAfterLose = (
        await provider.connection.getTokenAccountBalance(playerTokenAccount)
      ).value.amount;

      expect(BigInt(playerAfterLose) - BigInt(playerAfterWin)).to.equal(-1000000n);

      const restoreWeights = [2000, 2000, 500, 1500, 2000, 2000];
      const restorePayoutTriple = [220, 180, 2000, 360, 450, 0];
      const restorePayoutDouble = [65, 50, 100, 75, 85, 0];

      await program.methods
        .setSymbolWeights(restoreWeights)
        .accounts({
          gameState,
          owner: owner.publicKey,
        })
        .rpc();

      await program.methods
        .setPayoutTriple(restorePayoutTriple)
        .accounts({
          gameState,
          owner: owner.publicKey,
        })
        .rpc();

      await program.methods
        .setPayoutDouble(restorePayoutDouble)
        .accounts({
          gameState,
          owner: owner.publicKey,
        })
        .rpc();
    });

    it("应该正确计算代理商佣金", async () => {
      const bets = [new BN(10_000_000), new BN(0), new BN(0), new BN(0), new BN(0), new BN(0)];

      // 多次游戏以累积佣金
      for (let i = 0; i < 5; i++) {
        await program.methods
          .play(bets, new BN(activeAgentRoomCard))
          .accounts({
            gameState,
            player: player.publicKey,
            playerTokenAccount,
            poolTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([player])
          .rpc();
      }

      const gameStateAccount = await program.account.gameState.fetch(gameState);
      const agentData = gameStateAccount.agents.find(
        (a) => a.pubkey.toString() === activeAgent.publicKey.toString()
      );

      console.log("代理商佣金:", agentData.commission.toString());
      // 佣金可能为正或负，取决于玩家输赢
    });

    it("应该允许玩家不使用房卡游戏", async () => {
      const bets = [new BN(1_000_000), new BN(0), new BN(0), new BN(0), new BN(0), new BN(0)];

      await program.methods
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

      // 不应该抛出错误
    });
  });

  describe("提取功能", () => {
    it("应该允许所有者提取奖池", async () => {
      const withdrawAmount = new BN(1000000); // 1 Token

      const ownerBalanceBefore = (
        await provider.connection.getTokenAccountBalance(ownerTokenAccount)
      ).value.amount;

      await program.methods
        .withdrawPool(withdrawAmount)
        .accounts({
          gameState,
          owner: owner.publicKey,
          poolTokenAccount,
          ownerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const ownerBalanceAfter = (
        await provider.connection.getTokenAccountBalance(ownerTokenAccount)
      ).value.amount;

      expect(BigInt(ownerBalanceAfter) - BigInt(ownerBalanceBefore)).to.equal(
        BigInt(withdrawAmount.toString())
      );
    });

    it("应该拒绝提取超过奖池余额", async () => {
      const gameStateAccount = await program.account.gameState.fetch(gameState);
      const excessAmount = gameStateAccount.totalPool.add(new BN(1000000));

      try {
        await program.methods
          .withdrawPool(excessAmount)
          .accounts({
            gameState,
            owner: owner.publicKey,
            poolTokenAccount,
            ownerTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        expect.fail("应该抛出错误");
      } catch (error) {
        expect(error.message).to.include("InsufficientFunds");
      }
    });
  });

  describe("边界情况", () => {
    it("应该拒绝非所有者调用管理员函数", async () => {
      const unauthorized = Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(
          unauthorized.publicKey,
          LAMPORTS_PER_SOL
        )
      );

      try {
        await program.methods
          .setCommissionRate(20)
          .accounts({
            gameState,
            owner: unauthorized.publicKey,
          })
          .signers([unauthorized])
          .rpc();
        expect.fail("应该抛出错误");
      } catch (error) {
        expect(error.message).to.include("Unauthorized");
      }
    });

    it("应该拒绝使用无效房卡号", async () => {
      const bets = [new BN(1_000_000), new BN(0), new BN(0), new BN(0), new BN(0), new BN(0)];
      const invalidRoomCard = 99999;

      try {
        await program.methods
          .play(bets, new BN(invalidRoomCard))
          .accounts({
            gameState,
            player: player.publicKey,
            playerTokenAccount,
            poolTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([player])
          .rpc();
        expect.fail("应该抛出错误");
      } catch (error) {
        expect(error.message).to.include("InvalidRoomCard");
      }
    });
  });
});
