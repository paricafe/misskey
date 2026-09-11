/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface CompatClient {
	id: string;
	name: string;
	redirectUris: string[];
	scopes: string[];
	website?: string;
	createdAt: number;
}

export interface Grant {
	tokenHash: string;
	clientId: string;
	scopes: string[];
	kind: 'user' | 'app';
	userId?: string;
	nativeToken?: string;
	createdAt: number;
}

export interface AuthorizationCode {
	clientId: string;
	redirectUri: string;
	scopes: string[];
	userId: string;
	nativeToken: string;
	codeChallenge?: string;
}

export const hashCredential = (value: string): string => createHash('sha256').update(value).digest('hex');
export const randomCredential = (): string => `mc_${randomBytes(32).toString('base64url')}`;

/** All writes are synchronous; a successful native action can immediately persist its metadata. */
export class CompatStore {
	private readonly db: DatabaseSync;
	private readonly key: Buffer;

	constructor(filename: string) {
		if (filename === ':memory:') {
			this.key = randomBytes(32);
		} else {
			mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
			const keyFile = `${filename}.key`;
			if (!existsSync(keyFile) && existsSync(filename) && statSync(filename).size > 0) {
				throw new Error('The compatibility database encryption key is missing');
			}
			try {
				const fd = openSync(keyFile, 'wx', 0o600);
				try { writeFileSync(fd, randomBytes(32)); } finally { closeSync(fd); }
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			}
			chmodSync(keyFile, 0o600);
			this.key = readFileSync(keyFile);
			if (this.key.length !== 32) throw new Error('Invalid compatibility database encryption key');
			try { closeSync(openSync(filename, 'wx', 0o600)); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			}
			chmodSync(filename, 0o600);
		}
		this.db = new DatabaseSync(filename);
		this.db.exec(`
			PRAGMA busy_timeout = 5000;
			PRAGMA journal_mode = WAL;
			PRAGMA foreign_keys = ON;
			CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, data TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS grants (hash TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), payload TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS kv (namespace TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, owner, key));
			CREATE TABLE IF NOT EXISTS operations (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (kind, id));
		`);
		if (filename !== ':memory:') {
			for (const suffix of ['', '-wal', '-shm']) {
				if (existsSync(filename + suffix)) chmodSync(filename + suffix, 0o600);
			}
		}
	}

	close(): void { this.db.close(); }

	transaction<T>(callback: () => T): T {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const result = callback();
			if (result instanceof Promise) throw new TypeError('CompatStore transactions must be synchronous');
			this.db.exec('COMMIT');
			return result;
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}

	createClient(input: Omit<CompatClient, 'id' | 'createdAt'>, now = Date.now()): { client: CompatClient; clientSecret: string } {
		const client: CompatClient = { ...input, id: randomCredential(), createdAt: now };
		const clientSecret = randomCredential();
		this.db.prepare('INSERT INTO clients VALUES (?, ?, ?)').run(client.id, hashCredential(clientSecret), JSON.stringify(client));
		return { client, clientSecret };
	}

	getClient(id: string): CompatClient | undefined {
		const row = this.db.prepare('SELECT data FROM clients WHERE id = ?').get(id);
		return row ? JSON.parse(String(row.data)) as CompatClient : undefined;
	}

	verifyClient(id: string, secret: string): CompatClient | undefined {
		const row = this.db.prepare('SELECT data, secret_hash FROM clients WHERE id = ?').get(id);
		if (!row || !timingSafeEqual(Buffer.from(String(row.secret_hash), 'hex'), Buffer.from(hashCredential(secret), 'hex'))) return undefined;
		return JSON.parse(String(row.data)) as CompatClient;
	}

	issueCode(code: AuthorizationCode, expiresAt: number): string {
		const raw = randomCredential();
		this.db.prepare('INSERT INTO codes VALUES (?, ?, ?)').run(hashCredential(raw), this.encrypt(code), expiresAt);
		return raw;
	}

