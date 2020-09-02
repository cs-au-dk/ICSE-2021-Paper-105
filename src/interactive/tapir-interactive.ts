import {PatternWrapper} from "../pattern-finder/pattern-language";
import {Node} from "estree";
import {dirname, resolve} from "path";
import * as fs from "fs";
import {existsSync} from "fs";
import {promisify as p} from "util";
import {printAst} from "../util/parsing";
import {createDirectoryIfMissing} from "../util/file";
import prompts from 'prompts';
import {applySeries, filterSeries, mapSeries} from "../util/promise";
import openEditor = require("open-editor");
import {MatchResult, UncertainAccPathMatch, MaybeArgTypeMatch, MaybeApplyOrSpreadArgFilterMatch, DisjunctionMatchResult, TapirMatchResult} from "tapir";
import {SourceLocation} from "acorn";

export class MaybeExplicitQuestionMatch implements MatchResult {
    readonly question: string;
    readonly negated: boolean;

    constructor(question: string, negated?: boolean) {
        this.question = question;
        this.negated = !!negated;
    }

    public negate() {
        return new MaybeExplicitQuestionMatch(this.question, !this.negated);
    }
}
export class TransformQuestion implements MatchResult {
    readonly question: string;
    readonly negated: boolean;

    constructor(question: string, negated?: boolean) {
        this.question = question;
        this.negated = !!negated;
    }

    public negate() {
        return new TransformQuestion(this.question, !this.negated);
    }
}

export class TapirInteractivePhase {
    readonly benignCategoriesInteractive: InteractiveBenignChangeCategoryClassification;
    readonly precisionInteractive: InteractiveMatchResultStrategy;
    readonly benignIndividualInteractive: IndividualBenignBreakingChangeQuestions;
    readonly interactiveMode: boolean;

    constructor(libraryName: string, clientName: string, dir: string, questionFileDirectory: string, interactiveMode: boolean) {
        this.benignCategoriesInteractive = new InteractiveBenignChangeCategoryClassification(libraryName, clientName, dir, questionFileDirectory);
        this.precisionInteractive = new InteractiveMatchResultStrategy(libraryName, clientName, dir, questionFileDirectory, interactiveMode);
        this.benignIndividualInteractive = new IndividualBenignBreakingChangeQuestions(libraryName, clientName, dir, questionFileDirectory);
        this.interactiveMode = true;
    }

    public async loadQuestions() {
        await this.benignCategoriesInteractive.loadQuestions();
        await this.precisionInteractive.loadQuestions();
        await this.benignIndividualInteractive.loadQuestions();
    }

    hasAnswersForAllCategories() {
        return !hasUnansweredQuestions(this.benignCategoriesInteractive.getQuestionsObject());
    }

    async filterBasedOnBenignCategoryQuestions(tapirResults: Map<PatternWrapper, TapirMatchResult[]>) {
        this.benignCategoriesInteractive.registerTapirResult(tapirResults);
        if (this.interactiveMode)
            await this.benignCategoriesInteractive.promptForAnswers();
        const patternsToBeIgnored: string[] = this.benignCategoriesInteractive.getIgnoredCategories();
        return new Map([...tapirResults].filter(([pattern, _tmrs]) => !patternsToBeIgnored.includes(pattern.id)).map(([pattern, tmrs]) => [pattern, tmrs]));
    }

    async filterBasedOnPrecisionQuestions(tapirResults: Map<PatternWrapper, TapirMatchResult[]>): Promise<Map<PatternWrapper, TapirMatchResult[]>> {
        return new Map(await mapSeries([...tapirResults], async ([pattern, tmrs]) =>
            [pattern, (await filterSeries(tmrs, async tmr => await this.precisionInteractive.areUncertaintiesTrue(tmr, pattern)))]));
    }

    async filterBasedOnBenignIndividualQuestions(tapirResults: Map<PatternWrapper, TapirMatchResult[]>) {
        return new Map(await mapSeries([...tapirResults], async ([pattern, tmrs]) =>
            [pattern, (await filterSeries(tmrs, async tmr => {
                if (!pattern.benign && !pattern.applicationLevelQuestion)
                    return true;
                const answerForCategory = this.benignCategoriesInteractive.getAnswerForCategory(pattern);
                if (answerForCategory === "Yes")
                    return true;
                else if (answerForCategory === "No")
                    return false;
                return await this.benignIndividualInteractive.shouldMatchBePatched(tmr, pattern);
            }))]));
    }

