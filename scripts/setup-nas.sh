#!/usr/bin/env bash
# One-time NAS setup. Run from your Mac, inside this repo.
#
# Prerequisites:
#   - .env.secrets filled in with your API keys
#   - SSH access to your NAS
#   - gh CLI (optional — only needed for self-hosted runner auto-setup)
#
# Usage:
#   ./scripts/setup-nas.sh user@nas-host
#   ./scripts/setup-nas.sh admin@192.168.1.100 /volume1/docker/klaus
#
set -euo pipefail

NAS="${1:-}"
NAS_DIR="${2:-/volume1/docker/klaus}"
NAS_USER="${NAS%%@*}"

if [[ -z "$NAS" ]]; then
  echo "Usage: $0 user@nas-host [/path/on/nas]"
  exit 1
fi

if [[ ! -f .env.secrets ]]; then
  echo "Error: no .env.secrets found locally."
  echo "  Create it with your 4 API keys:"
  echo "    ANTHROPIC_API_KEY=..."
  echo "    VOYAGE_API_KEY=..."
  echo "    ELEVENLABS_API_KEY=..."
  echo "    ALLOWED_CHAT_ID=..."
  exit 1
fi

REPO_URL=$(git remote get-url origin 2>/dev/null \
  | sed 's|git@github\.com:|https://github.com/|; s|\.git$||')
echo "→ Repo: $REPO_URL"

# ── Optional: GitHub Actions runner token ────────────────────────────────────

GITHUB_RUNNER_TOKEN=""
GITHUB_REPO_URL="$REPO_URL"

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")
  if [[ -n "$REPO" ]]; then
    RUNNER_REGISTERED=$(gh api "repos/$REPO/actions/runners" \
      -q '.runners[] | select(.name == "nas-runner") | .id' 2>/dev/null || echo "")
    if [[ -n "$RUNNER_REGISTERED" ]]; then
      echo "→ Runner 'nas-runner' already registered — skipping token fetch"
    else
      echo "→ Fetching runner registration token..."
      GITHUB_RUNNER_TOKEN=$(gh api "repos/$REPO/actions/runners/registration-token" \
        -q .token 2>/dev/null || echo "")
    fi
  fi
fi

# ── Clone/pull repo, write .env, add runner config, start services ────────────

echo "→ Setting up NAS (you'll be prompted for your password)..."
ssh "$NAS" "
  set -e
  export PATH=/usr/local/bin:\$PATH

  mkdir -p '$(dirname "$NAS_DIR")'
  if [ -d '$NAS_DIR/.git' ]; then
    echo '→ Updating repo...'
    git -C '$NAS_DIR' pull --ff-only
  else
    echo '→ Cloning repo...'
    git clone '$REPO_URL' '$NAS_DIR'
  fi

  [ -f '$NAS_DIR/.env' ] || cp '$NAS_DIR/.env.example' '$NAS_DIR/.env'
"

if [[ -n "$GITHUB_RUNNER_TOKEN" ]]; then
  echo "→ Adding runner config..."
  ssh "$NAS" "
    f='$NAS_DIR/.env'
    grep -q '^GITHUB_REPO_URL=' \"\$f\"    && sed -i 's|^GITHUB_REPO_URL=.*|GITHUB_REPO_URL=$GITHUB_REPO_URL|' \"\$f\"    || echo 'GITHUB_REPO_URL=$GITHUB_REPO_URL'    >> \"\$f\"
    grep -q '^GITHUB_RUNNER_TOKEN=' \"\$f\" && sed -i 's|^GITHUB_RUNNER_TOKEN=.*|GITHUB_RUNNER_TOKEN=$GITHUB_RUNNER_TOKEN|' \"\$f\" || echo 'GITHUB_RUNNER_TOKEN=$GITHUB_RUNNER_TOKEN' >> \"\$f\"
  "
fi

# ── Copy .env.secrets to NAS ──────────────────────────────────────────────────

echo "→ Copying .env.secrets to NAS (you'll be prompted again)..."
ssh "$NAS" "cat > '$NAS_DIR/.env.secrets'" < .env.secrets

# ── Add NAS user to docker group ──────────────────────────────────────────────

echo "→ Adding $NAS_USER to docker group on NAS (you'll be prompted)..."
ssh "$NAS" "sudo synogroup --adduser docker '$NAS_USER' 2>/dev/null || sudo usermod -aG docker '$NAS_USER'" || true

# ── Start services ────────────────────────────────────────────────────────────

echo "→ Starting services (you'll be prompted once more)..."
ssh "$NAS" "export PATH=/usr/local/bin:\$PATH; docker compose -f '$NAS_DIR/docker-compose.yml' -f '$NAS_DIR/docker-compose.nas.yml' --project-directory '$NAS_DIR' up -d --remove-orphans"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "✓ Done! Scan the WhatsApp QR to finish pairing:"
echo "  ssh $NAS 'export PATH=/usr/local/bin:\$PATH && docker compose -f $NAS_DIR/docker-compose.yml -f $NAS_DIR/docker-compose.nas.yml logs -f app'"
echo ""
if [[ -n "$GITHUB_RUNNER_TOKEN" ]]; then
  echo "CI/CD runner registered: $REPO_URL/settings/actions/runners"
  echo ""
fi
echo "After that, push to main and CI/CD handles everything."
