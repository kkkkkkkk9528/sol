//! 老虎机合约（单文件，精简 ≤800 行）
//! 功能：
//! - Switchboard VRF 随机：支持即时玩法与两段式玩法（request_play / settle_play）
//! - 代理商：SOL 质押、房卡推广、基于净输赢的佣金累计与结算周期提取
//! - 赔率系统：6符号，两连/三连赔率；Double 触发自动连续转轮（乘数递增至 16x，受 max_auto_spins）
//! - 支付方式：绑定指定 SPL Token 奖池账户与 mint；所有下注/派彩走 SPL Token
//! - 管理功能：权重、赔率、佣金率、质押门槛、VRF 设置；奖池同步/提取/关闭
//! - 安全机制：账户与权限校验、VRF 所属与偏移校验、结算周期限制、溢出保护
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{hash::hashv, program_pack::Pack};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("8cozexydPUo9jTBT7PRWVe5Qmi3bpkjgQuPo2ZaTKHus");
pub const SWITCHBOARD_V2_PROGRAM_ID: Pubkey =
    pubkey!("SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f");

const SYMBOLS: usize = 6;
const GAME_STATE_SEED: &[u8] = b"game_state";
const MAX_AGENT_COUNT: usize = 48;

#[program]
pub mod slot_machine {
    use super::*;

    // 初始化：绑定奖池账户与 mint；写入默认参数
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        require!(
            ctx.accounts.pool_token_account.owner == &anchor_spl::token::ID,
            ErrorCode::InvalidTokenAccount
        );
        require!(
            ctx.accounts.token_mint.owner == &anchor_spl::token::ID,
            ErrorCode::InvalidMint
        );
        let pool_state =
            anchor_spl::token::spl_token::state::Account::unpack(
                &ctx.accounts.pool_token_account.data.borrow(),
            )
            .map_err(|_| error!(ErrorCode::InvalidTokenAccount))?;
        require_keys_eq!(
            pool_state.mint,
            ctx.accounts.token_mint.key(),
            ErrorCode::PoolMintMismatch
        );
        require_keys_eq!(
            pool_state.owner,
            ctx.accounts.game_state.key(),
            ErrorCode::PoolAuthorityMismatch
        );

