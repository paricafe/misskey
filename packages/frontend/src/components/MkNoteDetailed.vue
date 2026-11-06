<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkLoading v-if="!pluginsReady"/>
<NoteBody v-else v-bind="$props"/>
</template>

<script lang="ts" setup>
import type * as Misskey from 'misskey-js';
import MkLoading from '@/components/global/MkLoading.vue';
import { pluginsReady } from '@/plugin.js';
import NoteBody from './MkNoteDetailed.body.vue';

defineProps<{
	note: Misskey.entities.Note;
	initialTab?: 'replies' | 'renotes' | 'reactions';
}>();

</script>
