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
				<MkPreferenceContainer k="enableTranslateButton">
					<MkSwitch v-model="enableTranslateButton">{{ i18n.ts.enableTranslateButton }}</MkSwitch>
				</MkPreferenceContainer>
				<MkPreferenceContainer k="showDetailTimeWhenHover">
					<MkSwitch v-model="showDetailTimeWhenHover">{{ i18n.ts.showDetailTimeWhenHover }}</MkSwitch>
				</MkPreferenceContainer>
				<MkPreferenceContainer k="noteClickToOpen">
					<MkSwitch v-model="noteClickToOpen">{{ i18n.ts.noteClickToOpen }}</MkSwitch>
				</MkPreferenceContainer>
				<MkPreferenceContainer k="enableFallbackReactButton">
					<MkSwitch v-model="enableFallbackReactButton">{{ i18n.ts.enableFallbackReactButton }}</MkSwitch>
				</MkPreferenceContainer>
				<MkPreferenceContainer k="enableMFMCheatsheet">
					<MkSwitch v-model="enableMFMCheatsheet">{{ i18n.ts.enableMFMCheatsheet }}</MkSwitch>
				</MkPreferenceContainer>
				<MkPreferenceContainer k="enableUndoClearPostForm">
					<MkSwitch v-model="enableUndoClearPostForm">{{ i18n.ts.enableUndoClearPostForm }}</MkSwitch>
				</MkPreferenceContainer>
				<MkPreferenceContainer k="collapseNotesRepliedTo">
					<MkSwitch v-model="collapseNotesRepliedTo">{{ i18n.ts.collapseNotesRepliedTo }}</MkSwitch>
				</MkPreferenceContainer>
				<MkPreferenceContainer k="alwaysCollapseRenotes">
					<MkSwitch v-model="alwaysCollapseRenotes">{{ i18n.ts.alwaysCollapseRenotes }}</MkSwitch>
				</MkPreferenceContainer>
				<MkPreferenceContainer k="collapseEverything">
					<MkSwitch v-model="collapseEverything"><template #label>{{ i18n.ts.collapseEverything }}</template></MkSwitch>
					<template #caption><i class="ti ti-alert-triangle" style="color: var(--MI_THEME-warn);"></i>{{ i18n.ts.collapseEverythingDescription }}</template>
				</MkPreferenceContainer>
				<MkPreferenceContainer k="disableReactionsViewer">
					<MkSwitch v-model="disableReactionsViewer">{{ i18n.ts.disableReactionsViewer }}</MkSwitch>
				</MkPreferenceContainer>
				<MkPreferenceContainer k="emojiAutoSpacing">
					<MkSwitch v-model="emojiAutoSpacing">{{ i18n.ts.emojiAutoSpacing }}</MkSwitch>
				</MkPreferenceContainer>
				<MkPreferenceContainer k="clickToShowInstanceTickerWindow">
					<MkSwitch v-model="clickToShowInstanceTickerWindow">{{ i18n.ts.clickToShowInstanceTickerWindow }}</MkSwitch>
				</MkPreferenceContainer>
				<MkPreferenceContainer k="autoSpacingBehaviour">
					<MkSelect v-model="autoSpacingBehaviour">
						<template #label>{{ i18n.ts.autoSpacing }}</template>
						<option :value="null">{{ i18n.ts.disabled }}</option>
						<option value="special">Auto</option>
						<option value="all">{{ i18n.ts.all }}</option>
						<template #caption>{{ i18n.ts.autoSpacingDescription }}</template>
					</MkSelect>
				</MkPreferenceContainer>
			</div>
		</div>
	</FormSection>
</div>
</template>

<script lang="ts" setup>
import { computed, ref } from 'vue';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import { prefer } from '@/preferences.js';
import { miLocalStorage } from '@/local-storage.js';
import { getDefaultFontSettings } from '@/utility/font-settings.js';
import MkSwitch from '@/components/MkSwitch.vue';
import MkSelect from '@/components/MkSelect.vue';
import MkRadios from '@/components/MkRadios.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkRange from '@/components/MkRange.vue';
import MkButton from '@/components/MkButton.vue';
import FormSection from '@/components/form/section.vue';
import MkPreferenceContainer from '@/components/MkPreferenceContainer.vue';

const defaultFont = getDefaultFontSettings();
console.log(defaultFont);

const fontSizeNumber = ref(Number(miLocalStorage.getItem('fontSize') ?? 1));
const fontSizeNumberOld = ref(fontSizeNumber.value);

const fontSizePx = computed(() => fontSizeNumber.value + 14);

function saveFontSize() {
	miLocalStorage.setItem('fontSize', fontSizeNumber.value.toString());
	window.document.documentElement.classList.remove('f-' + fontSizeNumberOld.value);
	window.document.documentElement.classList.add('f-' + fontSizeNumber.value);
	fontSizeNumberOld.value = fontSizeNumber.value;
}

const enableTranslateButton = prefer.model('enableTranslateButton');
const showDetailTimeWhenHover = prefer.model('showDetailTimeWhenHover');
const noteClickToOpen = prefer.model('noteClickToOpen');
const enableFallbackReactButton = prefer.model('enableFallbackReactButton');
const enableMFMCheatsheet = prefer.model('enableMFMCheatsheet');
const enableUndoClearPostForm = prefer.model('enableUndoClearPostForm');
const autoSpacingBehaviour = prefer.model('autoSpacingBehaviour');
const collapseNotesRepliedTo = prefer.model('collapseNotesRepliedTo');
const alwaysCollapseRenotes = prefer.model('alwaysCollapseRenotes');
const collapseEverything = prefer.model('collapseEverything');
const disableReactionsViewer = prefer.model('disableReactionsViewer');
const emojiAutoSpacing = prefer.model('emojiAutoSpacing');
const clickToShowInstanceTickerWindow = prefer.model('clickToShowInstanceTickerWindow');

definePage(() => ({
	title: 'Pari Plus!',
	icon: 'ti ti-plus',
}));
</script>
