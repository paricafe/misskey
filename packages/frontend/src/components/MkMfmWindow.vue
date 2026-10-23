<!--
SPDX-FileCopyrightText: marie and other Sharkey contributors
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkWindow
	:initialWidth="600"
	:initialHeight="800"
	:canResize="true"
	@closed="emit('closed')"
>
	<template #header>MFM Cheatsheet</template>
	<MkStickyContainer>
		<div class="_spacer" style="--MI_SPACER-w: 800px;">
			<div>{{ i18n.ts._mfm.intro }}</div>
			<br/>
			<div v-for="section in sections" :key="section.title" class="_block">
				<div :class="$style.title">{{ section.title }}</div>
				<p v-if="section.description" :class="$style.description">{{ section.description }}</p>
				<div :class="$style.preview">
					<Mfm :text="section.text"/>
					<MkTextarea v-model="section.text"><template #label>MFM</template></MkTextarea>
				</div>
			</div>
		</div>
	</MkStickyContainer>
</MkWindow>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
import MkWindow from '@/components/MkWindow.vue';
import MkTextarea from '@/components/MkTextarea.vue';
import { i18n } from '@/i18n.js';

const emit = defineEmits<{
	(ev: 'closed'): void;
}>();

const m = i18n.ts._mfm;
const dummy = m.dummy;

const sections = ref([
	{ title: m.mention, description: m.mentionDescription, text: '@example' },
	{ title: m.hashtag, description: m.hashtagDescription, text: '#test' },
	{ title: m.link, description: m.linkDescription, text: `[${dummy}](https://pari.cafe)` },
	{ title: m.emoji, description: m.emojiDescription, text: ':heart:' },
	{ title: m.bold, description: m.boldDescription, text: `**${dummy}**` },
	{ title: 'Italic', text: '<i>italic</i> *italic2*' },
	{ title: m.small, description: m.smallDescription, text: `<small>${dummy}</small>` },
	{ title: m.quote, description: m.quoteDescription, text: `> ${dummy}` },
	{ title: 'Strikethrough', text: '~~Hello world~~' },
	{ title: m.center, description: m.centerDescription, text: `<center>${dummy}</center>` },
	{ title: m.inlineCode, description: m.inlineCodeDescription, text: '`<: "Hello, world!"`' },
	{ title: m.blockCode, description: m.blockCodeDescription, text: '```\n~ (#i, 100) {\n\t<: ? ((i % 15) = 0) "FizzBuzz"\n\t\t.? ((i % 3) = 0) "Fizz"\n\t\t.? ((i % 5) = 0) "Buzz"\n\t\t. i\n}\n```' },
	{ title: 'Ruby', text: '$[ruby 帕里咖啡 PariCafe]' },
	{ title: 'Border', text: '$[border a default border]\n\n$[border.width=2 a thick border]\n\n$[border.style=double,width=5 a double border]\n\n$[border.color=0f0 a green border]\n\n$[border.radius=10 a rounded border]' },
	{ title: m.search, description: m.searchDescription, text: `${dummy} [search]\n${dummy} [検索]` },
	{ title: m.flip, description: m.flipDescription, text: `$[flip ${dummy}]\n$[flip.v ${dummy}]\n$[flip.h,v ${dummy}]` },
	{ title: m.font, description: m.fontDescription, text: `$[font.serif ${dummy}]\n$[font.monospace ${dummy}]` },
	{ title: m.x2, description: m.x2Description, text: '$[x2 ☕]' },
	{ title: m.x3, description: m.x3Description, text: '$[x3 ☕]' },
	{ title: m.x4, description: m.x4Description, text: '$[x4 ☕]' },
	{ title: m.blur, description: m.blurDescription, text: `$[blur ${dummy}]` },
	{ title: m.jelly, description: m.jellyDescription, text: '$[jelly ☕] $[jelly.speed=3s ☕] $[jelly.delay=3s ☕] $[jelly.loop=3 ☕]' },
	{ title: m.tada, description: m.tadaDescription, text: '$[tada ☕] $[tada.speed=3s ☕] $[tada.delay=3s ☕] $[tada.loop=3 ☕]' },
	{ title: m.jump, description: m.jumpDescription, text: '$[jump ☕] $[jump.speed=3s ☕] $[jump.delay=3s ☕] $[jump.loop=3 ☕]' },
	{ title: m.bounce, description: m.bounceDescription, text: '$[bounce ☕] $[bounce.speed=3s ☕] $[bounce.delay=3s ☕] $[bounce.loop=3 ☕]' },
	{ title: m.spin, description: m.spinDescription, text: '$[spin ☕] $[spin.left ☕] $[spin.alternate ☕]\n$[spin.x ☕] $[spin.x,left ☕] $[spin.x,alternate ☕]\n$[spin.y ☕] $[spin.y,left ☕] $[spin.y,alternate ☕]\n\n$[spin.speed=3s ☕] $[spin.delay=3s ☕] $[spin.loop=3 ☕]' },
	{ title: m.shake, description: m.shakeDescription, text: '$[shake ☕] $[shake.speed=3s ☕] $[shake.delay=3s ☕] $[shake.loop=3 ☕]' },
	{ title: m.twitch, description: m.twitchDescription, text: '$[twitch ☕] $[twitch.speed=3s ☕] $[twitch.delay=3s ☕] $[twitch.loop=3 ☕]' },
	{ title: m.rainbow, description: m.rainbowDescription, text: '$[rainbow ☕] $[rainbow.speed=3s ☕] $[rainbow.delay=3s ☕] $[rainbow.loop=3 ☕]' },
	{ title: m.sparkle, description: m.sparkleDescription, text: '$[sparkle ☕]' },
	{ title: m.rotate, description: m.rotateDescription, text: '$[rotate ☕]\n$[rotate.deg=45 ☕]\n$[rotate.x,deg=45 Hello, world!]' },
	{ title: m.position, description: m.positionDescription, text: '$[position.y=-1 ☕]\n$[position.x=-1 ☕]' },
	{ title: m.scale, description: m.scaleDescription, text: '$[scale.x=1.3 ☕]\n$[scale.x=1.5,y=3 ☕]\n$[scale.y=0.3 ☕]' },
	{ title: m.foreground, description: m.foregroundDescription, text: '$[fg.color=eb6f92 Text color]' },
	{ title: m.background, description: m.backgroundDescription, text: '$[bg.color=31748f Background color]' },
	{ title: m.plain, description: m.plainDescription, text: '<plain>**bold** @mention #hashtag `code` $[x2 ☕]</plain>' },
]);
</script>

<style lang="scss" module>
.title {
	position: sticky;
	z-index: 1;
	top: var(--MI-stickyTop, 0px);
	padding: 16px;
	font-weight: bold;
	font-size: 1.1em;
	-webkit-backdrop-filter: var(--MI-blur, blur(10px));
	backdrop-filter: var(--MI-blur, blur(10px));
	background-color: color-mix(in srgb, var(--MI_THEME-panel) 70%, transparent);
}

.description {
	margin: 0;
	padding: 0 16px 16px;
}

.preview {
	border-top: solid 0.5px var(--MI_THEME-divider);
	padding: 16px;
}
</style>
