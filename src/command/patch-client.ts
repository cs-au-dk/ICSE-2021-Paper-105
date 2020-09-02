import commander from 'commander';

import {runTapirAndPatcherInDir} from '../experiments/PatchingExperiment';
import {createLogger} from '../logging';

import {createCommander} from './patch-client-util';
import {resolve} from "path";
import {StaticConfiguration} from "../static-configuration";

const logger = createLogger('patch-client', 'info');

createCommander(async function(clientName: string, libraryAndVersion: string, patchDir: string, cmdObj: any) {
  if (cmdObj.debug) {
    logger.level = 'debug';
  }
  const excludedFolders = !cmdObj.excludeFolders ? [] : cmdObj.excludeFolders.split(',');
  const excludedFiles = !cmdObj.excludeFiles ? [] : cmdObj.excludeFiles.split(',');

  if (excludedFolders.length > 0 || excludedFiles.length > 0) {
    logger.debug(`excluding folders [${excludedFolders.join(', ')}]`);
    logger.debug(`excluding files [${excludedFiles.join(', ')}]`);
  }

  await runTapirAndPatcherInDir(patchDir, resolve(StaticConfiguration.resPath, `semantic-patches/${libraryAndVersion}.json`), excludedFolders, excludedFiles, libraryAndVersion, clientName, true, true, true, resolve(patchDir, 'autogenerated-patch-questions'));
});

commander.parse(process.argv);