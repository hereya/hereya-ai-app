import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";
import { resolveSecrets } from "./secrets.js";

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> => {
  await resolveSecrets();

  // Only MCP requests hit the org Lambda now.
  // Frontend requests are routed directly to per-app Lambdas by API Gateway.
  return handleMcpRequest(event);
};

async function handleMcpRequest(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    const url = `https://${event.requestContext.domainName}${event.rawPath}${event.rawQueryString ? "?" + event.rawQueryString : ""}`;
    const body = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString()
      : event.body ?? "";

    const request = new Request(url, {
      method: "POST",
      headers: new Headers(event.headers as Record<string, string>),
      body,
    });

    const parsedBody = JSON.parse(body);

    const authorizerContext = (event.requestContext as unknown as Record<string, unknown>)?.authorizer as
      { lambda?: Record<string, string> } | undefined;

    const authInfo = {
      token: event.headers?.authorization?.replace("Bearer ", "") ?? "",
      clientId: "api-gateway",
      scopes: ["mcp:access"],
      extra: {
        userId: authorizerContext?.lambda?.userId ?? "",
        orgId: authorizerContext?.lambda?.orgId ?? "",
        orgRole: authorizerContext?.lambda?.orgRole ?? "",
      },
    };

    const response = await transport.handleRequest(request, { parsedBody, authInfo });

    const responseBody = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      statusCode: response.status,
      headers: responseHeaders,
      body: responseBody,
    };
  } finally {
    await transport.close();
    await server.close();
  }
}
