Self-hosted software usually dies at the onboarding step. Forcing a user to open a terminal, run OpenSSL to generate a 32-byte cryptographic secret, and paste it into a .env file guarantees a 90% abandonment rate.

YAOS implements a consumer-grade, zero-terminal claim flow, while gracefully handling the realities of infrastructure paywalls.

# The Single-Use Claim Architecture

When deployed, the YAOS server boots into an "Unclaimed" state.
- The user visits the Worker URL in their browser and is greeted by a lightweight, dependency-free HTML setup page.
- The browser utilizes crypto.getRandomValues() to generate a high-entropy token locally.
- The user clicks "Claim". The token is sent to the server.
- The server hashes the token (SHA-256) and stores only the hash inside a singleton Config Durable Object via an ACID transaction.
- The setup route permanently locks itself.

For subsequent authentication, the plugin utilizes modern HTTP headers—specifically Authorization: Bearer <token>—rather than leaking the shared token into query strings, browser history, or proxies.

# The URI Protocol Handshake

To completely eliminate the copy-paste step, the setup page generates a custom deep-link: obsidian://yaos?action=setup&host=...&token=....

When clicked, the OS routes this directly to the Obsidian plugin, which intercepts the URI, configures its internal settings, and immediately boots the sync engine.

# Graceful Degradation and the Credit Card Wall

Cloudflare R2 requires a primary payment method on file to provision a bucket. If we enforced R2 as a strict deployment requirement, the Cloudflare "Deploy" button would hit a billing wall, and users would abandon the setup.

We solved this via Capability Negotiation:
- The default YAOS deployment does not include an R2 binding. It provisions the Worker and the Durable Object, which requires no credit card.
- When the Obsidian plugin connects, it performs a capability probe (GET /api/capabilities).
- If the server lacks the YAOS_BUCKET binding, it returns { attachments: false, snapshots: false }.
- The plugin reads this and gracefully disables the attachment and snapshot UI. It continues to sync markdown text flawlessly.

![Deploy-button resilience without mandatory R2](./diagrams/deploy-button-resilience-without-mandatory-r2.webp)

Power users who want attachment sync can easily add the R2 binding later via the Cloudflare dashboard. The server will dynamically detect the new binding, update its capabilities, and the plugin will unlock the UI without a single line of code changing.
