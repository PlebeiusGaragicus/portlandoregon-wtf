#!/usr/bin/env bash
set -euo pipefail

# Publish a release by fast-forwarding the abvstudio fork to this repo's main.
#
# Development happens on PlebeiusGaragicus/battle-juice, which has GitHub Pages
# disabled. The abvstudio-net fork is the published copy: it has Pages enabled
# and serves portlandoregon.wtf, its custom domain in that repo's Pages
# settings. Syncing the fork is what triggers a deploy.
#
# The fork must stay a pure mirror — never commit to it directly, or these
# fast-forwards start failing and you inherit a divergence to hand-manage.
#
# Usage:
#   ./scripts/release.sh              # sync the fork to origin/main
#   ./scripts/release.sh --dry-run    # show what would happen, change nothing
#   ./scripts/release.sh --watch      # sync, then follow the Pages deploy

UPSTREAM="PlebeiusGaragicus/battle-juice"
FORK="abvstudio-net/battle-juice"
BRANCH="main"
SITE="https://portlandoregon.wtf/"

dry_run=false
watch=false
for arg in "$@"; do
    case "$arg" in
        --dry-run) dry_run=true ;;
        --watch)   watch=true ;;
        -h|--help) sed -n '4,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 1 ;;
    esac
done

note() { printf '\033[1m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

command -v gh >/dev/null || fail "gh CLI not installed"
gh auth status >/dev/null 2>&1 || fail "not logged in — run: gh auth login"

# Refuse to publish work that only exists on this laptop.
note "Checking $UPSTREAM is up to date"
git fetch --quiet origin "$BRANCH"
local_sha="$(git rev-parse "$BRANCH")"
remote_sha="$(git rev-parse "origin/$BRANCH")"
if [ "$local_sha" != "$remote_sha" ]; then
    fail "local $BRANCH and origin/$BRANCH differ — push or pull first
  local:  $local_sha
  origin: $remote_sha"
fi

if [ -n "$(git status --porcelain)" ]; then
    note "warning: working tree is dirty; uncommitted changes will NOT be published"
fi

# What the fork is about to receive.
fork_sha="$(gh api "repos/$FORK/commits/$BRANCH" --jq .sha 2>/dev/null || echo "")"
[ -n "$fork_sha" ] || fail "can't read $FORK — does the fork exist, and do you have access?"

if [ "$fork_sha" = "$remote_sha" ]; then
    note "Fork is already at $remote_sha — nothing to publish"
    exit 0
fi

note "Publishing $(git rev-parse --short "$remote_sha") to $FORK"
git --no-pager log --oneline "$fork_sha..$remote_sha" 2>/dev/null | sed 's/^/    /' \
    || echo "    (fork history not available locally — run: git fetch fork)"

if $dry_run; then
    note "--dry-run: stopping before the sync"
    exit 0
fi

# gh repo sync fast-forwards the fork's branch from its parent. It fails rather
# than clobbering if the fork has diverged, which is the behaviour we want.
note "Syncing fork"
gh repo sync "$FORK" --source "$UPSTREAM" --branch "$BRANCH"

note "Synced. Pages deploy runs in $FORK → $SITE"

if $watch; then
    note "Waiting for the deploy to start"
    sleep 8
    run_id="$(gh run list --repo "$FORK" --workflow deploy-pages --limit 1 --json databaseId --jq '.[0].databaseId')"
    [ -n "$run_id" ] || fail "no deploy run found — are Actions enabled on the fork?"
    gh run watch "$run_id" --repo "$FORK" --exit-status
    note "Live at $SITE"
fi
