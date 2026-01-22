use anchor_lang::prelude::*;
use anchor_lang::solana_program::{clock::Clock, system_instruction, program as solana_program};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("GtSdwriBEDSUrrdxx1tHA1TV8aAgA9bSKcPmeYCUQhBg");

// ============== 常量定义 ==============
pub const SYMBOL_COUNT: usize = 6;
pub const SYMBOL_CHERRY: u8 = 0;
pub const SYMBOL_LEMON: u8 = 1;
pub const SYMBOL_SEVEN: u8 = 2;
pub const SYMBOL_BELL: u8 = 3;
pub const SYMBOL_STAR: u8 = 4;
pub const SYMBOL_DOUBLE: u8 = 5;

const WEIGHT_TOTAL: u32 = 10000;
const PAYOUT_BASE: u64 = 100;
const MAX_MULTIPLIER: u16 = 1600;
const DEFAULT_COMMISSION_RATE: u8 = 10;
const DEFAULT_STAKE_THRESHOLD: u64 = 1_000_000;
const DEFAULT_SETTLEMENT_PERIOD: i64 = 86400;
const STARTING_ROOM_CARD: u64 = 10000;

// ============== Xorshift128 随机数生成器 ==============
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct XorshiftRng {
    x: u32,
    y: u32,
    z: u32,
    w: u32,
}

impl XorshiftRng {
    fn new(seed: u32) -> Self {
        Self {
            x: seed,
            y: seed.wrapping_mul(362436069),
            z: seed.wrapping_mul(521288629),
            w: seed.wrapping_mul(88675123),
        }
    }

    fn next_u32(&mut self) -> u32 {
        let t = self.x ^ (self.x << 11);
        self.x = self.y;
        self.y = self.z;
        self.z = self.w;
        self.w = self.w ^ (self.w >> 19) ^ (t ^ (t >> 8));
        self.w
    }

    fn next_range(&mut self, max: u32) -> u32 {
        self.next_u32() % max
    }
}

// ============== 错误码 ==============
#[error_code]
pub enum ErrorCode {
    #[msg("未授权访问")]
    Unauthorized,
    #[msg("质押金额过低")]
    StakeTooLow,
    #[msg("奖池余额不足")]
    InsufficientFunds,
    #[msg("无效的房卡号")]
    InvalidRoomCard,
    #[msg("符号权重无效")]
    InvalidSymbolWeights,
    #[msg("下注表无效")]
    InvalidBetTable,
    #[msg("佣金率无效")]
    InvalidCommissionRate,
    #[msg("代理商不存在")]
    AgentNotFound,
    #[msg("提取时间未到")]
    WithdrawalNotDue,
    #[msg("佣金数值溢出")]
    CommissionOverflow,
}

// ============== 主程序 ==============
#[program]
pub mod slot_machine {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        game_state.owner = ctx.accounts.user.key();
        game_state.bump = ctx.bumps.game_state;
        game_state.pool_mint = ctx.accounts.token_mint.key();
        game_state.pool_token_account = ctx.accounts.pool_token_account.key();
        game_state.total_pool = 0;
        game_state.nonce = 0;
        game_state.agents = Vec::new();
        game_state.next_room_card = STARTING_ROOM_CARD;
        game_state.commission_rate = DEFAULT_COMMISSION_RATE;
        game_state.stake_threshold = DEFAULT_STAKE_THRESHOLD;
        game_state.settlement_period = DEFAULT_SETTLEMENT_PERIOD;
        
        // 默认符号权重 (RTP ~88%-95%)
        game_state.symbol_weights = [2500, 2500, 250, 1600, 2150, 1000];
        
        // 默认赔率表
        game_state.payout_triple = [220, 180, 2000, 360, 450, 0];
        game_state.payout_double = [65, 50, 100, 75, 85, 0];
        
        // 初始化 RNG
        let seed = Clock::get()?.unix_timestamp as u32;
        game_state.rng = XorshiftRng::new(seed);
        game_state.max_auto_spins = 5;
        
