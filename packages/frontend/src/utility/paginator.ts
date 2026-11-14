/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ref, shallowRef, triggerRef } from 'vue';
import * as Misskey from 'misskey-js';
import type { ComputedRef, Ref, ShallowRef, UnwrapRef } from 'vue';
import { misskeyApi } from '@/utility/misskey-api.js';

const MAX_ITEMS = 30;
const MAX_QUEUE_ITEMS = 100;
const FIRST_FETCH_LIMIT = 15;
const SECOND_FETCH_LIMIT = 30;

export type MisskeyEntity = {
	id: string;
	createdAt: string;
	_shouldInsertAd_?: boolean;
};

type AbsEndpointType = {
	req: unknown;
	res: unknown;
};

type FilterByEpRes<E extends Record<string, AbsEndpointType>> = {
	[K in keyof E]: E[K]['res'] extends Array<{ id: string }> ? K : never
}[keyof E];
export type PaginatorCompatibleEndpointPaths = FilterByEpRes<Misskey.Endpoints>;
export type PaginatorCompatibleEndpoints = {
	[K in PaginatorCompatibleEndpointPaths]: Misskey.Endpoints[K];
};

export type ExtractorFunction<P extends IPaginator, T> = (item: UnwrapRef<P['items']>[number]) => T;

type FetchNewerOptions = {
	toQueue?: boolean | (() => boolean);
	trim?: boolean;
};

function getNewItems<T extends MisskeyEntity>(items: T[], existingItems: readonly Pick<MisskeyEntity, 'id'>[]): T[] {
	const ids = new Set(existingItems.map(item => item.id));
	return items.filter(item => {
		if (ids.has(item.id)) return false;
		ids.add(item.id);
		return true;
	});
}

export interface IPaginator<T = unknown, _T = T & MisskeyEntity> {
	items: Ref<_T[]> | ShallowRef<_T[]>;
	queuedAheadItemsCount: Ref<number>;
	fetching: Ref<boolean>;
	fetchingOlder: Ref<boolean>;
	fetchingNewer: Ref<boolean>;
	canFetchOlder: Ref<boolean>;
	canFetchNewer: Ref<boolean>;
	canSearch: boolean;
	error: Ref<boolean>;
	computedParams: ComputedRef<Misskey.Endpoints[PaginatorCompatibleEndpointPaths]['req'] | null | undefined> | null;
	initialId: MisskeyEntity['id'] | null;
	initialDate: number | null;
	initialDirection: 'newer' | 'older';
	noPaging: boolean;
	searchQuery: Ref<null | string>;
	order: Ref<'newest' | 'oldest'>;

	init(): Promise<void>;
	reload(): Promise<void>;
	fetchOlder(): Promise<void>;
	fetchNewer(options?: FetchNewerOptions): Promise<void>;
	trim(trigger?: boolean): void;
	unshiftItems(newItems: (_T)[]): void;
	pushItems(oldItems: (_T)[]): void;
	prepend(item: _T): void;
	enqueue(item: _T): void;
	releaseQueue(): void;
	removeItem(id: string): void;
	updateItem(id: string, updater: (item: _T) => _T): void;
}

export class Paginator<
	Endpoint extends PaginatorCompatibleEndpointPaths,
	E extends PaginatorCompatibleEndpoints[Endpoint] = PaginatorCompatibleEndpoints[Endpoint],
	T extends E['res'][number] & MisskeyEntity = E['res'][number] & MisskeyEntity,
	SRef extends boolean = false,
