use anchor_lang::prelude::*;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use solana_program::{
    account_info::next_account_info,
    entrypoint::ProgramResult,
    program_option::COption,
    program_pack::Pack,
    pubkey::Pubkey,
};
use solana_program_test::*;
use solana_sdk::{
    account::Account as SolanaAccount,
    signature::{Keypair, Signer},
    system_program,
    transaction::Transaction,
};
use spl_token::state::{Account as TokenAccount, AccountState, Mint};

fn slot_machine_process<'a, 'b, 'c, 'd>(
    program_id: &'a Pubkey,
    accounts: &'b [AccountInfo<'c>],
    data: &'d [u8],
) -> ProgramResult {
    let accounts: &'c [AccountInfo<'c>] = unsafe { std::mem::transmute(accounts) };
    slot_machine::entry(program_id, accounts, data)
}

fn mock_switchboard_process<'a, 'b, 'c, 'd>(
    program_id: &'a Pubkey,
    accounts: &'b [AccountInfo<'c>],
    data: &'d [u8],
) -> ProgramResult {
    let accounts: &'c [AccountInfo<'c>] = unsafe { std::mem::transmute(accounts) };
    let accounts_iter = &mut accounts.iter();
    let vrf = next_account_info(accounts_iter)?;
    if vrf.owner != program_id {
        return Err(solana_program::program_error::ProgramError::IncorrectProgramId);
    }
    if data.len() != 4 + 32 {
        return Err(solana_program::program_error::ProgramError::InvalidInstructionData);
    }
    let offset = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
    let mut vrf_data = vrf.try_borrow_mut_data()?;
    if vrf_data.len() < offset + 32 {
        return Err(solana_program::program_error::ProgramError::InvalidAccountData);
    }
    vrf_data[offset..offset + 32].copy_from_slice(&data[4..]);
    Ok(())
}

fn pack_mint(mint_authority: Pubkey, decimals: u8) -> Vec<u8> {
    let mint = Mint {
        mint_authority: COption::Some(mint_authority),
        supply: 0,
        decimals,
        is_initialized: true,
        freeze_authority: COption::None,
    };
    let mut data = vec![0u8; Mint::LEN];
    Mint::pack(mint, &mut data).unwrap();
    data
}

