/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiRole } from '@/models/Role.js';
import { DEFAULT_POLICIES, type RolePolicies, RoleService } from './RoleService.js';

describe('RoleService single-policy evaluation and timeline pipeline guard', () => {
	function createService(roles: MiRole[]) {
		const exec = vi.fn().mockResolvedValue([]);
		const pipeline = vi.fn(() => ({ exec }));
		const service = Object.create(RoleService.prototype) as RoleService;
		Object.assign(service, {
			meta: {
				policies: {
					...DEFAULT_POLICIES,
					rateLimitFactor: 2,
					mentionLimit: 10,
					canPublicNote: true,
				},
			},
			config: { maxFileSize: 50 * 1024 * 1024 },
			redisForTimelines: { pipeline },
			fanoutTimelineService: { push: vi.fn() },
			globalEventService: { publishRoleTimelineStream: vi.fn() },
		});
		Object.defineProperty(service, 'getUserRoles', {
			value: vi.fn().mockResolvedValue(roles),
		});
		return { service, pipeline, exec };
	}

	test('getUserPolicy and getUserPolicyFromRoles match getUserPolicies across all keys', async () => {
		const roles = [
			{
				id: 'r1',
				policies: {
					rateLimitFactor: { useDefault: false, priority: 0, value: 5 },
					canPublicNote: { useDefault: false, priority: 1, value: false },
					mentionLimit: { useDefault: false, priority: 0, value: 30 },
					chatAvailability: { useDefault: false, priority: 0, value: 'readonly' },
					uploadableFileTypes: { useDefault: false, priority: 0, value: ['image/png', '  '] },
					maxFileSizeMb: { useDefault: false, priority: 0, value: 200 },
				},
			},
			{
				id: 'r2',
				policies: {
					rateLimitFactor: { useDefault: false, priority: 1, value: 3 },
					canPublicNote: { useDefault: false, priority: 0, value: true },
					mentionLimit: { useDefault: true, priority: 1, value: 99 },
					chatAvailability: { useDefault: false, priority: 0, value: 'available' },
					uploadableFileTypes: { useDefault: false, priority: 0, value: ['image/webp'] },
				},
			},
		] as unknown as MiRole[];

		const { service } = createService(roles);
		const all = await service.getUserPolicies('u1');

		for (const key of Object.keys(all) as Array<keyof RolePolicies>) {
			expect(service.getUserPolicyFromRoles(roles, key)).toEqual(all[key]);
			await expect(service.getUserPolicy('u1', key)).resolves.toEqual(all[key]);
		}
		await expect(service.getUserPolicy(null, 'rateLimitFactor')).resolves.toBe(2);
	});

	test('addNoteToRoleTimeline skips Redis pipeline execution when the user has no roles', async () => {
		const { service, pipeline, exec } = createService([]);

		await service.addNoteToRoleTimeline({
			id: 'note-1',
			userId: 'u1',
			fileIds: [],
		} as never);

		expect(pipeline).not.toHaveBeenCalled();
		expect(exec).not.toHaveBeenCalled();
	});
});
