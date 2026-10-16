#!/usr/bin/env bun
/** Internal destination-scoped publisher. Child arguments are never logged. */
import { withArtifactPathWrite } from "../lib/artifact-window";

const [destination, separator, ...command] = process.argv.slice(2);
if (!destination || separator !== "--" || !command.length) {
  console.error("gstack-artifact-publish: destination -- command required; staged bytes kept");
  process.exitCode = 1;
} else {
  try {
    process.exitCode = await withArtifactPathWrite(destination, async () => {
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
