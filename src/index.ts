import { Root, Element } from "hast";
import path from "path";
import prettier from "prettier";
import ts from "typescript";
import visit from "unist-util-visit";
import { fs } from "./fs";
import { pageCache } from "./pageCache";

const distPath = path.resolve(__dirname, "../dist");
const definitionPath = path.join(distPath, "index.d.ts");
const prettierOptionsPath = path.resolve(__dirname, "../.prettierrc");

async function generateModules(indexPageTree: Root): Promise<ts.Statement[]> {
  const statements: ts.Statement[] = [];
  const resourcePathSegments = new Set<string>();

  visit<Element>(indexPageTree, "element", (node) => {
    if (
      node.tagName !== "a" ||
      !node.properties ||
      !Array.isArray(node.properties.className) ||
      !node.properties.className.includes("list-group-item") ||
      !node.properties.href
    ) {
      return;
    }

    const regExpExecArray = /^\/docs\/api\/([a-z_]+)$/.exec(
      node.properties.href,
    );
    if (!regExpExecArray) {
      return;
    }
    resourcePathSegments.add(regExpExecArray[1]);
  });

  for (const resourcePathSegment of resourcePathSegments.values()) {
    const { contents } = await pageCache.getApiPage(resourcePathSegment);
    console.log({ resourcePathSegment, contents: contents.length });
  }

  return statements;
}

async function main(): Promise<void> {
  const prettierOptions: prettier.Options = {
    ...JSON.parse(await fs.readFile(prettierOptionsPath, "utf8")),
    parser: "typescript",
  };
  await fs.upsertDir(distPath);
  const { tree: indexPageTree } = await pageCache.getApiPage("");

  const resultFile = ts.createSourceFile(
    "index.d.ts",
    "",
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

  const result = printer.printNode(
    ts.EmitHint.Unspecified,
    // declare module "chargebee"
    ts.createModuleDeclaration(
      undefined,
      [ts.createModifier(ts.SyntaxKind.DeclareKeyword)],
      ts.createStringLiteral("chargebee"),
      ts.createModuleBlock([
        // namespace Chargebee
        ts.createModuleDeclaration(
          undefined,
          undefined,
          ts.createIdentifier("Chargebee"),
          ts.createModuleBlock(await generateModules(indexPageTree)),
          ts.NodeFlags.Namespace,
        ),

        // export = Chargebee
        ts.createExportAssignment(
          undefined,
          undefined,
          true,
          ts.createIdentifier("Chargebee"),
        ),
      ]),
    ),
    resultFile,
  );

  const prettyResult = prettier.format(result, prettierOptions);
  await fs.writeFile(definitionPath, prettyResult, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
