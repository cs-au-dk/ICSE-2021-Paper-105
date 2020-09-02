import {PackageOperations} from "../package/package-operations";
import {Path} from "../types";
import {addMapToMapArray} from "../util/collections";
import {ClientPatchType, LibraryPatchDescriptionTypes, PatchType} from "../pattern-finder/patch-description-types";
import {StaticConfiguration} from "../static-configuration";
import {relative, resolve} from "path";
import {queue} from "async";
import {cpus} from "os";
import {Program, SourceLocation} from "estree";
import {PatternWrapper} from "../pattern-finder/pattern-language";
import {getFilesToAnalyze} from "../util/file";
import {parseFileWithRecast} from "../util/parsing";
import {createLogger} from "../logging";
import {Tapir, TapirMatchResult} from "../pattern-finder/tapir";
const logger = createLogger('DetectionExperiments', 'info');

const THROW_ERROR_IF_HIGH_CONFIDENCE_RESULT_IS_FALSE_POSITIVE = true;
export function runNewDetectionExperiments(cb: any) {
    const experiments = ["lodash@4.0.0", "async@3.0.0", "express@4.0.0", "chalk@2.0.0", "bluebird@3.0.0", "uuid@3.0.0", "commander@3.0.0", "rxjs@6.0.0", "core-js@3.0.0", "yargs@14.0.0", "node-fetch@2.0.0", "winston@3.0.0", "redux@4.0.0", "jsonwebtoken@8.0.0", "mongoose@5.0.0"];
    runExperimentsWithPatchFile(experiments, "affected-clients", "detection-patterns", cb);
}

export function runNewPrecisionExperiments(cb: any) {
    const experiments = ["lodash@4.0.0", "async@3.0.0", "express@4.0.0", "chalk@2.0.0", "bluebird@3.0.0", "uuid@3.0.0", "commander@3.0.0", "rxjs@6.0.0", "core-js@3.0.0", "yargs@14.0.0", "node-fetch@2.0.0", "winston@3.0.0", "redux@4.0.0", "jsonwebtoken@8.0.0", "mongoose@5.0.0"];
    runExperimentsWithPatchFile(experiments, "unaffected-clients", "detection-patterns", cb);
}

function runExperimentsWithPatchFile(experiments: string[], patchDescriptionDirectory: string, breakingChangeDescriptionDirectory: string, cb: (res: TapirResultForAllLibraries) => void) {
    const resArray: TapirResultForLibrary[] = [];
    const resultCB = (res: TapirResultForLibrary) => {
        resArray.push(res);
        if (resArray.length === experiments.length)
            cb(new TapirResultForAllLibraries(resArray));
    };
    experiments.forEach(exp => doExperiment(exp,`${patchDescriptionDirectory}/${exp}.patches.json`, `${breakingChangeDescriptionDirectory}/${exp}.json`, resultCB));
}

function doExperiment(libraryName: string, patchLocation: string, breakingChangeDescriptionLocation: string, cb : (res: TapirResultForLibrary) => void) {
    const patches : LibraryPatchDescriptionTypes = require(resolve(StaticConfiguration.resPath, patchLocation));
    let patterns : PatternWrapper[] = require(resolve(StaticConfiguration.resPath, breakingChangeDescriptionLocation));
    if (!StaticConfiguration.checkForDeprecations) {
        patterns = patterns.filter(bc => !bc.deprecation);
    }
    const clientNames = Object.keys(patches);
    const resArray : TapirResultForClient[] = [];
    let numberClientsProcessed = 0;
    const resultCB = (res: TapirResultForClient|undefined) => {
        numberClientsProcessed++;
        if (res)
            resArray.push(res);
        if (numberClientsProcessed === clientNames.length)
            cb(new TapirResultForLibrary(libraryName, resArray));
    };
    clientNames.forEach(clientName => globalLimitClientTests.push({patterns: patterns, clientPatches: patches[clientName], clientName: clientName, moduleName: libraryName.split("@")[0], resultCB: resultCB}));
}

