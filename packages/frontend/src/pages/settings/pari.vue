<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
	<div class="_gaps_m">
		<div class="label">{{ i18n.ts.pariPlusNoteSettings }}</div>
		<MkSwitch v-model="autoTranslateButton">{{ i18n.ts.autoTranslateButton }}</MkSwitch>
		<MkSwitch v-model="showDetailTimeWhenHover">{{ i18n.ts.showDetailTimeWhenHover }}</MkSwitch>
		<MkSwitch v-model="noteClickToOpen">{{ i18n.ts.noteClickToOpen }}</MkSwitch>
		<MkSwitch v-model="enableFallbackReactButton">{{ i18n.ts.enableFallbackReactButton }}</MkSwitch>
		<MkSwitch v-model="enableMFMCheatsheet">{{ i18n.ts.enableMFMCheatsheet }}</MkSwitch>
		<MkSelect v-model="autoSpacingBehaviour">
			<template #label>{{ i18n.ts.autoSpacing }}</template>
			<option :value="null">{{ i18n.ts.disabled }}</option>
			<option value="all">{{ i18n.ts.all }}</option>
			<option value="special">{{ i18n.ts.auto }}</option>
			<template #caption>{{ i18n.ts.autoSpacingDescription }}</template>
		</MkSelect>
    </div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { i18n } from '@/i18n.js';
import { definePageMetadata } from '@/scripts/page-metadata.js';
import { defaultStore } from '@/store.js';
import MkSwitch from '@/components/MkSwitch.vue';
import MkSelect from '@/components/MkSelect.vue';

const autoTranslateButton = computed(defaultStore.makeGetterSetter('autoTranslateButton'));
const showDetailTimeWhenHover = computed(defaultStore.makeGetterSetter('showDetailTimeWhenHover'));
const noteClickToOpen = computed(defaultStore.makeGetterSetter('noteClickToOpen'));
const enableFallbackReactButton = computed(defaultStore.makeGetterSetter('enableFallbackReactButton'));
const enableMFMCheatsheet = computed(defaultStore.makeGetterSetter('enableMFMCheatsheet'));
const autoSpacingBehaviour = computed(defaultStore.makeGetterSetter('autoSpacingBehaviour'));

definePageMetadata(() => ({
	title: 'Pari Plus!',
	icon: 'ti ti-plus',
}));
</script>
