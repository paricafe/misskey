/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/// <reference lib="esnext" />

import { parse as vueSfcParse } from 'vue/compiler-sfc';
import {
	createLogger,
	type EnvironmentModuleGraph,
	type LogErrorOptions,
	type LogOptions,
	normalizePath,
	type Plugin,
	type PluginOption,
} from 'vite';
import fs from 'node:fs';
import JSON5 from 'json5';
import { RolldownMagicString } from 'rolldown';
import type { TransformResult } from 'rolldown';
import path from 'node:path'
import { hash, toBase62 } from '../vite.config';
import { minimatch } from 'minimatch';
import {
	type AttributeNode,
	type DirectiveNode,
	type ElementNode,
	ElementTypes,
	NodeTypes,
	type RootNode,
	type SimpleExpressionNode,
	type TemplateChildNode,
} from '@vue/compiler-core';

export interface SearchIndexItem {
	id: string;
	parentId?: string;
	path?: string;
	label: string;
	keywords: string[];
	texts: string[];
	icon?: string;
	inlining?: string[];
}

export type Options = {
	targetFilePaths: string[],
	mainVirtualModule: string,
	modulesToHmrOnUpdate: string[],
	fileVirtualModulePrefix?: string,
	fileVirtualModuleSuffix?: string,
	verbose?: boolean,
};

interface MarkerRelation {
	parentId?: string;
	markerId: string;
	node: ElementNode;
}

let logger = {
	info: (msg: string, options?: LogOptions) => { },
	warn: (msg: string, options?: LogOptions) => { },
	error: (msg: string, options?: LogErrorOptions) => { },
};
let loggerInitialized = false;

function initLogger(options: Options) {
	if (loggerInitialized) return;
	loggerInitialized = true;
	const viteLogger = createLogger(options.verbose ? 'info' : 'warn');

	logger.info = (msg, options) => {
		msg = `[create-search-index] ${msg}`;
		viteLogger.info(msg, options);
	}

	logger.warn = (msg, options) => {
		msg = `[create-search-index] ${msg}`;
		viteLogger.warn(msg, options);
	}

	logger.error = (msg, options) => {
		msg = `[create-search-index] ${msg}`;
		viteLogger.error(msg, options);
	}
}

type WalkVueNode = RootNode | TemplateChildNode | SimpleExpressionNode;

function walkVueElements<C extends {} | null>(nodes: WalkVueNode[], context: C, callback: (node: ElementNode, context: C) => C | undefined | void | false): void {
	for (const node of nodes) {
		let currentContext = context;
		if (node.type === NodeTypes.COMPOUND_EXPRESSION) throw new Error("Unexpected COMPOUND_EXPRESSION");
		if (node.type === NodeTypes.ELEMENT) {
			const result = callback(node, context);
			if (result === false) return;
			if (result !== undefined) currentContext = result;
		}
		if ('children' in node) {
			walkVueElements(node.children, currentContext, callback);
		}
	}
}

function findAttribute(props: Array<AttributeNode | DirectiveNode>, name: string): AttributeNode | DirectiveNode | null {
	for (const prop of props) {
		switch (prop.type) {
			case NodeTypes.ATTRIBUTE:
				if (prop.name === name) {
					return prop;
				}
				break;
			case NodeTypes.DIRECTIVE:
				if (prop.name === 'bind' && prop.arg && 'content' in prop.arg && prop.arg.content === name) {
					return prop;
				}
				break;
		}
	}
	return null;
}

function findEndOfStartTagAttributes(node: ElementNode): number {
	if (node.children.length > 0) {
		const nodeStart = node.loc.start.offset;
		const firstChildStart = node.children[0].loc.start.offset;
		const endOfStartTag = node.loc.source.lastIndexOf('>', firstChildStart - nodeStart);
		if (endOfStartTag === -1) throw new Error("Bug: Failed to find end of start tag");
		return nodeStart + endOfStartTag;
	} else {
		return node.isSelfClosing ? node.loc.end.offset - 1 : node.loc.end.offset;
	}
}

function generateJavaScriptCode(resolvedRootMarkers: SearchIndexItem[]): string {
	return `import { i18n } from '@/i18n.js';\n`
		+ `export const searchIndexes = ${customStringify(resolvedRootMarkers)};\n`;
}

function customStringify(obj: unknown): string {
	return JSON.stringify(obj).replaceAll(/"(.*?)"/g, (all, group) => {
		return group.includes('${') ? '`' + group + '`' : all;
	});
}

function extractElementText(node: ElementNode, id: string): string | null {
	return extractElementTextChecked(node, node.tag, id);
}