async function testClient(patterns: PatternWrapper[], clientPatches: ClientPatchType, clientName: string, moduleName: string) : Promise<TapirResultForClient> {
    logger.info(`Preparing client directory for client: ${clientName}`);
    const gitDir = await PackageOperations.getPathToGitDir(clientPatches.repo.gitURL, clientPatches.repo.gitCommit, moduleName, clientName, clientPatches.install);
    const filesToAnalyze = await getFilesToAnalyze(gitDir, clientPatches.excludedFolders, clientPatches.excludedFiles);
    const resultsForClient : Map<string, Map<Path, TapirResultForFileAndPattern>> =  new Map();
    logger.info(`Starting analysis of client: ${clientName}`);
    await Promise.all(filesToAnalyze.map(async file => {
        try {
            const program: Program = await parseFileWithRecast(file);
            const tapirResultsForFile: Map<PatternWrapper, TapirMatchResult[]> = Tapir.runTapirOnFile(relative(gitDir, file), program, patterns).getMatchPatternResults();
            patterns.forEach(pattern => {
                const patchesRelatedToFileAndPattern = clientPatches.patches.filter(p => file === `${gitDir}/${p.file}`).filter(p => p.classification === pattern.id && [".js", ".es"].some(extension => !p.file.includes(".") || p.file.endsWith(extension)));
                if (!resultsForClient.has(pattern.id))
                    resultsForClient.set(pattern.id, new Map());
                let tapirResultForFileAndPattern = testPatternOnFile(file, pattern, patchesRelatedToFileAndPattern, tapirResultsForFile.get(pattern) as TapirMatchResult[]);
                if (tapirResultForFileAndPattern.hasResults())
                    (resultsForClient.get(pattern.id) as Map<string, TapirResultForFileAndPattern>).set(file, tapirResultForFileAndPattern);
            });
        } catch (e) {
            logger.debug(e);
            if (e.message !== 'Failed parsing') {
                throw e;
            }
        }
    }));
    logger.info(`Finished analysis of client: ${clientName}`);
    return new TapirResultForClient(resultsForClient);
}

function testPatternOnFile(fileName: string, pattern: PatternWrapper, patches: PatchType[], tapirResults: TapirMatchResult[]): TapirResultForFileAndPattern {
    const expectedChangesNotFound: ExpectedChange[] = []; // non-behavioral false negatives
    const expectedChangesFound: ExpectedChange[] = []; // non-behavioral true positives
    const unexpectedChangesFound: number[] = []; // non-behavioral false positives
    const expectedBehavioralChangesNotFound: ExpectedChange[] = []; // behavioral false negatives
    const expectedBehavioralChangesFound: ExpectedChange[] = []; // behavioral true positives
    const unexpectedBehavioralChangesFound: number[] = []; // behavioral false positives
    const notBenignCertainTruePositives: number[] = [];

    const lineNumbersWithPatternDetected = tapirResults.map(tmr => (tmr.node.loc as SourceLocation).start.line);
    patches.forEach(p => {
        if (lineNumbersWithPatternDetected.includes(p.lineNumber)) {
            (pattern.question ? expectedBehavioralChangesFound : expectedChangesFound).push(new ExpectedChange(p.truePositive, p.lineNumber));
            if (!pattern.question && !pattern.benign && p.truePositive !== false)
                notBenignCertainTruePositives.push(p.lineNumber);
        } else {
            (pattern.question ? expectedBehavioralChangesNotFound : expectedChangesNotFound).push(new ExpectedChange(p.truePositive, p.lineNumber));
        }
    });
    let unexpectedChanges = tapirResults.filter(tmr => !patches.some(p => p.lineNumber === (tmr.node.loc as SourceLocation).start.line));
    if (THROW_ERROR_IF_HIGH_CONFIDENCE_RESULT_IS_FALSE_POSITIVE) {
        unexpectedChanges.filter(tmr => !tmr.uncertainCallFilters && !tmr.uncertainAccPath).forEach(tmr => {
            const loc = tmr.node.loc as SourceLocation;
            throw new Error(`High confidence result in false positive: ${tmr.node.type}:${fileName}:${loc.start.line}:${loc.start.column}:${pattern.id}`);
        });
    }
    const numberCertain = tapirResults.filter(tr => !tr.uncertainAccPath && !tr.uncertainCallFilters).length;
    const numberUncertain = tapirResults.filter(tr => tr.uncertainAccPath || tr.uncertainCallFilters).length;
    unexpectedChanges.forEach(unexpectedChange => (pattern.question ? unexpectedBehavioralChangesFound : unexpectedChangesFound).push((unexpectedChange.node.loc as SourceLocation).start.line));
    return new TapirResultForFileAndPattern(expectedChangesNotFound, expectedChangesFound, unexpectedChangesFound, expectedBehavioralChangesNotFound, expectedBehavioralChangesFound, unexpectedBehavioralChangesFound, notBenignCertainTruePositives, numberCertain, numberUncertain);
}

