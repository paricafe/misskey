/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type VirtualListAnchor = { id: string; offset: number };

/** Measured heights belong to item IDs, so pagination and edits can retain the scroll anchor. */
export class VirtualListLayout {
	private ids: readonly string[] = [];
	private indices = new Map<string, number>();
	private heights = new Map<string, number>();
	private offsets = [0];
	private dirty = false;

	constructor(private estimatedHeight = 200) {}

	public update(ids: readonly string[]): void {
		this.ids = [...ids];
		this.indices = new Map(ids.map((id, i) => [id, i]));
		for (const id of this.heights.keys()) {
			if (!this.indices.has(id)) this.heights.delete(id);
		}
		this.dirty = true;
	}

	public measure(id: string, height: number): boolean {
		if (!this.indices.has(id) || !Number.isFinite(height) || height < 0 || this.heights.get(id) === height) return false;
		this.heights.set(id, height);
		this.dirty = true;
		return true;
	}

	private rebuild(): void {
		if (!this.dirty) return;
		this.offsets = [0];
		for (const id of this.ids) this.offsets.push(this.offsets.at(-1)! + (this.heights.get(id) ?? this.estimatedHeight));
		this.dirty = false;
	}

	public offset(index: number): number {
		this.rebuild();
		return this.offsets[Math.max(0, Math.min(index, this.ids.length))];
	}

	public get totalHeight(): number {
		return this.offset(this.ids.length);
	}

	private indexAt(position: number): number {
		this.rebuild();
		let low = 0;
		let high = this.ids.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (this.offsets[middle + 1] <= position) low = middle + 1;
			else high = middle;
		}
		return low;
	}

	public range(top: number, viewportHeight: number, overscan = 600): { start: number; end: number; top: number; bottom: number } {
		const start = this.indexAt(Math.max(0, top - overscan));
		const endPosition = top + viewportHeight + overscan;
		const end = endPosition <= 0 ? 0 : Math.min(this.ids.length, this.indexAt(endPosition) + 1);
		return { start: Math.min(start, end), end, top: this.offset(Math.min(start, end)), bottom: this.totalHeight - this.offset(end) };
	}

	public anchor(top: number): VirtualListAnchor | null {
		if (this.ids.length === 0) return null;
		const index = Math.min(this.ids.length - 1, this.indexAt(Math.max(0, top)));
		return { id: this.ids[index], offset: top - this.offset(index) };
	}

	public position(anchor: VirtualListAnchor): number | null {
		const index = this.indices.get(anchor.id);
		return index == null ? null : this.offset(index) + anchor.offset;
	}
}
