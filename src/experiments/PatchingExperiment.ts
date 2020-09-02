import {PackageOperations} from "../package/package-operations";
import {StaticConfiguration} from "../static-configuration";
import {relative, resolve} from "path";
import {PatternWrapper} from "../pattern-finder/pattern-language";
import {Patcher} from "../pattern-finder/patcher";
import {createLogger} from "../logging";
import {parseFileWithRecast} from "../util/parsing";
import {addToMapSet} from "../util/collections";
import {getFilesToAnalyze} from "../util/file";
import {Tapir, TapirMatchResult} from "tapir";
import {TapirInteractivePhase} from "../interactive/tapir-interactive";
import {applySeries, mapSeries} from "../util/promise";
import {exec} from "child_process";
import {promisify as p} from "util";
import chalk from "chalk";
import {Path} from "../types";
const logger = createLogger('package-operations', 'info');
const USE_DOCKER=false;

export async function runPatchingExperiments(): Promise<PatcherResultForAllLibraries> {
    const experiments = ["lodash@4.0.0", "async@3.0.0", "express@4.0.0", "chalk@2.0.0", "bluebird@3.0.0", "uuid@3.0.0", "rxjs@6.0.0", "core-js@3.0.0", "node-fetch@2.0.0", "winston@3.0.0", "redux@4.0.0", "mongoose@5.0.0"];
    return await runExperiments(experiments, "affected-clients-experiment", false, false);
}

async function runExperiments(libraries: string[], experiment: string, pullRequestExperiment: boolean, onlyPatch: boolean) {
    const libraryResults: PatcherResultForLibrary[] = await mapSeries(libraries, async library => {
        const clients = require(resolve(StaticConfiguration.resPath, `${experiment}`, 'clients', `${library}.clients.json`));
        const clientResults: PatcherResultForClient[] = await mapSeries(clients, async (client: any) => {
            logger.info("Starting experiment for client: " + client.name);
            logger.info(`Preparing patcher dir: ${client.name}`);
            let patcherRunningDir = await PackageOperations.getPathToPatcherDir(client.repo.gitURL, client.repo.gitCommit, library, client.name, !onlyPatch);
            if (client.packagePath)
                patcherRunningDir = resolve(patcherRunningDir, client.packagePath);
            return await runTapirAndPatcherInDir(patcherRunningDir, resolve(StaticConfiguration.resPath, `semantic-patches/${library}.json`), client.excludedFolders, client.excludedFiles, library, client.name, pullRequestExperiment, onlyPatch, true, resolve(StaticConfiguration.resPath, `${experiment}/questions`), client.testCommand);
        });
        return new PatcherResultForLibrary(library, clientResults);
    });
    return new PatcherResultForAllLibraries(libraryResults);
}

export async function runPullRequestPatchingExperiments() {
    const libraries = ["lodash@4.0.0", "async@3.0.0", "express@4.0.0", "chalk@2.0.0", "bluebird@3.0.0", "uuid@3.0.0", "rxjs@6.0.0", "core-js@3.0.0", "node-fetch@2.0.0", "winston@3.0.0", "redux@4.0.0", "mongoose@5.0.0"];
    return runExperiments(libraries, 'pull-request-experiment', true, true);
}

function readPatterns(semanticPatchFile: string): PatternWrapper[] {
    let patterns : PatternWrapper[] = require(semanticPatchFile);
    if (!StaticConfiguration.checkForDeprecations) {
        patterns = patterns.filter(bc => !bc.deprecation);
    }
    return patterns;
}

