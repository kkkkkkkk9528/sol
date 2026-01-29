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

describe("rng_weights_payouts", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  let program: Program;
  const programId = new anchor.web3.PublicKey("8cozexydPUo9jTBT7PRWVe5Qmi3bpkjgQuPo2ZaTKHus");

  const owner = provider.wallet;
  const payer = (owner as any).payer as Keypair;
  const player = Keypair.generate();

  let gameState: PublicKey;
  let mint: PublicKey;
  let poolTokenAccount: PublicKey;
  let playerTokenAccount: PublicKey;
  let vrfPubkey: PublicKey;

  before(async () => {
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(owner.publicKey, 5 * LAMPORTS_PER_SOL)
    );

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
    program = new Program(idl, provider);

    [gameState] = PublicKey.findProgramAddressSync([Buffer.from("game_state")], program.programId);

    let gameStateAccount: any;
    try {
      gameStateAccount = await (program.account as any).gameState.fetch(gameState);
    } catch {
      gameStateAccount = null;
    }

    if (gameStateAccount) {
      mint = gameStateAccount.poolMint as PublicKey;
      poolTokenAccount = gameStateAccount.poolTokenAccount as PublicKey;
      vrfPubkey = gameStateAccount.vrf as PublicKey;
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

      vrfPubkey = anchor.web3.SystemProgram.programId;
    }

    playerTokenAccount = (
      await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, player.publicKey)
    ).address;

    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(player.publicKey, 2 * LAMPORTS_PER_SOL)
    );

    await mintTo(provider.connection, payer, mint, playerTokenAccount, owner.publicKey, 10_000_000_000);
    await mintTo(provider.connection, payer, mint, poolTokenAccount, owner.publicKey, 50_000_000_000);

    if (vrfPubkey.toString() === anchor.web3.SystemProgram.programId.toString()) {
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
    }
  });

  it("set_symbol_weights: 权重总和必须等于 10000", async () => {
    const invalidWeights = [2000, 2000, 500, 1500, 2000, 1000];
    try {
      await program.methods.setSymbolWeights(invalidWeights).accounts({ gameState, owner: owner.publicKey }).rpc();
      expect.fail("应该抛出错误");
    } catch (error) {
      expect(error.message).to.include("InvalidSymbolWeights");
    }
  });

  it("request_play: 禁止对 DOUBLE 符号下注", async () => {
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
          vrf: vrfPubkey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([player, pendingPlay])
        .rpc();
      expect.fail("应该抛出错误");
    } catch (error) {
      expect(error.message).to.include("InvalidBetTable");
    }
  });

  it("request_play: VRF 未更新时 settle_play 会失败", async () => {
    const pendingPlay = Keypair.generate();
    const bets = [new BN(1_000_000), new BN(0), new BN(0), new BN(0), new BN(0), new BN(0)];

    await program.methods
      .requestPlay(bets, null)
      .accounts({
        gameState,
        pendingPlay: pendingPlay.publicKey,
        player: player.publicKey,
        playerTokenAccount,
        poolTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        vrf: vrfPubkey,
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
          vrf: vrfPubkey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      expect.fail("应该抛出错误");
    } catch (error) {
      expect(error.message).to.include("VrfNotUpdated");
    }
  });
});
