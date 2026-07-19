import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import websocketPlugin from '@fastify/websocket'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import Database from 'better-sqlite3'
import fastify from 'fastify'
import pg from 'pg'
import {
	copyFileSync,
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'

const PORT = Number(process.env.PORT ?? 5421)
const DATA_DIR = resolve(process.env.DATA_DIR ?? './data')
const ROOMS_DIR = join(DATA_DIR, 'rooms')
const UPLOADS_DIR = join(DATA_DIR, 'uploads')
const WORKSPACES_DIR = join(DATA_DIR, 'workspaces')
const BOARDS_META_PATH = join(DATA_DIR, 'boards.json')
const WORKSPACES_META_PATH = join(DATA_DIR, 'workspaces.json')
const DIST_DIR = resolve('./dist')
const OPENAPI_PATH = resolve('./openapi.json')
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY
const DATABASE_URL = process.env.DATABASE_URL
const { Pool } = pg
const pgPool = DATABASE_URL ? new Pool({ connectionString: normalizePostgresConnectionString(DATABASE_URL) }) : null

mkdirSync(ROOMS_DIR, { recursive: true })
mkdirSync(UPLOADS_DIR, { recursive: true })
mkdirSync(WORKSPACES_DIR, { recursive: true })

function sanitizeId(value) {
	return String(value || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'untitled'
}

function sanitizeUploadName(value) {
	return String(value || 'asset').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 180) || 'asset'
}

const rooms = new Map()
let boardsMeta = loadBoardsMeta()
let workspacesMeta = loadWorkspacesMeta()
const syncTickets = new Map()
const snapshotTimers = new Map()

function normalizePostgresConnectionString(connectionString) {
	const url = new URL(connectionString)
	const sslmode = url.searchParams.get('sslmode')
	if (sslmode === 'prefer' || sslmode === 'require' || sslmode === 'verify-ca') {
		url.searchParams.set('sslmode', 'verify-full')
	}
	return url.toString()
}

function hashToken(token) {
	return createHash('sha256').update(token).digest('hex')
}

function loadBoardsMeta() {
	if (!existsSync(BOARDS_META_PATH)) return {}
	try {
		const parsed = JSON.parse(readFileSync(BOARDS_META_PATH, 'utf8'))
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
	} catch (error) {
		console.error('Failed to read boards metadata.', error)
		return {}
	}
}

function saveBoardsMeta() {
	writeFileSync(BOARDS_META_PATH, JSON.stringify(boardsMeta, null, 2))
}

function loadWorkspacesMeta() {
	if (!existsSync(WORKSPACES_META_PATH)) return {}
	try {
		const parsed = JSON.parse(readFileSync(WORKSPACES_META_PATH, 'utf8'))
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
	} catch (error) {
		console.error('Failed to read workspaces metadata.', error)
		return {}
	}
}

function saveWorkspacesMeta() {
	writeFileSync(WORKSPACES_META_PATH, JSON.stringify(workspacesMeta, null, 2))
}

function getWorkspaceRoomsDir(workspaceId) {
	return join(WORKSPACES_DIR, sanitizeId(workspaceId), 'rooms')
}

function getWorkspaceUploadsDir(workspaceId) {
	return join(WORKSPACES_DIR, sanitizeId(workspaceId), 'uploads')
}

function getBoardFilePath(workspaceId, roomId) {
	return join(getWorkspaceRoomsDir(workspaceId), `${sanitizeId(roomId)}.db`)
}

function timestampFromFile(workspaceId, roomId) {
	try {
		const stats = statSync(getBoardFilePath(workspaceId, roomId))
		return stats.birthtimeMs > 0 ? stats.birthtime.toISOString() : stats.ctime.toISOString()
	} catch {
		return new Date().toISOString()
	}
}

function getWorkspaceBoardMeta(workspaceId) {
	if (!boardsMeta.workspaces) {
		const legacyBoards = {}
		for (const [key, value] of Object.entries(boardsMeta)) {
			if (key !== 'workspaces' && value && typeof value === 'object' && value.id) {
				legacyBoards[key] = value
			}
		}
		boardsMeta = { workspaces: {}, legacyBoards }
		saveBoardsMeta()
	}
	if (!boardsMeta.workspaces[workspaceId]) {
		boardsMeta.workspaces[workspaceId] = {}
		saveBoardsMeta()
	}
	return boardsMeta.workspaces[workspaceId]
}

function ensureLocalBoardMeta(workspaceId, roomId) {
	const id = sanitizeId(roomId)
	const workspaceBoards = getWorkspaceBoardMeta(workspaceId)
	const existing = workspaceBoards[id]
	if (existing) {
		if (!existing.id) existing.id = id
		if (!existing.createdAt) existing.createdAt = timestampFromFile(workspaceId, id)
		if (!existing.updatedAt) existing.updatedAt = existing.createdAt
		return existing
	}

	const now = timestampFromFile(workspaceId, id)
	const created = { id, workspaceId, name: '', createdAt: now, updatedAt: now }
	workspaceBoards[id] = created
	saveBoardsMeta()
	return created
}

function localBoardSummary(workspaceId, roomId) {
	const id = sanitizeId(roomId)
	const meta = ensureLocalBoardMeta(workspaceId, id)
	return {
		id,
		workspaceId,
		name: meta.name || '',
		createdAt: meta.createdAt,
		updatedAt: meta.updatedAt,
		url: `/board/${encodeURIComponent(id)}`,
	}
}

function toBoardSummary(row) {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		name: row.name || '',
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		url: `/board/${encodeURIComponent(row.id)}`,
	}
}