        Ok(())
    }

    pub fn set_symbol_weights(ctx: Context<AdminOnly>, weights: [u16; SYMBOL_COUNT]) -> Result<()> {
        require_keys_eq!(ctx.accounts.owner.key(), ctx.accounts.game_state.owner, ErrorCode::Unauthorized);
        
        let total: u32 = weights.iter().map(|&w| w as u32).sum();
        require_eq!(total, WEIGHT_TOTAL, ErrorCode::InvalidSymbolWeights);
        
        ctx.accounts.game_state.symbol_weights = weights;
        Ok(())
    }

    pub fn set_payout_triple(ctx: Context<AdminOnly>, payouts: [u16; SYMBOL_COUNT]) -> Result<()> {
        require_keys_eq!(ctx.accounts.owner.key(), ctx.accounts.game_state.owner, ErrorCode::Unauthorized);
        ctx.accounts.game_state.payout_triple = payouts;
        Ok(())
    }

    pub fn set_payout_double(ctx: Context<AdminOnly>, payouts: [u16; SYMBOL_COUNT]) -> Result<()> {
        require_keys_eq!(ctx.accounts.owner.key(), ctx.accounts.game_state.owner, ErrorCode::Unauthorized);
        ctx.accounts.game_state.payout_double = payouts;
        Ok(())
    }

    pub fn set_commission_rate(ctx: Context<AdminOnly>, new_rate: u8) -> Result<()> {
        require_keys_eq!(ctx.accounts.owner.key(), ctx.accounts.game_state.owner, ErrorCode::Unauthorized);
        require!(new_rate <= 100, ErrorCode::InvalidCommissionRate);
        ctx.accounts.game_state.commission_rate = new_rate;
        Ok(())
    }

    pub fn set_stake_threshold(ctx: Context<AdminOnly>, new_threshold: u64) -> Result<()> {
        require_keys_eq!(ctx.accounts.owner.key(), ctx.accounts.game_state.owner, ErrorCode::Unauthorized);
        ctx.accounts.game_state.stake_threshold = new_threshold;
        Ok(())
    }

    pub fn sync_pool_total(ctx: Context<SyncPoolTotal>) -> Result<()> {
        require_keys_eq!(ctx.accounts.owner.key(), ctx.accounts.game_state.owner, ErrorCode::Unauthorized);
        ctx.accounts.game_state.total_pool = ctx.accounts.pool_token_account.amount;
        Ok(())
    }

    pub fn withdraw_pool(ctx: Context<WithdrawPool>, amount: u64) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require_keys_eq!(ctx.accounts.owner.key(), game_state.owner, ErrorCode::Unauthorized);
        game_state.total_pool = ctx.accounts.pool_token_account.amount;
        require_gte!(game_state.total_pool, amount, ErrorCode::InsufficientFunds);
        
        let bump = game_state.bump;
        game_state.total_pool -= amount;
        
        transfer_token_with_pda(
            &ctx.accounts.pool_token_account.to_account_info(),
            &ctx.accounts.owner_token_account.to_account_info(),
            &ctx.accounts.game_state.to_account_info(),
            &ctx.accounts.token_program,
            amount,
            bump,
        )?;
        
        emit!(PoolWithdrawal {
            owner: ctx.accounts.owner.key(),
            amount,
        });
        
        Ok(())
    }

    pub fn withdraw_commission(ctx: Context<WithdrawCommission>) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        let agent_key = ctx.accounts.agent.key();
        let current_time = Clock::get()?.unix_timestamp;
        let settlement_period = game_state.settlement_period;
        let bump = game_state.bump;
        game_state.total_pool = ctx.accounts.pool_token_account.amount;
        let total_pool = game_state.total_pool;
        
        let agent = find_active_agent_mut(&mut game_state.agents, agent_key)?;
        
        require_gte!(
            current_time,
            agent.last_settlement + settlement_period,
            ErrorCode::WithdrawalNotDue
        );
        require_gt!(agent.commission, 0, ErrorCode::InsufficientFunds);
        
        let amount = agent.commission as u64;
        require_gte!(total_pool, amount, ErrorCode::InsufficientFunds);
        
        agent.commission = 0;
        agent.last_settlement = current_time;
        
        game_state.total_pool -= amount;
        
        transfer_token_with_pda(
            &ctx.accounts.pool_token_account.to_account_info(),
            &ctx.accounts.agent_token_account.to_account_info(),
            &ctx.accounts.game_state.to_account_info(),
            &ctx.accounts.token_program,
            amount,
            bump,
        )?;
        
        emit!(CommissionWithdrawn { agent: agent_key, amount });
        
        Ok(())
    }

    pub fn become_agent(ctx: Context<BecomeAgent>, stake_amount: u64) -> Result<()> {
        let game_state = &ctx.accounts.game_state;
        require_gte!(stake_amount, game_state.stake_threshold, ErrorCode::StakeTooLow);

        transfer_sol(
            &ctx.accounts.agent,
            &ctx.accounts.game_state.to_account_info(),
            &ctx.accounts.system_program,
            stake_amount,
        )?;

        let game_state = &mut ctx.accounts.game_state;
        let room_card = game_state.next_room_card;
        game_state.next_room_card += 1;

        let current_time = Clock::get()?.unix_timestamp;
        game_state.agents.push(Agent {
            pubkey: ctx.accounts.agent.key(),
            stake: stake_amount,
            room_card,
            commission: 0,
            stake_time: current_time,
            last_settlement: current_time,
            is_active: true,
        });

        emit!(AgentCreated {
            agent: ctx.accounts.agent.key(),
            room_card,
            stake: stake_amount,
        });

        Ok(())
    }

    pub fn redeem_agent_stake(ctx: Context<RedeemAgentStake>) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        let agent_key = ctx.accounts.agent.key();
        
        let agent = find_active_agent_mut(&mut game_state.agents, agent_key)?;
        let stake_amount = agent.stake;
        let room_card = agent.room_card;
        
        agent.is_active = false;
        
        **ctx.accounts.game_state.to_account_info().try_borrow_mut_lamports()? -= stake_amount;
        **ctx.accounts.agent.to_account_info().try_borrow_mut_lamports()? += stake_amount;
        
        emit!(AgentRedeemed { agent: agent_key, room_card, stake: stake_amount });
        
        Ok(())
    }

    pub fn play(ctx: Context<Play>, bets: [u64; SYMBOL_COUNT], room_card: Option<u64>) -> Result<()> {
        require_eq!(bets[SYMBOL_DOUBLE as usize], 0, ErrorCode::InvalidBetTable);
        let total_bet: u64 = bets.iter().sum();
        require_gt!(total_bet, 0, ErrorCode::InvalidBetTable);

        let player_token_account = ctx.accounts.player_token_account.to_account_info();
        let pool_token_account = ctx.accounts.pool_token_account.to_account_info();
        transfer_token(
            &player_token_account,
            &pool_token_account,
            &ctx.accounts.player,
            &ctx.accounts.token_program,
            total_bet,
        )?;

        let game_state = &mut ctx.accounts.game_state;
        game_state.total_pool = ctx.accounts.pool_token_account.amount;
        game_state.total_pool += total_bet;

        let (total_payout, all_results) = execute_spins_with_bets(game_state, &bets)?;

        if let Some(card) = room_card {
            process_agent_commission(game_state, card, total_bet, total_payout)?;
        }

        game_state.nonce += 1;

        if total_payout > 0 {
            require_gte!(game_state.total_pool, total_payout, ErrorCode::InsufficientFunds);
            let bump = game_state.bump;
            game_state.total_pool -= total_payout;

            transfer_token_with_pda(
                &pool_token_account,
                &player_token_account,
                &ctx.accounts.game_state.to_account_info(),
                &ctx.accounts.token_program,
                total_payout,
                bump,
            )?;
        }

        emit!(GameResult {
            player: ctx.accounts.player.key(),
            spins: all_results,
            total_payout,
        });

        Ok(())
    }
}