const globalLimitClientTests =
    queue(async function(arg: {patterns: PatternWrapper[], clientPatches: ClientPatchType, clientName: string, moduleName: string, resultCB: (res: TapirResultForClient|undefined) => void}, cb) {
        arg.resultCB(await testClient(arg.patterns, arg.clientPatches, arg.clientName, arg.moduleName).catch(e => {
            logger.error(`Failed processing client ${arg.clientName} with error ${e}`);
            return undefined;
        }));
        // // Notice, we use a separate callback for processing the result since passing a value to the 'actual' callback is
        // // used to indicate an error.
        // arg.resultCB(res);
        cb();
    }, cpus().length);

class ExpectedChange {
    constructor(public truePositive: boolean | undefined, public lineNumber: number) {}

    toString(): string {
       return `${this.lineNumber}`;
    }

    get[Symbol.toStringTag]() {
        return `${this.lineNumber}`;
    }
}

class TapirResultForFileAndPattern {
    private expectedChangesNotFound: ExpectedChange[];
    private expectedChangesFound: ExpectedChange[];
    private unexpectedChangesFound: number[];
    private expectedBehavioralChangesNotFound: ExpectedChange[];
    private expectedBehavioralChangesFound: ExpectedChange[];
    private unexpectedBehavioralChangesFound: number[];
    private notBenignCertainTruePositives: number[];
    private numberCertain: number;
    private numberUncertain: number;

    constructor(expectedChangesNotFound: ExpectedChange[], expectedChangesFound: ExpectedChange[], unexpectedChangesFound: number[], expectedBehavioralChangesNotFound: ExpectedChange[], expectedBehavioralChangesFound: ExpectedChange[], unexpectedBehavioralChangesFound: number[], notBenignCertainTruePositives: number[], numberCertain: number, numberUncertain: number) {
        this.expectedChangesNotFound = expectedChangesNotFound;
        this.expectedChangesFound = expectedChangesFound;
        this.unexpectedChangesFound = unexpectedChangesFound;
        this.expectedBehavioralChangesNotFound = expectedBehavioralChangesNotFound;
        this.expectedBehavioralChangesFound = expectedBehavioralChangesFound;
        this.unexpectedBehavioralChangesFound = unexpectedBehavioralChangesFound;
        this.notBenignCertainTruePositives = notBenignCertainTruePositives;
        this.numberCertain = numberCertain;
        this.numberUncertain = numberUncertain;
    }

    public getExpectedChangesNotFound(behavioral: boolean) : number[] {
        return (behavioral ? this.expectedBehavioralChangesNotFound : this.expectedChangesNotFound).map(e => e.lineNumber);
    }

    public getExpectedChangesFound(behavioral: boolean) : ExpectedChange[] {
        return behavioral ? this.expectedBehavioralChangesFound : this.expectedChangesFound;
    }

