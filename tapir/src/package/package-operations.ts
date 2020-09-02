import {exec} from 'child_process';
import {resolve} from 'path';
import {promisify as p} from 'util';

import {createLogger} from '../logging';
import {StaticConfiguration} from '../static-configuration';
import {Path} from '../types';
import {createDirectoryIfMissing, isDirectory} from '../util/file';

import rimraf = require('rimraf');
import {Util} from '../util/util';

const logger = createLogger('package-operations', 'info');

export class PackageOperations {

  /**
   * Performs an npm install
   */
  static async npmInstall(path: Path, docker?: boolean): Promise<Path> {
    try {
      const timeout = 1000 * 60 * 3;

      if (docker) {
        await this.dockerizedCommand('npm install', path, timeout);
      } else {
        await p(exec)('npm install', {cwd: path, timeout: timeout});
      }
    } catch (e) {
      logger.error(`npm install failed for ${path}. Failed with error ${e}`);
      throw e;
    }

    return path;
  }

  static async npmInstallAndBuild(gitDir: string, docker?: boolean): Promise<ExecReturn> {
    const timeout = 3 * 60 * 1000;
    if (docker) {
      await this.npmInstall(gitDir, docker);
      return this.dockerizedCommand('npm run-script build', gitDir, timeout);
    }
    return new Promise(function (resolve) {
      exec(
          `npm install`, {cwd: gitDir, timeout: timeout, killSignal: 'SIGKILL'},
          (error, stdout: string, stderr: string) => {
            p(exec)('npm run-script build', {cwd: gitDir, timeout: timeout, killSignal: 'SIGKILL'})
                .catch(_ => undefined)
                .finally(
                    () => resolve({exit: error?.code || 0, signal: error?.signal, stdout: stdout, stderr: stderr}));
          });
    });
  }

  /**
   * Clones and checks out the given repo and commit and returns the path in which the repo has been cloned.
   */
  static async getPathToGitDir(
      gitURL: string, gitCommit: string, moduleName: string, clientName: string, install?: boolean): Promise<Path> {
    await createDirectoryIfMissing(StaticConfiguration.gitPath);
    const resGitFolder = `${moduleName}-${clientName}`;
    const moduleGitFolder = resolve(StaticConfiguration.gitPath, resGitFolder);
    if (StaticConfiguration.useFilesFromPreviousGitCloneWhenRunningExperiments && await isDirectory(moduleGitFolder))
      return moduleGitFolder;
    await p(rimraf)(moduleGitFolder);
    await p(exec)(`git clone ${gitURL} ${resGitFolder}`, {cwd: StaticConfiguration.gitPath});
    await p(exec)(`git checkout ${gitCommit}`, {cwd: moduleGitFolder});
    if (install) {
      const ret = await PackageOperations.npmInstallAndBuild(moduleGitFolder);
      if (ret.exit !== 0) {
        logger.warn(`npm install or npm build for ${moduleGitFolder} failed with exit code ${ret.exit} and signal ${
            ret.signal}`);
        logger.warn(`stderr: ${ret.stderr}`);
      }
    }

    return moduleGitFolder;
  }

  private static dockerizedCommand(command: string, cwd: string, timeoutMS: number): Promise<ExecReturn> {
    return new Promise<ExecReturn>(async (res) => {
      const dockerHomeFolder = await Util.getHomeFolderInDockerContainer();
      const dockerCommand: string = `docker run -v ${resolve(cwd)}:${
          resolve(dockerHomeFolder, 'cwd')} --rm -t torp123/tapir:v1.1 bash -c 'cd cwd && ${command}'`;


      logger.debug(`Running: ${dockerCommand}`);
      exec(dockerCommand, {timeout: timeoutMS}, (error, stdout, stderr) => {
        res({exit: error ?.code || 0, signal : error ?.signal, stdout : stdout, stderr: stderr});
      });
    });
  }
}
type ExecReturn = {
  exit: number,
  signal?: string, stdout: string, stderr: string
}
