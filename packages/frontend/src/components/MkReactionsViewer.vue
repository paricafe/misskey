<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<component
	:is="prefer.s.animation ? TransitionGroup : 'div'"
	:enterActiveClass="$style.transition_x_enterActive"
	:leaveActiveClass="$style.transition_x_leaveActive"
	:enterFromClass="$style.transition_x_enterFrom"
	:leaveToClass="$style.transition_x_leaveTo"
	:moveClass="$style.transition_x_move"
	tag="div" :class="$style.root"
>
	<XReaction
		v-for="[reaction, count] in _reactions"
		:key="reaction"
		:reaction="reaction"
		:reactionEmojis="props.reactionEmojis"
		:count="count"
		:isInitial="initialReactions.has(reaction)"
		:noteId="props.noteId"
		:myReaction="props.myReaction"
		@reactionToggled="onMockToggleReaction"
	/>
	<slot v-if="hasMoreReactions" name="more"/>
</component>
</template>

<script lang="ts" setup>
import * as Misskey from 'misskey-js';
import { inject, watch, ref } from 'vue';
import { TransitionGroup } from 'vue';
import XReaction from '@/components/MkReactionsViewer.reaction.vue';
import { prefer } from '@/preferences.js';
import { DI } from '@/di.js';

const props = withDefaults(defineProps<{
	noteId: Misskey.entities.Note['id'];
	reactions: Misskey.entities.Note['reactions'];
	reactionEmojis: Misskey.entities.Note['reactionEmojis'];
	myReaction: Misskey.entities.Note['myReaction'];
	maxNumber?: number;
}>(), {
	maxNumber: Infinity,
});

const mock = inject(DI.mock, false);

const emit = defineEmits<{
	(ev: 'mockUpdateMyReaction', emoji: string, delta: number): void;
}>();

const initialReactions = new Set(Object.keys(props.reactions));

const _reactions = ref<[string, number][]>([]);
const hasMoreReactions = ref(false);

watch([() => props.reactions, () => props.maxNumber], ([newSource, maxNumber]) => {
	let newReactions: [string, number][] = [];
	hasMoreReactions.value = Object.keys(newSource).length > maxNumber;

	newReactions = Object.entries(newSource)
		.filter(([, count]) => count !== 0)
		.sort(([, a], [, b]) => b - a)
		.slice(0, props.maxNumber);

	if (props.myReaction && !newReactions.some(([x]) => x === props.myReaction) && props.myReaction in newSource) {
		if (newSource[props.myReaction] > 0) {
			newReactions.push([props.myReaction, newSource[props.myReaction]]);
		}
	}

	_reactions.value = newReactions;
}, { immediate: true, deep: true });
</script>

<style lang="scss" module>
.transition_x_move,
.transition_x_enterActive,
.transition_x_leaveActive {
	transition: opacity 0.2s cubic-bezier(0,.5,.5,1), transform 0.2s cubic-bezier(0,.5,.5,1) !important;
}
.transition_x_enterFrom,
.transition_x_leaveTo {
	opacity: 0;
	transform: scale(0.7);
}
.transition_x_leaveActive {
	position: absolute;
}

.root {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px;

	&:empty {
		display: none;
	}
}
</style>
