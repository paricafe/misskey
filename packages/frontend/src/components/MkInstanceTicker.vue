<!--
SPDX-FileCopyrightText: syuilo and other misskey contributors
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.root" :style="themeColorStyle" @click.stop="showInstanceTickerWindow">
	<img v-if="faviconUrl" :class="$style.icon" :src="faviconUrl"/>
	<div :class="$style.name">{{ instanceName }}</div>
</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { instanceName as localInstanceName } from '@@/js/config.js';
import type { CSSProperties } from 'vue';
import { instance as localInstance } from '@/instance.js';
import * as os from '@/os.js';
import { getProxiedImageUrlNullable } from '@/utility/media-proxy.js';

const props = defineProps<{
	host: string | null;
	instance?: {
		faviconUrl?: string
		name: string
		themeColor?: string
	}
}>();

// if no instance data is given, this is for the local instance
const instanceName = computed(() => props.host == null ? localInstanceName : props.instance?.name ?? props.host);

const faviconUrl = computed(() => {
	let imageSrc: string | null = null;
	if (props.host == null) {
		if (localInstance.iconUrl == null) {
			return '/favicon.ico';
		} else {
			imageSrc = localInstance.iconUrl;
		}
	} else {
		imageSrc = props.instance?.faviconUrl ?? null;
	}
	return getProxiedImageUrlNullable(imageSrc);
});

const themeColorStyle = computed<CSSProperties>(() => {
	const themeColor = (props.host == null ? localInstance.themeColor : props.instance?.themeColor) ?? '#777777';
	return {
		backgroundColor: themeColor,
	};
});

function showInstanceTickerWindow() {
	if (props.host) {
		os.pageWindow(`/instance-info/${props.host}`);
	} else {
		os.pageWindow('/about');
	}
}
</script>

<style lang="scss" module>
.root {
	display: flex;
	align-items: center;
	height: 1.5ex;
	border-radius: 1.0rem;
	padding: 4px;
	overflow: clip;
	color: #fff;

	// text-shadowは重いから使うな

	mask-image: linear-gradient(90deg,
		rgb(0,0,0),
		rgb(0,0,0) calc(100% - 16px),
		rgba(0,0,0,0) 100%
	);
}

.icon {
	height: 2ex;
	flex-shrink: 0;
}

.name {
	padding: 0.5ex;
	margin: -0.5ex;
	margin-left: calc(4px - 0.5ex);
	line-height: 1;
	font-size: 0.8em;
	font-weight: bold;
	white-space: nowrap;
	overflow: hidden;
	overflow-wrap: anywhere;
	max-width: 300px;
	text-overflow: ellipsis;

	&::-webkit-scrollbar {
		display: none;
	}
}

@container (max-width: 400px) {
	.name {
		max-width: 55px;
	}
}
</style>