async function ensureBoardMeta(workspace, roomId) {
	const workspaceId = typeof workspace === 'string' ? workspace : workspace.workspaceId
	const userId = typeof workspace === 'string' ? 'local-dev' : workspace.userId
	const id = sanitizeId(roomId)
	if (!pgPool) return localBoardSummary(workspaceId, id)

	const now = new Date().toISOString()
	const result = await pgPool.query(
		`insert into public.tldraw_boards (id, workspace_id, name, created_by, created_at, updated_at, deleted_at)
		 values ($1, $2, '', $3, $4, $4, null)
		 on conflict (workspace_id, id)
		 do update set deleted_at = null, updated_at = public.tldraw_boards.updated_at
		 returning id, workspace_id, name, created_at, updated_at`,
		[id, workspaceId, userId, now]
	)
	return toBoardSummary(result.rows[0])
}

function getRoom(workspaceId, roomId) {
	const id = sanitizeId(roomId)
	const key = `${sanitizeId(workspaceId)}:${id}`
	const existing = rooms.get(key)
	if (existing && !existing.room.isClosed()) return existing

	ensureLocalBoardMeta(workspaceId, id)
	mkdirSync(getWorkspaceRoomsDir(workspaceId), { recursive: true })
	const dbPath = getBoardFilePath(workspaceId, id)
	const db = new Database(dbPath)
	const storage = new SQLiteSyncStorage({ sql: new NodeSqliteWrapper(db) })
	const room = new TLSocketRoom({
		storage,
		onDataChange() {
			scheduleSnapshotPersist(workspaceId, id)
		},
		onSessionRemoved(room, args) {
			if (args.numSessionsRemaining === 0) {
				void persistBoardSnapshot(workspaceId, id, 'sync-room')
				room.close()
				db.close()
				const timerKey = `${sanitizeId(workspaceId)}:${id}`
				const timer = snapshotTimers.get(timerKey)
				if (timer) clearTimeout(timer)
				snapshotTimers.delete(timerKey)
				rooms.delete(key)
			}
		},
	})

	const entry = { id, workspaceId, dbPath, db, storage, room }
	rooms.set(key, entry)
	return entry
}

