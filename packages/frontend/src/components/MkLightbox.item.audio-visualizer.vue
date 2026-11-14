<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.root">
	<audio
		:key="audioElKey"
		ref="audioEl"
		preload="metadata"
		:crossorigin="crossOriginMode === 'anonymous' ? 'anonymous' : undefined"
		:src="content.url"
		@loadedmetadata="onLoadedMetadata"
		@error="onLoadError"
	></audio>
	<canvas
		ref="canvasEl"
		width="1600"
		height="900"
		data-gallery-click-action="media"
		:class="$style.visualizer"
		v-bind="$attrs"
	></canvas>
	<div v-if="!isPlaying" :class="$style.playIconWrapper">
		<div :class="$style.playIcon">
			<i class="ti ti-player-play"></i>
		</div>
	</div>
</div>
</template>

<script setup lang="ts">
import { useTemplateRef, shallowRef, ref, computed, watch, onBeforeUnmount } from 'vue';
import * as Misskey from 'misskey-js';
import tinycolor from 'tinycolor2';
import type { Content } from '@/components/MkLightbox.item.vue';
import { i18n } from '@/i18n.js';
import { themeManager } from '@/theme.js';
import { prefer } from '@/preferences.js';

defineOptions({
	inheritAttrs: false,
});

const props = defineProps<{
	content: Content;
	user?: Misskey.entities.User | null;
	isPlaying: boolean;
	volume: number;
}>();

const emit = defineEmits<{
	(ev: 'loadedmetadata'): void;
}>();

const audioEl = useTemplateRef('audioEl');
const canvasEl = useTemplateRef('canvasEl');
const canvasCtx = computed(() => canvasEl.value?.getContext('2d') ?? null);

const fileUser = computed(() => props.content.file?.user ?? props.user);

const BAND_COUNT = 96;
const BASE_HALF_HEIGHT_RATIO = 0.003;

const FFT_SIZE = 4096;
const BIN_COUNT = FFT_SIZE / 2;

const MIN_FREQ = 20;
const MAX_FREQ = 16000;

const SPECTRUM_TILT_COEFFICIENT = 1.085;

const BEAT_BAND_COUNT = 36;
const BEAT_MIN_FREQ = 30;
const BEAT_MAX_FREQ = 300;

const WAVE_ATTACK_TAU = 0.01;
const WAVE_RELEASE_TAU = 0.015;
const CONTRAST_EXPONENT = 1.9;
const WAVE_GAIN_HALF_HEIGHT_RATIO = 0.3;
const BAR_THICKNESS_FACTOR = 0.5;

const LEVEL_TAU = 0.3;
const LEVEL_SCALE = 0.1;
const BEAT_ATTACK_TAU = 0.012;
const BEAT_FALL_TAU = 0.11;
const BEAT_BASELINE_TAU = 0.7;
const BEAT_SENSITIVITY = 3;
const BEAT_RELEASE_TAU = 0.18;
const BEAT_SCALE = 0.16;

const AVATAR_SIZE_RATIO = 0.36;

const motionDamp = prefer.s.animation ? 1 : 0.3;

const freqArray = new Uint8Array(BIN_COUNT);
const bandStart = new Uint16Array(BAND_COUNT);
const bandEnd = new Uint16Array(BAND_COUNT);
const beatBandStart = new Uint16Array(BEAT_BAND_COUNT);
const beatBandEnd = new Uint16Array(BEAT_BAND_COUNT);
const bandTilt = new Float32Array(BAND_COUNT);
const rawLevels = new Float32Array(BAND_COUNT);
const levels = new Float32Array(BAND_COUNT);
const beatRawLevels = new Float32Array(BEAT_BAND_COUNT);
const pointsX = new Float64Array(BAND_COUNT);
const topPointsY = new Float64Array(BAND_COUNT);
const bottomPointsY = new Float64Array(BAND_COUNT);

type AnalysisRange = { floor: number; ceil: number };
const waveRange: AnalysisRange = { floor: 0, ceil: 0 };
const beatRange: AnalysisRange = { floor: 0, ceil: 0 };
let levelEnv = 0;
let energyEnv = 0;
let energyBaseline = 0;
let beatEnv = 0;

function getAudioVisualizerBarWidth(canvasWidth: number, barCount: number, thicknessFactor: number) {
	return (canvasWidth / barCount) * thicknessFactor;
}

