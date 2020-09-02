import {exec} from 'child_process';
import {resolve} from 'path';
import {promisify as p} from 'util';

import {StaticConfiguration} from '../static-configuration';
const dataToLatex = require("data-to-latex");

export class Util {

  public static async getHomeFolderInDockerContainer(): Promise<string> {
    // The username in the docker container is equal to the user name of the user owning the build file in the docker
    // folder. So to resolve the home folder of the docker container, we extract the owner of this file.
    const userOwningDockerBuildFile =
        (await p(exec)(`./get-file-user ./build`, {cwd: StaticConfiguration.dockerFolder})).stdout.trim();
    return resolve('/home/', userOwningDockerBuildFile);
  }

  public static constructionLatexTable(table: string[][]): string {
    let latexTable : string[] = [];

    const tabularOptions = {
      vLines: (new Array(table[0].length + 1)).fill(true), // set vertical lines to get a fully closed tabular
      hLines: (new Array(table.length + 1)).fill(true)  // set horizontal lines to close it horizontally
    };

    table.forEach(row => latexTable = latexTable.concat(row));
    return dataToLatex.formattedTabular(latexTable, table[0].length, tabularOptions)
        .toString().replace(/%/g, '\\%').replace(/#/g, '\\#');
  }
}
