import {PatternWrapper, Transform} from "./pattern-language";
import {Node, Program, Identifier, Literal, MemberExpression, ImportDeclaration, VariableDeclaration} from "estree";
import {visit} from "ast-types";
import {isAssignmentExpression, isBlockStatement, isCallExpression, isExportNamedDeclaration, isFunctionDeclaration, isIdentifier, isImportDeclaration, isImportDefaultSpecifier, isImportNamespaceSpecifier, isImportSpecifier, isMemberExpression, isObjectPattern, isParenthesizedExpression, isProgram, isRequireCall, isSimpleLiteral, isVariableDeclarator} from "../util/ast-utils";
import {parseSource, printAst, writeModule} from "../util/parsing";
import {PackageOperations} from "../package/package-operations";
import { ExpressionKind, SpreadElementKind } from "ast-types/gen/kinds";
import {Tapir, AccessPathPattern, CallPattern, ImportPattern, parseAccessPathPattern, parsePattern, Pattern, ReadPropertyPattern, WritePropertyPattern,
    ImportAccessPath, PropAccessPath,
    GlobMatch
} from "tapir";
import {addToMapSet} from "../util/collections";
import { Options } from "recast";
import {applySeries} from "../util/promise";
import {TapirInteractivePhase, TransformQuestion} from "../interactive/tapir-interactive";

export class Patcher {
    private program: Program;
    private patchings: Map<string, Set<PatternWrapper>>; 
    private tapir: Tapir;
    private dir: string;
    private newRequires: Set<string> = new Set();
    private newRequiresWithPropName: Map<string, Set<string>> = new Map(); 
    private globMatchCache: Map<Node, GlobMatch> = new Map();
    private astPrintingOptions: Options;
    private originallyUsedIdentifiers: Set<string>;
    private interactivePhase: TapirInteractivePhase|undefined;
    constructor(program: Program, patchings: Map<string, Set<PatternWrapper>>, tapir: Tapir, dir: string, interactivePhase?: TapirInteractivePhase) {
        this.program = program;
        this.patchings = patchings;
        this.tapir = tapir;
        this.dir = dir;
        this.interactivePhase = interactivePhase;

        let quoteType : 'single'|'double'|undefined = undefined;
        visit(program, {
            visitLiteral(this:any, path:any): any {
                this.traverse(path);
                const node = path.node as Literal;
                if (typeof node.value !== "string")
                    return;
                const quoteCharacter = (node.raw as string).substring(0, 1);
                if (quoteCharacter === `'`)
                    quoteType = "single";
                else if (quoteCharacter === `"`)
                    quoteType = "double";
            }
        });
        this.astPrintingOptions = {quote: quoteType || "single"}
        this.originallyUsedIdentifiers = this.findUsedIdentifiers();
    }

