import {AccessPathPattern, Filter} from "../pattern-finder/pattern-language";
import {GlobPattern} from "../pattern-finder/glob";
import {Node} from "estree";

export interface MatchResult {
    negate: () => MatchResult;
}

export class TrueResult implements MatchResult {
    public negate() {
        return FALSE_RESULT_INSTANCE;
    }
}
export const TRUE_RESULT_INSTANCE = new TrueResult();
class FalseResult implements MatchResult {
    public negate() {
        return TRUE_RESULT_INSTANCE;
    }
}
export const FALSE_RESULT_INSTANCE = new FalseResult();
export class MaybeAccPathMatch implements MatchResult {
    readonly accPathMatchedByUnknown: AccessPathPattern;
    readonly negated: boolean;

    constructor(accPathMatchedByUnknown: AccessPathPattern, negated?: boolean) {
        this.accPathMatchedByUnknown = accPathMatchedByUnknown;
        this.negated = !!negated;
    }

    public negate() {
        return new MaybeAccPathMatch(this.accPathMatchedByUnknown, !this.negated);
    }
}
export class UncertainMatchDueToMultipleAccPaths implements MatchResult {
    readonly negated: boolean;

    constructor(negated?: boolean) {
        this.negated = !!negated;
    }

    public negate() {
        return new UncertainMatchDueToMultipleAccPaths(!this.negated);
    }
}
export class UncertainAccPathMatch implements MatchResult {
    readonly negated: boolean;

    constructor(negated?: boolean) {
        this.negated = !!negated;
    }

    public negate() {
        return new UncertainMatchDueToMultipleAccPaths(!this.negated);
    }
}
export class MaybeArgTypeMatch implements MatchResult {
    readonly argument: Node;
    readonly typesToMatch: string;
    readonly negated: boolean;

    constructor(argument: Node, typesToMatch: string, negated?: boolean) {
        this.argument = argument;
        this.typesToMatch = typesToMatch;
        this.negated = !!negated;
    }

    public negate() {
        return new MaybeArgTypeMatch(this.argument, this.typesToMatch, !this.negated);
    }
}
export class MaybeImportPathMatch implements MatchResult {
    readonly importPathPattern: GlobPattern;
    readonly negated: boolean;

    constructor(importPathPattern: GlobPattern, negated?: boolean) {
        this.importPathPattern = importPathPattern;
        this.negated = !!negated;
    }

    public negate() {
        return new MaybeImportPathMatch(this.importPathPattern, !this.negated);
    }
}
export class MaybeApplyOrSpreadArgFilterMatch implements MatchResult {
    readonly filters: Filter[];
    readonly negated: boolean;

    constructor(filters: Filter[], negated?: boolean) {
        this.filters = filters;
        this.negated = !!negated;
    }

    public negate() {
        return new MaybeApplyOrSpreadArgFilterMatch(this.filters, !this.negated);
    }
}

export class DisjunctionMatchResult implements MatchResult {
    readonly matchResults: Set<MatchResult>;

    constructor(matchResults: Set<MatchResult>) {
        this.matchResults = matchResults;
    }

    public negate() {
        return new ConjunctionMatchResult(new Set([...this.matchResults].map(m => m.negate())))
    }
}

class ConjunctionMatchResult implements MatchResult {
    readonly matchResults: Set<MatchResult>;

    constructor(matchResults: Set<MatchResult>) {
        this.matchResults = matchResults;
    }

    public negate() {
        return new DisjunctionMatchResult(new Set([...this.matchResults].map(m => m.negate())))
    }
}

export function orMatchResult(...matchResults: MatchResult[]): MatchResult {
    if (matchResults.some(r => r === TRUE_RESULT_INSTANCE))
        return TRUE_RESULT_INSTANCE;
    if (!matchResults.some(r => r !== FALSE_RESULT_INSTANCE))
        return FALSE_RESULT_INSTANCE;
    const res: Set<MatchResult> = new Set();
    matchResults.filter(m => m !== FALSE_RESULT_INSTANCE).forEach(m => (m instanceof DisjunctionMatchResult ? m.matchResults : new Set([m])).forEach(m => res.add(m)));
    return (res.size === 1) ? res.values().next().value : new DisjunctionMatchResult(res);
}

export function andMatchResult(...matchResults: MatchResult[]): MatchResult {
    if (matchResults.some(r => r === FALSE_RESULT_INSTANCE))
        return FALSE_RESULT_INSTANCE;
    if (!matchResults.some(r => r !== TRUE_RESULT_INSTANCE))
        return TRUE_RESULT_INSTANCE;
    const res: Set<MatchResult> = new Set();
    matchResults.filter(m => m !== TRUE_RESULT_INSTANCE).forEach(m => (m instanceof ConjunctionMatchResult ? m.matchResults : new Set([m])).forEach(m => res.add(m)));
    return (res.size === 1) ? res.values().next().value : new ConjunctionMatchResult(res);
}

export function getMatchResultFromBoolean(res: boolean) {
    return res ? TRUE_RESULT_INSTANCE : FALSE_RESULT_INSTANCE;
}
