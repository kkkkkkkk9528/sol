use anchor_lang::prelude::*;
use anchor_lang::solana_program::{clock::Clock, system_instruction, program as solana_program};
use anchor_spl::token::{self, Token, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

// ============== 符号定义 ==============
// 0: 樱桃 (Cherry)
// 1: 柠檬 (Lemon)  
// 2: 七 (Seven)
// 3: 铃铛 (Bell)
// 4: 星星 (Star)
// 5: 翻倍 (Double) - 触发自动再转一轮

pub const SYMBOL_CHERRY: u8 = 0;
pub const SYMBOL_LEMON: u8 = 1;
pub const SYMBOL_SEVEN: u8 = 2;
pub const SYMBOL_BELL: u8 = 3;
pub const SYMBOL_STAR: u8 = 4;
pub const SYMBOL_DOUBLE: u8 = 5;
pub const SYMBOL_COUNT: usize = 6;

// ============== Xorshift128 随机数生成器 ==============
// 周期: 2^128-1，随机性好，状态小(4个u32)
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct XorshiftRng {
    pub x: u32,
    pub y: u32,
    pub z: u32,
    pub w: u32,
}

impl XorshiftRng {
    pub fn new(seed: u32) -> Self {
        XorshiftRng {
            x: seed,
            y: seed.wrapping_mul(362436069),
            z: seed.wrapping_mul(521288629),
            w: seed.wrapping_mul(88675123),
        }
    }

    pub fn next_u32(&mut self) -> u32 {
        let t = self.x ^ (self.x << 11);
        self.x = self.y;
        self.y = self.z;
        self.z = self.w;
        self.w = self.w ^ (self.w >> 19) ^ (t ^ (t >> 8));
        self.w
    }

    pub fn next_range(&mut self, max: u32) -> u32 {
        self.next_u32() % max
    }
}

// ============== 错误码 ==============
#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized access")]
    Unauthorized,
    #[msg("Stake amount too low")]
    StakeTooLow,
    #[msg("Insufficient funds in pool")]
    InsufficientFunds,
    #[msg("Invalid room card")]
    InvalidRoomCard,
    #[msg("Invalid symbol weights")]
    InvalidSymbolWeights,
    #[msg("Agent not found")]
    AgentNotFound,
    #[msg("Withdrawal not due yet, can only withdraw once per day")]
    WithdrawalNotDue,
}

fn get_current_time() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

// ============== 主程序 ==============
#[program]
pub mod slot_machine {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        game_state.owner = *ctx.accounts.user.key;
        game_state.bump = ctx.bumps.game_state;  // 保存 PDA bump
        game_state.total_pool = 0;
        game_state.nonce = 0;
        game_state.agents = Vec::new();
        game_state.next_room_card = 10000;
        game_state.commission_rate = 10;
        game_state.stake_threshold = 1000000;
        game_state.settlement_period = 86400;
        
        // 默认符号权重 (总和 = 10000，即百分比 * 100)
        // 目标 RTP: ~90% (庄家优势 ~10%)
        game_state.symbol_weights = [
            2500,  // Cherry: 25%
            2500,  // Lemon: 25%
            250,   // Seven: 2.5% (高赔率，极低概率)
            1600,  // Bell: 16%
            2150,  // Star: 21.5%
            1000,  // Double: 10%
        ];
        
        // 默认赔率表 (三个相同符号) - 基于100为1x
        game_state.payout_triple = [
            220,   // Cherry x3: 2.2x
            180,   // Lemon x3: 1.8x
            2000,  // Seven x3: 20x (大奖)
            360,   // Bell x3: 3.6x
            450,   // Star x3: 4.5x
            0,     // Double x3: 触发免费转
        ];
        
        // 两个相同符号赔率
        game_state.payout_double = [
            65,    // Cherry x2: 0.65x
            50,    // Lemon x2: 0.5x
            100,   // Seven x2: 1x
            75,    // Bell x2: 0.75x
            85,    // Star x2: 0.85x
            0,     // Double x2: 无效
        ];
        
