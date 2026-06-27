import { spawn } from "node:child_process";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      ...options,
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
    child.on("error", reject);
  });
}

await run("npm", ["run", "build"], {
  env: {
    ...process.env,
    DESKTOP_BUILD: "1",
    VITE_API_BASE_URL: process.env.VITE_API_BASE_URL || "http://localhost:8787",
  },
});