function localBoardIds(workspaceId) {
	const roomsDir = getWorkspaceRoomsDir(workspaceId)
	const fromDisk = existsSync(roomsDir)
		? readdirSync(roomsDir)
				.filter((name) => name.endsWith('.db'))
				.map((name) => name.slice(0, -3))
		: []
	const active = [...rooms.values()]
		.filter((entry) => entry.workspaceId === workspaceId)
		.map((entry) => entry.id)
	const workspaceBoards = getWorkspaceBoardMeta(workspaceId)
	return [...new Set([...fromDisk, ...active, ...Object.keys(workspaceBoards)])].sort()
}

async function listBoardIds(workspace) {
	const workspaceId = typeof workspace === 'string' ? workspace : workspace.workspaceId
	if (!pgPool) return localBoardIds(workspaceId)
	const dbRows = await pgPool.query(
		`select id from public.tldraw_boards where workspace_id = $1 and deleted_at is null order by id`,
		[workspaceId]
	)
	return [...new Set([...localBoardIds(workspaceId), ...dbRows.rows.map((row) => row.id)])].sort()
}

async function listBoards(workspace) {
	const workspaceId = typeof workspace === 'string' ? workspace : workspace.workspaceId
	importLegacyBoardsIfNeeded(workspaceId)
	if (!pgPool) {
		return localBoardIds(workspaceId)
			.map((boardId) => localBoardSummary(workspaceId, boardId))
			.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id))
	}

	const ids = await listBoardIds(workspace)
	await Promise.all(ids.map((boardId) => ensureBoardMeta(workspace, boardId)))
	const result = await pgPool.query(
		`select id, workspace_id, name, created_at, updated_at
		 from public.tldraw_boards
		 where workspace_id = $1 and deleted_at is null
		 order by updated_at desc, id asc`,
		[workspaceId]
	)
	return result.rows.map(toBoardSummary)
}

async function renameBoard(workspace, roomId, name) {
	const workspaceId = typeof workspace === 'string' ? workspace : workspace.workspaceId
	const id = sanitizeId(roomId)
	if (pgPool) await ensureBoardMeta(workspace, id)
	const meta = ensureLocalBoardMeta(workspaceId, id)
	meta.name = String(name ?? '').trim().slice(0, 120)
	meta.updatedAt = new Date().toISOString()
	saveBoardsMeta()
	if (!pgPool) return localBoardSummary(workspaceId, id)
	const result = await pgPool.query(
		`update public.tldraw_boards
		 set name = $3, updated_at = $4
		 where workspace_id = $1 and id = $2 and deleted_at is null
		 returning id, workspace_id, name, created_at, updated_at`,
		[workspaceId, id, meta.name, meta.updatedAt]
	)
	return toBoardSummary(result.rows[0])
}

async function deleteBoard(workspace, roomId) {
	const workspaceId = typeof workspace === 'string' ? workspace : workspace.workspaceId
	const id = sanitizeId(roomId)
	const key = `${sanitizeId(workspaceId)}:${id}`
	const active = rooms.get(key)
	if (active) {
		active.room.close()
		active.db.close()
		rooms.delete(key)
	}

	const dbPath = getBoardFilePath(workspaceId, id)
	if (existsSync(dbPath)) unlinkSync(dbPath)

	delete getWorkspaceBoardMeta(workspaceId)[id]
	saveBoardsMeta()
	if (pgPool) {
		const now = new Date().toISOString()
		await pgPool.query(
			`update public.tldraw_boards set deleted_at = $3, updated_at = $3 where workspace_id = $1 and id = $2`,
			[workspaceId, id, now]
		)
	}
	return { ok: true, id }
}

