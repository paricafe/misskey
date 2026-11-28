<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<canvas
	v-show="show"
	ref="canvas"
	:width="canvasWidth"
	:height="canvasHeight"
	draggable="false"
	tabindex="-1"
	style="-webkit-user-drag: none;"
></canvas>
</template>

<script lang="ts" setup>
import { watch, ref, shallowRef, useTemplateRef, onMounted, onUnmounted } from 'vue';
import { genId } from '@/utility/id.js';
import { extractAvgColorFromBlurhash } from '@@/js/extract-avg-color-from-blurhash.js';
import { defaultBlurhashRenderer } from '@/utility/blurhash-renderer.js';

const isTest = Boolean(import.meta.env.MODE === 'test' || (window as Window & { isPlaywright?: boolean }).isPlaywright);

const props = withDefaults(defineProps<{
	blurhash: string | null;
	onlyAvgColor?: boolean;
	width?: number;
	height?: number;
	show?: boolean;
}>(), {
	onlyAvgColor: false,
	width: 64,
	height: 64,
	show: true,
});

const canvas = useTemplateRef('canvas');
const canvasWidth = ref(64);
const canvasHeight = ref(64);
const viewId = genId();
const bitmapTmp = shallowRef<CanvasImageSource | undefined>();
let requestSeq = 0;
let activeRequestId: string | null = null;
let unmounted = false;

watch([() => props.width, () => props.height, canvas], () => {
	const ratio = props.width / props.height;
	if (!Number.isFinite(ratio) || ratio <= 0) {
		canvasWidth.value = 64;
		canvasHeight.value = 64;
	} else if (ratio > 1) {
		canvasWidth.value = Math.round(64 * ratio);
		canvasHeight.value = 64;
	} else {
		canvasWidth.value = 64;
		canvasHeight.value = Math.round(64 / ratio);
	}
}, {
	immediate: true,
});

watch([() => props.blurhash, () => props.onlyAvgColor], () => {
	draw();
});

function closeTempBitmap() {
	if (bitmapTmp.value && 'close' in bitmapTmp.value && typeof bitmapTmp.value.close === 'function') {
		bitmapTmp.value.close();
	}
	bitmapTmp.value = undefined;
}

function drawImage(bitmap: CanvasImageSource) {
	if (!canvas.value) {
		closeTempBitmap();
		bitmapTmp.value = bitmap;
		return;
	}

	closeTempBitmap();
	const ctx = canvas.value.getContext('2d');
	if (!ctx) return;
	ctx.drawImage(bitmap, 0, 0, canvasWidth.value, canvasHeight.value);
	if ('close' in bitmap && typeof bitmap.close === 'function') {
		bitmap.close();
	}
}

function drawAvg() {
	if (!canvas.value) return;

	const color = (props.blurhash != null && extractAvgColorFromBlurhash(props.blurhash)) || '#888';

	const ctx = canvas.value.getContext('2d');
	if (!ctx) return;

	ctx.beginPath();
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, canvasWidth.value, canvasHeight.value);
}

function cancelActiveRequest() {
	if (activeRequestId != null) {
		defaultBlurhashRenderer.cancel(activeRequestId);
		activeRequestId = null;
	}
}

async function draw() {
	cancelActiveRequest();
	if (isTest && props.blurhash == null) return;

	drawAvg();

	if (props.blurhash == null || props.onlyAvgColor) return;

	const seq = ++requestSeq;
	const requestId = `${viewId}:${seq}`;
	activeRequestId = requestId;
	const hash = props.blurhash;

	await defaultBlurhashRenderer.render(
		requestId,
		hash,
		(image) => {
			if (activeRequestId === requestId) activeRequestId = null;
			drawImage(image);
		},
		() => unmounted || seq !== requestSeq,
	);
}

onMounted(() => {
	if (bitmapTmp.value) {
		drawImage(bitmapTmp.value);
	} else {
		draw();
	}
});

onUnmounted(() => {
	unmounted = true;
	requestSeq++;
	cancelActiveRequest();
	closeTempBitmap();
});
</script>