    async persistQuestions() {
        await this.benignCategoriesInteractive.persistQuestions();
        await this.precisionInteractive.persistQuestions();
        await this.benignIndividualInteractive.persistQuestions();
    }

    answersMissing() {
        return hasUnansweredQuestions(this.benignCategoriesInteractive.getQuestionsObject()) ||
            hasUnansweredQuestions(this.precisionInteractive.getQuestionsObject()) ||
            hasUnansweredQuestions(this.benignIndividualInteractive.getQuestionsObject());
    }

    getNumberBenignCategoryQuestions() {
        return this.benignCategoriesInteractive.getNumberQuestions();
    }

    getNumberPrecisionQuestions() {
        return this.precisionInteractive.getNumberQuestions();
    }

    getNumberBenignIndividualQuestions() {
        return this.benignIndividualInteractive.getNumberQuestions();
    }

    getAnswerToTransformQuestion(transformQuestion: TransformQuestion, node: Node, fileName: string, patternWrapper: PatternWrapper) {
        return this.precisionInteractive.getAnswer(transformQuestion, node, fileName, patternWrapper);
    }

    async filterResults(tapirResults: Map<PatternWrapper, TapirMatchResult[]>) {
        let filteredTapirResults: Map<PatternWrapper, TapirMatchResult[]> = await this.filterBasedOnBenignCategoryQuestions(tapirResults);
        filteredTapirResults = await this.filterBasedOnPrecisionQuestions(filteredTapirResults);
        return await this.filterBasedOnBenignIndividualQuestions(filteredTapirResults);
    }

    getNumberObjQuestions() {
        return this.precisionInteractive.getNumberObjQuestions();
    }

    getNumberCallQuestions() {
        return this.precisionInteractive.getNumberCallQuestions();
    }

    getNumberExtraQuestions() {
        return this.precisionInteractive.getNumberExtraQuestions();
    }

    getNumberMinorQuestions() {
        return this.getNumberBenignCategoryQuestions() + this.getNumberBenignIndividualQuestions();
    }
}

interface Question {
    questionText: string;
    answer: ""|"Yes"|"No";
    patternId: string;
    fileName: string;
    lineNumber: number;
    columnNumber: number;
}
type QuestionObjectType = {[key: string]: Question};

export class InteractiveMatchResultStrategy {
    readonly questionsFilePath: string;
    private questionsObject: QuestionObjectType | undefined;
    readonly dir: string;
    readonly promptAnswersImmediately: boolean;

    constructor(libraryName: string, clientName: string, dir: string, questionFileDirectory: string, interactiveMode: boolean) {
        this.dir = dir;
        this.questionsFilePath = resolve(questionFileDirectory, libraryName, `${clientName}-precision.json`);
        this.promptAnswersImmediately = interactiveMode;
    }

    public getQuestionsObject() {
        return this.questionsObject;
    }

    public getAnswer(res: MatchResult, node: Node, fileName: string, patternWrapper: PatternWrapper) {
        if (!this.questionsObject)
            throw new Error("InteractiveMatchResultStrategy#loadQuestions should have been called.");
        const questionId = InteractiveMatchResultStrategy.computeQuestionId(res, node, fileName, patternWrapper);
        return this.questionsObject[questionId].answer;
    }

    public async loadQuestions() {
        this.questionsObject = await loadQuestions(this.questionsFilePath);
    }

    public async persistQuestions() {
        await persistQuestions(this.questionsFilePath, this.questionsObject);
    }

    public static computeQuestionId(res: MatchResult, node: Node, fileName: string, patternWrapper: PatternWrapper): string {
        if (!node.loc)
            throw new Error("Node should have a location");
        return `[${patternWrapper.id}]${fileName}_${node.type}_${node.loc.start.line}:${node.loc.start.column}:${node.loc.end.line}:${node.loc.end.column}${res.constructor.name}`
    }

    public static computeQuestionText(res: MatchResult, node: Node, fileName: string, patternWrapper: PatternWrapper): string {
        if (!node.loc)
            throw new Error("Node should have a location");
        const textFromRes = InteractiveMatchResultStrategy.getTextFromMatchResult(res, patternWrapper);
        return `[${patternWrapper.id}] ${fileName}, ${node.type} at ${node.loc.start.line}:${node.loc.start.column}:${node.loc.end.line}:${node.loc.end.column}: ${textFromRes}`
    }

