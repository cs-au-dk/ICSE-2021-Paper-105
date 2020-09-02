import {Node} from 'estree';
import {isArrayExpression, isArrowFunctionExpression, isFunctionExpression, isNegationExpression, isObjectExpression, isSimpleLiteral, isTemplateLiteral} from "../util/ast-utils";
import {globMatch, GlobPattern, parseGlobPattern} from "./glob";
import {andMatchResult, FALSE_RESULT_INSTANCE, getMatchResultFromBoolean, MatchResult, MaybeAccPathMatch, MaybeArgTypeMatch, MaybeImportPathMatch, orMatchResult, TRUE_RESULT_INSTANCE} from "../interactive/tapir-interactive";
import {AccessPath, CallAccessPath, ImportAccessPath, PropAccessPath, ThisAccessPath, UnknownAccessPath} from "./access-path";

export interface PatternWrapper {
    pattern: string;
    question?: string;
    id: string;
    changelogId: string;
    changelogDescription: string;
    deprecation?: boolean;
    benign?: boolean;
}

export interface Pattern {}
export class ImportPattern implements Pattern {
    readonly importPathPattern: ImportPathPattern;
    readonly onlyDefault: boolean;
    constructor(importPathPattern: ImportPathPattern, onlyDefault: boolean) {
        this.importPathPattern = importPathPattern;
        this.onlyDefault = onlyDefault;
    }
    public toString(): string {
        return `import${this.onlyDefault ? "D" : ""} ${this.importPathPattern.toString(true)}`;
    }
}

export class ReadPropertyPattern implements Pattern {
    readonly propertyPathPattern: PropertyPathPattern;
    readonly notInvoked: boolean; // If true match only read properties that are not syntactically the callee
    constructor(propertyPathPattern: PropertyPathPattern, notInvoked: boolean) {
        this.propertyPathPattern = propertyPathPattern;
        this.notInvoked = notInvoked;
    }
    public toString(): string {
        return `read${this.notInvoked ? "O" : ""} ${this.propertyPathPattern}`;
    }
}

export class WritePropertyPattern implements Pattern {
    readonly propertyPathPattern: PropertyPathPattern;
    constructor(propertyPathPattern: PropertyPathPattern) {
        this.propertyPathPattern = propertyPathPattern;
    }
    public toString(): string {
        return `write ${this.propertyPathPattern}`;
    }
}

export class CallPattern implements Pattern {
    readonly accessPathPattern: AccessPathPattern;
    readonly filters: Filter[];
    readonly onlyReturnChanged: boolean;
    constructor(accessPathPattern: AccessPathPattern, filters: Filter[], onlyReturnChanged: boolean) {
        this.accessPathPattern = accessPathPattern;
        this.filters = filters;
        this.onlyReturnChanged = onlyReturnChanged;
    }
    public toString(): string {
        return `call${this.onlyReturnChanged ? "R" : ""} ${[this.accessPathPattern, ...this.filters].join(" ")}`;
    }
}

export class PropertyPathPattern implements AccessPathPattern {
    readonly receiver: AccessPathPattern;
    readonly propNames: string[];
    constructor(receiver: AccessPathPattern, propNames: string[]) {
        this.receiver = receiver;
        this.propNames = propNames;
    }
    public toString(): string {
        return this.propNames.length === 1 ?
            `${this.receiver}.${this.propNames[0]}`:
            `${this.receiver}.{${this.propNames.join(",")}}`;
    }

    public matches(accPath: AccessPath, unknownRequires: Set<ImportAccessPath>): MatchResult {
        if (accPath instanceof PropAccessPath && this.propNames.includes(accPath.prop))
            return this.receiver.matches(accPath.receiver, unknownRequires);
        return FALSE_RESULT_INSTANCE;
    }
}

export interface AccessPathPattern {
    matches: (accPath: AccessPath, unknownRequires: Set<ImportAccessPath>) => MatchResult;
}

export class ImportPathPattern implements AccessPathPattern {
    readonly importPathPattern: GlobPattern;
    constructor(importPathPattern: string) {
        this.importPathPattern = parseGlobPattern(importPathPattern);
    }
    public toString(ignoreAngleBrackets?: boolean): string {
        if (ignoreAngleBrackets)
            return `${this.importPathPattern}`;
        return `<${this.importPathPattern}>`;
    }

