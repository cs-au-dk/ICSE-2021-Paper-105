/**
 * Use https://astexplorer.net/ for debugging/understanding the structure of AST
 * nodes.
 */

import {
    AssignmentPattern,
    Identifier,
    Pattern as AstPattern,
    Program,
    Node,
    ImportDeclaration,
    VariableDeclaration,
    AssignmentExpression,
    FunctionDeclaration,
    FunctionExpression,
    ArrowFunctionExpression,
    ObjectExpression,
    ObjectPattern,
    MemberExpression,
    CallExpression, SimpleCallExpression, NewExpression
} from 'estree'
import {
    isAssignmentExpression,
    isCallExpression,
    isIdentifier,
    isImportDeclaration,
    isImportDefaultSpecifier,
    isImportNamespaceSpecifier,
    isImportSpecifier,
    isMemberExpression,
    isModuleImport,
    isObjectPattern,
    isRequireCall,
    isSimpleLiteral,
    isSpreadElement,
    isProperty,
    isAnyCreateFunctionNode,
    isVariableDeclarator,
    isFunctionDeclaration,
    isProgram,
    isBlockStatement,
    isObjectExpression,
    isArrayExpression,
    isParenthesizedExpression,
    isExpressionStatement,
    isAssignmentPattern,
    isThisExpression
} from "../util/ast-utils";
import {addToMapSet, setUnion} from "../util/collections";
import {
    AccessPathPattern,
    CallPattern,
    ImportPattern, parsePattern,
    PatternWrapper,
    ReadPropertyPattern,
    WritePropertyPattern
} from "./pattern-language";
import {StaticConfiguration} from "../static-configuration";
import {visit} from 'recast';
import {DisjunctionMatchResult, FALSE_RESULT_INSTANCE, MaybeAccPathMatch, MaybeApplyOrSpreadArgFilterMatch, MaybeArgTypeMatch, MaybeImportPathMatch, TRUE_RESULT_INSTANCE, UncertainAccPathMatch} from "../interactive/tapir-interactive";
import {AccessPath, CallAccessPath, ImportAccessPath, PropAccessPath, ThisAccessPath, unknownAccessPathInstance} from "./access-path";
import {getFilesToAnalyze} from "../util/file";
import {parseFileWithRecast} from "../util/parsing";
import {isAbsolute, relative, resolve} from "path";
import {Path} from "../types";

export class Tapir {
    readonly module: Program;
    readonly fileName: string;
    private unknownRequires: Set<ImportAccessPath>;
    private declarationAnalysisResults: Map<Identifier, Node>|undefined;
    private declaredVariableNames: Set<string>;
    private aliasAnalysisResults: Map<Node | string, Set<Node>>|undefined;
    private computeAccessPathsResults: Map<Node, Set<AccessPath>>|undefined;
    private matchPatternResults: Map<PatternWrapper, TapirMatchResult[]>|undefined;
    private moduleNameToVariableMap: Map<string, string>|undefined;
    private treatRelativeRequiresAsUnknown: boolean;

    constructor(fileName: string, module: Program, treatRelativeRequiresAsUnknown = true) {
        this.fileName = fileName;
        this.module = module;
        this.unknownRequires = new Set();
        this.declaredVariableNames = new Set();
        this.treatRelativeRequiresAsUnknown = treatRelativeRequiresAsUnknown;
    }

    public static async createTapirFromFileName(fileName: string) {
        return new Tapir(fileName, await parseFileWithRecast(fileName), false);
    }

    public getDeclAnalysisResults(): Map<Identifier, Node> {
        if (!this.declarationAnalysisResults)
            throw new Error("The declaration analysis has not been run yet.");
        return this.declarationAnalysisResults;
    }

    public getModuleNameToVariableMap(): Map<string, string> {
        if (!this.moduleNameToVariableMap)
            throw new Error("The declaration analysis has not been run yet.");
        return this.moduleNameToVariableMap;
    }

    public getDeclaredVariableNames(): Set<string> {
        return this.declaredVariableNames;
    }

    public getAliasAnalysisResults(): Map<Node | string, Set<Node>> {
        if (!this.aliasAnalysisResults)
            throw new Error("The alias analysis has not been run yet.");
        return this.aliasAnalysisResults;
    }

    public getComputeAccessPathsResults(): Map<Node, Set<AccessPath>> {
        if (!this.computeAccessPathsResults)
            throw new Error("The compute access paths phase has not been run yet.");
        return this.computeAccessPathsResults;
    }