function extractElementTextChecked(node: ElementNode, processingNodeName: string, id: string): string | null {
	const result: string[] = [];
	for (const child of node.children) {
		const text = extractElementText2Inner(child, processingNodeName, id);
		if (text == null) return null;
		result.push(text);
	}
	return result.join('');
}

function extractElementText2Inner(node: TemplateChildNode, processingNodeName: string, id: string): string | null {
	if (node.type === NodeTypes.COMPOUND_EXPRESSION) throw new Error("Unexpected COMPOUND_EXPRESSION");

	switch (node.type) {
		case NodeTypes.INTERPOLATION: {
			const expr = node.content;
			if (expr.type === NodeTypes.COMPOUND_EXPRESSION) throw new Error(`Unexpected COMPOUND_EXPRESSION`);
			const exprResult = evalExpression(expr.content);
			if (typeof exprResult !== 'string') {
				logger.error(`Result of interpolation node is not string at line ${id}:${node.loc.start.line}`);
				return null;
			}
			return exprResult;
		}
		case NodeTypes.ELEMENT:
			if (node.tagType === ElementTypes.ELEMENT) {
				return extractElementTextChecked(node, processingNodeName, id);
			} else {
				logger.error(`Unexpected ${node.tag} extracting text of ${processingNodeName} ${id}:${node.loc.start.line}`);
				return null;
			}
		case NodeTypes.TEXT:
			return node.content;
		case NodeTypes.COMMENT:
			return '';
		case NodeTypes.IF:
		case NodeTypes.IF_BRANCH:
		case NodeTypes.FOR:
		case NodeTypes.TEXT_CALL:
			logger.error(`Unexpected controlflow element extracting text of ${processingNodeName} ${id}:${node.loc.start.line}`);
			return null;
	}
}

function extractSugarTags(nodes: TemplateChildNode[], id: string): { label: string | null; texts: string[]; icon: string | null; } {
	let label: string | null | undefined = undefined;
	let icon: string | null | undefined = undefined;
	const texts: string[] = [];

	logger.info(`Extracting labels and texts from ${nodes.length} nodes`);

	walkVueElements(nodes, null, (node) => {
		switch (node.tag) {
			case 'SearchMarker':
				return false;
			case 'SearchLabel':
				if (label !== undefined) {
					logger.warn(`Duplicate SearchLabel found, ignoring the second one at ${id}:${node.loc.start.line}`);
					break;
				}

				label = extractElementText(node, id);
				return;
			case 'SearchText':
				const content = extractElementText(node, id);
				if (content) {
					texts.push(content);
				}
				return;
			case 'SearchIcon':
				if (icon !== undefined) {
					logger.warn(`Duplicate SearchIcon found, ignoring the second one at ${id}:${node.loc.start.line}`);
					break;
				}

				if (node.children.length !== 1) {
					logger.error(`SearchIcon must have exactly one child at ${id}:${node.loc.start.line}`);
					return;
				}

				const iconNode = node.children[0];
				if (iconNode.type !== NodeTypes.ELEMENT) {
					logger.error(`SearchIcon must have a child element at ${id}:${node.loc.start.line}`);
					return;
				}
				icon = getStringProp(findAttribute(iconNode.props, 'class'), id);
				return;
		}

		return;
	});

	logger.info(`Extraction completed: label=${label}, text=[${texts.join(', ')}, icon=${icon}]`);
	return { label: label ?? null, texts, icon: icon ?? null };
}

function getStringProp(attr: AttributeNode | DirectiveNode | null, id: string): string | null {
	switch (attr?.type) {
		case null:
		case undefined:
			return null;
		case NodeTypes.ATTRIBUTE:
			return attr.value?.content ?? null;
		case NodeTypes.DIRECTIVE:
			if (attr.exp == null) return null;
			if (attr.exp.type === NodeTypes.COMPOUND_EXPRESSION) throw new Error('Unexpected COMPOUND_EXPRESSION');
			const value = evalExpression(attr.exp.content ?? '');
			if (typeof value !== 'string') {
				logger.error(`Expected string value, got ${typeof value} at ${id}:${attr.loc.start.line}`);
				return null;
			}
			return value;
	}
}

function getStringArrayProp(attr: AttributeNode | DirectiveNode | null, id: string): string[] | null {
	switch (attr?.type) {
		case null:
		case undefined:
			return null;
		case NodeTypes.ATTRIBUTE:
			logger.error(`Expected directive, got attribute at ${id}:${attr.loc.start.line}`);
			return null;
		case NodeTypes.DIRECTIVE:
			if (attr.exp == null) return null;
			if (attr.exp.type === NodeTypes.COMPOUND_EXPRESSION) throw new Error('Unexpected COMPOUND_EXPRESSION');
			const value = evalExpression(attr.exp.content ?? '');
			if (!Array.isArray(value) || !value.every(x => typeof x === 'string')) {
				logger.error(`Expected string array value, got ${typeof value} at ${id}:${attr.loc.start.line}`);
				return null;
			}
			return value;
	}
}