    public matches(accPath: AccessPath, unknownRequires: Set<ImportAccessPath>): MatchResult {
        if (accPath instanceof ImportAccessPath) {
            const importString = accPath.importPath.endsWith(".js") ? accPath.importPath.substring(0, accPath.importPath.length - 3) : accPath.importPath;
            return globMatch(importString, this.importPathPattern) ? TRUE_RESULT_INSTANCE : FALSE_RESULT_INSTANCE;
        } else if (accPath instanceof UnknownAccessPath && [...unknownRequires].some(ukr => globMatch(ukr.importPath, this.importPathPattern)))
            return new MaybeImportPathMatch(this.importPathPattern);
        return FALSE_RESULT_INSTANCE;
    }
}

export class DisjunctionAccessPathPattern implements AccessPathPattern {
    readonly accessPathPatterns: AccessPathPattern[];
    constructor(accessPathPatterns: AccessPathPattern[]) {
        this.accessPathPatterns = accessPathPatterns;
    }
    public toString(): string {
        return `{${this.accessPathPatterns.map(accPath => accPath.toString()).join(",")}}`;
    }

    public matches(accPath: AccessPath, unknownRequires: Set<ImportAccessPath>): MatchResult {
        return orMatchResult(...this.accessPathPatterns.map(accPathPattern => accPathPattern.matches(accPath, unknownRequires)))
    }
}

export class ExclusionAccessPathPattern implements AccessPathPattern {
    readonly includeAccPathPattern: AccessPathPattern;
    readonly excludeAccPathPattern: AccessPathPattern;
    constructor(includeAccPathPattern: AccessPathPattern, excludeAccPathPattern: AccessPathPattern) {
        this.includeAccPathPattern = includeAccPathPattern;
        this.excludeAccPathPattern = excludeAccPathPattern;
    }
    public toString(): string {
        return `(${this.includeAccPathPattern}\\${this.excludeAccPathPattern})`;
    }

    public matches(accPath: AccessPath, unknownRequires: Set<ImportAccessPath>): MatchResult {
        return andMatchResult(this.includeAccPathPattern.matches(accPath, unknownRequires), this.excludeAccPathPattern.matches(accPath, unknownRequires).negate());
    }
}

export class CallAccessPathPattern implements AccessPathPattern {
    readonly accessPathPattern: AccessPathPattern;
    constructor(accessPathPattern: AccessPathPattern) {
        this.accessPathPattern = accessPathPattern;
    }
    public toString(): string {
        return `${this.accessPathPattern}()`;
    }

    public matches(accPath: AccessPath, unknownRequires: Set<ImportAccessPath>): MatchResult {
        if (accPath instanceof CallAccessPath)
            return this.accessPathPattern.matches(accPath.callee, unknownRequires);
        return FALSE_RESULT_INSTANCE;
    }
}

export class WildcardAccessPathPattern implements AccessPathPattern {
    readonly accessPathPattern: AccessPathPattern;
    constructor(accessPathPattern: AccessPathPattern) {
        this.accessPathPattern = accessPathPattern;
    }
    public toString(): string {
        return `${this.accessPathPattern}**`;
    }

    public matches(accPath: AccessPath, unknownRequires: Set<ImportAccessPath>): MatchResult {
        let nextElementResult = FALSE_RESULT_INSTANCE;
        if (accPath instanceof PropAccessPath)
            nextElementResult = this.matches(accPath.receiver, unknownRequires);
        else if (accPath instanceof CallAccessPath)
            nextElementResult = this.matches(accPath.callee, unknownRequires);
        return orMatchResult(this.accessPathPattern.matches(accPath, unknownRequires), nextElementResult);
    }
}

export class PotentiallyUnknownAccessPathPattern implements AccessPathPattern {
    readonly accessPathPattern: AccessPathPattern;
    constructor(accessPathPattern: AccessPathPattern) {
        this.accessPathPattern = accessPathPattern;
    }
    public toString(): string {
        return `${this.accessPathPattern}?`;
    }

    public matches(accPath: AccessPath, unknownRequires: Set<ImportAccessPath>): MatchResult {
        if (accPath instanceof UnknownAccessPath || accPath instanceof ThisAccessPath)
            return new MaybeAccPathMatch(this.accessPathPattern);
        return this.accessPathPattern.matches(accPath, unknownRequires);
    }
}

export interface Filter {
    matches: (args: Node[]) => MatchResult;
}