    public getMatchPatternResults(): Map<PatternWrapper, TapirMatchResult[]> {
        if (!this.matchPatternResults)
            throw new Error("The match pattern phase has not been run yet.");
        return this.matchPatternResults;
    }

    public declarationAnalysis(): Map<Identifier, Node> {
        const res: Map<Identifier, Node> = new Map();
        const moduleNameToVariable: Map<string, string> = new Map();
        const tapir = this;
        let state = new Map();

        function handleParams(params: AstPattern[], node: Node) {
            params.filter(p => isIdentifier(p)).forEach(p => {
                tapir.declaredVariableNames.add((p as Identifier).name);
                state.set((p as Identifier).name, node)
            });
            params.filter(p => isObjectPattern(p)).forEach(p => {
                (p as ObjectPattern).properties.forEach(prop => {
                    // @ts-ignore
                    if (isIdentifier(prop.key)) {
                        // @ts-ignore
                        tapir.declaredVariableNames.add(prop.key.name);
                        // @ts-ignore
                        state.set(prop.key.name, node)
                    }
                })
            });
            params.filter(p => isAssignmentPattern(p)).forEach(p => {
                const left = (p as AssignmentPattern).left;
                if (isIdentifier(left)) {
                    tapir.declaredVariableNames.add(left.name);
                    state.set((p as Identifier).name, node)
                }
            });
        }
        visit(this.module,
            {
                visitImportDeclaration: function (this: any, path: any) {
                    const node = path.node as ImportDeclaration;
                    node.specifiers.forEach(spec => {
                        tapir.declaredVariableNames.add(spec.local.name);
                        state.set(spec.local.name, spec);
                        // @ts-ignore
                        spec.SOURCE = node.source.value;
                    });
                    node.specifiers.filter(spec => isImportDefaultSpecifier(spec) || isImportNamespaceSpecifier(spec))
                        .forEach(spec => {
                            // @ts-ignore
                            moduleNameToVariable.set(node.source.value, spec.local.name);
                        });
                    this.traverse(path);
                },
                visitVariableDeclaration: function (this: any, path: any) {
                    const node = path.node as VariableDeclaration;
                    node.declarations.filter(decl => isIdentifier(decl.id)).forEach(decl => {
                        tapir.declaredVariableNames.add((decl.id as Identifier).name);
                        state.set((decl.id as Identifier).name, decl)
                    });
                    node.declarations.filter(decl => isObjectPattern(decl.id)).forEach(decl =>
                        (decl.id as ObjectPattern).properties.forEach(p => {
                            // @ts-ignore
                            if (isIdentifier(p.value)) {
                                // @ts-ignore
                                tapir.declaredVariableNames.add(p.value.name);
                                // @ts-ignore
                                state.set(p.value.name, p);
                                // @ts-ignore
                                p.INIT_EXP = decl.init;
                            }
                        })
                    );
                    node.declarations.filter(decl => isIdentifier(decl.id)).filter(decl => isRequireCall(decl.init))
                        .forEach(decl => {
                            // @ts-ignore
                            moduleNameToVariable.set(decl.init.arguments[0].value as string, decl.id.name)
                        });
                    this.traverse(path);
                },
                visitFunctionDeclaration: function (this: any, path: any) {
                    const node = path.node as FunctionDeclaration;
                    if (isIdentifier(node.id))
                        state.set(node.id.name, node);
                    const oldState = new Map(state);
                    handleParams(node.params, node);
                    this.traverse(path);
                    state = oldState;
                },
                visitFunctionExpression: function (this: any, path: any) {
                    const node = path.node as FunctionExpression;
                    const oldState = new Map(state);
                    if (isIdentifier(node.id))
                        state.set(node.id.name, node);
                    handleParams(node.params, node);
                    this.traverse(path);
                    state = oldState;
                },
                visitArrowFunctionExpression: function (this: any, path: any) {
                    const node = path.node as ArrowFunctionExpression;
                    const oldState = new Map(state);
                    handleParams(node.params, node);
                    this.traverse(path);
                    state = oldState;
                },
                visitIdentifier: function (this: any, path: any) {
                    const node = path.node as Identifier;
                    if (!state.has(node.name) || 
                        (isVariableDeclarator(path.parent.node) && path.parent.node.id === node)|| 
                        isFunctionDeclaration(path.parent.node) || 
                        isImportSpecifier(path.parent.node)) {
                        this.traverse(path);
                        return;
                    }
                    res.set(node, state.get(node.name) as Node)
                    this.traverse(path);
                },
                visitAssignmentExpression: function (this: any, path: any) {
                    const node = path.node as AssignmentExpression;
                    if (isIdentifier(node.left) && !state.has(node.left.name)) {
                        state.set(node.left.name, node);
                        res.set(node.left, node);
                    } else if (isIdentifier(node.left) && state.has(node.left.name)) {
                        res.set(node.left, state.get(node.left.name) as Node)
                    } else if (isMemberExpression(node.left) && isIdentifier(node.left.object) && state.has(node.left.object.name)) {
                        res.set(node.left.object, state.get(node.left.object.name) as Node);
                    }
                    if (isRequireCall(node.right) && isIdentifier(node.left))
                    // @ts-ignore
                        moduleNameToVariable.set(node.right.arguments[0].value as string, node.left.name);
                    this.traverse(path);
                }
            });
        this.declarationAnalysisResults = res;
        this.moduleNameToVariableMap = moduleNameToVariable;
        return res;
    }

