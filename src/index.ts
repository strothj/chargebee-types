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
  exported = false,
): ts.ModuleDeclaration {
  return ts.createModuleDeclaration(
    undefined,
    exported ? [ts.createModifier(ts.SyntaxKind.ExportKeyword)] : undefined,
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
  const isInterfaceReference =
    !propertyElement.properties?.className.includes("cb-list-action") &&
    !propertyElement.properties?.className.includes("cb-sublist-action");

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

  const typePropertiesElement = propertyElement.children.find(
    (child): child is Element =>
      child.type === "element" &&
      child.properties?.className?.includes("cb-list-group-in"),
  );

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
    if (typePropertiesElement) {
      type = ts.createTypeLiteralNode(
        typePropertiesElement.children
          .filter(
            (child): child is Element =>
              child.type === "element" &&
              child.properties?.className?.includes("cb-sublist-action"),
          )
          .map((subPropertyElement) =>
            generateInterfacePropertySignature(subPropertyElement),
          ),
      );
    } else if (definitions.includes("string")) {
      type = ts.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
    } else if (definitions.includes("list of string")) {
      type = ts.createArrayTypeNode(
        ts.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
      );
    } else if (
      definitions.includes("integer") ||
      definitions.includes("in cents") ||
      definitions.includes("timestamp(UTC) in seconds") ||
      definitions.includes("bigdecimal") || // TODO: Verify this type.
      definitions.includes("long") ||
      definitions.includes("double")
    ) {
      type = ts.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
    } else if (definitions.includes("boolean")) {
      type = ts.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
    } else if (definitions.includes("jsonobject")) {
      type = ts.createKeywordTypeNode(ts.SyntaxKind.ObjectKeyword);
    } else if (definitions.includes("jsonarray")) {
      if (propertyName === "notes") {
        console.warn("Assuming array of strings for field:", propertyName);
        type = ts.createArrayTypeNode(
          ts.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        );
      } else if (propertyName === "exemption_details") {
        type = ts.createArrayTypeNode(
          ts.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        );
      } else {
        throw new Error(`Unknown array type for field: ${propertyName}`);
      }
    } else if (definitions.includes("enumerated string")) {
      const enumValues: string[] = [];
      visit<Element>(propertyDescriptionElement, "element", (element) => {
        if (
          element.tagName !== "samp" ||
          !element.properties?.className?.includes("enum")
        ) {
          return;
        }
        const text = element.children.find(
          (child): child is Text => child.type === "text",
        );
        if (!text) {
          throw new Error("Unable to parse enum value.");
        }
        enumValues.push(text.value);
      });
      if (enumValues.length > 0) {
        type = ts.createUnionTypeNode(
          enumValues.map((enumValue) =>
            ts.createLiteralTypeNode(ts.createStringLiteral(enumValue)),
          ),
        );
      } else {
        console.warn("Unable to parse string enum property for:", propertyName);
        type = ts.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
      }
    } else {
      type = ts.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    }
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

// #region Root Module Generators
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
// #endregion

// #region Namespace generators
function generateErrorNamespace(): ts.Statement {
  const errorInterfaces = [
    {
      interfaceName: "PaymentErrorObject",
      type: "payment",
      api_error_code: [
        "payment_processing_failed",
        "payment_method_verification_failed",
        "payment_method_not_present",
        "payment_gateway_currency_incompatible",
        "payment_intent_invalid",
        "payment_intent_invalid_amount",
      ],
    },
    {
      interfaceName: "InvalidRequestErrorObject",
      type: "invalid_request",
      api_error_code: [
        "resource_not_found",
        "resource_limit_exhausted",
        "param_wrong_value",
        "duplicate_entry",
        "db_connection_failure",
        "invalid_state_for_request",
        "http_method_not_supported",
        "invalid_request",
        "resource_limit_exceeded",
      ],
    },
    {
      interfaceName: "OperationFailedErrorObject",
      type: "operation_failed",
      api_error_code: [
        "internal_error",
        "internal_temporary_error",
        "request_blocked",
        "api_request_limit_exceeded",
        "site_not_ready",
        "site_read_only_mode",
      ],
    },
    {
      interfaceName: "IOErrorErrorObject",
      type: "io_error",
      api_error_code: null,
    },
    {
      interfaceName: "ClientErrorErrorObject",
      type: "client_error",
      api_error_code: null,
    },
    {
      interfaceName: "MiscErrorObject",
      type: null,
      api_error_code: [
        "api_authentication_failed",
        "api_authorization_failed",
        "site_not_found",
        "configuration_incompatible",
      ],
    },
  ];
  const errorInterfaceDeclarations = errorInterfaces.map((errorInterface) =>
    ts.createInterfaceDeclaration(
      undefined,
      undefined,
      ts.createIdentifier(errorInterface.interfaceName),
      undefined,
      [
        ts.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [
          ts.createExpressionWithTypeArguments(
            undefined,
            ts.createIdentifier("ErrorObjectBase"),
          ),
        ]),
      ],
      [
        errorInterface.type
          ? ts.createPropertySignature(
              undefined,
              ts.createIdentifier("type"),
              undefined,
              ts.createLiteralTypeNode(
                ts.createStringLiteral(errorInterface.type),
              ),
              undefined,
            )
          : null,
        errorInterface.api_error_code
          ? ts.createPropertySignature(
              undefined,
              ts.createIdentifier("api_error_code"),
              undefined,
              ts.createUnionTypeNode(
                errorInterface.api_error_code.map((errorCode) =>
                  ts.createLiteralTypeNode(ts.createStringLiteral(errorCode)),
                ),
              ),
              undefined,
            )
          : null,
      ].filter(
        (propertySignature): propertySignature is ts.PropertySignature =>
          !!propertySignature,
      ),
    ),
  );

  const errorObjectMapInterfaceDeclaration = ts.createInterfaceDeclaration(
    undefined,
    undefined,
    ts.createIdentifier("ErrorObjectMap"),
    undefined,
    undefined,
    errorInterfaces.map(({ interfaceName }) =>
      ts.createPropertySignature(
        undefined,
        ts.createIdentifier(interfaceName),
        undefined,
        ts.createTypeReferenceNode(
          ts.createIdentifier(interfaceName),
          undefined,
        ),
        undefined,
      ),
    ),
  );

  return createModuleDeclaration(
    "error",
    [
      // interface ErrorObjectBase { ... }
      ts.createInterfaceDeclaration(
        undefined,
        undefined,
        ts.createIdentifier("ErrorObjectBase"),
        undefined,
        undefined,
        [
          ts.createPropertySignature(
            undefined,
            ts.createIdentifier("message"),
            undefined,
            ts.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
            undefined,
          ),
          ts.createPropertySignature(
            undefined,
            ts.createIdentifier("param"),
            ts.createToken(ts.SyntaxKind.QuestionToken),
            ts.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
            undefined,
          ),
        ],
      ),
      // interface MiscErrorObject extends ErrorObjectBase { ... } ...
      ...errorInterfaceDeclarations,
      // interface ErrorObjectMap { ... }
      errorObjectMapInterfaceDeclaration,
      // type ErrorObject = ErrorObjectMap[keyof ErrorObjectMap];
      ts.createTypeAliasDeclaration(
        undefined,
        undefined,
        ts.createIdentifier("ErrorObject"),
        undefined,
        ts.createIndexedAccessTypeNode(
          ts.createTypeReferenceNode(
            ts.createIdentifier("ErrorObjectMap"),
            undefined,
          ),
          ts.createTypeOperatorNode(
            ts.SyntaxKind.KeyOfKeyword,
            ts.createTypeReferenceNode(
              ts.createIdentifier("ErrorObjectMap"),
              undefined,
            ),
          ),
        ),
      ),
    ],
    true,
  );
}

function generateRequestNamespace(): ts.Statement {
  return createModuleDeclaration(
    "request",
    [
      // interface ResponseHandler<Response> { ... }
      ts.createInterfaceDeclaration(
        undefined,
        undefined,
        ts.createIdentifier("ResponseHandler"),
        [ts.createTypeParameterDeclaration(ts.createIdentifier("Response"))],
        undefined,
        [
          // (error: error.ErrorObject | undefined, response: Response): void;
          ts.createCallSignature(
            undefined,
            [
              ts.createParameter(
                undefined,
                undefined,
                undefined,
                ts.createIdentifier("error"),
                undefined,
                ts.createUnionTypeNode([
                  ts.createTypeReferenceNode(
                    ts.createQualifiedName(
                      ts.createIdentifier("error"),
                      ts.createIdentifier("ErrorObject"),
                    ),
                    undefined,
                  ),
                  ts.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
                ]),
              ),
              ts.createParameter(
                undefined,
                undefined,
                undefined,
                ts.createIdentifier("response"),
                undefined,
                ts.createTypeReferenceNode(
                  ts.createIdentifier("Response"),
                  undefined,
                ),
              ),
            ],
            ts.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword),
          ),
        ],
      ),
      ts.createInterfaceDeclaration(
        undefined,
        undefined,
        ts.createIdentifier("RequestWrapper"),
        [
          ts.createTypeParameterDeclaration(
            ts.createIdentifier("Response"),
            undefined,
            undefined,
          ),
        ],
        undefined,
        [
          // request(): Promise<Response>;
          ts.createMethodSignature(
            undefined,
            [],
            ts.createTypeReferenceNode(ts.createIdentifier("Promise"), [
              ts.createTypeReferenceNode(
                ts.createIdentifier("Response"),
                undefined,
              ),
            ]),
            ts.createIdentifier("request"),
            undefined,
          ),
          // request(responseHandler: ResponseHandler<Response>): void;
          ts.createMethodSignature(
            undefined,
            [
              ts.createParameter(
                undefined,
                undefined,
                undefined,
                ts.createIdentifier("responseHandler"),
                undefined,
                ts.createTypeReferenceNode(
                  ts.createIdentifier("ResponseHandler"),
                  [
                    ts.createTypeReferenceNode(
                      ts.createIdentifier("Response"),
                      undefined,
                    ),
                  ],
                ),
              ),
            ],
            ts.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword),
            ts.createIdentifier("request"),
            undefined,
          ),
        ],
      ),
      // interface RequestFactory<Arguments extends any[], Response> { ... }
      ts.createInterfaceDeclaration(
        undefined,
        undefined,
        ts.createIdentifier("RequestFactory"),
        [
          ts.createTypeParameterDeclaration(
            ts.createIdentifier("Arguments"),
            ts.createArrayTypeNode(
              ts.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
            ),
          ),
          ts.createTypeParameterDeclaration(
            ts.createIdentifier("Response"),
            undefined,
          ),
        ],
        undefined,
        [
          // (...args: Arguments): RequestWrapper<Response>;
          ts.createCallSignature(
            undefined,
            [
              ts.createParameter(
                undefined,
                undefined,
                ts.createToken(ts.SyntaxKind.DotDotDotToken),
                ts.createIdentifier("args"),
                undefined,
                ts.createTypeReferenceNode(
                  ts.createIdentifier("Arguments"),
                  undefined,
                ),
              ),
            ],
            ts.createTypeReferenceNode(ts.createIdentifier("RequestWrapper"), [
              ts.createTypeReferenceNode(
                ts.createIdentifier("Response"),
                undefined,
              ),
            ]),
          ),
        ],
      ),
    ],
    true,
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
// #endregion

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
        createModuleDeclaration("Chargebee", [
          generateErrorNamespace(),
          generateRequestNamespace(),
          ...(await generateModules(indexPageTree)),
        ]),

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
