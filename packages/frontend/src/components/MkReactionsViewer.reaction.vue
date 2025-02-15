<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<button
	ref="buttonEl"
	v-ripple="canToggle"
	class="_button"
	:class="[$style.root, { [$style.reacted]: isReacted, [$style.canToggle]: canToggle, [$style.small]: defaultStore.state.reactionsDisplaySize === 'small', [$style.large]: defaultStore.state.reactionsDisplaySize === 'large' }]"
	@click.stop="toggleReaction()"
	@contextmenu.prevent.stop="menu"
>
	<MkReactionIcon :class="defaultStore.state.limitWidthOfReaction ? $style.limitWidth : ''" :reaction="reaction" :emojiUrl="note.reactionEmojis[reaction.substring(1, reaction.length - 1)]"/>
	<span :class="$style.count">{{ count }}</span>
</button>
</template>

<script lang="ts" setup>
import { computed, inject, onMounted, onBeforeMount, shallowRef, watch } from 'vue';
import * as Misskey from 'misskey-js';
import { getUnicodeEmoji } from '@@/js/emojilist.js';
import MkCustomEmojiDetailedDialog from './MkCustomEmojiDetailedDialog.vue';
import XDetails from '@/components/MkReactionsViewer.details.vue';
import MkReactionIcon from '@/components/MkReactionIcon.vue';
import * as os from '@/os.js';
import { misskeyApi, misskeyApiGet } from '@/scripts/misskey-api.js';
import { useTooltip } from '@/scripts/use-tooltip.js';
import { $i } from '@/account.js';
import MkReactionEffect from '@/components/MkReactionEffect.vue';
import { claimAchievement } from '@/scripts/achievements.js';
import { defaultStore } from '@/store.js';
import { i18n } from '@/i18n.js';
import * as sound from '@/scripts/sound.js';
import { customEmojisMap } from '@/custom-emojis.js';

const localEmojiSet = new Set(Array.from(customEmojisMap.keys()));
const reactionCache = new Map<string, { hasNative: boolean; base: string }>();

function getReactionInfo(reaction: string) {
	if (reactionCache.has(reaction)) {
		return reactionCache.get(reaction)!;
	}

	let hasNative: boolean;
	let base: string;

	if (!reaction.includes(':')) {
		hasNative = true;
		base = reaction;
	} else {
		const baseName = reaction.split('@')[0].split(':')[1];
		hasNative = localEmojiSet.has(baseName);
		base = hasNative ? `:${baseName}:` : reaction;
	}

	const info = { hasNative, base };
	reactionCache.set(reaction, info);
	return info;
}

const props = defineProps<{
	reaction: string;
	count: number;
	isInitial: boolean;
	note: Misskey.entities.Note;
}>();

const mock = inject<boolean>('mock', false);

const emit = defineEmits<{
	(ev: 'reactionToggled', emoji: string, newCount: number): void;
}>();

const buttonEl = shallowRef<HTMLElement>();

const emojiName = computed(() => props.reaction.replace(/:/g, '').replace(/@\./, ''));
const emoji = computed(() => customEmojisMap.get(emojiName.value) ?? getUnicodeEmoji(props.reaction));

const reactionInfo = computed(() => getReactionInfo(props.reaction));
const hasNativeEmoji = computed(() => reactionInfo.value.hasNative);
const baseReaction = computed(() => reactionInfo.value.base);

const canToggle = computed(() => $i != null && hasNativeEmoji.value);

const isReacted = computed(() => {
	if (!props.note.myReaction) return false;
	const myInfo = getReactionInfo(props.note.myReaction);
	return myInfo.base === reactionInfo.value.base;
});

let lastCount = props.count;

