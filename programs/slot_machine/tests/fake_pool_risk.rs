use anchor_lang::prelude::*;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use solana_program::{
    entrypoint::ProgramResult,
    program_option::COption,
    program_pack::Pack,
};
use solana_program_test::*;
use solana_sdk::{
    account::Account as SolanaAccount,
    signature::{Keypair, Signer},
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
async fn play_rejects_using_non_pool_account_even_when_payout_is_zero() {
    let program_id = slot_machine::id();
    let mut program_test = ProgramTest::new("slot_machine", program_id, processor!(slot_machine_process));
    program_test.add_program("spl_token", spl_token::id(), processor!(spl_token::processor::Processor::process));

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
            rng: slot_machine::XorshiftRng::default(),
            symbol_weights: [2500, 2500, 250, 1600, 2150, 1000],
            payout_triple: [0, 0, 0, 0, 0, 0],
            payout_double: [0, 0, 0, 0, 0, 0],
            max_auto_spins: 1,
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
    let ix = solana_sdk::instruction::Instruction {
        program_id,
        accounts: slot_machine::accounts::Play {
            game_state,
            player: player.pubkey(),
            player_token_account,
            pool_token_account: player_token_account,
            token_program: spl_token::id(),
        }
        .to_account_metas(None),
        data: slot_machine::instruction::Play {
            bets,
            room_card: Some(10000),
        }
        .data(),
    };

    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, &player],
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
