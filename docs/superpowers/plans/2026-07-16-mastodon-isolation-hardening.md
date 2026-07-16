# Mastodon API Isolation Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-enabled Mastodon compatibility switch, prove native OAuth remains intact, and restore the original abuse-report service return contract.

**Architecture:** A focused `MastodonApiIntegrationService` gates REST and streaming lifecycle registration from one place. Shared OAuth and native token-management code reads the same normalized configuration flag, while `AbuseReportService` shares one private create-and-notify path between its original API and a new entity-returning API.

**Tech Stack:** TypeScript, NestJS 11, Fastify 5, Vitest, TypeORM repositories, Redis mocks, pnpm.

## Global Constraints

- `enableMastodonApi` defaults to `true`; existing installations remain compatible without configuration changes.
- Disabled mode must not register Mastodon REST/streaming/OAuth behavior or access Mastodon token storage from native endpoints.
- Enabled mode must remain strict and fail on invalid route registration.
- Do not add, edit, or remove any migration or entity.
- Do not add or run backend E2E tests; use unit and Fastify injection tests only.
- New TypeScript files under `packages/backend/` require the AGPL SPDX header.
- Do not edit locale files or generated misskey-js API files.

---

### Task 1: Configuration and server lifecycle boundary

**Files:**
- Create: `packages/backend/src/server/api/mastodon/MastodonApiIntegrationService.ts`
- Create: `packages/backend/src/server/api/mastodon/MastodonApiIntegrationService.test.ts`
- Modify: `packages/backend/src/config.ts`
- Modify: `packages/backend/src/server/ServerModule.ts`
- Modify: `packages/backend/src/server/ServerService.ts`
- Modify: `.config/example.yml`
- Modify: `.config/docker_example.yml`
- Modify: `chart/files/default.yml`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: normalized `Config.enableMastodonApi: boolean`, `MastodonApiServerService.createServer`, and `MastodonStreamingApiServerService.attach/detach`.
- Produces: `MastodonApiIntegrationService.register(fastify): void`, `attach(server): void`, and `detach(): Promise<void>`.

- [ ] **Step 1: Write the failing lifecycle tests**

```ts
test('registers and manages streaming when Mastodon API is enabled', async () => {
	const { service, register, attach, detach } = createService(true);
	const fastify = { register };
	const server = {};
	service.register(fastify as never);
	service.attach(server as never);
	await service.detach();
	expect(register).toHaveBeenCalledTimes(1);
	expect(attach).toHaveBeenCalledWith(server);
	expect(detach).toHaveBeenCalledTimes(1);
});

test('does nothing when Mastodon API is disabled', async () => {
	const { service, register, attach, detach } = createService(false);
	service.register({ register } as never);
	service.attach({} as never);
	await service.detach();
	expect(register).not.toHaveBeenCalled();
	expect(attach).not.toHaveBeenCalled();
	expect(detach).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter backend exec vitest run src/server/api/mastodon/MastodonApiIntegrationService.test.ts`

Expected: FAIL because `MastodonApiIntegrationService` does not exist.

- [ ] **Step 3: Implement the boundary**

Add `enableMastodonApi?: boolean` to `Source`, `enableMastodonApi: boolean` to `Config`, and normalize it with `enableMastodonApi: config.enableMastodonApi ?? true`.

```ts
@Injectable()
export class MastodonApiIntegrationService {
	private streamingAttached = false;
	constructor(
		@Inject(DI.config) private config: Config,
		private mastodonApiServerService: MastodonApiServerService,
		private mastodonStreamingApiServerService: MastodonStreamingApiServerService,
	) {}

	public register(fastify: FastifyInstance): void {
		if (!this.config.enableMastodonApi) return;
		fastify.register(this.mastodonApiServerService.createServer);
	}

	public attach(server: http.Server): void {
		if (!this.config.enableMastodonApi) return;
		this.mastodonStreamingApiServerService.attach(server);
		this.streamingAttached = true;
	}

	public async detach(): Promise<void> {
		if (!this.streamingAttached) return;
		this.streamingAttached = false;
		await this.mastodonStreamingApiServerService.detach();
	}
}
```

Register this provider in `ServerModule`. Replace direct REST/streaming dependencies in `ServerService` with the integration service. Document `#enableMastodonApi: true` in both examples and Helm defaults. Add to Unreleased Server:

