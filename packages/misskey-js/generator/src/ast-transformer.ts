import * as ts from 'typescript';

export function removeNeverPropertiesFromAST(astNodes: readonly ts.Node[]): ts.Node[] {
	const factory = ts.factory;

	function removeNeverPropertiesFromMembers(
		members: readonly ts.TypeElement[],
		visitType: (node: ts.Node) => ts.Node | undefined,
	): { newMembers: ts.TypeElement[]; hasChanged: boolean } {
		const newMembers: ts.TypeElement[] = [];
		let hasChanged = false;

		for (const member of members) {
			if (ts.isPropertySignature(member)) {
				if (member.type && member.type.kind === ts.SyntaxKind.NeverKeyword) {
					hasChanged = true;
					continue;
				}
				let updatedPropertySignature = member;
				if (member.type) {
					const visitedMemberType = ts.visitNode(member.type, visitType);
					if (visitedMemberType && visitedMemberType !== member.type) {
						updatedPropertySignature = factory.updatePropertySignature(
							member,
							member.modifiers,
							member.name,
							member.questionToken,
							visitedMemberType as ts.TypeNode,
						);
						hasChanged = true;
					} else if (visitedMemberType === undefined) {
						hasChanged = true;
						continue;
					}
				}
				newMembers.push(updatedPropertySignature);
			} else {
				newMembers.push(member);
			}
		}
		return { newMembers, hasChanged };
	}

	function typeNodeRecursiveVisitor(node: ts.Node): ts.Node | undefined {
		if (ts.isTypeLiteralNode(node)) {
			const { newMembers, hasChanged } = removeNeverPropertiesFromMembers(node.members, typeNodeRecursiveVisitor);

			if (newMembers.length === 0) {
				return undefined;
			}

			if (hasChanged) {
				return factory.updateTypeLiteralNode(node, factory.createNodeArray(newMembers));
			}
			return node;
		}

		return ts.visitEachChild(node, typeNodeRecursiveVisitor, undefined);
	}

	function interfaceRecursiveVisitor(node: ts.Node): ts.Node | undefined {
		if (ts.isInterfaceDeclaration(node)) {
			const { newMembers, hasChanged } = removeNeverPropertiesFromMembers(node.members, typeNodeRecursiveVisitor);

			if (newMembers.length === 0) {
				return undefined;
			}

			if (hasChanged) {
				return factory.updateInterfaceDeclaration(
					node,
					node.modifiers,
					node.name,
					node.typeParameters,
					node.heritageClauses,
					newMembers,
				);
			}
			return node;
		}
		return ts.visitEachChild(node, interfaceRecursiveVisitor, undefined);
	}

	function topLevelVisitor(node: ts.Node): ts.Node | undefined {
		if (ts.isTypeAliasDeclaration(node) && node.name.escapedText === 'paths') {
			const newType = ts.visitNode(node.type, typeNodeRecursiveVisitor);
			if (newType && newType !== node.type) {
				return factory.updateTypeAliasDeclaration(
					node,
					node.modifiers,
					node.name,
					node.typeParameters,
					newType as ts.TypeNode,
				);
			} else if (newType === undefined) {
				return undefined;
			}
		}
		if (ts.isInterfaceDeclaration(node) && node.name.escapedText === 'operations') {
			const result = interfaceRecursiveVisitor(node);
			return result;
		}
		return ts.visitEachChild(node, topLevelVisitor, undefined);
	}

	const transformedNodes: ts.Node[] = [];
	for (const astNode of astNodes) {
		const resultNode = ts.visitNode(astNode, topLevelVisitor);
		if (resultNode) {
			transformedNodes.push(resultNode);
		}
	}

	return transformedNodes;
}
