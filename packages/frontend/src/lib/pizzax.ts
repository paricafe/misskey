/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { customRef, ref, watch, onScopeDispose } from 'vue';
import type { Ref } from 'vue';
import { $i } from '@/i.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { get, set } from '@/utility/idb-proxy.js';
import { store } from '@/store.js';
import { TypedBroadcastChannel as BroadcastChannel } from '@/utility/typed-broadcast-channel.js';
import { deepClone } from '@/utility/clone.js';
import { deepMerge } from '@/utility/merge.js';

type StateDef = Record<string, {
	where: 'account' | 'device' | 'deviceAccount';
	default: any;
}>;

type State<T extends StateDef> = { [K in keyof T]: T[K]['default']; };
type ReactiveState<T extends StateDef> = { [K in keyof T]: Ref<T[K]['default']>; };

type ArrayElement<A> = A extends readonly (infer T)[] ? T : never;

type PizzaxChannelMessage<T extends StateDef> = {
	where: 'device' | 'deviceAccount';
	key: keyof T;
	value: T[keyof T]['default'];
	userId?: string;
};

export class Pizzax<T extends StateDef> {
	public readonly ready: Promise<void>;
	public readonly loaded: Promise<void>;

	public readonly key: string;
	public readonly deviceStateKeyName: `pizzax::${this['key']}`;
	public readonly deviceAccountStateKeyName: `pizzax::${this['key']}::${string}` | '';
	public readonly registryCacheKeyName: `pizzax::${this['key']}::cache::${string}` | '';

	public readonly def: T;

	public readonly s: State<T>;

	public readonly r: ReactiveState<T>;

	private pizzaxChannel: BroadcastChannel<PizzaxChannelMessage<T>>;

	private currentIdbJob: Promise<unknown> = Promise.resolve();
	private addIdbSetJob<T>(job: () => Promise<T>) {
		const promise = this.currentIdbJob.then(job, err => {
			console.error('Pizzax failed to save data to idb!', err);
			return job();
		});
		this.currentIdbJob = promise;
		return promise;
	}

	constructor(key: string, def: T) {
		this.key = key;
		this.deviceStateKeyName = `pizzax::${key}`;
		this.deviceAccountStateKeyName = $i ? `pizzax::${key}::${$i.id}` : '';
		this.registryCacheKeyName = $i ? `pizzax::${key}::cache::${$i.id}` : '';
		this.def = def;

		this.pizzaxChannel = new BroadcastChannel(`pizzax::${key}`);

		this.s = {} as State<T>;
		this.r = {} as ReactiveState<T>;

		for (const [k, v] of Object.entries(def) as [keyof T, T[keyof T]['default']][]) {
			const defaultValue = deepClone(v.default);
			this.s[k] = defaultValue;
			this.r[k] = ref(defaultValue);
		}

		this.ready = this.init();
		this.loaded = this.ready.then(() => this.load());
	}

	private isPureObject(value: unknown): value is Record<string | number | symbol, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	private mergeState<X>(value: X, def: X): X {
		if (this.isPureObject(value) && this.isPureObject(def)) {
			const merged = deepMerge<Record<PropertyKey, unknown>>(value, def);

			if (_DEV_) console.log('Merging state. Incoming: ', value, ' Default: ', def, ' Result: ', merged);

			return merged as X;
		}
		return value;
	}

	private async init(): Promise<void> {
		await this.migrate();

		const deviceState: State<T> = await get(this.deviceStateKeyName) || {};
		const deviceAccountState = $i ? await get(this.deviceAccountStateKeyName) || {} : {};
		const registryCache = $i ? await get(this.registryCacheKeyName) || {} : {};

		for (const [k, v] of Object.entries(this.def) as [keyof T, T[keyof T]['default']][]) {
			if (v.where === 'device' && Object.prototype.hasOwnProperty.call(deviceState, k)) {
				this.r[k].value = this.s[k] = this.mergeState<T[keyof T]['default']>(deviceState[k], v.default);
			} else if (v.where === 'account' && $i && Object.prototype.hasOwnProperty.call(registryCache, k)) {
				this.r[k].value = this.s[k] = this.mergeState<T[keyof T]['default']>(registryCache[k], v.default);
			} else if (v.where === 'deviceAccount' && Object.prototype.hasOwnProperty.call(deviceAccountState, k)) {
				this.r[k].value = this.s[k] = this.mergeState<T[keyof T]['default']>(deviceAccountState[k], v.default);
			} else {
				this.r[k].value = this.s[k] = deepClone(v.default);
			}
		}

		this.pizzaxChannel.addEventListener('message', (ev) => {
			const { where, key, value, userId } = ev.data;
			if (where === 'deviceAccount' && (!$i || userId !== $i.id)) return;
			this.r[key].value = this.s[key] = value;
		});
	}

