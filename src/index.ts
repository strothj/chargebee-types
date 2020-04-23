import { Root, Element, Node, Text, Comment } from "hast";
import path from "path";
import prettier from "prettier";
import ts from "typescript";
import visit from "unist-util-visit";
import { fs } from "./fs";
import { pageCache } from "./pageCache";

const distPath = path.resolve(__dirname, "../dist");
const definitionPath = path.join(distPath, "index.d.ts");
const prettierOptionsPath = path.resolve(__dirname, "../.prettierrc");

// #region Utilities
function getAdjacentElement(node: Node, parentNode: Node): Element | null {
  const parentElement = parentNode as Element;
  const nodeIndex = parentElement.children.findIndex((child) => child === node);
  let adjacentElement: Element | null = null;

  for (let i = nodeIndex + 1; i < parentElement.children.length; i += 1) {
    const child = parentElement.children[i];
    if (child.type !== "element") {
      continue;
    }
    adjacentElement = child;
    break;
  }

  return adjacentElement;
}

function createModuleDeclaration(
  name: string,
  statements: ts.Statement[],
): ts.ModuleDeclaration {
  return ts.createModuleDeclaration(
    undefined,
    undefined,
    ts.createIdentifier(name),
    ts.createModuleBlock(statements),
    ts.NodeFlags.Namespace,
  );
}
// #endregion

function generateModel(
  modulePageTree: Root,
  namespaceName: string,
): ts.Statement {
  visit<Comment>(modulePageTree, "comment", (comment, _, parent) => {
    if (comment.value !== "attributes") {
      return;
    }

    const adjacentElement = getAdjacentElement(comment, parent);
    console.log({ namespaceName, adjacentElement: adjacentElement?.tagName });
  });

  return ts.createInterfaceDeclaration(
    undefined,
    undefined,
    ts.createIdentifier("Test"),
    undefined,
    undefined,
    [],
  );
}

function generateModule(
  modulePageTree: Root,
): {
  namespaceName: string;
  prefixedNamespaceName: string;
  namespaceStatement: ts.Statement;
} {
  let namespaceName: string | null = null;

  visit<Element>(modulePageTree, "element", (element, _, parent) => {
    if (
      element.tagName !== "h4" ||
      !element.children.find(
        (child) => child.type === "text" && child.value === "Model Class",
      )
    ) {
      return;
    }

    const adjacentElement = getAdjacentElement(element, parent);
    if (!adjacentElement) {
      return;
    }
    visit<Text>(adjacentElement, "text", (text, _, textParent) => {
      const value = text.value;
      const textParentElement = textParent as Element;
      if (
        !/[a-z._]/.test(value) ||
        textParentElement.tagName !== "pre" ||
        !textParentElement.properties?.className.includes("prettyprint") ||
        !textParentElement.properties?.className.includes("lang-js")
      ) {
        return;
      }
      const valueSegments = value.split(".");
      namespaceName = valueSegments[valueSegments.length - 1];
    });
  });

  if (!namespaceName) {
    throw new Error("Unable to determine namespace name.");
  }

  // Prefixing the namespace names is required because one of the modules as a
  // reserved keyword as a name (export).
  return {
    namespaceName,
    prefixedNamespaceName: `_${namespaceName}`,
    // namespace _subscriptions { ... }
    namespaceStatement: createModuleDeclaration(`_${namespaceName}`, [
      generateModel(modulePageTree, namespaceName),
    ]),
  };
}

async function generateModules(indexPageTree: Root): Promise<ts.Statement[]> {
  const statements: ts.Statement[] = [];
  const resourcePathSegments = new Set<string>();

  visit<Element>(indexPageTree, "element", (element) => {
    if (
      element.tagName !== "a" ||
      !element.properties ||
      !Array.isArray(element.properties.className) ||
      !element.properties.className.includes("list-group-item") ||
      !element.properties.href
    ) {
      return;
    }

    const regExpExecArray = /^\/docs\/api\/([a-z_]+)$/.exec(
      element.properties.href,
    );
    if (!regExpExecArray) {
      return;
    }
    resourcePathSegments.add(regExpExecArray[1]);
  });

  const namespaceExportMappings: {
    namespaceName: string;
    prefixedNamespaceName: string;
  }[] = [];
  for (const resourcePathSegment of resourcePathSegments.values()) {
    const { tree: modulePageTree } = await pageCache.getApiPage(
      resourcePathSegment,
    );
    const {
      namespaceName,
      prefixedNamespaceName,
      namespaceStatement,
    } = generateModule(modulePageTree);
    statements.push(namespaceStatement);
    namespaceExportMappings.push({ namespaceName, prefixedNamespaceName });
  }

  // export { _subscriptions as subscriptions }
  statements.push(
    ts.createExportDeclaration(
      undefined,
      undefined,
      ts.createNamedExports(
        namespaceExportMappings.map((mapping) =>
          ts.createExportSpecifier(
            ts.createIdentifier(mapping.prefixedNamespaceName),
            ts.createIdentifier(mapping.namespaceName),
          ),
        ),
      ),
    ),
  );

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
        createModuleDeclaration(
          "Chargebee",
          await generateModules(indexPageTree),
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
