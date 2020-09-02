import commander from 'commander';
import {table} from "table";
import {PatcherResultForAllLibraries, runPullRequestPatchingExperiments} from "../experiments/PatchingExperiment";

commander.arguments('')
    .description('Run JSFix on the clients used for the pull request experiment (reproduces table 3)')
    .action(async function() {
        const results: PatcherResultForAllLibraries = await runPullRequestPatchingExperiments();
        const tableData : string[][] = results.getResultsTable(true, false);
        console.log(table(tableData));
    });

commander.parse(process.argv);
