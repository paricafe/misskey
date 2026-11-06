<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkLoading v-if="!pluginsReady"/>
<NoteBody v-else v-bind="$props" @reaction="emit('reaction', $event)" @removeReaction="emit('removeReaction', $event)"/>
</template>

<script lang="ts" setup>
import type * as Misskey from 'misskey-js';
import MkLoading from '@/components/global/MkLoading.vue';
import { pluginsReady } from '@/plugin.js';
import NoteBody from './MkNote.body.vue';

defineProps<{
	note: Misskey.entities.Note;
	pinned?: boolean;
	mock?: boolean;
	withHardMute?: boolean;
}>();

const emit = defineEmits<{
	(ev: 'reaction', emoji: string): void;
	(ev: 'removeReaction', emoji: string): void;
}>();

</script>
