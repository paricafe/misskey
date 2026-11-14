/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { walk } from 'oxc-walker';
import { RolldownMagicString } from 'rolldown';
import { assertType } from './utils.js';
import type { ESTree } from 'rolldown/utils';
import type { Plugin } from 'vite';
import type { CallExpression, Expression } from 'estree';

export function pluginRemoveUnrefI18n(
	{
		i18nSymbolName = 'i18n',
	}: {
		i18nSymbolName?: string
	} = {}): Plugin {
	return {
		name: 'UnwindCssModuleClassName',
		renderChunk(code, _chunk, _options, meta) {
			if (!code.includes('unref(i18n)')) return null;
			const ast = this.parse(code);
			const magicString = meta.magicString ?? new RolldownMagicString(code);
			walk(ast, {
				enter(node: ESTree.Node) {
					if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'unref'
						&& node.arguments.length === 1) {
						const arg = node.arguments[0];
						if (arg.type === 'Identifier' && arg.name === i18nSymbolName) {
							assertType<CallExpression>(node);
							assertType<Expression>(arg);
							magicString.remove(node.start, arg.start);
							magicString.remove(arg.end, node.end);
						}
					}
				},
			});

			return magicString;
		},
	};
}
