import commander from 'commander';
import {Tapir, TapirMatchResult} from "../pattern-finder/tapir";
import {Path} from "../types";
import {PatternWrapper} from "../pattern-finder/pattern-language";
import {SourceLocation} from "acorn";

commander.arguments('<client-directory> <pattern-file>')
    .description('Runs Tapir on the clients whose test suite are unaffected by the update. Reproduces table 5 in the paper.')
    .option('--exclude-folders <excludeFolders>', 'Folders to exclude')
    .action(async function(clientDirectory: string, patternFile: string, cmdObj: any) {
        const res: Map<Path, Map<PatternWrapper, TapirMatchResult[]>> = await Tapir.runTapirOnDirectory(clientDirectory, patternFile, cmdObj.excludeFolders?.split(","));
        res.forEach((resultsForFile, fileName) => {
            resultsForFile.forEach((resultsForPattern, pattern) => {
                resultsForPattern.forEach(singleResult =>
                    console.log(`Detection pattern ${pattern.changelogId} matched at ${fileName}:${(singleResult.node.loc as SourceLocation).start.line}:${(singleResult.node.loc as SourceLocation).start.column} with ${singleResult.uncertainAccPath || singleResult.uncertainCallFilters ? "low" : "high"} confidence`))
            });
        });
    });

commander.parse(process.argv);
