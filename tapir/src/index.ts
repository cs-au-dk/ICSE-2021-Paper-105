#!/usr/bin/env node
import commander from 'commander';

commander.version('0.0.1')
    .command(
        'affected-test-suite-experiment', 'Runs Tapir on the clients whose test suite fails after the update. Reproduces table 4 in the paper.',
        {executableFile: 'command/affected-test-suite-experiment'})
    .command(
        'unaffected-test-suite-experiment', 'Runs Tapir on the clients whose test suite are unaffected by the update. Reproduces table 5 in the paper.',
        {executableFile: 'command/unaffected-test-suite-experiment'})
    .command(
        'detection-pattern-statistics', 'Generate a table of statistics about the detection patterns in the res/detection-patterns folder. Reproduces table 2 and 3 in the paper.',
        {executableFile: 'command/detection-pattern-statistics'})
    .command(
        'single-client', 'Runs Tapir on a single client',
        {executableFile: 'command/single-client-experiment', isDefault: true})
    .parse(process.argv);
