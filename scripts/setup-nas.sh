#!/usr/bin/env bash
# One-time NAS setup. Run from your Mac, NOT on the NAS.
#
# Prerequisites (on your Mac):
#   - gh CLI installed and logged in (brew install gh && gh auth login)
#   - SSH access to your NAS
#   - A 1Password Service Account token (ops_...) from my.1password.com/developer-tools/service-accounts
#
# Usage:
#   ./scripts/setup-nas.sh user@nas-host
#   ./scripts/setup-nas.sh admin@192.168.1.100 /volume1/docker/klaus
#
set -euo pipefail

NAS="${1:-}"
NAS_DIR="${2:-/volume1/docker/klaus}"

if [[ -z "$NAS" ]]; then
  echo "Usage: $0 user@nas-host [/path/on/nas]"
  exit 1
fi

# ── Preflight ─────────────────────────────────────────────────────────────────

command -v gh  >/dev/null || { echo "Error: gh CLI not found — brew install gh"; exit 1; }
command -v ssh >/dev/null || { echo "Error: ssh not found"; exit 1; }

gh auth status >/dev/null 2>&1 || { echo "Error: not logged in — gh auth login"; exit 1; }

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null \
  || git remote get-url origin | sed 's|.*github\.com[:/]||;s|\.git$||')
REPO_URL="https://github.com/$REPO"
echo "→ Repo: $REPO_URL"

# ── 1Password service account token ──────────────────────────────────────────

echo ""
echo "Paste your 1Password service account token (ops_...) and press Enter:"
read -rs OP_SERVICE_ACCOUNT_TOKEN
echo ""

[[ "$OP_SERVICE_ACCOUNT_TOKEN" == ops_* ]] \
  || { echo "Error: token must start with ops_"; exit 1; }

# ── Propagate to GitHub Actions (so CI can resolve secrets too) ───────────────

echo "→ Setting GitHub Actions secret OP_SERVICE_ACCOUNT_TOKEN..."
echo "$OP_SERVICE_ACCOUNT_TOKEN" | gh secret set OP_SERVICE_ACCOUNT_TOKEN --repo "$REPO"

# ── Get runner registration token from GitHub API ─────────────────────────────

echo "→ Fetching runner registration token..."
GITHUB_RUNNER_TOKEN=$(gh api "repos/$REPO/actions/runners/registration-token" -q .token)

# ── Set up the NAS over SSH ───────────────────────────────────────────────────

echo "→ Connecting to $NAS..."

ssh "$NAS" /bin/bash << EOF
set -euo pipefail

NAS_DIR="$NAS_DIR"
REPO_URL="$REPO_URL"
OP_SERVICE_ACCOUNT_TOKEN="$OP_SERVICE_ACCOUNT_TOKEN"
GITHUB_RUNNER_TOKEN="$GITHUB_RUNNER_TOKEN"
GITHUB_REPO_URL="$REPO_URL"

# ── Install op CLI if needed ──────────────────────────────────────────────────
if ! command -v op >/dev/null 2>&1; then
  echo "→ Installing 1Password CLI..."
  ARCH=\$(uname -m)
  curl -sSfL "https://downloads.1password.com/linux/tar/stable/\${ARCH}/1password-cli-latest.tar.gz" \\
    | tar xzf - -C /tmp op
  sudo mv /tmp/op /usr/local/bin/op
  echo "   op \$(op --version)"
else
  echo "→ op CLI already installed (\$(op --version))"
fi

# ── Clone or pull repo ────────────────────────────────────────────────────────
mkdir -p "\$(dirname "\$NAS_DIR")"
if [[ -d "\$NAS_DIR/.git" ]]; then
  echo "→ Updating repo..."
  git -C "\$NAS_DIR" pull --ff-only
else
  echo "→ Cloning repo to \$NAS_DIR..."
  git clone "\$REPO_URL" "\$NAS_DIR"
fi
cd "\$NAS_DIR"

# ── Write .env ────────────────────────────────────────────────────────────────
echo "→ Writing .env..."
cp .env.example .env

# Inject secrets (sed handles both commented-out and missing lines)
set_env() {
  local key="\$1" val="\$2"
  if grep -q "^#\?[[:space:]]*\${key}=" .env; then
    sed -i "s|^#\?[[:space:]]*\${key}=.*|\${key}=\${val}|" .env
  else
    echo "\${key}=\${val}" >> .env
  fi
}

set_env OP_SERVICE_ACCOUNT_TOKEN "\$OP_SERVICE_ACCOUNT_TOKEN"
set_env GITHUB_RUNNER_TOKEN      "\$GITHUB_RUNNER_TOKEN"
set_env GITHUB_REPO_URL          "\$GITHUB_REPO_URL"

# ── Run DB migrations then start all services ─────────────────────────────────
echo "→ Starting services..."
OP_SERVICE_ACCOUNT_TOKEN="\$OP_SERVICE_ACCOUNT_TOKEN" \\
  op run --env-file .env -- \\
  docker compose -f docker-compose.yml -f docker-compose.nas.yml up -d

echo ""
echo "✓ NAS setup complete."
EOF

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "✓ Done! Two things left:"
echo ""
echo "  1. Scan WhatsApp QR (only needed once — auth is persisted in a Docker volume):"
echo "     ssh $NAS 'cd $NAS_DIR && docker compose -f docker-compose.yml -f docker-compose.nas.yml logs -f app'"
echo ""
echo "  2. Check the runner is online:"
echo "     $REPO_URL/settings/actions/runners"
echo ""
echo "  After that, push to main and CI/CD handles everything."
