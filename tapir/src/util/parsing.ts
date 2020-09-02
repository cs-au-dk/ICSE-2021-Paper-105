import {Path} from "../types";
import {Program} from "estree";
import {promisify as p} from "util";
import * as fs from "fs";
import {parse as acornParse} from "acorn";
import {createLogger} from "../logging";
import {Options, parse as recastParse} from 'recast';
const logger = createLogger('parsing', 'info');

const SPECIAL_SHEBANG = `SPECIAL_SHEBANG!@!@`;
export async function parseFileWithRecast(sourceFile: Path): Promise<Program> {
    let module: Program;
    try {
        let programSource = await p(fs.readFile)(sourceFile, 'utf-8');

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
