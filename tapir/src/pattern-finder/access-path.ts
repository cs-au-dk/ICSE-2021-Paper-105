export interface AccessPath {
    toString: () => string;
}
export class UnknownAccessPath implements AccessPath {
    public toString() {
        return "U";
    }
}
export const unknownAccessPathInstance = new UnknownAccessPath();
export class ImportAccessPath implements AccessPath {
    readonly importPath: string;
    constructor(importPath: string) {
        this.importPath = importPath;
    }
    public toString() {
        return `<${this.importPath}>`;
    }
}
export class PropAccessPath implements AccessPath {
    readonly receiver: AccessPath;
    readonly prop: string;
    constructor(receiver: AccessPath, prop: string) {
        this.receiver = receiver;
        this.prop = prop;
    }
    public toString() {
        return `${this.receiver}.${this.prop}`;
    }
}
export class CallAccessPath implements AccessPath {
    readonly callee: AccessPath;
    constructor(callee: AccessPath) {
        this.callee = callee;
    }
    public toString() {
        return `${this.callee}()`;
    }
}

export class ThisAccessPath implements AccessPath {
    constructor() {
    }
    public toString() {
        return `this`;
    }
}

export function parseAccessPath(accPath: string): AccessPath {
    if (accPath.endsWith("()"))
        return new CallAccessPath(parseAccessPath(accPath.substring(0, accPath.length - 2)));
    if (accPath.startsWith("<") && accPath.endsWith(">"))
        return new ImportAccessPath(accPath.substring(1, accPath.length - 1));
    if (accPath === "U")
        return unknownAccessPathInstance;
    if (accPath.includes(".")) {
        const receiverAccPathString = accPath.substring(0, accPath.lastIndexOf("."));
        const propName = accPath.substring(accPath.lastIndexOf(".") + 1);
        return new PropAccessPath(parseAccessPath(receiverAccPathString), propName);
    }
    throw new Error(`Invalid accPath: ${accPath}`);
}
