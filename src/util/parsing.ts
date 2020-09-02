import {Path} from "../types";
import {Program} from "estree";
import {promisify as p} from "util";
import * as fs from "fs";
import {parse as acornParse} from "acorn";
import {createLogger} from "../logging";
import {Options, parse as recastParse, print} from 'recast';
import {writeFile} from "fs";
import {isExpressionStatement} from "./ast-utils";
const logger = createLogger('parsing', 'info');

const SPECIAL_SHEBANG = `SPECIAL_SHEBANG!@!@`;
export async function parseFileWithRecast(sourceFile: Path, programSource?: string): Promise<Program> {
    let module: Program;
    try {
        programSource = programSource || await readSource(sourceFile);

        if (programSource.startsWith('#')) {
           programSource = '//' + programSource.replace('\n', `${SPECIAL_SHEBANG}\n`);
        }

        //@ts-ignore I don't know why there's a warning produced here
        module = recastParse(programSource, {
            parser: {
                parse(source: string, recastSetOptions: Partial<Options>) {
                    return acornParse(source, getParserOptions(recastSetOptions));
                }
            }
        });
    } catch (e) {
        logger.debug(`Failed to parse JavaScript file ${sourceFile}. Returning empty set of patterns`);
        throw new Error('Failed parsing');
    }
    return module;
}

export async function readSource(sourceFile: Path) {
    return p(fs.readFile)(sourceFile, 'utf-8');
}

function getParserOptions(recastSetOptions: any): any {
    return {
        sourceType: 'module',
        locations: true,
        allowHashBang: true,
        ranges: true,
        preserveParens: true,
        onComment: recastSetOptions.onComment,
        allowReturnOutsideFunction: true
    }
}

export function printAst(module: any, astPrintingOptions?: Options) {
    return print(module, astPrintingOptions || {quote: "single"});
}

export async function writeModule(module: Program, file: string, astPrintingOptions: Options): Promise<void> {
    let source = printAst(module, astPrintingOptions).code;
    if (source.includes(SPECIAL_SHEBANG)) {
        source = source.replace(SPECIAL_SHEBANG, '').slice(2)
    }
    return p(writeFile)(file, source)
}

export function parseSource(source: string): any {
    let module: Program;
    try {
        //@ts-ignore I don't know why there's a warning produced here
        module = recastParse(source, {
            parser: {
                parse(source: string, recastParserOptions: Partial<Options>) {
                    return acornParse(source, getParserOptions(recastParserOptions));
                }
            }
        });
    } catch (e) {
        logger.debug(`Failed to parse source: ${source}. Returning empty set of patterns`);
        throw new Error(`Failed to parse source: ${source}. Returning empty set of patterns`);
    }
    // @ts-ignore
    let mainExpression = module.program.body[0];
    return isExpressionStatement(mainExpression) ? mainExpression.expression : mainExpression;
}
