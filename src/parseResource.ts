import cheerio from "cheerio";

type Resource = {
  namespaceName: string;
  interfaces: Interface[];
};

type PropertyType = {
  optional: boolean;
} & (
  | {
      type: "primitive";
      typeName: string;
    }
  | {
      type: "object";
      properties: Property[];
    }
);

type Property = [string, PropertyType];

type Interface = {
  name: string;
  properties: Property[];
};

function parseEnumElement(
  $: CheerioStatic,
  enumElement: CheerioElement,
): string {
  const enumValueElements = $("> samp.enum", enumElement);
  const enumValues = enumValueElements
    .toArray()
    .map((enumValueElement) => enumValueElement.children[0].data)
    .filter((enumValue): enumValue is string => enumValue !== undefined);
  if (enumValues.length === 0) {
    throw new Error("Missing enum values.");
  }
  return enumValues.map((enumValue) => `"${enumValue}"`).join(" | ");
}

function parsePropertyAttributes(
  $: CheerioStatic,
  propertyTypeElement: CheerioElement,
): string[] {
  const propertyStringElement = $("> dfn.text-muted", propertyTypeElement)[0];
  if (!propertyStringElement) {
    throw new Error("Missing property string element.");
  }
  const propertyStringTextNode = propertyStringElement.children[0];
  if (!propertyStringTextNode) {
    throw new Error("Missing property string text node.");
  }
  const propertyString = propertyStringTextNode.data;
  if (!propertyString) {
    throw new Error("Missing property string.");
  }

  const propertyAttributes = propertyString.split(", ");
  return propertyAttributes;
}

function parsePropertyTypeElement(
  $: CheerioStatic,
  propertyTypeElement: CheerioElement,
): PropertyType {
  const propertyAttributes = parsePropertyAttributes($, propertyTypeElement);
  const optional = propertyAttributes.includes("optional");
  if (propertyAttributes.includes("string")) {
    return {
      optional,
      type: "primitive",
      typeName: "string",
    };
  } else if (propertyAttributes.includes("enumerated string")) {
    const enumElement = $("> .cb-enum-parent", propertyTypeElement)[0];
    if (!enumElement) {
      throw new Error("Missing enum element.");
    }
    return {
      optional,
      type: "primitive",
      typeName: parseEnumElement($, enumElement),
    };
  } else if (
    propertyAttributes.includes("in cents") ||
    propertyAttributes.includes("timestamp(UTC) in seconds")
  ) {
    return {
      optional,
      type: "primitive",
      typeName: "number",
    };
  } else {
    throw new Error(`Unsupported type: ${propertyAttributes.join(", ")}`);
  }
}

function parsePropertyElements(
  $: CheerioStatic,
  propertyElements: Cheerio,
): Property[] {
  const properties: Property[] = [];
  for (const propertyElement of propertyElements.toArray()) {
    const propertyNameElement = $("> .cb-list-item", propertyElement)[0];
    if (!propertyNameElement) {
      throw new Error("Missing property name element.");
    }
    const propertyName = $("> samp", propertyNameElement)
      .toArray()[0]
      .children.filter((node) => node.type === "text")[0].data;
    if (!propertyName) {
      throw new Error("Missing property name.");
    }
    const propertyIsObject =
      $("> a.toggle-attr", propertyNameElement).length > 0;

    const propertyTypeElement = $("> .cb-list-desc", propertyElement)[0];
    if (!propertyTypeElement) {
      throw new Error("Missing property type element.");
    }

    if (propertyIsObject) {
      const objectPropertyElements = $(".cb-sublist-action", propertyElement);
      properties.push([
        propertyName,
        {
          optional: parsePropertyAttributes($, propertyTypeElement).includes(
            "optional",
          ),
          type: "object",
          properties: parsePropertyElements($, objectPropertyElements),
        },
      ]);
      continue;
    }

    const propertyType = parsePropertyTypeElement($, propertyTypeElement);
    properties.push([propertyName, propertyType]);
  }
  return properties;
}

function fromSnakeCaseToPascalCase(snakeCase: string): string {
  return snakeCase
    .split("_")
    .map((segment) => `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`)
    .join("");
}

export function parseResource(
  resourceName: string,
  resourceHtml: string,
): Resource {
  const modelName = fromSnakeCaseToPascalCase(resourceName);
  console.log({ modelName });
  const $ = cheerio.load(resourceHtml);
  const listGroupElements = $(".cb-list-group");
  const interfaces: Interface[] = [];
  let parsingModel = true;

  for (const listGroupElement of listGroupElements.toArray()) {
    const propertyElements = $("> .cb-list-action", listGroupElement);
    const properties = parsePropertyElements($, propertyElements);
    console.log({ properties });
    if (properties.length === 0) {
      continue;
    }

    if (parsingModel) {
      parsingModel = false;
      interfaces.push({
        name: modelName,
        properties,
      });
      continue;
    }

    // break;
  }

  const resource: Resource = {
    namespaceName: resourceName,
    interfaces,
  };

  console.log(resource);
  return resource;
}