async function toggleReaction() {
	if (!canToggle.value) return;

	const oldReaction = props.note.myReaction;

	if (isReacted.value) {
		const confirm = await os.confirm({
			type: 'warning',
			text: i18n.ts.cancelReactionConfirm,
		});
		if (confirm.canceled) return;

		if (mock) {
			emit('reactionToggled', props.reaction, (props.count - 1));
			return;
		}

		misskeyApi('notes/reactions/delete', {
			noteId: props.note.id,
		}).then(() => {
			if (oldReaction !== props.reaction) {
				misskeyApi('notes/reactions/create', {
					noteId: props.note.id,
					reaction: props.reaction,
				});
			}
		});
	} else {
		if (defaultStore.state.confirmOnReact) {
			const confirm = await os.confirm({
				type: 'question',
				text: i18n.tsx.reactAreYouSure({ emoji: props.reaction.replace('@.', '') }),
			});
			if (confirm.canceled) return;
		}

	if (oldReaction) {
		const confirm = await os.confirm({
			type: 'warning',
			text: i18n.ts.changeReactionConfirm,
		});
		if (confirm.canceled) return;

		sound.playMisskeySfx('reaction');

		if (mock) {
			emit('reactionToggled', props.reaction, (props.count + 1));
			return;
		}

		await misskeyApi('notes/reactions/delete', {
			noteId: props.note.id,
		});
	}

	sound.playMisskeySfx('reaction');

	if (mock) {
		emit('reactionToggled', props.reaction, (props.count + 1));
		return;
	}

	misskeyApi('notes/reactions/create', {
		noteId: props.note.id,
		reaction: baseReaction.value,
	});

	if (props.note.text && props.note.text.length > 100 && (Date.now() - new Date(props.note.createdAt).getTime() < 1000 * 3)) {
		claimAchievement('reactWithoutRead');
	}
}

async function menu(ev) {
	if (!props.reaction.includes(':')) return;

	os.popupMenu([{
		text: i18n.ts.info,
		icon: 'ti ti-info-circle',
		action: async () => {
			const { dispose } = os.popup(MkCustomEmojiDetailedDialog, {
				emoji: await misskeyApiGet('emoji', {
					name: props.reaction.replace(/:/g, '').replace(/@\./, ''),
				}),
			}, {
				closed: () => dispose(),
			});
		},
	}], ev.currentTarget ?? ev.target);
}

function anime() {
	if (document.hidden || !defaultStore.state.animation || buttonEl.value == null) return;

	const rect = buttonEl.value.getBoundingClientRect();
	const x = rect.left + 16;
	const y = rect.top + (buttonEl.value.offsetHeight / 2);
	const { dispose } = os.popup(MkReactionEffect, { reaction: props.reaction, x, y }, {
		end: () => dispose(),
	});
}

watch(() => props.count, (newCount, oldCount) => {
	if (oldCount < newCount && !props.isInitial) anime();
	lastCount = newCount;
}, { immediate: true });

onBeforeMount(() => {
	getReactionInfo(props.reaction);
	if (props.note.myReaction) {
		getReactionInfo(props.note.myReaction);
	}
	Object.keys(props.note.reactions).forEach(reaction => {
		getReactionInfo(reaction);
	});
});

if (!mock) {
	useTooltip(buttonEl, async (showing) => {
		const allVariants = new Set([props.reaction]);

		if (reactionInfo.value.hasNative) {
			allVariants.add(reactionInfo.value.base);

			Object.keys(props.note.reactions).forEach(reaction => {
				const info = getReactionInfo(reaction);
				if (info.hasNative && info.base === reactionInfo.value.base) {
					allVariants.add(reaction);
				}
			});
		}

		const reactionPromises = Array.from(allVariants).map(variant =>
			misskeyApiGet('notes/reactions', {
				noteId: props.note.id,
				type: variant,
				limit: 10,
				_cacheKey_: props.count,
			}),
		);

		const allReactions = await Promise.all(reactionPromises);

		const allUsers = [...new Map(
			allReactions.flat().map(x => [x.user.id, x.user]),
		).values()];

		const { dispose } = os.popup(XDetails, {
			showing,
			reaction: props.reaction,
			users: allUsers,
			count: props.count,
			targetElement: buttonEl.value,
		}, {
			closed: () => dispose(),
		});
	}, 100);
}
</script>

<style lang="scss" module>
.root {
	display: inline-flex;
	height: 42px;
	margin: 2px;
	padding: 0 6px;
	font-size: 1.5em;
	border-radius: 6px;
	align-items: center;
	justify-content: center;

	&.canToggle {
		background: var(--MI_THEME-buttonBg);

		&:hover {
			background: rgba(0, 0, 0, 0.1);
		}
	}

	&:not(.canToggle) {
		cursor: default;
	}

	&.small {
		height: 32px;
		font-size: 1em;
		border-radius: 4px;

		> .count {
			font-size: 0.9em;
			line-height: 32px;
		}
	}

	&.large {
		height: 52px;
		font-size: 2em;
		border-radius: 8px;

		> .count {
			font-size: 0.6em;
			line-height: 52px;
		}
	}

	&.reacted, &.reacted:hover {
		background: var(--MI_THEME-accentedBg);
		color: var(--MI_THEME-accent);
		box-shadow: 0 0 0 1px var(--MI_THEME-accent) inset;

		> .count {
			color: var(--MI_THEME-accent);
		}

		> .icon {
			filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.5));
		}
	}
}

.limitWidth {
	max-width: 70px;
	object-fit: contain;
}

.count {
	font-size: 0.7em;
	line-height: 42px;
	margin: 0 0 0 4px;
}
</style>
