<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.root">
	<div :class="[$style.seekbar]">
		<MkMediaRange
			v-model="rangePercent"
			:buffer="bufferedDataRatio"
		/>
	</div>

	<div :class="[$style.controlsChild, $style.controlsLeft]">
		<button class="_button" :class="$style.controlButton" @click="togglePlayPause">
			<i v-if="isPlaying" class="ti ti-player-pause"></i>
			<i v-else class="ti ti-player-play"></i>
		</button>

		<div :class="[$style.controlsChild, $style.controlsTime]">{{ hms(elapsedTimeMs) }} / {{ hms(durationMs) }}</div>
	</div>
	<div :class="[$style.controlsChild, $style.controlsCenter]">
	</div>
	<div :class="[$style.controlsChild, $style.controlsRight]">
		<button class="_button" :class="$style.controlButton" @click="toggleMute">
			<i v-if="volume === 0" class="ti ti-volume-3"></i>
			<i v-else class="ti ti-volume"></i>
		</button>
		<MkMediaRange v-model="volume"/>
		<button class="_button" :class="$style.controlButton" @click="showMenu">
			<i class="ti ti-settings"></i>
		</button>
	</div>
</div>
</template>

<script lang="ts" setup>
import { ref, shallowRef, inject, computed, watch, onBeforeUnmount } from 'vue';
import type { MenuItem } from '@/types/menu.js';
import { DI } from '@/di.js';
import { hms } from '@/filters/hms.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import hasAudio from '@/utility/media-has-audio.js';
import MkMediaRange from '@/components/MkMediaRange.vue';

const props = withDefaults(defineProps<{
	externalVolumeControl?: boolean;
}>(), {
	externalVolumeControl: false,
});

const volume = defineModel<number>('volume', { required: true });

const mediaEl = inject(DI.mkLightboxItemMediaEl, shallowRef<HTMLVideoElement | HTMLAudioElement | null>(null));
const isVideo = computed(() => mediaEl.value instanceof HTMLVideoElement);

const menuShowing = ref(false);

function showMenu(ev: PointerEvent) {
	const menu: MenuItem[] = [
		{
			type: 'switch',
			text: i18n.ts._mediaControls.loop,
			icon: 'ti ti-repeat',
			ref: loop,
		},
		{
			type: 'radio',
			text: i18n.ts._mediaControls.playbackRate,
			icon: 'ti ti-clock-play',
			ref: speed,
			options: [{
				label: '0.25x',
				value: 0.25,
			}, {
				label: '0.5x',
				value: 0.5,
			}, {
				label: '0.75x',
				value: 0.75,
			}, {
				label: '1.0x',
				value: 1,
			}, {
				label: '1.25x',
				value: 1.25,
			}, {
				label: '1.5x',
				value: 1.5,
			}, {
				label: '2.0x',
				value: 2,
			}],
		},
		...(window.document.pictureInPictureEnabled && isVideo.value ? [{
			text: i18n.ts._mediaControls.pip,
			icon: 'ti ti-picture-in-picture',
			action: togglePictureInPicture,
		}] : []),
	];

	menuShowing.value = true;
	os.popupMenu(menu, ev.currentTarget ?? ev.target, {
		align: 'right',
		onClosing: () => {
			menuShowing.value = false;
		},
	});
}

const oncePlayed = ref(false);
const isReady = ref(false);
const isPlaying = ref(false);
const isActuallyPlaying = ref(false);
const elapsedTimeMs = ref(0);
const durationMs = ref(0);
const rangePercent = computed({
	get: () => {
		return (elapsedTimeMs.value / durationMs.value) || 0;
	},
	set: (to) => {
		if (mediaEl.value == null) return;
		mediaEl.value.currentTime = to * durationMs.value / 1000;
	},
});
const speed = ref(1);
const loop = ref(false);
const bufferedEnd = ref(0);
const bufferedDataRatio = computed(() => {
	if (durationMs.value === 0) return 0;
	return bufferedEnd.value / (durationMs.value / 1000);
});

function togglePlayPause() {
	if (!isReady.value) return;

	if (isPlaying.value) {
		mediaEl.value?.pause();
	} else {
		mediaEl.value?.play().catch(err => {
			if (_DEV_) console.warn('Failed to play media:', err);
		});
	}
}

function togglePictureInPicture() {
	if (window.document.pictureInPictureElement) {
		window.document.exitPictureInPicture().catch(err => {
			if (_DEV_) console.warn('Failed to exit picture-in-picture:', err);
		});
	} else if (isVideo.value) {
		(mediaEl.value as HTMLVideoElement).requestPictureInPicture().catch(err => {
			if (_DEV_) console.warn('Failed to enter picture-in-picture:', err);
		});
	}
}

function toggleMute() {
	if (volume.value === 0) {
		volume.value = .25;
	} else {
		volume.value = 0;
	}
}

let abortController: AbortController | null = null;
let loopObserver: MutationObserver | null = null;

let elapsedTickFrameId: number | null = null;

function syncElapsedTime() {
	if (mediaEl.value == null) return;
	elapsedTimeMs.value = mediaEl.value.currentTime * 1000;
}

function elapsedTick() {
	syncElapsedTime();
	elapsedTickFrameId = window.requestAnimationFrame(elapsedTick);
}

function startElapsedTick() {
	if (elapsedTickFrameId != null) return;
	elapsedTickFrameId = window.requestAnimationFrame(elapsedTick);
}

