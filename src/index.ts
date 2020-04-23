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

function snakeCaseToPascalCase(snakeCase: string): string {
  return snakeCase
    .split("_")
    .map((segment) =>
      segment.slice(0, 1).toUpperCase().concat(segment.slice(1)),
    )
    .join("");
}
// #endregion

function generateInterfacePropertySignature(
  propertyElement: Element,
): ts.PropertySignature {
  // If the "cb-list-action" class is missing from the property element it means
  // that the property references a defined interface. The resolution logic for
  // the property name and type must be adjusted accordingly.
  const isInterfaceReference = !propertyElement.properties?.className.includes(
    "cb-list-action",
  );

  const propertyItemElement = propertyElement.children.find(
    (child): child is Element =>
      child.type === "element" &&
      child.properties?.className.includes("cb-list-item"),
  );
  if (!propertyItemElement) {
    throw new Error("Unable to locate property item element.");
  }
  let propertyName: string | null = null;

  if (!isInterfaceReference) {
    visit<Text>(propertyItemElement, "text", (text, _, textParent) => {
      const textParentElement = textParent as Element;
      if (
        textParentElement.type !== "element" ||
        textParentElement.tagName !== "samp"
      ) {
        return;
      }
      propertyName = text.value;
    });
  } else {
    // Since the property is a reference to a defined interface, it's property
    // name is wrapped in a link.
    visit<Element>(propertyItemElement, "element", (element) => {
      if (element.tagName !== "a" || !element.properties?.href) {
        return;
      }
      const text = element.children.find(
        (child): child is Text => child.type === "text",
      );
      if (!text) {
        throw new Error(
          "Failed to retrieve interface reference property name.",
        );
      }
      propertyName = text.value;
    });
  }

  if (!propertyName) {
    throw new Error("Unable to locate property name.");
  }

  const propertyDescriptionElement = propertyElement.children.find(
    (child): child is Element =>
      child.type === "element" &&
      child.properties?.className.includes("cb-list-desc"),
  );
  if (!propertyDescriptionElement) {
    throw new Error("Unable to locate property description element.");
  }
  const definitionElement = propertyDescriptionElement.children.find(
    (child): child is Element =>
      child.type === "element" &&
      child.tagName === "dfn" &&
      child.properties?.className.includes("text-muted"),
  );
  if (!definitionElement) {
    throw new Error("Could not locate property definition element.");
  }
  const definitionText = definitionElement.children.find(
    (child): child is Text => child.type === "text",
  );
  if (!definitionText) {
    throw new Error("Unable to locate definition text.");
  }
  const definitions = definitionText.value
    .split(", ")
    .map((segment) => segment.trim());
  const isOptional = definitions.includes("optional");

  let type: ts.TypeNode;
  if (isInterfaceReference) {
    const interfaceNameDefinition = definitions.filter(
      (definition) => definition !== "optional",
    )[0];
    let interfaceName = /^list of /.test(interfaceNameDefinition)
      ? `${snakeCaseToPascalCase(
          interfaceNameDefinition.replace(/^list of /, ""),
        )}[]`
      : snakeCaseToPascalCase(interfaceNameDefinition);
    // Special case because the documentation has a typo/inconsistency.
    if (interfaceName === "UnbilledCharge[]") {
      console.warn(
        "Overriding type reference of UnbilledCharge[] to UnbilledChargeEstimate[]",
      );
      interfaceName = "UnbilledChargeEstimate[]";
    }

    type = ts.createTypeReferenceNode(
      ts.createIdentifier(interfaceName),
      undefined,
    );
  } else {
    type = ts.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
  }

  return ts.createPropertySignature(
    undefined,
    ts.createIdentifier(propertyName),
    isOptional ? ts.createToken(ts.SyntaxKind.QuestionToken) : undefined,
    type,
    undefined,
  );
}

function generateInterfaceProperties(
  propertyListElement: Element,
): ts.PropertySignature[] {
  const propertySignatures: ts.PropertySignature[] = propertyListElement.children
    .filter((childNode): childNode is Element => childNode.type === "element")
    .map((childElement) => generateInterfacePropertySignature(childElement));

  return propertySignatures;
}

function generateModuleInterfaces(
  modulePageTree: Root,
): ts.InterfaceDeclaration[] {
  const interfaceDeclarations: ts.InterfaceDeclaration[] = [];

  visit<Element>(modulePageTree, "element", (element, index, parent) => {
    const parentElement = parent as Element;
    if (
      element.tagName !== "div" ||
      !element.properties?.className?.includes("page-header")
    ) {
      return;
    }
    const headingElement = element.children.find(
      (child): child is Element => child.tagName === "h4",
    );
    if (!headingElement) {
      return;
    }
    const id: string = headingElement.properties?.id || "";
    if (!/_attributes$/.test(id)) {
      return;
    }
    const interfaceName = snakeCaseToPascalCase(id.replace("_attributes", ""));
    const propertyElements: Element[] = [];
    for (let i = index + 1; i < parentElement.children.length; i += 1) {
      const propertyNode = parentElement.children[i];
      if (propertyNode.type !== "element") {
        continue;
      }
      if (!propertyNode.properties?.className?.includes("cb-list")) {
        break;
      }
      propertyElements.push(propertyNode);
    }

    interfaceDeclarations.push(
      ts.createInterfaceDeclaration(
        undefined,
        undefined,
        ts.createIdentifier(interfaceName),
        undefined,
        undefined,
        propertyElements.map((propertyElement) =>
          generateInterfacePropertySignature(propertyElement),
        ),
      ),
    );
  });

  return interfaceDeclarations;
}

function generateModel(
  modulePageTree: Root,
  namespaceName: string,
): ts.Statement {
  const interfaceName = snakeCaseToPascalCase(namespaceName);
  let propertyListElement: Element | null = null;

  visit<Comment>(modulePageTree, "comment", (comment, _, parent) => {
    if (comment.value !== "attributes") {
      return;
    }

    const adjacentElement = getAdjacentElement(comment, parent);
    if (
      !adjacentElement ||
      adjacentElement.tagName !== "div" ||
      !adjacentElement.properties?.className?.includes("cb-list-group")
    ) {
      return;
    }

    propertyListElement = adjacentElement;
  });

  if (!propertyListElement) {
    throw new Error(
      `Unable to retrieve property list for model: ${interfaceName}`,
    );
  }

  // interface Subscription { ... }
  return ts.createInterfaceDeclaration(
    undefined,
    undefined,
    ts.createIdentifier(interfaceName),
    undefined,
    undefined,
    generateInterfaceProperties(propertyListElement),
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
      ...generateModuleInterfaces(modulePageTree),
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
