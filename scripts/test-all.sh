#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ "${SBF_SKIP_BUILD:-0}" != "1" ]]; then
  cargo-build-sbf --manifest-path programs/slot_machine/Cargo.toml
  cargo-build-sbf --manifest-path programs/slot_machine_token/Cargo.toml
fi

anchor test --skip-build

cargo test --manifest-path programs/slot_machine/Cargo.toml --tests
