import {resolve} from "path";
import {table as tableMaker} from 'table';
import {
  AccessPathPattern,
  ArgTypeFilter,
  CallAccessPathPattern,
  CallPattern,
  DisjunctionAccessPathPattern,
  ImportPathPattern, ImportPattern,
  ExclusionAccessPathPattern,
  NumArgsFilter,
  parsePattern,
  Pattern,
  PatternWrapper,
  PotentiallyUnknownAccessPathPattern,
  PropertyPathPattern, ReadPropertyPattern,
  WildcardAccessPathPattern, WritePropertyPattern
} from "../pattern-finder/pattern-language";
import commander from "commander";
import {applySeries} from "../util/promise";
import {StaticConfiguration} from "../static-configuration";

commander.arguments('')
  .description('Generate a table of statistics about the detection patterns in the res/detection-patterns folder. Reproduces table 2 and 3 in the paper.')
  .action(async function() {

    function getTableRowFromResults(libName: string, results: PatternStatisticsCollector) {
      return [
        libName,
        "" + results.getNumberPatterns(),
        "" + results.getData().numberImportPatterns,
        "" + results.getData().numberReadPropertyPatterns,
        "" + results.getData().numberWritePropertyPatterns,
        "" + results.getData().numberCallPatterns,
        "" + (results.getData().patternLength / results.getNumberPatterns()).toFixed(2),
        "" + (results.getData().numberImportPathPattern / results.getNumberPatterns()).toFixed(2),
        "" + (results.getData().numberDisjunctionAccessPathPatterns / results.getNumberPatterns()).toFixed(2),
        "" + (results.getData().numberExclusionAccessPathPatterns / results.getNumberPatterns()).toFixed(2),
        "" + (results.getData().numberCallAccessPathPattern / results.getNumberPatterns()).toFixed(2),
        "" + (results.getData().numberWildCardAccessPathPatterns / results.getNumberPatterns()).toFixed(2),
        "" + (results.getData().numberPropertyPathPatterns / results.getNumberPatterns()).toFixed(2),
        "" + (results.getData().numberPotentiallyUnknownAccessPathPatterns / results.getNumberPatterns()).toFixed(2),
        "" + (results.getData().numberArgNumberFilters / results.getData().numberCallPatterns).toFixed(2),
        "" + (results.getData().numberTypeFilters / results.getData().numberCallPatterns).toFixed(2)
      ]
    }

    const libs = ["lodash@4.0.0", "async@3.0.0", "express@4.0.0", "chalk@2.0.0", "bluebird@3.0.0", "uuid@3.0.0", "commander@3.0.0", "rxjs@6.0.0", "core-js@3.0.0", "yargs@14.0.0", "node-fetch@2.0.0", "winston@3.0.0", "redux@4.0.0", "jsonwebtoken@8.0.0", "mongoose@5.0.0"]
    const table: string[][] = [];
    let res: PatternStatisticsCollector[] = [];
    table.push([
      "Library",
      "#Patterns",
      "#Import",
      "#Read",
      "#Write",
      "#Call",
      "Length",
      "<M>",
      ",",
      "\\",
      "()",
      "**",
      ".",
      "?",
      "[m, n]",
      "TypeFilter"
    ]);
    await applySeries(libs, async lib => {
      const patchLocation = `detection-patterns/${lib}.json`;
      const patternWrappers : PatternWrapper[] = require(resolve(StaticConfiguration.resPath, patchLocation));
      const resultsForLibrary: PatternStatisticsCollector[] = [];
      await applySeries(patternWrappers, async (patternWrapper: PatternWrapper) => {
        if (patternWrapper.deprecation)
          return;
        const parsedPattern: Pattern = parsePattern(patternWrapper.pattern);
        const patternStatisticsCollector = new PatternStatisticsCollector();
        collectPatternStatistics(parsedPattern, patternStatisticsCollector);
        resultsForLibrary.push(patternStatisticsCollector);
      });
      const combinedResult: PatternStatisticsCollector = PatternStatisticsCollector.sum(resultsForLibrary);
      table.push(getTableRowFromResults(lib, combinedResult));
      res = res.concat(combinedResult);
    });
    const combinedResult: PatternStatisticsCollector = PatternStatisticsCollector.sum(res);
    table.push(getTableRowFromResults("Total", combinedResult));
    console.log(tableMaker(table));
    //console.log("Total number patterns: " + combinedResult.getNumberPatterns());
    //console.log(Util.constructionLatexTable(table));
  });

