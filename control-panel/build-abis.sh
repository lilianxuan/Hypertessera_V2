#!/usr/bin/env bash
# Regenerate control-panel ABIs from forge build artifacts.
# Emits BOTH:
#   abis.json  - for fetch()/tooling
#   abis.js    - window.HT_ABIS = {...}  (lets the panel run from file:// with no server)
# Run from anywhere; resolves the repo root relative to this script.
set -euo pipefail
cd "$(dirname "$0")/.."
forge build >/dev/null
CONTRACTS=(HyperAccessControl VaultTimelock AssetRegistry RWAToken NAVOracle MintBurnController StubStateManager PoRRegistry ClaimRegistry ReservePSM WrappedAsset Queue RevenuePool UnifiedPool StateManager EarnVault LiquidityEarnVault LiquidityBridge VaultFactory Settlement AdapterFactory FirstPeriodAdapter LiquidityAdapter RWAAdapter ProtocolFeeConfig KYTDepositGateway)
{
  for c in "${CONTRACTS[@]}"; do
    f=$(find out -name "$c.json" | head -1)
    jq -c --arg n "$c" '{($n): .abi}' "$f"
  done
} | jq -s 'add' > control-panel/abis.json
printf 'window.HT_ABIS = ' > control-panel/abis.js
cat control-panel/abis.json >> control-panel/abis.js
printf ';\n' >> control-panel/abis.js
echo "wrote control-panel/abis.json + abis.js ($(jq 'keys|length' control-panel/abis.json) contracts)"
