#!/usr/bin/env bash
#
# HyperTessera deployment driver.
#
# The protocol is deployed in two parts: a shared platform that exists once, and Vaults that are
# created one at a time, whenever the protocol needs another one.
#
#   ./script/deploy.sh --network anvil                        # platform (+ demo vaults on demo)
#   ./script/deploy.sh --network bsc-mainnet                  # platform only, no vaults
#   ./script/deploy.sh --network bsc-mainnet --vault cash     # add one Cash vault
#   ./script/deploy.sh --network bsc-mainnet --vault lp       # add one LP vault
#   VAULT=0xAbc... ./script/deploy.sh -n bsc-mainnet --vault cash   # wire an existing vault
#   ./script/deploy.sh --network bsc-mainnet --vault cash --label cash2   # a second Cash vault
#   ./script/deploy.sh --network bsc-mainnet --kyt cash       # add the KYT gateway in front of it
#   ./script/deploy.sh --network bsc-mainnet --dry-run        # simulate stage 1, broadcast nothing
#
# Network settings live in script/deploy/networks/<name>.env. See the deployment handbook,
# docs/deployment-handbook.md, for the full variable reference.
#
# Platform stages (run in order, once per deployment):
#   1 core      governance, asset infrastructure, revenue pool, PSM (+ demo assets)
#   2 platform  StateManager, UnifiedPool, Queue, LiquidityBridge, VaultFactory, Settlement,
#               AdapterFactory, ClaimRegistry — everything shared, and no Vault
#
# Vault stage (repeatable, once per Vault):
#   --vault cash|note|lp   deploys or adopts one Vault and does all of its wiring
#
# Optional add-on module (repeatable, once per Vault, run after that Vault exists):
#   --kyt <vault-label>    deploys a KYTDepositGateway in front of that Vault and, while the Vault
#                          is still CONFIGURING, installs it as the Vault's gate. Vaults without it
#                          are unaffected. See docs/deployment-handbook.md section 12.
#
# --dry-run simulates the FIRST stage of the requested range and stops. Later stages cannot be
# simulated on a fresh chain: each one calls contracts the previous stage deployed, and in a dry run
# those were never broadcast. Use `--dry-run --from N` to rehearse stage N against a chain where
# stages 1..N-1 already exist (a fork, or a partially-completed deployment).
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"
PANEL="$REPO_ROOT/control-panel"

NETWORK=""
FROM_STAGE=1
TO_STAGE=2
DRY_RUN=0
VAULT_KIND=""
VAULT_LABEL=""
KYT_TARGET=""

die() { echo "ERROR: $*" >&2; exit 1; }
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

usage() {
  sed -n '3,36p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --network|-n) NETWORK="${2:-}"; shift 2 ;;
    --vault)      VAULT_KIND="${2:-}"; shift 2 ;;
    --kyt)        KYT_TARGET="${2:-}"; shift 2 ;;
    --label)      VAULT_LABEL="${2:-}"; shift 2 ;;
    --from)       FROM_STAGE="${2:-}"; shift 2 ;;
    --to)         TO_STAGE="${2:-}"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --help|-h)    usage 0 ;;
    *)            echo "unknown argument: $1" >&2; usage 1 ;;
  esac
done

[ -n "$NETWORK" ] || die "--network is required (one of: $(ls script/deploy/networks/*.env 2>/dev/null | xargs -n1 basename | sed 's/\.env$//' | tr '\n' ' '))"
NET_FILE="script/deploy/networks/${NETWORK}.env"
[ -f "$NET_FILE" ] || die "no such network file: $NET_FILE"

case "${VAULT_KIND:-none}" in
  none|cash|note|lp) ;;
  *) die "--vault must be one of: cash, note, lp" ;;
esac
[ -n "$VAULT_KIND" ] || [ -z "$VAULT_LABEL" ] || die "--label only means something together with --vault"
[ -z "$KYT_TARGET" ] || [ -z "$VAULT_KIND" ] || die "--kyt and --vault are separate runs; do the vault first, then the gateway"

command -v forge >/dev/null || die "forge not found — install Foundry (https://getfoundry.sh)"
command -v jq    >/dev/null || die "jq not found — required to merge stage outputs"
command -v cast  >/dev/null || die "cast not found — install Foundry (https://getfoundry.sh)"

# The network file is the only place deployment settings live; nothing is hardcoded here.
# shellcheck disable=SC1090
set -a; . "./$NET_FILE"; set +a

[ -n "${RPC_URL:-}" ] || die "$NET_FILE must set RPC_URL"
DEPLOY_PROFILE="${DEPLOY_PROFILE:-demo}"
export DEPLOY_PROFILE
FORGE_FLAGS="${FORGE_FLAGS:-}"