    public getUnexpectedChangesFound(behavioral: boolean) : number[] {
        return behavioral ? this.unexpectedBehavioralChangesFound : this.unexpectedChangesFound;
    }

    public getTruePositives(behavioral: boolean): number[] {
        return this.getExpectedChangesFound(behavioral).filter(expChg => expChg.truePositive).map(expChg => expChg.lineNumber);
    }

    public getFalsePositives(behavioral: boolean): number[] {
        return this.getExpectedChangesFound(behavioral).filter(expChg => !expChg.truePositive).map(expChg => expChg.lineNumber);
    }

    public getNotBenignCertainTruePositives(): number[] {
        return this.notBenignCertainTruePositives;
    }

    public getNumberCertain(): number {
        return this.numberCertain;
    }

    public getNumberUncertain(): number {
        return this.numberUncertain;
    }

    public hasResults(): boolean {
        return this.expectedChangesNotFound.length !== 0 ||
            this.expectedChangesFound.length !== 0 ||
            this.unexpectedChangesFound.length !== 0 ||
            this.expectedBehavioralChangesNotFound.length !== 0 ||
            this.expectedBehavioralChangesFound.length !== 0 ||
            this.unexpectedBehavioralChangesFound.length !== 0;
    }
}

class TapirResultForClient {
    private results : Map<string, Map<Path, TapirResultForFileAndPattern>>;
    constructor(results: Map<string, Map<Path, TapirResultForFileAndPattern>>) {
        this.results = results;
    }

    public getNumberUncertain() : number {
        return this.sumResults(v => v.getNumberUncertain());
    }

    public getNumberCertain() : number {
        return this.sumResults(v => v.getNumberCertain());
    }

    public getExpectedChangesNotFound(behavioral: boolean) : number {
        return this.sumLengthsOfResultsArray(v => v.getExpectedChangesNotFound(behavioral));
    }

    public getExpectedChangesFound(behavioral: boolean) : number {
        return this.sumLengthsOfResultsArray(v => v.getExpectedChangesFound(behavioral));
    }

    public getUnexpectedChangesFound(behavioral: boolean) : number {
        return this.sumLengthsOfResultsArray(v => v.getUnexpectedChangesFound(behavioral));
    }

    public unexpectedDetectionSummary(behavioral: boolean) : Map<string, Map<Path, number[]>> {
        return this.summarizeResult(v => v.getUnexpectedChangesFound(behavioral));
    }

    public falseNegativeSummary(behavioral: boolean) : Map<string, Map<Path, number[]>> {
        return this.summarizeResult(v => v.getExpectedChangesNotFound(behavioral));
    }

    /**
     * Reports all expected patches (including both true positives and false positives)
     */
    public expectedChangeSummary(behavioral: boolean) : Map<string, Map<Path, ExpectedChange[]>> {
        return this.summarizeResult(v => v.getExpectedChangesFound(behavioral));
    }

    public summarizeResult<T>(transformValue: (v: TapirResultForFileAndPattern) => T[]): Map<string, Map<Path, T[]>> {
        return new Map(Array.from(this.results.entries(), ([k, v]) => [k, new Map(Array.from(v, ([k1, v1]) => [k1, transformValue(v1)]).filter(([_k1, v1]) => v1.length > 0) as any)]));
    }

    public sumLengthsOfResultsArray<T>(transformValue: (v: TapirResultForFileAndPattern) => T[]): number {
        return sum([...this.results.values()].map(v => sum([...v.values()].map(v2 => transformValue(v2).length))));
    }

    public sumResults(transformValue: (v: TapirResultForFileAndPattern) => number): number {
        return sum([...this.results.values()].map(v => sum([...v.values()].map(v2 => transformValue(v2)))));
    }