export class NumArgsFilter implements Filter {
    readonly minArgs: number;
    readonly maxArgs: number;
    constructor(minArgs: number, maxArgs: number) {
        this.minArgs = minArgs;
        this.maxArgs = maxArgs;
    }
    public toString(): string {
        return `[${this.minArgs}, ${this.maxArgs}]`;
    }
    public matches(args: Node[]): MatchResult {
        return getMatchResultFromBoolean(args.length >= this.minArgs && args.length <= this.maxArgs);
    }
    public getMinArgs() {
        return this.minArgs;
    }
    public getMaxArgs() {
        return this.maxArgs;
    }
}

export class ArgTypeFilter implements Filter {
    readonly argNumber: number;
    readonly argTypes: JSType[];
    constructor(argNumber: number, argTypes: JSType[]) {
        this.argNumber = argNumber;
        this.argTypes = argTypes;
    }
    public toString(): string {
        return this.argTypes.length === 1 ?
            `${this.argNumber}:${this.argTypes[0]}`:
            `${this.argNumber}:{${this.argTypes.join(",")}}`
    }
    public matches(args: Node[]): MatchResult {
        const argument = args[this.argNumber];

        function getValueFromLiteral(jstype: JSType) {
            if ((jstype.startsWith(`'`) && jstype.endsWith(`'`)) || (jstype.startsWith(`"`) && jstype.endsWith(`"`)))
                return jstype.substring(1, jstype.length - 1);
            else if (jstype === "NaN")
                return NaN;
            else if (jstype === "undefined")
                return undefined;
            else if (jstype === "false")
                return false;
            else if (jstype === "true")
                return true;
            const numberRes = parseInt(jstype);
            if (isNaN(numberRes))
                throw new Error(`Invalid type in type filter: ${jstype}`);
            return numberRes;
        }

        return orMatchResult(...this.argTypes.map(jstype => {
            if (isSimpleLiteral(argument)) {
                if (JSTypes.includes(jstype)) {
                    return getMatchResultFromBoolean(typeof argument.value === jstype);
                } else {
                    return getMatchResultFromBoolean(argument.value === getValueFromLiteral(jstype));
                }
            }
            if (isFunctionExpression(argument) || isArrowFunctionExpression(argument)) {
                if (jstype === 'function') return TRUE_RESULT_INSTANCE;
                for (let i = 1; i <= 3; i++)
                    if (jstype === 'function' + i) return getMatchResultFromBoolean(argument.params.length === i);
                return FALSE_RESULT_INSTANCE;
            }
            if (isObjectExpression(argument)) {
                return getMatchResultFromBoolean(jstype === 'object');
            }
            if (isArrayExpression(argument)) {
                return getMatchResultFromBoolean(jstype === 'array');
            }
            if (isTemplateLiteral(argument)) {
                return getMatchResultFromBoolean(jstype === 'string');
            }
            if (isNegationExpression(argument)) {
                return getMatchResultFromBoolean(jstype === 'boolean');
            }
            return new MaybeArgTypeMatch(argument, jstype);
        }));
    }
}

export function parsePattern(pattern: string): Pattern {
    const [kind, path] = pattern.split(" ");
    if (kind === "import") {
        return new ImportPattern(new ImportPathPattern(path), false);
    } else if (kind === "importD") {
        return new ImportPattern(new ImportPathPattern(path), true);
    } else if (kind.startsWith("read")) {
        const propertyPathPattern = parsePropertyPathPattern(path);
        return new ReadPropertyPattern(propertyPathPattern, kind === "readO")
    } else if (kind === "write") {
        const propertyPathPattern = parsePropertyPathPattern(path);
        return new WritePropertyPattern(propertyPathPattern);
    } else if (kind.startsWith("call")) {
        const accessPathPattern = parseAccessPathPattern(path);
        const filters = parseFilters(pattern);
        return new CallPattern(accessPathPattern, filters, kind === "callR");
    }
    throw new Error(`Invalid pattern kind. Expected import, read, write or call, but got: ${kind}`);
}

function parsePropertyPathPattern(path: string): PropertyPathPattern {
    const indexLastDot = path.lastIndexOf(".");
    if (indexLastDot === -1 || indexLastDot === path.length - 1 || indexLastDot === 0) {
        throw new Error(`Not a valid property path pattern: ${path}`);
    }
    const receiverAccessPath = parseAccessPathPattern(path.substring(0, indexLastDot));
    const propertyString = path.substring(indexLastDot + 1);

    const propNames: string[] = propertyString.startsWith("{") && propertyString.endsWith("}") ?
        propertyString.substring(1, propertyString.length - 1).split(",").map(str => str.trim()) :
        [propertyString];

    return new PropertyPathPattern(receiverAccessPath, propNames);
}

