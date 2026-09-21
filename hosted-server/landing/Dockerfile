# syntax=docker/dockerfile:1

# Static site image for the landing / playground / chat pages.
#
# Deliberately single-stage and build-step-free: this directory is hand-written
# HTML, CSS and JS with no package.json, bundler or server-side code. The
# playground and chat call the MCP endpoint straight from the browser with a
# user-supplied token, so the image holds no secrets and needs no runtime beyond
# a file server.
#
# Separate from ../vercel/Dockerfile on purpose: that one ships the MCP endpoint,
# this one only serves documents.

ARG CADDY_VERSION=2.11-alpine

FROM caddy:${CADDY_VERSION}

# The MCP endpoint the pages call and advertise in their install snippets.
# Because the pages are static there is nothing to configure at runtime — the URL
# is substituted into them during the build, so changing it means rebuilding:
#
#   docker build --build-arg NOVADA_MCP_ENDPOINT=https://mcp.internal.example/mcp .
#
# Must be an absolute http(s) URL ending in /mcp; the key-in-path variant
# (…/<key>/mcp) that the install snippets use is derived from it. The default is
# the public endpoint, so a plain `docker build` ships the pages unchanged.
ARG NOVADA_MCP_ENDPOINT=https://mcp.novada.com/mcp

# Recorded so the baked endpoint is recoverable from `docker inspect` — the pages
# are the only other evidence of which one an image was built against.
LABEL com.novada.mcp-endpoint="${NOVADA_MCP_ENDPOINT}"

# Content. The globs deliberately exclude *.md (og-image-spec.md is a design note)
# and og-image.html (a template used to re-screenshot og-image.png, not a page).
# bake-mcp-endpoint.sh is not matched either, so it never lands in the docroot.
COPY --chown=1000:1000 *.html *.css *.js *.txt *.json *.png /srv/

COPY Caddyfile /etc/caddy/Caddyfile
COPY bake-mcp-endpoint.sh /tmp/bake-mcp-endpoint.sh
# One RUN, three jobs (hadolint DL3059):
#  - bake: rewrite the endpoint literals in the docroot, then delete the script
#    so a shipped container has no tool for rewriting its own pages. A no-op when
#    NOVADA_MCP_ENDPOINT is left at its default.
#  - validate: fail the build on a malformed config rather than crash-looping
#    the container.
#  - chown: Caddy resolves XDG_DATA_HOME=/data and XDG_CONFIG_HOME=/config, both
#    root-owned in the base image; hand them over so it can run unprivileged.
RUN set -eu; \
    sh /tmp/bake-mcp-endpoint.sh "$NOVADA_MCP_ENDPOINT" /srv; \
    rm -f /tmp/bake-mcp-endpoint.sh; \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; \
    chown -R 1000:1000 /data /config

# Numeric so the identity resolves without /etc/passwd (Kubernetes runAsNonRoot).
USER 1000:1000

EXPOSE 8081

# /health is served by Caddy itself, independent of the page content.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "--quiet", "--tries=1", "--spider", "http://127.0.0.1:8081/health"]

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