    /**
     * Reports only patches found marked as a true positive
     */
    public falsePositiveSummary(behavioral: boolean) : Map<string, Map<Path, number[]>>{
        return this.summarizeResult(v => v.getFalsePositives(behavioral));
    }

    public getFalsePositives(behavioral: boolean): number {
        return this.sumLengthsOfResultsArray(v => v.getFalsePositives(behavioral));
    }

    /**
     * Reports only patches found marked as a false positive
     */
    public truePositiveSummary(behavioral: boolean) : Map<string, Map<Path, number[]>>{
        return this.summarizeResult(v => v.getTruePositives(behavioral));
    }

    public getTruePositives(behavioral: boolean): number {
        return this.sumLengthsOfResultsArray(v => v.getTruePositives(behavioral));
    }

    public getNumberNotBenignCertainTPs() {
        return this.sumLengthsOfResultsArray(v => v.getNotBenignCertainTruePositives());
    }
}

function addMapMapArrayToMapMapArray<T, R>(target: Map<T, Map<Path, R[]>>, source: Map<T, Map<Path, R[]>>) {
    Array.from(source.keys()).forEach(k => {
        if (!target.has(k))
            target.set(k, new Map());
        addMapToMapArray(target.get(k) as Map<Path, R[]>, source.get(k) as Map<Path, R[]>);
    })
}

class TapirResultForLibrary {
    private library : string;
    private results : TapirResultForClient[];
    constructor(library: string, results: TapirResultForClient[]) {
        this.library = library;
        this.results = results;
    }

    constructRQ1TableLine(showBcPerClient: boolean) : string[] {
        const numberClients = this.getNumberClients();
        const truePositivesNonBehavioral = this.getRQ1TruePositives(false);
        const truePositivesBehavioral = this.getRQ1TruePositives(true);
        const falsePositives = this.getRQ1FalsePositives(false) + this.getRQ1FalsePositives(true);
        const changesRequired = this.getNumberBreakingChanges(false) + this.getNumberBreakingChanges(true);
        const numberCertain = this.getNumberCertain();
        const numberNotBenignCertainTPs = this.getNumberNotBenignCertainTPs();
        return TapirResultForLibrary.constructRQ1TableLineFromData(this.library, numberClients, changesRequired, truePositivesNonBehavioral, truePositivesBehavioral, falsePositives, numberCertain, showBcPerClient, numberNotBenignCertainTPs);
    }

    public static constructRQ1TableLineFromData(library: string, numberClients: number, changesRequired: number, truePositivesNonBehavioral: number, truePositivesBehavioral: number, falsePositives: number, numberCertain: number, showBcPerClient: boolean, numberNotBenignCertainTPs: number, showNotBenignTPT?: boolean) : string[] {
        const totalTruePositives = truePositivesNonBehavioral + truePositivesBehavioral;
        const recall = (totalTruePositives / changesRequired) * 100;
        const tpFrac = (totalTruePositives / (totalTruePositives + falsePositives)) * 100;
        const res = [
            library,
            "" + numberClients,
            "" + recall + "%",
            "" + totalTruePositives,
            "" + truePositivesNonBehavioral,
            "" + truePositivesBehavioral,
            "" + falsePositives,
            "" + (Number.isNaN(tpFrac) ? 100 : tpFrac.toFixed(0)) + '%',
            "" + numberCertain
        ];
        if (showNotBenignTPT)
            res.push("" + numberNotBenignCertainTPs);
        if (showBcPerClient) {
            res.push("" + (changesRequired/numberClients).toFixed(1));
        }
        return res;
    }

    public getNumberClients() {
        return this.results.length;
    }

    public getNumberUncertain() {
        return sum(this.results.map(e => e.getNumberUncertain()));
    }

    public getNumberCertain() {
        return sum(this.results.map(e => e.getNumberCertain()));
    }

    public getNumberBreakingChanges(behavioral: boolean) {
        return this.getRQ1TruePositives(behavioral) + this.getRQ1FalseNegatives(behavioral);
    }

