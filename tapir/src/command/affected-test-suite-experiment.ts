import commander from 'commander';
import {runNewDetectionExperiments, TapirResultForAllLibraries} from "../experiments/DetectionExperiment";
import {table} from "table";

commander.arguments('')
    .description('Runs Tapir on the clients whose test suite fails after the update. Reproduces table 4 in the paper.')
    .action(async function() {
        runNewDetectionExperiments((results: TapirResultForAllLibraries) => {
            const tableData : string[][] = results.constructRQ1Table(false);
            console.log(table(tableData));
        });
    });

commander.parse(process.argv);
