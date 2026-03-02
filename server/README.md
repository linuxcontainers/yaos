# Vault CRDT Sync — Server

PartyKit server for the Obsidian vault sync plugin. Relays Yjs CRDT updates between devices and persists state in Durable Objects. Optionally uses R2 for attachment storage and snapshots.

## Architecture

- **One room per vault**: Room ID = `v1:<vaultId>`
- **Yjs sync**: [y-partykit](https://docs.partykit.io/reference/y-partykit-api/) handles the sync protocol
- **Persistence**: Durable Object snapshot mode (survives hibernation and restarts)
- **Hibernation**: Enabled — idle rooms use no compute
- **Auth**: WebSocket uses `?token=`; HTTP endpoints use `Authorization: Bearer <token>`
- **Blobs**: Presigned R2 URLs for attachment upload/download (optional)
- **Snapshots**: CRDT state backups stored in R2 (optional)

## Quick start (local dev)

```bash
cd server
npm install
cp .env.example .env
# Edit .env: set SYNC_TOKEN to any random string
npm run dev
```

Server runs at `http://127.0.0.1:1999`.

Plugin settings:
| Setting | Value |
|---------|-------|
| Server host | `http://127.0.0.1:1999` |
| Token | Same as `SYNC_TOKEN` in `.env` |
| Vault ID | Any string (e.g., `dev-vault`) |

## Deploy to PartyKit (managed)

The simplest option. Free tier includes Durable Object storage.

```bash
# 1. Login
npx partykit login

# 2. Set the auth token
npx partykit env add SYNC_TOKEN
# Enter your token when prompted

# 3. Deploy
npm run deploy
```

Output: `https://vault-crdt-sync.<username>.partykit.dev`

Use that URL as **Server host** in the plugin.

## Deploy to your own Cloudflare account

For custom domains, regulatory requirements, or R2 integration.

### Prerequisites

1. **Cloudflare Account ID**: Dashboard → Overview → right sidebar, or in the URL
2. **API Token**: [Create one](https://dash.cloudflare.com/profile/api-tokens) using the "Edit Cloudflare Workers" template

### Deploy

```bash
CLOUDFLARE_ACCOUNT_ID=<your-account-id> \
CLOUDFLARE_API_TOKEN=<your-api-token> \
npx partykit deploy \
  --domain sync.yourdomain.com \
  --var SYNC_TOKEN=<your-token>
```

The `--var` flag sets environment variables. Add R2 vars if using attachments/snapshots (see below).

### DNS setup

After deploying, add a CNAME record:
- **Name**: `sync` (or your subdomain)
- **Target**: The worker URL PartyKit outputs, or use Cloudflare's proxy

## R2 setup (attachments + snapshots)

R2 is required for:
- **Attachment sync**: Images, PDFs, and other non-markdown files
- **Snapshots**: Daily backups and on-demand restore points

### 1. Create an R2 bucket

Cloudflare Dashboard → R2 → Create bucket
- Name: `vault-crdt-sync` (or your choice)
- Location: Automatic

### 2. Create R2 API credentials

R2 → Manage R2 API Tokens → Create API Token
- Permissions: **Object Read & Write**
- Specify bucket: Select your bucket
- TTL: No expiration (or your preference)

Save the **Access Key ID** and **Secret Access Key**.

### 3. Get your Account ID

Same as for deployment — visible in the dashboard sidebar.

### 4. Set environment variables

For local dev, add to `.env`:
```bash
R2_ACCOUNT_ID=<your-cloudflare-account-id>
R2_ACCESS_KEY_ID=<from-api-token>
R2_SECRET_ACCESS_KEY=<from-api-token>
R2_BUCKET_NAME=vault-crdt-sync
```

For production (own Cloudflare account), pass via `--var` during deploy:
```bash
CLOUDFLARE_ACCOUNT_ID=<account> \
CLOUDFLARE_API_TOKEN=<token> \
npx partykit deploy \
  --domain sync.yourdomain.com \
  --var SYNC_TOKEN=<token> \
  --var R2_ACCOUNT_ID=<account-id> \
  --var R2_ACCESS_KEY_ID=<access-key> \
  --var R2_SECRET_ACCESS_KEY=<secret-key> \
  --var R2_BUCKET_NAME=vault-crdt-sync
```

For PartyKit managed hosting, R2 integration requires deploying to your own account (PartyKit's shared infra doesn't expose your R2).

## Environment variables reference

| Variable | Required | Description |
|----------|----------|-------------|
| `SYNC_TOKEN` | Yes | Auth token — must match plugin settings |
| `R2_ACCOUNT_ID` | For R2 | Your Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | For R2 | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | For R2 | R2 API token secret |
| `R2_BUCKET_NAME` | For R2 | Name of your R2 bucket |

## Endpoints

WebSocket connections require `?token=<SYNC_TOKEN>`.
HTTP endpoints require `Authorization: Bearer <SYNC_TOKEN>`.

### WebSocket
- `wss://<host>/parties/main/v1:<vaultId>` — Yjs sync connection

### HTTP (blob storage)
- `POST /blob/presign-put` — Get presigned URL to upload a blob
- `POST /blob/presign-get` — Get presigned URL to download a blob  
- `POST /blob/exists` — Check which blob hashes exist in R2

### HTTP (snapshots)
- `POST /snapshot/maybe` — Create daily snapshot (noop if already taken today)
- `POST /snapshot/now` — Force create a snapshot
- `GET /snapshot/list` — List all snapshots for this vault
- `POST /snapshot/presign-get` — Get download URL for a snapshot

## Operational safeguards

The server includes a few deliberate hardening limits:

- **Blob upload cap**: `/blob/presign-put` rejects uploads larger than **10 MB**
- **Bounded R2 fan-out**: blob existence checks and snapshot index fetches use a small worker pool instead of unbounded `Promise.all(...)`
- **Cloudflare-safe concurrency**: the worker pool is intentionally set below the Workers 6-open-connection ceiling to avoid self-inflicted connection pressure
- **HTTP auth headers**: normal HTTP endpoints use `Authorization: Bearer <token>` instead of query-string tokens
- **Robust snapshot listing**: R2 XML listing is parsed with a real XML parser, not regex extraction
- **Safer snapshot IDs**: snapshot suffixes use cryptographic randomness instead of `Math.random()`

These constraints are meant to keep the server predictable under normal personal-use loads, especially on Cloudflare Workers and Durable Objects.

## Secret management

### Generating a strong token

```bash
# macOS / Linux
openssl rand -base64 32

# Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Rotating the token

1. Generate a new token
2. Redeploy with the new `--var SYNC_TOKEN=<new-token>`
3. Update plugin settings on all devices
4. Reload the plugin on each device

No grace period — old token stops working immediately on deploy.

### Security notes

- Always use HTTPS in production
- The plugin warns if connecting over unencrypted HTTP to non-localhost
- `http://127.0.0.1` for local dev is fine
- Compromised token = full read/write access to synced vault content

## Android / mobile notes

The plugin handles mobile reconnection automatically, but be aware:

- **Network switches**: Plugin reconnects on visibility change (app resume)
- **Aggressive OS**: Some Android OEMs kill background apps aggressively. The plugin persists to IndexedDB, so data isn't lost, but sync resumes on next open.
- **Attachment sync**: Large files + cellular = consider disabling attachment sync or reducing concurrency in plugin settings

If users report "stuck" sync on mobile, the issue is usually network — have them try "Reconnect to sync server" command.

## Storage limits

- **Durable Objects**: 128 KiB per value, 2 KB key limit
- **y-partykit**: Automatically shards large Yjs snapshots
- **R2**: Effectively unlimited; free tier is 10 GB/month

## Updating

```bash
# Make changes to src/server.ts
npm run deploy  # or full deploy command with env vars
```

CRDT data persists in Durable Objects — redeploys don't affect stored state.

## Troubleshooting

**"R2 not configured"**: Missing R2 env vars. Check all four are set.

**"unauthorized"**: Token mismatch. Verify `SYNC_TOKEN` matches between server and plugin.

**Snapshots return empty list**: Snapshots are per-vault. Check vaultId matches. If you changed vaultId, old snapshots are under the old ID.

**Slow initial sync on large vaults**: Expected — CRDT state must transfer fully on first connect. Subsequent syncs are incremental.

**WebSocket disconnects frequently**: Check server logs for errors. May indicate network instability or client-side issues.