```markdown
- Enhance: Allow administrators to disable the Mastodon-compatible API with `enableMastodonApi: false`
```

- [ ] **Step 4: Run GREEN**

Run: `pnpm --filter backend exec vitest run src/server/api/mastodon/MastodonApiIntegrationService.test.ts src/server/api/mastodon/MastodonApiServerService.test.ts src/server/api/mastodon/MastodonStreamingApiServerService.test.ts src/server/api/StreamingApiServerService.test.ts`

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- .config/example.yml .config/docker_example.yml chart/files/default.yml CHANGELOG.md packages/backend/src/config.ts packages/backend/src/server/ServerModule.ts packages/backend/src/server/ServerService.ts packages/backend/src/server/api/mastodon/MastodonApiIntegrationService.ts packages/backend/src/server/api/mastodon/MastodonApiIntegrationService.test.ts
git commit -m "feat(mastodon): add runtime integration boundary"
```

### Task 2: Gate OAuth and cover native OAuth

**Files:**
- Modify: `packages/backend/src/server/oauth/OAuth2ProviderService.ts`
- Modify: `packages/backend/src/server/oauth/OAuth2ProviderService.test.ts`

**Interfaces:**
- Consumes: `Config.enableMastodonApi`.
- Produces: native-only RFC 8414 metadata and dispatch when disabled; current behavior when enabled.

- [ ] **Step 1: Add failing disabled and native-flow tests**

Expand the fixture with working native mocks for HTTP client discovery, cache/user lookup, ID generation, and access-token insertion. Add:

```ts
test('restores native OAuth metadata and routes when Mastodon API is disabled', async () => {
	const { service, fastify, mastodonOAuthService } = await createServer(false);
	const metadata = service.generateRFC8414();
	expect(metadata.scopes_supported).not.toContain('read:accounts');
	expect(metadata.grant_types_supported).toEqual(['authorization_code']);
	expect(metadata).not.toHaveProperty('userinfo_endpoint');
	expect(metadata).not.toHaveProperty('revocation_endpoint');
	expect((await fastify.inject({ method: 'GET', url: '/userinfo' })).statusCode).toBe(404);
	expect((await fastify.inject({ method: 'POST', url: '/revoke' })).statusCode).toBe(404);
	expect(mastodonOAuthService.getSupportedScopes).not.toHaveBeenCalled();
});
```

Build a native S256 challenge:

```ts
const verifier = 'native-oauth-verifier-which-is-long-enough-for-pkce';
const challenge = createHash('sha256').update(verifier).digest('base64url');
```

Inject `/authorize`, parse `transaction_id` from the HTML, submit `/decision`, parse the redirect `code`, exchange it through the token Fastify instance, and assert the native repository insert. Assert Mastodon authorization and exchange spies remain untouched.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter backend exec vitest run src/server/oauth/OAuth2ProviderService.test.ts`

Expected: disabled metadata and route assertions fail because integration is always active.

- [ ] **Step 3: Gate shared OAuth points**

Use conditional metadata fields:

```ts
const mastodonEnabled = this.config.enableMastodonApi;
return {
	issuer: this.config.url,
	authorization_endpoint: new URL('/oauth/authorize', this.config.url),
	token_endpoint: new URL('/oauth/token', this.config.url),
	...(mastodonEnabled ? { userinfo_endpoint: new URL('/oauth/userinfo', this.config.url).toString() } : {}),
	scopes_supported: mastodonEnabled ? [...new Set([...kinds, ...this.mastodonOAuthService.getSupportedScopes()])] : kinds,
	response_types_supported: ['code'],
	grant_types_supported: mastodonEnabled ? ['authorization_code', 'client_credentials'] : ['authorization_code'],
	...(mastodonEnabled ? {
		token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
		revocation_endpoint: this.mastodonOAuthService.getRevocationEndpoint(),
		app_registration_endpoint: new URL('/api/v1/apps', this.config.url),
	} : {}),
	service_documentation: 'https://misskey-hub.net',
	code_challenge_methods_supported: ['S256'],
	authorization_response_iss_parameter_supported: true,
};
```

Require `config.enableMastodonApi` in authorize, decision, and token dispatch conditions. Register revoke and userinfo only when enabled. Do not change native PKCE, redirect, grant reuse, insertion, or error logic.

