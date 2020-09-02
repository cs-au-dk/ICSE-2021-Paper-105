import {normalize, resolve} from 'path';

import {Path} from './types';
import {REGISTER_INSTANCE} from "ts-node";

export class StaticConfiguration {
  // If running with ts-node, then the 'virtual' compiled file is next to the source file (not in the dist folder)
  public static projectHome =
      StaticConfiguration.isRunningTests() ? normalize(resolve(__dirname, '../')) : normalize(resolve(__dirname, '../'));
  public static outPath: Path = resolve(StaticConfiguration.projectHome, 'out');
  public static resPath: Path = resolve(StaticConfiguration.projectHome, 'res');
  public static gitPath: Path = resolve(StaticConfiguration.outPath, 'git');
  public static dockerFolder = resolve(StaticConfiguration.resPath, 'docker');

  public static ignoreAccessPathsForOrdinaryCalls = false;
  public static failAccessPathsUsingThirdPartyModules = true;
  public static assumeUnknownReceiverMatches = true;
  public static assumeFirstReceiverMatchOnUnknownLibraryObject = true;
  public static checkForDeprecations = false;
  public static useFilesFromPreviousGitCloneWhenRunningExperiments = true;

  /**
   * returns true if running the mocha tests
   */
  public static isRunningTests(): boolean {
    // Checks if ts-node is enabled (only the case for tests)
    return typeof process[REGISTER_INSTANCE] === 'object'
  }

}
