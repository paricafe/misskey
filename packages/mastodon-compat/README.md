# @pari/mastodon-compat

An independent Mastodon HTTP/WebSocket gateway for the public Misskey API.

See [deployment, compatibility and verification](../../docs/mastodon-compatibility.md).

- `pnpm build` compiles the gateway.
- `pnpm test` runs protocol and transport regression tests.
- `pnpm start` starts the standalone gateway with `MASTODON_PUBLIC_URL`, `MISSKEY_NATIVE_URL`, and optional `MASTODON_DATABASE`.

No backend internals, ORM, or native service imports are permitted in this package.
