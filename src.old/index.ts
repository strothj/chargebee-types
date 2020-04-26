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
): ts.PropertySignature[] {
  // Parse paramter interface sub objects.
  if (propertyElement.properties?.className?.includes("sub-group")) {
    let propertyName = null as string | null;
    let isArray = null as boolean | null;
    let propertySignatures = null as ts.PropertySignature[] | null;
    visit<Element>(propertyElement, "element", (element) => {
      if (element.properties?.className?.includes("cb-list-head")) {
        const listHeadElement = element;
        visit<Element>(listHeadElement, "element", (listHeadChildElement) => {
          // Parse property name.
          if (
            propertyName === null &&
            listHeadChildElement.properties?.className?.includes("cb-list-item")
          ) {
            const listItemElement = listHeadChildElement;
            visit<Text>(
              listItemElement,
              "text",
              (propertyNameText, _, propertyNameTextParent) => {
                const propertyNameTextParentElement = propertyNameTextParent as Element;
                if (propertyNameTextParentElement.tagName !== "strong") {
                  return;
                }
                propertyName = propertyNameText.value;
              },
            );
          }
          // Parse isArray.
          else if (
            isArray === null &&
            listHeadChildElement.properties?.className?.includes("cb-list-desc")
          ) {
            const listDescriptionElement = listHeadChildElement;
            const listDescriptionText = listDescriptionElement.children.find(
              (child): child is Text => child.type === "text",
            );
            if (!listDescriptionText) {
              return;
            }
            isArray = listDescriptionText.value.includes("Array");
          } else {
            return;
          }
        });
      } else if (
        propertySignatures === null &&
        element.properties?.className?.includes("collapse")
      ) {
        const propertyElements = element.children.filter(
          (child): child is Element =>
            child.type === "element" &&
            child.properties?.className?.includes("cb-sublist-action"),
        );
        propertySignatures = propertyElements
          .map((propertyElement) =>
            generateInterfacePropertySignature(propertyElement),
          )
          .flat(1);
      } else {
        return;
      }
    });
    if (propertyName === null) {
      throw new Error(
        `Unable to parse property name.: ${propertyElement.position?.start.line}`,
      );
    } else if (isArray === null) {
      throw new Error("Unable to isArray.");
    } else if (propertySignatures === null) {
      throw new Error("Unable to parse property signatures.");
    }
    const typeLiteralNode = ts.createTypeLiteralNode(propertySignatures);
    return [
      ts.createPropertySignature(
        undefined,
        ts.createIdentifier(propertyName),
        ts.createToken(ts.SyntaxKind.QuestionToken),
        isArray ? ts.createArrayTypeNode(typeLiteralNode) : typeLiteralNode,
        undefined,
      ),
    ];
  }

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
  let propertyName = null as string | null;

  if (!isInterfaceReference) {
    visit<Text>(propertyItemElement, "text", (text, _, textParent) => {
      const textParentElement = textParent as Element;
      if (
        propertyName !== null ||
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
  let definitionElement = null as Element | null;
  visit<Element>(propertyDescriptionElement, "element", (element) => {
    if (
      definitionElement ||
      element.tagName !== "dfn" ||
      !element.properties?.className?.includes("text-muted")
    ) {
      return;
    }
    definitionElement = element;
  });
  // const definitionElement = propertyDescriptionElement.children.find(
  //   (child): child is Element =>
  //     child.type === "element" &&
  //     child.tagName === "dfn" &&
  //     child.properties?.className?.includes("text-muted"),
  // );
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
    // Special case: string filter property set:
    // TODO: Compute the valid combinations of the string filters.
    if (
      definitions.includes("string filter") ||
      definitions.includes("enumerated string filter") ||
      // The following fields are shown with their examples within the
      // documentation property tables as using string values. This may be a
      // mistake.
      definitions.includes("integer filter") ||
      definitions.includes("timestamp(UTC) in seconds filter") ||
      definitions.includes("boolean filter") ||
      definitions.includes("in cents filter")
    ) {
      propertyName = propertyName.trim().replace("[", "");
      let operators = null as string[] | null;
      if (propertyName === "sort_by") {
        operators = ["asc", "desc"];
      } else {
        visit<Element>(
          propertyDescriptionElement,
          "element",
          (element, index, parent) => {
            if (
              element.tagName !== "b" ||
              element.children[0].type !== "text" ||
              !element.children[0].value.includes("Supported operators")
            ) {
              return;
            }
            const parentElement = parent as Element;
            const operatorsText = parentElement.children[index + 1] as Text;
            operators = operatorsText.value.split(", ");
          },
        );
      }
      if (!operators) {
        throw new Error("Unable to parse operators.");
      }
      return operators.map((operator) =>
        ts.createPropertySignature(
          undefined,
          ts.createStringLiteral(`${propertyName}[${operator}]`),
          isOptional ? ts.createToken(ts.SyntaxKind.QuestionToken) : undefined,
          ts.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          undefined,
        ),
      );
    } else if (typePropertiesElement) {
      type = ts.createTypeLiteralNode(
        typePropertiesElement.children
          .filter(
            (child): child is Element =>
              child.type === "element" &&
              child.properties?.className?.includes("cb-sublist-action"),
          )
          .map(
            (subPropertyElement) =>
              generateInterfacePropertySignature(subPropertyElement)[0],
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

  return [
    ts.createPropertySignature(
      undefined,
      ts.createIdentifier(propertyName),
      isOptional ? ts.createToken(ts.SyntaxKind.QuestionToken) : undefined,
      type,
      undefined,
    ),
  ];
}

function generateInterfaceProperties(
  propertyListElement: Element,
): ts.PropertySignature[] {
  const propertySignatures: ts.PropertySignature[] = propertyListElement.children
    .filter((childNode): childNode is Element => childNode.type === "element")
    .map((childElement) => generateInterfacePropertySignature(childElement))
    .flat(1);

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
        propertyElements
          .map((propertyElement) =>
            generateInterfacePropertySignature(propertyElement),
          )
          .flat(1),
      ),
    );
  });

  return interfaceDeclarations;
}

function generateModuleMethods(
  modulePageTree: Root,
  namespaceName: string,
): ts.Statement[] {
  const statements: ts.Statement[] = [];
  console.log("## generateModuleMethods:", namespaceName);

  visit<Element>(
    modulePageTree,
    "element",
    (sampleResultHeadingElement, _, parent) => {
      if (sampleResultHeadingElement.tagName !== "h4") {
        return;
      }

      const sampleResultHeadingText = sampleResultHeadingElement.children.find(
        (child) =>
          child.type === "text" && child.value.trim() === "Sample Result",
      );
      if (!sampleResultHeadingText) {
        return;
      }

      // Determine whether or not the method returns a list of results by
      // parsing the sample text.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const sampleResultCodeWrapperElement = getAdjacentElement(
        sampleResultHeadingElement,
        parent,
      )!;
      let sampleResultCodeElement = null as Element | null;
      visit<Element>(sampleResultCodeWrapperElement, "element", (element) => {
        if (
          sampleResultCodeElement !== null ||
          (element.tagName !== "pre" && element.tagName !== "code") ||
          !element.properties?.className?.includes("prettyprint")
        ) {
          return;
        }
        sampleResultCodeElement = element;
      });
      if (!sampleResultCodeElement) {
        throw new Error(
          `Failed to retrieve sample code element for ${namespaceName} method.`,
        );
      }
      const sampleResultCodeText = sampleResultCodeElement.children.find(
        (child): child is Text => child.type === "text",
      );
      if (!sampleResultCodeText) {
        throw new Error("Unable to retrieve sample code text.");
      }
      const sampleResultCode = sampleResultCodeText.value.replace(/\s/g, "");
      const isList = /^{"list":\[{/.test(sampleResultCode);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const methodSignatureWrapperElement = getAdjacentElement(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        getAdjacentElement(sampleResultCodeWrapperElement, parent)!,
        parent,
      )!;
      if (
        !methodSignatureWrapperElement.properties?.className?.includes(
          "cb-code-io",
        )
      ) {
        throw new Error();
      }
      const methodSignatureElement = methodSignatureWrapperElement.children.find(
        (child): child is Element =>
          child.type === "element" &&
          child.properties?.className?.includes("prettyprint"),
      );
      if (!methodSignatureElement) {
        throw new Error("Unable to retrieve method signature element.");
      }
      const methodSignatureText = methodSignatureElement.children.find(
        (child): child is Text => child.type === "text",
      );
      if (!methodSignatureText) {
        throw new Error("Unable to retrieve method signature text.");
      }
      const methodSignature = methodSignatureText.value;
      const methodNameMatch = /chargebee\.[a-z0-9_]+\.([a-z0-9_]+)\(/.exec(
        methodSignature,
      );
      const methodName = methodNameMatch && methodNameMatch[1];
      if (!methodName) {
        throw new Error("Unable to parse method name.");
      }
      const stringParameterMatch = /\(<([a-z0-9_]+)>/.exec(methodSignature);
      const stringParameterName =
        stringParameterMatch && stringParameterMatch[1];
      const hasObjectParameter = /{.+}/.test(methodSignature);

      let listOffset: Element = methodSignatureWrapperElement;
      if (hasObjectParameter) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const inputParametersWrapper = getAdjacentElement(
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          getAdjacentElement(listOffset, parent)!,
          parent,
        )!;
        const interfacePropertySignatures = inputParametersWrapper.children
          .filter(
            (child): child is Element =>
              child.type === "element" &&
              (child.properties?.className?.includes("cb-list-action") ||
                child.properties?.className?.includes("sub-group")),
          )
          .map((propertyElement) =>
            generateInterfacePropertySignature(propertyElement),
          )
          .flat(1);
        statements.push(
          ts.createInterfaceDeclaration(
            undefined,
            [ts.createModifier(ts.SyntaxKind.ExportKeyword)],
            `${snakeCaseToPascalCase(methodName)}Parameters`,
            undefined,
            undefined,
            interfacePropertySignatures,
          ),
        );
        listOffset = inputParametersWrapper;
      }

      // TODO: Type return types.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      // const returnTypeWrapper = getAdjacentElement(
      //   // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      //   getAdjacentElement(listOffset, parent)!,
      //   parent,
      // )!;
      statements.push(
        ts.createInterfaceDeclaration(
          undefined,
          [ts.createModifier(ts.SyntaxKind.ExportKeyword)],
          `${snakeCaseToPascalCase(methodName)}Response`,
          undefined,
          undefined,
          [],
          // returnTypeWrapper.children
          //   .filter(
          //     (child): child is Element =>
          //       child.type === "element" &&
          //       child.properties?.className?.includes("cb-list"),
          //   )
          //   .map((child) => generateInterfacePropertySignature(child))
          //   .flat(1),
        ),
      );

      console.log({
        isList,
        methodName,
        methodSignature,
        stringParameterName,
        hasObjectParameter,
      });

      statements.push(
        // We use a s prefixed variable name with a separate export declaration
        // because some method names use reserved words.
        // const _create: request.RequestFactory<[CreateParameters], CreateResponse>;
        ts.createVariableStatement(
          undefined,
          ts.createVariableDeclarationList(
            [
              ts.createVariableDeclaration(
                ts.createIdentifier(`_${methodName}`),
                ts.createTypeReferenceNode(
                  ts.createQualifiedName(
                    ts.createIdentifier("request"),
                    ts.createIdentifier("RequestFactory"),
                  ),
                  [
                    ts.createTupleTypeNode(
                      [
                        stringParameterName
                          ? ts.createKeywordTypeNode(
                              ts.SyntaxKind.StringKeyword,
                            )
                          : null,
                        hasObjectParameter
                          ? ts.createTypeReferenceNode(
                              ts.createIdentifier(
                                `${snakeCaseToPascalCase(
                                  methodName,
                                )}Parameters`,
                              ),
                              undefined,
                            )
                          : null,
                      ].filter(
                        (node): node is NonNullable<typeof node> => !!node,
                      ),
                    ),
                    ts.createTypeReferenceNode(
                      ts.createIdentifier(
                        `${snakeCaseToPascalCase(methodName)}Response`,
                      ),
                      undefined,
                    ),
                  ],
                ),
              ),
            ],
            ts.NodeFlags.Const,
          ),
        ),
        // export { _create as create };
        ts.createExportDeclaration(
          undefined,
          undefined,
          ts.createNamedExports([
            ts.createExportSpecifier(
              ts.createIdentifier(`_${methodName}`),
              methodName,
            ),
          ]),
        ),
      );
    },
  );

  return statements;
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
    [ts.createModifier(ts.SyntaxKind.ExportKeyword)],
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
      ...generateModuleMethods(modulePageTree, namespaceName),
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