function writeLogarithmicFrequencyBands(options: {
	fftSize: number;
	sampleRate: number;
	minFrequency: number;
	maxFrequency: number;
	starts: Uint16Array;
	ends: Uint16Array;
}) {
	const bandCount = options.starts.length;
	const binCount = options.fftSize / 2;
	const maxFrequency = Math.min(options.maxFrequency, options.sampleRate / 2);
	const frequencyRatio = maxFrequency / options.minFrequency;
	const toBin = (frequency: number) => frequency * options.fftSize / options.sampleRate;

	for (let i = 0; i < bandCount; i++) {
		const lowFrequency = options.minFrequency * Math.pow(frequencyRatio, i / bandCount);
		const highFrequency = options.minFrequency * Math.pow(frequencyRatio, (i + 1) / bandCount);
		const start = Math.min(Math.max(Math.floor(toBin(lowFrequency)), 0), binCount - 1);
		const end = Math.min(Math.max(Math.ceil(toBin(highFrequency)), start + 1), binCount);
		options.starts[i] = start;
		options.ends[i] = end;
	}
}

function writeSpectrumTilt(options: {
	sampleRate: number;
	minFrequency: number;
	maxFrequency: number;
	tilt: Float32Array;
}) {
	const bandCount = options.tilt.length;
	const maxFrequency = Math.min(options.maxFrequency, options.sampleRate / 2);
	const frequencyRatio = maxFrequency / options.minFrequency;
	const pivotFrequency = Math.sqrt(options.minFrequency * maxFrequency);

	for (let i = 0; i < bandCount; i++) {
		const centerFrequency = options.minFrequency * Math.pow(frequencyRatio, (i + 0.5) / bandCount);
		options.tilt[i] = Math.pow(SPECTRUM_TILT_COEFFICIENT, Math.log2(centerFrequency / pivotFrequency));
	}
}

function writeFrequencyBandLevels(options: {
	frequencyData: Uint8Array;
	starts: Uint16Array;
	ends: Uint16Array;
	levels: Float32Array;
	tilt?: Float32Array;
}) {
	const bandCount = options.levels.length;

	for (let i = 0; i < bandCount; i++) {
		let max = 0;
		let total = 0;
		for (let bin = options.starts[i]; bin < options.ends[i]; bin++) {
			const value = options.frequencyData[bin];
			total += value;
			if (value > max) max = value;
		}
		const binCount = options.ends[i] - options.starts[i];
		const level = (max * 0.7 + (total / binCount) * 0.3) / 255;
		options.levels[i] = options.tilt == null ? level : Math.min(level * options.tilt[i], 1);
	}

	let previous = options.levels[0];
	let sum = 0;
	let min = 1;
	let peak = 0;
	for (let i = 0; i < bandCount; i++) {
		const current = options.levels[i];
		const next = i + 1 < bandCount ? options.levels[i + 1] : current;
		const smoothed = (previous + current * 3 + next) / 5;
		options.levels[i] = smoothed;
		previous = current;

		sum += smoothed;
		if (smoothed < min) min = smoothed;
		if (smoothed > peak) peak = smoothed;
	}

	return { min, peak, mean: sum / bandCount };
}

function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number) {
	return ((value - inMin) / (inMax - inMin)) * (outMax - outMin) + outMin;
}

function setupBands(sampleRate: number) {
	writeLogarithmicFrequencyBands({
		fftSize: FFT_SIZE,
		sampleRate,
		minFrequency: MIN_FREQ,
		maxFrequency: MAX_FREQ,
		starts: bandStart,
		ends: bandEnd,
	});
	writeSpectrumTilt({
		sampleRate,
		minFrequency: MIN_FREQ,
		maxFrequency: MAX_FREQ,
		tilt: bandTilt,
	});
	writeLogarithmicFrequencyBands({
		fftSize: FFT_SIZE,
		sampleRate,
		minFrequency: BEAT_MIN_FREQ,
		maxFrequency: BEAT_MAX_FREQ,
		starts: beatBandStart,
		ends: beatBandEnd,
	});
}

function resetAnalysis() {
	levels.fill(0);
	waveRange.floor = 0;
	waveRange.ceil = 0;
	beatRange.floor = 0;
	beatRange.ceil = 0;
	levelEnv = 0;
	energyEnv = 0;
	energyBaseline = 0;
	beatEnv = 0;
}

function approach(current: number, target: number, tau: number, dt: number) {
	return current + (target - current) * (1 - Math.exp(-dt / tau));
}

