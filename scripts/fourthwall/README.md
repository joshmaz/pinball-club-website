# Fourthwall Phase 1: local read-only integration

Requires Python 3.9+ and no dependencies. Run from the repository root:

```sh
python3 -B scripts/fourthwall/connection_test.py
python3 -B -m unittest discover -s scripts/fourthwall -p 'test_*.py'
```

The reusable `FourthwallClient` exposes `shop()`, `products(page=0, size=100)`,
and `product(product_id)`.
Credentials are read directly from `~/.config/fourthwall/credentials.env` using
`FOURTHWALL_API_USERNAME` and `FOURTHWALL_API_PASSWORD`. Plain or matching quoted
values and an optional `export` prefix are supported; shell expansion is never run.
Do not put this file, credentials, or authenticated headers in browser code.

The destination is fixed to `https://api.fourthwall.com/open-api/v1.0/` with HTTP
Basic authentication. TLS certificate verification stays enabled. Redirects and
environment proxies are disabled. Errors omit response bodies and headers.
No arbitrary route or write method is exposed. The connection test checks the
expected public domain before fetching products and follows product pagination.
It prints only selected shop and product fields, never full API responses.

## Verified results, 2026-10-30

Live connection passed. Shop: Southern New Hampshire Pinball Club Store.
Public domain: `shop.snhpinballclub.com`; status: `LIVE`.
Four products returned, all with state `AVAILABLE`:

- Classic SNH Pinball Club logo tee: PUBLIC
- New Product: HIDDEN
- SNHPC Coffee Mug: PUBLIC
- Club Tee: PUBLIC

Only shop and product-list GET requests were made. No writes, purchases, paid
features, production website changes, commits, or pull requests were performed.
Four offline checks passed: fixed destination/Basic authentication, redirect
blocking, sanitized HTTP errors, and pagination validation.

## Documented operations, not executed