    public aliasAnalysis(): Map<Node | string, Set<Node>> {
        if (!this.declarationAnalysisResults)
            this.declarationAnalysis();
        const res: Map<Node | string, Set<Node>> = new Map();
        const tapir = this;
        visit(this.module, {
            visitImportDeclaration: function (this: any, path: any) {
                const node = path.node as ImportDeclaration;
                node.specifiers.forEach(spec => addToMapSet(res, spec, spec));
                this.traverse(path);
            },
            visitVariableDeclaration: function (this: any, path: any) {
                const node = path.node as VariableDeclaration;
                node.declarations.filter(decl => isIdentifier(decl.id)).filter(decl => !!decl.init).forEach(decl => addToMapSet(res, decl, decl.init));
                node.declarations.filter(decl => isObjectPattern(decl.id)).filter(decl => !!decl.init).forEach(decl =>
                    (decl.id as ObjectPattern).properties.forEach(p => addToMapSet(res, p, p)));
                this.traverse(path);
            },
            visitAssignmentExpression: function (this: any, path: any) {
                const node = path.node;
                if (isIdentifier(node.left) && tapir.getDeclAnalysisResults().has(node.left)) {
                    addToMapSet(res, tapir.getDeclAnalysisResults().get(node.left), node.right);
                } else if (isMemberExpression(node.left) && isIdentifier(node.left.property) && typeof node.left.property.name === "string") {
                    addToMapSet(res, node.left.property.name, node.right);
                }
                this.traverse(path);
            },
            visitObjectExpression: function (this: any, path: any) {
                const node = path.node as ObjectExpression;
                // @ts-ignore
                node.properties.filter(prop => isIdentifier(prop.key)).forEach(prop => addToMapSet(res, (prop.key as Identifier).name, prop.value));
                this.traverse(path);
            }
        });
        this.aliasAnalysisResults = res;
        return res;
    }

    public computeAccessPathsPhase(): Map<Node, Set<AccessPath>> {
        if (!this.aliasAnalysisResults)
            this.aliasAnalysis();
        const res: Map<Node, Set<AccessPath>> = new Map();
        const tapir = this;
        visit(this.module, {
            visitMemberExpression: function (this: any, path: any) {
                const node = path.node;
                if (!isLeftHandSideInAssignment(path))
                    res.set(node, tapir.computeAccessPaths(node, tapir));
                this.traverse(path);
            },
            visitCallExpression: function (this: any, path: any) {
                const node = path.node as CallExpression;
                let accessPathNode;
                if (isMemberExpression(node.callee) && isIdentifier(node.callee.property) && (['call', 'apply'].includes(node.callee.property.name)))
                    accessPathNode = (node.callee as MemberExpression).object;
                else if (isRequireCall(node))
                    accessPathNode = node;
                else
                    accessPathNode = node.callee;
                res.set(node, tapir.computeAccessPaths(accessPathNode, tapir));
                this.traverse(path);
            },
            visitNewExpression: function (this: any, path: any) {
                const node = path.node as NewExpression;
                res.set(node, tapir.computeAccessPaths(node.callee, tapir));
                this.traverse(path);
            },
            visitIdentifier: function (this: any, path: any) {
                const node = path.node as Identifier;
                if (isImportSpecifier(tapir.getDeclAnalysisResults().get(node)))
                    res.set(node, tapir.computeAccessPaths(node, tapir));
                this.traverse(path);
            },
            visitAssignmentExpression: function (this: any, path: any) {
                const node = path.node as AssignmentExpression;
                if (isMemberExpression(node.left) && isIdentifier(node.left.property)) {
                    res.set(node, tapir.computeAccessPaths(node.left, tapir, true));
                }
                this.traverse(path);
            },
            visitImportDeclaration: function (this: any, path: any) {
                const node = path.node as ImportDeclaration;
                node.specifiers.forEach(spec => res.set(spec, tapir.computeAccessPaths(spec, tapir)));
                res.set(node, tapir.computeAccessPaths(node, tapir));
                this.traverse(path);
            }
        });
        this.computeAccessPathsResults = res;
        return res;
    }