fn pack_token_account(mint: Pubkey, owner: Pubkey, amount: u64) -> Vec<u8> {
    let token = TokenAccount {
        mint,
        owner,
        amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut data = vec![0u8; TokenAccount::LEN];
    TokenAccount::pack(token, &mut data).unwrap();
    data
}

#[tokio::test]
async fn request_play_rejects_using_non_pool_account() {
    let program_id = slot_machine::id();
    let mut program_test = ProgramTest::new("slot_machine", program_id, processor!(slot_machine_process));
    program_test.add_program("spl_token", spl_token::id(), processor!(spl_token::processor::Processor::process));
    program_test.add_program(
        "switchboard_v2_mock",
        slot_machine::SWITCHBOARD_V2_PROGRAM_ID,
        processor!(mock_switchboard_process),
    );

    let owner = Keypair::new();
    let agent = Keypair::new();
    let player = Keypair::new();

    let mint = Pubkey::new_unique();
    let real_pool_token_account = Pubkey::new_unique();
    let player_token_account = Pubkey::new_unique();

    let (game_state, bump) = Pubkey::find_program_address(&[b"game_state"], &program_id);

    program_test.add_account(
        mint,
        SolanaAccount {
            lamports: 1_000_000_000,
            data: pack_mint(Pubkey::new_unique(), 6),
            owner: spl_token::id(),
            executable: false,
            rent_epoch: 0,
        },
    );

    program_test.add_account(
        player.pubkey(),
        SolanaAccount {
            lamports: 2_000_000_000,
            data: vec![],
            owner: system_program::id(),
            executable: false,
            rent_epoch: 0,
        },
    );

    let player_amount_before: u64 = 10_000_000;
    program_test.add_account(
        player_token_account,
        SolanaAccount {
            lamports: 1_000_000_000,
            data: pack_token_account(mint, player.pubkey(), player_amount_before),
            owner: spl_token::id(),
            executable: false,
            rent_epoch: 0,
        },
    );

    program_test.add_account(
        real_pool_token_account,
        SolanaAccount {
            lamports: 1_000_000_000,
            data: pack_token_account(mint, game_state, 0),
            owner: spl_token::id(),
            executable: false,
            rent_epoch: 0,
        },
    );

    let mut game_state_data = vec![0u8; 8 + 4096];
    {
        let mut cursor = std::io::Cursor::new(&mut game_state_data[..]);
        let state = slot_machine::GameState {
            owner: owner.pubkey(),
            bump,
            pool_mint: mint,
            pool_token_account: real_pool_token_account,
            total_pool: 0,
            nonce: 0,
            agents: vec![slot_machine::Agent {
                pubkey: agent.pubkey(),
                stake: 0,
                room_card: 10000,
                commission: 0,
                stake_time: 0,
                last_settlement: 0,
                is_active: true,
            }],
            next_room_card: 10001,
            commission_rate: 10,
            stake_threshold: 1_000_000,
            settlement_period: 86_400,
            vrf: Pubkey::default(),
            vrf_result_offset: 0,
            symbol_weights: [2500, 2500, 250, 1600, 2150, 1000],
            payout_triple: [0, 0, 0, 0, 0, 0],
            payout_double: [0, 0, 0, 0, 0, 0],
            max_auto_spins: 1,
            min_bet: 100,
        };
        state.try_serialize(&mut cursor).unwrap();
    }

    program_test.add_account(
        game_state,
        SolanaAccount {
            lamports: 1_000_000_000,
            data: game_state_data,
            owner: program_id,
            executable: false,
            rent_epoch: 0,
        },
    );

    let mut context = program_test.start_with_context().await;

    let pending_play = Keypair::new();
    let bet: u64 = 1_000_000;
    let bets: [u64; 6] = [bet, 0, 0, 0, 0, 0];

    let ix = solana_sdk::instruction::Instruction {
        program_id,
        accounts: slot_machine::accounts::RequestPlay {
            game_state,
            pending_play: pending_play.pubkey(),
            player: player.pubkey(),
            player_token_account,
            pool_token_account: player_token_account,
            token_program: spl_token::id(),
            vrf: Pubkey::new_unique(),
            system_program: system_program::id(),
        }
        .to_account_metas(None),
        data: slot_machine::instruction::RequestPlay { bets, room_card: None }.data(),
    };

    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, &player, &pending_play],
        context.last_blockhash,
    );
    assert!(context.banks_client.process_transaction(tx).await.is_err());

    let state_acc = context.banks_client.get_account(game_state).await.unwrap().unwrap();
    let mut state_data_slice: &[u8] = &state_acc.data;
    let state = slot_machine::GameState::try_deserialize(&mut state_data_slice).unwrap();

    assert_eq!(state.total_pool, 0);
    let agent_state = state.agents.iter().find(|a| a.pubkey == agent.pubkey()).unwrap();
    assert_eq!(agent_state.commission, 0);

    let player_acc = context
        .banks_client
        .get_account(player_token_account)
        .await
        .unwrap()
        .unwrap();
    let player_token = TokenAccount::unpack(&player_acc.data).unwrap();
    assert_eq!(player_token.amount, player_amount_before);
}