    public async patchPatterns() {
        const patcher = this;
        const importDeclarations: Set<ImportDeclaration> = new Set();
        let firstImportNode: any;
        function visitor(this: any, path: any) {
            if (isImportDeclaration(path.node)) {
                firstImportNode = firstImportNode || path;
                importDeclarations.add(path.node);
            } else if (isRequireCall(path.node)) {
                firstImportNode = firstImportNode || path;
            }
            this.traverse(path);
            if (!path.node.loc)
                return;
            const sourceLocString = `${path.node.loc.start.line}:${path.node.loc.start.column}:${path.node.loc.end.line}:${path.node.loc.end.column}`;
            if (!patcher.patchings.has(sourceLocString)) return;
            const patternWrappers: Set<PatternWrapper> = patcher.patchings.get(sourceLocString) as Set<PatternWrapper>;
            patternWrappers.forEach(patternWrapper => {
                const pattern: Pattern = parsePattern(patternWrapper.pattern);
                if (pattern instanceof ImportPattern) {
                    patcher.patchImportPathPattern(pattern, patternWrapper.transform, path);
                } else if (pattern instanceof ReadPropertyPattern) {
                    patcher.patchReadPropertyPattern(pattern, patternWrapper, path);
                } else if (pattern instanceof WritePropertyPattern) {
                    patcher.patchWritePropertyPattern(pattern, patternWrapper.transform, path);
                } else if (pattern instanceof CallPattern) {
                    patcher.patchCallPattern(pattern, patternWrapper.transform, path, patternWrapper);
                }
                const node = isCallExpression(path.node) ? path.node.callee : path.node;
                let cleanupPattern = patternWrapper.transform.cleanupPattern;
                if (!cleanupPattern)
                    return;
                const fromPattern: AccessPathPattern = parseAccessPathPattern(cleanupPattern.fromPattern);
                if (patcher.tapir.doesAnyAccessPathMatchPattern(fromPattern, patcher.tapir.computeAccessPaths(node, patcher.tapir))) {
                    path.replace(parseSource(patcher.interpolateVariables(cleanupPattern.toPattern, path.node)));
                }
            })
        }
        visit(this.program, {
            visitCallExpression: visitor,
            visitNewExpression: visitor,
            visitMemberExpression: visitor,
            visitImportDeclaration: visitor,
            visitIdentifier: visitor,
            visitAssignmentExpression: visitor
        });
        this.newRequiresWithPropName.forEach((propNames, moduleName) => {
            let generatedCode: string;
            if (importDeclarations.size > 0) {
                generatedCode = propNames.size === 1 && propNames.has("*") ?
                    `import ${this.convertModuleNameToValidIdentifier(moduleName)} from '${moduleName}';\n` :
                    `import {${[...propNames]
                        .map(propName => this.tapir.getDeclaredVariableNames().has(propName) ?
                            `${propName} as ${getAlternativePropName(moduleName, propName)}` : propName).join(", ")
                    }} from '${moduleName}';\n`;
            } else {
                generatedCode = propNames.size === 1 && propNames.has("*") ?
                    `const ${this.convertModuleNameToValidIdentifier(moduleName)} = require('${moduleName}');\n` :
                    `const {${[...propNames].map(propName => this.tapir.getDeclaredVariableNames().has(propName) ?
                        `${propName}: ${getAlternativePropName(moduleName, propName)}` : propName).join(", ")
                    }} = require('${moduleName}');\n`;

            }
            const newImport = parseSource(generatedCode);
            // @ts-ignore
            const programBody: Node[] = this.program.program.body;
            if (!firstImportNode)
                programBody.unshift(newImport);
            else {
                let currentPath = firstImportNode;
                while (!isProgram(currentPath.parent.node)) {
                    currentPath = currentPath.parent;
                }
                let indexOfNode = programBody.findIndex(exp => exp === currentPath.node);
                programBody.splice(indexOfNode, 0, newImport);
            }
        });
        await this.patchPackageJson();
        this.unifyPropertyImportsFromSameModuleAndRemoveUnusedImports();
    }
    private findUsedIdentifiers() {
        const resultSet: Set<string> = new Set();
        visit(this.program, {
            visitIdentifier: function (this: any, path: any) {
                this.traverse(path);
                const node = path.node as Identifier;
                if (isParentExportDeclaration(path)) {
                    resultSet.add(node.name);
                    return;
                }
                if ((isVariableDeclarator(path.parent.node) && path.parent.node.id === path.node && isRequireCall(path.parent.node.init)) ||
                    (isVariableDeclarator(path.parent.parent.parent.node) && path.parent.parent.parent.node.id === path.parent.parent.node && isRequireCall(path.parent.parent.parent.node.init)) ||
                    isFunctionDeclaration(path.parent.node) ||
                    isImportSpecifier(path.parent.node) || isImportNamespaceSpecifier(path.parent.node) || isImportDefaultSpecifier(path.parent.node)) {
                    return;
                }
                resultSet.add(node.name);
            }
        });
        return resultSet;
    };
    private unifyPropertyImportsFromSameModuleAndRemoveUnusedImports() {
        const propertyImports: Map<string, Set<any>> = new Map();
        const requireCalls: Map<string, Set<any>> = new Map();
        const newlyUsedIdentifierNames: Set<string> = this.findUsedIdentifiers();
        const removedIdentifierNames = new Set([...this.originallyUsedIdentifiers].filter(name => !newlyUsedIdentifierNames.has(name)));
        const patcher = this;
        visit(this.program, {
            visitImportDeclaration: function(this:any, path:any) {
                this.traverse(path);
                const node = path.node as ImportDeclaration;
                const newSpecifiers = node.specifiers.filter(spec => !removedIdentifierNames.has(spec.local.name));
                if (newSpecifiers.length !== node.specifiers.length) {
                    node.specifiers = newSpecifiers;
                    if (node.specifiers.length === 0)
                        patcher.removeNode(path);
                }
                if (node.specifiers.some(isImportSpecifier))
                    addToMapSet(propertyImports, node.source.value, path);
            },
            visitVariableDeclaration: function(this:any, path:any) {
                const node = path.node as VariableDeclaration;
                const newDeclarations = node.declarations.filter(decl => {
                    if (isIdentifier(decl.id) && removedIdentifierNames.has(decl.id.name))
                        return false;
                    if (isObjectPattern(decl.id)) {
                        // @ts-ignore
                        const newProperties = decl.id.properties.filter(prop => !isIdentifier(prop.key) || !removedIdentifierNames.has(prop.key.name));
                        if (newProperties.length !== decl.id.properties.length)
                            decl.id.properties = newProperties;
                        if (newProperties.length === 0) {
                            return false;
                        }
                    }
                    return true;
                });
                if (newDeclarations.length !== node.declarations.length)
                    node.declarations = newDeclarations;
                if (node.declarations.length === 0) {
                    patcher.removeNode(path);
                    return false;
                } else
                    this.traverse(path);
            },
            visitVariableDeclarator(this: any, path: any): any {
                this.traverse(path);
                const decl = path.node;
                if (isObjectPattern(decl.id) && isRequireCall(decl.init)) {
                    let firstArg = decl.init.arguments[0];
                    if (isSimpleLiteral(firstArg) && typeof firstArg.value === "string")
                        addToMapSet(requireCalls, firstArg.value, path);
                }
            }
        });
        propertyImports.forEach((paths, _moduleName) => {
            if (paths.size === 1)
                return;
            const importSpecifiers = [...paths]
                .map(p => p.node.specifiers)
                .reduce((acc, elem) => [...acc, ...elem], []);
            [...paths].forEach((path, idx) => {
                if (idx === 0)
                    path.node.specifiers = importSpecifiers;
                else {
                    this.removeNode(path);
                }
            })
        });
        requireCalls.forEach((paths, _moduleName) => {
            if (paths.size === 1)
                return;
            const properties = [...paths]
                .map(p => p.node.id.properties)
                .reduce((acc, elem) => [...acc, ...elem], []);
            [...paths].forEach((path, idx) => {
                if (idx === 0)
                    path.node.id.properties = properties;
                else {
                    this.removeNode(path);
                }
            })
        });
    }