        // 初始化 Xorshift128 RNG
        let clock = Clock::get()?;
        let seed = clock.unix_timestamp as u32;
        game_state.rng = XorshiftRng::new(seed);
        game_state.max_auto_spins = 5;
        
        Ok(())
    }

    /// 设置符号权重 (出现概率)
    pub fn set_symbol_weights(ctx: Context<AdminOnly>, weights: [u16; SYMBOL_COUNT]) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require!(ctx.accounts.owner.key() == game_state.owner, ErrorCode::Unauthorized);
        
        // 验证权重总和 = 10000
        let total: u32 = weights.iter().map(|&w| w as u32).sum();
        require!(total == 10000, ErrorCode::InvalidSymbolWeights);
        
        game_state.symbol_weights = weights;
        Ok(())
    }

    /// 设置三连赔率
    pub fn set_payout_triple(ctx: Context<AdminOnly>, payouts: [u16; SYMBOL_COUNT]) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require!(ctx.accounts.owner.key() == game_state.owner, ErrorCode::Unauthorized);
        game_state.payout_triple = payouts;
        Ok(())
    }

    /// 设置两连赔率
    pub fn set_payout_double(ctx: Context<AdminOnly>, payouts: [u16; SYMBOL_COUNT]) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require!(ctx.accounts.owner.key() == game_state.owner, ErrorCode::Unauthorized);
        game_state.payout_double = payouts;
        Ok(())
    }

    pub fn set_commission_rate(ctx: Context<AdminOnly>, new_rate: u8) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require!(ctx.accounts.owner.key() == game_state.owner, ErrorCode::Unauthorized);
        game_state.commission_rate = new_rate;
        Ok(())
    }

    pub fn set_stake_threshold(ctx: Context<AdminOnly>, new_threshold: u64) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require!(ctx.accounts.owner.key() == game_state.owner, ErrorCode::Unauthorized);
        game_state.stake_threshold = new_threshold;
        Ok(())
    }

    /// 合约所有者提取奖池资金 (Token)
    pub fn withdraw_pool(ctx: Context<WithdrawPool>, amount: u64) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require!(ctx.accounts.owner.key() == game_state.owner, ErrorCode::Unauthorized);
        require!(amount <= game_state.total_pool, ErrorCode::InsufficientFunds);
        
        game_state.total_pool -= amount;
        
        // 准备 PDA 签名
        let seeds = &[
            b"game_state".as_ref(),
            &[game_state.bump],
        ];
        let signer = &[&seeds[..]];
        
        // 转账 Token 给所有者
        let cpi_accounts = Transfer {
            from: ctx.accounts.pool_token_account.to_account_info(),
            to: ctx.accounts.owner_token_account.to_account_info(),
            authority: ctx.accounts.game_state.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, amount)?;
        
        emit!(PoolWithdrawal {
            owner: ctx.accounts.owner.key(),
            amount,
        });
        
        Ok(())
    }

    /// 代理商提取佣金（每天一次，Token）
    pub fn withdraw_commission(ctx: Context<WithdrawCommission>) -> Result<()> {
        let current_time = get_current_time()?;
        let game_state = &mut ctx.accounts.game_state;
        let agent_key = ctx.accounts.agent.key();
        let settlement_period = game_state.settlement_period;
        
        let agent_idx = game_state.agents.iter().position(|a| a.pubkey == agent_key && a.is_active)
            .ok_or(ErrorCode::AgentNotFound)?;
        
        let agent = &mut game_state.agents[agent_idx];
        
        // 检查是否到提取时间（每天一次）
        require!(
            current_time >= agent.last_settlement + settlement_period as i64,
            ErrorCode::WithdrawalNotDue
        );
        
        let commission = agent.commission;
        require!(commission > 0, ErrorCode::InsufficientFunds);
        
        let amount = commission as u64;
        
        // 检查奖池余额并更新
        require!(amount <= game_state.total_pool, ErrorCode::InsufficientFunds);
        game_state.total_pool -= amount;
        
        // 清零佣金
        agent.commission = 0;
        // 更新提取时间
        agent.last_settlement = current_time;
        
        // 准备 PDA 签名
        let seeds = &[
            b"game_state".as_ref(),
            &[game_state.bump],
        ];
        let signer = &[&seeds[..]];
        
        // 转账 Token 给代理商
        let cpi_accounts = Transfer {
            from: ctx.accounts.pool_token_account.to_account_info(),
            to: ctx.accounts.agent_token_account.to_account_info(),
            authority: ctx.accounts.game_state.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, amount)?;
        
        emit!(CommissionWithdrawn {
            agent: agent_key,
            amount,
        });
        
        Ok(())
    }

    /// 质押成为代理商
    pub fn become_agent(ctx: Context<BecomeAgent>, stake_amount: u64) -> Result<()> {
        let game_state = &ctx.accounts.game_state;
        require!(stake_amount >= game_state.stake_threshold, ErrorCode::StakeTooLow);

        let transfer_ix = system_instruction::transfer(
            &ctx.accounts.agent.key(),
            &ctx.accounts.game_state.key(),
            stake_amount,
        );
        solana_program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.agent.to_account_info(),
                ctx.accounts.game_state.to_account_info(),
            ],
        )?;

        let game_state = &mut ctx.accounts.game_state;
        let room_card = game_state.next_room_card;
        game_state.next_room_card += 1;

        let current_time = get_current_time()?;
        let agent_key = ctx.accounts.agent.key();
        game_state.agents.push(Agent {
            pubkey: agent_key,
            stake: stake_amount,
            room_card,
            commission: 0,
            stake_time: current_time,
            last_settlement: current_time,
            is_active: true,
        });

        emit!(AgentCreated {
            agent: agent_key,
            room_card,
            stake: stake_amount,
        });

        Ok(())
    }

    /// 代理商赎回质押（违约操作，直接返还全部质押）
    pub fn redeem_agent_stake(ctx: Context<RedeemAgentStake>) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        let agent_key = ctx.accounts.agent.key();
        
        let agent_idx = game_state.agents.iter().position(|a| a.pubkey == agent_key && a.is_active)
            .ok_or(ErrorCode::AgentNotFound)?;
        
        let stake_amount = game_state.agents[agent_idx].stake;
        let room_card = game_state.agents[agent_idx].room_card;
        
        // 标记为不活跃（违约操作，放弃未结算佣金）
        game_state.agents[agent_idx].is_active = false;
        
        // 返还全部质押
        **ctx.accounts.game_state.to_account_info().try_borrow_mut_lamports()? -= stake_amount;
        **ctx.accounts.agent.to_account_info().try_borrow_mut_lamports()? += stake_amount;
        
        emit!(AgentRedeemed {
            agent: agent_key,
            room_card,
            stake: stake_amount,
        });
        
        Ok(())
    }

    /// 主游戏逻辑 (Token)
    pub fn play(ctx: Context<Play>, bet_amount: u64, room_card: Option<u64>) -> Result<()> {
        let player_key = *ctx.accounts.player.key;
        
        // 转入下注金额 (Token)
        let cpi_accounts = Transfer {
            from: ctx.accounts.player_token_account.to_account_info(),
            to: ctx.accounts.pool_token_account.to_account_info(),
            authority: ctx.accounts.player.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, bet_amount)?;

        let game_state = &mut ctx.accounts.game_state;
        game_state.total_pool += bet_amount;

        // 执行游戏轮次（可能触发翻倍自动转）
        let (total_payout, all_results) = execute_spins(game_state, bet_amount)?;

        // 处理代理商佣金
        if let Some(card) = room_card {
            process_agent_commission(game_state, card, bet_amount, total_payout)?;
        }

        game_state.nonce += 1;

        // 支付奖金 (Token)
        if total_payout > 0 && total_payout <= game_state.total_pool {
            game_state.total_pool -= total_payout;
            
            // 准备 PDA 签名
            let seeds = &[
                b"game_state".as_ref(),
                &[game_state.bump],
            ];
            let signer = &[&seeds[..]];
            
            let cpi_accounts = Transfer {
                from: ctx.accounts.pool_token_account.to_account_info(),
                to: ctx.accounts.player_token_account.to_account_info(),
                authority: ctx.accounts.game_state.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
            token::transfer(cpi_ctx, total_payout)?;
        }

        emit!(GameResult {
            player: player_key,
            spins: all_results,
            total_payout,
        });

        Ok(())
    }
}