	private load(): Promise<void> {
		return new Promise((resolve, reject) => {
			if ($i) {
				window.setTimeout(async () => {
					await store.ready;

					misskeyApi('i/registry/get-all', { scope: ['client', this.key] })
						.then(kvs => {
							const cache: Partial<T> = {};
							for (const [k, v] of Object.entries(this.def) as [keyof T, T[keyof T]['default']][]) {
								if (v.where === 'account') {
									if (Object.prototype.hasOwnProperty.call(kvs, k)) {
										this.r[k].value = this.s[k] = (kvs as Partial<T>)[k];
										cache[k] = (kvs as Partial<T>)[k];
									} else {
										this.r[k].value = this.s[k] = deepClone(v.default);
									}
								}
							}

							return set(this.registryCacheKeyName, cache);
						})
						.then(() => resolve());
				}, 1);
			} else {
				resolve();
			}
		});
	}

	public set<K extends keyof T>(key: K, value: T[K]['default']): Promise<void> {
		const rawValue = deepClone(value);

		this.r[key].value = this.s[key] = rawValue;

		return this.addIdbSetJob(async () => {
			switch (this.def[key].where) {
				case 'device': {
					this.pizzaxChannel.postMessage({
						where: 'device',
						key,
						value: rawValue,
					});
					const deviceState = await get(this.deviceStateKeyName) || {};
					deviceState[key] = rawValue;
					await set(this.deviceStateKeyName, deviceState);
					break;
				}
				case 'deviceAccount': {
					if ($i == null) break;
					this.pizzaxChannel.postMessage({
						where: 'deviceAccount',
						key,
						value: rawValue,
						userId: $i.id,
					});
					const deviceAccountState = await get(this.deviceAccountStateKeyName) || {};
					deviceAccountState[key] = rawValue;
					await set(this.deviceAccountStateKeyName, deviceAccountState);
					break;
				}
				case 'account': {
					if ($i == null) break;
					const cache = await get(this.registryCacheKeyName) || {};
					cache[key] = rawValue;
					await set(this.registryCacheKeyName, cache);
					await misskeyApi('i/registry/set', {
						scope: ['client', this.key],
						key: key.toString(),
						value: rawValue,
					});
					break;
				}
			}
		});
	}

	public push<K extends keyof T>(key: K, value: ArrayElement<T[K]['default']>): void {
		const currentState = this.s[key];
		this.set(key, [...currentState, value]);
	}

	public reset(key: keyof T) {
		const defaultValue = deepClone(this.def[key].default);
		this.set(key, defaultValue);
		return defaultValue;
	}

	public model<K extends keyof T, R = T[K]['default']>(
		key: K,
	): Ref<R>;
	public model<K extends keyof T, R extends Exclude<any, T[K]['default']>>(
		key: K,
		getter: (v: T[K]['default']) => R,
		setter: (v: R) => T[K]['default'],
	): Ref<R>;

	public model<K extends keyof T, R>(
		key: K,
		getter?: (v: T[K]['default']) => R,
		setter?: (v: R) => T[K]['default'],
	): Ref<R> {
		return customRef<R>((track, trigger) => {
			const watchStop = watch(this.r[key], () => {
				trigger();
			});

			onScopeDispose(() => {
				watchStop();
			}, true);

			return {
				get: () => {
					track();
					return (getter != null ? getter(this.s[key]) : this.s[key]) as R;
				},
				set: (value) => {
					const val = setter != null ? setter(value) : value;
					this.set(key, val as T[K]['default']);
				},
			};
		});
	}

	private async migrate() {
		const deviceState = localStorage.getItem(this.deviceStateKeyName);
		if (deviceState) {
			await set(this.deviceStateKeyName, JSON.parse(deviceState));
			localStorage.removeItem(this.deviceStateKeyName);
		}

		const deviceAccountState = $i && localStorage.getItem(this.deviceAccountStateKeyName);
		if ($i && deviceAccountState) {
			await set(this.deviceAccountStateKeyName, JSON.parse(deviceAccountState));
			localStorage.removeItem(this.deviceAccountStateKeyName);
		}

		const registryCache = $i && localStorage.getItem(this.registryCacheKeyName);
		if ($i && registryCache) {
			await set(this.registryCacheKeyName, JSON.parse(registryCache));
			localStorage.removeItem(this.registryCacheKeyName);
		}
	}
}
