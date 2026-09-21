#!/bin/sh
# bake-mcp-endpoint.sh — point the static pages at a different MCP endpoint.
#
# The landing pages are hand-written HTML with no bundler, so the endpoint they
# call is a plain string literal repeated across them. This rewrites those
# literals in place, driven by the NOVADA_MCP_ENDPOINT build arg in the
# Dockerfile. It runs against the copy in /srv inside the image, never against
# the source tree.
#
#   bake-mcp-endpoint.sh https://mcp.internal.example/mcp /srv
#
# Only endpoint URLs are rewritten. The pages also reference themselves on the
# same host — canonical, og:url, og:image, and the /faq, /pricing, /tools links —
# and those are deliberately left alone: they say where the site is published,
# which is independent of where the MCP endpoint lives.
set -eu

EP="${1:?usage: bake-mcp-endpoint.sh <endpoint-url> <dir>}"
DIR="${2:?usage: bake-mcp-endpoint.sh <endpoint-url> <dir>}"

# What the committed pages contain today.
DEF_EP="https://mcp.novada.com/mcp"
DEF_ORIGIN="https://mcp.novada.com"
DEF_HOST="mcp.novada.com"
DEF_ENC="https%3A%2F%2Fmcp.novada.com%2Fmcp"   # inside the Cursor/VS Code deeplinks

if [ "$EP" = "$DEF_EP" ]; then
  echo "bake-mcp-endpoint: default endpoint, nothing to rewrite"
  exit 0
fi

# Reject anything that would corrupt the pages rather than configure them.
case "$EP" in
  http://*|https://*) ;;
  *) echo "bake-mcp-endpoint: must be an absolute http(s) URL: $EP" >&2; exit 1 ;;
esac
case "$EP" in
  */mcp) ;;
  *) echo "bake-mcp-endpoint: must end in /mcp — the key-in-path form is derived from it: $EP" >&2; exit 1 ;;
esac
case "$EP" in
  *'|'*|*'&'*|*' '*|*'"'*|*"'"*|*'<'*|*'>'*)
    echo "bake-mcp-endpoint: must not contain | & < > quotes or spaces: $EP" >&2; exit 1 ;;
esac

ORIGIN="${EP%/mcp}"                                                  # …/mcp → …
HOST="$(printf '%s' "$EP" | sed -e 's|^https\{0,1\}://||' -e 's|/.*$||')"
ENC="$(printf '%s' "$EP" | sed -e 's|:|%3A|g' -e 's|/|%2F|g')"

cd "$DIR"

# Every pattern is anchored on what follows the host, so none of them overlap
# and the order is irrelevant:
#   /mcp                     the endpoint itself, including the ?token=… suffixes
#   %2Fmcp                   the same URL percent-encoded inside a deeplink
#   /NOVADA_API_KEY, /YOUR_API_KEY, /${…}, /<span…>
#                            the key-in-path form, whose key is a placeholder, a
#                            template expression, or a highlighted span
#   Calling …, 请求 …         the playground's live status label
# A bare "https://mcp.novada.com/" is NOT a pattern here: that is the site's own
# URL, and rewriting it would break canonical/og:image and the nav links.
find . -maxdepth 1 -type f \
  \( -name '*.html' -o -name '*.js' -o -name '*.txt' -o -name '*.json' \) \
  -exec sed -i \
    -e "s|${DEF_EP}|${EP}|g" \
    -e "s|${DEF_ENC}|${ENC}|g" \
    -e "s|${DEF_ORIGIN}/NOVADA_API_KEY|${ORIGIN}/NOVADA_API_KEY|g" \
    -e "s|${DEF_ORIGIN}/YOUR_API_KEY|${ORIGIN}/YOUR_API_KEY|g" \
    -e "s|${DEF_ORIGIN}/\${|${ORIGIN}/\${|g" \
    -e "s|${DEF_ORIGIN}/<span|${ORIGIN}/<span|g" \
    -e "s|Calling ${DEF_HOST}|Calling ${HOST}|g" \
    -e "s|请求 ${DEF_HOST}|请求 ${HOST}|g" \
    {} +

# A partial rewrite would ship pages that call the wrong host, so treat any
# survivor as a build failure instead of a surprise in production.
if grep -rl \
     -e "$DEF_EP" \
     -e "$DEF_ENC" \
     -e "${DEF_ORIGIN}/NOVADA_API_KEY" \
     -e "${DEF_ORIGIN}/YOUR_API_KEY" \
     -e "${DEF_ORIGIN}/\${" \
     -e "${DEF_ORIGIN}/<span" \
     . 2>/dev/null | grep -q .; then
  echo "bake-mcp-endpoint: endpoint literals survived the rewrite in:" >&2
  grep -rln \
    -e "$DEF_EP" \
    -e "$DEF_ENC" \
    -e "${DEF_ORIGIN}/NOVADA_API_KEY" \
    -e "${DEF_ORIGIN}/YOUR_API_KEY" \
    -e "${DEF_ORIGIN}/\${" \
    -e "${DEF_ORIGIN}/<span" \
    . >&2
  exit 1
fi

echo "bake-mcp-endpoint: baked endpoint=${EP} origin=${ORIGIN} host=${HOST}"