    private removeNode(path: any) {
        let currentPath = path;
        while (!isProgram(currentPath.parent.node) && !isBlockStatement(currentPath.parent.node)) {
            currentPath = currentPath.parent;
        }
        let indexOfNode = currentPath.parent.node.body.findIndex((exp: Node) => exp === currentPath.node);
        if (indexOfNode === -1)
            throw new Error("The node to be removed was not found");
        currentPath.parent.node.body.splice(indexOfNode, 1);
    }

    private patchImportPathPattern(pattern: ImportPattern, transform: Transform, path: any) {
        const computeNewImportString = (node: Node, moduleString: string) => {
            const moduleStringEndsInJs = moduleString.endsWith((".js"));
            if (!this.globMatchCache.has(node)) {
                const moduleStringWithoutExtension = moduleStringEndsInJs ? moduleString.substring(0, moduleString.length - 3) : moduleString;
                this.globMatchCache.set(node, pattern.importPathPattern.importPathPattern.matches(moduleStringWithoutExtension, 1)[0]);
            }
            let globMatch = this.globMatchCache.get(node) as GlobMatch;
            const newNameValues: any = globMatch.getWildcardMatches();
            if (transform.replacements)
                transform.replacements.forEach(replacement => {
                    const sourceValue = globMatch.getWildcardMatches()[replacement.source];
                    let newName = sourceValue;
                    replacement.substitutes.forEach(substitute => {
                        const [target, substituteValue] = substitute.split("=>").map(str => str.trim());
                        if (sourceValue === target) {
                            newName = substituteValue;
                        }
                    });
                    newNameValues[replacement.newName] = newName;
                });
            let resModuleString = transform.pattern as string;
            Object.keys(newNameValues).forEach(newName => {
                resModuleString = resModuleString.replace(newName, newNameValues[newName])
            });
            if (this.tapir.getModuleNameToVariableMap().has(moduleString))
                this.tapir.getModuleNameToVariableMap().set(resModuleString, this.tapir.getModuleNameToVariableMap().get(moduleString) as string);
            if (resModuleString && resModuleString.indexOf("<") === -1 && !resModuleString.match(/\s/))
                this.newRequires.add(resModuleString.split("/")[0]);
            return resModuleString;
        };

        const node = path.node;
        const transformPattern = transform.pattern as string;
        if (isCallExpression(node)) {
            if (isRequireCall(node) && isSimpleLiteral(node.arguments[0]) && typeof node.arguments[0].value === "string") {
                const value = computeNewImportString(node, node.arguments[0].value);
                if (value.indexOf("<") !== -1) {
                    const [/*match*/, moduleName, propName] = value.match(/<(.*)>\.(.*)/);
                    this.newRequires.add(moduleName.split("/")[0]);
                    node.arguments[0].value = moduleName;
                    path.replace(parseSource(`${printAst(node, this.astPrintingOptions).code}.${propName}`));
                } else if (!transformPattern) {
                    this.removeNode(path);
                } else {
                    node.arguments[0].value = value;
                }
            }
        } else if (isImportDeclaration(node)) {
            if (isSimpleLiteral(node.source) && typeof node.source.value === "string") {
                let value = computeNewImportString(node, node.source.value);
                if (value.indexOf("<") !== -1) {
                    const [/*match*/, moduleName, propName] = value.match(/<(.*)>\.(.*)/);
                    this.newRequires.add(moduleName.split("/")[0]);
                    if (node.specifiers && node.specifiers.length == 1) {
                        const sameName = !node.specifiers[0].local || node.specifiers[0].local.name === propName;
                        let source = `import { ${sameName ? propName : propName + " as " + (node.specifiers[0].local as Identifier).name} } from '${moduleName}';`;
                        path.replace(parseSource(source));
                    }
                } else if (pattern.onlyDefault) {
                    path.replace(parseSource(transformPattern.replace(/\$locName/g, node.specifiers[0].local.name)));
                } else if (!transformPattern) {
                    this.removeNode(path);
                } else if (transformPattern.includes(" ")) {
                    path.replace(parseSource(transformPattern));
                } else {
                    node.source.value = value;
                }
            }
        }
    }

