<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<TransitionGroup
	:enterActiveClass="prefer.s.animation ? $style.transition_x_enterActive : ''"
	:leaveActiveClass="prefer.s.animation ? $style.transition_x_leaveActive : ''"
	:enterFromClass="prefer.s.animation ? $style.transition_x_enterFrom : ''"
	:leaveToClass="prefer.s.animation ? $style.transition_x_leaveTo : ''"
	:moveClass="prefer.s.animation ? $style.transition_x_move : ''"
	tag="div" :class="$style.root"
	@click.stop
>
	<XReaction v-for="[reaction, count] in reactions" :key="reaction" :reaction="reaction" :count="count" :isInitial="initialReactions.has(reaction)" :note="note" @reactionToggled="onMockToggleReaction"/>
	<slot v-if="hasMoreReactions" name="more"/>
</TransitionGroup>
</template>

<script lang="ts" setup>
import * as Misskey from 'misskey-js';
import { inject, watch, ref } from 'vue';
import XReaction from '@/components/MkReactionsViewer.reaction.vue';
import { prefer } from '@/preferences.js';

const props = withDefaults(defineProps<{
	note: Misskey.entities.Note;
	maxNumber?: number;
}>(), {
	maxNumber: Infinity,
});

const mock = inject<boolean>('mock', false);

const emit = defineEmits<{
	(ev: 'mockUpdateMyReaction', emoji: string, delta: number): void;
}>();

const initialReactions = ref(new Set<string>());

const reactions = ref<[string, number][]>([]);
const hasMoreReactions = ref(false);

function normalizeReaction(reaction) {
	if (reaction.startsWith(':') && reaction.endsWith(':')) {
		const match = reaction.match(/^:([^@]+)(?:@[^:]+)?:$/);
		if (match) {
			return `:${match[1]}:`;
		}
	}
	return reaction;
}

watch(() => props.note.myReaction, (newMyReaction) => {
	if (newMyReaction && !Object.keys(reactions.value).includes(newMyReaction)) {
		reactions.value[newMyReaction] = props.note.reactions[newMyReaction];
	}
}, { immediate: true });

function onMockToggleReaction(emoji: string, count: number) {
	if (!mock) return;

	const i = reactions.value.findIndex((item) => {
		return normalizeReaction(item[0]) === normalizeReaction(emoji);
	});
	if (i < 0) return;

	emit('mockUpdateMyReaction', emoji, (count - reactions.value[i][1]));
}

watch([() => props.note.reactions, () => props.maxNumber], ([newSource, maxNumber]) => {
	initialReactions.value = new Set(Object.keys(newSource));

	const normalizedCounts = new Map<string, number>();
	const normalizedOriginals = new Map<string, string>();

	for (const [reaction, count] of Object.entries(newSource)) {
		const normalized = normalizeReaction(reaction);
		const currentCount = normalizedCounts.get(normalized) || 0;
		normalizedCounts.set(normalized, currentCount + count);

		if (!normalizedOriginals.has(normalized) || !reaction.includes('@')) {
			normalizedOriginals.set(normalized, reaction);
		}
	}

	let newReactions: [string, number][] = [];

	for (let i = 0; i < reactions.value.length; i++) {
		const [reaction] = reactions.value[i];
		const normalized = normalizeReaction(reaction);

		if (normalizedCounts.has(normalized) && normalizedCounts.get(normalized)! > 0) {
			newReactions.push([
				normalizedOriginals.get(normalized)!,
				normalizedCounts.get(normalized)!,
			]);
			normalizedCounts.delete(normalized);
		}
	}

	const remainingEntries = Array.from(normalizedCounts.entries())
		.filter(([, count]) => count > 0)
		.sort(([, a], [, b]) => b - a);

	for (const [normalized, count] of remainingEntries) {
		if (newReactions.length < maxNumber) {
			newReactions.push([normalizedOriginals.get(normalized)!, count]);
		}
	}

	hasMoreReactions.value = Object.keys(newSource).length > maxNumber;

	if (props.note.myReaction) {
		const normalizedMyReaction = normalizeReaction(props.note.myReaction);
		const alreadyIncluded = newReactions.some(([x]) =>
			normalizeReaction(x) === normalizedMyReaction,
		);

		if (!alreadyIncluded && newSource[props.note.myReaction]) {
			newReactions.push([
				props.note.myReaction,
				newSource[props.note.myReaction],
			]);
		}
	}

	reactions.value = newReactions.slice(0, props.maxNumber);
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
	margin: 4px -2px 0 -2px;

	&:empty {
		display: none;
	}
}
</style>
