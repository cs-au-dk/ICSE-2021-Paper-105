#!/usr/bin/env node

const fsp = require('fs').promises;
const tableMaker = require('table').table;
const path = require('path');

(async function () {
    const librariesToUse = ["lodash@4.0.0", "async@3.0.0", "express@4.0.0", "chalk@2.0.0", "bluebird@3.0.0", "uuid@3.0.0"/*, "commander@3.0.0"*/, "rxjs@6.0.0", "core-js@3.0.0"/*, "yargs@14.0.0"*/, "node-fetch@2.0.0", "winston@3.0.0", "redux@4.0.0"/*, "jsonwebtoken@8.0.0"*/, "mongoose@5.0.0"];
    const table = [];
    table.push(['Library', 'Patterns', 'Templates', 'Unexpressible', "No general patch", "Unknown"]);


    const rows = await Promise.all(librariesToUse.map(async library => {
        const bcdFile = path.resolve(__dirname, library + ".json");
        const bcds = JSON.parse(await fsp.readFile(bcdFile, 'utf-8')).filter(bcd => !bcd.deprecation);
        const typeFilter = (bcds, type) => bcds.filter(bcd => bcd.pattern.startsWith(type));
        const imports =  typeFilter(bcds, 'import').length;
        const readProperties =  typeFilter(bcds, 'read').length;
        const writeProperties =  typeFilter(bcds, 'write').length;
        const applications =  typeFilter(bcds, 'call').length;
        const patterns = imports + readProperties + writeProperties + applications;

        const qInPattern = bcds.filter(bcd => bcd.pattern.includes('?')).length;

        const templates = bcds.filter(bcd => bcd.transform && (bcd.transform.pattern || bcd.transform.pattern === "")).length;
        const unexpressible = bcds.filter(bcd => bcd.transform && bcd.transform.status && bcd.transform.status === "UNEXPRESSIBLE_PATCH").length;
        const noGeneralPatch = bcds.filter(bcd => bcd.transform && bcd.transform.status && bcd.transform.status === "NO_GENERAL_PATCH").length;
        const noGeneralPatchAndBehavioral = bcds.filter(bcd => bcd.transform && bcd.transform.status && bcd.transform.status === "NO_GENERAL_PATCH" && bcd.behavioral).length;
        const unknownPatch = bcds.filter(bcd => bcd.transform && bcd.transform.status && bcd.transform.status === "UNKNOWN_PATCH").length;

        return [path.basename(bcdFile, ".json"), patterns, templates, unexpressible, noGeneralPatch, unknownPatch];
    }));
    const sumColumn = (columnNum) => table.slice(1).reduce((prev, cur) => prev + cur[columnNum], 0);
    rows.forEach(row => table.push(row));
    table.push(['Total', ...[1,2,3,4,5/*,6,7,8,9,10,11*/].map(i => sumColumn(i))]);
    console.log(tableMaker(table));

    const nonChangelogBcds = (await Promise.all(librariesToUse.map(async library => {
        const bcdFile = path.resolve(__dirname, library + ".json");
        const bcds = JSON.parse(await fsp.readFile(bcdFile, 'utf-8'));
        return bcds.filter(bcd => bcd.id.match(/\d+/)[0].length > 2).length;
    }))).reduce((prev, cur) => prev + cur, 0);
    console.log("Non changelog bcds: " + nonChangelogBcds);
})();