    private patchReadPropertyPattern(_pattern: ReadPropertyPattern, patternWrapper: PatternWrapper, path: any) {
        const node = path.node;
        const pattern = this.getTransformPattern(patternWrapper, path);
        if (isMemberExpression(node)) {
            path.replace(parseSource(this.interpolateVariables(pattern, node)));
        } else if (isIdentifier(node)) {
            let source = pattern.replace("$base.", "");
            path.replace(parseSource(this.interpolateVariables(source, node)));
        } else if (isImportDeclaration(node) && !pattern.startsWith("<")) {
            node.specifiers.filter(isImportSpecifier)
                .filter(spec => _pattern.propertyPathPattern.matches(new PropAccessPath(new ImportAccessPath(node.source.value as string), spec.imported.name), new Set()))
                .forEach(spec => spec.imported.name = this.interpolateVariables(pattern.replace("$base.", ""), spec.imported));
        }
    }

    private patchWritePropertyPattern(_pattern: WritePropertyPattern, transform: Transform, path: any) {
        const node = path.node;
        if (isAssignmentExpression(node) && isMemberExpression(node.left)) {
            path.replace(parseSource(this.interpolateVariables(transform.pattern as string, node)));
        }
    }

    private patchCallPattern(_pattern: CallPattern, transform: Transform, path: any, patternWrapper: PatternWrapper) {
        const node = path.node;
        if (isCallExpression(node)) {
            if (this.isThisOrApplyCall(node)) {
                this.handleCallOrApplyCall(transform, node);
                return;
            }

            path.replace(parseSource(this.interpolateVariables(this.getTransformPattern(patternWrapper, path), node)));
        }
    }

