use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer};
use anchor_spl::token::spl_token::instruction::AuthorityType;
use mpl_token_metadata::accounts::Metadata as MetadataPda;
use mpl_token_metadata::instructions::{CreateV1, CreateV1InstructionArgs};
use mpl_token_metadata::types::TokenStandard;

declare_id!("ADT9mwnQipeQTidQ8KaCxCs8Gxp681QAQFVmBfPMgCdp");

const MINT_DECIMALS: u8 = 9;
const TOKEN_NAME: &str = "SlotMachine Token";
const TOKEN_SYMBOL: &str = "SMT";
const TOKEN_URI: &str = "https://example.com/metadata.json";

#[program]
pub mod slot_machine_token {
    use super::*;

    pub fn initialize_mint(ctx: Context<InitializeMint>) -> Result<()> {
        super::initialize_mint(ctx)
    }

    pub fn initialize_token_account(ctx: Context<InitializeTokenAccount>) -> Result<()> {
        super::initialize_token_account(ctx)
    }

    pub fn mint_token(ctx: Context<MintToken>, amount: u64) -> Result<()> {
        super::mint_token(ctx, amount)
    }

    pub fn transfer_token(ctx: Context<TransferToken>, amount: u64) -> Result<()> {
        super::transfer_token(ctx, amount)
    }

    pub fn burn_token(ctx: Context<BurnToken>, amount: u64) -> Result<()> {
        super::burn_token(ctx, amount)
    }

    pub fn renounce_mint_authority(ctx: Context<RenounceMintAuthority>) -> Result<()> {
        super::renounce_mint_authority(ctx)
    }
}

#[error_code]
pub enum TokenError {
    #[msg("金额必须大于 0")]
    InvalidAmount,
}

#[derive(Accounts)]
pub struct InitializeMint<'info> {
    #[account(mut)]
    pub mint_authority: Signer<'info>,
    #[account(
        init,
        payer = mint_authority,
        mint::decimals = MINT_DECIMALS,
        mint::authority = mint_authority,
    )]
    pub mint: Account<'info, Mint>,
    /// CHECK: Metaplex metadata PDA; program validates the PDA derivation against mint.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: Sysvar instructions account; constrained by address.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub sysvar_instructions: UncheckedAccount<'info>,
    /// CHECK: Metaplex Token Metadata program; used for CPI.
    #[account(address = mpl_token_metadata::ID)]
    pub token_metadata_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn initialize_mint(ctx: Context<InitializeMint>) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();
    let (metadata_key, _) = MetadataPda::find_pda(&mint_key);
    require_keys_eq!(ctx.accounts.metadata.key(), metadata_key);

    let authority_key = ctx.accounts.mint_authority.key();
    let accounts = CreateV1 {
        metadata: metadata_key,
        master_edition: None,
        mint: (mint_key, false),
        authority: authority_key,
        payer: authority_key,
        update_authority: (authority_key, true),
        system_program: ctx.accounts.system_program.key(),
        sysvar_instructions: ctx.accounts.sysvar_instructions.key(),
        spl_token_program: Some(ctx.accounts.token_program.key()),
    };

    let args = CreateV1InstructionArgs {
        name: TOKEN_NAME.to_string(),
        symbol: TOKEN_SYMBOL.to_string(),
        uri: TOKEN_URI.to_string(),
        seller_fee_basis_points: 0,
        primary_sale_happened: false,
        is_mutable: true,
        token_standard: TokenStandard::Fungible,
        collection: None,
        uses: None,
        collection_details: None,
        creators: None,
        rule_set: None,
        decimals: Some(MINT_DECIMALS),
        print_supply: None,
    };

    let ix = accounts.instruction(args);
    let account_infos = [
        ctx.accounts.token_metadata_program.to_account_info(),
        ctx.accounts.metadata.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.mint_authority.to_account_info(),
        ctx.accounts.mint_authority.to_account_info(),
        ctx.accounts.mint_authority.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.sysvar_instructions.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
    ];
    invoke(&ix, &account_infos)?;
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeTokenAccount<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = owner,
    )]
    pub token_account: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn initialize_token_account(_ctx: Context<InitializeTokenAccount>) -> Result<()> {
    Ok(())
}

#[derive(Accounts)]
pub struct MintToken<'info> {
    #[account(mut)]
    pub mint_authority: Signer<'info>,
    #[account(
        mut,
        constraint = mint.mint_authority == COption::Some(mint_authority.key())
    )]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = to.mint == mint.key()
    )]
    pub to: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn mint_token(ctx: Context<MintToken>, amount: u64) -> Result<()> {
    require!(amount > 0, TokenError::InvalidAmount);
    let cpi_accounts = MintTo {
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.to.to_account_info(),
        authority: ctx.accounts.mint_authority.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token::mint_to(cpi_ctx, amount)
}

#[derive(Accounts)]
pub struct TransferToken<'info> {
    #[account(mut)]
    pub from: Signer<'info>,
    #[account(
        mut,
        constraint = from_token_account.owner == from.key(),
        constraint = from_token_account.mint == mint.key()
    )]
    pub from_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = to_token_account.mint == mint.key()
    )]
    pub to_token_account: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

pub fn transfer_token(ctx: Context<TransferToken>, amount: u64) -> Result<()> {
    require!(amount > 0, TokenError::InvalidAmount);
    let cpi_accounts = Transfer {
        from: ctx.accounts.from_token_account.to_account_info(),
        to: ctx.accounts.to_token_account.to_account_info(),
        authority: ctx.accounts.from.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token::transfer(cpi_ctx, amount)
}

#[derive(Accounts)]
pub struct BurnToken<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        constraint = token_account.owner == owner.key(),
        constraint = token_account.mint == mint.key()
    )]
    pub token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

pub fn burn_token(ctx: Context<BurnToken>, amount: u64) -> Result<()> {
    require!(amount > 0, TokenError::InvalidAmount);
    let cpi_accounts = Burn {
        mint: ctx.accounts.mint.to_account_info(),
        from: ctx.accounts.token_account.to_account_info(),
        authority: ctx.accounts.owner.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token::burn(cpi_ctx, amount)
}

#[derive(Accounts)]
pub struct RenounceMintAuthority<'info> {
    #[account(mut)]
    pub mint_authority: Signer<'info>,
    #[account(
        mut,
        constraint = mint.mint_authority == COption::Some(mint_authority.key())
    )]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

pub fn renounce_mint_authority(ctx: Context<RenounceMintAuthority>) -> Result<()> {
    let cpi_accounts = SetAuthority {
        account_or_mint: ctx.accounts.mint.to_account_info(),
        current_authority: ctx.accounts.mint_authority.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token::set_authority(cpi_ctx, AuthorityType::MintTokens, None)?;
    Ok(())
}
