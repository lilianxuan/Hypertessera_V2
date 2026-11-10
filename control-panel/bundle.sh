#!/usr/bin/env bash
# Produce a single, fully self-contained control-panel/standalone.html with the ABIs, the
# deployment config, and ethers.js all inlined. Drop the resulting file on any static host
# (pagedrop, GitHub Pages, S3, IPFS, …) and it works with just MetaMask — no other files.
#
# Prereqs: config.js + abis.js must exist (run `forge script Deploy` then `./build-abis.sh`).
# Usage:   ./control-panel/bundle.sh
set -euo pipefail
cd "$(dirname "$0")"

[ -f config.js ] || { echo "ERROR: config.js missing — deploy first (forge script Deploy ...)"; exit 1; }
[ -f abis.js ]   || { echo "ERROR: abis.js missing — run ./build-abis.sh"; exit 1; }

ETHERS_URL="https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js"
echo "fetching ethers.js to inline…"
ETHERS_SRC=$(curl -fsSL "$ETHERS_URL" || true)

python3 - "$ETHERS_SRC" <<'PY'
import sys, re
ethers_src = sys.argv[1]
html = open("index.html", encoding="utf-8").read()
abis = open("abis.js", encoding="utf-8").read()
config = open("config.js", encoding="utf-8").read()
kyt = open("kyt.js", encoding="utf-8").read()

# Inline ethers (fall back to the CDN tag if the download failed).
ethers_tag = '<script src="https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js"></script>'
if ethers_src.strip():
    html = html.replace(ethers_tag, "<script>/* ethers@6.13.4 (inlined) */\n" + ethers_src + "\n</script>")
    note = "ethers inlined"
else:
    note = "ethers left on CDN (download failed)"

# Inline ABIs + config (replace the external <script src> tags).
html = html.replace('<script src="abis.js"></script>',   "<script>" + abis.strip()   + "</script>")
html = html.replace('<script src="config.js"></script>', "<script>" + config.strip() + "</script>")

html = html.replace('<script src="kyt.js"></script>', "<script>" + kyt.strip() + "\n</script>")
open("standalone.html", "w", encoding="utf-8", newline="\n").write(html)
print(f"wrote control-panel/standalone.html ({len(html)//1024} KB) — {note}")
PY
echo "Host standalone.html anywhere static; open it and connect MetaMask."