    public getRQ1FalsePositives(behavioral: boolean) {
        return sum(this.results.map(e => e.getUnexpectedChangesFound(behavioral)));
    }

    public getRQ1FalseNegatives(behavioral: boolean) {
        return sum(this.results.map(e => e.getExpectedChangesNotFound(behavioral)));
    }

    public getRQ1TruePositives(behavioral: boolean) {
        return sum(this.results.map(e => e.getExpectedChangesFound(behavioral)));
    }

    public getNumberNotBenignCertainTPs() {
        return sum(this.results.map(e => e.getNumberNotBenignCertainTPs()));
    }

    constructRQ2TableLine(showUnclassified: boolean, showExpectedNotFound: boolean, showNotBenignTPT?: boolean) : string[] {
        const numberClients = this.getNumberClients();
        const clientsWithWarnings = this.getNumberClientsWithWarnings();
        const clientsWithTP = this.getNumberClientsWithTP();
        const clientsWithFP = this.getNumberClientsWithFP();
        const truePositivesNonBehavioral = this.getRQ2TruePositives(false);
        const truePositivesBehavioral = this.getRQ2TruePositives(true);
        const falsePositives = this.getRQ2FalsePositives(false) + this.getRQ2FalsePositives(true);
        const numberUnexpectedFound = this.getRQ2NumberUnexpectedFound(false) + this.getRQ2NumberUnexpectedFound(true);
        const numberExpectedNotFound = this.getRQ2NumberExpectedNotFound(false) + this.getRQ2NumberExpectedNotFound(true);
        const numberNotBenignCertainTPs = this.getNumberNotBenignCertainTPs();
        return TapirResultForLibrary.constructRQ2TableLineFromData(this.library, numberClients, clientsWithWarnings, clientsWithTP, clientsWithFP, truePositivesNonBehavioral, truePositivesBehavioral, falsePositives,
            numberUnexpectedFound, numberExpectedNotFound, this.getNumberCertain(), showUnclassified, showExpectedNotFound, numberNotBenignCertainTPs, showNotBenignTPT);
    }

    public getRQ2NumberExpectedNotFound(behavioral: boolean) {
        return sum(this.results.map(e => e.getExpectedChangesNotFound(behavioral)));
    }

    public getRQ2NumberUnexpectedFound(behavioral: boolean) {
        return sum(this.results.map(e => e.getUnexpectedChangesFound(behavioral)));
    }

    public getRQ2FalsePositives(behavioral: boolean) {
        return sum(this.results.map(e => e.getFalsePositives(behavioral)));
    }

    public getRQ2TruePositives(behavioral: boolean) {
        return sum(this.results.map(e => e.getTruePositives(behavioral)));
    }

    public getNumberClientsWithTP() {
        return this.results.filter(r => r.getTruePositives(false) > 0 || r.getTruePositives(true) > 0).length;
    }

    public getNumberClientsWithFP() {
        return this.results.filter(r => r.getFalsePositives(false) > 0 || r.getFalsePositives(true) > 0).length;
    }

    public getNumberClientsWithWarnings() {
        return this.results.filter(r => r.getExpectedChangesFound(false) > 0 || r.getExpectedChangesFound(true) > 0 || r.getUnexpectedChangesFound(false) > 0 || r.getUnexpectedChangesFound(true) > 0).length;
    }