function collectPatternStatistics(pattern: Pattern, statisticsCollector: PatternStatisticsCollector) {
  if (pattern instanceof CallPattern) {
    statisticsCollector.registerCallPattern(pattern);
    pattern.filters.forEach(f => {
      if (f instanceof ArgTypeFilter)
        statisticsCollector.registerTypeFilter(f);
      else if (f instanceof NumArgsFilter)
        statisticsCollector.registerArgNumberFilter(f);
      else
        throw new Error("Unsupported filter type: " + f);
    });
    collectAccessPathPatternStatistics(pattern.accessPathPattern, statisticsCollector);
  } else if (pattern instanceof ImportPattern) {
    statisticsCollector.registerImportPattern(pattern);
    collectAccessPathPatternStatistics(pattern.importPathPattern, statisticsCollector);
  } else if (pattern instanceof ReadPropertyPattern) {
    statisticsCollector.registerReadPropertyPattern(pattern);
    collectAccessPathPatternStatistics(pattern.propertyPathPattern, statisticsCollector);
  } else if (pattern instanceof WritePropertyPattern) {
    statisticsCollector.registerWritePropertyPattern(pattern);
    collectAccessPathPatternStatistics(pattern.propertyPathPattern, statisticsCollector);
  } else {
    throw new Error("Unsupported pattern type: " + pattern);
  }
}

function collectAccessPathPatternStatistics(pattern: AccessPathPattern, statisticsCollector: PatternStatisticsCollector) {
  return ((function collectPatternStatisticsHelper(pattern: AccessPathPattern) {
    if (pattern instanceof CallAccessPathPattern) {
      statisticsCollector.registerCallAccessPathPattern(pattern);
      collectPatternStatisticsHelper(pattern.accessPathPattern);
    } else if (pattern instanceof ExclusionAccessPathPattern) {
      statisticsCollector.registerExclusionAccessPathPattern(pattern);
      collectPatternStatisticsHelper(pattern.includeAccPathPattern);
      collectPatternStatisticsHelper(pattern.excludeAccPathPattern);
    } else if (pattern instanceof DisjunctionAccessPathPattern) {
      statisticsCollector.registerDisjunctionAccessPathPattern(pattern);
      pattern.accessPathPatterns.forEach(collectPatternStatisticsHelper);
    } else if (pattern instanceof ImportPathPattern) {
      statisticsCollector.registerImportPathPattern(pattern);
      //TODO: should we register glob complexity?
    } else if (pattern instanceof PotentiallyUnknownAccessPathPattern) {
      statisticsCollector.registerPotentiallyUnknownAccessPathPattern(pattern);
      collectPatternStatisticsHelper(pattern.accessPathPattern);
    } else if (pattern instanceof PropertyPathPattern) {
      statisticsCollector.registerPropertyPathPattern(pattern);
      collectPatternStatisticsHelper(pattern.receiver);
    } else if (pattern instanceof WildcardAccessPathPattern) {
      statisticsCollector.registerWildCardAccessPathPattern(pattern);
      collectPatternStatisticsHelper(pattern.accessPathPattern);
    } else {
      throw new Error("Unsupported pattern type: " + pattern);
    }
  })(pattern));
}