function stopElapsedTick() {
	if (elapsedTickFrameId == null) return;
	window.cancelAnimationFrame(elapsedTickFrameId);
	elapsedTickFrameId = null;
}

function syncDuration() {
	const duration = mediaEl.value?.duration;
	durationMs.value = duration != null && Number.isFinite(duration) ? duration * 1000 : 0;
}

function syncBuffered() {
	const buffered = mediaEl.value?.buffered;
	if (buffered == null || buffered.length === 0) {
		bufferedEnd.value = 0;
		return;
	}

	let end = 0;
	for (let i = 0; i < buffered.length; i++) {
		if (buffered.end(i) > end) end = buffered.end(i);
	}
	bufferedEnd.value = end;
}

function syncReady() {
	const el = mediaEl.value;
	isReady.value = el != null && el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
}

function init() {
	const el: HTMLMediaElement | null = mediaEl.value;
	if (el == null) return;

	abortController = new AbortController();
	const signal = abortController.signal;

	const on = (type: keyof HTMLMediaElementEventMap, listener: () => void) => {
		el.addEventListener(type, listener, { signal });
	};

	on('play', () => {
		isPlaying.value = true;
		oncePlayed.value = true;
		startElapsedTick();
	});

	on('playing', () => {
		isActuallyPlaying.value = true;
		startElapsedTick();
	});

	on('waiting', () => {
		isActuallyPlaying.value = false;
		stopElapsedTick();
	});

	on('pause', () => {
		isPlaying.value = false;
		isActuallyPlaying.value = false;
		stopElapsedTick();
	});

	on('ended', () => {
		oncePlayed.value = false;
		isPlaying.value = false;
		isActuallyPlaying.value = false;
		stopElapsedTick();
		syncElapsedTime();
	});

	on('timeupdate', syncElapsedTime);
	on('seeking', syncElapsedTime);
	on('seeked', () => {
		syncElapsedTime();
		syncBuffered();
	});

	on('durationchange', syncDuration);
	on('loadstart', syncReady);
	on('canplay', syncReady);
	on('canplaythrough', syncReady);
	on('loadedmetadata', () => {
		syncDuration();
		syncBuffered();
		syncReady();
	});
	on('progress', syncBuffered);
	on('emptied', () => {
		isReady.value = false;
		isPlaying.value = false;
		isActuallyPlaying.value = false;
		oncePlayed.value = false;
		stopElapsedTick();
		syncDuration();
		syncBuffered();
		syncElapsedTime();
	});

	if (!props.externalVolumeControl) {
		on('volumechange', () => {
			const to = el.muted ? 0 : el.volume;
			if (volume.value !== to) volume.value = to;
		});
	}

	on('ratechange', () => {
		if (speed.value !== el.playbackRate) speed.value = el.playbackRate;
	});

	loopObserver = new MutationObserver(() => {
		if (loop.value !== el.loop) loop.value = el.loop;
	});
	loopObserver.observe(el, { attributes: true, attributeFilter: ['loop'] });

	syncReady();
	syncDuration();
	syncBuffered();
	syncElapsedTime();
	loop.value = el.loop;
	speed.value = el.playbackRate;
	isPlaying.value = !el.paused;
	if (!el.paused) {
		oncePlayed.value = true;
		startElapsedTick();
	}

	if (!props.externalVolumeControl) {
		el.volume = volume.value;
	}

	if (isVideo.value) {
		hasAudio(el).then(had => {
			if (signal.aborted) return;
			if (!had) {
				el.loop = el.muted = true;
				el.play().catch(err => {
					if (_DEV_) console.warn('Failed to play media:', err);
				});
			}
		});
	}
}

function teardown() {
	abortController?.abort();
	abortController = null;
	loopObserver?.disconnect();
	loopObserver = null;
	stopElapsedTick();
	isReady.value = false;
	isActuallyPlaying.value = false;
	oncePlayed.value = false;
}

watch(volume, (to) => {
	if (props.externalVolumeControl) return;
	if (mediaEl.value == null) return;
	mediaEl.value.volume = to;
	mediaEl.value.muted = to === 0;
});

watch(speed, (to) => {
	if (mediaEl.value == null) return;
	mediaEl.value.playbackRate = to;
});

watch(loop, (to) => {
	if (mediaEl.value == null) return;
	mediaEl.value.loop = to;
});

watch(mediaEl, () => {
	teardown();
	init();
}, { immediate: true });

onBeforeUnmount(teardown);

defineExpose({
	isPlaying,
	isReady,
	isActuallyPlaying,
});
</script>

<style lang="scss" module>
.root {
	display: grid;
	grid-template-areas:
		"seekbar seekbar seekbar"
		"left center right";
	grid-template-columns: auto 1fr auto;
	align-items: center;
	gap: 4px 8px;
	width: 100%;
}

.controlsChild {
	display: flex;
	align-items: center;
	gap: 4px;
}

.controlsLeft {
	grid-area: left;
}

.controlsRight {
	grid-area: right;
}

.controlsCenter {
	grid-area: center;
	justify-content: center;
}

.controlButton {
	padding: 6px;
	border-radius: 4px;

	&:disabled {
		opacity: 0.7;
		cursor: not-allowed;
	}

	&:hover {
		background-color: var(--MI_THEME-accentedBg);
		color: var(--MI_THEME-accent);
	}

	&:focus-visible {
		outline: none;
	}
}

.controlsTime {
	font-size: 85%;
}

.seekbar {
	grid-area: seekbar;
}
</style>