function importLegacyBoardsIfNeeded(workspaceId) {
	const workspace = workspacesMeta[workspaceId]
	if (workspace?.legacyImportedAt) return
	const legacyBoards = boardsMeta.legacyBoards ?? {}
	const legacyIds = [
		...new Set([
			...Object.keys(legacyBoards),
			...(existsSync(ROOMS_DIR)
				? readdirSync(ROOMS_DIR)
						.filter((name) => name.endsWith('.db'))
						.map((name) => name.slice(0, -3))
				: []),
		]),
	]
	if (legacyIds.length === 0) {
		if (workspace) {
			workspace.legacyImportedAt = new Date().toISOString()
			saveWorkspacesMeta()
		}
		return
	}
	mkdirSync(getWorkspaceRoomsDir(workspaceId), { recursive: true })
	const workspaceBoards = getWorkspaceBoardMeta(workspaceId)
	for (const boardId of legacyIds) {
		const legacyPath = join(ROOMS_DIR, `${sanitizeId(boardId)}.db`)
		const targetPath = getBoardFilePath(workspaceId, boardId)
		if (existsSync(legacyPath) && !existsSync(targetPath)) copyFileSync(legacyPath, targetPath)
		workspaceBoards[boardId] = {
			...(legacyBoards[boardId] ?? {}),
			id: boardId,
			workspaceId,
			createdAt: legacyBoards[boardId]?.createdAt ?? timestampFromFile(workspaceId, boardId),
			updatedAt: legacyBoards[boardId]?.updatedAt ?? legacyBoards[boardId]?.createdAt ?? new Date().toISOString(),
		}
	}
	if (workspace) workspace.legacyImportedAt = new Date().toISOString()
	saveBoardsMeta()
	saveWorkspacesMeta()
}

async function getSnapshot(workspace, roomId) {
	const workspaceId = typeof workspace === 'string' ? workspace : workspace.workspaceId
	await ensureBoardMeta(workspace, roomId)
	const { id, room } = getRoom(workspaceId, roomId)
	return { roomId: id, workspaceId, snapshot: room.getCurrentSnapshot() }
}

async function getRecords(workspace, roomId) {
	const workspaceId = typeof workspace === 'string' ? workspace : workspace.workspaceId
	const { roomId: id, snapshot } = await getSnapshot(workspace, roomId)
	const records = snapshot.documents.map((doc) => doc.state)
	return {
		roomId: id,
		workspaceId,
		documentClock: snapshot.documentClock ?? snapshot.clock ?? 0,
		records,
		shapes: records.filter((record) => record?.typeName === 'shape'),
		assets: records.filter((record) => record?.typeName === 'asset'),
		bindings: records.filter((record) => record?.typeName === 'binding'),
	}
}

function scheduleSnapshotPersist(workspaceId, roomId) {
	if (!pgPool) return
	const key = `${sanitizeId(workspaceId)}:${sanitizeId(roomId)}`
	const existing = snapshotTimers.get(key)
	if (existing) clearTimeout(existing)
	const timer = setTimeout(() => {
		snapshotTimers.delete(key)
		void persistBoardSnapshot(workspaceId, roomId, 'sync-room')
	}, 1000)
	snapshotTimers.set(key, timer)
}

async function persistBoardSnapshot(workspaceId, roomId, userId) {
	if (!pgPool) return
	const id = sanitizeId(roomId)
	const entry = rooms.get(`${sanitizeId(workspaceId)}:${id}`)
	if (!entry || entry.room.isClosed()) return
	const snapshot = entry.room.getCurrentSnapshot()
	const now = new Date().toISOString()
	await ensureBoardMeta({ workspaceId, userId, role: 'editor' }, id)
	await pgPool.query(
		`insert into public.tldraw_board_snapshots
			(workspace_id, board_id, snapshot, document_clock, updated_by, updated_at)
		 values ($1, $2, $3::jsonb, $4, $5, $6)
		 on conflict (workspace_id, board_id)
		 do update set
			snapshot = excluded.snapshot,
			document_clock = excluded.document_clock,
			updated_by = excluded.updated_by,
			updated_at = excluded.updated_at`,
		[
			workspaceId,
			id,
			JSON.stringify(snapshot),
			Number(snapshot.documentClock ?? snapshot.clock ?? 0),
			userId,
			now,
		]
	)
	await pgPool.query(
		`update public.tldraw_boards set updated_at = $3 where workspace_id = $1 and id = $2 and deleted_at is null`,
		[workspaceId, id, now]
	)
}

function normalizeRecord(record) {
	if (!record || typeof record !== 'object' || Array.isArray(record)) {
		throw new Error('Each record must be an object.')
	}
	if (typeof record.id !== 'string' || typeof record.typeName !== 'string') {
		throw new Error('Each record must include string id and typeName fields.')
	}
	return record
}