export async function runTapirAndPatcherInDir(patcherRunningDir: string, semanticPatchFile: string, excludedFolders: string[]|undefined, excludedFiles: string[]|undefined, moduleAndVersion: string, clientName: string, pullRequestExperiment: boolean, onlyPatch: boolean, interactiveMode: boolean, questionFileDirectory: string, explicitTestCommand?: string) {
    let initialTestResults : any = {exit: 0, signal: undefined};
    if (!onlyPatch) {
        await PackageOperations.npmInstallAndBuild(patcherRunningDir, USE_DOCKER);
        logger.info(`Starting preliminary tests for: ${clientName}`);
        initialTestResults = await PackageOperations.runTest(patcherRunningDir, USE_DOCKER, explicitTestCommand);
        logger.info(`Preliminary tests for: ${clientName} ended with: exit: ${initialTestResults.exit}, signal: ${initialTestResults.signal}`);
        if (pullRequestExperiment) {
            await p(exec)(`git reset --hard`, {cwd: patcherRunningDir});
        } else if (initialTestResults.exit === 0 && !initialTestResults.signal) {
            throw new Error(`Tests did not fail before patching client: ${clientName} after updating to module: ${moduleAndVersion}`);
        }
    }
    const patterns: PatternWrapper[] = readPatterns(semanticPatchFile);
    const filesToAnalyze = await getFilesToAnalyze(patcherRunningDir, excludedFolders, excludedFiles);
    const interactivePhase = new TapirInteractivePhase(moduleAndVersion, clientName, patcherRunningDir, questionFileDirectory, interactiveMode);
    await interactivePhase.loadQuestions();
    let totalNumberPatches = 0;
    const patchClassifications = new Set();
    let tapirAndPatcherTime = 0;
    let tapirTime = 0;
    let missingTransformations = new Set();
    const patchingsForAllFiles: Map<Path, Map<string, Set<PatternWrapper>>> = new Map();
    logger.info(`Starting running Tapir and Patcher for in ${patcherRunningDir}`);
    await applySeries(filesToAnalyze, async file => {
        try {
            const program = await parseFileWithRecast(file);
            const startTime: number = +new Date();
            let relativeFileName = relative(patcherRunningDir, file);
            const tapir = Tapir.runTapirOnFile(relativeFileName, program, patterns);
            const tapirResults: Map<PatternWrapper, TapirMatchResult[]> = tapir.getMatchPatternResults() as Map<PatternWrapper, TapirMatchResult[]>; // The cast is needed since PatternWrapper type in JSFix has some fields that PatternWrapper in Tapir does not, but the result PatternWrapper is the one from JSFix.
            const filteredTapirResults: Map<PatternWrapper, TapirMatchResult[]> = await interactivePhase.filterResults(tapirResults);
            const transformedTapirResults = new Map([...filteredTapirResults].map(([pattern, tmrs]) => [pattern, tmrs.map(tmr => tmr.node)]));
            const patchings: Map<string, Set<PatternWrapper>> = new Map();
            transformedTapirResults.forEach((nodes, pattern) => {
                if ((!pattern.transform || pattern.transform.status) && nodes.length > 0) {
                    missingTransformations.add(pattern.id);
                    throw new Error(`Missing transformation pattern for ${pattern.id}. Targets node at: ${file}:${nodes[0].loc?.start.line}:${nodes[0].loc?.start.column}`);
                }
                nodes.forEach(n => {
                    patchClassifications.add(pattern.id);
                    if (n.loc) // n always has a location
                        addToMapSet(patchings, `${n.loc.start.line}:${n.loc.start.column}:${n.loc.end.line}:${n.loc.end.column}`, pattern);
                });
            });
            patchingsForAllFiles.set(file, patchings);
            tapirTime += +new Date() - startTime;
            if (patchings.size === 0) {
                const totalTime = +new Date() - startTime;
                tapirAndPatcherTime += totalTime;
                return; // Nothing to patch
            }
            totalNumberPatches += [...patchings.values()].reduce((acc, elem) => acc + elem.size, 0);
            const patcher = new Patcher(program, patchings, tapir, patcherRunningDir, interactivePhase);
            await patcher.patchPatterns();
            await patcher.persistModule();
            const totalTime = +new Date() - startTime;
            tapirAndPatcherTime+= totalTime;
        } catch (e) {
            logger.debug(e);
            if (e.message.startsWith("Missing transformation pattern")) {
                if (pullRequestExperiment)
                    throw e;
            } else if (e.message !== "Failed parsing")
                throw e;
        }
    });
    await interactivePhase.persistQuestions();
    const [dep, version] = moduleAndVersion.split('@');
    await PackageOperations.addPackageToPackageJson(patcherRunningDir, dep, version);
    if (interactivePhase.answersMissing()) {
        logger.info(`Patching for ${clientName} finished with unanswered questions`);
        return PatcherResultForClient.makeNoResult(clientName);
    }
    if (missingTransformations.size > 0)
        return PatcherResultForClient.makeMissingTransformationResult(clientName);
    if (onlyPatch) {
        logger.info("CSV summary for client:");
        logger.info(`${clientName}, , ${totalNumberPatches}, ${[...patchClassifications].join(" ")}, ${interactivePhase.getNumberBenignCategoryQuestions()}, ${interactivePhase.getNumberPrecisionQuestions()}, ${interactivePhase.getNumberBenignIndividualQuestions()}, Time: ${tapirAndPatcherTime}, tapirTime: ${tapirTime}, NumberFilesAnalyze: ${filesToAnalyze.length}`);
        return new PatcherResultForClient(clientName, undefined, totalNumberPatches, interactivePhase.getNumberBenignCategoryQuestions(), interactivePhase.getNumberPrecisionQuestions(), interactivePhase.getNumberBenignIndividualQuestions(), tapirAndPatcherTime, tapirTime, interactivePhase.getNumberObjQuestions(), interactivePhase.getNumberCallQuestions(), interactivePhase.getNumberExtraQuestions(), interactivePhase.getNumberMinorQuestions(),false, patchingsForAllFiles);
    } else {
        logger.info(`Started install and build: ${patcherRunningDir}`);
        await PackageOperations.npmInstallAndBuild(patcherRunningDir, USE_DOCKER);
        logger.info(`Started running tests in: ${patcherRunningDir}`);
        const {exit, signal} = await PackageOperations.runTest(patcherRunningDir, USE_DOCKER, explicitTestCommand);
        logger.info(`Finished running tests in: ${patcherRunningDir} with result: exit: ${exit}, signal: ${signal}`);
        if (pullRequestExperiment) {
            if (!initialTestResults)
                throw new Error("Initial test results should be set when doing the pull request experiment");
            const sameTestResult = exit === initialTestResults.exit && signal === initialTestResults.signal;
            logger.info(`Test results are ${sameTestResult ? "the same as" : "different from"} the test run before patching and updating`);
        }
        const succeeded = !(exit > 0 || signal);
        logger.info("CSV summary for client:");
        logger.info(`${clientName}, , ${totalNumberPatches}, ${[...patchClassifications].join(" ")}, ${interactivePhase.getNumberBenignCategoryQuestions()}, ${interactivePhase.getNumberPrecisionQuestions()}, ${interactivePhase.getNumberBenignIndividualQuestions()}, Time: ${tapirAndPatcherTime}, tapirTime: ${tapirTime}, NumberFilesAnalyze: ${filesToAnalyze.length}`);
        return new PatcherResultForClient(clientName, succeeded, totalNumberPatches, interactivePhase.getNumberBenignCategoryQuestions(), interactivePhase.getNumberPrecisionQuestions(), interactivePhase.getNumberBenignIndividualQuestions(), tapirAndPatcherTime, tapirTime, interactivePhase.getNumberObjQuestions(), interactivePhase.getNumberCallQuestions(), interactivePhase.getNumberExtraQuestions(), interactivePhase.getNumberMinorQuestions(), false, patchingsForAllFiles);
    }
}