const RANGE_FLOOR_FALL_TAU = 0.25;
const RANGE_FLOOR_RISE_TAU = 4;
const RANGE_CEIL_FALL_TAU = 1.4;
const MIN_RANGE_SPAN = 0.14;

function updateRange(range: AnalysisRange, frameMin: number, framePeak: number, dt: number) {
	range.floor = approach(range.floor, frameMin, frameMin < range.floor ? RANGE_FLOOR_FALL_TAU : RANGE_FLOOR_RISE_TAU, dt);
	range.ceil = framePeak > range.ceil ? framePeak : approach(range.ceil, Math.max(framePeak, range.floor + MIN_RANGE_SPAN), RANGE_CEIL_FALL_TAU, dt);
	return Math.max(range.ceil - range.floor, MIN_RANGE_SPAN);
}

const accentColorHue = tinycolor(themeManager.currentCompiledTheme!.accent).toHsl().h;

const avatarImage = shallowRef<HTMLImageElement | null>(null);

let audioCtx: AudioContext | null = null;
let audioSource: MediaElementAudioSourceNode | null = null;
let analyserNode: AnalyserNode | null = null;
let gainNode: GainNode | null = null;
let abortController: AbortController | null = null;

let isVisualizerAvailable = true;

function isSameOrigin(url: string) {
	try {
		return new URL(url, window.location.href).origin === window.location.origin;
	} catch {
		return false;
	}
}

const isSameOriginContent = computed(() => isSameOrigin(props.content.url));
const corsFailedUrl = ref<string | null>(null);
let resumeAfterReloadUrl: string | null = null;

const crossOriginMode = computed<'anonymous' | 'none'>(() => (isSameOriginContent.value || corsFailedUrl.value === props.content.url) ? 'none' : 'anonymous');
const canUseAudioGraph = computed(() => isSameOriginContent.value || crossOriginMode.value === 'anonymous');

const audioElKey = computed(() => `${crossOriginMode.value}\n${props.content.url}`);

let hasLoadedMetadata = false;
let isPlayRequested = false;

function onLoadedMetadata() {
	hasLoadedMetadata = true;
	emit('loadedmetadata');
}

function onLoadError() {
	if (crossOriginMode.value !== 'anonymous' || hasLoadedMetadata) return;

	resumeAfterReloadUrl = isPlayRequested ? props.content.url : null;
	corsFailedUrl.value = props.content.url;
}

let visualizerTickFrameId: number | null = null;
let lastTickTimestamp = 0;

function resumeAudioCtx() {
	if (audioCtx == null || audioCtx.state !== 'suspended') return;
	audioCtx.resume().catch(err => {
		console.error('Failed to resume AudioContext:', err);
	});
}

function visualizerTick(timestamp: number) {
	const dt = lastTickTimestamp === 0 ? 1 / 60 : Math.min((timestamp - lastTickTimestamp) / 1000, 0.1);
	lastTickTimestamp = timestamp;

	draw(dt);

	visualizerTickFrameId = window.requestAnimationFrame(visualizerTick);
}

function startVisualizerTick() {
	if (visualizerTickFrameId != null) return;
	lastTickTimestamp = 0;
	visualizerTickFrameId = window.requestAnimationFrame(visualizerTick);
}

function stopVisualizerTick() {
	if (visualizerTickFrameId == null) return;
	window.cancelAnimationFrame(visualizerTickFrameId);
	visualizerTickFrameId = null;
	lastTickTimestamp = 0;
}

function setPlaying(playing: boolean) {
	if (playing && isVisualizerAvailable) {
		startVisualizerTick();
	} else {
		stopVisualizerTick();
	}
}

function setupAudioGraph(el: HTMLAudioElement) {
	try {
		audioCtx = new AudioContext();
		analyserNode = audioCtx.createAnalyser();
		analyserNode.fftSize = FFT_SIZE;
		analyserNode.smoothingTimeConstant = 0.2;
		analyserNode.minDecibels = -90;
		analyserNode.maxDecibels = -25;
		gainNode = audioCtx.createGain();
		gainNode.gain.value = props.volume;
		audioSource = audioCtx.createMediaElementSource(el);

		audioSource.connect(analyserNode);
		audioSource.connect(gainNode).connect(audioCtx.destination);

		setupBands(audioCtx.sampleRate);
		return true;
	} catch (err) {
		console.error('Failed to set up the audio graph for the visualizer:', err);
		teardownAudioGraph();
		return false;
	}
}

