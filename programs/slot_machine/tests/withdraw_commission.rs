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
async fn withdraw_commission_transfers_exact_amount_and_resets_state() {
    let program_id = slot_machine::id();
    let mut program_test = ProgramTest::new("slot_machine", program_id, processor!(slot_machine_process));
    program_test.add_program("spl_token", spl_token::id(), processor!(spl_token::processor::Processor::process));

    let agent = Keypair::new();
    let mint = Pubkey::new_unique();
    let pool_token_account = Pubkey::new_unique();
    let agent_token_account = Pubkey::new_unique();

    let (game_state, bump) = Pubkey::find_program_address(&[b"game_state"], &program_id);

    let commission_amount: u64 = 123_456;
    let pool_amount_before: u64 = 1_000_000;

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
        pool_token_account,
        SolanaAccount {
            lamports: 1_000_000_000,
            data: pack_token_account(mint, game_state, pool_amount_before),
            owner: spl_token::id(),
            executable: false,
            rent_epoch: 0,
        },
    );

    program_test.add_account(
        agent_token_account,
        SolanaAccount {
            lamports: 1_000_000_000,
            data: pack_token_account(mint, agent.pubkey(), 0),
            owner: spl_token::id(),
            executable: false,
            rent_epoch: 0,
        },
    );

    let mut game_state_data = vec![0u8; 8 + 4096];
    {
        let mut cursor = std::io::Cursor::new(&mut game_state_data[..]);
        let state = slot_machine::GameState {
            owner: Pubkey::new_unique(),
            bump,
            pool_mint: mint,
            pool_token_account,
            total_pool: pool_amount_before,
            nonce: 0,
            agents: vec![slot_machine::Agent {
                pubkey: agent.pubkey(),
                stake: 0,
                room_card: 10000,
                commission: commission_amount as i64,
                stake_time: 0,
                last_settlement: -86_401,
                is_active: true,
            }],
            next_room_card: 10001,
            commission_rate: 10,
            stake_threshold: 1_000_000,
            settlement_period: 86_400,
            rng: slot_machine::XorshiftRng::default(),
            symbol_weights: [2500, 2500, 250, 1600, 2150, 1000],
            payout_triple: [220, 180, 2000, 360, 450, 0],
            payout_double: [65, 50, 100, 75, 85, 0],
            max_auto_spins: 5,
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

    let ix = solana_sdk::instruction::Instruction {
        program_id,
        accounts: slot_machine::accounts::WithdrawCommission {
            game_state,
            agent: agent.pubkey(),
            pool_token_account,
            agent_token_account,
            token_program: spl_token::id(),
        }
        .to_account_metas(None),
        data: slot_machine::instruction::WithdrawCommission {}.data(),
    };

    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&context.payer.pubkey()),
        &[&context.payer, &agent],
        context.last_blockhash,
    );
    context.banks_client.process_transaction(tx).await.unwrap();

    let pool_acc = context.banks_client.get_account(pool_token_account).await.unwrap().unwrap();
    let agent_acc = context.banks_client.get_account(agent_token_account).await.unwrap().unwrap();
    let state_acc = context.banks_client.get_account(game_state).await.unwrap().unwrap();

    let pool_token = TokenAccount::unpack(&pool_acc.data).unwrap();
    let agent_token = TokenAccount::unpack(&agent_acc.data).unwrap();

    assert_eq!(pool_token.amount, pool_amount_before - commission_amount);
    assert_eq!(agent_token.amount, commission_amount);

    let mut state_data_slice: &[u8] = &state_acc.data;
    let state = slot_machine::GameState::try_deserialize(&mut state_data_slice).unwrap();
    assert_eq!(state.total_pool, pool_amount_before - commission_amount);
    let agent_state = state.agents.iter().find(|a| a.pubkey == agent.pubkey()).unwrap();
    assert_eq!(agent_state.commission, 0);
    assert!(agent_state.last_settlement >= 0);
}
