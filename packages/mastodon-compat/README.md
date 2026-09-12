# @pari/mastodon-compat

An independent Mastodon HTTP/WebSocket gateway for the public Misskey API.

See [deployment, compatibility and verification](../../docs/mastodon-compatibility.md).

- `pnpm build` compiles the gateway.
- `pnpm test` runs protocol and transport regression tests.
- `pnpm start` starts the standalone gateway with `MASTODON_PUBLIC_URL`, `MISSKEY_NATIVE_URL`, and `MASTODON_DATABASE_URL` (PostgreSQL).
- The embedded gateway uses Misskey's existing PostgreSQL configuration. Run native migrations before starting it; no compatibility file volume is required.

No backend internals, ORM, or native service imports are permitted in this package.