function init() {
	const el = audioEl.value;
	if (el == null) return;

	resetAnalysis();

	isVisualizerAvailable = canUseAudioGraph.value && setupAudioGraph(el);

	if (isVisualizerAvailable) {
		el.volume = 1;
	} else {
		el.volume = props.volume;
	}
	el.muted = false;

	abortController = new AbortController();
	const signal = abortController.signal;

	const on = (type: keyof HTMLMediaElementEventMap, listener: () => void) => {
		el.addEventListener(type, listener, { signal });
	};

	on('play', () => {
		isPlayRequested = true;
		resumeAudioCtx();
	});
	on('playing', () => setPlaying(true));
	on('waiting', () => setPlaying(false));
	on('pause', () => setPlaying(false));
	on('ended', () => setPlaying(false));
	on('emptied', () => setPlaying(false));

	if (!el.paused) resumeAudioCtx();
	setPlaying(!el.paused);

	if (resumeAfterReloadUrl === props.content.url) {
		resumeAfterReloadUrl = null;
		el.play().catch(err => {
			if (_DEV_) console.warn('Failed to play media:', err);
		});
	}

	redrawIfStopped();
}

function teardownAudioGraph() {
	audioSource?.disconnect();
	audioSource = null;
	analyserNode?.disconnect();
	analyserNode = null;
	gainNode?.disconnect();
	gainNode = null;
	if (audioCtx != null && audioCtx.state !== 'closed') {
		audioCtx.close().catch(err => {
			console.error('Failed to close AudioContext:', err);
		});
	}
	audioCtx = null;
}

function teardown() {
	abortController?.abort();
	abortController = null;
	stopVisualizerTick();
	teardownAudioGraph();
	isVisualizerAvailable = true;
	hasLoadedMetadata = false;
	isPlayRequested = false;
}

const GATE_FLOOR = 0.02;
const GATE_RANGE = 0.08;

function analyse(dt: number) {
	if (analyserNode == null) return;
	analyserNode.getByteFrequencyData(freqArray);

	const waveFrame = writeFrequencyBandLevels({
		frequencyData: freqArray,
		starts: bandStart,
		ends: bandEnd,
		levels: rawLevels,
		tilt: bandTilt,
	});

	const gate = Math.min(Math.max((waveFrame.mean - GATE_FLOOR) / GATE_RANGE, 0), 1);

	const span = updateRange(waveRange, waveFrame.min, waveFrame.peak, dt);

	for (let i = 0; i < BAND_COUNT; i++) {
		const normalized = Math.min(Math.max((rawLevels[i] - waveRange.floor) / span, 0), 1);
		const target = Math.pow(normalized, CONTRAST_EXPONENT) * gate;

		levels[i] = approach(levels[i], target, target > levels[i] ? WAVE_ATTACK_TAU : WAVE_RELEASE_TAU, dt);
	}

	const beatFrame = writeFrequencyBandLevels({
		frequencyData: freqArray,
		starts: beatBandStart,
		ends: beatBandEnd,
		levels: beatRawLevels,
	});
	const beatGate = Math.min(Math.max((beatFrame.mean - GATE_FLOOR) / GATE_RANGE, 0), 1);
	const beatSpan = updateRange(beatRange, beatFrame.min, beatFrame.peak, dt);
	const energy = Math.min(Math.max((beatFrame.mean - beatRange.floor) / beatSpan, 0), 1) * beatGate;

	levelEnv = approach(levelEnv, energy, LEVEL_TAU, dt);

	energyEnv = approach(energyEnv, energy, energy > energyEnv ? BEAT_ATTACK_TAU : BEAT_FALL_TAU, dt);
	energyBaseline = approach(energyBaseline, energyEnv, BEAT_BASELINE_TAU, dt);
	const hit = Math.min(Math.max(energyEnv - energyBaseline, 0) * BEAT_SENSITIVITY, 1);
	beatEnv = hit > beatEnv ? hit : approach(beatEnv, hit, BEAT_RELEASE_TAU, dt);
}

