<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps_m">
	<MkInfo>
		{{ i18n.ts.pariPlusInfo }}
	</MkInfo>
	<FormSection>
		<div class="_gaps_m">
			<div class="label">{{ i18n.ts.pariPlusSystemSettings }}</div>
			<div class="_gaps_s">
				<MkSwitch v-model="useHardwareAcceleration">{{ i18n.ts.useHardwareAcceleration }}</MkSwitch>
				<MkSwitch v-model="enableRenderingOptimization">{{ i18n.ts.enableRenderingOptimization }}</MkSwitch>
			</div>
		</div>
	</FormSection>
	<FormSection>
		<div class="_gaps_m">
			<div class="label">{{ i18n.ts.pariPlusAppearanceSettings }}</div>
			<div class="_gaps_s">
				<MkRange v-model="fontSizeNumber" :min="0" :max="10" :step="1" continuousUpdate>
					<template #label>{{ i18n.ts.fontSize }}</template>
					<template #caption>
						<div :style="`font-size: ${fontSizePx}px;`">
							<span>
								A quick brown fox jumps over the lazy dog<br>
								一只敏捷的棕色狐狸跳过那只懒狗<br>
								機敏な茶色のキツネが怠惰な犬を飛び越える<br>
							</span>
							<MkButton v-if="fontSizeNumber !== fontSizeNumberOld" @click.stop="saveFontSize">{{ i18n.ts.save }}</MkButton>
						</div>
					</template>
				</MkRange>
				<MkSelect v-model="defaultFont.fontFace">
					<template #label>{{ i18n.ts.pariPlusFontPicker }}</template>
					<template #caption>
						Testing feature, may cause slow loading.
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
					<template #label>{{ i18n.ts.appearance }}</template>
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
	</FormSection>

	<FormSection>
		<div class="_gaps_m">
			<div class="label">{{ i18n.ts.pariPlusNoteSettings }}</div>
			<div class="_gaps_s">
				<MkSwitch v-model="autoTranslateButton">{{ i18n.ts.autoTranslateButton }}</MkSwitch>
				<MkSwitch v-model="showDetailTimeWhenHover">{{ i18n.ts.showDetailTimeWhenHover }}</MkSwitch>
				<MkSwitch v-model="noteClickToOpen">{{ i18n.ts.noteClickToOpen }}</MkSwitch>
				<MkSwitch v-model="enableFallbackReactButton">{{ i18n.ts.enableFallbackReactButton }}</MkSwitch>
				<MkSwitch v-model="enableMFMCheatsheet">{{ i18n.ts.enableMFMCheatsheet }}</MkSwitch>
				<MkSwitch v-model="enableUndoClearPostForm">{{ i18n.ts.enableUndoClearPostForm }}</MkSwitch>
				<MkSwitch v-model="collapseNotesRepliedTo">{{ i18n.ts.collapseNotesRepliedTo }}</MkSwitch>
				<MkSwitch v-model="disableReactionsViewer">{{ i18n.ts.disableReactionsViewer }}</MkSwitch>
				<MkSwitch v-model="collapsedUnexpectedLangs">{{ i18n.ts.collapsedUnexpectedLangs }}</MkSwitch>
				<MkSwitch v-model="emojiAutoSpacing">{{ i18n.ts.emojiAutoSpacing }}</MkSwitch>
				<MkSwitch v-model="insertNewNotes">
					<template #label>{{ i18n.ts.insertNewNotes }}</template>
					<template #caption>{{ i18n.ts.insertNewNotesDescription }}</template>
				</MkSwitch>
				<MkSwitch v-model="clickToShowInstanceTickerWindow">{{ i18n.ts.clickToShowInstanceTickerWindow }}</MkSwitch>
				<MkSelect v-model="autoSpacingBehaviour">
					<template #label>{{ i18n.ts.autoSpacing }}</template>
					<option :value="null">{{ i18n.ts.disabled }}</option>
					<option value="special">Auto</option>
					<option value="all">{{ i18n.ts.all }}</option>
					<template #caption>{{ i18n.ts.autoSpacingDescription }}</template>
				</MkSelect>
		    </div>
		</div>
	</FormSection>
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
import MkInfo from '@/components/MkInfo.vue';
import MkRange from '@/components/MkRange.vue';
import MkButton from '@/components/MkButton.vue';
import FormSection from '@/components/form/section.vue';

const defaultFont = getDefaultFontSettings();
console.log(defaultFont);

const fontSizeNumber = ref(Number(miLocalStorage.getItem('fontSize') || 1));
const fontSizeNumberOld = ref(fontSizeNumber.value);

const fontSizePx = computed(() => fontSizeNumber.value + 14);

function saveFontSize() {
	miLocalStorage.setItem('fontSize', fontSizeNumber.value.toString());
	window.document.documentElement.classList.remove('f-' + fontSizeNumberOld.value);
	window.document.documentElement.classList.add('f-' + fontSizeNumber.value);
	fontSizeNumberOld.value = fontSizeNumber.value;
}

const useHardwareAcceleration = computed(defaultStore.makeGetterSetter('useHardwareAcceleration'));
const enableRenderingOptimization = computed(defaultStore.makeGetterSetter('enableRenderingOptimization'));

const autoTranslateButton = computed(defaultStore.makeGetterSetter('autoTranslateButton'));
const showDetailTimeWhenHover = computed(defaultStore.makeGetterSetter('showDetailTimeWhenHover'));
const noteClickToOpen = computed(defaultStore.makeGetterSetter('noteClickToOpen'));
const enableFallbackReactButton = computed(defaultStore.makeGetterSetter('enableFallbackReactButton'));
const enableMFMCheatsheet = computed(defaultStore.makeGetterSetter('enableMFMCheatsheet'));
const enableUndoClearPostForm = computed(defaultStore.makeGetterSetter('enableUndoClearPostForm'));
const autoSpacingBehaviour = computed(defaultStore.makeGetterSetter('autoSpacingBehaviour'));
const collapseNotesRepliedTo = computed(defaultStore.makeGetterSetter('collapseNotesRepliedTo'));
const disableReactionsViewer = computed(defaultStore.makeGetterSetter('disableReactionsViewer'));
const collapsedUnexpectedLangs = computed(defaultStore.makeGetterSetter('collapsedUnexpectedLangs'));
const emojiAutoSpacing = computed(defaultStore.makeGetterSetter('emojiAutoSpacing'));
const insertNewNotes = computed(defaultStore.makeGetterSetter('insertNewNotes'));
const clickToShowInstanceTickerWindow = computed(defaultStore.makeGetterSetter('clickToShowInstanceTickerWindow'));

definePageMetadata(() => ({
	title: 'Pari Plus!',
	icon: 'ti ti-plus',
}));
</script>
