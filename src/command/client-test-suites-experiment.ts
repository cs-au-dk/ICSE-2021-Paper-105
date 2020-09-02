import commander from 'commander';
import {table} from "table";
import {runPatchingExperiments} from "../experiments/PatchingExperiment";

commander.arguments('')
    .description('Run JSFix on the TAPIR clients with affected test suites (reproduces table 2)')
    .action(async function() {
        const results = await runPatchingExperiments();
        const tableData : string[][] = results.getResultsTable(false, false);
        console.log(table(tableData));
    });

commander.parse(process.argv);