    private static getTextFromMatchResult(res: MatchResult, patternWrapper: PatternWrapper): string {
        if (res instanceof UncertainAccPathMatch) {
            return `${patternWrapper.uncertainAccPathQuestion}`;
        } else if (res instanceof MaybeArgTypeMatch) {
            return `is arg ${printAst(res.argument).code} of type ${res.typesToMatch}`;
        } else if (res instanceof MaybeApplyOrSpreadArgFilterMatch) {
            return `does the call match the filters: ${res.filters}`;
        } else if (res instanceof MaybeExplicitQuestionMatch) {
            return `${res.question}`;
        } else if (res instanceof TransformQuestion) {
            return `${res.question}`;
        } else if (res instanceof DisjunctionMatchResult) {
            return [...res.matchResults].map(elem => this.getTextFromMatchResult(elem, patternWrapper)).join(' OR ');
        }
        throw new Error("Unsupported MatchResult kind");
    }

    public async promptForAnswers() {
        if (!this.questionsObject)
            throw new Error("InteractiveMatchResultStrategy#loadQuestions should have been called.");
        const questionsObject = this.questionsObject;
        const questionsToAsk = Object.values(questionsObject).filter(q => !q.answer);
        await applySeries(questionsToAsk, async question => {
            question.answer = await this.askQuestion(question);
        });
        this.persistQuestions();
    }

    private async askQuestion(question: Question): Promise<"Yes" | "No"> {
        openEditor([`${resolve(this.dir, question.fileName)}:${question.lineNumber}:${question.columnNumber + 1}`])
        const response = await prompts({
            type: 'select',
            name: 'value',
            message: question.questionText,
            choices: [
                {title: 'Yes', value: 'Yes'},
                {title: 'No', value: 'No'}
            ]
        });
        return response.value as "Yes" | "No";
    }

    public getNumberQuestions() {
        if (!this.questionsObject)
            throw new Error("InteractiveMatchResultStrategy#loadQuestions should have been called.");
        return Object.keys(this.questionsObject).length;
    }

    async areUncertaintiesTrue(tmr: TapirMatchResult, patternWrapper: PatternWrapper): Promise<boolean> {
        if (!this.questionsObject)
            throw new Error("InteractiveMatchResultStrategy#loadQuestions should have been called.");

        const matchResults = [];
        if (tmr.uncertainAccPath)
            matchResults.push(new UncertainAccPathMatch());
        if (tmr.uncertainCallFilters)
            matchResults.push(...tmr.uncertainCallFilters);
        if (patternWrapper.question)
            matchResults.push(new MaybeExplicitQuestionMatch(patternWrapper.question));
        if (patternWrapper.transformQuestion)
            matchResults.push(new TransformQuestion(patternWrapper.transformQuestion));

        for (let i = 0; i < matchResults.length; i++) {
            const matchResult = matchResults[i];
            const questionId = InteractiveMatchResultStrategy.computeQuestionId(matchResult, tmr.node, tmr.fileName, patternWrapper);
            if (this.questionsObject[questionId]?.answer) {
                if (this.questionsObject[questionId].answer === "No" && !(matchResult instanceof TransformQuestion))
                    return false;
                continue;
            }
            const questionText = InteractiveMatchResultStrategy.computeQuestionText(matchResult, tmr.node, tmr.fileName, patternWrapper);
            const question: Question = {
                questionText: questionText,
                answer: "",
                patternId: patternWrapper.id,
                fileName: tmr.fileName,
                lineNumber: (tmr.node.loc as SourceLocation).start.line,
                columnNumber: (tmr.node.loc as SourceLocation).start.column
            };
            this.questionsObject[questionId] = question;
            question.answer = await this.askQuestion(question);
            await this.persistQuestions();
            if (question.answer === "No" && !(matchResult instanceof TransformQuestion))
                return false;
        }
        return true;
    }

    getNumberObjQuestions() {
        if (!this.questionsObject)
            throw new Error("InteractiveMatchResultStrategy#loadQuestions should have been called.");
        return Object.keys(this.questionsObject).filter((qid: string) =>
            qid.endsWith("UncertainAccPathMatch") || qid.endsWith("ConjunctionMatchResult")
            || (qid.endsWith("DisjunctionMatchResult") && !(this.questionsObject as QuestionObjectType)[qid].questionText.includes(": is arg"))
        ).length;
    }