// ============== 游戏逻辑函数 ==============

/// 执行转轮（包含翻倍自动转）
fn execute_spins(game_state: &mut GameState, bet_amount: u64) -> Result<(u64, Vec<SpinResult>)> {
    let mut total_payout = 0u64;
    let mut all_results: Vec<SpinResult> = Vec::new();
    let mut spins_remaining = 1u8;
    let mut current_multiplier = 100u16; // 100 = 1x
    let max_spins = game_state.max_auto_spins;
    let mut spin_count = 0u8;

    while spins_remaining > 0 && spin_count < max_spins {
        spins_remaining -= 1;
        spin_count += 1;

        // 生成三个符号
        let symbols = generate_symbols(game_state);
        
        // 计算本轮奖金
        let (base_payout, triggered_double) = calculate_spin_payout(
            game_state,
            symbols,
            bet_amount,
        );

        let spin_payout = (base_payout as u128 * current_multiplier as u128 / 100) as u64;
        total_payout += spin_payout;

        all_results.push(SpinResult {
            symbols,
            payout: spin_payout,
            multiplier: current_multiplier,
        });

        // 检查是否触发翻倍
        if triggered_double {
            spins_remaining += 1;
            current_multiplier = current_multiplier.saturating_mul(2);
            if current_multiplier > 1600 {
                current_multiplier = 1600; // 最大16倍
            }
        }
    }

    Ok((total_payout, all_results))
}