    public computeAccessPaths(node: Node, tapir: Tapir, isAssignmentNode?: boolean): Set<AccessPath> {
        function lookup(x: Node | string, visited: Set<Node | string>): Set<AccessPath> {
            if (!tapir.getAliasAnalysisResults().has(x))
                return typeof x === "string" ? new Set() : new Set([unknownAccessPathInstance]);
            if (visited.has(x))
                return new Set();
            if (typeof x === "string" && (tapir.getAliasAnalysisResults().get(x) as Set<Node>).size > 30)
                return new Set([unknownAccessPathInstance]);
            visited.add(x);
            return setUnion([...(tapir.getAliasAnalysisResults().get(x) as Set<Node>)].map(n => computePaths(n, new Set(visited))))
        }

        function computePaths(n: Node, visited: Set<Node | string>): Set<AccessPath> {
            let res: Set<AccessPath>;
            if (isModuleImport(n)) {
                res = new Set([tapir.getImportAccessPath(n)]);
            } else if (isMemberExpression(n) && isIdentifier(n.property)) {
                res = new Set([...computePaths(n.object, new Set(visited))].map(acc => new PropAccessPath(acc, (n.property as Identifier).name)));
                if (node !== n || !isAssignmentNode)
                    [...lookup(n.property.name, visited)].forEach(acc => res.add(acc));
            } else if (isIdentifier(n)) {
                if (!tapir.getDeclAnalysisResults().has(n))
                // @ts-ignore
                    res = new Set([globalObjects[n.name] || unknownAccessPathInstance]);
                else if (isAnyCreateFunctionNode(tapir.getDeclAnalysisResults().get(n)))
                    res = new Set([unknownAccessPathInstance]);
                else
                    res = lookup(tapir.getDeclAnalysisResults().get(n) as Node, visited);
            } else if (isCallExpression(n)) {
                res = new Set([...computePaths(n.callee, visited)].map(acc => new CallAccessPath(acc)));
            } else if (isProperty(n)) {
                // @ts-ignore
                const accPaths = computePaths(n.INIT_EXP, visited);
                res = new Set([...accPaths].map(accPath => new PropAccessPath(accPath, (n.key as Identifier).name)));
            } else if (isArrayExpression(n)) {
                res = new Set([globalObjects.Array]);
            } else if (isObjectExpression(n)) {
                res = new Set([globalObjects.Object]);
            } else if (isParenthesizedExpression(n)) {
                // @ts-ignore
                res = new Set(computePaths(n.expression, visited));
            } else if (isThisExpression(n)) {
                res = new Set([new ThisAccessPath()]);
            } else {
                res = new Set([unknownAccessPathInstance]);
            }
            return res;
        }

        return computePaths(node, new Set());
    }

    private getImportAccessPath(n: Node): AccessPath {
        let importString = undefined;
        if (isRequireCall(n) && isSimpleLiteral(n.arguments[0]) && typeof n.arguments[0].value === "string") {
            importString = n.arguments[0].value;
        } else if (isImportDefaultSpecifier(n) || isImportNamespaceSpecifier(n) || isImportSpecifier(n)) {
            // @ts-ignore
            importString = n.SOURCE;
        } else if (isImportDeclaration(n)) {
            // @ts-ignore
            importString = n.source.value;
        }
        if (!importString || (this.treatRelativeRequiresAsUnknown && importString.startsWith(".")))
            return unknownAccessPathInstance;
        const importAccessPath = new ImportAccessPath(importString);
        if (isImportSpecifier(n))
            return new PropAccessPath(importAccessPath, n.local.name);
        return importAccessPath;
    }