    getNumberCallQuestions() {
        if (!this.questionsObject)
            throw new Error("InteractiveMatchResultStrategy#loadQuestions should have been called.");
        return Object.keys(this.questionsObject).filter((qid: string) =>
            qid.endsWith("MaybeArgTypeMatch") || qid.endsWith("MaybeApplyOrSpreadArgFilterMatch")
            || (qid.endsWith("DisjunctionMatchResult") && (this.questionsObject as QuestionObjectType)[qid].questionText.includes(": is arg"))
        ).length;
    }

    getNumberExtraQuestions() {
        if (!this.questionsObject)
            throw new Error("InteractiveMatchResultStrategy#loadQuestions should have been called.");
        return Object.keys(this.questionsObject).filter((qid: string) =>
            qid.endsWith("MaybeExplicitQuestionMatch") || qid.endsWith("TransformQuestion")
        ).length;
    }
}
interface BenignChangeCategoryQuestion {
    questionText: string;
    answer: ""|"Yes"|"No"|"Maybe";
    patternId: string;
}
type BenignChangeCategoryQuestionObject = {[key: string]: BenignChangeCategoryQuestion};
export class InteractiveBenignChangeCategoryClassification {
    private questionsObject: BenignChangeCategoryQuestionObject|undefined;
    readonly questionsFilePath: string;
    readonly dir: string;
    constructor(libraryName: string, clientName: string, dir: string, questionFileDirectory: string) {
        this.dir = dir;
        this.questionsFilePath = resolve(questionFileDirectory, libraryName, `${clientName}-benign-categories.json`);
    }

    public async loadQuestions() {
        this.questionsObject = await loadQuestions(this.questionsFilePath);
    }

    private computeQuestionText(p: PatternWrapper) {
        return `Should we patch the breaking change: ${p.changelogDescription}`;
    }

    public getIgnoredCategories() {
        if (!this.questionsObject)
            throw new Error("InteractiveBenignChangeCategoryClassification#loadQuestions should have been called.");
        const questionsObject = this.questionsObject;
        return Object.keys(questionsObject).filter(patternId => questionsObject[patternId].answer === "No");
    }

    public getSometimesCategories() {
        if (!this.questionsObject)
            throw new Error("InteractiveBenignChangeCategoryClassification#loadQuestions should have been called.");
        const questionsObject = this.questionsObject;
        return Object.keys(questionsObject).filter(patternId => questionsObject[patternId].answer === "Maybe");
    }

    public registerTapirResult(tapirResultOverapproximated: Map<PatternWrapper, TapirMatchResult[]>) {
        const benignPatterns = [...tapirResultOverapproximated].filter(([_pattern, nodes]) => nodes && nodes.length > 0)
            .map(([pattern, _nodes]) => pattern)
            .filter(pattern => pattern.benign || pattern.applicationLevelQuestion);
        if (!this.questionsObject)
            throw new Error("InteractiveBenignChangeCategoryClassification#loadQuestions should have been called.");
        const questionsObject = this.questionsObject;
        benignPatterns.forEach(p => {
            if (!questionsObject[p.id]?.answer)
                questionsObject[p.id] = {questionText: this.computeQuestionText(p), answer: "", patternId: p.id}
        });
    }

    async persistQuestions() {
        await persistQuestions(this.questionsFilePath, this.questionsObject);
    }

    public async promptForAnswers() {
        if (!this.questionsObject)
            throw new Error("InteractiveBenignChangeCategoryClassification#loadQuestions should have been called.");
        const questionsObject = this.questionsObject;
        const questionsToAsk = Object.values(questionsObject).filter(question => !question.answer);
        return await applySeries(questionsToAsk, async question => {
            const response = await prompts({
                type: 'select',
                name: 'value',
                message: question.questionText,
                choices: [
                    { title: 'Yes'/*, description: 'Patch all occurrences'*/, value: 'Yes' },
                    { title: 'Maybe'/*, description: 'Ask for each occurrence'*/, value: 'Maybe' },
                    { title: 'No'/*, description: 'Patch no occurrences'*/, value: 'No' }
                ],
                initial: 1
            });
            question.answer = response.value;
        });
        this.persistQuestions();
    }

    public getNumberQuestions() {
        if (!this.questionsObject)
            throw new Error("InteractiveBenignChangeCategoryClassification#loadQuestions should have been called.");
        return Object.keys(this.questionsObject).length;
    }

