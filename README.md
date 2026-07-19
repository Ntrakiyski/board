# tldraw self-hosted

Self-hosted tldraw for iPad sketching, shared board URLs, REST access, and MCP access for agents.

## Run

Create `.env` from `.env.example` and set the Clerk keys plus `DATABASE_URL`:

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

Open a board:

```text
http://<server-ip>:5421/board/personal-sketchbook
```

Any board ID in the URL becomes its own shared room:

```text
http://<server-ip>:5421/board/client-a
http://<server-ip>:5421/board/wireframes
```

Open the same board URL on the iPad and Mac to see the same live canvas.

The app uses Clerk sign-in and Clerk Organizations as workspaces. You must select or create an Organization before opening a board. Boards are scoped to the active Organization.

Use the hamburger menu for:

```text
New board
View boards
Organization switcher
```

`View boards` opens the board list. Each board can be opened, renamed, or deleted from its row menu.
The Clerk organization switcher includes Clerk's own Manage button for organization settings and invitations. The bottom-left profile avatar opens Clerk user profile. The top action row has a copy-link icon before the three-dot menu. That button copies the current board URL and opens the Clerk Organization members view so you can invite teammates.

## Storage

Boards are synced through the Node server and stored as SQLite files under:

```text
/home/vps-apps/tldraw-selfhost/data/workspaces/<workspace-id>/rooms
```

Uploaded assets are stored under:

```text
/home/vps-apps/tldraw-selfhost/data/uploads
```

When `DATABASE_URL` is configured, workspace and board metadata is stored in the shared InsForge/Postgres database:

```text
workspaces
workspace_memberships
tldraw_boards
tldraw_board_snapshots
tldraw_integration_tokens
```

Without `DATABASE_URL`, the app falls back to local JSON metadata under `/home/vps-apps/tldraw-selfhost/data`.

The Docker volume is `./data:/data`, so the board data survives container rebuilds.

## REST API

The server exposes a REST API for agents and other apps that want to read or write the same tldraw board records used by the web editor.
Board API requests accept either:

```text
Authorization: Bearer <Clerk organization JWT>
Authorization: Bearer <bd_ Board workspace token>
```

The simplest way to create a scoped Board workspace token is from the Board hamburger menu:

```text
Copy Connections token
```

That creates an editor token for the active Clerk Organization workspace and copies it to your clipboard.

You can also create one from the API while authenticated with Clerk:

```bash
curl -X POST http://<server-ip>:5421/api/integration-tokens \
  -H "Authorization: Bearer <Clerk organization JWT>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Connections","role":"editor"}'
```

The returned `bd_...` token is shown once. Store it in Connections as the Board workspace token.

OpenAPI document:

```text
http://<server-ip>:5421/openapi.json
```

Useful endpoints:

```text
GET    /api/health
GET    /api/boards
GET    /api/boards/:roomId
GET    /api/boards/:roomId/snapshot
POST   /api/boards/:roomId/records
DELETE /api/boards/:roomId/records
```

The write endpoints currently accept raw tldraw records. For example, shape records need the same structure the tldraw editor stores internally, such as `id`, `typeName`, `type`, `x`, `y`, `props`, and related metadata fields.

## MCP

The MCP endpoint is:

```text
http://<server-ip>:5421/mcp
```

It supports these tools:

```text
list_boards
read_board
get_board_snapshot
create_shapes
update_shapes
delete_shapes
```

Use Streamable HTTP transport when connecting an MCP client. The tools operate on raw tldraw records, so an agent can inspect board state and create/update/delete canvas content.

## Tailscale

On this VPS the app is published on port `5421`. From devices on the same Tailnet, use the Tailscale IP or MagicDNS name:

```text
http://100.123.30.5:5421/board/personal-sketchbook
```

Keep this behind Tailscale or add authentication before exposing it publicly.

## License

tldraw SDK production use requires a license key. When you have one, set it before building:

```bash
VITE_TLDRAW_LICENSE_KEY="tldraw-..." docker compose up -d --build
```