// ============== 辅助函数 ==============

fn transfer_sol<'info>(
    from: &Signer<'info>,
    to: &AccountInfo<'info>,
    _system_program: &Program<'info, System>,
    amount: u64,
) -> Result<()> {
    let ix = system_instruction::transfer(&from.key(), &to.key(), amount);
    solana_program::invoke(&ix, &[from.to_account_info(), to.clone()])?;
    Ok(())
}

fn transfer_token<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &Signer<'info>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    let cpi_accounts = Transfer {
        from: from.clone(),
        to: to.clone(),
        authority: authority.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(token_program.to_account_info(), cpi_accounts);
    token::transfer(cpi_ctx, amount)
}

fn transfer_token_with_pda<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    amount: u64,
    bump: u8,
) -> Result<()> {
    let seeds = &[b"game_state".as_ref(), &[bump]];
    let signer = &[&seeds[..]];
    
    let cpi_accounts = Transfer {
        from: from.clone(),
        to: to.clone(),
        authority: authority.clone(),
    };
    let cpi_ctx = CpiContext::new_with_signer(token_program.to_account_info(), cpi_accounts, signer);
    token::transfer(cpi_ctx, amount)
}

fn find_active_agent_mut(agents: &mut Vec<Agent>, pubkey: Pubkey) -> Result<&mut Agent> {
    agents
        .iter_mut()
        .find(|a| a.pubkey == pubkey && a.is_active)
        .ok_or(error!(ErrorCode::AgentNotFound))
}

