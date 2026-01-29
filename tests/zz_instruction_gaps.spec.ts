import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";
import path from "path";

describe("instruction_gaps", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const programId = new anchor.web3.PublicKey("8cozexydPUo9jTBT7PRWVe5Qmi3bpkjgQuPo2ZaTKHus");
  const owner = provider.wallet;
  const payer = (owner as any).payer as Keypair;
  const player = Keypair.generate();

  let program: Program;
  let gameState: PublicKey;
  let mint: PublicKey;
  let poolTokenAccount: PublicKey;
  let ownerTokenAccount: PublicKey;
  let playerTokenAccount: PublicKey;
  let vrfPubkey: PublicKey;

  async function loadProgram(): Promise<Program> {
    const idl = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "target/idl/slot_machine.json"), "utf8")
    );
    const typesByName = new Map((idl.types ?? []).map((t: any) => [t.name, t.type]));
    for (const acc of idl.accounts ?? []) {
      if (!acc.type) {
        const t = typesByName.get(acc.name);
        if (t) acc.type = t;
      }
    }
    idl.address = programId.toBase58();
    return new Program(idl, provider);
  }

  async function fetchState(): Promise<any> {
    return await (program.account as any).gameState.fetch(gameState);
  }

  async function getTokenAmount(account: PublicKey): Promise<bigint> {
    const v = (await provider.connection.getTokenAccountBalance(account)).value.amount;
    return BigInt(v);
  }

  before(async () => {
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(owner.publicKey, 5 * LAMPORTS_PER_SOL)
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(player.publicKey, 5 * LAMPORTS_PER_SOL)
    );

    program = await loadProgram();
    expect(program.programId.toBase58()).to.equal(programId.toBase58());
    [gameState] = PublicKey.findProgramAddressSync([Buffer.from("game_state")], program.programId);

    let state: any;
    try {
      state = await fetchState();
    } catch {
      state = null;
    }

    if (state) {
      mint = state.poolMint as PublicKey;
      poolTokenAccount = state.poolTokenAccount as PublicKey;
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
          poolTokenAccount,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    }

    ownerTokenAccount = (
      await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, owner.publicKey)
    ).address;
    playerTokenAccount = (
      await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, player.publicKey)
    ).address;

    await mintTo(provider.connection, payer, mint, playerTokenAccount, owner.publicKey, 10_000_000_000);
    await mintTo(provider.connection, payer, mint, poolTokenAccount, owner.publicKey, 50_000_000_000);

    state = await fetchState();
    if ((state.vrf as PublicKey).equals(anchor.web3.SystemProgram.programId)) {
      const vrf = Keypair.generate();
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

      await program.methods.setVrf(vrf.publicKey, 0).accounts({ gameState, owner: owner.publicKey }).rpc();
      vrfPubkey = vrf.publicKey;
    } else {
      vrfPubkey = state.vrf as PublicKey;
    }
  });

  it("set_payout_triple / set_payout_double: 可更新并恢复", async () => {
    const prev = await fetchState();
    const prevTriple = prev.payoutTriple as number[];
    const prevDouble = prev.payoutDouble as number[];

    const nextTriple = [221, 181, 2001, 361, 451, 0];
    const nextDouble = [66, 51, 101, 76, 86, 0];

    try {
      await program.methods
        .setPayoutTriple(nextTriple)
        .accounts({ gameState, owner: owner.publicKey })
        .rpc();
    } catch (e: any) {
      const logs = e?.logs ? `\nlogs:\n${e.logs.join("\n")}` : "";
      throw new Error(`setPayoutTriple failed: ${e}${logs}`);
    }
    await program.methods
      .setPayoutDouble(nextDouble)
      .accounts({ gameState, owner: owner.publicKey })
      .rpc();

    const state = await fetchState();
    expect(state.payoutTriple).to.deep.equal(nextTriple);
    expect(state.payoutDouble).to.deep.equal(nextDouble);

    await program.methods
      .setPayoutTriple(prevTriple)
      .accounts({ gameState, owner: owner.publicKey })
      .rpc();
    await program.methods
      .setPayoutDouble(prevDouble)
      .accounts({ gameState, owner: owner.publicKey })
      .rpc();
  });

  it("sync_pool_total: 可同步链上奖池余额到 total_pool", async () => {
    const extra = 123_456_789;
    const before = await fetchState();
    const beforePool = await getTokenAmount(poolTokenAccount);

    await mintTo(provider.connection, payer, mint, poolTokenAccount, owner.publicKey, extra);
    const afterMintPool = await getTokenAmount(poolTokenAccount);
    expect(afterMintPool).to.equal(beforePool + BigInt(extra));

    await program.methods
      .syncPoolTotal()
      .accounts({ gameState, owner: owner.publicKey, poolTokenAccount })
      .rpc();

    const after = await fetchState();
    expect(after.totalPool.toString()).to.equal(afterMintPool.toString());
    expect(after.totalPool.toString()).to.not.equal(before.totalPool.toString());
  });

  it("set_payment_token: 可切换支付 mint/奖池账户并恢复", async () => {
    const prev = await fetchState();
    const prevMint = prev.poolMint as PublicKey;
    const prevPool = prev.poolTokenAccount as PublicKey;

    const mint2 = await createMint(provider.connection, payer, owner.publicKey, null, 6);
    const pool2 = (
      await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint2, gameState, true)
    ).address;
    await mintTo(provider.connection, payer, mint2, pool2, owner.publicKey, 7_000_000_000);

    await program.methods
      .setPaymentToken()
      .accounts({
        gameState,
        owner: owner.publicKey,
        tokenMint: mint2,
        poolTokenAccount: pool2,
      })
      .rpc();

    let state = await fetchState();
    expect((state.poolMint as PublicKey).toBase58()).to.equal(mint2.toBase58());
    expect((state.poolTokenAccount as PublicKey).toBase58()).to.equal(pool2.toBase58());
    expect(state.totalPool.toString()).to.equal((await getTokenAmount(pool2)).toString());

    await program.methods
      .setPaymentToken()
      .accounts({
        gameState,
        owner: owner.publicKey,
        tokenMint: prevMint,
        poolTokenAccount: prevPool,
      })
      .rpc();

    state = await fetchState();
    mint = state.poolMint as PublicKey;
    poolTokenAccount = state.poolTokenAccount as PublicKey;
    ownerTokenAccount = (
      await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, owner.publicKey)
    ).address;
    playerTokenAccount = (
      await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, player.publicKey)
    ).address;
  });

  it("play: 即时玩法可执行且玩家/奖池余额守恒", async () => {
    const bets = [new BN(1_000_000), new BN(0), new BN(0), new BN(0), new BN(0), new BN(0)];
    await mintTo(provider.connection, payer, mint, playerTokenAccount, owner.publicKey, 2_000_000_000);
    await mintTo(provider.connection, payer, mint, poolTokenAccount, owner.publicKey, 50_000_000_000);

    const playerBefore = await getTokenAmount(playerTokenAccount);
    const poolBefore = await getTokenAmount(poolTokenAccount);

    await program.methods
      .play(bets, null)
      .accounts({
        gameState,
        player: player.publicKey,
        playerTokenAccount,
        poolTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        vrf: vrfPubkey,
      })
      .signers([player])
      .rpc();

    const playerAfter = await getTokenAmount(playerTokenAccount);
    const poolAfter = await getTokenAmount(poolTokenAccount);
    expect(playerAfter + poolAfter).to.equal(playerBefore + poolBefore);
    expect(playerAfter.toString()).to.not.equal(playerBefore.toString());
  });

  it("close_game: 可清空奖池并置 total_pool=0，且可恢复", async () => {
    await mintTo(provider.connection, payer, mint, poolTokenAccount, owner.publicKey, 9_000_000_000);
    await program.methods
      .syncPoolTotal()
      .accounts({ gameState, owner: owner.publicKey, poolTokenAccount })
      .rpc();

    const poolBefore = await getTokenAmount(poolTokenAccount);
    const ownerBefore = await getTokenAmount(ownerTokenAccount);

    await program.methods
      .closeGame()
      .accounts({
        gameState,
        owner: owner.publicKey,
        poolTokenAccount,
        ownerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const poolAfter = await getTokenAmount(poolTokenAccount);
    const ownerAfter = await getTokenAmount(ownerTokenAccount);
    expect(poolAfter).to.equal(0n);
    expect(ownerAfter).to.equal(ownerBefore + poolBefore);

    await mintTo(provider.connection, payer, mint, poolTokenAccount, owner.publicKey, 10_000_000_000);
    await program.methods
      .initialize()
      .accounts({
        gameState,
        user: owner.publicKey,
        tokenMint: mint,
        poolTokenAccount,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    await program.methods.setVrf(vrfPubkey, 0).accounts({ gameState, owner: owner.publicKey }).rpc();
  });
});
