<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :actions="headerActions" :tabs="headerTabs">
	<div class="_spacer" style="--MI_SPACER-w: 800px;">
		<MkPostForm
			v-if="state === 'writing'"
			fixed
			:instant="true"
			:initialText="initialText"
			:initialVisibility="visibility"
			:initialFiles="files"
			:initialLocalOnly="localOnly"
			:reply="reply"
			:renote="renote"
			:initialVisibleUsers="visibleUsers"
			class="_panel"
			@posted="onPosted"
		/>
		<div v-else-if="state === 'posted'" class="_buttonsCenter">
			<MkButton primary @click="close">{{ i18n.ts.close }}</MkButton>
			<MkButton @click="goToMisskey">{{ i18n.ts.goToMisskey }}</MkButton>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>

import { ref, computed } from 'vue';
import * as Misskey from 'misskey-js';
import MkButton from '@/components/MkButton.vue';
import MkPostForm from '@/components/MkPostForm.vue';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { definePage } from '@/page.js';
import { postMessageToParentWindow } from '@/utility/post-message.js';
import { i18n } from '@/i18n.js';

const urlParams = new URLSearchParams(window.location.search);
const localOnlyQuery = urlParams.get('localOnly');
const visibilityQuery = urlParams.get('visibility') as typeof Misskey.noteVisibilities[number];

const state = ref<'fetching' | 'writing' | 'posted'>('fetching');
const title = ref(urlParams.get('title'));
const text = urlParams.get('text');
const url = urlParams.get('url');
const initialText = ref<string | undefined>();
const reply = ref<Misskey.entities.Note | undefined>();
const renote = ref<Misskey.entities.Note | undefined>();
const visibility = ref(Misskey.noteVisibilities.includes(visibilityQuery) ? visibilityQuery : undefined);
const localOnly = ref(localOnlyQuery === '0' ? false : localOnlyQuery === '1' ? true : undefined);
const files = ref([] as Misskey.entities.DriveFile[]);
const visibleUsers = ref([] as Misskey.entities.UserDetailed[]);

async function init() {
	let noteText = '';
	if (title.value) {
		noteText += `[ ${title.value} ]\n`;

		if (text?.startsWith(title.value)) {
			noteText += text.replace(title.value, '').trimStart();
		} else if (text) {
			noteText += `${text}\n`;
		}
	} else if (text) {
		noteText += `${text}\n`;
	}

	if (url) {
		try {
			noteText += new URL(url).href;
		} catch {
			noteText += url;
		}
	}
	initialText.value = noteText.trim();

	if (visibility.value === 'specified') {
		const visibleUserIds = urlParams.get('visibleUserIds');
		const visibleAccts = urlParams.get('visibleAccts');
		await Promise.all(
			[
				...(visibleUserIds ? visibleUserIds.split(',').map(userId => ({ userId })) : []),
				...(visibleAccts ? visibleAccts.split(',').map(Misskey.acct.parse) : []),
			]
			// @ts-expect-error payloadの引数側の型が正常に解決されない
				.map(q => misskeyApi('users/show', q)
					.then(user => {
						visibleUsers.value.push(user);
					}, () => {
						console.error(`Invalid user query: ${JSON.stringify(q)}`);
					}),
				),
		);
	}

	try {
		const replyId = urlParams.get('replyId');
		const replyUri = urlParams.get('replyUri');
		if (replyId) {
			reply.value = await misskeyApi('notes/show', {
				noteId: replyId,
			});
		} else if (replyUri) {
			const obj = await misskeyApi('ap/show', {
				uri: replyUri,
			});
			if (obj.type === 'Note') {
				reply.value = obj.object;
			}
		}

		const renoteId = urlParams.get('renoteId');
		const renoteUri = urlParams.get('renoteUri');
		if (renoteId) {
			renote.value = await misskeyApi('notes/show', {
				noteId: renoteId,
			});
		} else if (renoteUri) {
			const obj = await misskeyApi('ap/show', {
				uri: renoteUri,
			});
			if (obj.type === 'Note') {
				renote.value = obj.object;
			}
		}

		const fileIds = urlParams.get('fileIds');
		if (fileIds) {
			await Promise.all(
				fileIds.split(',')
					.map(fileId => misskeyApi('drive/files/show', { fileId })
						.then(file => {
							files.value.push(file);
						}, () => {
							console.error(`Failed to fetch a file ${fileId}`);
						}),
					),
			);
		}
	} catch (err: any) {
		os.alert({
			type: 'error',
			title: err.message,
			text: err.name,
		});
	}

	state.value = 'writing';
}

init();

function close(): void {
	window.close();

	window.setTimeout(() => {
		window.location.href = '/';
	}, 100);
}

function goToMisskey(): void {
	window.location.href = '/';
}

function onPosted(): void {
	state.value = 'posted';
	postMessageToParentWindow('misskey:shareForm:shareCompleted');
}

const headerActions = computed(() => []);

const headerTabs = computed(() => []);

definePage(() => ({
	title: i18n.ts.share,
	icon: 'ti ti-share',
}));
</script>
