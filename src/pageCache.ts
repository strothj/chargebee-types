import * as fs from "fs";
import type { Root } from "hast";
import fetch from "node-fetch";
import * as path from "path";
import * as parse from "rehype-parse";
import { Category } from "typescript-logging";
import * as unified from "unified";

type ApiPage = {
  contents: string;
  tree: Root;
};

const cachePath = path.resolve(__dirname, "../.cache");

function parseAst(contents: string): Root {
  const tree = unified()
    .use(parse, { fragment: false })
    .parse(contents) as Root;
  return tree;
}

async function getApiPage(name: string): Promise<ApiPage> {
  if (!fs.existsSync(cachePath)) {
    fs.mkdirSync(cachePath);
  }

  const filename = name.length > 0 ? `${name}.html` : "index.html";
  const filePath = path.join(cachePath, filename);
  const astFilename = `${filename}.ast.json`;
  const astFilePath = path.join(cachePath, astFilename);
  const resourceTitle = name.length > 0 ? name : "index";
  let contents: string;
  let tree: Root;
  const logger = new Category(`getApiPage(${resourceTitle})`);

  if (!fs.existsSync(filePath)) {
    logger.info("Retrieving resource from documentation server.");
    const response = await fetch(
      `https://apidocs.chargebee.com/docs/api/${name}?lang=node`,
    );
    if (!response.ok) {
      throw new Error(
        `Failed to retrieve resource: ${resourceTitle}: ${response.status}: ${response.statusText}`,
      );
    }
    contents = await response.text();
    fs.writeFileSync(filePath, contents, "utf8");
  } else {
    logger.debug("Retrieving resource from local cache.");
    contents = fs.readFileSync(filePath, "utf8");
  }

  if (!fs.existsSync(astFilePath)) {
    tree = parseAst(contents);
    fs.writeFileSync(astFilePath, JSON.stringify(tree, null, 2), "utf8");
  } else {
    logger.debug("Reading ast from cache.");
    tree = JSON.parse(fs.readFileSync(astFilePath, "utf8"));
  }

  return { contents, tree };
}

export const pageCache = {
  getApiPage,
};