	getCode(raw: string, now = Date.now()): AuthorizationCode | undefined {
		const row = this.db.prepare('SELECT payload FROM codes WHERE hash = ? AND expires_at > ?').get(hashCredential(raw), now);
		return row ? this.decrypt<AuthorizationCode>(String(row.payload)) : undefined;
	}

	deleteCode(raw: string): boolean {
		return Number(this.db.prepare('DELETE FROM codes WHERE hash = ?').run(hashCredential(raw)).changes) > 0;
	}

	createGrant(input: Omit<Grant, 'tokenHash' | 'createdAt'>, now = Date.now()): { token: string; grant: Grant } {
		const token = randomCredential();
		const grant = { ...input, tokenHash: hashCredential(token), createdAt: now };
		this.db.prepare('INSERT INTO grants VALUES (?, ?, ?)').run(grant.tokenHash, grant.clientId, this.encrypt(grant));
		return { token, grant };
	}

	getGrant(token: string): Grant | undefined {
		const row = this.db.prepare('SELECT payload FROM grants WHERE hash = ?').get(hashCredential(token));
		return row ? this.decrypt<Grant>(String(row.payload)) : undefined;
	}

	revokeGrant(token: string, clientId: string): boolean {
		return Number(this.db.prepare('DELETE FROM grants WHERE hash = ? AND client_id = ?').run(hashCredential(token), clientId).changes) > 0;
	}

	get<T>(namespace: string, ownerId: string, key: string): T | undefined {
		const row = this.db.prepare('SELECT value FROM kv WHERE namespace = ? AND owner = ? AND key = ?').get(namespace, ownerId, key);
		return row ? this.decrypt<T>(String(row.value)) : undefined;
	}

	put(namespace: string, ownerId: string, key: string, value: unknown): void {
		this.db.prepare('INSERT INTO kv VALUES (?, ?, ?, ?) ON CONFLICT (namespace, owner, key) DO UPDATE SET value = excluded.value').run(namespace, ownerId, key, this.encrypt(value));
	}

	list<T>(namespace: string, ownerId: string): Array<{ key: string; value: T }> {
		return this.db.prepare('SELECT key, value FROM kv WHERE namespace = ? AND owner = ? ORDER BY key').all(namespace, ownerId)
			.map(row => ({ key: String(row.key), value: this.decrypt<T>(String(row.value)) }));
	}

	delete(namespace: string, ownerId: string, key: string): boolean {
		return Number(this.db.prepare('DELETE FROM kv WHERE namespace = ? AND owner = ? AND key = ?').run(namespace, ownerId, key).changes) > 0;
	}

	putOperation(kind: string, id: string, value: unknown, expiresAt: number): void {
		this.db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at').run(kind, id, this.encrypt(value), expiresAt);
	}

	getOperation<T>(kind: string, id: string, now = Date.now()): T | undefined {
		const row = this.db.prepare('SELECT payload FROM operations WHERE kind = ? AND id = ? AND expires_at > ?').get(kind, id, now);
		return row ? this.decrypt<T>(String(row.payload)) : undefined;
	}

	takeOperation<T>(kind: string, id: string, now = Date.now()): T | undefined {
		const row = this.db.prepare('DELETE FROM operations WHERE kind = ? AND id = ? RETURNING payload, expires_at').get(kind, id);
		return row && Number(row.expires_at) > now ? this.decrypt<T>(String(row.payload)) : undefined;
	}

	deleteOperation(kind: string, id: string): boolean {
		return Number(this.db.prepare('DELETE FROM operations WHERE kind = ? AND id = ?').run(kind, id).changes) > 0;
	}

	prune(now = Date.now()): void {
		this.db.prepare('DELETE FROM operations WHERE expires_at <= ?').run(now);
		this.db.prepare('DELETE FROM codes WHERE expires_at <= ?').run(now);
	}

	private encrypt(value: unknown): string {
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', this.key, iv);
		const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
		return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
	}

	private decrypt<T>(payload: string): T {
		const buffer = Buffer.from(payload, 'base64');
		const decipher = createDecipheriv('aes-256-gcm', this.key, buffer.subarray(0, 12));
		decipher.setAuthTag(buffer.subarray(12, 28));
		return JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8')) as T;
	}
}
