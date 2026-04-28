import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSchemaTools } from "./schema.js";
import { registerDataTools } from "./data.js";
import { registerFileTools } from "./files.js";
import { registerInstructionTools } from "./instructions.js";
import { registerSkillTools } from "./skills.js";
import { registerViewTools } from "./views.js";
import { registerConfigTools } from "./config.js";
import { registerUserTools } from "./users.js";
import { registerDeployTools } from "./deploy.js";
import { registerCustomDomainTools } from "./custom-domain.js";
import { registerAuthTools } from "./auth.js";
import { registerMailTools } from "./mail.js";

export function registerTools(server: McpServer) {
  registerSchemaTools(server);
  registerDataTools(server);
  registerFileTools(server);
  registerInstructionTools(server);
  registerSkillTools(server);
  registerViewTools(server);
  registerConfigTools(server);
  registerUserTools(server);
  registerDeployTools(server);
  registerCustomDomainTools(server);
  registerAuthTools(server);
  registerMailTools(server);
}
