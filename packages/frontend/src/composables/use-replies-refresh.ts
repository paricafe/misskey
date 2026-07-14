/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export interface NoteChildrenChange {
	action: 'added' | 'removed';
	childId: string;
}

export function createRepliesRefreshScheduler(options: {
	isActive: () => boolean;
	isLoaded: () => boolean;
	refresh: () => Promise<void>;
	remove: (childId: string) => void;
	throttleMs?: number;
}) {
	const throttleMs = options.throttleMs ?? 1000;
	let dirty = false;
	let running = false;
	let disposed = false;
	let timer: number | null = null;
	let lastStartedAt = -throttleMs;

	function canRefresh(): boolean {
		return !disposed && dirty && options.isActive() && options.isLoaded();
	}

	function schedule(): void {
		if (!canRefresh() || running || timer != null) return;
		const delay = Math.max(0, lastStartedAt + throttleMs - Date.now());
		timer = window.setTimeout(() => { void run(); }, delay);
	}

	async function run(): Promise<void> {
		timer = null;
		if (!canRefresh() || running) return;
		dirty = false;
		running = true;
		lastStartedAt = Date.now();
		let failed = false;
		try {
			await options.refresh();
		} catch {
			dirty = true;
			failed = true;
		} finally {
			running = false;
			if (!failed) schedule();
		}
	}

	function invalidate(): void {
		dirty = true;
		schedule();
	}

	function notify(change: NoteChildrenChange): void {
		if (change.action === 'removed') options.remove(change.childId);
		invalidate();
	}

	function activate(): void {
		schedule();
	}

	function dispose(): void {
		disposed = true;
		if (timer != null) window.clearTimeout(timer);
		timer = null;
	}

	return {
		invalidate,
		notify,
		activate,
		dispose,
		isDirty: () => dirty,
	};
}
