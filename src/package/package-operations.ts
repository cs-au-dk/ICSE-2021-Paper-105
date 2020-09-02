import {exec} from 'child_process';
import * as fs from 'fs';
import ncp from 'ncp';
import {resolve} from 'path';
import {promisify as p} from 'util';

import {createLogger} from '../logging';
import {StaticConfiguration} from '../static-configuration';
import {Path} from '../types';
import {createDirectoryIfMissing, isDirectory} from '../util/file';
import latestVersion from 'latest-version';

import rimraf = require('rimraf');
import {Util} from '../util/util';
import {writeJson, copy} from 'fs-extra';

const logger = createLogger('package-operations', 'info');

export class PackageOperations {
  /**
   * Performs an npm install
   * @param pkg if a Package, then it first fetches the content from the npm
   * registry, and then performs an npm install on the extracted content.
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

  static async getPackageJsonObj(packagePath: string): Promise<any> {
    const packageJsonPath = resolve(packagePath, 'package.json');
    const packageJsonCnt = await p(fs.readFile)(packageJsonPath, 'utf-8');
    const packageJsonObj = JSON.parse(packageJsonCnt);
    return packageJsonObj;
  }

  static async npmInstallAndBuild(gitDir: string, docker?: boolean): Promise<ExecReturn> {
    const timeout = 3 * 60 * 1000;
    if (docker) {
      await this.npmInstall(gitDir, docker);
      return this.dockerizedCommand('npm run-script build', gitDir, timeout);
    }
    return new Promise(function(resolve) {
      exec(
          `npm install`, {cwd: gitDir, timeout: timeout, killSignal: 'SIGKILL'},
          (error, stdout: string, stderr: string) => {
            p(exec)('npm run-script build', {cwd: gitDir, timeout: timeout, killSignal: 'SIGKILL'})
                .catch(_ => undefined)
                .finally(
                    () => resolve({exit: error ?.code || 0, signal : error ?.signal, stdout : stdout, stderr: stderr}));
          });
    });
  }

  static async addPackageToPackageJson(dir: string, packageName: string, packageVersion?: string) {
    if (!packageVersion) packageVersion = await latestVersion(packageName);
    const pkgJson = await PackageOperations.getPackageJsonObj(dir);
    pkgJson.dependencies[packageName] = `^${packageVersion}`;
    await writeJson(resolve(dir, 'package.json'), pkgJson, {spaces: 2});
  }

  /**
   * @param gitDir
   */
  static async runTest(gitDir: string, docker?: boolean, explicitTestCommand?: string): Promise<ExecReturn> {
    const timeout = 1000 * 60 * 3;
    const command = explicitTestCommand || 'npm test';
    if (docker) {
      return PackageOperations.dockerizedCommand(command, gitDir, timeout);
    }
    return new Promise(function(resolve) {
      exec(command, {cwd: gitDir, timeout: timeout, killSignal: 'SIGKILL'}, (error, stdout, stderr) => {
        resolve({exit: error ?.code || 0, signal : error ?.signal, stdout : stdout, stderr: stderr});
      })
    });
    // return [res.stdout, res.stderr];
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

  /**
   * Clones and checks out the given repo and commit, copies the directory - installs and builds the project and
   * updates to moduleAndVersion, and copies these files to another directory and returns this directory.
   */
  static async getPathToPatcherDir(
      gitURL: string, gitCommit: string, moduleAndVersion: string, clientName: string,
      install?: boolean): Promise<Path> {
    let moduleName = moduleAndVersion.split('@')[0];
    const gitDir = await this.getPathToGitDir(gitURL, gitCommit, moduleName, clientName, install);
    await createDirectoryIfMissing(StaticConfiguration.patcherPreparingDir);
    await createDirectoryIfMissing(StaticConfiguration.patcherRunningDir);
    const resFolder = `${moduleName}-${clientName}`;
    const patcherPreparingFolder = resolve(StaticConfiguration.patcherPreparingDir, resFolder);
    if (!await isDirectory(patcherPreparingFolder)) {
      await createDirectoryIfMissing(patcherPreparingFolder);
      await this.copyDirectory(gitDir, patcherPreparingFolder);
      if (install) {
        await this.npmInstallAndBuild(patcherPreparingFolder);
        await p(exec)(
            `npm install ${moduleAndVersion}`,
            {cwd: patcherPreparingFolder, timeout: 5 * 60 * 1000, killSignal: 'SIGKILL'})
      }
    }

    const patcherRunningFolder = resolve(StaticConfiguration.patcherRunningDir, resFolder);
    await p(rimraf)(patcherRunningFolder);
    await createDirectoryIfMissing(patcherRunningFolder);
    await this.copyDirectory(patcherPreparingFolder, patcherRunningFolder);

    return patcherRunningFolder;
  }

  public static async copyDirectory(fromDir: string, toDir: string) {
    try {
      await copy(fromDir, toDir);
    } catch (e) {
      await p(ncp)(fromDir, toDir);
    }
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
