import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolError } from "../errors.js";

const TOPICS: Record<string, string> = {
  "create-app": `# How to Create an App on Hereya

An app on Hereya is a Postgres schema + an S3 folder + one or more skills (instructions for using the app).

## Steps

### 1. Pick a name
Choose a lowercase alphanumeric name, starting with a letter — **no hyphens, no underscores**. Max 63 characters. Examples: \`recipes\`, \`billing\`, \`contactmanager\`, \`orders2\`.

This constraint exists because the schema name is used verbatim as a DNS label for the app's URL (\`{schema}.{customDomain}\`) and as the per-app Postmark sender subdomain. DNS labels don't allow underscores, and keeping the rule uniform avoids surprises at \`enable-auth\` time. (A handful of legacy apps pre-date this rule and keep working, but new apps must follow it.)

### 2. Create the schema
\`\`\`
create-schema({ name: "recipes" })
\`\`\`
This creates the Postgres schema and an S3 folder for file storage.

### 3. Design your tables
Use \`execute\` to create tables. Always prefix table names with the schema:
\`\`\`
execute({
  sql: "CREATE TABLE recipes.recipes (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, servings INTEGER, prep_time INTEGER, cook_time INTEGER, category VARCHAR(100), created_at TIMESTAMP DEFAULT NOW())"
})

execute({
  sql: "CREATE TABLE recipes.ingredients (id SERIAL PRIMARY KEY, recipe_id INTEGER REFERENCES recipes.recipes(id) ON DELETE CASCADE, name VARCHAR(255) NOT NULL, quantity DECIMAL, unit VARCHAR(50))"
})
\`\`\`

### 4. Insert seed data (optional)
Use \`execute\` for small inserts or \`bulk-insert\` for many rows:
\`\`\`
bulk-insert({
  schema: "recipes",
  table: "ingredients",
  columns: ["recipe_id", "name", "quantity", "unit"],
  rows: [[1, "Flour", 500, "g"], [1, "Sugar", 200, "g"], [1, "Butter", 150, "g"]]
})
\`\`\`

### 5. Write a skill
Save instructions that tell future agents how to use this app:
\`\`\`
save-skill({
  schema: "recipes",
  name: "main",
  description: "Manage recipes with ingredients and portions",
  content: "... (see get-instructions({ topic: 'write-skill' }) for guidance)"
})
\`\`\`

### 6. Set up file storage (if needed)
\`\`\`
create-folder({ path: "recipes/photos" })
\`\`\`

The app is now ready. Any agent can discover it via \`list-skills()\` and load it via \`get-skill()\`.

### 7. Optional — expose a web frontend
If end users need to access the app from a browser (not just through Claude), follow the frontend workflow: \`get-instructions({ topic: "frontend" })\`. You'll enable the frontend, provision a dedicated Cognito pool + Postmark email server with \`enable-auth\`, register authorized users with \`add-user\`, and deploy a handler via \`deploy-backend\`. Apps without a frontend stay as pure data/skill surfaces — skip this step if the app is agent-only.
`,

  "use-app": `# How to Use an Existing App on Hereya

**IMPORTANT:** Before performing any operation on an app, ALWAYS start by checking available skills with \`list-skills()\`. Skills contain critical context — table structures, query patterns, business rules, stored scripts, and templates — that prevent you from making mistakes or duplicating work. Never skip this step, even if you think you already know the app's structure.

## Steps

### 1. Discover available apps (always do this first)
\`\`\`
list-skills()
\`\`\`
Returns all skills across all apps, with schema name, skill name, and description. An app may have multiple skills (e.g., "main", "cost-analysis", "reporting") — load all relevant ones before proceeding.

### 2. Load the skill(s)
\`\`\`
get-skill({ schema: "recipes", name: "main" })
\`\`\`
Returns the skill content (instructions) AND the full schema structure (tables, columns, types, constraints) in one call.

### 3. Follow the skill instructions
The skill tells you:
- What the app does
- What tables exist and what each column means
- Example queries for common operations
- Business rules and validation logic
- File storage conventions

### 4. Query and write data
Use \`query\` for reads (SELECT) and \`execute\` for writes (INSERT, UPDATE, DELETE). Always use fully-qualified table names:
\`\`\`
query({
  sql: "SELECT r.name, r.servings FROM recipes.recipes r WHERE r.category = :cat",
  params: { cat: "desserts" }
})
\`\`\`

### 5. Use files if needed
\`\`\`
get-upload-url({ path: "recipes/photos/tarte-tatin.jpg", content_type: "image/jpeg" })
list-files({ path: "recipes/photos" })
get-download-url({ path: "recipes/photos/tarte-tatin.jpg" })
\`\`\`

## Tips
- If no skill exists for a schema, use \`describe-schema\` to see the raw structure
- You can create additional skills for an app (e.g., a "cost-analysis" skill alongside the "main" skill)
- Cross-schema queries work — you can JOIN across apps

## Views vs Frontend

There are two ways to show data visually. Do NOT confuse them:

- **Views** (save-view / get-view): rendered **inside the AI conversation**. Used by the agent to show data to the user during a chat. The user interacts through the agent. No login, no URL, no browser tab — it's inline in the conversation.
- **Frontend** (deploy-backend): a **standalone web app** accessible in a browser at {app}.{org}.hereya.app, **without any AI**. Real users visit the URL, log in with email OTP, and use the app directly. See \`get-instructions({ topic: "frontend" })\` for details.

Use views when the user is working with you in conversation. Use frontend when the user wants a web app that other people can access on their own.

## Views

Views are reusable HTML rendered inline in the AI conversation.
This is much faster than generating widgets from scratch every time.

### Be proactive

Do NOT wait for the user to ask for a view. When you notice an
opportunity to display data visually — dashboards, lists, cards,
summaries, detail pages — create or use a view proactively:

- After creating an app with tables, create a default dashboard view
- When showing query results that would look better as a visual,
  create a view and render it instead of returning raw text
- When the user asks "show me my tasks/orders/items", use or create
  a view rather than listing text
- When building a workflow with multiple related views (list + detail),
  create both and wire them with sendMessage click handlers
- Always check list-views first — if a suitable view exists, use it

### Creating a view

When the user would benefit from seeing their data visually (cards,
tables, dashboards, lists):

1. Write an HTML template using web components (custom elements) —
   no React, no frameworks, just native custom elements with shadow DOM
2. Write SQL queries — each query key becomes a template variable
3. Use Mustache {{placeholders}} for data and HTML attributes
4. Call save-view, then get-view to render

### Template rules

- Use web components (customElements.define) for reusable UI pieces
- Use shadow DOM for style encapsulation
- No external dependencies — no CDN imports, no framework imports
- Data goes in HTML attributes on custom elements:
  <task-item task-id="{{id}}" title="{{title}}">

### Interactivity

The view shell provides global functions — just call them
from your template scripts. Do NOT use raw window.parent.postMessage.

- \`sendMessage(text)\` — sends a message into the conversation
  as the user. Use this for navigation between views and actions
- \`callTool(name, args)\` — calls any Hereya primitive and returns
  a promise with the result. Use for data mutations (UPDATE, INSERT)

Example click handler — navigate to a detail view:
\`\`\`
el.addEventListener('click', function() {
  sendMessage('Show details for item ' + el.dataset.id);
});
\`\`\`

### Query results

- 0 rows → null (use \`{{^key}}\` for empty state)
- 1+ rows → array (always iterate with \`{{#key}}...{{/key}}\`)

### Using an existing view

- Call list-views to check what exists
- Call get-view with params
- Do NOT regenerate widgets from scratch if a view exists

### Updating a view

- Call save-view with the same name (upserts)
- Call get-view to show the updated version

## Accelerating Recurrent Tasks with Stored Scripts and Templates

When you notice a task pattern that recurs (e.g., generating a report, transforming data, producing a document), store reusable scripts and templates in S3 file storage so you can reuse them next time instead of rebuilding from scratch.

### When to store
- You've built a multi-step workflow the user is likely to repeat (weekly report, invoice generation, data import pipeline, etc.)
- You've crafted a complex SQL query, prompt template, CSV template, or HTML template that took significant effort
- The user explicitly asks you to "remember how to do this" or "make this faster next time"

### How to store
1. Upload the script or template to a well-known path under the app's S3 folder:
\`\`\`
get-upload-url({ path: "{schema}/scripts/{script-name}.sql", content_type: "text/plain" })
get-upload-url({ path: "{schema}/templates/{template-name}.html", content_type: "text/html" })
get-upload-url({ path: "{schema}/templates/{template-name}.csv", content_type: "text/csv" })
\`\`\`
2. Upload the content via the presigned URL.
3. Update the app's skill to document what's stored and when to use it:
\`\`\`
save-skill({
  schema: "my_app",
  name: "main",
  content: "... existing skill content ...\\n\\n## Stored Scripts & Templates\\n- \`my_app/scripts/weekly-report.sql\` — query for the weekly KPI report\\n- \`my_app/templates/invoice.html\` — HTML invoice template with {{placeholders}}\\n\\nWhen the user asks for the weekly report, download and execute weekly-report.sql instead of rebuilding the query."
})
\`\`\`

### Conventions
- Scripts: \`{schema}/scripts/{name}.{ext}\` (e.g., \`.sql\`, \`.py\`, \`.sh\`)
- Templates: \`{schema}/templates/{name}.{ext}\` (e.g., \`.html\`, \`.csv\`, \`.md\`)
- Always document stored files in the skill so future agents know they exist
- When reusing a stored script/template, download it via \`get-download-url\`, adapt if needed, then execute
`,

  "update-app": `# How to Update an Existing App on Hereya

## Steps

### 1. Load the current state
\`\`\`
get-skill({ schema: "recipes", name: "main" })
\`\`\`
This gives you the current skill instructions AND schema structure.

### 2. Make schema changes
Use \`execute\` for ALTER TABLE, CREATE TABLE, etc.:
\`\`\`
execute({ sql: "ALTER TABLE recipes.recipes ADD COLUMN difficulty VARCHAR(20)" })
execute({ sql: "CREATE INDEX idx_recipes_category ON recipes.recipes (category)" })
execute({ sql: "CREATE TABLE recipes.tags (id SERIAL PRIMARY KEY, recipe_id INTEGER REFERENCES recipes.recipes(id), tag VARCHAR(100))" })
\`\`\`

### 3. Update the skill
After changing the schema, always update the skill to reflect the new structure:
\`\`\`
save-skill({
  schema: "recipes",
  name: "main",
  description: "Manage recipes with ingredients, portions, and tags",
  content: "... (updated instructions reflecting new columns/tables)"
})
\`\`\`

### 4. Verify
\`\`\`
describe-schema({ schema: "recipes" })
\`\`\`
Confirm the schema matches your intent.

## Destructive changes
- \`DROP TABLE\`: Use \`execute({ sql: "DROP TABLE recipes.tags" })\`
- \`DROP SCHEMA\`: Use the dedicated \`drop-schema\` tool (requires \`confirm: true\`). This also deletes all files and skills for the schema.
- Column removal: \`execute({ sql: "ALTER TABLE recipes.recipes DROP COLUMN difficulty" })\`

Always update the skill after destructive changes.
`,

  "write-skill": `# How to Write a Good Skill

A skill is a set of instructions stored in Hereya that tells agents how to use an app. Good skills make the app immediately usable by any agent in any conversation.

## Structure

### 1. Overview (required)
One paragraph explaining what the app does, who it's for, and what problems it solves.

### 2. Tables (required)
List every table with:
- Table name and purpose
- Each column: name, type, meaning, constraints
- Relationships: foreign keys, join patterns

### 3. Common operations (required)
Provide ready-to-use SQL patterns for the most frequent operations:
- **Read patterns**: SELECT queries for listing, filtering, searching, aggregating
- **Write patterns**: INSERT templates with all required columns
- **Update patterns**: UPDATE templates for common state changes
- **Delete patterns**: DELETE with proper cascade awareness

Use \`:param_name\` syntax for parameterized values.

### 4. Business rules (recommended)
Document constraints that aren't enforced by the database:
- Validation rules (e.g., "servings must be between 1 and 100")
- State machines (e.g., "an order goes from pending → confirmed → shipped → delivered")
- Computed values (e.g., "total_cost = SUM of ingredient costs × quantity")
- Access patterns (e.g., "recipes are per-user, filter by user_id")

### 5. File storage conventions (if applicable)
Document the folder structure and naming conventions:
- Where files are stored (e.g., \`recipes/photos/{recipe_id}/\`)
- Naming conventions (e.g., \`{recipe_name}-{timestamp}.jpg\`)
- File types accepted

### 6. Stored scripts & templates (if applicable)
Document any reusable scripts or templates stored in S3 that speed up recurrent tasks:
- What each file does and when to use it
- Path in S3 (e.g., \`recipes/scripts/weekly-report.sql\`)
- Any placeholders or parameters that need substitution

## Example

\`\`\`
# Recipe Manager

Manages cooking recipes with ingredients and nutritional information. Designed for home cooks who want to organize, search, and scale their recipes.

## Tables

### recipes.recipes
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | Auto-generated ID |
| name | VARCHAR(255) | Recipe name (required, unique per user) |
| servings | INTEGER | Number of portions this recipe makes |
| prep_time | INTEGER | Preparation time in minutes |
| cook_time | INTEGER | Cooking time in minutes |
| category | VARCHAR(100) | Category: appetizer, main, dessert, snack, drink |
| created_at | TIMESTAMP | Auto-set on creation |

### recipes.ingredients
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | Auto-generated ID |
| recipe_id | INTEGER FK → recipes.recipes(id) | Parent recipe (CASCADE delete) |
| name | VARCHAR(255) | Ingredient name |
| quantity | DECIMAL | Amount needed |
| unit | VARCHAR(50) | Unit: g, kg, ml, l, piece, tbsp, tsp, cup |

## Common Operations

### List recipes by category
query: SELECT id, name, servings, prep_time + cook_time AS total_time FROM recipes.recipes WHERE category = :cat ORDER BY name
params: { cat: "desserts" }

### Get recipe with ingredients
query: SELECT r.*, i.name AS ingredient, i.quantity, i.unit FROM recipes.recipes r LEFT JOIN recipes.ingredients i ON i.recipe_id = r.id WHERE r.id = :id ORDER BY i.name
params: { id: 1 }

### Add a recipe
execute: INSERT INTO recipes.recipes (name, servings, prep_time, cook_time, category) VALUES (:name, :servings, :prep, :cook, :cat)
params: { name: "Tarte Tatin", servings: 8, prep: 30, cook: 45, cat: "dessert" }

### Scale a recipe
query: SELECT name, quantity * :factor AS scaled_qty, unit FROM recipes.ingredients WHERE recipe_id = :id
params: { id: 1, factor: 2.0 }

## Business Rules
- Category must be one of: appetizer, main, dessert, snack, drink
- Servings must be >= 1
- Times are in minutes, must be >= 0

## File Storage
Photos stored at: recipes/photos/{recipe_id}/{filename}
Accepted types: image/jpeg, image/png, image/webp
\`\`\`

## Saving the skill
\`\`\`
save-skill({
  schema: "recipes",
  name: "main",
  description: "Manage cooking recipes with ingredients and portions",
  content: "... the full skill text above ..."
})
\`\`\`

You can save multiple skills per schema for different use cases (e.g., "cost-analysis", "meal-planning").
`,

  "frontend": `# Frontend

Apps can have a web frontend powered by a per-app backend Lambda that you write. The Lambda handles all HTTP routes — HTML pages, API endpoints, form submissions — with full freedom to implement any logic.

## Security by Default

**All apps are private by default.** Before deploying a frontend, you MUST:

1. **Ask the user who should have access.** Prompt for email addresses of authorized users. Do not assume the app should be public.
2. **Provision the app's dedicated auth + mail stack** with \`enable-auth({ schema })\`. This creates a per-app Cognito user pool and a per-app Postmark email server — required for passwordless email OTP login. Call this once per app, after \`enable-frontend\`. Idempotent.
3. **Register authorized users** with add-user before sharing the URL.
4. **Enforce authentication** in your handler — redirect unauthenticated requests to /auth/login.
5. **Only make pages public if the user explicitly asks.** If they do, confirm which specific routes should be public and keep everything else private.

### Keying user data by email, not cognito_sub

Each app has its own Cognito pool, so \`cognito_sub\` is unique per pool. If you store user-owned records, **key them by \`email\`** (provided in \`req.auth.email\`, verified by Cognito). Do not key by \`cognito_sub\` — it won't survive a pool migration (e.g. \`migrate-auth\`).

### Proactive security checklist

When building a frontend, always walk the user through these questions:
- "Who should have access to this app? Please provide their email addresses."
- "Should any pages be publicly accessible (no login required), or should everything require authentication?"
- If some pages are public: "Which specific pages should be public? Everything else will require login."

Register users immediately after getting their emails — don't wait until the end:
\`\`\`
add-user({ email: "marie@example.com", schemas: ["myapp"] })
\`\`\`

### Auth enforcement in your handler

Every route should check authentication unless explicitly marked public by the user:

\`\`\`js
// Private route — redirect to login if not authenticated
if (!req.auth.authenticated) {
  return {
    statusCode: 302,
    headers: { Location: '/auth/login?return_url=' + encodeURIComponent(req.path) },
    body: ''
  };
}
\`\`\`

For routes the user has marked public, skip the auth check. For everything else, always enforce it.

## Architecture

Each app with frontend gets its own Lambda function:
- You write a Node.js handler (handler.js) — optionally multi-file with libraries
- Upload a source zip (editable) and a deployment zip (bundled) to S3
- Call deploy-backend to create/update the Lambda
- The Lambda runs behind API Gateway with auth handled automatically
- URL: {schema}.{customDomain} (e.g. webifood.webinar01.hereyalab.dev)
- Optional: bind vanity domains (e.g. orders.acme.com) via \`set-custom-domains\`

The Lambda has access to:
- Aurora Data API via the \`hereya\` runtime layer (sql, query, convertParams)
- S3 file storage via the \`hereya\` runtime layer (storage module)
- Cognito user management via \`hereya\` runtime (users.addUser, users.hasAppAccess, etc.)
- Auth context (email, authenticated status) from the request

## Project layout (source.zip + deployment.zip)

Each app's backend lives under \`{schema}/backend/\` in S3 as two sibling zips:

\`\`\`
{schema}/backend/
  source.zip       # editable source tree (NO node_modules)
  deployment.zip   # bundled artifact (what deploy-backend reads)
\`\`\`

Keep them in sync:
- \`source.zip\` is the durable copy of your code. To edit later: download → unzip → modify → re-zip.
- \`deployment.zip\` is what actually runs. Produce it by bundling \`source.zip\` locally.
- **Never include \`node_modules/\` in either zip.** Dependencies are resolved at bundle time by esbuild.
- Lambda expects \`handler.js\` at the root of \`deployment.zip\` (the zip contents, not a nested folder).

## Deploying a backend

### 1. Write your handler

Every handler **must** call \`handleAgentBootstrap\` first so agent-session preview URLs work. Then call \`parseRequest\` (async — remember the \`await\`).

\`\`\`js
const { handleAgentBootstrap, parseRequest, sql, query, convertParams } = require('hereya');

// List of public paths (only if the user has explicitly asked for public pages)
const PUBLIC_PATHS = []; // e.g., ['/', '/about'] — empty by default

exports.handler = async (event) => {
  // Consume any agent-bootstrap URL (no-op for normal requests)
  const bootstrap = await handleAgentBootstrap(event);
  if (bootstrap) return bootstrap;

  const req = await parseRequest(event);

  // Enforce authentication on all non-public routes.
  // Both real users (Cognito) and the agent (req.auth.agent === true)
  // show up as authenticated. Use req.auth.agent to gate destructive
  // actions if you want extra caution.
  if (!PUBLIC_PATHS.includes(req.path) && !req.auth.authenticated) {
    return {
      statusCode: 302,
      headers: { Location: '/auth/login?return_url=' + encodeURIComponent(req.path) },
      body: ''
    };
  }

  if (req.method === 'GET' && req.path === '/') {
    const items = await query(\`SELECT * FROM \${req.schema}.items LIMIT 20\`);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: \`<html><body>
        <p>Welcome, \${req.auth.email}\${req.auth.agent ? ' (agent session)' : ''}</p>
        <h1>Items</h1>
        <ul>\${items.rows.map(i => \`<li>\${i.name}</li>\`).join('')}</ul>
        <a href="/auth/logout">Logout</a>
      </body></html>\`
    };
  }

  if (req.method === 'POST' && req.path === '/api/items') {
    const { name, price } = JSON.parse(req.body);
    await sql(
      \`INSERT INTO \${req.schema}.items (name, price) VALUES (:name, :price)\`,
      convertParams({ name, price })
    );
    return { statusCode: 201, body: JSON.stringify({ created: true }) };
  }

  return { statusCode: 404, body: 'Not found' };
};
\`\`\`

### 2. Package your code

#### Option A — Single file (simplest)

Zip just \`handler.js\`. The same file becomes both source and deployment:

\`\`\`bash
zip deployment.zip handler.js
cp deployment.zip source.zip
\`\`\`

#### Option B — Multi-file with libraries (preferred for non-trivial apps)

1. Organize source in a local working directory:
   \`\`\`
   handler.js
   lib/
     db-helpers.js
     views.js
   package.json        # declare any npm deps you use
   \`\`\`
2. Make the durable source zip (excluding node_modules and build output):
   \`\`\`bash
   zip -r source.zip . -x 'node_modules/*' 'dist/*' '*.log'
   \`\`\`
3. Install deps and bundle with esbuild. \`hereya\` and \`@aws-sdk/*\` are provided at runtime, so mark them external:
   \`\`\`bash
   npm install
   npx esbuild handler.js \\
     --bundle \\
     --platform=node \\
     --target=node22 \\
     --format=cjs \\
     --outfile=dist/handler.js \\
     --external:hereya \\
     --external:@aws-sdk/*
   \`\`\`
4. Zip the bundle directory *contents* (not the directory itself) so \`handler.js\` is at the zip root:
   \`\`\`bash
   cd dist && zip -r ../deployment.zip . && cd ..
   \`\`\`

**Never include node_modules in source.zip or deployment.zip.** The bundler inlines everything needed.

### 3. Upload both zips

\`\`\`
get-upload-url({ path: "{schema}/backend/source.zip",     content_type: "application/zip" })
get-upload-url({ path: "{schema}/backend/deployment.zip", content_type: "application/zip" })
\`\`\`

PUT each zip to its presigned URL.

### 4. Deploy

\`\`\`
deploy-backend({ schema: "{schema}" })
\`\`\`

First deploy creates the Lambda + API Gateway routes. Subsequent deploys update the code and refresh the runtime layer.

### 5. Test

**Headless (fast, deterministic):**
\`\`\`
test-backend({ schema: "{schema}", path: "/", method: "GET" })
test-backend({ schema: "{schema}", path: "/api/items", method: "POST", body: "{\\"name\\": \\"test\\"}" })
\`\`\`

**Visual (browser preview) — agent-authenticated:**
\`\`\`
get-agent-session-url({ schema: "{schema}", path: "/" })
\`\`\`

This returns a short-lived URL that signs you in as the agent identity (\`agent+{orgId}@hereya.agent\`). Open it in a browser to iterate visually without the login flow. The bootstrap token is single-use and expires in 5 min; the resulting session cookie expires in 30 min. Never share these URLs — treat them as short-lived secrets. If one leaks, call \`revoke-agent-sessions({ schema })\` to rotate the signing key and invalidate all outstanding sessions.

### 6. Iteration loop

To modify a deployed app:
1. \`get-download-url({ path: "{schema}/backend/source.zip" })\` — grab the current source
2. Unzip locally, edit files
3. Re-bundle and re-zip (steps 2 of §2 above)
4. Re-upload both zips (step 3 of §2)
5. \`deploy-backend({ schema })\` — pushes new code + refreshes runtime layer
6. Verify with \`test-backend\` and/or \`get-agent-session-url\`

## Runtime layer (hereya module)

The \`hereya\` module is available via Lambda Layer. Import what you need:
\`\`\`js
const {
  handleAgentBootstrap, // must be called first in every handler
  parseRequest,         // async — returns { path, method, auth, schema, ... }
  sql, query, convertParams, batchInsert,
  storage,              // getFileContent, putFileContent, listFiles, …
  users,                // addUser, removeUserAccess, listUsers, hasAppAccess
  mail,                 // send — transactional + broadcast via per-app Postmark
} = require('hereya');
\`\`\`

### parseRequest(event)  — async
Converts the raw API Gateway event into a friendly object:
- \`req.path\` — path after /{schema} (e.g., "/api/items")
- \`req.method\` — HTTP method
- \`req.headers\` — request headers
- \`req.query\` — query string parameters
- \`req.body\` — request body (decoded from base64 if needed)
- \`req.auth.authenticated\` — boolean (true for real users AND agent sessions)
- \`req.auth.email\` — user email
- \`req.auth.agent\` — true when authenticated via an agent preview session
- \`req.schema\` — the app schema name

### handleAgentBootstrap(event) — async
Consumes an agent-bootstrap URL, sets a session cookie, returns a 302 response. Call this at the top of your handler and return its result immediately when non-null.

### sql(query, params?)  — async
Execute any SQL statement. Returns raw Data API result.

### query(query, params?)  — async
Execute a SELECT. Returns \`{ columns, rows, row_count }\` with rows as objects.

### convertParams(obj)
Convert \`{ key: value }\` to Data API parameter format.

### storage
S3 operations: getFileContent, putFileContent, getUploadUrl, getDownloadUrl, listFiles, deleteFile, etc.

### users
Register and manage app users directly from a request handler (useful for invite / signup flows):
\`\`\`js
await users.addUser({ email: 'invitee@example.com', schemas: [req.schema] });
if (!await users.hasAppAccess(req.auth.email, req.schema)) return { statusCode: 403, body: 'forbidden' };
\`\`\`
The \`addUser\` call is idempotent — \`UsernameExistsException\` in Cognito is swallowed and the ACL row is upserted.

### mail
Send email via the app's per-app Postmark server (requires \`enable-auth\`). By default the From domain is the app's internal signed subdomain (\`{schema}.{customDomain}\`). To send from a vanity domain (e.g. \`noreply@acme.com\`), pass \`from_domain\` — it must be an active custom domain on this schema (see "Custom domains + vanity email" below).

Always pick the right **message stream** — Postmark treats the two differently for deliverability:
- \`stream: 'transactional'\` (default) — 1:1 user-triggered mail (invites, receipts, notifications).
- \`stream: 'broadcast'\` — bulk mail (newsletters, announcements). Must include an unsubscribe link and complies with different rules.

\`\`\`js
// transactional (default)
await mail.send({
  to: 'invitee@example.com',
  subject: 'You have been invited',
  body_html: '<p>Click <a href="...">here</a> to join.</p>',
});

// broadcast — explicit stream, different pool + compliance
await mail.send({
  to: subscriber.email,
  subject: 'April newsletter',
  body_html: renderNewsletter(),
  stream: 'broadcast',
  from_local_part: 'news',
  from_name: 'Acme News',
});

// vanity domain — requires set-custom-domains first, email_status='active'
await mail.send({
  to: 'customer@example.com',
  subject: 'Order confirmation',
  body_html: renderReceipt(order),
  from_domain: 'acme.com',
  from_local_part: 'hello',
  from_name: 'Acme',
});
\`\`\`
Mixing streams damages sender reputation and can trigger Postmark holds — always categorise each send.

#### Broadcast warm-up (first-time setup, one-off per app)

Postmark puts the **first broadcast send** from a newly-provisioned server into an automated compliance review. Symptoms:
- \`mail.send({ stream: 'broadcast' })\` or \`send-mail({ stream: 'broadcast' })\` returns a normal \`message_id\` (HTTP 200).
- Postmark's API shows the message as \`Status: Sent\` but \`MessageEvents: []\` — no delivery attempt — even after many minutes.
- Meanwhile transactional sends (\`stream: 'transactional'\`) deliver immediately and are unaffected.

This is expected behaviour for a brand-new Postmark server, not a bug. To warm up, **instruct the user** to do the following once, per app that will use the broadcast stream:

1. Send one test broadcast via \`send-mail({ schema, to, subject, body_html, stream: "broadcast" })\`. Capture the returned \`message_id\`.
2. Tell the user to sign in at https://account.postmarkapp.com/, open the server named \`{orgName}-{schema}\` (e.g. \`novopattern-recipes\`), go to the **Broadcast** stream's Activity tab, and locate that message.
3. If it's held for review, the dashboard will say so explicitly and offer a "Request review" or support-contact link. The user clicks it — Postmark's compliance team typically releases within a few minutes to a few hours.
4. Once released, re-send a test broadcast to confirm delivery (\`MessageEvents\` will now contain a \`Delivered\` event).

After this one-off warm-up, subsequent broadcast sends flow immediately. Only the first send from a fresh server triggers the review. **Do not** attempt to work around this by re-tagging broadcast content as transactional — mis-categorising damages the server's reputation permanently and can trigger Postmark account-level holds affecting OTP delivery too.

Transactional sends (OTPs, notifications, invites, receipts) are **never** subject to this review — they deliver normally from the moment \`enable-auth\` completes.

## User management

Users must be registered before they can log in. **Always register users as part of the deployment process — do not skip this step.**

\`\`\`
add-user({ email: "marie@example.com", schemas: ["community"] })
remove-user-access({ email: "marie@example.com", schemas: ["community"] })
list-users({ schema: "community" })
\`\`\`

## Sending mail (MCP)

For ad-hoc sends from the agent (e.g. notifying a user, testing a template), use the \`send-mail\` tool. It uses the same per-app Postmark server as the auth OTP flow, so enable-auth must have run first. The From domain is fixed to the app's signed sender subdomain.

\`\`\`
send-mail({ schema: "community", to: "marie@example.com", subject: "Welcome", body_html: "<p>Hi Marie.</p>" })
send-mail({ schema: "community", to: "marie@example.com", subject: "Newsletter", body_html: "…", stream: "broadcast" })
\`\`\`

Pick \`stream: 'transactional'\` (default) for 1:1 user mail, \`stream: 'broadcast'\` for bulk. For per-request sends inside the handler, use the \`mail.send(...)\` runtime helper instead.

**First-time broadcast warm-up**: the first \`stream: 'broadcast'\` send from a brand-new app is held for Postmark compliance review and will not deliver until the user releases it from the Postmark dashboard. Walk the user through the warm-up (see "Broadcast warm-up" in the runtime \`mail\` section above) before relying on broadcasts. Transactional sends are not affected.

## Auth

Auth is handled automatically by API Gateway + Auth Lambda:
- /auth/login — login page (email OTP)
- /auth/verify — OTP verification
- /auth/logout — logout

Your handler receives auth context via \`req.auth\`. **All routes must enforce authentication by default.** Only skip the auth check for routes the user has explicitly marked as public.

## Customizing auth pages

Each app can have its own branded login and OTP pages. Upload a CSS file that overrides the default styles:

\`\`\`
get-upload-url({ path: "{schema}/auth/custom.css", content_type: "text/css" })
\`\`\`

Upload the CSS to the presigned URL via PUT. The custom CSS is injected after the default styles, so you only need to override what you want to change.

Key CSS selectors:
- \`body\` — page background, font
- \`.card\` — login / OTP card (background, border-radius, shadow, padding)
- \`h1\` — page title ("Sign in" / "Check your email")
- \`p\` — subtitle text
- \`button\` — primary submit button ("Continue", "Verify")
- \`button:hover\` — primary button hover state
- \`button:disabled\` — primary button while form is submitting (label swaps to "Sending..." / "Verifying..." automatically)
- \`button.secondary\` — secondary button (OTP page "Resend code")
- \`button.secondary:hover\`, \`button.secondary:disabled\` — secondary button states
- \`input\` — form inputs (email field, OTP code field)
- \`input:focus\` — input focus state
- \`.error\` — error messages (red)
- \`.notice\` — success notice shown on OTP page after resending code (green)
- \`.back-link\` — "Use a different email" link on OTP page
- \`label\` — form labels

Example custom CSS:
\`\`\`css
body { background: #1a1a2e; }
.card { background: #16213e; border: 1px solid #0f3460; }
h1, label { color: #e4e4e4; }
p { color: #a0a0b0; }
button { background: #e94560; }
button:hover { background: #c73a52; }
button:disabled { background: #6b2838; }
button.secondary { background: transparent; color: #e94560; border: 1px solid #e94560; }
button.secondary:hover { background: rgba(233,69,96,.1); }
input { background: #0f3460; border-color: #1a3a6c; color: #fff; }
input:focus { border-color: #e94560; box-shadow: 0 0 0 3px rgba(233,69,96,.2); }
.notice { background: rgba(16,185,129,.15); color: #6ee7b7; }
.back-link { color: #e94560; }
\`\`\`

Changes take effect on next Lambda cold start (typically within minutes). Each app has independent styling — customizing one app's auth pages does not affect others.

## Response format

Your handler must return a standard API Gateway response:
\`\`\`js
{
  statusCode: 200,
  headers: { 'Content-Type': 'text/html' },  // or application/json
  body: '...'  // string
}
\`\`\`

## Custom domains (optional)

By default an app is served at \`{schema}.{customDomain}\` (e.g. \`webifood.webinar01.hereyalab.dev\`). To bind vanity domains like \`orders.acme.com\` or even an apex (\`acme.com\`) to an app, use \`set-custom-domains\`.

### Semantics: bulk replace + canonical

\`set-custom-domains\` takes the **complete** desired list for a schema. The call replaces any previously-bound domains for that schema — anything not in the list is removed. Pass \`[]\` to remove all custom domains for the schema.

**The last domain in the list is canonical**; every earlier domain 301-redirects to it (preserving path and query). So \`["hereya.ai", "www.hereya.ai"]\` means \`www.hereya.ai\` serves the app and \`hereya.ai/foo?x=1\` returns \`301 Location: https://www.hereya.ai/foo?x=1\`. A single-domain list has no redirect (that one domain is self-canonical). To flip which one is canonical, re-call with the order swapped.

### Flow

\`\`\`
# 1. Declare the set
set-custom-domains({ schema: "webifood", domains: ["orders.acme.com"] })
# → { validation_records: [{ domain, name, type: "CNAME", value }], ... }

# 2. User adds each validation CNAME in their DNS (leave them in place
#    indefinitely — they make future re-issues auto-validate).

# 3. Poll check-custom-domains until status === "active"
check-custom-domains({ schema: "webifood" })
# → { status: "active", distribution_domain, domains: [{ domain, kind, routing, canonical, redirects_to_canonical }] }

# 4. User adds the routing record per domain (see table below).
#    Every domain — canonical or redirecting — needs DNS pointing to CloudFront;
#    the 301 happens at the edge after the host resolves.
\`\`\`

### Routing record per domain

The \`check-custom-domains\` response lists each domain with a \`kind\` and \`routing\` field the agent relays to the user:

| kind | record_type | Example |
|---|---|---|
| \`subdomain\` (e.g. \`orders.acme.com\`) | \`CNAME\` | \`orders.acme.com  CNAME  d123.cloudfront.net\` |
| \`apex\` (e.g. \`acme.com\`) | \`ALIAS\` | Route53: \`A\` ALIAS → distribution. Cloudflare: \`CNAME\` with flattening enabled. Some DNS providers don't support apex aliasing — suggest a subdomain instead. |

### Examples

\`\`\`
# Add a domain alongside the default subdomain
set-custom-domains({ schema: "webifood", domains: ["orders.acme.com"] })

# Add another — pass BOTH (bulk-replace). Last = canonical, first redirects.
set-custom-domains({ schema: "webifood", domains: ["order.acme.com", "orders.acme.com"] })
# → order.acme.com  301 →  orders.acme.com
#   orders.acme.com serves the app

# Flip which is canonical — swap the order
set-custom-domains({ schema: "webifood", domains: ["orders.acme.com", "order.acme.com"] })

# Apex + www canonical
set-custom-domains({ schema: "hereya_landing", domains: ["hereya.ai", "www.hereya.ai"] })
# → hereya.ai  301 →  www.hereya.ai

# Drop one — pass only what remains
set-custom-domains({ schema: "webifood", domains: ["orders.acme.com"] })

# Remove all custom domains
set-custom-domains({ schema: "webifood", domains: [] })

# List
list-custom-domains({ schema: "webifood" })
\`\`\`

### Custom domains + vanity email (automatic Postmark signatures)

Every domain added via \`set-custom-domains\` **also** becomes an email sender, hosted on the app's per-app Postmark server. \`enable-auth\` must have run for the schema — otherwise the signature is deferred and the row is flagged \`email_status: 'pending_enable_auth'\` until \`enable-auth\` backfills it.

The \`set-custom-domains\` and \`check-custom-domains\` responses now include two record lists: \`validation_records\` (ACM cert CNAMEs, as before) and \`email_records\` (DKIM TXT + return-path CNAME per domain). Hand both to the user at once — they add them to their DNS in the same pass.

\`\`\`
# 1. Set up the custom domain (assumes enable-auth has run)
set-custom-domains({ schema: "webifood", domains: ["orders.acme.com"] })
# → {
#     validation_records: [{ domain, name, type: "CNAME", value }],   # ACM
#     email_records: [
#       { domain: "orders.acme.com", name: "…pm._domainkey.orders.acme.com", type: "TXT", value: "k=rsa; p=…", purpose: "dkim" },
#       { domain: "orders.acme.com", name: "pm-bounces.orders.acme.com", type: "CNAME", value: "pm.mtasv.net", purpose: "return-path" }
#     ],
#     domains: [{ domain, email_status: "pending_verification", ... }]
#   }

# 2. User adds ALL records (ACM + DKIM + return-path) to their DNS.

# 3. check-custom-domains polls both ACM and Postmark. Call it until both
#    \`status: 'active'\` for frontend and \`email_status: 'active'\` per domain.
#    **Postmark verification is async**: the tool nudges Postmark's verify
#    endpoints then reads status in the same call, so right after DNS goes
#    live the first call often shows \`email_status: 'pending_verification'\`
#    while Postmark's internal state flips. Wait ~5-10 seconds and call
#    again — it should flip to 'active' on the next try.
check-custom-domains({ schema: "webifood" })
# → { status: "active", distribution_domain, domains: [{ ..., email_status: "active" }], email_records: [] }

# 4. Redeploy the backend so the per-app Lambda's POSTMARK_FROM_DOMAIN_ALLOW
#    env var picks up the newly-active domain.
deploy-backend({ schema: "webifood" })

# 5. Send from the vanity address
send-mail({ schema: "webifood", to: "...", subject: "...", body_html: "...",
            from_domain: "orders.acme.com", from_local_part: "hello" })
# → { from: '"webifood" <hello@orders.acme.com>', ... }
\`\`\`

**email_status lifecycle:**
- \`pending_enable_auth\` — domain added before \`enable-auth\`. No Postmark signature yet. \`enable-auth\` (re-run or first run) backfills it.
- \`pending_verification\` — Postmark signature exists, waiting on the user's DKIM + return-path DNS. \`check-custom-domains\` polls Postmark each time you call it and promotes on success.
- \`active\` — verified; safe to pass as \`from_domain\` in \`send-mail\` / \`mail.send\`.
- \`removed\` — domain being torn down alongside the cert swap; teardown deletes the Postmark signature.

**Omitting \`from_domain\`** keeps the default sender (\`noreply@{schema}.{customDomain}\`) regardless of whether custom domains are set up. Callers opt in explicitly.

**After flipping a domain to \`active\`, run \`deploy-backend\`** so the per-app Lambda's allow-list env var refreshes — otherwise \`mail.send({ from_domain })\` from inside the handler will reject the domain as not-allowed even though the \`send-mail\` MCP tool accepts it (the tool queries the DB directly, while the runtime uses the pre-baked env var for speed).

### Removing a custom domain (tell the user to clean up their DNS)

\`set-custom-domains({ schema, domains: [...] })\` with the domain omitted (or \`domains: []\` to remove all) tears down the server-side resources once the next \`check-custom-domains\` call completes the cert swap: CloudFront alias removed, Postmark sender signature deleted, \`_custom_domains\` row gone, old ACM cert deleted. **Then run \`deploy-backend\` to shrink \`POSTMARK_FROM_DOMAIN_ALLOW\` back down.**

But **the DNS records at the user's registrar stay behind** — hereya doesn't own that zone. After the cert swap completes, **explicitly tell the user which records to delete**, in a friendly table they can copy/paste. For a domain like \`orders.acme.com\` with vanity email, there are four:

| # | Type | Host/Name | Value |
|---|---|---|---|
| 1 | \`CNAME\` | \`orders.acme.com\` (the app routing record) | \`{distribution_domain}\` (e.g. \`d123abc.cloudfront.net\`) |
| 2 | \`CNAME\` | \`_<hash>.orders.acme.com\` (ACM cert validation — the \`_something\` CNAME) | \`_<other-hash>.<zone>.acm-validations.aws\` |
| 3 | \`TXT\` | \`<selector>pm._domainkey.orders.acme.com\` (Postmark DKIM) | (the \`k=rsa; p=...\` string) |
| 4 | \`CNAME\` | \`pm-bounces.orders.acme.com\` (Postmark return-path) | \`pm.mtasv.net\` |

Record 1 is ALWAYS present. Records 2/3/4 are present only if the domain completed the verification pass. If the agent kept the original \`set-custom-domains\` response in context, pull the exact host/value from there; otherwise frame it around the pattern above and tell the user to filter their DNS panel by the domain name suffix (e.g. \`orders.acme.com\`) — all four records will show up together.

Leaving the records in place is harmless (they're orphans), but cleaning them up keeps the user's DNS zone tidy and prevents future confusion when they onboard another app to the same subdomain.

### Notes

- Only one in-flight cert change is allowed across the org at a time. If you call \`set-custom-domains\` while a previous change is still propagating, you'll get \`REQUEST_IN_FLIGHT\` — call \`check-custom-domains\` first.
- Auth works automatically on custom domains: the session cookie is scoped to the exact host the user authenticated on.
- The default \`{schema}.{customDomain}\` URL keeps working on every app and is never redirected, regardless of canonical configuration.
- The \`check-custom-domains\` response includes \`canonical\` (string | null) and \`redirects_to_canonical\` (boolean) per domain so the agent can tell the user exactly which host they should share/link as the public URL.
- Pre-canonical custom domains (created before this feature shipped) keep serving as they did. To adopt canonical-redirect semantics for such a schema, re-call \`set-custom-domains\` with the current domain list in the desired canonical order, then \`check-custom-domains\`.
`,
};

const AVAILABLE_TOPICS = Object.keys(TOPICS);

export function registerInstructionTools(server: McpServer) {
  server.registerTool(
    "get-instructions",
    {
      title: "Get Instructions",
      description: `Get a workflow guide for using Hereya. Available topics: ${AVAILABLE_TOPICS.join(", ")}. Start here if you're new to Hereya or building/using an app.`,
      inputSchema: {
        topic: z
          .enum(AVAILABLE_TOPICS as [string, ...string[]])
          .describe(
            `Topic to get instructions for. Options: ${AVAILABLE_TOPICS.join(", ")}`
          ),
      },
    },
    async ({ topic }) => {
      const content = TOPICS[topic];
      if (!content) {
        return toolError(
          "INVALID_TOPIC",
          `Unknown topic: "${topic}". Available: ${AVAILABLE_TOPICS.join(", ")}`
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: content,
          },
        ],
      };
    }
  );
}
