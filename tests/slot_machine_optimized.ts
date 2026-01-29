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
  const programId = new anchor.web3.PublicKey("8cozexydPUo9jTBT7PRWVe5Qmi3bpkjgQuPo2ZaTKHus");

  before(async () => {
    const idl = JSON.parse(fs.readFileSync(path.join(process.cwd(), "target/idl/slot_machine.json"), "utf8"));
    const typesByName = new Map((idl.types ?? []).map((t: any) => [t.name, t.type]));
    for (const acc of idl.accounts ?? []) {
      if (!acc.type) {
        const t = typesByName.get(acc.name);
        if (t) acc.type = t;
      }
    }
    idl.address = programId.toBase58();
    program = new Program(idl, provider);
  });
  
  let gameState: anchor.web3.PublicKey;
  let gameStateBump: number;
  let mint: anchor.web3.PublicKey;
  let poolTokenAccount: anchor.web3.PublicKey;
  let ownerTokenAccount: anchor.web3.PublicKey;
  let playerTokenAccount: anchor.web3.PublicKey;
  let agentTokenAccount: anchor.web3.PublicKey;
  let vrf: Keypair;
  
  const owner = provider.wallet;
  const payer = (owner as any).payer as Keypair;
  const player = Keypair.generate();
  const agent = Keypair.generate();

  before(async () => {
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(owner.publicKey, 5 * LAMPORTS_PER_SOL)
    );

    // 查找 PDA
    [gameState, gameStateBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("game_state")],
      program.programId
    );

    let gameStateAccount: any;
    try {
      gameStateAccount = await (program.account as any).gameState.fetch(gameState);
    } catch {
      gameStateAccount = null;
    }

    if (gameStateAccount) {
      mint = gameStateAccount.poolMint as anchor.web3.PublicKey;
      poolTokenAccount = gameStateAccount.poolTokenAccount as anchor.web3.PublicKey;
    } else {
      mint = await createMint(provider.connection, payer, owner.publicKey, null, 6);
      poolTokenAccount = (
        await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, gameState, true)
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
        payer,
        mint,
        owner.publicKey
      )
    ).address;

    playerTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        mint,
        player.publicKey
      )
    ).address;

    agentTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
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
      payer,
      mint,
      playerTokenAccount,
      owner.publicKey,
      1000000000 // 1000 Token
    );

    // 给奖池铸造 Token
    await mintTo(
      provider.connection,
      payer,
      mint,
      poolTokenAccount,
      owner.publicKey,
      10000000000 // 10000 Token
    );

    vrf = Keypair.generate();
    const vrfSpace = 64;
    const vrfRent = await provider.connection.getMinimumBalanceForRentExemption(vrfSpace);
    const switchboardV2ProgramId = new anchor.web3.PublicKey(
      "SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f"
    );
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.createAccount({
          fromPubkey: owner.publicKey,
          newAccountPubkey: vrf.publicKey,
          lamports: vrfRent,
          space: vrfSpace,
          programId: switchboardV2ProgramId,
        })
      ),
      [vrf]
    );

    await program.methods
      .setVrf(vrf.publicKey, 0)
      .accounts({
        gameState,
        owner: owner.publicKey,
      })
      .rpc();
  });

  describe("初始化", () => {
    it("应该成功初始化游戏状态", async () => {
      const gameStateAccount = await (program.account as any).gameState.fetch(gameState);
      
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

      const gameStateAccount = await (program.account as any).gameState.fetch(gameState);
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

      const gameStateAccount = await (program.account as any).gameState.fetch(gameState);
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

      const gameStateAccount = await (program.account as any).gameState.fetch(gameState);
      expect(gameStateAccount.stakeThreshold.toNumber()).to.equal(2000000);
    });

    it("应该允许所有者设置最低下注额", async () => {
      await program.methods
        .setMinBet(new BN(2_000_000))
        .accounts({
          gameState,
          owner: owner.publicKey,
        })
        .rpc();

      const gameStateAccount = await (program.account as any).gameState.fetch(gameState);
      expect(gameStateAccount.minBet.toString()).to.equal("2000000");

      await program.methods
        .setMinBet(new BN(1))
        .accounts({
          gameState,
          owner: owner.publicKey,
        })
        .rpc();
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

      const gameStateAccount = await (program.account as any).gameState.fetch(gameState);
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
        expect(error.message).to.include("StakeBelowThreshold");
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
      const gameStateAccount = await (program.account as any).gameState.fetch(gameState);

      expect(gameStateAccount.agents[0].stake.toString()).to.equal("0");
      expect(gameStateAccount.agents[0].roomCard.toNumber()).to.equal(0);
      expect(gameStateAccount.agents[0].commission.toString()).to.equal("0");
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

      const gameStateAccount = await (program.account as any).gameState.fetch(gameState);
      activeAgentRoomCard = gameStateAccount.agents.find(
        (a) => a.pubkey.toString() === activeAgent.publicKey.toString() && a.isActive
      ).roomCard.toNumber();
    });

    it("request_play/settle_play: settle 在 VRF 未更新时失败", async () => {
      const pendingPlay = Keypair.generate();
      const bets = [new BN(1_000_000), new BN(0), new BN(0), new BN(0), new BN(0), new BN(0)];

      await program.methods
        .requestPlay(bets, new BN(activeAgentRoomCard))
        .accounts({
          gameState,
          pendingPlay: pendingPlay.publicKey,
          player: player.publicKey,
          playerTokenAccount,
          poolTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          vrf: vrf.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([player, pendingPlay])
        .rpc();

      try {
        await program.methods
          .settlePlay()
          .accounts({
            gameState,
            pendingPlay: pendingPlay.publicKey,
            player: player.publicKey,
            playerTokenAccount,
            poolTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            vrf: vrf.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .rpc();
        expect.fail("应该抛出错误");
      } catch (error) {
        expect(error.message).to.include("VrfNotUpdated");
      }
    });

    it("request_play 会把下注转入奖池并创建 PendingPlay；settle_play 在 VRF 未更新时失败", async () => {
      const pendingPlay = Keypair.generate();
      const bets = [new BN(1_000_000), new BN(0), new BN(0), new BN(0), new BN(0), new BN(0)];

      const playerBefore = (
        await provider.connection.getTokenAccountBalance(playerTokenAccount)
      ).value.amount;
      const poolBefore = (await provider.connection.getTokenAccountBalance(poolTokenAccount)).value.amount;

      await program.methods
        .requestPlay(bets, null)
        .accounts({
          gameState,
          pendingPlay: pendingPlay.publicKey,
          player: player.publicKey,
          playerTokenAccount,
          poolTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          vrf: vrf.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([player, pendingPlay])
        .rpc();

      const playerAfterRequest = (
        await provider.connection.getTokenAccountBalance(playerTokenAccount)
      ).value.amount;
      const poolAfterRequest = (
        await provider.connection.getTokenAccountBalance(poolTokenAccount)
      ).value.amount;

      expect(BigInt(playerAfterRequest)).to.equal(BigInt(playerBefore) - 1_000_000n);
      expect(BigInt(poolAfterRequest)).to.equal(BigInt(poolBefore) + 1_000_000n);

      const pending = await (program.account as any).pendingPlay.fetch(pendingPlay.publicKey);
      expect(pending.player.toString()).to.equal(player.publicKey.toString());
      expect(pending.totalBet.toString()).to.equal("1000000");
      expect(pending.hasRoomCard).to.equal(false);

      try {
        await program.methods
          .settlePlay()
          .accounts({
            gameState,
            pendingPlay: pendingPlay.publicKey,
            player: player.publicKey,
            playerTokenAccount,
            poolTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            vrf: vrf.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .rpc();
        expect.fail("应该抛出错误");
      } catch (error) {
        expect(error.message).to.include("VrfNotUpdated");
      }
    });

    it("request_play 应拒绝对 DOUBLE 符号下注", async () => {
      const pendingPlay = Keypair.generate();
      const bets = [new BN(0), new BN(0), new BN(0), new BN(0), new BN(0), new BN(1_000_000)];

      try {
        await program.methods
          .requestPlay(bets, null)
          .accounts({
            gameState,
            pendingPlay: pendingPlay.publicKey,
            player: player.publicKey,
            playerTokenAccount,
            poolTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            vrf: vrf.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([player, pendingPlay])
          .rpc();
        expect.fail("应该抛出错误");
      } catch (error) {
        expect(error.message).to.include("InvalidBetTable");
      }
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
      const gameStateAccount = await (program.account as any).gameState.fetch(gameState);
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
        expect(error.message).to.include("InsufficientPool");
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

    it("request_play 应拒绝总下注为 0", async () => {
      const pendingPlay = Keypair.generate();
      const bets = [new BN(0), new BN(0), new BN(0), new BN(0), new BN(0), new BN(0)];

      try {
        await program.methods
          .requestPlay(bets, null)
          .accounts({
            gameState,
            pendingPlay: pendingPlay.publicKey,
            player: player.publicKey,
            playerTokenAccount,
            poolTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            vrf: vrf.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([player, pendingPlay])
          .rpc();
        expect.fail("应该抛出错误");
      } catch (error) {
        expect(error.message).to.include("InvalidAmount");
      }
    });

    it("request_play 应拒绝低于最低下注额", async () => {
      await program.methods
        .setMinBet(new BN(2_000_000))
        .accounts({
          gameState,
          owner: owner.publicKey,
        })
        .rpc();

      const pendingPlay = Keypair.generate();
      const bets = [new BN(1_000_000), new BN(0), new BN(0), new BN(0), new BN(0), new BN(0)];

      try {
        await program.methods
          .requestPlay(bets, null)
          .accounts({
            gameState,
            pendingPlay: pendingPlay.publicKey,
            player: player.publicKey,
            playerTokenAccount,
            poolTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            vrf: vrf.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([player, pendingPlay])
          .rpc();
        expect.fail("应该抛出错误");
      } catch (error) {
        expect(error.message).to.include("BetBelowMinimum");
      } finally {
        await program.methods
          .setMinBet(new BN(1))
          .accounts({
            gameState,
            owner: owner.publicKey,
          })
          .rpc();
      }
    });

    it("request_play: 逐项校验最低下注额（拆分下注也应拒绝）", async () => {
      await program.methods
        .setMinBet(new BN(2_000_000))
        .accounts({
          gameState,
          owner: owner.publicKey,
        })
        .rpc();

      const pendingPlay = Keypair.generate();
      const bets = [new BN(1_000_000), new BN(1_000_000), new BN(0), new BN(0), new BN(0), new BN(0)];

      try {
        await program.methods
          .requestPlay(bets, null)
          .accounts({
            gameState,
            pendingPlay: pendingPlay.publicKey,
            player: player.publicKey,
            playerTokenAccount,
            poolTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            vrf: vrf.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([player, pendingPlay])
          .rpc();
        expect.fail("应该抛出错误");
      } catch (error) {
        expect(error.message).to.include("BetBelowMinimum");
      } finally {
        await program.methods
          .setMinBet(new BN(1))
          .accounts({
            gameState,
            owner: owner.publicKey,
          })
          .rpc();
      }
    });
  });
});