function drawBars(ctx: CanvasRenderingContext2D, width: number, height: number, centerY: number) {
	const baseHalfHeight = height * BASE_HALF_HEIGHT_RATIO;
	const gainHalfHeight = height * WAVE_GAIN_HALF_HEIGHT_RATIO;
	const cellWidth = width / levels.length;

	for (let i = 0; i < BAND_COUNT; i++) {
		const halfHeight = baseHalfHeight + levels[i] * gainHalfHeight;
		pointsX[i] = cellWidth * (i + 0.5);
		topPointsY[i] = centerY - halfHeight;
		bottomPointsY[i] = centerY + halfHeight;

		const opacity = remap(levels[i], 0, 1, 0.125, 1);
		const hue = remap(i, 0, BAND_COUNT - 1, accentColorHue - 10, accentColorHue + 10);
		ctx.globalAlpha = opacity;
		ctx.strokeStyle = `hsl(${hue}, 100%, 50%)`;
		ctx.beginPath();
		ctx.moveTo(pointsX[i], topPointsY[i]);
		ctx.lineTo(pointsX[i], bottomPointsY[i]);
		ctx.stroke();
	}
	ctx.globalAlpha = 1;
}

function draw(dt: number) {
	const canvas = canvasEl.value;
	const ctx = canvasCtx.value;
	if (canvas == null || ctx == null) return;

	if (dt > 0) analyse(dt);

	ctx.fillStyle = `hsl(${accentColorHue}, ${0.8 * 100}%, ${0.05 * 100}%)`;
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	const centerX = canvas.width / 2;
	const centerY = canvas.height / 2;

	if (isVisualizerAvailable) {
		ctx.lineWidth = getAudioVisualizerBarWidth(canvas.width, BAND_COUNT, BAR_THICKNESS_FACTOR);
		ctx.lineCap = 'round';
		drawBars(ctx, canvas.width, canvas.height, centerY);
	}

	const avatarScaleFactor = 1 + (levelEnv * LEVEL_SCALE + beatEnv * BEAT_SCALE) * motionDamp;
	const avatar = avatarImage.value;
	const avatarSize = canvas.height * AVATAR_SIZE_RATIO * avatarScaleFactor;
	if (avatar != null) {
		const avatarHeight = Math.max(avatar.height * (avatarSize / avatar.width), avatarSize);
		const avatarWidth = Math.max(avatar.width * (avatarSize / avatar.height), avatarSize);
		ctx.save();
		ctx.beginPath();
		ctx.arc(centerX, centerY, avatarSize / 2, 0, Math.PI * 2);
		ctx.clip();
		ctx.drawImage(avatar, centerX - avatarWidth / 2, centerY - avatarHeight / 2, avatarWidth, avatarHeight);
		ctx.restore();
	}

	if (!isVisualizerAvailable) {
		ctx.fillStyle = `hsl(${accentColorHue}, ${0.4 * 100}%, ${0.75 * 100}%)`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.font = `${Math.round(canvas.height * 0.055)}px ${window.getComputedStyle(canvas).fontFamily}`;
		ctx.fillText(i18n.ts.cannotPreview, centerX, centerY + avatarSize / 2 + canvas.height * 0.09);
	}
}

function redrawIfStopped() {
	if (visualizerTickFrameId == null) draw(0);
}

watch(() => props.volume, (to) => {
	if (gainNode != null) {
		gainNode.gain.value = to;
	} else if (audioEl.value != null) {
		audioEl.value.volume = to;
	}
});

watch(() => fileUser.value?.avatarUrl, (avatarUrl) => {
	const img = new Image();
	img.addEventListener('load', () => {
		avatarImage.value = img;
		redrawIfStopped();
	}, { once: true });
	img.src = avatarUrl ?? '/static-assets/avatar.png';
}, { immediate: true });

watch(audioEl, () => {
	teardown();
	init();
}, { immediate: true });

onBeforeUnmount(teardown);

defineExpose({
	audioEl,
});
</script>

<style module lang="scss">
.root {
	position: absolute;
	inset: 0;
	display: grid;
	place-items: center;
}

.visualizer {
	display: block;
	user-select: none;
	width: min(100cqw, calc(100cqh * 16 / 9));
	height: auto;
	aspect-ratio: 16 / 9;
	background: var(--MI_THEME-panel);
}

.playIconWrapper {
	position: absolute;
	top: 0;
	left: 0;
	width: 100%;
	height: 100%;
	display: grid;
	place-items: center;
	pointer-events: none;
}

.playIcon {
	display: grid;
	place-items: center;
	width: 50px;
	height: 50px;
	border-radius: 100%;
	font-size: 120%;
	background: var(--MI_THEME-accent);
	color: var(--MI_THEME-fgOnAccent);
	scale: 1;
	transition: scale 100ms ease;
}

.visualizer:hover ~ .playIconWrapper .playIcon {
	scale: 1.2;
}
</style>