#[tokio::test]
async fn request_settle_requires_vrf_update_and_transfers_bet_once() {
    let program_id = slot_machine::id();
    let mut program_test = ProgramTest::new("slot_machine", program_id, processor!(slot_machine_process));
    program_test.add_program("spl_token", spl_token::id(), processor!(spl_token::processor::Processor::process));
    program_test.add_program(
        "switchboard_v2_mock",
        slot_machine::SWITCHBOARD_V2_PROGRAM_ID,
        processor!(mock_switchboard_process),
    );

    let owner = Keypair::new();
    let player = Keypair::new();
    let agent = Keypair::new();
    let pending_play = Keypair::new();

    let mint = Pubkey::new_unique();
    let vrf = Pubkey::new_unique();
    let real_pool_token_account = Pubkey::new_unique();
    let player_token_account = Pubkey::new_unique();

    let (game_state, bump) = Pubkey::find_program_address(&[b"game_state"], &program_id);

    program_test.add_account(
        mint,
        SolanaAccount {
            lamports: 1_000_000_000,
            data: pack_mint(Pubkey::new_unique(), 6),
            owner: spl_token::id(),
            executable: false,
            rent_epoch: 0,
        },
    );

    program_test.add_account(
        player.pubkey(),
        SolanaAccount {
            lamports: 5_000_000_000,
            data: vec![],
            owner: system_program::id(),
            executable: false,
            rent_epoch: 0,
        },
    );

    let player_amount_before: u64 = 10_000_000;
    program_test.add_account(
        player_token_account,
        SolanaAccount {
            lamports: 1_000_000_000,
            data: pack_token_account(mint, player.pubkey(), player_amount_before),
            owner: spl_token::id(),
            executable: false,
            rent_epoch: 0,
        },
    );

    program_test.add_account(
        real_pool_token_account,
        SolanaAccount {
            lamports: 1_000_000_000,
            data: pack_token_account(mint, game_state, 0),
            owner: spl_token::id(),
            executable: false,
            rent_epoch: 0,
        },
    );

    program_test.add_account(
        vrf,
        SolanaAccount {
            lamports: 1_000_000_000,
            data: vec![0u8; 64],
            owner: slot_machine::SWITCHBOARD_V2_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    );

    let mut game_state_data = vec![0u8; 8 + 4096];
    {
        let mut cursor = std::io::Cursor::new(&mut game_state_data[..]);
        let state = slot_machine::GameState {
            owner: owner.pubkey(),
            bump,
            pool_mint: mint,
            pool_token_account: real_pool_token_account,
            total_pool: 0,
            nonce: 0,
            agents: vec![slot_machine::Agent {
                pubkey: agent.pubkey(),
                stake: 0,
                room_card: 10000,
                commission: 0,
                stake_time: 0,
                last_settlement: 0,
                is_active: true,
            }],
            next_room_card: 10001,
            commission_rate: 10,
            stake_threshold: 1_000_000,
            settlement_period: 86_400,
            vrf,
            vrf_result_offset: 0,
            symbol_weights: [2500, 2500, 250, 1600, 2150, 1000],
            payout_triple: [0, 0, 0, 0, 0, 0],
            payout_double: [0, 0, 0, 0, 0, 0],
            max_auto_spins: 1,
            min_bet: 1,
        };
        state.try_serialize(&mut cursor).unwrap();
    }
    program_test.add_account(
        game_state,
        SolanaAccount {
            lamports: 1_000_000_000,
            data: game_state_data,
            owner: program_id,
            executable: false,
            rent_epoch: 0,
        },
    );

    let mut context = program_test.start_with_context().await;

    let bet: u64 = 1_000_000;
    let bets: [u64; 6] = [bet, 0, 0, 0, 0, 0];
    let request_ix = solana_sdk::instruction::Instruction {
        program_id,
        accounts: slot_machine::accounts::RequestPlay {
            game_state,
            pending_play: pending_play.pubkey(),
            player: player.pubkey(),
            player_token_account,
            pool_token_account: real_pool_token_account,
            token_program: spl_token::id(),
            vrf,
            system_program: system_program::id(),
        }
        .to_account_metas(None),
        data: slot_machine::instruction::RequestPlay { bets, room_card: None }.data(),
    };

    let tx = Transaction::new_signed_with_payer(
        &[request_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, &player, &pending_play],
        context.last_blockhash,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    let player_acc = context.banks_client.get_account(player_token_account).await.unwrap().unwrap();
    let player_token = TokenAccount::unpack(&player_acc.data).unwrap();
    assert_eq!(player_token.amount, player_amount_before - bet);

    let pool_acc = context
        .banks_client
        .get_account(real_pool_token_account)
        .await
        .unwrap()
        .unwrap();
    let pool_token = TokenAccount::unpack(&pool_acc.data).unwrap();
    assert_eq!(pool_token.amount, bet);

    let settle_ix = solana_sdk::instruction::Instruction {
        program_id,
        accounts: slot_machine::accounts::SettlePlay {
            game_state,
            pending_play: pending_play.pubkey(),
            player: player.pubkey(),
            player_token_account,
            pool_token_account: real_pool_token_account,
            token_program: spl_token::id(),
            vrf,
            system_program: system_program::id(),
        }
        .to_account_metas(None),
        data: slot_machine::instruction::SettlePlay {}.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[settle_ix.clone()],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        context.last_blockhash,
    );
    assert!(context.banks_client.process_transaction(tx).await.is_err());

    context.last_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();

    let mut update_data = Vec::with_capacity(4 + 32);
    update_data.extend_from_slice(&0u32.to_le_bytes());
    update_data.extend_from_slice(&[7u8; 32]);
    let vrf_update_ix = solana_sdk::instruction::Instruction {
        program_id: slot_machine::SWITCHBOARD_V2_PROGRAM_ID,
        accounts: vec![solana_sdk::instruction::AccountMeta::new(vrf, false)],
        data: update_data,
    };
    let tx = Transaction::new_signed_with_payer(
        &[vrf_update_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        context.last_blockhash,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    let vrf_acc = context.banks_client.get_account(vrf).await.unwrap().unwrap();
    assert_eq!(&vrf_acc.data[0..32], &[7u8; 32]);

    context.last_blockhash = context.banks_client.get_latest_blockhash().await.unwrap();

    let tx = Transaction::new_signed_with_payer(
        &[settle_ix],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        context.last_blockhash,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    let pending_acc = context.banks_client.get_account(pending_play.pubkey()).await.unwrap();
    assert!(pending_acc.is_none());
}