class PatcherResultForClient {
    readonly clientName: string;
    readonly succeeded: boolean|undefined;
    readonly numberPathes: number;
    readonly numberBenignCatQuestions: number;
    readonly numberPrecisionQuestions: number;
    readonly numberBenignIndividualQuestions: number;
    readonly tapirAndPatchingTime: number;
    readonly missingTransformation: boolean;
    readonly tapirTime: number;
    readonly numberObjQuestions: number;
    readonly numberCallQuestions: number;
    readonly numberExtraQuestions: number;
    readonly numberMinorQuestions: number;
    readonly patchingsForAllFiles: Map<Path, Map<string, Set<PatternWrapper>>>;
    constructor(clientName: string, succeeded: boolean|undefined, numberPatches: number, numberBenignCatQuestions: number, numberPrecisionQuestions: number, numberBenignIndividualQuestions: number, tapirAndPatchingTime: number, tapirTime: number, numberObjQuestions: number, numberCallQuestions: number, numberExtraQuestions: number, numberMinorQuestions: number, missingTransformation: boolean, patchingsForAllFiles: Map<Path, Map<string, Set<PatternWrapper>>>) {
        this.clientName = clientName;
        this.succeeded = succeeded;
        this.numberPathes = numberPatches;
        this.numberBenignCatQuestions = numberBenignCatQuestions;
        this.numberPrecisionQuestions = numberPrecisionQuestions;
        this.numberBenignIndividualQuestions = numberBenignIndividualQuestions;
        this.tapirAndPatchingTime = tapirAndPatchingTime;
        this.missingTransformation = missingTransformation;
        this.tapirTime = tapirTime;
        this.numberObjQuestions = numberObjQuestions;
        this.numberCallQuestions = numberCallQuestions;
        this.numberExtraQuestions = numberExtraQuestions;
        this.numberMinorQuestions = numberMinorQuestions;
        this.patchingsForAllFiles = patchingsForAllFiles;
    }
    public static makeNoResult(clientName: string) {
        return new PatcherResultForClient(clientName,undefined, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, new Map());
    }