# Resolve the deploy wallet. `forge` auto-loads the repo .env, which on this project holds a real
# testnet key — pinning the key here means a network file always wins over whatever .env holds.
DEPLOYER_PK="${TEST_PK:-${PRIVATE_KEY:-}}"
if [ -z "$DEPLOYER_PK" ]; then
  [ "$DEPLOY_PROFILE" = "demo" ] || die "production profile requires TEST_PK or PRIVATE_KEY"
  DEPLOYER_PK="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" # anvil account 0
fi
export TEST_PK="$DEPLOYER_PK"
DEPLOYER="$(cast wallet address --private-key "$DEPLOYER_PK")"

# Single-wallet bring-up: under the demo profile any unset operator role falls back to the deploy
# wallet, which is how every testnet generation to date has been run. Production requires each one
# to be named explicitly — the stage scripts enforce that, this only avoids a confusing forge error.
if [ "$DEPLOY_PROFILE" = "demo" ]; then
  export SETTLEMENT_OPERATORS="${SETTLEMENT_OPERATORS:-$DEPLOYER}"
  export SETTLEMENT_THRESHOLD="${SETTLEMENT_THRESHOLD:-1}"
  export DATA_PROVIDER_SIGNER="${DATA_PROVIDER_SIGNER:-$DEPLOYER}"
else
  REQUIRED="USDT"
  # Only a Vault run needs the Vault-local roles and the operator set; a platform-only run does not,
  # and must not be blocked on values that are not yet decided.
  [ -n "$VAULT_KIND" ] && REQUIRED="$REQUIRED SETTLEMENT_OPERATORS SETTLEMENT_THRESHOLD DATA_PROVIDER_SIGNER VAULT_CURATOR VAULT_KEEPER VAULT_GUARDIAN VAULT_ALLOCATOR"
  # The KYT add-on needs its own two accounts and none of the Vault roles.
  [ -n "$KYT_TARGET" ] && REQUIRED="$REQUIRED KYT_ORACLE KYT_ADMIN"
  for v in $REQUIRED; do
    [ -n "${!v:-}" ] || die "$NET_FILE must set $v under DEPLOY_PROFILE=production"
  done
fi

CORE_OUT="$PANEL/deployments.json"
PLATFORM_OUT="$PANEL/deployments-platform.json"
STAGE_OUTPUTS=("$CORE_OUT" "$PLATFORM_OUT")

addr() { # addr <file> <key>
  local v
  v="$(jq -r --arg k "$2" '.addresses[$k] // empty' "$1" 2>/dev/null || true)"
  [ -n "$v" ] && [ "$v" != "null" ] || die "missing address '$2' in $(basename "$1") — run the earlier stage first"
  echo "$v"
}

# A simulated stage still executes vm.writeJson, so it would overwrite the address book of the
# deployment that is actually live. Snapshot the stage outputs and put them back afterwards.
snapshot_outputs() {
  SNAPSHOT_DIR="$(mktemp -d)"
  for f in "${STAGE_OUTPUTS[@]}"; do
    if [ -f "$f" ]; then cp "$f" "$SNAPSHOT_DIR/$(basename "$f")"; fi
  done
}
restore_outputs() {
  [ -n "${SNAPSHOT_DIR:-}" ] || return 0
  for f in "${STAGE_OUTPUTS[@]}"; do
    if [ -f "$SNAPSHOT_DIR/$(basename "$f")" ]; then cp "$SNAPSHOT_DIR/$(basename "$f")" "$f"; else rm -f "$f"; fi
  done
  rm -rf "$SNAPSHOT_DIR"
}

run_stage() { # run_stage <script path> <contract>
  local args=("script" "$1" "--tc" "$2" "--rpc-url" "$RPC_URL")
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "   (dry run — simulating, nothing is broadcast)"
  else
    args+=("--broadcast")
  fi
  # shellcheck disable=SC2206
  [ -n "$FORGE_FLAGS" ] && args+=($FORGE_FLAGS)
  forge "${args[@]}"
}

# Exports the platform addresses a Vault run consumes.
export_platform_env() {
  export HYPER_ACCESS_CONTROL="$(addr "$CORE_OUT" HyperAccessControl)"
  export PROTOCOL_FEE_CONFIG="$(addr "$CORE_OUT" ProtocolFeeConfig)"
  export USDT="$(addr "$CORE_OUT" MockUSDT)"
  export STATE_MANAGER="$(addr "$PLATFORM_OUT" StateManager)"
  export QUEUE="$(addr "$PLATFORM_OUT" Queue)"
  export UNIFIED_POOL="$(addr "$PLATFORM_OUT" UnifiedPool)"
  export SETTLEMENT="$(addr "$PLATFORM_OUT" Settlement)"
  export ADAPTER_FACTORY="$(addr "$PLATFORM_OUT" AdapterFactory)"
  export VAULT_FACTORY="$(addr "$PLATFORM_OUT" VaultFactory)"
  export CLAIM_REGISTRY="$(addr "$PLATFORM_OUT" ClaimRegistry)"
  export LIQUIDITY_BRIDGE="$(addr "$PLATFORM_OUT" LiquidityBridge)"
}

