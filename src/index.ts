async function main(): Promise<void> {
  console.log("test");
  throw new Error("test");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
