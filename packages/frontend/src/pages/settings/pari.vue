<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
	<div class="_gaps_m">
		<MkSwitch v-model="autoTranslateButton">
			<template #label>{{ i18n.ts.autoTranslateButton }}</template>
		</MkSwitch>
	
	</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { i18n } from '@/i18n.js';
import { definePageMetadata } from '@/scripts/page-metadata.js';
import { defaultStore } from '@/store.js';
import MkSwitch from '@/components/MkSwitch.vue';

const autoTranslateButton = computed(defaultStore.makeGetterSetter('autoTranslateButton'));

definePageMetadata(() => ({
	title: 'Pari Cafe',
	icon: 'ti ti-plus',
}));
</script>