function extractUsageInfoFromTemplateAst(
	templateAst: RootNode | undefined,
	id: string,
): SearchIndexItem[] {
	const allMarkers: SearchIndexItem[] = [];
	const markerMap = new Map<string, SearchIndexItem>();

	if (!templateAst) return allMarkers;

	walkVueElements<string | null>([templateAst], null, (node, parentId) => {
		if (node.tag !== 'SearchMarker') {
			return;
		}

		const markerIdProp = node.props?.find(p => p.name === 'markerId');
		const markerId = markerIdProp?.type == NodeTypes.ATTRIBUTE ? markerIdProp.value?.content : null;

		if (markerId == null) {
			logger.error(`Marker ID not found for node: ${JSON.stringify(node)}`);
			throw new Error(`Marker ID not found in file ${id}`);
		}

		const markerInfo: SearchIndexItem = {
			id: markerId,
			parentId: parentId ?? undefined,
			label: '',
			keywords: [],
			texts: [],
		};

		const path = getStringProp(findAttribute(node.props, 'path'), id);
		const icon = getStringProp(findAttribute(node.props, 'icon'), id);
		const label = getStringProp(findAttribute(node.props, 'label'), id);
		const inlining = getStringArrayProp(findAttribute(node.props, 'inlining'), id);
		const keywords = getStringArrayProp(findAttribute(node.props, 'keywords'), id);
		const texts = getStringArrayProp(findAttribute(node.props, 'texts'), id);

		if (path) markerInfo.path = path;
		if (icon) markerInfo.icon = icon;
		if (label) markerInfo.label = label;
		if (inlining) markerInfo.inlining = inlining;
		if (keywords) markerInfo.keywords = keywords;
		if (texts) markerInfo.texts = texts;

		if (markerInfo.path == null && parentId == null) {
			markerInfo.path = id.match(/.*(\/(admin|settings)\/[^\/]+)\.vue$/)?.[1];
		}

		{
			const extracted = extractSugarTags(node.children, id);
			if (extracted.label && markerInfo.label) logger.warn(`Duplicate label found for ${markerId} at ${id}:${node.loc.start.line}`);
			if (extracted.icon && markerInfo.icon) logger.warn(`Duplicate icon found for ${markerId} at ${id}:${node.loc.start.line}`);
			markerInfo.label = extracted.label ?? markerInfo.label ?? '';
			markerInfo.texts = [...extracted.texts, ...markerInfo.texts];
			markerInfo.icon = extracted.icon ?? markerInfo.icon ?? undefined;
		}

		if (!markerInfo.label) {
			logger.warn(`No label found for ${markerId} at ${id}:${node.loc.start.line}`);
		}

		markerMap.set(markerId, markerInfo);
		allMarkers.push(markerInfo);
		return markerId;
	});

	return allMarkers;
}

function evalExpression(expr: string): unknown {
	const rarResult = Function('i18n', `return ${expr}`)(i18nProxy);
	return JSON.parse(JSON.stringify(rarResult));
}

const propertyAccessProxySymbol = Symbol('propertyAccessProxySymbol');

type AccessProxy = {
	[propertyAccessProxySymbol]: string[],
	[k: string]: AccessProxy,
}

const propertyAccessProxyHandler: ProxyHandler<AccessProxy> = {
	get(target: AccessProxy, p: string | symbol): any {
		if (p in target) {
			return (target as any)[p];
		}
		if (p == "toJSON" || p == Symbol.toPrimitive) {
			return propertyAccessProxyToJSON;
		}
		if (typeof p == 'string') {
			return target[p] = propertyAccessProxy([...target[propertyAccessProxySymbol], p]);
		}
		return undefined;
	}
}

function propertyAccessProxyToJSON(this: AccessProxy, hint: string) {
	const expression = this[propertyAccessProxySymbol].reduce((prev, current) => {
		if (current.match(/^[a-z][0-9a-z]*$/i)) {
			return `${prev}.${current}`;
		} else {
			return `${prev}['${current}']`;
		}
	});
	return '$\{' + expression + '}';
}

function propertyAccessProxy(path: string[]): AccessProxy {
	const target: AccessProxy = {
		[propertyAccessProxySymbol]: path,
	};
	return new Proxy(target, propertyAccessProxyHandler);
}