    getAnswerForCategory(pattern: PatternWrapper) {
        if (!this.questionsObject)
            throw new Error("InteractiveBenignChangeCategoryClassification#loadQuestions should have been called.");
        return this.questionsObject[pattern.id].answer;
    }

    getQuestionsObject() {
        return this.questionsObject;
    }
}

interface BenignChangeIndividualQuestion {
    questionText: string;
    answer: ""|"Yes"|"No";
    patternId: string;
    fileName: string;
    lineNumber: number;
    columnNumber: number;
}
type BenignChangeIndividualQuestionObject = {[key: string]: BenignChangeIndividualQuestion};
export class IndividualBenignBreakingChangeQuestions {
    private questionsObject: BenignChangeIndividualQuestionObject|undefined;
    readonly questionsFilePath: string;
    readonly dir: string;
    constructor(libraryName: string, clientName: string, dir: string, questionFileDirectory: string) {
        this.dir = dir;
        this.questionsFilePath = resolve(questionFileDirectory, libraryName, `${clientName}-benign-individual.json`);
    }

    public async loadQuestions() {
        this.questionsObject = await loadQuestions(this.questionsFilePath);
    }

    private computeQuestionId(p: PatternWrapper, fileName: string, node: Node) {
        if (!node.loc)
            throw new Error("Node should have a location");
        return `${p.id}-${fileName}_${node.type}_${node.loc.start.line}:${node.loc.start.column}:${node.loc.end.line}:${node.loc.end.column}`
    }

    public static computeQuestionText(p: PatternWrapper, fileName: string, node: Node) {
        if (!node.loc)
            throw new Error("Node should have a location");
        return `${fileName}_${node.type}_${node.loc.start.line}:${node.loc.start.column}:${node.loc.end.line}:${node.loc.end.column}: Should we patch the breaking change: ${p.changelogDescription}`;
    }

    async persistQuestions() {
        await persistQuestions(this.questionsFilePath, this.questionsObject);
    }

    private async askQuestionAndStoreAnswer(question: BenignChangeIndividualQuestion) {
        return async () => {
            openEditor([`${resolve(this.dir, question.fileName)}:${question.lineNumber}:${question.columnNumber + 1}`])
            const response = await prompts({
                type: 'select',
                name: 'value',
                message: question.questionText,
                choices: [
                    {title: 'Yes', value: 'Yes'},
                    {title: 'No', value: 'No'}
                ]
            });
            question.answer = response.value;
        };
    }

    public getNumberQuestions() {
        if (!this.questionsObject)
            throw new Error("IndividualBenignBreakingChangeQuestions#loadQuestions should have been called.");
        return Object.keys(this.questionsObject).length;
    }

    async shouldMatchBePatched(tmr: TapirMatchResult, pattern: PatternWrapper): Promise<boolean> {
        if (!this.questionsObject)
            throw new Error("IndividualBenignBreakingChangeQuestions#loadQuestions should have been called.");
        const questionId = this.computeQuestionId(pattern, tmr.fileName, tmr.node);
        if (!tmr.node.loc) {return false;} //never true - but makes typescript happy
        if (!this.questionsObject[questionId]?.answer) {
            this.questionsObject[questionId] = {questionText: IndividualBenignBreakingChangeQuestions.computeQuestionText(pattern, tmr.fileName, tmr.node), answer: "", patternId: pattern.id, fileName: tmr.fileName, lineNumber: tmr.node.loc.start.line, columnNumber: tmr.node.loc.start.column}
            this.askQuestionAndStoreAnswer(this.questionsObject[questionId]);
        }
        return this.questionsObject[questionId].answer === "Yes";
    }

    getQuestionsObject() {
        return this.questionsObject;
    }
}

async function loadQuestions(questionsFilePath: string) {
    return existsSync(questionsFilePath) ? JSON.parse(await p(fs.readFile)(questionsFilePath, 'utf-8')) : {};
}
async function persistQuestions(questionsFilePath: string, questionsObject: any) {
    await createDirectoryIfMissing(dirname(questionsFilePath));
    await p(fs.writeFile)(questionsFilePath, JSON.stringify(questionsObject, null, 2));
}
function hasUnansweredQuestions(questionsObject: any) {
    return !Object.keys(questionsObject).every(key => questionsObject[key].answer)
}
