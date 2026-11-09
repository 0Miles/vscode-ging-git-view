import * as fs from "node:fs";

const FS_REGEX = /\\/g;

export function isDirectory(filePath: string) {
  return new Promise<boolean>((resolve) => {
    fs.stat(filePath, (err, stats) => {
      resolve(err ? false : stats.isDirectory());
    });
  });
}

export function doesPathExist(filePath: string) {
  return new Promise<boolean>((resolve) => {
    fs.stat(filePath, (err) => resolve(!err));
  });
}

export function getPathFromStr(str: string) {
  return str.replace(FS_REGEX, "/");
}