async function putRecords(workspace, roomId, records) {
	const workspaceId = typeof workspace === 'string' ? workspace : workspace.workspaceId
	const userId = typeof workspace === 'string' ? 'api' : workspace.userId
	await ensureBoardMeta(workspace, roomId)
	const entry = getRoom(workspaceId, roomId)
	const normalized = records.map(normalizeRecord)
	await entry.room.updateStore((store) => {
		for (const record of normalized) store.put(record)
	})
	await persistBoardSnapshot(workspaceId, roomId, userId)
	return { roomId: entry.id, count: normalized.length, records: normalized }
}

async function deleteRecords(workspace, roomId, recordIds) {
	const workspaceId = typeof workspace === 'string' ? workspace : workspace.workspaceId
	const userId = typeof workspace === 'string' ? 'api' : workspace.userId
	await ensureBoardMeta(workspace, roomId)
	const entry = getRoom(workspaceId, roomId)
	const ids = recordIds.map((id) => String(id))
	await entry.room.updateStore((store) => {
		for (const id of ids) store.delete(id)
	})
	await persistBoardSnapshot(workspaceId, roomId, userId)
	return { roomId: entry.id, count: ids.length, recordIds: ids }
}

async function verifyClerkToken(token) {
	if (!CLERK_SECRET_KEY) return { workspaceId: 'local-dev', userId: 'local-dev', role: 'admin' }
	const { verifyToken } = await import('@clerk/backend')
	const claims = await verifyToken(token, { secretKey: CLERK_SECRET_KEY })
	const userId = readStringClaim(claims, 'sub')
	const organization = readClerkOrganization(claims)
	if (!userId || !organization.id) {
		const error = new Error('An active Clerk organization is required.')
		error.statusCode = 403
		throw error
	}
	return ensureWorkspace(organization.id, readStringClaim(claims, 'org_name') ?? organization.id, userId, organization.role)
}

function readClerkOrganization(claims) {
	const current = claims?.o && typeof claims.o === 'object' ? claims.o : {}
	const compactRole = readStringClaim(current, 'rol')
	return {
		id: readStringClaim(claims, 'org_id') ?? readStringClaim(current, 'id'),
		role: readStringClaim(claims, 'org_role') ?? (compactRole ? `org:${compactRole}` : undefined),
	}
}

function readStringClaim(claims, name) {
	const value = claims?.[name]
	return typeof value === 'string' && value ? value : undefined
}

function mapClerkRole(role) {
	if (role === 'org:admin') return 'admin'
	if (role === 'org:manager') return 'manager'
	return 'member'
}

async function ensureWorkspace(clerkOrgId, name, userId, clerkRole) {
	const workspaceId = sanitizeId(clerkOrgId)
	const now = new Date().toISOString()
	const role = mapClerkRole(clerkRole)
	if (pgPool) {
		const workspaceResult = await pgPool.query(
			`insert into public.workspaces (id, clerk_org_id, name, created_at, updated_at)
			 values ($1, $2, $3, $4, $4)
			 on conflict (clerk_org_id)
			 do update set name = excluded.name, updated_at = excluded.updated_at, deleted_at = null
			 returning id, name`,
			[workspaceId, clerkOrgId, name || clerkOrgId, now]
		)
		const workspace = workspaceResult.rows[0]
		await pgPool.query(
			`insert into public.workspace_memberships (workspace_id, user_id, role, created_at, updated_at)
			 values ($1, $2, $3, $4, $4)
			 on conflict (workspace_id, user_id)
			 do update set role = excluded.role, updated_at = excluded.updated_at`,
			[workspace.id, userId, role, now]
		)
		return { workspaceId: workspace.id, workspaceName: workspace.name, userId, role, authType: 'clerk' }
	}

	const existing = workspacesMeta[workspaceId]
	if (!existing) {
		workspacesMeta[workspaceId] = {
			id: workspaceId,
			clerkOrgId,
			name,
			members: {},
			createdAt: now,
			updatedAt: now,
		}
	}
	const workspace = workspacesMeta[workspaceId]
	workspace.name = name || workspace.name
	workspace.updatedAt = now
	workspace.members = workspace.members ?? {}
	workspace.members[userId] = {
		userId,
		role,
		updatedAt: now,
	}
	saveWorkspacesMeta()
	return { workspaceId, workspaceName: workspace.name, userId, role: workspace.members[userId].role, authType: 'clerk' }
}