    private isThisOrApplyCall(node: any) {
        return isCallExpression(node) && isMemberExpression(node.callee) && isIdentifier(node.callee.property) && ['apply', 'call'].includes(node.callee.property.name);
    }

    private handleCallOrApplyCall(transform: Transform, node: any) {
        const isApplyCall = isCallExpression(node) && isMemberExpression(node.callee) && isIdentifier(node.callee.property) && node.callee.property.name === 'apply';
        if (!isApplyCall)
            return;
        const match = (transform.pattern as string).match(/(.*)\(\$args\)$/);
        if (!match)
            return;
        let [/*match*/, calleeSource] = match;
        const callee = node.callee.object;
        node.callee.object = parseSource(this.interpolateVariables(calleeSource, callee));
    }

    private replaceMultipleArgs(args: (ExpressionKind | SpreadElementKind)[], sourcePart: string): string {
        return sourcePart.replace(/args(\[(-?\d+),?\s*(-?\d+)?\])?/g, (_match, _argString, firstArg, lastArg) => {
            let firstArgNumber = firstArg ? parseInt(firstArg) : 0;
            if (firstArgNumber < 0)
                firstArgNumber = args.length + firstArgNumber;
            let lastArgNumber = lastArg ? parseInt(lastArg) : args.length;
            if (lastArgNumber < 0)
                lastArgNumber = args.length + lastArgNumber;
            let argReplacementString = "";
            for (let argNumber = firstArgNumber; argNumber < lastArgNumber; argNumber++) {
                if (argNumber !== firstArgNumber)
                    argReplacementString += ", ";
                argReplacementString += printAst(args[argNumber], this.astPrintingOptions).code;
            }
            return argReplacementString;
        });
    }

    private replaceModuleImports(source: string): string {
        return source.replace(/<([\w/\-@.\d]*)>(\.[\w]+)?/g, (_g0, moduleNameAndVersion, propNameWithDot) => {
            const [moduleName, version] = moduleNameAndVersion.split("@");
            if (this.tapir.getModuleNameToVariableMap().has(moduleName))
                return this.tapir.getModuleNameToVariableMap().get(moduleName) as string + (propNameWithDot ? propNameWithDot : "");
            const moduleNameToAdd = moduleName.split("/")[0] + (version ? `@${version}` : "");
            this.newRequires.add(moduleNameToAdd);
            if (propNameWithDot) {
                let propName = propNameWithDot.substring(1);
                addToMapSet(this.newRequiresWithPropName, moduleName, propName);
                if (this.tapir.getDeclaredVariableNames().has(propName)) {
                    propName = getAlternativePropName(moduleName, propName);
                }
                return this.convertModuleNameToValidIdentifier(propName);
            }
            addToMapSet(this.newRequiresWithPropName, moduleName, "*");
            return this.convertModuleNameToValidIdentifier(moduleName);
        });
    }

    private convertModuleNameToValidIdentifier(moduleName: string): string {
        return moduleName.replace(/-\w/g, (g0) => g0.substring(1).toUpperCase());
    }

