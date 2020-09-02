import commander from 'commander';

export async function createCommander(
    action: (clientName: string, libraryAndVersion: string, patchDir: string, cmdObj: any) => void) {
  commander.arguments('<clientName> <libraryAndVersion> <patchDir>')
      .option('-d, --debug', 'Enable debug logging')
      .option('--exclude-folders <excludeFolders>', 'Folders to exclude in patching')
      .option('--exclude-files <excludeFiles>', 'Files to exclude in patching')
      .description(
          'Patches the client in <patchDir> with respect to the update to <libraryAndVersion>, but excluding the folders <excludeFolders> and the files <excludeFiles>')
      .action(action);
}