    public static makeMissingTransformationResult(clientName: string) {
        return new PatcherResultForClient(clientName, false, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,true, new Map());
    }

    getNumberPatches() {
        return this.numberPathes;
    }

    isSucceeded() {
        return !!this.succeeded;
    }

    isFailed() {
        return this.succeeded === false && !this.missingTransformation;
    }

    getNumberQuestions() {
        return this.numberBenignCatQuestions + this.numberPrecisionQuestions + this.numberBenignIndividualQuestions;
    }

    getPatchTime() {
        return this.tapirAndPatchingTime;
    }

    getTapirTime() {
        return this.tapirTime;
    }

    isMissingTransformation() {
        return this.missingTransformation;
    }

    needsQuestionAnswered() {
        return this.succeeded === undefined;
    }

    getNumberObjQuestions() {
        return this.numberObjQuestions;
    }

    getNumberCallQuestions() {
        return this.numberCallQuestions;
    }

    getNumberExtraQuestions() {
        return this.numberExtraQuestions;
    }

    getNumberMinorQuestions() {
        return this.numberMinorQuestions;
    }
}

class PatcherResultForLibrary {
    readonly library : string;
    readonly results : PatcherResultForClient[];
    constructor(library: string, results: PatcherResultForClient[]) {
        this.library = library;
        this.results = results;
    }

    public getNumberClients() {
        return this.results.length;
    }

    public getResultsData(pullRequestExperiment: boolean, includeNeedsQuestionsAnswered: boolean, includeTapirTime?: boolean): string[] {
        const avgPatchTime = this.getPatchTime() / (this.getNumberClients() - this.getNumberClientsMissingTransformation());
        const avgTapirTime = this.getTapirTime() / (this.getNumberClients() - this.getNumberClientsMissingTransformation());
        const res = [
            this.library,
            "" + this.getNumberClients(),
            "" + this.getNumberPatches(),
            ...(!pullRequestExperiment ?
                ["" + this.getNumberSucceeded(),
                    "" + this.getNumberFailed(),
                    "" + this.results.filter(r => r.missingTransformation).length
                ] : []),
            "" + (avgPatchTime / 1000).toFixed(2),
            ...(includeTapirTime ? ["" + (avgTapirTime / 1000).toFixed(2)] : []),
            "" + this.getNumberObjQuestions(),
            "" + this.getNumberCallQuestions(),
            "" + this.getNumberExtraQuestions(),
            "" + this.getNumberMinorQuestions()
        ];
        if (includeNeedsQuestionsAnswered)
            res.push("" + this.results.filter(r => r.succeeded === undefined).length);
        return res;
    }

    getNumberPatches() {
        return sum(this.results.map(r => r.getNumberPatches()));
    }

    getNumberSucceeded() {
        return this.results.filter(r => r.isSucceeded()).length;
    }

    getNumberFailed() {
        return this.results.filter(r => r.isFailed()).length;
    }

    getNumberQuestions() {
        return sum(this.results.map(r => r.getNumberQuestions()));
    }

    getPatchTime() {
        return sum(this.results.map(r => r.getPatchTime()));
    }

    getTapirTime() {
        return sum(this.results.map(r => r.getTapirTime()));
    }

    getNumberClientsMissingTransformation() {
        return this.results.filter(r => r.isMissingTransformation()).length;
    }

    getNumberNeedsQuestionsAnswered() {
        return this.results.filter(r => r.needsQuestionAnswered()).length;
    }

    getFailingClients() {
        return this.results.filter(r => r.isFailed()).map(r => r.clientName);
    }

    getClientsNeedingTransformation() {
        return this.results.filter(r => r.isMissingTransformation()).map(r => r.clientName);
    }

    getSucceedingClients() {
        return this.results.filter(r => r.isSucceeded()).map(r => r.clientName);
    }

    getNumberObjQuestions() {
        return sum(this.results.map(r => r.getNumberObjQuestions()));
    }