    public static constructRQ2TableLineFromData(library: string, numberClients: number, clientsWithWarnings: number, clientsWithTP: number, clientsWithFP: number, truePositivesNonBehavioral: number, truePositivesBehavioral: number, falsePositives: number, numberUnexpectedFound: number, numberExpectedNotFound: number, numberCertain: number, showUnclassified: boolean, showExpectedNotFound: boolean, numberNotBenignCertainTPs: number, showNotBenignTPT?: boolean) {
        const totalTruePositives = truePositivesNonBehavioral + truePositivesBehavioral;
        const tpFrac = (totalTruePositives / (totalTruePositives + falsePositives)) * 100;
        const res = [
            library,
            "" + numberClients,
            "" + clientsWithWarnings,
            "" + clientsWithTP,
            "" + clientsWithFP,
            "" + totalTruePositives,
            "" + truePositivesNonBehavioral,
            "" + truePositivesBehavioral,
            "" + falsePositives,
            "" + (Number.isNaN(tpFrac) ? 100 : tpFrac.toFixed(0)) + '%',
            "" + numberCertain
        ];
        if (showNotBenignTPT)
            res.push("" + numberNotBenignCertainTPs);
        if (showUnclassified)
            res.push("" + numberUnexpectedFound);

        if (showExpectedNotFound)
            res.push("" + numberExpectedNotFound);
        return res;
    }

    public unexpectedDetectionSummary() : Map<string, Map<Path, number[]>> {
        const res: Map<string, Map<Path, number[]>> = new Map();
        this.results.forEach(re => addMapMapArrayToMapMapArray(res, re.unexpectedDetectionSummary(false)));
        this.results.forEach(re => addMapMapArrayToMapMapArray(res, re.unexpectedDetectionSummary(true)));
        return res;
    }

    public falseNegativeSummary() : Map<string, Map<Path, number[]>> {
        const res: Map<string, Map<Path, number[]>> = new Map();
        this.results.forEach(re => addMapMapArrayToMapMapArray(res, re.falseNegativeSummary(false)));
        this.results.forEach(re => addMapMapArrayToMapMapArray(res, re.falseNegativeSummary(true)));
        return res;
    }

    public expectedChangeSummary() {
        const res: Map<string, Map<Path, ExpectedChange[]>> = new Map();
        this.results.forEach(re => addMapMapArrayToMapMapArray(res, re.expectedChangeSummary(false)));
        this.results.forEach(re => addMapMapArrayToMapMapArray(res, re.expectedChangeSummary(true)));
        return res;
    }
}

export class TapirResultForAllLibraries {
    private results : TapirResultForLibrary[];
    constructor(results: TapirResultForLibrary[]) {
        this.results = results;
    }

    public constructRQ1Table(showBcPerClient: boolean, showNotBenignTPT?: boolean) : string[][] {
        const table : string[][] = [];
        table.push(['Library', '#Clients', 'Recall', '#TP', '#TP(T)', '#TP(U)', '#FP', 'Precision (TP%)', 'High confidence']);
        if (showNotBenignTPT)
            table[0].push('#Not benign TP(T)');
        if (showBcPerClient) {
            table[0].push('#BCs/#Clients')
        }
        this.results.forEach( res => table.push(res.constructRQ1TableLine(showBcPerClient)));
        table.push(this.constructRQ1SummaryLine(showBcPerClient));
        return table;
    }

    private constructRQ1SummaryLine(showBcPerClient: boolean, showNotBenignTPT?: boolean) {
        const numberClients = this.results.reduce((acc, elem) => acc + elem.getNumberClients(), 0);
        const truePositivesNonBehavioral = this.results.reduce((acc, elem) => acc + elem.getRQ1TruePositives(false), 0);
        const truePositivesBehavioral = this.results.reduce((acc, elem) => acc + elem.getRQ1TruePositives(true), 0);
        const falsePositives = this.results.reduce((acc, elem) => acc + elem.getRQ1FalsePositives(false) + elem.getRQ1FalsePositives(true), 0);
        const changesRequired = this.results.reduce((acc, elem) => acc + elem.getNumberBreakingChanges(false) + elem.getNumberBreakingChanges(true), 0);
        const numberCertain = this.results.reduce((acc, elem) => acc + elem.getNumberCertain(), 0);
        const numberNotBenignCertainTPs = this.results.reduce((acc, elem) => acc + elem.getNumberNotBenignCertainTPs(), 0);
        return TapirResultForLibrary.constructRQ1TableLineFromData("Total", numberClients, changesRequired, truePositivesNonBehavioral, truePositivesBehavioral, falsePositives, numberCertain, showBcPerClient, numberNotBenignCertainTPs, showNotBenignTPT);
    }

