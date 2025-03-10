<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<header :class="$style.root">
	<div :class="$style.section">
		<div style="display: flex;">
			<div v-if="mock" :class="$style.name">
				<MkUserName :user="note.user"/>
			</div>
			<MkA v-else v-user-preview="note.user.id" :class="$style.name" :to="userPage(note.user)" @click.stop>
				<MkUserName :user="note.user"/>
			</MkA>
			<div v-if="note.user.isBot" :class="$style.isBot">bot</div>
			<div v-if="note.user.badgeRoles" :class="$style.badgeRoles">
				<img v-for="(role, i) in note.user.badgeRoles" :key="i" v-tooltip="role.name" :class="$style.badgeRole" :src="role.iconUrl!"/>
			</div>
		</div>
		<div :class="$style.username"><MkAcct :user="note.user"/></div>
	</div>
	<div :class="$style.section">
		<div :class="$style.info">
			<span v-if="note.updatedAt" style="margin-right: 0.5em;" :title="i18n.ts.edited"><i class="ti ti-pencil"></i></span>
			<div v-if="mock">
				<MkTime :time="note.createdAt" colored/>
			</div>
			<MkA v-else :to="notePage(note)" :style="{ textDecoration: 'none', userSelect: 'none' }" @mouseenter="setDetail(true)" @mouseleave="setDetail(false)">
				<MkTime
					:time="note.createdAt"
					:mode="(defaultStore.state.showDetailTimeWhenHover && isDetail) ? 'detail' : undefined"
					colored
				/>
			</MkA>
			<span v-if="note.visibility !== 'public'" style="margin-left: 0.5em;" :title="i18n.ts._visibility[note.visibility]">
				<i v-if="note.visibility === 'home'" class="ti ti-home"></i>
				<i v-else-if="note.visibility === 'followers'" class="ti ti-lock"></i>
				<i v-else-if="note.visibility === 'specified'" ref="specified" class="ti ti-mail"></i>
			</span>
			<span v-if="note.localOnly" style="margin-left: 0.5em;" :title="i18n.ts._visibility['disableFederation']"><i class="ti ti-rocket-off"></i></span>
			<span v-if="note.channel" style="margin-left: 0.5em;" :title="note.channel.name"><i class="ti ti-device-tv"></i></span>
		</div>
		<div :class="$style.info"><MkInstanceTicker v-if="showTicker" :style="{ cursor: defaultStore.state.clickToShowInstanceTickerWindow ? 'pointer' : 'default' }" :instance="note.user.instance" :host="note.user.host"/></div>
	</div>
</header>
</template>

<script lang="ts" setup>
import { inject, ref } from 'vue';
import * as Misskey from 'misskey-js';
import { i18n } from '@/i18n.js';
import { notePage } from '@/filters/note.js';
import { userPage } from '@/filters/user.js';
import { defaultStore } from '@/store.js';
import MkInstanceTicker from '@/components/MkInstanceTicker.vue';

const isDetail = ref(false);
const setDetail = (value) => {
	isDetail.value = value;
};

const props = defineProps<{
	note: Misskey.entities.Note;
}>();

const showTicker = (defaultStore.state.instanceTicker === 'always') || (defaultStore.state.instanceTicker === 'remote' && props.note.user.instance);

const mock = inject<boolean>('mock', false);
</script>

<style lang="scss" module>
.root {
	display: flex;
	align-items: baseline;
	white-space: nowrap;
}

.section {
	display: flex;
	white-space: nowrap;
	flex-direction: column;

	&:first-child {
		flex: 1;
		overflow: hidden;
		min-width: 0;
	}

	&:last-child {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		margin-left: auto;
		overflow: visible;
	}
}

.name {
	flex-shrink: 1;
	display: block;
	margin: 0 .5em 0 0;
	padding: 0;
	overflow: hidden;
	font-size: 1em;
	font-weight: bold;
	text-decoration: none;
	text-overflow: ellipsis;

	&:hover {
		text-decoration: none;
		opacity: 0.8;
	}
}

.isBot {
	flex-shrink: 0;
	align-self: center;
	margin: 0 .5em 0 0;
	padding: 1px 6px;
	font-size: 80%;
	border: solid 0.5px var(--MI_THEME-divider);
	border-radius: 3px;
}

.username {
	flex-shrink: 9999999;
	margin: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	opacity: 0.8;

	&::-webkit-scrollbar {
		display: none;
	}
}

.info {
	display: flex;
	align-items: center;
	gap: 4px;

	&:first-child {
		margin-top: 0;
		font-size: 0.9em;
	}

	&:not(:first-child) {
		margin-top: 4px;
		font-size: 0.9em;
	}
}

.badgeRoles {
	margin: 0 .5em 0 0;
}

.badgeRole {
	height: 1.3em;
	vertical-align: -20%;

	& + .badgeRole {
		margin-left: 0.2em;
	}
}
</style>
