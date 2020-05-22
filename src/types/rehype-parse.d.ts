// Issue detailing ongoing work creating TypeScript definitions:
// https://github.com/rehypejs/rehype/issues/27
declare module "rehype-parse" {
  import type { Plugin } from "unified";

  const parse: Plugin<[
    {
      /**
       * @default false
       */
      fragment?: boolean;
      /**
       * @default "html"
       */
      space?: "html" | "svg";
      /**
       * @default false
       */
      emitParseErrors?: boolean;
      /**
       * @default false
       */
      verbose?: boolean;
    }?,
  ]>;

  export = parse;
}
