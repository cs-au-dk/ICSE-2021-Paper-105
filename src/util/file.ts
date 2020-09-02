import {existsSync} from 'fs';
import {lstat, mkdirs, pathExists, readdir as fsReaddir} from 'fs-extra';
import {flatten} from 'lodash';
import {join, resolve} from 'path';
import {promisify as p} from 'util';

import {Path} from '../types';
import {asyncFilter} from './array';

export async function createDirectoryIfMissing(file: Path) {
  if (!existsSync(file)) {
    await p(mkdirs)(file);
  }
}

export async function isDirectory(dir: Path): Promise<boolean> {
  return await pathExists(dir) && (await lstat(dir)).isDirectory();
}

/**
 * returns all files (including directories) in path with fileExtension if specified
 * @param dir
 * @param recursive: reads sub directories
 * @param fileExtension: Only returns files with fileExtension if specified
 */
export async function readDir(
    dir: Path, recursive: boolean = false, fileExtensions?: string[], excluded?: string[], excludedFiles?: string[]): Promise<Path[]> {

  async function readDir_(dir: Path, pointer: Path): Promise<Path[]> {
    let files = await fsReaddir(dir);
    const subDirs = await asyncFilter(
        files, async file => (!excluded || !excluded.includes(join(pointer, file))) && await isDirectory(resolve(dir, file)));

    if (fileExtensions) {
      files = files.filter(file => !file.includes(".") || fileExtensions.some(fileExtension => file.endsWith(fileExtension))).map(file => resolve(dir, file));
    }
    if (excludedFiles)
        files = files.filter(file => !excludedFiles.some(excludedFile => resolve(dir, file).endsWith(excludedFile)));

    if (recursive) {
      return flatten(
          await Promise.all(subDirs.map(async subDir => readDir_(resolve(dir, subDir), join(pointer, subDir)))))
          .concat(files);
    } else {
      return files;
    }
  }
  return readDir_(dir, "");
}

export async function getFilesToAnalyze(directory: string, excludedFolders?: string[], excludedFiles?: string[]): Promise<string[]> {
  return asyncFilter((await readDir(directory, true, ['.js', '.es'], ['node_modules', '.git'].concat(excludedFolders ? excludedFolders : []), excludedFiles))
      .filter(f => !f.endsWith('.min.js')), async file => !(await isDirectory(file)));
}

