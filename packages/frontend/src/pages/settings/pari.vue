<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
	<div class="_gaps_m">
		<div class="label">{{ i18n.ts.pariPlusAppearanceSettings }}</div>
		<div class="_gaps_s">
			<MkSelect v-model="defaultFont.fontFace">
				<template #label>Font face</template>
				<template #caption>
					Default font
				</template>
				<option
					v-for="item in defaultFont.fontList"
					:key="item.id"
					:value="item.id"
				>
					{{ item.name }}
				</option>
			</MkSelect>
			<MkRadios v-if="defaultFont.availableTypes.length > 0" v-model="defaultFont.fontFaceType">
				<template #label>Testing feature, may cause slow loading.</template>
				<template #caption>
					Properties
				</template>
				<option
					v-for="item in defaultFont.availableTypes"
					:key="item.id"
					:value="item.id"
				>
					{{ item.name }}
				</option>
			</MkRadios>
        </div>
    </div>
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
			<option value="special">Auto</option>
			<option value="all">{{ i18n.ts.all }}</option>
			<template #caption>{{ i18n.ts.autoSpacingDescription }}</template>
		</MkSelect>
    </div>
</template>

<script lang="ts" setup>
import { computed, ref, watch } from 'vue';
import { i18n } from '@/i18n.js';
import { definePageMetadata } from '@/scripts/page-metadata.js';
import { defaultStore } from '@/store.js';
import { miLocalStorage } from '@/local-storage.js';
import { getDefaultFontSettings } from '@/scripts/font-settings.js';
import MkSwitch from '@/components/MkSwitch.vue';
import MkSelect from '@/components/MkSelect.vue';
import MkRadios from '@/components/MkRadios.vue';

const defaultFont = getDefaultFontSettings();
console.log(defaultFont);

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