async function verifyBoardIntegrationToken(token) {
	if (!pgPool || !token.startsWith('bd_')) return undefined
	const now = new Date().toISOString()
	const result = await pgPool.query(
		`update public.tldraw_integration_tokens
		 set last_used_at = $2
		 where token_hash = $1 and revoked_at is null
		 returning id, workspace_id, role, created_by`,
		[hashToken(token), now]
	)
	const row = result.rows[0]
	if (!row) return undefined
	const workspaceResult = await pgPool.query(
		`select id, name from public.workspaces where id = $1 and deleted_at is null`,
		[row.workspace_id]
	)
	const workspace = workspaceResult.rows[0]
	if (!workspace) return undefined
	return {
		workspaceId: workspace.id,
		workspaceName: workspace.name,
		userId: row.created_by,
		role: row.role === 'viewer' ? 'viewer' : 'editor',
		authType: 'integration_token',
		tokenId: row.id,
	}
}

function readBearerToken(req) {
	const authorization = req.headers.authorization ?? ''
	return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : ''
}

async function requireWorkspace(req) {
	const token = readBearerToken(req)
	if (!token && CLERK_SECRET_KEY) {
		const error = new Error('A valid Clerk session is required.')
		error.statusCode = 401
		throw error
	}
	const integrationWorkspace = token ? await verifyBoardIntegrationToken(token) : undefined
	if (integrationWorkspace) return integrationWorkspace
	return verifyClerkToken(token)
}

function requireWritableWorkspace(workspace) {
	if (workspace.role === 'viewer') {
		const error = new Error('This Board token can only read boards.')
		error.statusCode = 403
		throw error
	}
	return workspace
}

async function createIntegrationToken(workspace, input) {
	requireWritableWorkspace(workspace)
	if (!pgPool) {
		const error = new Error('Integration tokens require DATABASE_URL.')
		error.statusCode = 501
		throw error
	}
	const token = `bd_${randomBytes(32).toString('base64url')}`
	const id = `bit_${randomBytes(12).toString('hex')}`
	const now = new Date().toISOString()
	const name = String(input?.name ?? 'Connections').trim().slice(0, 80) || 'Connections'
	const role = input?.role === 'viewer' ? 'viewer' : 'editor'
	await pgPool.query(
		`insert into public.tldraw_integration_tokens
			(id, workspace_id, name, token_hash, role, created_by, created_at)
		 values ($1, $2, $3, $4, $5, $6, $7)`,
		[id, workspace.workspaceId, name, hashToken(token), role, workspace.userId, now]
	)
	return { id, name, role, workspaceId: workspace.workspaceId, token, createdAt: now }
}

function createSyncTicket(workspace, roomId) {
	const ticket = crypto.randomUUID()
	syncTickets.set(ticket, {
		workspace,
		roomId: sanitizeId(roomId),
		expiresAt: Date.now() + 2 * 60 * 1000,
	})
	return ticket
}

function consumeSyncTicket(ticket, roomId) {
	const record = syncTickets.get(ticket)
	syncTickets.delete(ticket)
	if (!record || record.expiresAt < Date.now() || record.roomId !== sanitizeId(roomId)) return undefined
	return record.workspace
}

function openApiDocument() {
	return JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'))
}

function toolResult(value) {
	return {
		content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
		structuredContent: value,
	}
}