/// 使用 Xorshift128 生成随机符号
fn generate_symbols(game_state: &mut GameState) -> [u8; 3] {
    let mut symbols = [0u8; 3];
    
    for i in 0..3 {
        let rand = game_state.rng.next_range(10000);
        symbols[i] = weight_to_symbol(&game_state.symbol_weights, rand);
    }

    symbols
}

/// 根据权重将随机数映射到符号
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

/// 计算单轮奖金
fn calculate_spin_payout(
    game_state: &GameState,
    symbols: [u8; 3],
    bet: u64,
) -> (u64, bool) {
    let s1 = symbols[0];
    let s2 = symbols[1];
    let s3 = symbols[2];

    // 检查是否有翻倍符号
    let triggered_double = symbols.iter().any(|&s| s == SYMBOL_DOUBLE);

    // 三个相同
    if s1 == s2 && s2 == s3 {
        if s1 == SYMBOL_DOUBLE {
            // 三个翻倍 = 触发免费转
            return (0, true);
        }
        let multiplier = game_state.payout_triple[s1 as usize] as u64;
        let payout = bet * multiplier / 100;
        return (payout, triggered_double);
    }

    // 两个相同 (排除翻倍符号参与计算)
    let mut non_double = [0u8; 3];
    let mut non_double_count = 0usize;
    for &s in &symbols {
        if s != SYMBOL_DOUBLE {
            non_double[non_double_count] = s;
            non_double_count += 1;
        }
    }
    
    if non_double_count >= 2 {
        let (matched_symbol, count) = find_pair(&non_double[..non_double_count]);
        if count >= 2 {
            let multiplier = game_state.payout_double[matched_symbol as usize] as u64;
            let payout = bet * multiplier / 100;
            return (payout, triggered_double);
        }
    }

    (0, triggered_double)
}