    public matchPattern(patternWrapper: PatternWrapper): TapirMatchResult[] {
        const pattern = parsePattern(patternWrapper.pattern);
        if (!this.computeAccessPathsResults)
            this.computeAccessPathsPhase();
        if (pattern instanceof ImportPattern)
            return this.matchImportPattern(pattern);
        else if (pattern instanceof ReadPropertyPattern)
            return this.matchReadPropertyPattern(pattern);
        else if (pattern instanceof WritePropertyPattern)
            return this.matchWritePropertyPattern(pattern);
        else if (pattern instanceof CallPattern)
            return this.matchCallPattern(pattern);
        throw new Error(`Unsupported pattern: ${pattern}`);
    }

    public matchImportPattern(pattern: ImportPattern): TapirMatchResult[] {
        const res: TapirMatchResult[] = [];
        const tapir = this;
        const computedAccessPaths = this.getComputeAccessPathsResults();
        visit(this.module, {
            visitCallExpression: function (this: any, path: any) {
                this.traverse(path);
                const n = path.node as CallExpression;
                if (!n.loc || !isRequireCall(n) || pattern.onlyDefault)
                    return;

                pushTapirResultIfMaybeTrue(n, tapir.fileName, res, tapir.doesAnyAccessPathMatchPattern(pattern.importPathPattern, computedAccessPaths.get(n) as Set<Node>))
            },
            visitImportDeclaration: function (this: any, path: any) {
                this.traverse(path);
                const n = path.node as ImportDeclaration;
                if (!n.loc || typeof n.source.value !== 'string') return;
                const specMatch = n.specifiers.filter(spec => !pattern.onlyDefault || isImportDefaultSpecifier(spec))
                    .some(spec => tapir.doesAnyAccessPathMatchPattern(pattern.importPathPattern, computedAccessPaths.get(spec) as Set<Node>));
                const nodeMatch = !pattern.onlyDefault && tapir.doesAnyAccessPathMatchPattern(pattern.importPathPattern, computedAccessPaths.get(n) as Set<Node>);
                pushTapirResultIfMaybeTrue(n, tapir.fileName, res, specMatch, nodeMatch);
            }
        });
        return res;
    }

    public matchReadPropertyPattern(pattern: ReadPropertyPattern): TapirMatchResult[] {
        const res: TapirMatchResult[] = [];
        const tapir = this;
        const computedAccessPaths = this.getComputeAccessPathsResults();
        visit(this.module, {
            visitMemberExpression: function (this: any, path: any) {
                this.traverse(path);
                if (isLeftHandSideInAssignment(path)) return;
                const n = path.node as MemberExpression;
                if (!n.loc || !isIdentifier(n.property) || n.computed) return;
                if (pattern.notInvoked && isCallee(path)) return;

                pushTapirResultIfMaybeTrue(n, tapir.fileName, res, tapir.doesAnyAccessPathMatchPattern(pattern.propertyPathPattern, computedAccessPaths.get(n) as Set<Node>))
            },
            visitImportDeclaration: function (this: any, path: any) {
                this.traverse(path);
                const n = path.node as ImportDeclaration;
                if (!n.loc)
                    return;
                if (n.specifiers.filter(isImportSpecifier).some(
                    spec => tapir.doesAnyAccessPathMatchPattern(pattern.propertyPathPattern, computedAccessPaths.get(spec) as Set<Node>))) {
                    pushTapirResultIfMaybeTrue(n, tapir.fileName, res, true);
                }
            },
            visitIdentifier: function (this: any, path: any) {
                this.traverse(path);
                const n = path.node as Identifier;
                if (!n.loc || !computedAccessPaths.has(n))
                    return;
                if (pattern.notInvoked && isCallee(path)) return;
                pushTapirResultIfMaybeTrue(n, tapir.fileName, res, tapir.doesAnyAccessPathMatchPattern(pattern.propertyPathPattern, computedAccessPaths.get(n) as Set<Node>));
            },
        });
        return res;
    }