type PatternStatsType = {
  patternLength: number;
  numberCallPatterns: number;
  numberImportPatterns: number;
  numberReadPropertyPatterns: number;
  numberWritePropertyPatterns: number;
  numberCallAccessPathPattern: number;
  numberTypeFilters: number;
  numberArgNumberFilters: number;
  numberExclusionAccessPathPatterns: number;
  numberDisjunctionAccessPathPatterns: number;
  numberImportPathPattern: number;
  numberNegationAccessPathPattern: number;
  numberPotentiallyUnknownAccessPathPatterns: number;
  numberPropertyPathPatterns: number;
  numberWildCardAccessPathPatterns: number;
}

class PatternStatisticsCollector {
  private data: PatternStatsType;
  constructor() {
    this.data = {
      patternLength: 0,
      numberCallPatterns: 0,
      numberImportPatterns: 0,
      numberReadPropertyPatterns: 0,
      numberWritePropertyPatterns: 0,
      numberCallAccessPathPattern: 0,
      numberTypeFilters: 0,
      numberArgNumberFilters: 0,
      numberExclusionAccessPathPatterns: 0,
      numberDisjunctionAccessPathPatterns: 0,
      numberImportPathPattern: 0,
      numberNegationAccessPathPattern: 0,
      numberPotentiallyUnknownAccessPathPatterns: 0,
      numberPropertyPathPatterns: 0,
      numberWildCardAccessPathPatterns: 0
    }
  }

  public getData(): PatternStatsType {
    return this.data;
  }

  public registerCallAccessPathPattern(_pattern: CallAccessPathPattern) {
    this.data.patternLength++;
    this.data.numberCallAccessPathPattern++;
  }

  public registerTypeFilter(_filter: ArgTypeFilter) {
    this.data.patternLength++;
    this.data.numberTypeFilters++;
  }

  public registerArgNumberFilter(_filter: NumArgsFilter) {
    this.data.patternLength++;
    this.data.numberArgNumberFilters++;
  }

  public registerExclusionAccessPathPattern(_pattern : ExclusionAccessPathPattern) {
    this.data.patternLength++;
    this.data.numberExclusionAccessPathPatterns++;
  }

  registerDisjunctionAccessPathPattern(_pattern: DisjunctionAccessPathPattern) {
    this.data.patternLength += _pattern.accessPathPatterns.length - 1;
    this.data.numberDisjunctionAccessPathPatterns++;
  }

  registerImportPathPattern(_pattern: ImportPathPattern) {
    this.data.patternLength++;
    this.data.numberImportPathPattern++;
  }

  registerPotentiallyUnknownAccessPathPattern(_pattern: PotentiallyUnknownAccessPathPattern) {
    this.data.patternLength++;
    this.data.numberPotentiallyUnknownAccessPathPatterns++;
  }

  registerPropertyPathPattern(_pattern: PropertyPathPattern) {
    this.data.patternLength++;
    this.data.numberPropertyPathPatterns++;
  }

  registerWildCardAccessPathPattern(_pattern: WildcardAccessPathPattern) {
    this.data.patternLength++;
    this.data.numberWildCardAccessPathPatterns++;
  }

  registerCallPattern(_pattern: CallPattern) {
    this.data.numberCallPatterns++;
  }

  registerImportPattern(_pattern: ImportPattern) {
    this.data.numberImportPatterns++;
  }

  registerReadPropertyPattern(_pattern: ReadPropertyPattern) {
    this.data.numberReadPropertyPatterns++;
  }

  registerWritePropertyPattern(_pattern: WritePropertyPattern) {
    this.data.numberWritePropertyPatterns++;
  }

  static sum(staticCollectors: PatternStatisticsCollector[]) {
    const res = new PatternStatisticsCollector();
    if (staticCollectors.length == 0)
      return res;
    Object.keys(staticCollectors[0].data).forEach(key => {
      // @ts-ignore
      res.data[key] = staticCollectors.reduce((acc, elem) => acc + elem.data[key], 0);
    });
    return res;
  }

  getNumberPatterns() {
    return this.data.numberImportPatterns + this.data.numberReadPropertyPatterns + this.data.numberWritePropertyPatterns + this.data.numberCallPatterns;
  }
}

commander.parse(process.argv);