# Runs one Vault stage. An LP vault bridges into a Cash vault: CASH_VAULT names which one, and an
# explicit value always wins so a new LP vault can be pointed at any existing Cash vault.
deploy_vault() { # deploy_vault <kind> [label]
  local kind="$1" lbl="${2:-$1}"
  say "Vault — $lbl ($kind)"
  export VAULT_KIND="$kind" VAULT_LABEL="$lbl"
  if [ "$kind" = "lp" ] && [ -z "${CASH_VAULT:-}" ]; then
    local cash_file="$PANEL/deployments-vault-cash.json"
    [ -f "$cash_file" ] || die "an lp vault needs CASH_VAULT — set it, or deploy a vault labelled 'cash' first"
    export CASH_VAULT="$(jq -r '.vault.vault' "$cash_file")"
    echo "   CASH_VAULT defaulted to the vault labelled 'cash': $CASH_VAULT"
  fi
  run_stage script/deploy/DeployVault.s.sol DeployVault
  unset VAULT_KIND VAULT_LABEL
}

# Runs the optional KYT add-on for one already-deployed Vault, named by its label.
deploy_kyt() { # deploy_kyt <vault-label>
  local lbl="$1"
  local vault_file="$PANEL/deployments-vault-$lbl.json"
  [ -f "$vault_file" ] || die "no vault labelled '$lbl' — deploy that vault first (its record is $vault_file)"
  say "KYT gateway — $lbl"
  export KYT_VAULT="$(jq -r '.vault.vault' "$vault_file")"
  export KYT_LABEL="$lbl"
  [ -n "${KYT_ORACLE:-}" ] || die "--kyt needs KYT_ORACLE — the account allowed to submit screening results"
  echo "   vault:  $KYT_VAULT"
  run_stage script/deploy/DeployKYTGateway.s.sol DeployKYTGateway
  unset KYT_VAULT KYT_LABEL
}

echo "network:  $NETWORK  ($RPC_URL)"
echo "profile:  $DEPLOY_PROFILE"
echo "deployer: $DEPLOYER"

# --- A KYT run: the Vault already exists, deploy just its gateway --------------------------
if [ -n "$KYT_TARGET" ]; then
  [ "$DRY_RUN" -eq 0 ] || die "--dry-run does not apply to a kyt run; simulate it with forge script directly"
  export_platform_env
  deploy_kyt "$KYT_TARGET"

# --- A Vault run: the platform already exists, deploy just this one Vault ------------------
elif [ -n "$VAULT_KIND" ]; then
  [ "$DRY_RUN" -eq 0 ] || die "--dry-run does not apply to a vault run; simulate it with forge script directly"
  export_platform_env
  deploy_vault "$VAULT_KIND" "${VAULT_LABEL:-$VAULT_KIND}"
else
  if [ "$DRY_RUN" -eq 1 ]; then
    # Only the first stage of the range can be simulated — see the --dry-run note at the top.
    TO_STAGE="$FROM_STAGE"
    snapshot_outputs
    trap restore_outputs EXIT
  fi
  echo "stages:   $FROM_STAGE..$TO_STAGE$([ "$DRY_RUN" -eq 1 ] && echo '  [dry run — first stage only, no output files written]')"

  if [ "$FROM_STAGE" -le 1 ] && [ "$TO_STAGE" -ge 1 ]; then
    say "Stage 1/2 — core"
    run_stage script/deploy/DeployCore.s.sol DeployCore
  fi

  if [ "$TO_STAGE" -ge 2 ]; then
    export HYPER_ACCESS_CONTROL="$(addr "$CORE_OUT" HyperAccessControl)"
    export REVENUE_POOL="$(addr "$CORE_OUT" RevenuePool)"
    export PROTOCOL_FEE_CONFIG="$(addr "$CORE_OUT" ProtocolFeeConfig)"
    # Later stages read the settlement token from the core stage's own output, so a demo run that
    # minted a fresh Mock USDT and a production run handed a real one look identical.
    export USDT="$(addr "$CORE_OUT" MockUSDT)"
  fi

  if [ "$FROM_STAGE" -le 2 ] && [ "$TO_STAGE" -ge 2 ]; then
    say "Stage 2/2 — platform"
    run_stage script/deploy/DeployPlatform.s.sol DeployPlatform
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    say "Dry run complete — stage $FROM_STAGE simulated, nothing broadcast, no output files changed."
    exit 0
  fi

  # The demo profile brings up the three delivery vaults so a devnet or testnet is immediately
  # usable, which is what CI and the off-chain harnesses expect. Production stops at the platform:
  # vaults are created deliberately, one at a time, with their own roles and parameters.
  if [ "$DEPLOY_PROFILE" = "demo" ] && [ "$TO_STAGE" -ge 2 ]; then
    export_platform_env
    deploy_vault cash
    deploy_vault note
    deploy_vault lp
  fi
