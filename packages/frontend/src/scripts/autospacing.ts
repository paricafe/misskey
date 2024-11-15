import * as misskey from 'misskey-js';
import { defaultStore } from '@/store.js';

const NO_SPACEING_LIST = [
    'A股',
    'B股',
    'H股',
    'SIM卡',
    'PC端',
    'T恤',
    'A站',
    'B站',
    'C站',
    'N卡',
    'A卡',
    'UP主',
    'X光',
    'B超',
    'Q弹',
];

const LIST_WINDOW = NO_SPACEING_LIST.reduce((a, b) => Math.max(a, b.length), 0) + 1;

const hashtagMap = new Map<string, string>();
let placeholderCounter = 0;

function preserveHashtags(text: string): string {
    placeholderCounter = 0;
    hashtagMap.clear();

    return text.replace(/#[^\s]+/g, (match) => {
        const placeholder = `__HASHTAG_${placeholderCounter}__`;
        hashtagMap.set(placeholder, match);
        placeholderCounter++;
        return placeholder;
    });
}

function restoreHashtags(text: string): string {
    let result = text;
    for (const [placeholder, hashtag] of hashtagMap) {
        result = result.replace(placeholder, hashtag);
    }
    return result;
}

export function autoSpacing(plainText: string) {
    if (defaultStore.reactiveState.autoSpacingBehaviour.value == null) return plainText;

    const textWithPlaceholders = preserveHashtags(plainText);

    const rep = (matched: string, c1: string, c2: string, position: number) => {
        if (defaultStore.reactiveState.autoSpacingBehaviour.value === 'all') return `${c1} ${c2}`;
        const context = plainText
            .slice(Math.max(0, position - LIST_WINDOW), position + LIST_WINDOW)
            .toUpperCase();
        if (NO_SPACEING_LIST.some((text) => context.includes(text))) {
            return matched;
        } else {
            return `${c1} ${c2}`;
        }
    };

    const spacedText = textWithPlaceholders
        .replace(/([\u4e00-\u9fa5\u0800-\u4e00\uac00-\ud7ff])([a-zA-Z0-9])/g, rep)
        .replace(/([a-zA-Z0-9,\.:])([\u4e00-\u9fa5\u0800-\u4e00\uac00-\ud7ff])/g, rep);

    return restoreHashtags(spacedText);
}

export function spacingNote(note: misskey.entities.Note) {
    const noteAsRecord = note as unknown as Record<string, string | null | undefined>;
    if (!noteAsRecord.__autospacing_raw_text) {
        noteAsRecord.__autospacing_raw_text = note.text;
    }
    if (!noteAsRecord.__autospacing_raw_cw) {
        noteAsRecord.__autospacing_raw_cw = note.cw;
    }
    note.text = noteAsRecord.__autospacing_raw_text
        ? autoSpacing(noteAsRecord.__autospacing_raw_text)
        : null;
    note.cw = noteAsRecord.__autospacing_raw_cw
        ? autoSpacing(noteAsRecord.__autospacing_raw_cw)
        : null;
    return note;
}
