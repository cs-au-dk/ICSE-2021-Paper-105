import commander from 'commander';
import {runNewPrecisionExperiments, TapirResultForAllLibraries} from "../experiments/DetectionExperiment";
import {table} from "table";

commander.arguments('')
    .description('Runs Tapir on the clients whose test suite are unaffected by the update. Reproduces table 5 in the paper.')
    .action(async function() {
        runNewPrecisionExperiments((results: TapirResultForAllLibraries) => {
            const tableData : string[][] = results.constructRQ2Table(false, false);
            console.log(table(tableData));
        });
    });

commander.parse(process.argv);