/// 查找配对符号
fn find_pair(symbols: &[u8]) -> (u8, usize) {
    let mut counts = [0usize; SYMBOL_COUNT];
    for &s in symbols {
        if (s as usize) < SYMBOL_COUNT {
            counts[s as usize] += 1;
        }
    }
    for (i, &count) in counts.iter().enumerate() {
        if count >= 2 {
            return (i as u8, count);
        }
    }
    (0, 0)
}

/// 处理代理商佣金（记账，不转账）
fn process_agent_commission(
    game_state: &mut GameState,
    room_card: u64,
    bet_amount: u64,
    payout: u64,
) -> Result<()> {
    let commission_rate = game_state.commission_rate;
    
    let agent_idx = game_state.agents.iter().position(|a| a.room_card == room_card && a.is_active);
    
    if let Some(idx) = agent_idx {
        let net = payout as i64 - bet_amount as i64;
        let commission_amount = (net.abs() as u64) * commission_rate as u64 / 100;
        
        if net < 0 {
            // 玩家输了，代理商获得佣金（记账）
            game_state.agents[idx].commission += commission_amount as i64;
        } else if net > 0 {
            // 玩家赢了，代理商扣除佣金（记账）
            let current_commission = game_state.agents[idx].commission;
            let deduction = commission_amount as i64;
            
            if current_commission >= deduction {
                game_state.agents[idx].commission -= deduction;
            } else {
                // 佣金不足，直接归零
                game_state.agents[idx].commission = 0;
            }
        }
    } else {
        return err!(ErrorCode::InvalidRoomCard);
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
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Play<'info> {
    #[account(mut)]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut)]
    pub game_state: Account<'info, GameState>,
    pub owner: Signer<'info>,
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
    /// CHECK: Token account validated by token program
    #[account(mut)]
    pub pool_token_account: AccountInfo<'info>,
    /// CHECK: Token account validated by token program
    #[account(mut)]
    pub owner_token_account: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawCommission<'info> {
    #[account(mut)]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub agent: Signer<'info>,
    /// CHECK: Token account validated by token program
    #[account(mut)]
    pub pool_token_account: AccountInfo<'info>,
    /// CHECK: Token account validated by token program
    #[account(mut)]
    pub agent_token_account: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

// ============== 数据结构 ==============

#[account]
pub struct GameState {
    pub owner: Pubkey,
    pub bump: u8,                              // PDA bump
    pub total_pool: u64,
    pub nonce: u64,
    pub agents: Vec<Agent>,
    pub next_room_card: u64,
    pub commission_rate: u8,
    pub stake_threshold: u64,
    pub settlement_period: u64,
    
    // Xorshift128 RNG 状态
    pub rng: XorshiftRng,
    pub symbol_weights: [u16; SYMBOL_COUNT],   // 符号出现权重 (总和=10000)
    pub payout_triple: [u16; SYMBOL_COUNT],    // 三连赔率 (x100)
    pub payout_double: [u16; SYMBOL_COUNT],    // 两连赔率 (x100)
    pub max_auto_spins: u8,                    // 最大自动转次数
}

impl GameState {
    // 32(owner) + 1(bump) + 8(pool) + 8(nonce) + 4+80*20(agents) + 8(room_card) + 1(rate) + 8(threshold) + 8(period)
    // + 16(rng) + 12(weights) + 12(triple) + 12(double) + 1(max_spins) + 200(预留)
    pub const SPACE: usize = 32 + 1 + 8 + 8 + 4 + (80 * 20) + 8 + 1 + 8 + 8 
        + 16 + (2 * 6) + (2 * 6) + (2 * 6) + 1 + 200;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Agent {
    pub pubkey: Pubkey,           // 32 字节
    pub stake: u64,               // 8 字节
    pub room_card: u64,           // 8 字节
    pub commission: i64,          // 8 字节 - 佣金余额（只记账，提取时转账）
    pub stake_time: i64,          // 8 字节
    pub last_settlement: i64,     // 8 字节
    pub is_active: bool,          // 1 字节
    // 总计：73 字节（对齐后约 80 字节）
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
