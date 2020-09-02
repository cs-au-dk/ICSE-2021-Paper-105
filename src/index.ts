#!/usr/bin/env node
import commander from 'commander';

commander.version('0.0.1')
    .command(
        'patch', 'Run JSFix',
        {executableFile: 'command/patch-client-with-external-patch-file', isDefault: true})
    .parse(process.argv);
