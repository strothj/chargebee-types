import { promises as fsPromises, exists as callbackFsExists } from "fs";
import util from "util";

const exists = util.promisify(callbackFsExists);

async function upsertDir(path: string): Promise<void> {
  if (!(await exists(path))) {
    await fsPromises.mkdir(path);
  }
}

export const fs = {
  ...fsPromises,
  exists,
  upsertDir,
};