function createMcpServer(workspace) {
	const server = new McpServer({
		name: 'tldraw-selfhost',
		version: '0.1.0',
	})

	server.registerTool(
		'list_boards',
		{
			title: 'List Boards',
			description: 'List boards known to the self-hosted tldraw server with names and timestamps.',
			inputSchema: {},
		},
		async () => toolResult({ boards: await listBoards(workspace) })
	)

	server.registerTool(
		'read_board',
		{
			title: 'Read Board',
			description: 'Read raw tldraw records for a board, grouped into records, shapes, assets, and bindings.',
			inputSchema: { roomId: z.string().min(1) },
		},
		async ({ roomId }) => toolResult(await getRecords(workspace, roomId))
	)

	server.registerTool(
		'get_board_snapshot',
		{
			title: 'Get Board Snapshot',
			description: 'Read the full tldraw sync room snapshot for a board.',
			inputSchema: { roomId: z.string().min(1) },
		},
		async ({ roomId }) => toolResult(await getSnapshot(workspace, roomId))
	)

	server.registerTool(
		'create_shapes',
		{
			title: 'Create Shapes',
			description:
				'Create raw tldraw shape records. Records must include id, typeName:"shape", type, x, y, props, and any required shape fields.',
			inputSchema: {
				roomId: z.string().min(1),
				shapes: z.array(z.record(z.string(), z.any())),
			},
		},
		async ({ roomId, shapes }) =>
			toolResult(await putRecords(requireWritableWorkspace(workspace), roomId, shapes))
	)

	server.registerTool(
		'update_shapes',
		{
			title: 'Update Shapes',
			description: 'Update raw tldraw shape records by replacing records with matching IDs.',
			inputSchema: {
				roomId: z.string().min(1),
				shapes: z.array(z.record(z.string(), z.any())),
			},
		},
		async ({ roomId, shapes }) =>
			toolResult(await putRecords(requireWritableWorkspace(workspace), roomId, shapes))
	)

	server.registerTool(
		'delete_shapes',
		{
			title: 'Delete Shapes',
			description: 'Delete tldraw shape records by record ID, e.g. shape:abc123.',
			inputSchema: {
				roomId: z.string().min(1),
				shapeIds: z.array(z.string()),
			},
		},
		async ({ roomId, shapeIds }) =>
			toolResult(await deleteRecords(requireWritableWorkspace(workspace), roomId, shapeIds))
	)

	return server
}

const app = fastify({ logger: true, bodyLimit: 20 * 1024 * 1024, serverFactory: createServer })

await app.register(cors, { origin: true })
await app.register(websocketPlugin)

app.setErrorHandler((error, req, reply) => {
	req.log.error(error)
	const isBadRequest =
		error.message?.startsWith('Request body') || error.message?.startsWith('Each record')
	const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : isBadRequest ? 400 : 500
	reply.code(statusCode).send({ error: error.message })
})

app.get('/connect/:roomId', { websocket: true }, async (socket, req) => {
	const roomId = sanitizeId(req.params.roomId)
	const workspace = consumeSyncTicket(String(req.query?.ticket ?? ''), roomId)
	if (!workspace) {
		socket.close(1008, 'Unauthorized')
		return
	}
	const sessionId = String(req.query?.sessionId ?? '')
	const caughtMessages = []
	const collectMessages = (message) => caughtMessages.push(message)

	socket.on('message', collectMessages)
	const { room } = getRoom(workspace.workspaceId, roomId)
	room.handleSocketConnect({ sessionId, socket })
	socket.off('message', collectMessages)

	for (const message of caughtMessages) socket.emit('message', message)
})

app.addContentTypeParser('*', (_, __, done) => done(null))

app.put('/uploads/:id', async (req, reply) => {
	const id = sanitizeUploadName(req.params.id)
	const target = join(UPLOADS_DIR, id)
	mkdirSync(dirname(target), { recursive: true })
	await pipeline(req.raw, createWriteStream(target))
	return reply.send({ ok: true, id, url: `/uploads/${encodeURIComponent(id)}` })
})