export function parseAccessPathPattern(path: string): AccessPathPattern {
    if (path.startsWith("<") && path.endsWith(">"))
        return new ImportPathPattern(path.substring(1, path.length - 1));
    if (path.startsWith("{") && isDisjunctionAccessPathPattern(path))
        return new DisjunctionAccessPathPattern(splitConnectiveString(path.substring(1, path.length - 1), ',', '{', '}').map(str => str.trim()).map(parseAccessPathPattern));
    if (path.startsWith("(") && isExclusionAccessPathPattern(path)) {
        const [includeAccPathPattern, excludeAccPathPattern] = splitConnectiveString(path.substring(1, path.length - 1), '\\', '(', ')').map(str => str.trim()).map(parseAccessPathPattern);
        return new ExclusionAccessPathPattern(includeAccPathPattern, excludeAccPathPattern);
    }
    if (path.endsWith("()"))
        return new CallAccessPathPattern(parseAccessPathPattern(path.substring(0, path.length - 2)));
    if (path.endsWith("**"))
        return new WildcardAccessPathPattern(parseAccessPathPattern(path.substring(0, path.length - 2)));
    if (path.endsWith("?"))
        return new PotentiallyUnknownAccessPathPattern(parseAccessPathPattern(path.substring(0, path.length - 1)));
    try {
        return parsePropertyPathPattern(path);
    } catch (e) {
        throw new Error(`Not a valid AccessPathPattern string: ${path}`);
    }
}

function isConnectiveAccessPath(path: string, splitOperator: string, useCurly: boolean) {
    const startSymbol = useCurly ? '{' : '(';
    const endSymbol = useCurly ? '}' : ')';
    if (!path.startsWith(startSymbol) || !path.endsWith(endSymbol))
        return false;
    let hasSeenSplitter = false;
    let parenLevel = 1;
    for (let i = 1; i < path.length - 1; i++) {
        if (path.charAt(i) === startSymbol)
            parenLevel++;
        else if (path.charAt(i) === splitOperator && parenLevel === 1)
            hasSeenSplitter = true;
        else if (path.charAt(i) === endSymbol)
            parenLevel--;
        if (parenLevel === 0)
            return false;
    }
    return hasSeenSplitter;
}

function isDisjunctionAccessPathPattern(path: string): boolean {
    return isConnectiveAccessPath(path, ',', true);
}

function isExclusionAccessPathPattern(path: string): boolean {
    return isConnectiveAccessPath(path, '\\', false);
}

function splitConnectiveString(path: string, connectiveOperator: string, startSymbol: string, endSymbol: string): string[] {
    const res = [];
    let parenLevel = 0;
    let nextSplitStart = 0;
    for (let i = 0; i < path.length; i++) {
        if (path.charAt(i) === startSymbol)
            parenLevel++;
        else if (path.charAt(i) === endSymbol)
            parenLevel--;
        if (parenLevel === 0 && path.charAt(i) === connectiveOperator) {
            res.push(path.substring(nextSplitStart, i));
            nextSplitStart = i + 1;
        }
    }
    res.push(path.substring(nextSplitStart, path.length));
    return res;
}

export function parseFilters(pattern: string): Filter[] {
    return splitConnectiveString(pattern.split(" ").splice(2).join(" "), " ", "[", "]").map(filterString => filterString.trim()).filter(str => str).map(parseFilter);
}

function parseFilter(filterString: string): Filter {
    const numArgsMatch = filterString.match("\\[\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\]");
    if (numArgsMatch) {
        return new NumArgsFilter(parseInt(numArgsMatch[1]), parseInt(numArgsMatch[2]));
    }
    const multipleTypesMatch = filterString.match("(\\d+)\\s*:\\s*\\{(.*)\\}");
    if (multipleTypesMatch) {
        const [ /* fullMatch */ , argNum, typesString] = multipleTypesMatch;
        return new ArgTypeFilter(parseInt(argNum), typesString.split(",").map(str => str.trim()));
    }
    const singleTypeMatch = filterString.match("(\\d+)\\s*:\\s*(.*)");
    if (singleTypeMatch) {
        const [ /* fullMatch */ , argNum, typesString] = singleTypeMatch;
        return new ArgTypeFilter(parseInt(argNum), [typesString.trim()]);
    }
    throw new Error(`Invalid filter: ${filterString}`);
}

export type JSType = 'string'|'number'|'boolean'|'undefined'|'function'|'function1'|'function2'|'function3'|'object'|'array'|string;
export const JSTypes = ['string','number','boolean','undefined','function','function1','function2','function3','object','array'];
