export function isToolModuleFile(filename: string): boolean {
  return filename.endsWith('.js') && !/\.(spec|test)\.js$/.test(filename);
}
