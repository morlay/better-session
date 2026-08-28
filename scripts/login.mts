import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const token = process.env.NODE_AUTH_TOKEN;
if (!token) {
  console.error("NODE_AUTH_TOKEN is required");
  process.exit(1);
}

// pnpm publish 拒绝脏 working tree，认证 token 写到全局 ~/.npmrc
writeFileSync(join(homedir(), ".npmrc"), `//npm.pkg.github.com/:_authToken=${token}\n`);