    private getPropNode(node: any): MemberExpression {
        if (isAssignmentExpression(node) && isMemberExpression(node.left))
            return node.left;
        if (isCallExpression(node))
            return this.getPropNode(node.callee);
        if (isMemberExpression(node))
            return node;
        if (isParenthesizedExpression(node))
        // @ts-ignore
            return this.getPropNode(node.expression);
        // @ts-ignore
        throw new Error("Unsupported node kind: " + node.type);
    }

    private interpolateVariables(pattern: string, n: Node): string {
        const interpolatedSpecialVariables = pattern.replace(/\$([^\s.(),{};\[\]]|\[[^\]]*\])*/g, (g0) => {
            const paths = g0.substring(1).split(":");
            const nodeToUseOrFinalString = paths.reduce((currentNode: any, elem) => {
                if (elem === "base") {
                    return this.getPropNode(currentNode).object;
                } else if (elem.startsWith("prop")) {
                    const propName = (isIdentifier(currentNode) ? currentNode : (this.getPropNode(currentNode) as MemberExpression).property as Identifier).name;
                    return elem.replace(/prop(\[(.*)\])?/g, (_g0, _g1, replacers: string | undefined) => {
                        if (!replacers)
                            return propName;
                        return replacers.split(",").map(e => e.split("=>")).reduce((acc, [e1, e2]) => e1.trim() === propName ? e2.trim() : acc, propName);
                    });
                } else if (elem === "callee") {
                    return currentNode.callee;
                } else if (elem.startsWith("args")) {
                    return this.replaceMultipleArgs(currentNode.arguments, elem);
                } else if (elem.match(/(-?\d+)/)) {
                    const [/*match*/, argNumber] = elem.match(/(-?\d+)/);
                    const argNumberInt = parseInt(argNumber);
                    return currentNode.arguments[argNumberInt >= 0 ? argNumberInt - 1 : currentNode.arguments.length + argNumberInt];
                } else if (elem === "value") {
                    return currentNode.right;
                }
            }, n);
            return typeof nodeToUseOrFinalString === "string" ? nodeToUseOrFinalString : printAst(nodeToUseOrFinalString, this.astPrintingOptions).code;
        });
        return this.replaceModuleImports(interpolatedSpecialVariables);
    }

    private getTransformPattern(patternWrapper: PatternWrapper, path: any) {
        const transform = patternWrapper.transform;
        let transformPattern;
        if (typeof transform.pattern === "string")
            transformPattern = transform.pattern;
        else if (patternWrapper.transformQuestion) {
            if (!this.interactivePhase) {
                throw new Error("InteractivePhase has not been passed to constructor, so we cannot patch transform questions");
            }
            const answer = this.interactivePhase.getAnswerToTransformQuestion(new TransformQuestion(patternWrapper.transformQuestion, false), path.node, this.tapir.fileName, patternWrapper);
            if (answer !== "Yes" && answer !== "No")
                throw new Error("Answer to transform question should be 'Yes' or 'No', but was: " + answer);
            transformPattern = transform.pattern[answer];
        } else
            throw new Error("Invalid pattern");
        return transformPattern;
    }

    private async patchPackageJson() {
        if (this.newRequires.size === 0)
            return;
        const packageJsonObj = await PackageOperations.getPackageJsonObj(this.dir);
        await applySeries([...this.newRequires].map(newModule => newModule.split("@")).filter(([newModule, _version]) => !packageJsonObj.dependencies[newModule]), async ([newModule, version]) => {
            await PackageOperations.addPackageToPackageJson(this.dir, newModule, version);
        });
    }

    public async persistModule() {
        await writeModule(this.program, `${this.dir}/${this.tapir.fileName}`, this.astPrintingOptions);
    }
}
function isParentExportDeclaration(path: any) {
    let currentPath = path;
    while (!isProgram(currentPath.parent.node) && !isBlockStatement(currentPath.parent.node)) {
        currentPath = currentPath.parent;
        if (isExportNamedDeclaration(currentPath.node))
            return true;
    }
    return false;
}

function getAlternativePropName(moduleName: string, propName: string): string {
    return moduleName.split("/")[0] + propName.substring(0, 1).toUpperCase() + propName.substring(1);
}
