# Solana 开发环境依赖需求方案

## 环境信息
- 日期: 2026-01-20
- 系统: Linux WSL2 (Ubuntu)
- 目标: slot_machine 项目 (Anchor 0.30.1)

## 核心依赖版本

| 依赖 | 版本要求 | 安装方式 |
|------|----------|----------|
| Rust | nightly (支持 edition2024) | rustup |
| Solana CLI | v2.2.12 | agave-install |
| Anchor CLI | 0.30.1 | avm |
| platform-tools | v1.51 | Solana CLI 自动安装 |
| Node.js | >=18 (当前 v22.22.0) | 系统包管理 |
| Yarn | >=1.22 (当前 1.22.22) | npm |

## 依赖安装顺序

### 1. Rust (nightly)
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly
. "$HOME/.cargo/env"
```

### 2. Solana CLI v2.2.12
```bash
sh -c "$(curl -sSfL https://release.anza.xyz/v2.2.12/install)"
export PATH="/root/.local/share/solana/install/active_release/bin:$PATH"
echo 'export PATH="/root/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.bashrc
```

### 3. Anchor CLI 0.30.1
```bash
cargo install --git https://github.com/solana-foundation/anchor avm --force
avm install 0.30.1
avm use 0.30.1
```

### 4. Yarn
```bash
npm install -g yarn
```

## 配置文件版本锁定

### package.json
```json
{
  "@coral-xyz/anchor": "^0.32.1"
}
```

### Anchor.toml
```toml
[toolchain]
anchor_version = "0.30.1"
```

### Cargo.toml (workspace)
```toml
[workspace]
members = ["programs/*"]
resolver = "2"
```

### programs/slot_machine/Cargo.toml
```toml
[dependencies]
anchor-lang = "0.30.1"
anchor-spl = "0.30.1"
```

## 构建命令

```bash
# 配置环境
export PATH="/root/.local/share/solana/install/active_release/bin:$PATH"
. "$HOME/.cargo/env"

# 安装依赖
npm install

# 构建
anchor build

# 测试
anchor test
```

## 已知问题

1. **blake3 1.8.3 需要 edition2024**: 使用 Rust nightly 解决
2. **platform-tools 自动下载**: 首次构建时会自动下载 SBF 编译工具

## 验证命令

```bash
rustc --version      # 应显示 nightly 版本
solana --version     # 应显示 solana-cli 2.2.12
anchor --version     # 应显示 anchor-cli 0.30.1
yarn --version       # 应显示 1.22.x
node --version       # 应显示 v22.x.x
```