const i18nProxy = propertyAccessProxy(['i18n']);

export function collectFileMarkers(id: string, code: string | RolldownMagicString | undefined): SearchIndexItem[] {
	try {
		let codeStr: string;
		if (typeof code === 'string') {
			codeStr = code;
		} else if (code != null) {
			codeStr = code.toString();
		} else {
			throw new Error(`Code is undefined for file ${id}`);
		}

		const { descriptor, errors } = vueSfcParse(codeStr, {
			filename: id,
		});

		if (errors.length > 0) {
			logger.error(`Compile Error: ${id}, ${errors}`);
			return [];
		}

		return extractUsageInfoFromTemplateAst(descriptor.template?.ast, id);
	} catch (error) {
		let _error = error instanceof Error ? error : new Error(String(error));
		logger.error(`Error analyzing file ${id}:`, { error: _error });
	}

	return [];
}

type TransformedCode = Exclude<TransformResult, string>;

export class MarkerIdAssigner {
	private cache: Map<string, TransformedCode>;

	constructor() {
		this.cache = new Map();
	}

	public onInvalidate(id: string) {
		this.cache.delete(id);
	}

	public processFile(id: string, code: string): TransformedCode {
		if (this.cache.has(id)) {
			return this.cache.get(id)!;
		}
		const transformed = this.#processImpl(id, code);
		this.cache.set(id, transformed);
		return transformed;
	}

	#processImpl(id: string, code: string): TransformedCode {
		const s = new RolldownMagicString(code);

		const parsed = vueSfcParse(code, { filename: id });
		if (!parsed.descriptor.template) {
			return {
				code,
			};
		}
		const ast = parsed.descriptor.template.ast;
		const markerRelations: MarkerRelation[] = [];

		if (!ast) {
			return {
				code,
			};
		}

		walkVueElements<string | null>([ast], null, (node, parentId) => {
			if (node.tag !== 'SearchMarker') return;

			const markerIdProp = findAttribute(node.props, 'markerId');

			let nodeMarkerId: string;
			if (markerIdProp != null) {
				if (markerIdProp.type !== NodeTypes.ATTRIBUTE) return logger.error(`markerId must be a attribute at ${id}:${markerIdProp.loc.start.line}`);
				if (markerIdProp.value == null) return logger.error(`markerId must have a value at ${id}:${markerIdProp.loc.start.line}`);
				nodeMarkerId = markerIdProp.value.content;
			} else {
				const idKey = id.replace(/\\/g, '/').split('packages/frontend/')[1]
				const generatedMarkerId = toBase62(hash(`${idKey}:${node.loc.start.line}`));

				const endOfStartTag = findEndOfStartTagAttributes(node);
				s.appendRight(endOfStartTag, ` markerId="${generatedMarkerId}" data-in-app-search-marker-id="${generatedMarkerId}"`);

				nodeMarkerId = generatedMarkerId;
			}

			markerRelations.push({
				parentId: parentId ?? undefined,
				markerId: nodeMarkerId,
				node: node,
			});

			return nodeMarkerId;
		})

		const parentChildrenMap = new Map<string, string[]>();

		markerRelations.forEach(relation => {
			if (relation.parentId) {
				if (!parentChildrenMap.has(relation.parentId)) {
					parentChildrenMap.set(relation.parentId, []);
				}
				parentChildrenMap.get(relation.parentId)!.push(relation.markerId);
			}
		});

		for (const [parentId, childIds] of parentChildrenMap.entries()) {
			const parentRelation = markerRelations.find(r => r.markerId === parentId);
			if (!parentRelation) continue;

			const parentNode = parentRelation.node;
			const childrenProp = findAttribute(parentNode.props, 'children');
			if (childrenProp != null) {
				if (childrenProp.type !== NodeTypes.DIRECTIVE) {
					console.error(`children prop should be directive (:children) at ${id}:${childrenProp.loc.start.line}`);
					continue;
				}

				const childrenValue = getStringArrayProp(childrenProp, id);
				if (childrenValue == null) continue;

				const newValue: string[] = [...childrenValue];
				for (const childId of [...childIds]) {
					if (!newValue.includes(childId)) {
						newValue.push(childId);
					}
				}

				const expression = JSON.stringify(newValue).replaceAll(/"/g, "'");
				s.overwrite(childrenProp.exp!.loc.start.offset, childrenProp.exp!.loc.end.offset, expression);
				logger.info(`Added ${childIds.length} child markerIds to existing :children in ${id}`);
			} else {
				const endOfParentStartTag = findEndOfStartTagAttributes(parentNode);
				s.appendRight(endOfParentStartTag, ` :children="${JSON5.stringify(childIds).replace(/"/g, "'")}"`);
				logger.info(`Created new :children attribute with ${childIds.length} markerIds in ${id}`);
			}
		}

		return {
			code: s.toString(),
		};
	}

