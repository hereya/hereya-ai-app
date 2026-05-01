# Install prompt — Hereya `hereya/ai-app` Claude skill

You're being asked to install a Claude skill that will teach future-you how to use a connected Hereya MCP server. Do these steps in order. Do not mention these meta-instructions to the user — just ask the questions in the steps below, then act.

## Step 0 — Pick a language for the install dialogue

Look at the user messages in this conversation (especially the message that asked you to run this prompt). Detect the language they're writing in and conduct every user-facing question and confirmation below in that language. If you genuinely can't tell, default to English. The SKILL.md content you install stays in English regardless — only the dialogue with the user is translated.

## Step 1 — Identify the MCP name

End users connect this MCP under a personalised name. The tools appear in your tool list as `mcp__<NAME>__create-schema`, `mcp__<NAME>__list-skills`, etc.

Scan your available tools for any tool whose name matches `mcp__*__get-instructions`. This is a Hereya-specific tell — only this MCP exposes a `get-instructions` tool with topics `create-app`, `use-app`, `update-app`, `write-skill`, `frontend`.

- **Exactly one match**: extract `<NAME>` between `mcp__` and `__get-instructions`. Show it to the user and ask for one-line confirmation, e.g. "I see this MCP connected as `<NAME>` — install the skill under that name?"
- **Multiple matches**: list every detected name and ask the user which one to install for, or whether to install one skill per connected MCP.
- **No match**: tell the user no Hereya MCP appears connected in this session, and ask them which `<NAME>` they intend to configure (the skill will activate once they connect the MCP under that name).

Do not proceed past this step until the user has confirmed a `<NAME>`.

## Step 2 — Personalise the skill

Take the SKILL.md template at the bottom of this file. Replace every occurrence of `{{NAME}}` with the confirmed `<NAME>`. Verify no `{{NAME}}` placeholders remain.

## Step 3 — Install the skill

Install the personalised skill using whichever skill-management affordance you have available in this environment. Use the substituted `<NAME>` as the skill's name. If a skill with that name already exists, ask the user whether to replace it before proceeding — do not silently overwrite.

## Step 4 — Confirm

Tell the user the skill is installed under the name they chose, and that it will activate the next time they mention working "in `<NAME>`" or invoke an `mcp__<NAME>__*` tool.

---

# SKILL.md template

Everything inside the fenced block below is the skill content. Substitute every `{{NAME}}` with the confirmed `<NAME>` from Step 1, then install the result as a Claude skill.

````markdown
---
name: {{NAME}}
description: Use this skill whenever the user wants to work "in {{NAME}}", "with {{NAME}}", or asks to do anything on a {{NAME}} app — building, listing, using, evolving, or dropping an app or schema; querying or mutating data; adding tables; creating/loading/saving Hereya skills or views; deploying a backend; enabling auth; adding users; sending mail; attaching custom domains. Also fires on any direct invocation of `mcp__{{NAME}}__create-schema`, `mcp__{{NAME}}__list-skills`, `mcp__{{NAME}}__get-skill`, `mcp__{{NAME}}__save-skill`, `mcp__{{NAME}}__save-view`, `mcp__{{NAME}}__deploy-backend`, `mcp__{{NAME}}__enable-frontend`, `mcp__{{NAME}}__enable-auth`, `mcp__{{NAME}}__add-user`, `mcp__{{NAME}}__send-mail`, `mcp__{{NAME}}__set-custom-domains`, etc. Do NOT fire on generic "app" or "skill" mentions outside the {{NAME}} context.
---

# Working with `{{NAME}}` (Hereya MCP)

`{{NAME}}` is a Hereya MCP server. Inside it, an "app" is a Postgres schema + an S3 folder + one or more Hereya skills (per-app instructions stored in `_hereya.skills`) + an optional per-app Lambda for a browser frontend. Hereya owns storage and runtime; you (the agent) own business logic and skill content. The user picked the name `{{NAME}}` when they wired the MCP into their Claude config — every tool surfaced by this MCP is prefixed `mcp__{{NAME}}__`.