fi

# --- Merged address book ---------------------------------------------------
# Later files win for the flat keys: the platform stage's NAVOracle and Queue supersede the core
# stage's, which exist only for the demo asset surface and are bound to the throwaway stub.
say "Writing merged address book"
MERGE_FILES=("$CORE_OUT")
[ -f "$PLATFORM_OUT" ] && MERGE_FILES+=("$PLATFORM_OUT")

SHARED="$(jq -s '
  {
    chainId:   (map(.chainId) | last),
    addresses: (map(.addresses // {}) | add),
    roles:     (map(.roles // {}) | add)
  }
  | .addresses |= with_entries(select(.value != "0x0000000000000000000000000000000000000000"))
  | .roles     |= with_entries(select(.value != "0x0000000000000000000000000000000000000000"))
' "${MERGE_FILES[@]}")"

# Every per-vault file, oldest first, becomes an entry in `vaults`. Vaults labelled cash/note/lp
# additionally fill the flat CashVault/NoteVault/LPVault/*Adapter keys the control panel, the
# off-chain SDK and the CI assertions read, so those consumers need no knowledge of labels.
VAULT_FILES=("$PANEL"/deployments-vault-*.json)
if [ -e "${VAULT_FILES[0]}" ]; then
  VAULTS="$(jq -s '[.[].vault]' "${VAULT_FILES[@]}")"
else
  VAULTS="[]"
fi

# The optional KYT gateways, one file per fronted Vault. Absent entirely when no Vault uses KYT.
KYT_FILES=("$PANEL"/deployments-kyt-*.json)
if [ -e "${KYT_FILES[0]}" ]; then
  KYTS="$(jq -s '[.[].kyt]' "${KYT_FILES[@]}")"
else
  KYTS="[]"
fi

MERGED="$(jq -n --argjson shared "$SHARED" --argjson vaults "$VAULTS" --argjson kyts "$KYTS" '
  def titled: {cash: "Cash", note: "Note", lp: "LP"}[.];
  $shared
  | .vaults = $vaults
  | reduce $vaults[] as $v (.;
      if ($v.label | . == "cash" or . == "note" or . == "lp")
      then .addresses[($v.label | titled) + "Vault"]        = $v.vault
         | .addresses[($v.label | titled) + "Adapter"]      = $v.adapter
         | .addresses[($v.label | titled) + "VaultTimelock"] = $v.timelock
      else . end)
  | if ($kyts | length) > 0 then .kytGateways = $kyts else . end
  | reduce $kyts[] as $k (.;
      if ($k.label | . == "cash" or . == "note" or . == "lp")
      then .addresses[($k.label | titled) + "KYTGateway"] = $k.gateway
      else . end)
')"

printf 'window.HT_DEPLOYMENTS = %s;\n' "$MERGED" > "$PANEL/config.js"
echo "$MERGED" | jq . > "$PANEL/deployments-merged.json"

echo
echo "Deployed to $NETWORK (chainId $(echo "$MERGED" | jq -r .chainId)):"
echo "$MERGED" | jq -r '.addresses | to_entries[] | "  \(.key)\t\(.value)"' | column -t -s $'\t'
VAULT_COUNT="$(echo "$MERGED" | jq '.vaults | length')"
if [ "$VAULT_COUNT" -gt 0 ]; then
  echo
  echo "Vaults ($VAULT_COUNT):"
  echo "$MERGED" | jq -r '.vaults[] | "  \(.label)\t\(.kind)\t\(.vault)"' | column -t -s $'\t'
fi
KYT_COUNT="$(echo "$MERGED" | jq '.kytGateways // [] | length')"
if [ "$KYT_COUNT" -gt 0 ]; then
  echo
  echo "KYT gateways ($KYT_COUNT):"
  echo "$MERGED" | jq -r '.kytGateways[] | "  \(.label)\t\(.gateway)\tgate installed: \(.gateInstalled)"' | column -t -s $'\t'
fi
echo
echo "Wrote control-panel/config.js and control-panel/deployments-merged.json."
echo "Next: ./control-panel/build-abis.sh, then follow the go-live checklist in"
echo "docs/deployment-handbook.md (ProductParams and subscriptionCapShare are NOT set yet)."
