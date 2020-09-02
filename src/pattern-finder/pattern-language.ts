export interface PatternWrapper {
    pattern: string;
    question?: string;
    transformQuestion?: string;
    uncertainAccPathQuestion?: string;
    transform: Transform
    id: string;
    changelogId: string;
    changelogDescription: string;
    deprecation?: boolean;
    benign?: boolean;
    applicationLevelQuestion?: boolean;
}
export interface Transform {
    pattern: string|TransformAnswerObject;
    cleanupPattern: CleanupPattern;
    replacements: Replacement[];
    status?: string;
}

export interface TransformAnswerObject {
    Yes: "string";
    No: "string";
}

export interface CleanupPattern {
    fromPattern: string;
    toPattern: string;
}

export interface Replacement {
    source: string;
    newName: string;
    substitutes: string[];
}