app.get('/uploads/:id', async (req, reply) => {
	const id = sanitizeUploadName(req.params.id)
	const target = join(UPLOADS_DIR, id)
	if (!existsSync(target)) return reply.code(404).send({ error: 'Not found' })
	reply.header('Content-Security-Policy', "default-src 'none'")
	reply.header('X-Content-Type-Options', 'nosniff')
	return reply.send(createReadStream(target))
})

app.get('/unfurl', async () => ({
	description: '',
	image: '',
	favicon: '',
	title: '',
}))

app.get('/api/health', async () => ({ ok: true }))
app.get('/api/auth/session', async (req) => {
	const workspace = await requireWorkspace(req)
	return { authenticated: true, ...workspace }
})
app.post('/api/sync-tickets/:roomId', async (req) => {
	const workspace = requireWritableWorkspace(await requireWorkspace(req))
	await ensureBoardMeta(workspace, req.params.roomId)
	return { ticket: createSyncTicket(workspace, req.params.roomId) }
})
app.get('/api/boards', async (req) => {
	const workspace = await requireWorkspace(req)
	return { boards: await listBoards(workspace) }
})
app.patch('/api/boards/:roomId', async (req) => {
	const workspace = requireWritableWorkspace(await requireWorkspace(req))
	return renameBoard(workspace, req.params.roomId, req.body?.name)
})
app.delete('/api/boards/:roomId', async (req) => {
	const workspace = requireWritableWorkspace(await requireWorkspace(req))
	return deleteBoard(workspace, req.params.roomId)
})
app.get('/api/boards/:roomId', async (req) => {
	const workspace = await requireWorkspace(req)
	return getRecords(workspace, req.params.roomId)
})
app.get('/api/boards/:roomId/snapshot', async (req) => {
	const workspace = await requireWorkspace(req)
	return getSnapshot(workspace, req.params.roomId)
})
app.post('/api/boards/:roomId/records', async (req) => {
	const workspace = requireWritableWorkspace(await requireWorkspace(req))
	if (!Array.isArray(req.body?.records)) {
		throw new Error('Request body must include records array.')
	}
	const records = req.body.records
	return putRecords(workspace, req.params.roomId, records)
})
app.delete('/api/boards/:roomId/records', async (req) => {
	const workspace = requireWritableWorkspace(await requireWorkspace(req))
	if (!Array.isArray(req.body?.recordIds)) {
		throw new Error('Request body must include recordIds array.')
	}
	const recordIds = req.body.recordIds
	return deleteRecords(workspace, req.params.roomId, recordIds)
})
app.post('/api/integration-tokens', async (req) => {
	const workspace = requireWritableWorkspace(await requireWorkspace(req))
	return createIntegrationToken(workspace, req.body)
})
app.get('/openapi.json', async () => openApiDocument())

app.post('/mcp', async (req, reply) => {
	const workspace = await requireWorkspace(req)
	const server = createMcpServer(workspace)
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	})

	try {
		await server.connect(transport)
		reply.hijack()
		await transport.handleRequest(req.raw, reply.raw, req.body)
	} catch (error) {
		req.log.error(error)
		if (!reply.raw.headersSent) {
			reply.raw.writeHead(500, { 'content-type': 'application/json' })
			reply.raw.end(
				JSON.stringify({
					jsonrpc: '2.0',
					error: { code: -32603, message: 'Internal server error' },
					id: null,
				})
			)
		}
	} finally {
		await transport.close()
		await server.close()
	}
})

app.get('/mcp', async (_, reply) => {
	reply.code(405).header('allow', 'POST').send({ error: 'Method not allowed. Use POST.' })
})

process.once('SIGINT', () => {
	void pgPool?.end()
	process.exit(0)
})
process.once('SIGTERM', () => {
	void pgPool?.end()
	process.exit(0)
})

if (existsSync(DIST_DIR)) {
	await app.register(fastifyStatic, {
		root: DIST_DIR,
		prefix: '/',
	})

	app.setNotFoundHandler((req, reply) => {
		if (req.raw.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/connect/')) {
			return reply.sendFile('index.html')
		}
		return reply.code(404).send({ error: 'Not found' })
	})
}

await app.listen({ host: '0.0.0.0', port: PORT })