    public constructRQ2Table(showUnclassified: boolean, showExpectedNotFound: boolean, showNotBenignTPT?: boolean): string[][] {
        const table: string[][] = [];
        table.push(['Library', '#Clients', '#Clients (warning)', '#Clients (TP)', '#Clients (FP)','#TP', '#TP(T)', '#TP(U)', '#FP', 'Precision (TP%)', 'High confidence']);
        if (showNotBenignTPT)
            table[0].push('#Not benign TP(T)');
        if (showUnclassified) {
            table[0].push('#Unclassified');
        }
        if (showExpectedNotFound)
            table[0].push("Classified but not found");
        this.results.forEach( res => table.push(res.constructRQ2TableLine(showUnclassified, showExpectedNotFound, showNotBenignTPT)));
        table.push(this.constructRQ2SummaryLine(showUnclassified, showExpectedNotFound, showNotBenignTPT));
        return table;
    }

    private constructRQ2SummaryLine(showUnclassified: boolean, showExpectedNotFound: boolean, showNotBenignTPT?: boolean) {
        const numberClients = sum(this.results.map(r => r.getNumberClients()));
        const clientsWithWarnings = sum(this.results.map(r => r.getNumberClientsWithWarnings()));
        const clientsWithTP = sum(this.results.map(r => r.getNumberClientsWithTP()));
        const clientsWithFP = sum(this.results.map(r => r.getNumberClientsWithFP()));
        const truePositivesNonBehavioral = sum(this.results.map(r => r.getRQ2TruePositives(false)));
        const truePositivesBehavioral = sum(this.results.map(r => r.getRQ2TruePositives(true)));
        const falsePositives = sum(this.results.map(r => r.getRQ2FalsePositives(false) + r.getRQ2FalsePositives(true)));
        const numberUnexpectedFound = sum(this.results.map(r => r.getRQ2NumberUnexpectedFound(false) + r.getRQ2NumberUnexpectedFound(true)));
        const numberExpectedNotFound = sum(this.results.map(r => r.getRQ2NumberExpectedNotFound(false) + r.getRQ2NumberExpectedNotFound(true)));
        const numberCertain = sum(this.results.map(r => r.getNumberCertain()));
        const numberNotBenignCertainTPs = sum(this.results.map(r => r.getNumberNotBenignCertainTPs()));
        return TapirResultForLibrary.constructRQ2TableLineFromData("Total", numberClients, clientsWithWarnings, clientsWithTP, clientsWithFP, truePositivesNonBehavioral, truePositivesBehavioral, falsePositives,
            numberUnexpectedFound, numberExpectedNotFound, numberCertain, showUnclassified, showExpectedNotFound, numberNotBenignCertainTPs, showNotBenignTPT);
    }

    /**
     * Returns a map from breaking change classification to all the false positives of that classification
     */
    public unexpectedChangeSummary() : Map<string, Map<Path, number[]>> {
        const res: Map<string, Map<Path, number[]>> = new Map();
        this.results.forEach(re => addMapMapArrayToMapMapArray(res, re.unexpectedDetectionSummary()));
        return res;
    }

    public falseNegativeSummary() {
        const res: Map<string, Map<Path, number[]>> = new Map();
        this.results.forEach(re => addMapMapArrayToMapMapArray(res, re.falseNegativeSummary()));
        return res;
    }

    public expectedChangeSummary() {
        const res: Map<string, Map<Path, ExpectedChange[]>> = new Map();
        this.results.forEach(re => addMapMapArrayToMapMapArray(res, re.expectedChangeSummary()));
        return res;
    }
}

function sum(arr : number[]) : number {
    return arr.reduce((acc, elem) => acc + elem, 0);
}