- [ ] **Step 4: Run GREEN**

Run: `pnpm --filter backend exec vitest run src/server/oauth/OAuth2ProviderService.test.ts`

Expected: enabled, disabled, and full native OAuth tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- packages/backend/src/server/oauth/OAuth2ProviderService.ts packages/backend/src/server/oauth/OAuth2ProviderService.test.ts
git commit -m "test(oauth): preserve native flow across Mastodon integration"
```

### Task 3: Gate native token management

**Files:**
- Modify: `packages/backend/src/server/api/endpoints/i/apps.ts`
- Modify: `packages/backend/src/server/api/endpoints/i/apps.test.ts`
- Modify: `packages/backend/src/server/api/endpoints/i/revoke-token.ts`
- Modify: `packages/backend/src/server/api/endpoints/i/revoke-token.test.ts`

**Interfaces:**
- Consumes: `Config.enableMastodonApi`.
- Produces: native-only list/revoke behavior when disabled.

- [ ] **Step 1: Add failing disabled tests**

```ts
test('returns only native tokens without reading Mastodon storage when disabled', async () => {
	const nativeToken = createNativeToken();
	const { endpoint, mastodonTokensRepository } = createEndpoint({ enableMastodonApi: false, nativeTokens: [nativeToken] });
	const result = await endpoint.exec({}, me, null);
	expect(result).toHaveLength(1);
	expect(result[0].id).toBe(nativeToken.id);
	expect(mastodonTokensRepository.find).not.toHaveBeenCalled();
});

