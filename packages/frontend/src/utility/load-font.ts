const defaultFontsList = [
	'roboto',
	'misskey-biz',
	'arial',
	'times',
	'system-ui',
];

export async function loadFontStyle(fontId: string) {
	if (defaultFontsList.includes(fontId)) return;
	try {
		await import(`@/styles-font/${fontId}.scss`);
	} catch (err) {
		console.warn(`Failed to load font style: ${fontId}`, err);
	}
}