fn execute_spins_with_bets(game_state: &mut GameState, bets: &[u64; SYMBOL_COUNT]) -> Result<(u64, Vec<SpinResult>)> {
    let mut total_payout = 0u64;
    let mut results = Vec::new();
    let mut spins_remaining = 1u8;
    let mut multiplier = 100u16;
    let mut spin_count = 0u8;

    while spins_remaining > 0 && spin_count < game_state.max_auto_spins {
        spins_remaining -= 1;
        spin_count += 1;

        let symbols = generate_symbols(game_state);
        let (base_payout, triggered_double) = calculate_payout_with_bets(game_state, symbols, bets);

        let spin_payout = (base_payout as u128 * multiplier as u128 / PAYOUT_BASE as u128) as u64;
        total_payout += spin_payout;

        results.push(SpinResult { symbols, payout: spin_payout, multiplier });

        if triggered_double {
            spins_remaining += 1;
            multiplier = multiplier.saturating_mul(2).min(MAX_MULTIPLIER);
        }
    }

    Ok((total_payout, results))
}

fn generate_symbols(game_state: &mut GameState) -> [u8; 3] {
    let mut symbols = [0u8; 3];
    for i in 0..3 {
        let rand = game_state.rng.next_range(WEIGHT_TOTAL);
        symbols[i] = weight_to_symbol(&game_state.symbol_weights, rand);
    }
    symbols
}

fn weight_to_symbol(weights: &[u16; SYMBOL_COUNT], rand: u32) -> u8 {
    let mut cumulative = 0u32;
    for (i, &weight) in weights.iter().enumerate() {
        cumulative += weight as u32;
        if rand < cumulative {
            return i as u8;
        }
    }
    (SYMBOL_COUNT - 1) as u8
}

fn calculate_outcome(game_state: &GameState, symbols: [u8; 3]) -> (bool, Option<u8>, u64) {
    let triggered_double = symbols.iter().any(|&s| s == SYMBOL_DOUBLE);

    if symbols[0] == symbols[1] && symbols[1] == symbols[2] {
        if symbols[0] == SYMBOL_DOUBLE {
            return (true, None, 0);
        }
        let payout_multiplier = game_state.payout_triple[symbols[0] as usize] as u64;
        return (triggered_double, Some(symbols[0]), payout_multiplier);
    }

    let non_double: Vec<u8> = symbols.iter().filter(|&&s| s != SYMBOL_DOUBLE).copied().collect();
    if non_double.len() >= 2 {
        if let Some((symbol, _)) = find_pair(&non_double) {
            let payout_multiplier = game_state.payout_double[symbol as usize] as u64;
            return (triggered_double, Some(symbol), payout_multiplier);
        }
    }

    (triggered_double, None, 0)
}

fn calculate_payout_with_bets(game_state: &GameState, symbols: [u8; 3], bets: &[u64; SYMBOL_COUNT]) -> (u64, bool) {
    let (triggered_double, winning_symbol, payout_multiplier) = calculate_outcome(game_state, symbols);
    let base_bet = match winning_symbol {
        Some(s) => bets[s as usize],
        None => 0,
    };
    if base_bet == 0 || payout_multiplier == 0 {
        return (0, triggered_double);
    }
    let base_payout = (base_bet as u128 * payout_multiplier as u128 / PAYOUT_BASE as u128) as u64;
    (base_payout, triggered_double)
}

fn find_pair(symbols: &[u8]) -> Option<(u8, usize)> {
    let mut counts = [0usize; SYMBOL_COUNT];
    for &s in symbols {
        if (s as usize) < SYMBOL_COUNT {
            counts[s as usize] += 1;
        }
    }
    counts.iter().enumerate().find(|(_, &count)| count >= 2).map(|(i, &count)| (i as u8, count))
}