test('revokes only native tokens when Mastodon API is disabled', async () => {
	const { endpoint, accessTokensRepository, mastodonTokensRepository, redis } = createEndpoint({ enableMastodonApi: false });
	await endpoint.exec({ tokenId: 'native-token-id' }, me, null);
	expect(accessTokensRepository.delete).toHaveBeenCalledWith({ id: 'native-token-id', userId: me.id });
	expect(mastodonTokensRepository.delete).not.toHaveBeenCalled();
	expect(mastodonTokensRepository.findOneBy).not.toHaveBeenCalled();
	expect(redis.publish).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter backend exec vitest run src/server/api/endpoints/i/apps.test.ts src/server/api/endpoints/i/revoke-token.test.ts`

Expected: disabled assertions fail.

- [ ] **Step 3: Implement repository gates**

Inject `DI.config` into `i/apps` and use:

```ts
const tokens = await query.getMany();
const mastodonTokens = this.config.enableMastodonApi
	? await this.mastodonOAuthTokensRepository.find({ where: { userId: me.id }, relations: { client: true } })
	: [];
```

In both `i/revoke-token` branches, perform the native delete first and then `if (!this.config.enableMastodonApi) return;` before any Mastodon hash, repository, or Redis work.

- [ ] **Step 4: Run GREEN**

Run the Step 2 command.

Expected: disabled and existing enabled tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- packages/backend/src/server/api/endpoints/i/apps.ts packages/backend/src/server/api/endpoints/i/apps.test.ts packages/backend/src/server/api/endpoints/i/revoke-token.ts packages/backend/src/server/api/endpoints/i/revoke-token.test.ts
git commit -m "fix(mastodon): isolate native token management when disabled"
```

### Task 4: Restore abuse-report return contract

**Files:**
- Create: `packages/backend/src/core/AbuseReportService.test.ts`
- Modify: `packages/backend/src/core/AbuseReportService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonReportService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonReportService.test.ts`

**Interfaces:**
- Produces: original `report(params)` notification results and new `reportAndGetCreated(params): Promise<MiAbuseUserReport[]>`.

- [ ] **Step 1: Write failing contract tests**

```ts
test('report returns the original ordered notification results', async () => {
	const { service, notifications } = createService();
	await expect(service.report([input])).resolves.toEqual(['admin', 'webhook', 'mail']);
	expect(notifications.notifyAdminStream).toHaveBeenCalledTimes(1);
	expect(notifications.notifySystemWebhook).toHaveBeenCalledTimes(1);
	expect(notifications.notifyMail).toHaveBeenCalledTimes(1);
});

test('reportAndGetCreated returns inserted reports after notifying once', async () => {
	const { service, repository, notifications, insertedReport } = createService();
	await expect(service.reportAndGetCreated([input])).resolves.toEqual([insertedReport]);
	expect(repository.insertOne).toHaveBeenCalledTimes(1);
	expect(notifications.notifyAdminStream).toHaveBeenCalledTimes(1);
	expect(notifications.notifySystemWebhook).toHaveBeenCalledTimes(1);
	expect(notifications.notifyMail).toHaveBeenCalledTimes(1);
});
```

Update the Mastodon report fixture to expose `reportAndGetCreated` and assert `report` is unused.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter backend exec vitest run src/core/AbuseReportService.test.ts src/server/api/mastodon/MastodonReportService.test.ts`

Expected: `report()` returns reports and `reportAndGetCreated()` is missing.

- [ ] **Step 3: Implement shared creation and notifications**

```ts
private async createAndNotify(params: AbuseReportInput[]) {
	const reports = Array.of<MiAbuseUserReport>();
	for (const param of params) {
		reports.push(await this.abuseUserReportsRepository.insertOne({ id: this.idService.gen(), ...param }));
	}
	const notifications = await Promise.all([
		this.abuseReportNotificationService.notifyAdminStream(reports),
		this.abuseReportNotificationService.notifySystemWebhook(reports, 'abuseReport'),
		this.abuseReportNotificationService.notifyMail(reports),
	]);
	return { reports, notifications };
}

public async report(params: AbuseReportInput[]) {
	return (await this.createAndNotify(params)).notifications;
}

public async reportAndGetCreated(params: AbuseReportInput[]): Promise<MiAbuseUserReport[]> {
	return (await this.createAndNotify(params)).reports;
}
```

Change `MastodonReportService` to call `reportAndGetCreated`.

- [ ] **Step 4: Run GREEN and focused regression**

Run: `pnpm --filter backend exec vitest run src/core/AbuseReportService.test.ts src/server/api/mastodon src/server/oauth/OAuth2ProviderService.test.ts src/server/api/StreamingApiServerService.test.ts src/server/api/endpoints/i/apps.test.ts src/server/api/endpoints/i/revoke-token.test.ts test/unit/mastodon-oauth-token-migration.ts`

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- packages/backend/src/core/AbuseReportService.ts packages/backend/src/core/AbuseReportService.test.ts packages/backend/src/server/api/mastodon/MastodonReportService.ts packages/backend/src/server/api/mastodon/MastodonReportService.test.ts
git commit -m "fix(backend): restore abuse report service contract"
```

### Task 5: Final Misskey validation

**Files:**
- Review only: all Task 1–4 files.

**Interfaces:**
- Produces: a verified handoff without migration, entity, locale, frontend, or generated API changes.

- [ ] **Step 1: Run focused tests fresh**

Run the Task 4 Step 4 command. Expected: zero failed files and tests.

- [ ] **Step 2: Run targeted lint**

Run: `pnpm --filter backend exec eslint src/config.ts src/core/AbuseReportService.ts src/core/AbuseReportService.test.ts src/server/ServerModule.ts src/server/ServerService.ts src/server/api/mastodon/MastodonApiIntegrationService.ts src/server/api/mastodon/MastodonApiIntegrationService.test.ts src/server/api/mastodon/MastodonReportService.ts src/server/api/mastodon/MastodonReportService.test.ts src/server/api/endpoints/i/apps.ts src/server/api/endpoints/i/apps.test.ts src/server/api/endpoints/i/revoke-token.ts src/server/api/endpoints/i/revoke-token.test.ts src/server/oauth/OAuth2ProviderService.ts src/server/oauth/OAuth2ProviderService.test.ts`

Expected: exit 0 with no ESLint errors; report warnings separately.

- [ ] **Step 3: Verify restricted paths and worktree**

```powershell
git diff --check
git diff --name-only de67331800..HEAD -- packages/backend/migration packages/backend/src/models locales packages/frontend packages/misskey-js/src/autogen
git status --short
```

Expected: diff check passes, restricted-path output is empty, and only intentional files remain.

- [ ] **Step 4: Inspect full lint status**

Run: `pnpm lint`

Expected: exit 0 or an exact report of unrelated baseline failures, with no new error in changed files.

- [ ] **Step 5: Review configuration and CHANGELOG**

Confirm the Unreleased Server entry appears once and all three configuration examples document the default-enabled switch.