        let s = &mut ctx.accounts.game_state;
        s.owner = ctx.accounts.user.key();
        s.bump = ctx.bumps.game_state;
        s.pool_mint = ctx.accounts.token_mint.key();
        s.pool_token_account = ctx.accounts.pool_token_account.key();
        s.total_pool = pool_state.amount;
        s.nonce = 0;
        s.agents = Vec::new();
        s.next_room_card = 10_000;
        s.commission_rate = 10;
        s.stake_threshold = 1_000_000;
        s.settlement_period = 86_400;
        s.vrf = Pubkey::default();
        s.vrf_result_offset = 0;
        s.symbol_weights = [2500, 2500, 250, 1600, 2150, 1000];
        s.payout_triple = [220, 180, 2000, 360, 450, 0];
        s.payout_double = [65, 50, 100, 75, 85, 0];
        s.max_auto_spins = 5;
        s.min_bet = 100;
        Ok(())
    }

    // 管理：佣金率
    pub fn set_commission_rate(ctx: Context<SetOwnerConfig>, rate: u8) -> Result<()> {
        let s = &mut ctx.accounts.game_state;
        require_owner(s, ctx.accounts.owner.key())?;
        require!(rate <= 100, ErrorCode::InvalidCommissionRate);
        s.commission_rate = rate;
        Ok(())
    }
    // 管理：质押门槛（lamports）
    pub fn set_stake_threshold(ctx: Context<SetOwnerConfig>, threshold: u64) -> Result<()> {
        let s = &mut ctx.accounts.game_state;
        require_owner(s, ctx.accounts.owner.key())?;
        s.stake_threshold = threshold;
        Ok(())
    }
    // 管理：最低下注额（SPL Token 最小单位）
    pub fn set_min_bet(ctx: Context<SetOwnerConfig>, min_bet: u64) -> Result<()> {
        let s = &mut ctx.accounts.game_state;
        require_owner(s, ctx.accounts.owner.key())?;
        require!(min_bet > 0, ErrorCode::InvalidAmount);
        s.min_bet = min_bet;
        Ok(())
    }
    // 管理：符号权重（概率）
    pub fn set_symbol_weights(ctx: Context<SetOwnerConfig>, w: [u16; 6]) -> Result<()> {
        let s = &mut ctx.accounts.game_state;
        require_owner(s, ctx.accounts.owner.key())?;
        validate_weights(&w)?;
        s.symbol_weights = w;
        Ok(())
    }
    // 管理：三连赔率（百分比）
    pub fn set_payout_triple(ctx: Context<SetOwnerConfig>, p: [u16; 6]) -> Result<()> {
        let s = &mut ctx.accounts.game_state;
        require_owner(s, ctx.accounts.owner.key())?;
        s.payout_triple = p;
        Ok(())
    }
    // 管理：两连赔率（百分比）
    pub fn set_payout_double(ctx: Context<SetOwnerConfig>, p: [u16; 6]) -> Result<()> {
        let s = &mut ctx.accounts.game_state;
        require_owner(s, ctx.accounts.owner.key())?;
        s.payout_double = p;
        Ok(())
    }
    // 管理：VRF 账户与偏移
    pub fn set_vrf(ctx: Context<SetOwnerConfig>, vrf: Pubkey, offset: u32) -> Result<()> {
        let s = &mut ctx.accounts.game_state;
        require_owner(s, ctx.accounts.owner.key())?;
        s.vrf = vrf;
        s.vrf_result_offset = offset;
        Ok(())
    }
    // 管理：设置支付代币（绑定奖池账户与 mint）
    pub fn set_payment_token(ctx: Context<SetPaymentToken>) -> Result<()> {
        let s = &mut ctx.accounts.game_state;
        let game_key = s.key();
        require_owner(s, ctx.accounts.owner.key())?;
        let pool_state =
            anchor_spl::token::spl_token::state::Account::unpack(
                &ctx.accounts.pool_token_account.to_account_info().data.borrow(),
            )
            .map_err(|_| error!(ErrorCode::InvalidTokenAccount))?;
        require_keys_eq!(
            pool_state.mint,
            ctx.accounts.token_mint.key(),
            ErrorCode::PoolMintMismatch
        );
        require_keys_eq!(pool_state.owner, game_key, ErrorCode::PoolAuthorityMismatch);
        s.pool_mint = ctx.accounts.token_mint.key();
        s.pool_token_account = ctx.accounts.pool_token_account.key();
        s.total_pool = ctx.accounts.pool_token_account.amount;
        Ok(())
    }

    // 管理：同步奖池余额
    pub fn sync_pool_total(ctx: Context<SyncPoolTotal>) -> Result<()> {
        let s = &mut ctx.accounts.game_state;
        require_owner(s, ctx.accounts.owner.key())?;
        require_keys_eq!(
            ctx.accounts.pool_token_account.key(),
            s.pool_token_account,
            ErrorCode::InvalidPoolAccount
        );
        s.total_pool = ctx.accounts.pool_token_account.amount;
        Ok(())
    }
    // 管理：提取奖池资金
    pub fn withdraw_pool(ctx: Context<WithdrawPool>, amount: u64) -> Result<()> {
        let s = &mut ctx.accounts.game_state;
        require_owner(s, ctx.accounts.owner.key())?;
        require_keys_eq!(
            ctx.accounts.pool_token_account.key(),
            s.pool_token_account,
            ErrorCode::InvalidPoolAccount
        );
        require_keys_eq!(
            ctx.accounts.pool_token_account.mint,
            s.pool_mint,
            ErrorCode::PoolMintMismatch
        );
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(
            ctx.accounts.pool_token_account.amount >= amount,
            ErrorCode::InsufficientPool
        );
        require!(s.total_pool >= amount, ErrorCode::InsufficientPool);
        pool_transfer_signed(
            &*s,
            &ctx.accounts.token_program,
            &ctx.accounts.pool_token_account,
            &ctx.accounts.owner_token_account,
            amount,
        )?;
        s.total_pool = s
            .total_pool
            .checked_sub(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        Ok(())
    }
    // 管理：关闭游戏（清空奖池）
    pub fn close_game(ctx: Context<CloseGame>) -> Result<()> {
        let s = &mut ctx.accounts.game_state;
        require_owner(s, ctx.accounts.owner.key())?;
        require_keys_eq!(
            ctx.accounts.pool_token_account.key(),
            s.pool_token_account,
            ErrorCode::InvalidPoolAccount
        );
        require_keys_eq!(
            ctx.accounts.pool_token_account.mint,
            s.pool_mint,
            ErrorCode::PoolMintMismatch
        );
        let amount = ctx.accounts.pool_token_account.amount;
        if amount > 0 {
            pool_transfer_signed(
                &*s,
                &ctx.accounts.token_program,
                &ctx.accounts.pool_token_account,
                &ctx.accounts.owner_token_account,
                amount,
            )?;
        }
        s.total_pool = 0;
        Ok(())
    }

    // 代理商：SOL 质押成为代理商（分配房卡）
    pub fn become_agent(ctx: Context<BecomeAgent>, stake_amount: u64) -> Result<()> {
        let s = &mut ctx.accounts.game_state;
        require!(stake_amount >= s.stake_threshold, ErrorCode::StakeBelowThreshold);
        require!(s.agents.len() < MAX_AGENT_COUNT, ErrorCode::TooManyAgents);
        let now = Clock::get()?.unix_timestamp;
        invoke_sol_transfer(
            &ctx.accounts.agent.to_account_info(),
            &s.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            stake_amount,
        )?;
        let agent_key = ctx.accounts.agent.key();
        if let Some(i) = s.agents.iter().position(|a| a.pubkey == agent_key) {
            let mut room_card = s.agents[i].room_card;
            if room_card == 0 {
                room_card = s.next_room_card;
                s.next_room_card = s
                    .next_room_card
                    .checked_add(1)
                    .ok_or(ErrorCode::MathOverflow)?;
            }
            let a = &mut s.agents[i];
            a.stake = a.stake.checked_add(stake_amount).ok_or(ErrorCode::MathOverflow)?;
            a.is_active = true;
            a.room_card = room_card;
            a.stake_time = now;
            if a.last_settlement < 0 {
                a.last_settlement = now;
            }
            return Ok(());
        }
        let room_card = s.next_room_card;
        s.next_room_card = s
            .next_room_card
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;
        s.agents.push(Agent {
            pubkey: agent_key,
            stake: stake_amount,
            room_card,
            commission: 0,
            stake_time: now,
            last_settlement: now,
            is_active: true,
        });
        Ok(())
    }
    // 代理商：赎回质押（stake/房卡/佣金）
    pub fn redeem_agent_stake(ctx: Context<RedeemAgentStake>) -> Result<()> {
        let s = &mut ctx.accounts.game_state;
        let k = ctx.accounts.agent.key();
        let i = s
            .agents
            .iter()
            .position(|a| a.pubkey == k)
            .ok_or(ErrorCode::AgentNotFound)?;
        let amount = s.agents[i].stake;
        require!(amount > 0, ErrorCode::NoStakeToRedeem);
        let vault = **s.to_account_info().lamports.borrow();
        require!(vault >= amount, ErrorCode::InsufficientStakeVault);
        **s.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.agent.to_account_info().try_borrow_mut_lamports()? += amount;
        let a = &mut s.agents[i];
        a.stake = 0;
        a.room_card = 0;
        a.commission = 0;
        Ok(())
    }
    // 代理商：提取佣金（需满足结算周期）
    pub fn withdraw_commission(ctx: Context<WithdrawCommission>) -> Result<()> {
        let s = &mut ctx.accounts.game_state;
        require_keys_eq!(
            ctx.accounts.pool_token_account.key(),
            s.pool_token_account,
            ErrorCode::InvalidPoolAccount
        );
        let k = ctx.accounts.agent.key();
        let i = s
            .agents
            .iter()
            .position(|a| a.pubkey == k)
            .ok_or(ErrorCode::AgentNotFound)?;
        let now = Clock::get()?.unix_timestamp;
        require!(s.agents[i].room_card > 0, ErrorCode::AgentInactive);
        let elapsed = now.saturating_sub(s.agents[i].last_settlement);
        require!(
            elapsed >= s.settlement_period as i64,
            ErrorCode::SettlementNotReady
        );
        let amount: u64 = s.agents[i]
            .commission
            .try_into()
            .map_err(|_| error!(ErrorCode::InvalidCommissionBalance))?;
        require!(amount > 0, ErrorCode::NoCommissionToWithdraw);
        require!(
            ctx.accounts.pool_token_account.amount >= amount,
            ErrorCode::InsufficientPool
        );
        require!(s.total_pool >= amount, ErrorCode::InsufficientPool);
        pool_transfer_signed(
            &*s,
            &ctx.accounts.token_program,
            &ctx.accounts.pool_token_account,
            &ctx.accounts.agent_token_account,
            amount,
        )?;
        s.total_pool = s
            .total_pool
            .checked_sub(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        s.agents[i].commission = 0;
        s.agents[i].last_settlement = now;
        Ok(())
    }

    // 即时玩法：下注→读取 VRF →派彩→代理佣金
    pub fn play(ctx: Context<Play>, bets: [u64; 6], room_card: Option<u64>) -> Result<()> {
        let s = &mut ctx.accounts.game_state;
        validate_bets(&bets, s.min_bet)?;
        require_keys_eq!(
            ctx.accounts.pool_token_account.key(),
            s.pool_token_account,
            ErrorCode::InvalidPoolAccount
        );
        let total_bet = bets_total(&bets)?;
        pool_transfer_from_user(
            &ctx.accounts.token_program,
            &ctx.accounts.player_token_account,
            &ctx.accounts.pool_token_account,
            &ctx.accounts.player,
            total_bet,
        )?;
        s.total_pool = s
            .total_pool
            .checked_add(total_bet)
            .ok_or(ErrorCode::MathOverflow)?;
        let vrf = read_vrf_bytes(&ctx.accounts.vrf, s.vrf, s.vrf_result_offset)?;
        let seed = derive_seed(vrf, Some(ctx.accounts.player.key()), Some(s.nonce), Some(Clock::get()?.slot), None);
        s.nonce = s.nonce.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
        let (payout, _, _, _) = compute_total_payout(seed, &bets, s)?;
        if payout > 0 {
            require!(
                ctx.accounts.pool_token_account.amount >= payout,
                ErrorCode::InsufficientPool
            );
            require!(s.total_pool >= payout, ErrorCode::InsufficientPool);
            pool_transfer_signed(
                &*s,
                &ctx.accounts.token_program,
                &ctx.accounts.pool_token_account,
                &ctx.accounts.player_token_account,
                payout,
            )?;
            s.total_pool = s
                .total_pool
                .checked_sub(payout)
                .ok_or(ErrorCode::MathOverflow)?;
        }
        apply_agent_commission(s, room_card, total_bet, payout)?;
        Ok(())
    }
    // 两段式玩法：先扣款记录 VRF 前镜像；结算时要求 VRF 结果更新
    pub fn request_play(ctx: Context<RequestPlay>, bets: [u64; 6], room_card: Option<u64>) -> Result<()> {
        let s = &mut ctx.accounts.game_state;
        validate_bets(&bets, s.min_bet)?;
        require_keys_eq!(
            ctx.accounts.pool_token_account.key(),
            s.pool_token_account,
            ErrorCode::InvalidPoolAccount
        );
        require_keys_eq!(ctx.accounts.vrf.key(), s.vrf, ErrorCode::InvalidVrfAccount);
        if let Some(card) = room_card {
            require!(
                find_active_agent_by_room_card(s, card).is_some(),
                ErrorCode::InvalidRoomCard
            );
        }
        let total_bet = bets_total(&bets)?;
        pool_transfer_from_user(
            &ctx.accounts.token_program,
            &ctx.accounts.player_token_account,
            &ctx.accounts.pool_token_account,
            &ctx.accounts.player,
            total_bet,
        )?;
        s.total_pool = s
            .total_pool
            .checked_add(total_bet)
            .ok_or(ErrorCode::MathOverflow)?;
        let before = read_vrf_bytes(&ctx.accounts.vrf, s.vrf, s.vrf_result_offset)?;
        let nonce = s.nonce;
        s.nonce = s.nonce.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
        let slot = Clock::get()?.slot;
        let p = &mut ctx.accounts.pending_play;
        p.player = ctx.accounts.player.key();
        p.player_token_account = ctx.accounts.player_token_account.key();
        p.pool_token_account = ctx.accounts.pool_token_account.key();
        p.request_nonce = nonce;
        p.request_slot = slot;
        p.total_bet = total_bet;
        p.bets = bets;
        p.has_room_card = room_card.is_some();
        p.room_card = room_card.unwrap_or_default();
        p.vrf_result_before = before;
        Ok(())
    }
    pub fn settle_play(ctx: Context<SettlePlay>) -> Result<()> {
        let s = &mut ctx.accounts.game_state;
        require_keys_eq!(
            ctx.accounts.pool_token_account.key(),
            s.pool_token_account,
            ErrorCode::InvalidPoolAccount
        );
        require_keys_eq!(ctx.accounts.vrf.key(), s.vrf, ErrorCode::InvalidVrfAccount);
        let p = &ctx.accounts.pending_play;
        require_keys_eq!(p.player, ctx.accounts.player.key(), ErrorCode::PlayerMismatch);
        require_keys_eq!(
            p.player_token_account,
            ctx.accounts.player_token_account.key(),
            ErrorCode::PlayerTokenMismatch
        );
        require_keys_eq!(
            p.pool_token_account,
            ctx.accounts.pool_token_account.key(),
            ErrorCode::InvalidPoolAccount
        );
        let after = read_vrf_bytes(&ctx.accounts.vrf, s.vrf, s.vrf_result_offset)?;
        require!(after != p.vrf_result_before, ErrorCode::VrfNotUpdated);
        let seed = derive_seed(
            p.vrf_result_before,
            Some(p.player),
            Some(p.request_nonce),
            Some(p.request_slot),
            Some(after),
        );
        let (payout, _, _, _) = compute_total_payout(seed, &p.bets, s)?;
        if payout > 0 {
            require!(
                ctx.accounts.pool_token_account.amount >= payout,
                ErrorCode::InsufficientPool
            );
            require!(s.total_pool >= payout, ErrorCode::InsufficientPool);
            pool_transfer_signed(
                &*s,
                &ctx.accounts.token_program,
                &ctx.accounts.pool_token_account,
                &ctx.accounts.player_token_account,
                payout,
            )?;
            s.total_pool = s
                .total_pool
                .checked_sub(payout)
                .ok_or(ErrorCode::MathOverflow)?;
        }
        apply_agent_commission(
            s,
            p.has_room_card.then_some(p.room_card),
            p.total_bet,
            payout,
        )?;
        Ok(())
    }
}

// 账户
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = user, space = 8 + GameState::SPACE, seeds = [GAME_STATE_SEED], bump)]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: 仅用于读取 mint 公钥；初始化时已校验其 owner 为 SPL Token 程序
    pub token_mint: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: 初始化时会 unpack 并校验其为 TokenAccount、mint 匹配且 authority 为 game_state PDA
    pub pool_token_account: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct SetOwnerConfig<'info> {
    #[account(mut, seeds = [GAME_STATE_SEED], bump = game_state.bump)]
    pub game_state: Account<'info, GameState>,
    pub owner: Signer<'info>,
}
#[derive(Accounts)]
pub struct SetPaymentToken<'info> {
    #[account(mut, seeds = [GAME_STATE_SEED], bump = game_state.bump)]
    pub game_state: Account<'info, GameState>,
    pub owner: Signer<'info>,
    /// CHECK: 仅用于读取 mint 公钥；并通过 pool_token_account 的 unpack 校验 mint 匹配
    pub token_mint: UncheckedAccount<'info>,
    #[account(mut)]
    pub pool_token_account: Account<'info, TokenAccount>,
}
#[derive(Accounts)]
pub struct SyncPoolTotal<'info> {
    #[account(mut, seeds = [GAME_STATE_SEED], bump = game_state.bump)]
    pub game_state: Account<'info, GameState>,
    pub owner: Signer<'info>,
    pub pool_token_account: Account<'info, TokenAccount>,
}
#[derive(Accounts)]
pub struct WithdrawPool<'info> {
    #[account(mut, seeds = [GAME_STATE_SEED], bump = game_state.bump)]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub pool_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