	async getOrLoad(id: string) {
		let code = this.getCached(id)?.code;
		if (code != null) {
			return code;
		}

		const originalCode = await fs.promises.readFile(id, 'utf-8');

		code = this.getCached(id)?.code;
		if (code != null) {
			return code;
		}

		code = this.processFile(id, originalCode)?.code;
		return code;
	}

	getCached(id: string) {
		return this.cache.get(id);
	}
}

export default function pluginCreateSearchIndex(options: Options): PluginOption {
	const assigner = new MarkerIdAssigner();
	return [
		createSearchIndex(options, assigner),
		pluginCreateSearchIndexVirtualModule(options, assigner),
	]
}

function createSearchIndex(options: Options, assigner: MarkerIdAssigner): Plugin {
	initLogger(options);
	const root = normalizePath(process.cwd());

	function isTargetFile(id: string): boolean {
		const relativePath = path.posix.relative(root, id);
		return options.targetFilePaths.some(pat => minimatch(relativePath, pat))
	}

	return {
		name: 'autoAssignMarkerId',
		enforce: 'pre',

		watchChange(id) {
			assigner.onInvalidate(id);
		},

		async transform(code, id) {
			if (!id.endsWith('.vue')) {
				return;
			}

			if (!isTargetFile(id)) {
				return;
			}

			return assigner.processFile(id, code);
		},
	};
}

export function pluginCreateSearchIndexVirtualModule(options: Options, asigner: MarkerIdAssigner): Plugin {
	const searchIndexPrefix = options.fileVirtualModulePrefix ?? 'search-index-individual:';
	const searchIndexSuffix = options.fileVirtualModuleSuffix ?? '.ts';
	const allSearchIndexFile = options.mainVirtualModule;
	const root = normalizePath(process.cwd());

	function isTargetFile(id: string): boolean {
		const relativePath = path.posix.relative(root, id);
		return options.targetFilePaths.some(pat => minimatch(relativePath, pat))
	}

	function parseSearchIndexFileId(id: string): string | null {
		const noQuery = id.split('?')[0];
		if (noQuery.startsWith(searchIndexPrefix) && noQuery.endsWith(searchIndexSuffix)) {
			const filePath = id.slice(searchIndexPrefix.length).slice(0, -searchIndexSuffix.length);
			if (isTargetFile(filePath)) {
				return filePath;
			}
		}
		return null;
	}

	return {
		name: 'generateSearchIndexVirtualModule',
		enforce: 'post',

		async resolveId(id) {
			if (id == allSearchIndexFile) {
				return '\0' + allSearchIndexFile;
			}

			const searchIndexFilePath = parseSearchIndexFileId(id);
			if (searchIndexFilePath != null) {
				return id;
			}
			return undefined;
		},

		async load(id) {
			if (id == '\0' + allSearchIndexFile) {
				const files = options.targetFilePaths.map((filePathPattern) => fs.globSync(filePathPattern)).flat();
				let generatedFile = '';
				let arrayElements = '';
				for (let file of files) {
					const normalizedRelative = normalizePath(file);
					const absoluteId = normalizePath(path.join(process.cwd(), normalizedRelative)) + searchIndexSuffix;
					const variableName = normalizedRelative.replace(/[\/.-]/g, '_');
					generatedFile += `import { searchIndexes as ${variableName} } from '${searchIndexPrefix}${absoluteId}';\n`;
					arrayElements += `  ...${variableName},\n`;
				}
				generatedFile += `export let searchIndexes = [\n${arrayElements}];\n`;
				return generatedFile;
			}

			const searchIndexFilePath = parseSearchIndexFileId(id);
			if (searchIndexFilePath != null) {
				this.addWatchFile(searchIndexFilePath);

				const code = await asigner.getOrLoad(searchIndexFilePath);
				return generateJavaScriptCode(collectFileMarkers(searchIndexFilePath, code));
			}
			return null;
		},

		hotUpdate(this: { environment: { moduleGraph: EnvironmentModuleGraph } }, { file, modules }) {
			if (isTargetFile(file)) {
				const updateMods = options.modulesToHmrOnUpdate.map(id => this.environment.moduleGraph.getModuleById(path.posix.join(root, id))).filter(x => x != null);
				return [...modules, ...updateMods];
			}
			return modules;
		}
	};
}
