#!/usr/bin/env bun
/** Internal explicitly mutation-scoped publisher. Child arguments are never logged. */
import { withArtifactPathsWrite } from "../lib/artifact-window";

const args = process.argv.slice(2), separator = args.indexOf("--");
const destination = args[0], command = args.slice(separator + 1), mutations = [destination];
let valid = separator >= 1;
for (let index = 1; index < separator; index += 2) {
  if (args[index] !== "--mutates" || !args[index + 1] || index + 1 >= separator) valid = false;
  else mutations.push(args[index + 1]);
}
if (!destination || !valid || !command.length) {
  console.error("gstack-artifact-publish: destination [--mutates path] -- command required; staged bytes kept");
  process.exitCode = 1;
} else {
  try {
    process.exitCode = await withArtifactPathsWrite(mutations, async () => {
      const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      return await child.exited;
    });
  } catch (error) {
    if (command[1]?.endsWith("gstack-design-claim-impl.sh")) {
      console.error(`gstack-design-claim: cannot create ${destination}; staged image kept at ${command[2]}\ncause: ${error instanceof Error ? error.message : "admission failed"}\nfix: preserve the staged image and resolve the destination or maintenance hold before publishing it once`);
    } else {
      console.error(`gstack-artifact-publish: ${error instanceof Error ? error.message : "admission failed"}; staged bytes kept`);
    }
    process.exitCode = 1;
  }
}
