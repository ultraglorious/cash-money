#!/bin/sh
# Refuse to record anything private in a public repository.
#
# Two kinds of pattern:
#
#   built-ins   — shapes that are private wherever they appear (an IBAN, a card
#                 mask). Safe to keep here, because a shape names nobody.
#   your list   — the actual names: your bank, employer, the people and places
#                 that show up in real statements. Those live OUTSIDE the repo,
#                 in $GIT_COMMON_DIR/private-patterns (one regex per line, '#'
#                 for comments), because the list is itself the sensitive part.
#
# Only ADDED lines are scanned, so existing content never blocks an unrelated
# commit. `git commit --no-verify` bypasses this when you mean to.
set -e

# Account-ish shapes, plus private-key material of the kinds that could
# plausibly be pasted here: the updater's signing key (minisign/rsign format,
# whose header says "secret key") and any PEM/SSH private key. The updater's
# PUBLIC key is meant to be committed, and its header says "public key", so it
# passes untouched.
BUILTIN='\b[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}\b|\(\.\.[0-9]{4}\)|untrusted comment:.*(secret|private) key|-----BEGIN [A-Z ]*PRIVATE KEY-----'
# Published placeholders of those same shapes: the documentation IBAN and the
# stand-in card mask. Removed before matching so the invented values the tests
# are supposed to use don't trip the rule meant to enforce using them.
ALLOW='s/GB29NWBK60161331926819//g; s/\(\.\.1234\)//g'
LIST="$(git rev-parse --git-common-dir)/private-patterns"

patterns="$BUILTIN"
if [ -f "$LIST" ]; then
  extra=$(grep -v '^[[:space:]]*#' "$LIST" | grep -v '^[[:space:]]*$' | paste -sd '|' -)
  [ -n "$extra" ] && patterns="$patterns|$extra"
fi

subject="$1"   # "staged" or a path to a commit message
if [ "$subject" = "staged" ]; then
  # The scanner's own source necessarily contains the patterns it hunts for,
  # so it is excluded — otherwise editing this file trips it every time.
  content=$(git diff --cached -U0 --no-color -- . ':(exclude).githooks/*' | grep '^+' | grep -v '^+++' || true)
  where="staged changes"
else
  content=$(cat "$subject")
  where="the commit message"
fi

hits=$(printf '%s\n' "$content" | sed -E "$ALLOW" | grep -inE "$patterns" || true)
[ -z "$hits" ] && exit 0

echo "─────────────────────────────────────────────────────────────"
echo " Private data found in $where — commit refused."
echo
printf '%s\n' "$hits" | head -20 | sed 's/^/   /'
echo
echo " This repository is public. Use an invented equivalent of the same"
echo " shape instead; the tests only ever need the shape."
echo
echo " Deliberate? Re-run with:  git commit --no-verify"
echo "─────────────────────────────────────────────────────────────"
exit 1
