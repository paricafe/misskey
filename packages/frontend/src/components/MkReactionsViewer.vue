<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<TransitionGroup
	:enterActiveClass="defaultStore.state.animation ? $style.transition_x_enterActive : ''"
	:leaveActiveClass="defaultStore.state.animation ? $style.transition_x_leaveActive : ''"
	:enterFromClass="defaultStore.state.animation ? $style.transition_x_enterFrom : ''"
	:leaveToClass="defaultStore.state.animation ? $style.transition_x_leaveTo : ''"
	:moveClass="defaultStore.state.animation ? $style.transition_x_move : ''"
	tag="div" :class="$style.root"
>
	<XReaction v-for="[reaction, count] in mergedReactions" :key="reaction" :reaction="reaction" :count="count" :isInitial="initialReactions.has(reaction)" :note="note" @reactionToggled="onMockToggleReaction"/>
	<slot v-if="hasMoreReactions" name="more"/>
</TransitionGroup>
</template>

<script lang="ts" setup>
import * as Misskey from 'misskey-js';
import { inject, watch, ref, computed, onBeforeMount } from 'vue';
import XReaction from '@/components/MkReactionsViewer.reaction.vue';
import { defaultStore } from '@/store.js';
import { customEmojisMap } from '@/custom-emojis.js';

const localEmojiSet = new Set(Array.from(customEmojisMap.keys()));
const emojiCache = new Map<string, boolean>();

function hasLocalEmoji(reaction: string): boolean {
  if (emojiCache.has(reaction)) return emojiCache.get(reaction)!;
  
  let result: boolean;
  if (!reaction.includes(':')) {
    result = true;
  } else {
    const emojiName = reaction.split('@')[0].split(':')[1];
    result = localEmojiSet.has(emojiName);
  }
  
  emojiCache.set(reaction, result);
  return result;
}

function getBaseReaction(reaction: string): string {
  if (!reaction.includes(':')) return reaction;
  return `:${reaction.split('@')[0].split(':')[1]}:`;
}

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

const initialReactions = new Set(Object.keys(props.note.reactions));

const reactions = ref<[string, number][]>([]);
const hasMoreReactions = ref(false);

const mergedReactions = computed(() => {
  const reactionMap = new Map();
  
  reactions.value.forEach(([reaction, count]) => {
    if (!hasLocalEmoji(reaction)) {
      if (reactionMap.has(reaction)) {
        reactionMap.set(reaction, reactionMap.get(reaction) + count);
      } else {
        reactionMap.set(reaction, count);
      }
      return;
    }
    
    const baseReaction = getBaseReaction(reaction);
    if (reactionMap.has(baseReaction)) {
      reactionMap.set(baseReaction, reactionMap.get(baseReaction) + count);
    } else {
      reactionMap.set(baseReaction, count);
    }
  });

  return Array.from(reactionMap.entries());
});

if (props.note.myReaction && !Object.keys(reactions.value).includes(props.note.myReaction)) {
	reactions.value[props.note.myReaction] = props.note.reactions[props.note.myReaction];
}

onBeforeMount(() => {
  Object.keys(props.note.reactions).forEach(reaction => {
    hasLocalEmoji(reaction);
  });
});

function onMockToggleReaction(emoji: string, count: number) {
	if (!mock) return;

	const i = reactions.value.findIndex((item) => item[0] === emoji);
	if (i < 0) return;

	emit('mockUpdateMyReaction', emoji, (count - reactions.value[i][1]));
}

watch([() => props.note.reactions, () => props.maxNumber], ([newSource, maxNumber]) => {
	let newReactions: [string, number][] = [];
	hasMoreReactions.value = Object.keys(newSource).length > maxNumber;

	for (let i = 0; i < reactions.value.length; i++) {
		const reaction = reactions.value[i][0];
		if (reaction in newSource && newSource[reaction] !== 0) {
			reactions.value[i][1] = newSource[reaction];
			newReactions.push(reactions.value[i]);
		}
	}

	const newReactionsNames = newReactions.map(([x]) => x);
	newReactions = [
		...newReactions,
		...Object.entries(newSource)
			.sort(([, a], [, b]) => b - a)
			.filter(([y], i) => i < maxNumber && !newReactionsNames.includes(y)),
	];

	newReactions = newReactions.slice(0, props.maxNumber);

	if (props.note.myReaction && !newReactions.map(([x]) => x).includes(props.note.myReaction)) {
		newReactions.push([props.note.myReaction, newSource[props.note.myReaction]]);
	}

	reactions.value = newReactions;
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
