import { Root } from "hast";
import fetch from "node-fetch";
import path from "path";
import parse from "rehype-parse";
import unified from "unified";
import { fs } from "./fs";

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
  await fs.upsertDir(cachePath);

  const filename = name.length > 0 ? `${name}.html` : "index.html";
  const filePath = path.join(cachePath, filename);
  const astFilename = `${filename}.ast.json`;
  const astFilePath = path.join(cachePath, astFilename);
  const resourceTitle = name.length > 0 ? name : "index";
  let contents: string;
  let tree: Root;

  if (!(await fs.exists(filePath))) {
    console.log(
      "Retrieving resource from documentation server:",
      resourceTitle,
    );
    const response = await fetch(
      `https://apidocs.chargebee.com/docs/api/${name}?lang=node`,
    );
    if (!response.ok) {
      throw new Error(
        `Failed to retrieve resource: ${resourceTitle}: ${response.status}: ${response.statusText}`,
      );
    }
    contents = await response.text();
    await fs.writeFile(filePath, contents, "utf8");
  } else {
    console.log("Retrieving resource from local cache:", resourceTitle);
    contents = await fs.readFile(filePath, "utf8");
  }

  if (!(await fs.exists(astFilePath))) {
    console.log("Generating ast:", resourceTitle);
    tree = parseAst(contents);
    await fs.writeFile(astFilePath, JSON.stringify(tree, null, 2), "utf8");
  } else {
    console.log("Reading ast from cache:", resourceTitle);
    tree = JSON.parse(await fs.readFile(astFilePath, "utf8"));
  }

  return { contents, tree };
}

export const pageCache = {
  getApiPage,
};
