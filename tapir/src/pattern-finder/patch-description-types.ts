export interface LibraryPatchDescriptionTypes {
    [index: string]: ClientPatchType
};

export interface ClientPatchType {
    excludedFolders?: string[];
    excludedFiles?: string[];
    patches: PatchType[];
    repo: RepoType;
    install?: boolean;
};

export interface PatchType {
    file: string;
    lineNumber: number;
    classification: string;
    truePositive?: boolean;
}

export interface RepoType {
    gitCommit: string;
    gitURL: string;
}
