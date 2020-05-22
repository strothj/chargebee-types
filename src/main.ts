import {
  CategoryConfiguration,
  CategoryServiceFactory,
  LogLevel,
} from "typescript-logging";

CategoryServiceFactory.setDefaultConfiguration(
  new CategoryConfiguration(LogLevel.Debug),
);

async function main(): Promise<void> {}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
