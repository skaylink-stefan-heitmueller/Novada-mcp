# Novada MCP — landing site

Static pages for the hosted MCP endpoint: the marketing page plus the
`/playground`, `/chat`, `/configure`, `/dashboard`, `/tools`, `/pricing` and
`/faq` views. Hand-written HTML, CSS and JS — no `package.json`, no bundler, no
server-side code. Caddy serves the files and nothing else.

**Deployed separately from `mcp.novada.com`.** That host is a bare API/MCP
endpoint with no marketing pages (`../vercel/vercel.json` rewrites every path to
the function). These pages are a different artifact on a different origin; the
playground and chat reach the MCP endpoint as ordinary cross-origin `fetch`
calls from the visitor's browser.

`markdown.js` renders the Markdown that tools return, for `/chat` and the
playground's Output view. It escapes every text run before building any tag,
allows only `http`/`https`/`mailto` links and never emits an `<img>` — tool
responses carry scraped third-party content, so they are treated as untrusted.
It also injects its own stylesheet, because `chat.html` is standalone and does
not load `shared.css`.

## Build

```bash
docker build -t novada-landing .
```

That ships the pages exactly as committed, pointing at the public endpoint
`https://mcp.novada.com/mcp`.

### Build args

| Arg | Default | Purpose |
|-----|---------|---------|
| `NOVADA_MCP_ENDPOINT` | `https://mcp.novada.com/mcp` | The MCP endpoint the pages call and advertise in their install snippets. |
| `CADDY_VERSION` | `2.11-alpine` | Base image tag. |

To point the pages at a different endpoint:

```bash
docker build \
  --build-arg NOVADA_MCP_ENDPOINT=https://mcp.internal.example/mcp \
  -t novada-landing .
```

The pages are static, so this is a **build-time substitution, not a runtime
setting** — there is no env var to set on the container. Changing the endpoint
means rebuilding the image.

`NOVADA_MCP_ENDPOINT` must be an absolute `http(s)` URL ending in `/mcp`, and
must not contain `|`, `&`, `<`, `>`, quotes or spaces. The build fails on
anything else rather than writing a corrupted page. The `/mcp` suffix is
required because the key-in-path URL the install snippets use is derived from it
by stripping that suffix, so a prefixed mount works too:
`https://gw.example/novada/mcp` produces `https://gw.example/novada/<key>/mcp`.

Which endpoint an image was built against is recorded as a label:

```bash
docker inspect -f '{{index .Config.Labels "com.novada.mcp-endpoint"}}' novada-landing
```

### What the substitution touches

`bake-mcp-endpoint.sh` runs during the build against the copy in `/srv`, never
against this source tree, and is deleted from the image afterwards. It rewrites
only URLs that name the **MCP endpoint**:

- the endpoint itself, including its `?token=…` variants
- the percent-encoded copy embedded in the Cursor / VS Code install deeplinks
- the key-in-path form `…/<key>/mcp`, whose key appears as a `NOVADA_API_KEY` or
  `YOUR_API_KEY` placeholder, a `${…}` template expression, or a highlighted
  `<span>`
- the playground's live status label ("Calling …")

It deliberately leaves the pages' references to **their own host** alone —
`canonical`, `og:url`, `og:image`, and the `/faq`, `/pricing`, `/tools`, `/chat`,
`/configure`, `/playground` links. Where the site is published is independent of
where the MCP endpoint lives, so a blanket host replacement would be wrong.

Three scheme-less mentions in `<meta name="description">` / `og:description`
also stay as-is: they are crawler-facing prose about the public product, not
URLs anything calls.

After rewriting, the script greps for surviving endpoint literals and fails the
build if it finds any, so a half-rewritten image cannot ship.

To preview the rewrite as a diff before building, run the script against a copy:

```bash
mkdir -p /tmp/bake && cp *.html *.js *.txt *.json /tmp/bake/
sh bake-mcp-endpoint.sh https://mcp.internal.example/mcp /tmp/bake
diff <(cat *.html) <(cat /tmp/bake/*.html) | head
```

### What ships

The `COPY` globs pick up `*.html *.css *.js *.txt *.json *.png`, and
`.dockerignore` keeps `*.md` (this README, `og-image-spec.md`) out of the build
context entirely. `og-image.html` is excluded too — it is a template used to
re-screenshot `og-image.png`, not a page. `bake-mcp-endpoint.sh` is in the
context because the build needs it, but the content globs do not match it, so it
never lands in the docroot.

## Run

```bash
docker run --rm -p 8081:8081 novada-landing
curl -s localhost:8081/health          # {"ok":true,"service":"novada-landing"}
```

Port `8081` rather than `80` so the process needs no privileged port and runs as
uid `1000`. `/health` is answered by Caddy itself, independently of the page
content, and is what `HEALTHCHECK` probes.

TLS terminates upstream — the Caddyfile sets `auto_https off` and serves plain
HTTP, so put the container behind an ingress, CDN or platform router rather than
exposing it directly.

## Local preview without Docker

`hosted-server/.claude/launch.json` defines a static-server config for this
directory:

```bash
npx serve -p 4500 landing     # run from hosted-server/
```

This only approximates the container: the Caddyfile's extensionless-URL
fallback, security headers and cache rules are not reproduced, and no endpoint
substitution happens — the pages call the public endpoint. Build the image when
any of that matters.