#[derive(Accounts)]
pub struct CloseGame<'info> {
    #[account(mut, close = owner, seeds = [GAME_STATE_SEED], bump = game_state.bump)]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub pool_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
#[derive(Accounts)]
pub struct BecomeAgent<'info> {
    #[account(mut, seeds = [GAME_STATE_SEED], bump = game_state.bump)]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub agent: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct RedeemAgentStake<'info> {
    #[account(mut, seeds = [GAME_STATE_SEED], bump = game_state.bump)]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub agent: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct WithdrawCommission<'info> {
    #[account(mut, seeds = [GAME_STATE_SEED], bump = game_state.bump)]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub agent: Signer<'info>,
    #[account(mut)]
    pub pool_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub agent_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
#[derive(Accounts)]
pub struct Play<'info> {
    #[account(mut, seeds = [GAME_STATE_SEED], bump = game_state.bump)]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut)]
    pub player_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub pool_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    /// CHECK: 通过 read_vrf_bytes 校验 key/owner/offset，并只读取数据
    pub vrf: UncheckedAccount<'info>,
}
#[derive(Accounts)]
pub struct RequestPlay<'info> {
    #[account(mut, seeds = [GAME_STATE_SEED], bump = game_state.bump)]
    pub game_state: Account<'info, GameState>,
    #[account(init, payer = player, space = 8 + PendingPlay::SPACE)]
    pub pending_play: Account<'info, PendingPlay>,
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut)]
    pub player_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub pool_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    /// CHECK: 通过 read_vrf_bytes 校验 key/owner/offset，并只读取数据
    pub vrf: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct SettlePlay<'info> {
    #[account(mut, seeds = [GAME_STATE_SEED], bump = game_state.bump)]
    pub game_state: Account<'info, GameState>,
    #[account(mut, close = player)]
    pub pending_play: Account<'info, PendingPlay>,
    #[account(mut)]
    /// CHECK: 仅作为 close 目标接收 lamports；并在指令中校验其 pubkey == pending_play.player
    pub player: UncheckedAccount<'info>,
    #[account(mut)]
    pub player_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub pool_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    /// CHECK: 通过 read_vrf_bytes 校验 key/owner/offset，并只读取数据
    pub vrf: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// 状态
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
    pub settlement_period: u64,
    pub vrf: Pubkey,
    pub vrf_result_offset: u32,
    pub symbol_weights: [u16; 6],
    pub payout_triple: [u16; 6],
    pub payout_double: [u16; 6],
    pub max_auto_spins: u8,
    pub min_bet: u64,
}
impl GameState {
    pub const SPACE: usize = 4096;
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
#[account]
pub struct PendingPlay {
    pub player: Pubkey,
    pub player_token_account: Pubkey,
    pub pool_token_account: Pubkey,
    pub request_nonce: u64,
    pub request_slot: u64,
    pub total_bet: u64,
    pub bets: [u64; 6],
    pub has_room_card: bool,
    pub room_card: u64,
    pub vrf_result_before: [u8; 32],
}
impl PendingPlay {
    pub const SPACE: usize = 8 * 6 + 32 * 3 + 8 * 4 + 1 + 32 + 64;
}

// 工具函数：权限/下注/VRF/派彩/转账
fn require_owner(s: &GameState, signer: Pubkey) -> Result<()> {
    require_keys_eq!(s.owner, signer, ErrorCode::Unauthorized);
    Ok(())
}
fn validate_bets(b: &[u64; 6], min_bet: u64) -> Result<()> {
    require!(b[5] == 0, ErrorCode::InvalidBetTable);
    let total = bets_total(b)?;
    require!(total > 0, ErrorCode::InvalidAmount);
    if min_bet > 0 {
        for i in 0..5 { let v = b[i]; if v > 0 {
                require!(v >= min_bet, ErrorCode::BetBelowMinimum);
            }
        }
    }
    Ok(())
}
fn validate_weights(w: &[u16; 6]) -> Result<()> {
    let mut sum = 0u32;
    for x in w.iter() {
        require!(*x > 0, ErrorCode::InvalidSymbolWeights);
        sum = sum.checked_add(*x as u32).ok_or(ErrorCode::MathOverflow)?;
    }
    require!(sum == 10_000, ErrorCode::InvalidSymbolWeights);
    Ok(())
}
fn bets_total(b: &[u64; 6]) -> Result<u64> {
    Ok(
        b.iter()
            .try_fold(0u64, |acc, x| acc.checked_add(*x).ok_or(ErrorCode::MathOverflow))?,
    )
}
fn invoke_sol_transfer<'a>(
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    sys: &AccountInfo<'a>,
    lamports: u64,
) -> Result<()> {
    let ix = anchor_lang::solana_program::system_instruction::transfer(from.key, to.key, lamports);
    anchor_lang::solana_program::program::invoke(&ix, &[from.clone(), to.clone(), sys.clone()])?;
    Ok(())
}
fn read_vrf_bytes(vrf: &UncheckedAccount, expected: Pubkey, offset: u32) -> Result<[u8; 32]> {
    require_keys_eq!(vrf.key(), expected, ErrorCode::InvalidVrfAccount);
    require!(vrf.owner == &SWITCHBOARD_V2_PROGRAM_ID, ErrorCode::InvalidVrfOwner);
    let data = vrf.try_borrow_data()?;
    let s = offset as usize;
    let e = s.checked_add(32).ok_or(ErrorCode::MathOverflow)?;
    require!(data.len() >= e, ErrorCode::InvalidVrfData);
    let mut out = [0u8; 32];
    out.copy_from_slice(&data[s..e]);
    Ok(out)
}
fn derive_seed(
    vrf: [u8; 32],
    player: Option<Pubkey>,
    nonce: Option<u64>,
    slot: Option<u64>,
    after: Option<[u8; 32]>,
) -> [u8; 32] {
    let nb = nonce.unwrap_or_default().to_le_bytes();
    let sb = slot.unwrap_or_default().to_le_bytes();
    let p = player.unwrap_or_default();
    match after {
        Some(a) => hashv(&[b"SLOT_SETTLE", &vrf, &a, p.as_ref(), &nb, &sb]).to_bytes(),
        None => hashv(&[b"SLOT_PLAY", &vrf, p.as_ref(), &nb, &sb]).to_bytes(),
    }
}
fn next_seed(s: [u8; 32], c: u64) -> [u8; 32] {
    hashv(&[b"SLOT_RNG", &s, &c.to_le_bytes()]).to_bytes()
}
fn pick_symbol(seed: [u8; 32], w: &[u16; 6]) -> Result<u8> {
    let mut sum = 0u32;
    for x in w.iter() {
        sum = sum.checked_add(*x as u32).ok_or(ErrorCode::MathOverflow)?;
    }
    require!(sum > 0, ErrorCode::InvalidSymbolWeights);
    let mut r = (u16::from_le_bytes([seed[0], seed[1]]) as u32) % sum;
    for (i, &ww) in w.iter().enumerate() {
        let v = ww as u32;
        if r < v {
            return Ok(i as u8);
        }
        r -= v;
    }
    Ok((SYMBOLS - 1) as u8)
}
fn compute_spin_payout(b: &[u64; 6], reels: [u8; 3], s: &GameState) -> Result<u64> {
    let mut total = 0u64;
    for sym in 0..SYMBOLS {
        let bet = b[sym];
        if bet == 0 {
            continue;
        }
        let m = (reels[0] == sym as u8) as u8
            + (reels[1] == sym as u8) as u8
            + (reels[2] == sym as u8) as u8;
        let rate = if m == 3 {
            s.payout_triple[sym]
        } else if m == 2 {
            s.payout_double[sym]
        } else {
            0
        };
        if rate == 0 {
            continue;
        }
        let win = (bet as u128)
            .checked_mul(rate as u128)
            .ok_or(ErrorCode::MathOverflow)?
            / 100u128;
        total = total
            .checked_add(u64::try_from(win).map_err(|_| error!(ErrorCode::MathOverflow))?)
            .ok_or(ErrorCode::MathOverflow)?;
    }
    Ok(total)
}
fn compute_total_payout(
    seed: [u8; 32],
    bets: &[u64; 6],
    s: &GameState,
) -> Result<(u64, u8, u8, [u8; 3])> {
    let mut cur = seed;
    let mut c = 0u64;
    let mut mul = 1u8;
    let mut doubles = 0u8;
    let mut total = 0u64;
    let mut last: [u8; 3];
    loop {
        let mut reels = [0u8; 3];
        for i in 0..3 {
            cur = next_seed(cur, c);
            c = c.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
            reels[i] = pick_symbol(cur, &s.symbol_weights)?;
        }
        last = reels;
        let payout = compute_spin_payout(bets, reels, s)?;
        let scaled = (payout as u128)
            .checked_mul(mul as u128)
            .ok_or(ErrorCode::MathOverflow)?;
        total = total
            .checked_add(u64::try_from(scaled).map_err(|_| error!(ErrorCode::MathOverflow))?)
            .ok_or(ErrorCode::MathOverflow)?;
        if !reels.iter().any(|x| *x == 5) {
            break;
        }
        if doubles >= s.max_auto_spins || mul >= 16 {
            break;
        }
        mul = mul.checked_mul(2).ok_or(ErrorCode::MathOverflow)?;
        doubles = doubles.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
    }
    Ok((total, doubles, mul, last))
}
fn find_active_agent_by_room_card<'a>(s: &'a GameState, card: u64) -> Option<&'a Agent> {
    s.agents.iter().find(|a| a.room_card == card && a.room_card > 0)
}
fn apply_agent_commission(
    s: &mut GameState,
    card: Option<u64>,
    total_bet: u64,
    payout: u64,
) -> Result<()> {
    let Some(card) = card else { return Ok(()); };
    let a = s
        .agents
        .iter_mut()
        .find(|x| x.is_active && x.room_card == card)
        .ok_or(ErrorCode::InvalidRoomCard)?;
    let net = payout as i128 - total_bet as i128;
    let rate = s.commission_rate as i128;
    if rate == 0 {
        return Ok(());
    }
    if net < 0 {
        let delta = ((-net) as u128)
            .checked_mul(rate as u128)
            .ok_or(ErrorCode::MathOverflow)?
            / 100u128;
        a.commission = a
            .commission
            .checked_add(i64::try_from(delta).map_err(|_| error!(ErrorCode::MathOverflow))?)
            .ok_or(ErrorCode::MathOverflow)?;
    } else if net > 0 {
        if a.commission == 0 { return Ok(()); }
        let delta = (net as u128)
            .checked_mul(rate as u128)
            .ok_or(ErrorCode::MathOverflow)?
            / 100u128;
        let di = i64::try_from(delta).map_err(|_| error!(ErrorCode::MathOverflow))?;
        a.commission = a.commission.saturating_sub(di).max(0);
    }
    Ok(())
}
fn pool_transfer_signed<'info>(
    gs: &Account<'info, GameState>,
    tp: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    amount: u64,
) -> Result<()> {
    let seeds = &[GAME_STATE_SEED, &[gs.bump]];
    let signer = &[&seeds[..]];
    let cpi = CpiContext::new_with_signer(
        tp.to_account_info(),
        Transfer {
            from: from.to_account_info(),
            to: to.to_account_info(),
            authority: gs.to_account_info(),
        },
        signer,
    );
    token::transfer(cpi, amount)
}
fn pool_transfer_from_user<'info>(
    tp: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    user: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    let cpi = CpiContext::new(
        tp.to_account_info(),
        Transfer {
            from: from.to_account_info(),
            to: to.to_account_info(),
            authority: user.to_account_info(),
        },
    );
    token::transfer(cpi, amount)
}