> implements IPaginator {
	public items: SRef extends true ? ShallowRef<T[]> : Ref<T[]>;

	public queuedAheadItemsCount = ref(0);
	public fetching = ref(true);
	public fetchingOlder = ref(false);
	public fetchingNewer = ref(false);
	public canFetchOlder = ref(false);
	public canFetchNewer = ref(false);
	public canSearch = false;
	public error = ref(false);
	private endpoint: Endpoint;
	private limit: number;
	private params: E['req'] | (() => E['req']);
	public computedParams: ComputedRef<E['req'] | null | undefined> | null;
	public initialId: MisskeyEntity['id'] | null = null;
	public initialDate: number | null = null;

	public initialDirection: 'newer' | 'older';

	private offsetMode: boolean;
	public noPaging: boolean;
	public searchQuery = ref<null | string>('');
	private searchParamName: keyof E['req'] | 'search';
	private canFetchDetection: 'safe' | 'limit' | null = null;
	private aheadQueue: T[] = [];
	private useShallowRef: SRef;
	private requestGeneration = 0;
	private requestController = new AbortController();
	private fetchNewerPromise: Promise<void> | null = null;

	public order: Ref<'newest' | 'oldest'>;

	constructor(endpoint: Endpoint, props: {
		limit?: number;
		params?: E['req'] | (() => E['req']);
		computedParams?: ComputedRef<E['req'] | null | undefined>;

		noPaging?: boolean;

		offsetMode?: boolean;

		initialId?: MisskeyEntity['id'];
		initialDate?: number | null;
		initialDirection?: 'newer' | 'older';

		order?: 'newest' | 'oldest';

		canFetchDetection?: 'safe' | 'limit';

		useShallowRef?: SRef;

		canSearch?: boolean;
		searchParamName?: keyof E['req'];
	}) {
		this.endpoint = endpoint;
		this.useShallowRef = (props.useShallowRef ?? false) as SRef;
		if (this.useShallowRef) {
			this.items = shallowRef<T[]>([]);
		} else {
			this.items = ref<T[]>([]) as Ref<T[]>;
		}

		this.limit = props.limit ?? FIRST_FETCH_LIMIT;
		this.params = props.params ?? {};
		this.computedParams = props.computedParams ?? null;
		this.order = ref(props.order ?? 'newest');
		this.initialId = props.initialId ?? null;
		this.initialDate = props.initialDate ?? null;
		this.initialDirection = props.initialDirection ?? 'older';
		this.canFetchDetection = props.canFetchDetection ?? null;
		this.noPaging = props.noPaging ?? false;
		this.offsetMode = props.offsetMode ?? false;
		this.canSearch = props.canSearch ?? false;
		this.searchParamName = props.searchParamName ?? 'search';

		this.getNewestId = this.getNewestId.bind(this);
		this.getOldestId = this.getOldestId.bind(this);
		this.init = this.init.bind(this);
		this.reload = this.reload.bind(this);
		this.fetchOlder = this.fetchOlder.bind(this);
		this.fetchNewer = this.fetchNewer.bind(this);
		this.unshiftItems = this.unshiftItems.bind(this);
		this.pushItems = this.pushItems.bind(this);
		this.prepend = this.prepend.bind(this);
		this.enqueue = this.enqueue.bind(this);
		this.releaseQueue = this.releaseQueue.bind(this);
		this.removeItem = this.removeItem.bind(this);
		this.updateItem = this.updateItem.bind(this);
	}

	private getNewestId(): string | null | undefined {
		if (this.aheadQueue.length > 0) {
			return this.aheadQueue.map(x => x.id).sort().at(-1);
		}
		return this.items.value.map(x => x.id).sort().at(-1);
	}

	private getOldestId(): string | null | undefined {
		return this.items.value.map(x => x.id).sort().at(0);
	}

	public async init(): Promise<void> {
		const generation = ++this.requestGeneration;
		this.requestController.abort();
		this.requestController = new AbortController();
		this.items.value = [];
		this.aheadQueue = [];
		this.queuedAheadItemsCount.value = 0;
		this.fetchNewerPromise = null;
		this.fetchingOlder.value = false;
		this.fetchingNewer.value = false;
		this.canFetchOlder.value = false;
		this.canFetchNewer.value = false;
		this.fetching.value = true;

		const data: E['req'] = {
			...(typeof this.params === 'function' ? this.params() : this.params),
			...(this.computedParams ? this.computedParams.value : {}),
			...(this.searchQuery.value != null && this.searchQuery.value.trim() !== '' ? { [this.searchParamName]: this.searchQuery.value } : {}),
			limit: this.limit ?? FIRST_FETCH_LIMIT,
			allowPartial: true,
			...((this.initialId == null && this.initialDate == null) && this.initialDirection === 'newer' ? {
				sinceId: '0',
			} : this.initialDirection === 'newer' ? {
				sinceId: this.initialId ?? undefined,
				sinceDate: this.initialDate ?? undefined,
			} : (this.initialId || this.initialDate) && this.initialDirection === 'older' ? {
				untilId: this.initialId ?? undefined,
				untilDate: this.initialDate ?? undefined,
			} : {}),
		};

		const apiRes = (await misskeyApi(this.endpoint, data, undefined, this.requestController.signal).catch(() => null)) as T[] | null;

		if (generation !== this.requestGeneration) return;

		if (apiRes == null) {
			this.error.value = true;
			this.fetching.value = false;
			return;
		}

		if ((this.initialId || this.initialDate) && this.initialDirection === 'newer') {
			apiRes.reverse();
		}

		for (let i = 0; i < apiRes.length; i++) {
			const item = apiRes[i];
			if (i === 3) item._shouldInsertAd_ = true;
		}

		this.pushItems(apiRes);

		if (this.canFetchDetection === 'limit') {
			if (apiRes.length < FIRST_FETCH_LIMIT) {
				(this.initialDirection === 'older' ? this.canFetchOlder : this.canFetchNewer).value = false;
			} else {
				(this.initialDirection === 'older' ? this.canFetchOlder : this.canFetchNewer).value = true;
			}
		} else if (this.canFetchDetection === 'safe' || this.canFetchDetection == null) {
			if (apiRes.length === 0 || this.noPaging) {
				(this.initialDirection === 'older' ? this.canFetchOlder : this.canFetchNewer).value = false;
			} else {
				(this.initialDirection === 'older' ? this.canFetchOlder : this.canFetchNewer).value = true;
			}
		}

		this.error.value = false;
		this.fetching.value = false;
	}

	public reload(): Promise<void> {
		return this.init();
	}

	public async fetchOlder(): Promise<void> {
		if (!this.canFetchOlder.value || this.fetching.value || this.fetchingOlder.value || this.items.value.length === 0) return;
		const generation = this.requestGeneration;
		this.fetchingOlder.value = true;

		const data: E['req'] = {
			...(typeof this.params === 'function' ? this.params() : this.params),
			...(this.computedParams ? this.computedParams.value : {}),
			...(this.searchQuery.value != null && this.searchQuery.value.trim() !== '' ? { [this.searchParamName]: this.searchQuery.value } : {}),
			limit: SECOND_FETCH_LIMIT,
			...(this.offsetMode ? {
				offset: this.items.value.length,
			} : {
				untilId: this.getOldestId(),
			}),
		};

		const apiRes = (await misskeyApi<T[]>(this.endpoint, data, undefined, this.requestController.signal).catch(_ => {
			return null;
		})) as T[] | null;

		if (generation !== this.requestGeneration) return;

		this.fetchingOlder.value = false;

		if (apiRes == null) {
			return;
		}

		for (let i = 0; i < apiRes.length; i++) {
			const item = apiRes[i];
			if (i === 10) item._shouldInsertAd_ = true;
		}

		if (this.order.value === 'oldest') {
			this.unshiftItems(apiRes.toReversed(), false);
		} else {
			this.pushItems(apiRes);
		}

		if (this.canFetchDetection === 'limit') {
			if (apiRes.length < FIRST_FETCH_LIMIT) {
				this.canFetchOlder.value = false;
			} else {
				this.canFetchOlder.value = true;
			}
		} else if (this.canFetchDetection === 'safe' || this.canFetchDetection == null) {
			if (apiRes.length === 0) {
				this.canFetchOlder.value = false;
			} else {
				this.canFetchOlder.value = true;
			}
		}
	}

	public fetchNewer(options: FetchNewerOptions = {}): Promise<void> {
		if (this.fetching.value) return Promise.resolve();
		if (this.fetchNewerPromise != null) return this.fetchNewerPromise;

		const generation = this.requestGeneration;
		this.fetchingNewer.value = true;
		this.fetchNewerPromise = this.fetchNewerPage(options, generation).finally(() => {
			if (generation !== this.requestGeneration) return;
			this.fetchNewerPromise = null;
			this.fetchingNewer.value = false;
		});
		return this.fetchNewerPromise;
	}

	private async fetchNewerPage(options: FetchNewerOptions, generation: number): Promise<void> {
		const data: E['req'] = {
			...(typeof this.params === 'function' ? this.params() : this.params),
			...(this.computedParams ? this.computedParams.value : {}),
			...(this.searchQuery.value != null && this.searchQuery.value.trim() !== '' ? { [this.searchParamName]: this.searchQuery.value } : {}),
			limit: SECOND_FETCH_LIMIT,
			...(this.offsetMode ? {
				offset: this.items.value.length,
			} : {
				sinceId: this.getNewestId(),
			}),
		};

		const apiRes = (await misskeyApi<T[]>(this.endpoint, data, undefined, this.requestController.signal).catch(_ => {
			return null;
		})) as T[] | null;

		if (generation !== this.requestGeneration) return;

		if (apiRes == null || apiRes.length === 0) {
			this.canFetchNewer.value = false;
			return;
		}

		if (typeof options.toQueue === 'function' ? options.toQueue() : options.toQueue) {
			this.enqueueItems(apiRes.toReversed());
		} else {
			if (this.order.value === 'oldest') {
				this.pushItems(apiRes);
			} else {
				this.unshiftItems(apiRes.toReversed(), options.trim ?? false);
			}
		}

		if (this.canFetchDetection === 'limit') {
			if (apiRes.length < FIRST_FETCH_LIMIT) {
				this.canFetchNewer.value = false;
			} else {
				this.canFetchNewer.value = true;
			}
		}
	}

	public trim(trigger = true): void {
		if (this.items.value.length >= MAX_ITEMS) this.canFetchOlder.value = true;
		this.items.value = this.items.value.slice(0, MAX_ITEMS);
		if (this.useShallowRef && trigger) triggerRef(this.items);
	}

	public unshiftItems(newItems: T[], trim = true): void {
		const uniqueItems = getNewItems(newItems, this.items.value);
		if (uniqueItems.length === 0) return;
		this.items.value.unshift(...uniqueItems);
		if (trim) this.trim(true);
		if (this.useShallowRef) triggerRef(this.items);
	}

	public pushItems(oldItems: T[]): void {
		const uniqueItems = getNewItems(oldItems, this.items.value);
		if (uniqueItems.length === 0) return;
		this.items.value.push(...uniqueItems);
		if (this.useShallowRef) triggerRef(this.items);
	}

	public prepend(item: T): void {
		if (this.items.value.some(x => x.id === item.id)) return;
		this.items.value.unshift(item);
		this.trim(false);
		if (this.useShallowRef) triggerRef(this.items);
	}

	public enqueue(item: T): void {
		this.enqueueItems([item]);
	}

	private enqueueItems(items: T[]): void {
		const uniqueItems = getNewItems(items, [...this.items.value, ...this.aheadQueue]);
		if (uniqueItems.length === 0) return;
		this.aheadQueue = [...uniqueItems, ...this.aheadQueue].slice(0, MAX_QUEUE_ITEMS);
		this.queuedAheadItemsCount.value = this.aheadQueue.length;
	}

	public releaseQueue(): void {
		if (this.aheadQueue.length === 0) return;
		this.unshiftItems(this.aheadQueue);
		this.aheadQueue = [];
		this.queuedAheadItemsCount.value = 0;
	}

	public removeItem(id: string): void {
		const index = this.items.value.findIndex(x => x.id === id);
		if (index !== -1) {
			this.items.value.splice(index, 1);
			if (this.useShallowRef) triggerRef(this.items);
		}
	}

	public updateItem(id: string, updater: (item: T) => T): void {
		const index = this.items.value.findIndex(x => x.id === id);
		if (index !== -1) {
			const item = this.items.value[index]!;
			this.items.value[index] = updater(item);
			if (this.useShallowRef) triggerRef(this.items);
		}
	}
}
