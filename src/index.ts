// eslint-disable-next-line @typescript-eslint/triple-slash-reference
// /// <reference path="../dist/index.d.ts" />
// import chargebee from "chargebee";

import { promises as fs, exists as fsExistsCallback } from "fs";
import util from "util";
import path from "path";
import fetch from "node-fetch";
import prettier from "prettier";
import { parseResource } from "./parseResource";
// import cheerio from "cheerio";

// type Test = chargebee.Configuration;

const fsExists = util.promisify(fsExistsCallback);

const apiMap = {
  // subscription: "https://apidocs.chargebee.com/docs/api/subscriptions",
  payment_intent: "https://apidocs.chargebee.com/docs/api/payment_intents",
};

async function main(): Promise<void> {
  const cachePath = path.resolve(__dirname, "../.cache");
  const cachePathExists = await fsExists(cachePath);
  if (!cachePathExists) {
    await fs.mkdir(cachePath);
  }

  for (const [name, url] of Object.entries(apiMap)) {
    const htmlPath = path.join(cachePath, `${name}.html`);
    if (!(await fsExists(htmlPath))) {
      console.log("Downloading api page:", name);
      const contents = await (await fetch(`${url}?lang=node`)).text();
      await fs.writeFile(htmlPath, contents, "utf8");
    }
  }

  const distPath = path.resolve(__dirname, "../dist");
  const distPathExists = await fsExists(distPath);
  if (!distPathExists) {
    await fs.mkdir(distPath);
  }

  const rootTemplate = await fs.readFile(
    path.join(__dirname, "rootTemplate.d.ts"),
    "utf8",
  );

  const renderTemplate = (): string =>
    prettier.format(rootTemplate, { parser: "typescript" });

  await fs.writeFile(
    path.join(distPath, "index.d.ts"),
    renderTemplate(),
    "utf8",
  );

  for (const resourceName of Object.keys(apiMap)) {
    const htmlPath = path.join(cachePath, `${resourceName}.html`);
    const resourceHtml = await fs.readFile(htmlPath, "utf8");
    parseResource(resourceName, resourceHtml);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