// 错误码
#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized")] Unauthorized,
    #[msg("Invalid amount")] InvalidAmount,
    #[msg("BetBelowMinimum")] BetBelowMinimum,
    #[msg("Math overflow")] MathOverflow,
    #[msg("Invalid pool token account")] InvalidPoolAccount,
    #[msg("Insufficient pool")] InsufficientPool,
    #[msg("Invalid token account")] InvalidTokenAccount,
    #[msg("Invalid mint")] InvalidMint,
    #[msg("Pool mint mismatch")] PoolMintMismatch,
    #[msg("Pool authority mismatch")] PoolAuthorityMismatch,
    #[msg("Invalid commission rate")] InvalidCommissionRate,
    #[msg("InvalidSymbolWeights")] InvalidSymbolWeights,
    #[msg("InvalidBetTable")] InvalidBetTable,
    #[msg("Stake below threshold")] StakeBelowThreshold,
    #[msg("Too many agents")] TooManyAgents,
    #[msg("Agent not found")] AgentNotFound,
    #[msg("Agent inactive")] AgentInactive,
    #[msg("No stake to redeem")] NoStakeToRedeem,
    #[msg("Insufficient stake vault")] InsufficientStakeVault,
    #[msg("Settlement not ready")] SettlementNotReady,
    #[msg("No commission to withdraw")] NoCommissionToWithdraw,
    #[msg("Invalid commission balance")] InvalidCommissionBalance,
    #[msg("Invalid room card")] InvalidRoomCard,
    #[msg("Invalid VRF account")] InvalidVrfAccount,
    #[msg("Invalid VRF owner")] InvalidVrfOwner,
    #[msg("Invalid VRF data")] InvalidVrfData,
    #[msg("VRF not updated")] VrfNotUpdated,
    #[msg("Player mismatch")] PlayerMismatch,
    #[msg("Player token mismatch")] PlayerTokenMismatch,
}