    getNumberCallQuestions() {
        return sum(this.results.map(r => r.getNumberCallQuestions()));
    }

    getNumberExtraQuestions() {
        return sum(this.results.map(r => r.getNumberExtraQuestions()));
    }

    getNumberMinorQuestions() {
        return sum(this.results.map(r => r.getNumberMinorQuestions()));
    }
}

export class PatcherResultForAllLibraries {
    readonly results : PatcherResultForLibrary[];
    constructor(results: PatcherResultForLibrary[]) {
        this.results = results;
    }

    getResultsTable(pullRequestExperiment: boolean, includeNeedsQuestionsAnswered: boolean, includeTapirTime?: boolean): string[][] {
        const resultsTable = [];
        resultsTable.push(["Library", pullRequestExperiment ? "Pull requests" : "Clients", "Patches", ...(!pullRequestExperiment ? [chalk.bold.green("\u2713"), chalk.bold.red("\u2717"), "-CT"] : []), "Avg. time", ...(includeTapirTime ? ["Tapir Time (s)"] : []), "Qobj", "Qcall", "Qextra", "Qminor"]);
        if (includeNeedsQuestionsAnswered)
            resultsTable[0].push("#needsQuestionAnswered");
        this.results.map(r => r.getResultsData(pullRequestExperiment, includeNeedsQuestionsAnswered, includeTapirTime)).forEach(rd => resultsTable.push(rd));
        resultsTable.push(this.createSummaryLine(pullRequestExperiment, includeNeedsQuestionsAnswered, includeTapirTime));
        return resultsTable;
    }

    private createSummaryLine(pullRequestExperiment: boolean, includeNeedsQuestionsAnswered: boolean, includeTapirTime?: boolean): string[] {
        const totalNumberClients = sum(this.results.map(r => r.getNumberClients()));
        const totalNumberPatches = sum(this.results.map(r => r.getNumberPatches()));
        const totalNumberSucceeded = sum(this.results.map(r => r.getNumberSucceeded()));
        const totalNumberFailed = sum(this.results.map(r => r.getNumberFailed()));
        const totalNeedsTransformation = sum(this.results.map(r => r.getNumberClientsMissingTransformation()));
        const totalNeedsQuestionAnswered = sum(this.results.map(r => r.getNumberNeedsQuestionsAnswered()));
        const totalPatchTime = sum(this.results.map(r => r.getPatchTime()));
        const totalTapirTime = sum(this.results.map(r => r.getTapirTime()));
        const avgPatchTime = totalPatchTime / (totalNumberClients - totalNeedsTransformation);
        const avgTapirTime = totalTapirTime / (totalNumberClients - totalNeedsTransformation);
        const totalNumberObjQuestions = sum(this.results.map(r => r.getNumberObjQuestions()));
        const totalNumberCallQuestions = sum(this.results.map(r => r.getNumberCallQuestions()));
        const totalNumberExtraQuestions = sum(this.results.map(r => r.getNumberExtraQuestions()));
        const totalNumberMinorQuestions = sum(this.results.map(r => r.getNumberMinorQuestions()));
        const res = [
            "",
            "" + totalNumberClients,
            "" + totalNumberPatches,
            ...(!pullRequestExperiment ?
                ["" + totalNumberSucceeded,
                    "" + totalNumberFailed,
                    "" + totalNeedsTransformation,
                ] : []),
            "" + (avgPatchTime / 1000).toFixed(2),
            ...(includeTapirTime ? ["" + (avgTapirTime / 1000).toFixed(2)] : []),
            "" + totalNumberObjQuestions,
            "" + totalNumberCallQuestions,
            "" + totalNumberExtraQuestions,
            "" + totalNumberMinorQuestions
        ];
        if (includeNeedsQuestionsAnswered)
            res.push("" + totalNeedsQuestionAnswered);
        return res;
    }

    getFailingClients() {
        return new Map(this.results.map(r => [r.library, r.getFailingClients()]));
    }

    getClientsNeedingTransformation() {
        return new Map(this.results.map(r => [r.library, r.getClientsNeedingTransformation()]));
    }

    getSucceedingClients() {
        return new Map(this.results.map(r => [r.library, r.getSucceedingClients()]));
    }
}

function sum(arr : number[]) : number {
    return arr.reduce((acc, elem) => acc + elem, 0);
}
