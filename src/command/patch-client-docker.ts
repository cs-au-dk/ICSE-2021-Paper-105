import {spawn} from 'child_process';
import commander from 'commander';
import {resolve} from 'path';

import {createLogger} from '../logging';
import {StaticConfiguration} from '../static-configuration';
import {Util} from '../util/util';

import {createCommander} from './patch-client-util';

const logger = createLogger('patch-client-docker', 'info');

createCommander(async function(clientName: string, libraryAndVersion: string, patchDir: string, cmdObj: any) {
  return new Promise<number>(async (res, reject) => {
    if (cmdObj.debug) {
      logger.level = 'debug';
    }

    const args: string[] = ['run', '-it'];

    const dockerHomeFolder = await Util.getHomeFolderInDockerContainer();

    // mount tapir build files
    ['node_modules', 'res', 'dist'].forEach(
        dir => args.push('-v', `${resolve(StaticConfiguration.projectHome, dir)}:${resolve(dockerHomeFolder, dir)}`));

    // mount client
    args.push('-v', `${resolve(patchDir)}:${resolve(dockerHomeFolder, 'client')}`);

    // remaining args
    args.push(
        '--rm', 'torp123/tapir:v1.1', 'node', resolve(dockerHomeFolder, 'dist/src/index.js'),
        'patch', clientName, libraryAndVersion, 'client'); //TODO: pass --exclude-folders, --exclude-files and cmdObj options (e.g., --debug) if present

    logger.debug(`Running: docker ${args.join(' ')}`);

    const docker = spawn('docker', args, {timeout: 20 * 60 * 1000, stdio: ['inherit', 'inherit', 'inherit']});

    docker.on('close', (code) => {
      if (code != 0) {
        reject(code);
      } else {
        res(code);
      }
    })
  });
});

commander.parse(process.argv);