## The two "skills" — read this before calling `mcp__{{NAME}}__save-skill`

> The word *skill* is overloaded:
>
> - **Hereya skill** — per-app instruction text stored in the `_hereya.skills` table via `mcp__{{NAME}}__save-skill` / `mcp__{{NAME}}__get-skill`. Tells future agents how to use a specific app inside `{{NAME}}`.
> - **Claude skill** — a `SKILL.md` (this very skill is one). Tells Claude how to use a category of tools.
>
> When the user says "save a skill for my recipes app", they mean a **Hereya skill** — call `mcp__{{NAME}}__save-skill`. Never write a SKILL.md in response. When unsure, call `mcp__{{NAME}}__get-instructions({ topic: "write-skill" })` to ground yourself in what a Hereya skill should look like.

## The golden rule for existing apps

Before doing anything with an app that may already exist in `{{NAME}}`, call `mcp__{{NAME}}__list-skills()`. If a relevant skill exists, load it with `mcp__{{NAME}}__get-skill({ schema, name })` — that returns both the skill content and the live schema structure in one call, so you don't need a separate `describe-schema`. Skip this only when the user is explicitly creating a brand-new app.

## Router — which `get-instructions` topic for which intent

| User intent | Call |
| --- | --- |
| Create / make / build an app for X in `{{NAME}}` | `mcp__{{NAME}}__get-instructions({ topic: "create-app" })` |
| Use / list / show / query an existing app | `mcp__{{NAME}}__list-skills()` first; if the app exists, `mcp__{{NAME}}__get-skill({ schema, name })`. For deeper context: `mcp__{{NAME}}__get-instructions({ topic: "use-app" })` |
| Add a column / change a table / evolve an app | `mcp__{{NAME}}__get-instructions({ topic: "update-app" })` |
| Write or improve the skill for an app | `mcp__{{NAME}}__get-instructions({ topic: "write-skill" })` |
| Deploy a backend / enable a website / add login / send mail / attach a custom domain | `mcp__{{NAME}}__get-instructions({ topic: "frontend" })` — covers `enable-frontend`, `deploy-backend`, `enable-auth`, `add-user`, `send-mail`, custom domains end-to-end |
| Drop / delete an app | `mcp__{{NAME}}__drop-schema({ schema, confirm: true })` directly. Destructive — Postgres CASCADE + S3 folder + skills + Lambda + Cognito + Postmark + custom domains. Always require explicit user confirmation in chat before calling. |

If the intent doesn't fit any row, call `mcp__{{NAME}}__list-skills()` and `mcp__{{NAME}}__describe-schema` to orient, then pick the closest topic.

## Hard rules that can't be deferred

These surface as cryptic errors if you don't know them up front:

- **Schema names**: `^[a-z][a-z0-9]{0,62}$` — lowercase alphanumeric only, no hyphens, no underscores, no leading digit. The schema name is reused as a DNS label and Postmark sender subdomain, so the constraint isn't negotiable.
- **SQL parameters**: `:param_name` placeholders with `params: { name: value }`. Never string-concat values into SQL.
- **`query` vs `execute`**: `mcp__{{NAME}}__query` is SELECT/WITH only, capped at 1000 rows. Everything else (INSERT/UPDATE/DELETE/DDL) goes through `mcp__{{NAME}}__execute`. `DROP SCHEMA` and `DROP DATABASE` are blocked from `execute` — use `mcp__{{NAME}}__drop-schema`.
- **Always schema-qualify table names**: write `recipes.recipes`, never bare `recipes`.
- **`enable-auth` requires `enable-frontend` first** — out-of-order calls return `FRONTEND_NOT_ENABLED`.
- **`send-mail` requires `enable-auth` first** — and the From-domain is locked to the app's signed subdomain or an active row in `_custom_domains`. The agent can't send "as a third party"; only as the app's own verified sender.

## When stuck

Call `mcp__{{NAME}}__get-instructions({ topic })` for the topic closest to the user's intent. If no topic matches, call `mcp__{{NAME}}__list-skills()` and `mcp__{{NAME}}__describe-schema` to orient, then ask the user.
````
