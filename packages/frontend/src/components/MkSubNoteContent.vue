<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="[$style.root, { [$style.collapsed]: collapsed }]">
	<div :class="[{ [$style.noteClickToOpen]: defaultStore.state.noteClickToOpen }]" @click.stop="defaultStore.state.noteClickToOpen ? noteClickToOpen(note.id) : undefined">
		<span v-if="note.isHidden" style="opacity: 0.5">({{ i18n.ts.private }})</span>
		<span v-if="note.deletedAt" style="opacity: 0.5">({{ i18n.ts.deletedNote }})</span>
		<MkA v-if="note.replyId" :class="$style.reply" :to="`/notes/${note.replyId}`" @click.stop><i class="ti ti-arrow-back-up"></i></MkA>
		<Mfm v-if="note.text" :text="note.text" :author="note.user" :nyaize="'respect'" :emojiUrls="note.emojis"/>
		<MkA v-if="note.renoteId" :class="$style.rp" :to="`/notes/${note.renoteId}`" @click.stop>RN: ...</MkA>
	</div>
	<details v-if="note.files && note.files.length > 0">
		<summary @click.stop>({{ i18n.tsx.withNFiles({ n: note.files.length }) }})</summary>
		<MkMediaList :mediaList="note.files" @click.stop/>
	</details>
	<details v-if="note.poll">
		<summary>{{ i18n.ts.poll }}</summary>
		<MkPoll :noteId="note.id" :poll="note.poll" :author="note.user" :emojiUrls="note.emojis"/>
	</details>
	<button v-if="isLong && collapsed" :class="$style.fade" class="_button" @click.stop="collapsed = false">
		<span :class="$style.fadeLabel">{{ i18n.ts.showMore }}</span>
	</button>
	<button v-else-if="isLong && !collapsed" :class="$style.showLess" class="_button" @click.stop="collapsed = true">
		<span :class="$style.showLessLabel">{{ i18n.ts.showLess }}</span>
	</button>
</div>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
import * as Misskey from 'misskey-js';
import { shouldCollapsed } from '@@/js/collapsed.js';
import MkMediaList from '@/components/MkMediaList.vue';
import MkPoll from '@/components/MkPoll.vue';
import { i18n } from '@/i18n.js';
import { defaultStore } from '@/store.js';
import { useRouter } from '@/router/supplier.js';

const props = defineProps<{
	note: Misskey.entities.Note;
}>();

const router = useRouter();

function noteClickToOpen(id: string) {
	const selection = document.getSelection();
	if (selection?.toString().length === 0) {
		router.push(`/notes/${id}`);
	}
}

const isLong = shouldCollapsed(props.note, []);

const collapsed = ref(isLong);
</script>

<style lang="scss" module>
.root {
	overflow-wrap: break-word;

	&.collapsed {
		position: relative;
		max-height: 9em;
		overflow: clip;

		> .fade {
			display: block;
			position: absolute;
			bottom: 0;
			left: 0;
			width: 100%;
			height: 64px;
			background: linear-gradient(0deg, var(--MI_THEME-panel), color(from var(--MI_THEME-panel) srgb r g b / 0));

			> .fadeLabel {
				display: inline-block;
				background: var(--MI_THEME-panel);
				padding: 6px 10px;
				font-size: 0.8em;
				border-radius: 999px;
				box-shadow: 0 2px 6px rgb(0 0 0 / 20%);
			}

			&:hover {
				> .fadeLabel {
					background: var(--MI_THEME-panelHighlight);
				}
			}
		}
	}
}

.reply {
	margin-right: 6px;
	color: var(--MI_THEME-accent);
}

.rp {
	margin-left: 4px;
	font-style: oblique;
	color: var(--MI_THEME-renote);
}

.showLess {
	width: 100%;
	margin-top: 14px;
	position: sticky;
	bottom: calc(var(--MI-stickyBottom, 0px) + 14px);
}

.showLessLabel {
	display: inline-block;
	background: var(--MI_THEME-popup);
	padding: 6px 10px;
	font-size: 0.8em;
	border-radius: 999px;
	box-shadow: 0 2px 6px rgb(0 0 0 / 20%);
}

.noteClickToOpen {
	cursor: pointer;
	-webkit-tap-highlight-color: transparent;
}
</style>