    public matchWritePropertyPattern(pattern: WritePropertyPattern): TapirMatchResult[] {
        const res: TapirMatchResult[] = [];
        const tapir = this;
        const computedAccessPaths = this.getComputeAccessPathsResults();
        visit(this.module, {
            visitAssignmentExpression: function (this: any, path: any) {
                this.traverse(path);
                const n = path.node as AssignmentExpression;
                if (!n.loc || !isMemberExpression(n.left) || !isIdentifier(n.left.property) || n.left.computed) return;
                pushTapirResultIfMaybeTrue(n, tapir.fileName, res, tapir.doesAnyAccessPathMatchPattern(pattern.propertyPathPattern, computedAccessPaths.get(n) as Set<Node>));
            }
        });
        return res;
    }

    public matchCallPattern(pattern: CallPattern): TapirMatchResult[] {
        const res: TapirMatchResult[] = [];
        const tapir = this;
        const computedAccessPaths = this.getComputeAccessPathsResults();
        const handleCall = function (this: any, path: any) {
            this.traverse(path);
            const n = path.node as CallExpression;
            // @ts-ignore
            const callee = isParenthesizedExpression(n.callee) ? n.callee.expression : n.callee;
            if (!n.loc || isRequireCall(n) || (!isIdentifier(callee) && !isMemberExpression(callee))) return;
            if (pattern.onlyReturnChanged && isExpressionStatement(path.parent.node)) return;

            const isFunProtoCall =
                isMemberExpression(callee) && isIdentifier(callee.property) && callee.property.name === 'call';
            const isFunProtoApply =
                isMemberExpression(callee) && isIdentifier(callee.property) && callee.property.name === 'apply';

            const accPathMatch = tapir.doesAnyAccessPathMatchPattern(pattern.accessPathPattern, computedAccessPaths.get(n) as Set<AccessPath>);
            if (!accPathMatch)
                return;

            const filterUncertainties: (MaybeApplyOrSpreadArgFilterMatch|MaybeArgTypeMatch|DisjunctionMatchResult)[] = [];
            if (!isFunProtoApply && !n.arguments.some(arg => isSpreadElement(arg))) {
                const args = !isFunProtoCall ? n.arguments : n.arguments.slice(1);
                const filterMatches = pattern.filters.map(f => f.matches(args));
                if (filterMatches.some(fm => fm === FALSE_RESULT_INSTANCE))
                    return false;
                filterMatches.filter(fm => fm instanceof MaybeArgTypeMatch || fm instanceof DisjunctionMatchResult).forEach(fm => filterUncertainties.push(fm as (MaybeArgTypeMatch|DisjunctionMatchResult)));
            } else if (pattern.filters.length > 0) {
                filterUncertainties.push(new MaybeApplyOrSpreadArgFilterMatch(pattern.filters));
            }
            pushTapirResultIfMaybeTrue(n, tapir.fileName, res, accPathMatch, false, filterUncertainties);
        };
        visit(this.module, {
            visitCallExpression: handleCall,
            visitNewExpression: handleCall
        });
        return res;
    }

    public doesAnyAccessPathMatchPattern(pattern: AccessPathPattern, computedAccessPaths: Set<AccessPath>): boolean|UncertainAccPathMatch {
        const matchResults = [...computedAccessPaths].map(accPath => pattern.matches(accPath, this.unknownRequires));
        if (matchResults.some(mr => mr instanceof MaybeAccPathMatch || mr instanceof MaybeImportPathMatch) ||
            matchResults.some(mr => mr === FALSE_RESULT_INSTANCE) && matchResults.some(mr => mr === TRUE_RESULT_INSTANCE)) // Multiple acc paths, but only some match
            return new UncertainAccPathMatch();
        return matchResults.some(mr => mr === TRUE_RESULT_INSTANCE);
    }

    public static async runTapirOnDirectory(dirName: string, patternDescriptionFile: string, excludedFolders?: string[]): Promise<Map<Path, Map<PatternWrapper, TapirMatchResult[]>>> {
        const res: Map<Path, Map<PatternWrapper, TapirMatchResult[]>> = new Map();
        const patternDescriptionFileAbsolute = isAbsolute(patternDescriptionFile) ? patternDescriptionFile : resolve(StaticConfiguration.projectHome, patternDescriptionFile);
        let patterns : PatternWrapper[] = require(patternDescriptionFileAbsolute);
        if (!StaticConfiguration.checkForDeprecations) {
            patterns = patterns.filter(bc => !bc.deprecation);
        }
        const filesToAnalyze = await getFilesToAnalyze(dirName, excludedFolders);
        await Promise.all(filesToAnalyze.map(async file => {
            try {
                const program: Program = await parseFileWithRecast(file);
                const relFileName = relative(dirName, file);
                const tapirResultsForFile: Map<PatternWrapper, TapirMatchResult[]> = Tapir.runTapirOnFile(relFileName, program, patterns).getMatchPatternResults();
                res.set(relFileName, tapirResultsForFile);
            } catch (e) {
                if (e.message !== 'Failed parsing') {
                    throw e;
                }
            }
        }));
        return res;
    }

