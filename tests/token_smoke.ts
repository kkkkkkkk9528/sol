import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddress,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";
import path from "path";

describe("token_smoke", () => {
  const getProvider = (): anchor.AnchorProvider => {
    try {
      return anchor.AnchorProvider.env();
    } catch {
      const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
      const walletPath =
        process.env.ANCHOR_WALLET ??
        path.join(process.env.HOME ?? "/root", ".config/solana/id.json");
      const secretKey = Uint8Array.from(
        JSON.parse(fs.readFileSync(walletPath, "utf8"))
      );
      const keypair = Keypair.fromSecretKey(secretKey);
      const wallet = new anchor.Wallet(keypair);
      const connection = new anchor.web3.Connection(url, "confirmed");
      return new anchor.AnchorProvider(connection, wallet, {
        commitment: "confirmed",
      });
    }
  };

  const provider = getProvider();
  anchor.setProvider(provider);

  let program: Program;

  const tokenProgramId = new PublicKey(
    "DpaMzqk9F6FbDLqacVQmyf1k8DvwZ1BvtsXr6b9mWMTZ"
  );

  const mintAuthority = provider.wallet;
  const alice = Keypair.generate();
  const bob = Keypair.generate();

  let mint: PublicKey;
  let aliceAta: PublicKey;
  let bobAta: PublicKey;

  before(async () => {
    const idl = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "target/idl/slot_machine_token.json"),
        "utf8"
      )
    );
    program = new Program(idl, provider);

    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(alice.publicKey, 2 * LAMPORTS_PER_SOL)
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(bob.publicKey, 2 * LAMPORTS_PER_SOL)
    );

    const payer = (provider.wallet as any).payer as Keypair | undefined;
    expect(payer).to.not.equal(undefined);

    mint = await createMint(
      provider.connection,
      payer!,
      mintAuthority.publicKey,
      null,
      9
    );
  });

  it("initialize_token_account: creates ATAs for alice and bob", async () => {
    aliceAta = await getAssociatedTokenAddress(
      mint,
      alice.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    bobAta = await getAssociatedTokenAddress(
      mint,
      bob.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    await program.methods
      .initializeTokenAccount()
      .accounts({
        owner: alice.publicKey,
        tokenAccount: aliceAta,
        mint,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([alice])
      .rpc();

    await program.methods
      .initializeTokenAccount()
      .accounts({
        owner: bob.publicKey,
        tokenAccount: bobAta,
        mint,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([bob])
      .rpc();

    const aliceAccount = await getAccount(provider.connection, aliceAta);
    expect(aliceAccount.owner.toBase58()).to.equal(alice.publicKey.toBase58());
    expect(aliceAccount.mint.toBase58()).to.equal(mint.toBase58());

    const bobAccount = await getAccount(provider.connection, bobAta);
    expect(bobAccount.owner.toBase58()).to.equal(bob.publicKey.toBase58());
    expect(bobAccount.mint.toBase58()).to.equal(mint.toBase58());
  });

  it("mint_token -> transfer_token -> burn_token -> renounce_mint_authority", async () => {
    const mintAmount = 1_000_000_000n;
    const transferAmount = 400_000_000n;
    const burnAmount = 100_000_000n;

    await program.methods
      .mintToken(new BN(mintAmount.toString()))
      .accounts({
        mintAuthority: mintAuthority.publicKey,
        mint,
        to: aliceAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const aliceAfterMint = await getAccount(provider.connection, aliceAta);
    expect(aliceAfterMint.amount).to.equal(mintAmount);

    await program.methods
      .transferToken(new BN(transferAmount.toString()))
      .accounts({
        from: alice.publicKey,
        fromTokenAccount: aliceAta,
        toTokenAccount: bobAta,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();

    const aliceAfterTransfer = await getAccount(provider.connection, aliceAta);
    const bobAfterTransfer = await getAccount(provider.connection, bobAta);
    expect(aliceAfterTransfer.amount).to.equal(mintAmount - transferAmount);
    expect(bobAfterTransfer.amount).to.equal(transferAmount);

    const mintBeforeBurn = await getMint(provider.connection, mint);

    await program.methods
      .burnToken(new BN(burnAmount.toString()))
      .accounts({
        owner: bob.publicKey,
        tokenAccount: bobAta,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([bob])
      .rpc();

    const bobAfterBurn = await getAccount(provider.connection, bobAta);
    expect(bobAfterBurn.amount).to.equal(transferAmount - burnAmount);

    const mintAfterBurn = await getMint(provider.connection, mint);
    expect(mintAfterBurn.supply).to.equal(mintBeforeBurn.supply - burnAmount);

    await program.methods
      .renounceMintAuthority()
      .accounts({
        mintAuthority: mintAuthority.publicKey,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const mintAfterRenounce = await getMint(provider.connection, mint);
    expect(mintAfterRenounce.mintAuthority).to.equal(null);

    try {
      await program.methods
        .mintToken(new BN("1"))
        .accounts({
          mintAuthority: mintAuthority.publicKey,
          mint,
          to: aliceAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      expect.fail("mint authority 已撤销，mint_token 应该失败");
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      expect(msg.length).to.be.greaterThan(0);
    }
  });
});
