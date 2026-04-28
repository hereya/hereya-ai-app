import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";

const app = new App(
  { name: "hereya-view", version: "1.0.0" },
  {},
  { autoResize: true }
);

// Inject rendered HTML into the view root
function injectHtml(html: string) {
  const root = document.getElementById("view-root")!;
  root.innerHTML = html;
  root.querySelectorAll("script").forEach((old) => {
    const s = document.createElement("script");
    s.textContent = old.textContent;
    old.replaceWith(s);
  });
}

// Expose globals for injected view scripts
(window as any).callTool = (name: string, args: Record<string, unknown>) =>
  app.callServerTool({ name, arguments: args });

(window as any).sendMessage = (text: string) =>
  app.sendMessage({ role: "user", content: [{ type: "text", text }] });

function applyTheme(ctx: Partial<McpUiHostContext>) {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

app.onhostcontextchanged = applyTheme;

app.ontoolresult = (result) => {
  const html = (result as any).structuredContent?.html;
  if (html) injectHtml(html);
};

app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) applyTheme(ctx);
});