    public static runTapirOnFile(fileName: string, module: Program, patterns: PatternWrapper[]): Tapir {
        const res: Map<PatternWrapper, TapirMatchResult[]> = new Map();
        const tapir = new Tapir(fileName, module);
        if (StaticConfiguration.assumeFirstReceiverMatchOnUnknownLibraryObject)
            tapir.computeUnknownRequires(module);
        patterns.forEach(pattern => res.set(pattern, tapir.matchPattern(pattern)));
        tapir.matchPatternResults = res;
        return tapir;
    }

    public computeUnknownRequires(module: Program): Set<ImportAccessPath> {
        const res: Set<ImportAccessPath> = new Set();
        visit(module, {
            visitCallExpression: function (this: any, path: any) {
                this.traverse(path);
                const n = path.node as SimpleCallExpression;
                n.arguments.filter(isCallExpression)
                    .filter(isRequireCall)
                    .map(n => n.arguments[0])
                    .forEach(requireArg => {
                        if (isSimpleLiteral(requireArg) && typeof requireArg.value === 'string')
                            res.add(new ImportAccessPath(requireArg.value));
                    });
            }
        });
        this.unknownRequires = res;
        return res;
    }
}
const globalObjects = {
    "JSON": new ImportAccessPath("JSON"),
    "console": new ImportAccessPath("console"),
    "Symbol": new ImportAccessPath("Symbol"),
    "global": new ImportAccessPath("global"),
    "globalThis": new ImportAccessPath("global"),
    "Array": new ImportAccessPath("Array"),
    "Error": new ImportAccessPath("Error"),
    "System": new ImportAccessPath("System"),
    "Map": new ImportAccessPath("Map"),
    "Set": new ImportAccessPath("Set"),
    "RegExp": new ImportAccessPath("RegExp"),
    "Reflect": new ImportAccessPath("Reflect"),
    "Dict": new ImportAccessPath("Dict"),
    "Object": new ImportAccessPath("Object"),
    "Function": new ImportAccessPath("Function"),
    "Number": new ImportAccessPath("Number"),
    "String": new ImportAccessPath("String"),
    "navigator": new ImportAccessPath("navigator"),
    "window": new ImportAccessPath("global"),
    "Date": new ImportAccessPath("Date"),
    "FormData": new ImportAccessPath("FormData")
};

function isLeftHandSideInAssignment(path: any) {
    let currentPath = path;
    while (!isProgram(currentPath.parent.node) && !isBlockStatement(currentPath.parent.node) &&
            !(isMemberExpression(currentPath.parent.node) && currentPath.parent.node.object === currentPath.node)) {
        if (isAssignmentExpression(currentPath.parent.node))
            return currentPath.parent.node.left === currentPath.node;
        currentPath = currentPath.parent;
    }
    return false;
}

function isCallee(path: any): boolean {
    if (isParenthesizedExpression(path.parent.node))
        return isCallee(path.parent);
    return isCallExpression(path.parent.node) && path.parent.node.callee === path.node;
}

export type TapirMatchResult = {
    node: Node;
    fileName: string;
    uncertainAccPath?: true;
    uncertainCallFilters?: (MaybeApplyOrSpreadArgFilterMatch|MaybeArgTypeMatch|DisjunctionMatchResult)[];
}

function pushTapirResultIfMaybeTrue(n: Node, fileName: string, res: TapirMatchResult[], match1: boolean|UncertainAccPathMatch, match2?: boolean|UncertainAccPathMatch, filterUncertainties?: (MaybeApplyOrSpreadArgFilterMatch|MaybeArgTypeMatch|DisjunctionMatchResult)[]) {
    if (!match1 && !match2)
        return;
    const matchResult: TapirMatchResult = {node: n, fileName: fileName};
    if (match1 instanceof UncertainAccPathMatch || match2 instanceof UncertainAccPathMatch)
        matchResult.uncertainAccPath = true;
    if (filterUncertainties && filterUncertainties.length > 0)
        matchResult.uncertainCallFilters = filterUncertainties;
    res.push(matchResult);
}
