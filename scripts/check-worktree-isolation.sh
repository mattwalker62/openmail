#!/usr/bin/env sh
# ============================================================================
# Worktree isolation guard  (added after the 2026-06-09 incident)
#
# The model (CLAUDE.md → Branch hygiene), copied from Dollop:
#   the home-base clone stays on `main`; EVERY task gets its own git worktree.
#
# Why this exists: two agents/sessions worked in the same home-base clone at
# once. One committed onto local `main` there; the other branched off it and
# inherited the commit, then the branch labels got tangled (PR #418 vs the
# preference work). A shared working tree means a shared HEAD/index/`main` —
# the worktree model isolates that, and this guard enforces it at commit time.
#
# Behaviour:
#   - In a linked worktree  → always allowed (that's the correct place to work).
#   - In the home base on `main` (or detached) → allowed.
#   - In the home base on any OTHER branch → blocked (pre-commit) / warned
#     (post-checkout).
#
# Usage:
#   check-worktree-isolation.sh          # block mode (exit 1 on violation)
#   check-worktree-isolation.sh --warn   # warn mode  (exit 0 always)
#
# Escape hatch for the rare legitimate case:
#   ALLOW_HOME_BASE_COMMIT=1 git commit ...     (or: git commit --no-verify)
# ============================================================================

[ -n "$ALLOW_HOME_BASE_COMMIT" ] && exit 0

mode="${1:-block}"

git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0
common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")

# Linked worktree: git-dir lives under <home>/.git/worktrees/<name>, so it
# differs from the common dir (<home>/.git). That's the sanctioned place to
# work — never block.
[ "$git_dir" != "$common_dir" ] && exit 0

# Home base, but on main or detached → fine.
[ -z "$branch" ] && exit 0
[ "$branch" = "main" ] && exit 0

home_base=$(dirname "$common_dir")
cat >&2 <<EOF

✋ Worktree isolation guard

You are on branch '$branch' in the HOME-BASE clone:
  $home_base

Home base stays on 'main'. Task work belongs in its own worktree:
  git worktree add -b $branch ../$(basename "$home_base")-<task> origin/main
  cd ../$(basename "$home_base")-<task>     # do the work there

Why: when two sessions/agents share the home clone they tangle each other's
branches, index and HEAD (incident 2026-06-09). A worktree isolates that.
See CLAUDE.md → Branch hygiene.

Escape hatch (only if you truly mean to work in the home clone):
  ALLOW_HOME_BASE_COMMIT=1 git commit ...      (or: git commit --no-verify)
EOF

[ "$mode" = "--warn" ] && exit 0
exit 1