Source: [official Platform OpenAPI JSON](https://docs.fourthwall.com/openapi/platform.json).
All paths below are relative to `/open-api/v1.0/`. Availability in the specification
does not mean every operation applies to every product type or shop configuration.

- Products: GET `products` and `products/{productId}`; POST `products`;
  PUT `products/{productId}/state` and `/availability`;
  DELETE `products/{productId}` archives a product.
  POST/DELETE `products/{productId}/images` attaches/removes images.
  Digital-file upload URL, link, and removal operations also exist.
  Product templates support listing, details, search, grouping, and category browsing.
- Artwork: GET `media/images`; POST `media/upload-url` requests a presigned URL;
  POST `media/images` registers an uploaded image; POST `customizations` creates
  a product design sketch using artwork. This is product customization, not a
  storefront theme API. No generic media update/delete operation was found.
  A future upload would require separate authorization; this client cannot upload
  or forward Basic credentials to storage URLs.
- Collections: GET/POST `collections`; GET `collections/{collectionIdOrSlug}`;
  PUT `collections/{collectionId}`; GET/PUT `collections/{collectionId}/products`;
  PUT `collections/{collectionId}/availability`. No collection deletion operation
  was found in the reviewed specification.
- Inventory: GET `products/{productId}/inventory`. No stock-quantity write endpoint
  was found. Product state/availability writes are distinct from stock adjustments.
- Storefront customization: no theme, layout, CSS, navigation, or section editing
  endpoint was found in the reviewed Platform specification. Fourthwall documents
  [Custom Code sections](https://docs.fourthwall.com/html/overview) with HTML,
  Liquid, CSS, and JavaScript added through its theme editor. Its separate
  Storefront API supports headless storefronts with a different token mechanism.

## Sources and documentation caveat

- [Platform Open API overview and current base URL](https://help.fourthwall.com/manage-my-shop/apps-features-and-integrations/platform-open-api)
- [Authentication guide](https://docs.fourthwall.com/guides/authentication)
- [Documentation index and specification links](https://docs.fourthwall.com/llms.txt)
- [Platform OpenAPI specification](https://docs.fourthwall.com/openapi/platform.json)

The authentication guide includes older `/open-api/v1/` examples. The current
help article and OpenAPI paths both specify `/open-api/v1.0/`, verified by the
successful live reads. The spec also contains an OAuth staging authorization URL;
it is irrelevant to this own-shop Basic-auth client and is never used.

Keep this tool local. Any later deployment or browser integration needs a separate
review and must keep Basic credentials on the server.

## Local read-only MCP adapter (2026-10-30)

`mcp_server.py` is a dependency-free stdio MCP adapter reusing `FourthwallClient`.
It opens no listening port, uses no hosted OAuth endpoint, and exposes exactly:

- `fourthwall_shop`: selected shop identity/domain/status fields.
- `fourthwall_products(page=0, size=20)`: one page (maximum 100) of catalog metadata.
- `fourthwall_product(product_id)`: selected metadata for one product.

Every catalog tool checks the expected shop domain first. Output excludes contact
information, descriptions, artwork, download links, orders, and customer data.
Product `state` and `access` are reduced to their `type` strings. Hidden products
are included. Catalog strings are untrusted data, not instructions. This is an
administrative connection, not a public storefront integration.

The client now requires an owned, regular, non-symlink credentials file without
any group/other permissions (use mode 600). The file is parsed without shell
execution. Credential input is capped at 16 KiB and API responses at 4 MiB;
requests time out after 30 seconds. HTTP errors are closed and sanitized. TLS,
proxy blocking, and redirect blocking remain in place. Product IDs are validated
before interpolation into the fixed product-detail route. No retry loop is used;
HTTP 429 is returned as a sanitized error.

The Basic API user may have write permissions at Fourthwall. Read-only scope is
enforced by this adapter's implementation, not by a reduced-permission API key.
It has no generic request, upload, purchase, write, or theme tool. Do not broaden
its endpoint allowlist without a separate review.

### Configure Codex

Register the absolute command locally; no credentials are copied into Codex config:

```sh
codex mcp add fourthwall_readonly -- /usr/bin/python3 -B /home/joshmaz/Repos/pinball-club-website/scripts/fourthwall/mcp_server.py
```

The registration is stored in `~/.codex/config.toml`. The script reads credentials
from the existing private file when a tool runs. It does not need credentials to
initialize or list tools. Restart the MCP connection/app or open a new Codex chat
to load the newly registered tools; registration cannot refresh an existing chat's
tool catalog automatically. Move/update the registration if the checkout moves.

### Verify

```sh
python3 -B -m unittest discover -s scripts/fourthwall -p 'test_*.py'
python3 -B scripts/fourthwall/connection_test.py
python3 -B scripts/fourthwall/mcp_smoke_test.py
```

Offline tests use dummy credentials only. The explicit live smoke test starts the
real stdio process, initializes MCP, discovers the three tools, reads the shop,
reads one catalog page, and retrieves one product. It prints selected metadata
only and suppresses raw protocol/error output. It makes only authenticated GET
requests to the verified API host.

This minimal adapter implements initialization, initialized notification, ping,
tool discovery, and synchronous tool calls with newline-delimited JSON-RPC. It
negotiates versions 2024-11-05, 2025-03-26, 2025-06-18, and 2025-11-25. It does not
advertise resources, prompts, tasks, streaming, or cancellation; calls finish or
time out before processing the next message. Input frames are capped at 64 KiB.
Protocol stdout contains no logs. No third-party packages are installed or needed.

### Security review and publish boundary

The original client already fixed the API host, allowed only GET, disabled proxies
and redirects, and sanitized request failures. Review addressed missing permission
checks, unbounded response reads, and the need for a shop guard inside MCP calls.
The original connection test remains a selected-field read-only diagnostic.

`netlify.toml` publishes `dist`, built by `scripts/build-preview.mjs`. That builder
copies an explicit allowlist: root HTML/favicons, `assets`, `donate`, `wix_archive`,
selected `data` JSON files, generated public configuration, and robots/headers.
It does not copy `scripts/`, `.codex/`, or the private credentials file. Files under
`scripts/fourthwall/` therefore are excluded from this configured static output.
This assessment concerns the current build code; keep secrets out of all public
source directories. Larger build/publish architecture changes are deferred.

Sources: [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
[MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
The current official Fourthwall specification was fetched and checked again on
2026-10-30; all three GET routes explicitly support `basicAuth`.

### Verification completed

On 2026-10-30 the installed server passed the live stdio handshake, discovery,
shop read, first product-page read, and single-product lookup. Shop status was
LIVE; four products were AVAILABLE, with three PUBLIC and one HIDDEN. All 13
offline security/protocol tests and the existing build-preview test passed.
Codex registration was verified to contain only the absolute interpreter/script
command, with no credential environment entries. No Fourthwall scripts were
present in the existing `dist`. No commits, deployments, storefront changes,
purchases, or paid operations were performed. This verifies the local MCP process;
loading its tools into Codex's current UI requires a connection/app restart or a
new chat. Files remain uncommitted under the previously untracked
`scripts/fourthwall/` directory.