fn process_agent_commission(
    game_state: &mut GameState,
    room_card: u64,
    bet_amount: u64,
    payout: u64,
) -> Result<()> {
    let agent = game_state
        .agents
        .iter_mut()
        .find(|a| a.room_card == room_card && a.is_active)
        .ok_or(ErrorCode::InvalidRoomCard)?;

    let net: i128 = payout as i128 - bet_amount as i128;
    let abs_net: u128 = net.unsigned_abs();
    let commission_u128: u128 = abs_net * game_state.commission_rate as u128 / 100u128;
    let commission_i64: i64 = i64::try_from(commission_u128).map_err(|_| error!(ErrorCode::CommissionOverflow))?;

    if net < 0 {
        agent.commission = agent
            .commission
            .checked_add(commission_i64)
            .ok_or_else(|| error!(ErrorCode::CommissionOverflow))?;
    } else if net > 0 {
        agent.commission = agent.commission.saturating_sub(commission_i64).max(0);
    }

    Ok(())
}

// ============== 账户结构 ==============

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + GameState::SPACE,
        seeds = [b"game_state"],
        bump
    )]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = pool_token_account.mint == token_mint.key(),
        constraint = pool_token_account.owner == game_state.key()
    )]
    pub pool_token_account: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Play<'info> {
    #[account(mut)]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(
        mut,
        constraint = player_token_account.owner == player.key(),
        constraint = player_token_account.mint == game_state.pool_mint
    )]
    pub player_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        address = game_state.pool_token_account,
        constraint = pool_token_account.owner == game_state.key(),
        constraint = pool_token_account.mint == game_state.pool_mint
    )]
    pub pool_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut)]
    pub game_state: Account<'info, GameState>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct SyncPoolTotal<'info> {
    #[account(mut)]
    pub game_state: Account<'info, GameState>,
    pub owner: Signer<'info>,
    #[account(
        address = game_state.pool_token_account,
        constraint = pool_token_account.owner == game_state.key(),
        constraint = pool_token_account.mint == game_state.pool_mint
    )]
    pub pool_token_account: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct BecomeAgent<'info> {
    #[account(mut)]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub agent: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RedeemAgentStake<'info> {
    #[account(mut)]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub agent: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawPool<'info> {
    #[account(mut)]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        address = game_state.pool_token_account,
        constraint = pool_token_account.owner == game_state.key(),
        constraint = pool_token_account.mint == game_state.pool_mint
    )]
    pub pool_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = owner_token_account.owner == owner.key(),
        constraint = owner_token_account.mint == game_state.pool_mint
    )]
    pub owner_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawCommission<'info> {
    #[account(mut)]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub agent: Signer<'info>,
    #[account(
        mut,
        address = game_state.pool_token_account,
        constraint = pool_token_account.owner == game_state.key(),
        constraint = pool_token_account.mint == game_state.pool_mint
    )]
    pub pool_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = agent_token_account.owner == agent.key(),
        constraint = agent_token_account.mint == game_state.pool_mint
    )]
    pub agent_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ============== 数据结构 ==============

#[account]
pub struct GameState {
    pub owner: Pubkey,
    pub bump: u8,
    pub pool_mint: Pubkey,
    pub pool_token_account: Pubkey,
    pub total_pool: u64,
    pub nonce: u64,
    pub agents: Vec<Agent>,
    pub next_room_card: u64,
    pub commission_rate: u8,
    pub stake_threshold: u64,
    pub settlement_period: i64,
    pub rng: XorshiftRng,
    pub symbol_weights: [u16; SYMBOL_COUNT],
    pub payout_triple: [u16; SYMBOL_COUNT],
    pub payout_double: [u16; SYMBOL_COUNT],
    pub max_auto_spins: u8,
}

impl GameState {
    pub const SPACE: usize = 32 + 1 + 32 + 32 + 8 + 8 + 4 + (80 * 20) + 8 + 1 + 8 + 8 + 16 + 12 + 12 + 12 + 1 + 200;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Agent {
    pub pubkey: Pubkey,
    pub stake: u64,
    pub room_card: u64,
    pub commission: i64,
    pub stake_time: i64,
    pub last_settlement: i64,
    pub is_active: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SpinResult {
    pub symbols: [u8; 3],
    pub payout: u64,
    pub multiplier: u16,
}

// ============== 事件 ==============

#[event]
pub struct GameResult {
    pub player: Pubkey,
    pub spins: Vec<SpinResult>,
    pub total_payout: u64,
}

#[event]
pub struct AgentCreated {
    pub agent: Pubkey,
    pub room_card: u64,
    pub stake: u64,
}

#[event]
pub struct AgentRedeemed {
    pub agent: Pubkey,
    pub room_card: u64,
    pub stake: u64,
}

#[event]
pub struct PoolWithdrawal {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct CommissionWithdrawn {
    pub agent: Pubkey,
    pub amount: u64,
}
