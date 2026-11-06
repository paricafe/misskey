/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import path from 'node:path';
import { normalizePath } from 'vite';
import type { ChunkingContext, CodeSplittingGroup } from 'rolldown';

function collectStaticDependencies(roots: string[], context: ChunkingContext): Set<string> {
	const modules = new Set<string>();

	function visit(id: string): void {
		if (modules.has(id)) return;
		modules.add(id);
		for (const dependency of context.getModuleInfo(id)?.importedIds ?? []) visit(dependency);
	}

	roots.forEach(visit);
	return modules;
}

/** Keep eagerly needed code together without pulling posting tools into the visitor boot. */
export function createClientChunkGroup(frontendRoot: string): CodeSplittingGroup {
	const resolve = (file: string) => normalizePath(path.resolve(frontendRoot, file));
	let common: Set<string> | undefined;
	let reading: Set<string> | undefined;
	let interactions: Set<string> | undefined;
	return {
		name(id, context) {
			common ??= collectStaticDependencies([
				'src/boot/main-boot.ts', 'src/boot/sub-boot.ts', 'src/ui/visitor.vue', 'src/ui/minimum.vue',
			].map(resolve), context);
			reading ??= collectStaticDependencies([
				'src/components/MkNote.vue', 'src/components/MkNotesTimeline.vue', 'src/components/MkStreamingNotesTimeline.vue',
			].map(resolve), context);
			interactions ??= collectStaticDependencies([
				'src/pages/timeline.vue', 'src/components/MkPostFormDialog.vue', 'src/components/MkEmojiPickerDialog.vue',
			].map(resolve), context);
			if (common.has(id)) return 'client-core';
			if (reading.has(id)) return 'client-reading';
			if (interactions.has(id)) return 'client-interactions';
			return undefined;
		},
		includeDependenciesRecursively: false,
	};
}
