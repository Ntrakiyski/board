import React from 'react'
import ReactDOM from 'react-dom/client'
import {
	ClerkProvider,
	OrganizationSwitcher,
	SignIn,
	useAuth,
	useClerk,
	useOrganizationList,
	useUser,
} from '@clerk/clerk-react'
import { useSync } from '@tldraw/sync'
import {
	AssetRecordType,
	DefaultActionsMenu,
	DefaultActionsMenuContent,
	DefaultMainMenu,
	DefaultMainMenuContent,
	DefaultZoomMenu,
	getHashForString,
	TLComponents,
	TLAssetStore,
	TLBookmarkAsset,
	Tldraw,
	TldrawUiButtonIcon,
	TldrawUiMenuGroup,
	TldrawUiMenuItem,
	TldrawUiMenuSubmenu,
	TldrawUiToolbarButton,
	uniqueId,
	useToasts,
} from 'tldraw'
import 'tldraw/tldraw.css'
import './styles.css'

type BoardSummary = {
	id: string
	name: string
	createdAt: string
	updatedAt: string
	url: string
}

const AuthTokenContext = React.createContext<string | null>(null)

function useAuthToken() {
	const token = React.useContext(AuthTokenContext)
	if (!token) throw new Error('Missing Clerk token.')
	return token
}

function getRoomIdFromPath() {
	const [, prefix, rawRoomId] = window.location.pathname.split('/')
	if (prefix !== 'board' || !rawRoomId) return null
	return decodeURIComponent(rawRoomId)
}

function makeBoardUrl(roomId: string) {
	return `/board/${encodeURIComponent(roomId)}`
}

function makeAbsoluteBoardUrl(roomId: string) {
	return `${window.location.origin}${makeBoardUrl(roomId)}`
}

function getOrigin() {
	return window.location.origin
}

function getSocketUri(roomId: string, ticket: string) {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	return `${protocol}//${window.location.host}/connect/${encodeURIComponent(roomId)}?ticket=${encodeURIComponent(ticket)}`
}

const multiplayerAssets: TLAssetStore = {
	async upload(_asset, file) {
		const objectName = `${uniqueId()}-${file.name}`.replace(/[^a-zA-Z0-9_.-]/g, '_')
		const url = `${getOrigin()}/uploads/${encodeURIComponent(objectName)}`
		const response = await fetch(url, { method: 'PUT', body: file })
		if (!response.ok) throw new Error(`Failed to upload asset: ${response.statusText}`)
		return { src: url }
	},
	resolve(asset) {
		return asset.props.src
	},
}

async function unfurlBookmarkUrl({ url }: { url: string }): Promise<TLBookmarkAsset> {
	const asset: TLBookmarkAsset = {
		id: AssetRecordType.createId(getHashForString(url)),
		typeName: 'asset',
		type: 'bookmark',
		meta: {},
		props: {
			src: url,
			description: '',
			image: '',
			favicon: '',
			title: '',
		},
	}

	try {
		const response = await fetch(`${getOrigin()}/unfurl?url=${encodeURIComponent(url)}`)
		const data = await response.json()
		asset.props.description = data?.description ?? ''
		asset.props.image = data?.image ?? ''
		asset.props.favicon = data?.favicon ?? ''
		asset.props.title = data?.title ?? ''
	} catch (error) {
		console.error(error)
	}

	return asset
}

function createBoardId() {
	const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
	const suffix = Math.random().toString(36).slice(2, 7)
	return `board-${timestamp}-${suffix}`
}

function formatBoardDate(value: string) {
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return 'Unknown date'
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: 'short',
		timeStyle: 'short',
	}).format(date)
}

function getBoardLabel(board: BoardSummary) {
	return board.name || board.id.slice(0, 12)
}

function authHeaders(token: string, json = false) {
	const headers = new Headers()
	headers.set('authorization', `Bearer ${token}`)
	if (json) headers.set('content-type', 'application/json')
	return headers
}

async function fetchBoards(token: string) {
	const response = await fetch('/api/boards', { headers: authHeaders(token) })
	if (!response.ok) throw new Error(`Failed to load boards: ${response.statusText}`)
	const data = (await response.json()) as { boards?: BoardSummary[] | string[] }
	const boards = data.boards ?? []
	return boards.map((board) => {
		if (typeof board === 'string') {
			return {
				id: board,
				name: '',
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				url: makeBoardUrl(board),
			}
		}
		return board
	})
}

async function createSyncTicket(roomId: string, token: string) {
	const response = await fetch(`/api/sync-tickets/${encodeURIComponent(roomId)}`, {
		method: 'POST',
		headers: authHeaders(token),
	})
	if (!response.ok) throw new Error(`Failed to create sync ticket: ${response.statusText}`)
	const data = (await response.json()) as { ticket?: string }
	if (!data.ticket) throw new Error('Sync ticket response was empty.')
	return data.ticket
}

async function copyTextToClipboard(text: string) {
	if (navigator.clipboard?.writeText && window.isSecureContext) {
		await navigator.clipboard.writeText(text)
		return
	}

	const textarea = document.createElement('textarea')
	textarea.value = text
	textarea.setAttribute('readonly', '')
	textarea.style.position = 'fixed'
	textarea.style.top = '0'
	textarea.style.left = '-9999px'
	document.body.appendChild(textarea)
	textarea.select()

	try {
		if (!document.execCommand('copy')) {
			throw new Error('Copy command was rejected.')
		}
	} finally {
		document.body.removeChild(textarea)
	}
}

function NewBoardMenuItem() {
	return (
		<TldrawUiMenuItem
			id="new-board"
			icon="plus"
			label="New board"
			onSelect={() => {
				window.location.href = makeAbsoluteBoardUrl(createBoardId())
			}}
		/>
	)
}

function BoardListSubmenu() {
	const authToken = useAuthToken()
	const [boards, setBoards] = React.useState<BoardSummary[]>([])
	const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading')
	const [openActionsFor, setOpenActionsFor] = React.useState<string | null>(null)
	const currentRoomId = getRoomIdFromPath()

	React.useEffect(() => {
		let cancelled = false
		setStatus('loading')
		fetchBoards(authToken)
			.then((nextBoards) => {
				if (cancelled) return
				setBoards(nextBoards)
				setStatus('ready')
			})
			.catch((error) => {
				console.error(error)
				if (!cancelled) setStatus('error')
			})

		return () => {
			cancelled = true
		}
	}, [authToken])

	async function renameBoard(board: BoardSummary) {
		const nextName = window.prompt('Board name', board.name || board.id)
		if (nextName === null) return

		const response = await fetch(`/api/boards/${encodeURIComponent(board.id)}`, {
			method: 'PATCH',
			headers: authHeaders(authToken, true),
			body: JSON.stringify({ name: nextName }),
		})
		if (!response.ok) throw new Error(`Failed to rename board: ${response.statusText}`)
		const updated = (await response.json()) as BoardSummary
		setBoards((current) => current.map((item) => (item.id === updated.id ? updated : item)))
		setOpenActionsFor(null)
	}

	async function removeBoard(board: BoardSummary) {
		if (!window.confirm(`Delete "${getBoardLabel(board)}"?`)) return

		const response = await fetch(`/api/boards/${encodeURIComponent(board.id)}`, {
			method: 'DELETE',
			headers: authHeaders(authToken),
		})
		if (!response.ok) throw new Error(`Failed to delete board: ${response.statusText}`)
		setBoards((current) => current.filter((item) => item.id !== board.id))
		setOpenActionsFor(null)

		if (currentRoomId === board.id) {
			window.location.href = makeAbsoluteBoardUrl('personal-sketchbook')
		}
	}

	return (
		<TldrawUiMenuSubmenu id="view-boards" label="View boards" size="wide">
			<TldrawUiMenuGroup id="boards">
				<div className="board-list-menu" onPointerDown={(event) => event.stopPropagation()}>
					{status === 'loading' && <div className="board-list-state">Loading boards...</div>}
					{status === 'error' && <div className="board-list-state">Could not load boards.</div>}
					{status === 'ready' && boards.length === 0 && (
						<div className="board-list-state">No boards yet.</div>
					)}
					{status === 'ready' &&
						boards.map((board) => (
							<div
								className="board-list-row"
								data-current={currentRoomId === board.id}
								key={board.id}
								onClick={() => {
									window.location.href = makeAbsoluteBoardUrl(board.id)
								}}
							>
								<div className="board-list-row-main">
									<div className="board-list-row-name">{getBoardLabel(board)}</div>
									<div className="board-list-row-date">{formatBoardDate(board.createdAt)}</div>
								</div>
								<div className="board-list-row-actions">
									<button
										className="board-list-icon-button"
										type="button"
										aria-label={`Actions for ${getBoardLabel(board)}`}
										onClick={(event) => {
											event.stopPropagation()
											setOpenActionsFor((current) => (current === board.id ? null : board.id))
										}}
									>
										<TldrawUiButtonIcon icon="dots-horizontal" small />
									</button>
									{openActionsFor === board.id && (
										<div className="board-list-actions-menu" onClick={(event) => event.stopPropagation()}>
											<button type="button" onClick={() => renameBoard(board)}>
												Edit
											</button>
											<button type="button" onClick={() => removeBoard(board)}>
												Delete
											</button>
										</div>
									)}
								</div>
							</div>
						))}
				</div>
			</TldrawUiMenuGroup>
		</TldrawUiMenuSubmenu>
	)
}

function CreateIntegrationTokenMenuItem() {
	const authToken = useAuthToken()
	const { addToast } = useToasts()

	return (
		<TldrawUiMenuItem
			id="create-connections-token"
			icon="copy"
			label="Copy Connections token"
			onSelect={async () => {
				try {
					const response = await fetch('/api/integration-tokens', {
						method: 'POST',
						headers: authHeaders(authToken, true),
						body: JSON.stringify({ name: 'Connections', role: 'editor' }),
					})
					if (!response.ok) throw new Error(`Failed to create token: ${response.statusText}`)
					const data = (await response.json()) as { token?: string }
					if (!data.token) throw new Error('Token response was empty.')
					await copyTextToClipboard(data.token)
					addToast({
						id: 'connections-token-copied',
						icon: 'clipboard-copy',
						severity: 'success',
						title: 'Connections token copied',
					})
				} catch (error) {
					console.error(error)
					addToast({
						id: 'connections-token-failed',
						severity: 'error',
						title: 'Could not create Connections token',
					})
				}
			}}
		/>
	)
}

function OrganizationMenuControls() {
	const { orgId } = useAuth()
	const { openCreateOrganization, openOrganizationProfile } = useClerk()
	const { isLoaded, setActive, userMemberships } = useOrganizationList({
		userMemberships: {
			pageSize: 20,
			keepPreviousData: true,
		},
	})
	const { addToast } = useToasts()
	const memberships = userMemberships.data ?? []

	async function selectOrganization(organizationId: string) {
		if (!isLoaded || !setActive || organizationId === orgId) return

		try {
			await setActive({ organization: organizationId })
		} catch (error) {
			console.error(error)
			addToast({
				id: 'organization-switch-failed',
				severity: 'error',
				title: 'Could not switch workspace',
			})
		}
	}

	return (
		<TldrawUiMenuGroup id="clerk">
			<TldrawUiMenuSubmenu id="workspace" label="Workspace" size="wide">
				<TldrawUiMenuGroup id="workspace-actions">
					<TldrawUiMenuItem
						id="manage-organization"
						label="Manage organization"
						onSelect={() => openOrganizationProfile()}
					/>
					<TldrawUiMenuItem
						id="create-organization"
						label="Create organization"
						onSelect={() => openCreateOrganization()}
					/>
				</TldrawUiMenuGroup>
				<TldrawUiMenuGroup id="workspace-list">
					{!isLoaded && (
						<TldrawUiMenuItem id="workspace-loading" label="Loading workspaces..." disabled onSelect={() => {}} />
					)}
					{isLoaded && memberships.length === 0 && (
						<TldrawUiMenuItem id="workspace-empty" label="No workspaces found" disabled onSelect={() => {}} />
					)}
					{isLoaded &&
						memberships.map((membership) => (
							<TldrawUiMenuItem
								id={`workspace-${membership.organization.id}`}
								key={membership.organization.id}
								label={membership.organization.name}
								isSelected={membership.organization.id === orgId}
								onSelect={() => selectOrganization(membership.organization.id)}
							/>
						))}
				</TldrawUiMenuGroup>
			</TldrawUiMenuSubmenu>
		</TldrawUiMenuGroup>
	)
}

function openOrganizationMembers(openOrganizationProfile: ReturnType<typeof useClerk>['openOrganizationProfile']) {
	openOrganizationProfile({ __experimental_startPath: '/organization-members' })
}

function ProfileZoomButton() {
	const { openUserProfile } = useClerk()
	const { user } = useUser()
	const label = user?.fullName || user?.primaryEmailAddress?.emailAddress || 'Profile'
	const initials =
		(user?.firstName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? 'P').toUpperCase()

	return (
		<TldrawUiToolbarButton
			className="profile-zoom-button"
			data-testid="profile.button"
			type="icon"
			title={label}
			onClick={() => openUserProfile()}
		>
			{user?.imageUrl ? (
				<img className="profile-zoom-button-avatar" src={user.imageUrl} alt="" />
			) : (
				<span className="profile-zoom-button-fallback">{initials}</span>
			)}
		</TldrawUiToolbarButton>
	)
}

function BoardZoomMenu() {
	return (
		<>
			<ProfileZoomButton />
			<DefaultZoomMenu />
		</>
	)
}

function CopyBoardLinkButton() {
	const { addToast } = useToasts()
	const { openOrganizationProfile } = useClerk()
	const [copied, setCopied] = React.useState(false)
	const timeoutRef = React.useRef<number | null>(null)

	React.useEffect(() => {
		return () => {
			if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
		}
	}, [])

	return (
		<TldrawUiToolbarButton
			className={copied ? 'board-share-button board-share-button-copied' : 'board-share-button'}
			data-testid="copy-board-link.button"
			type="icon"
			title={copied ? 'Board link copied' : 'Copy board link'}
			onClick={async () => {
				try {
					await copyTextToClipboard(window.location.href)
					setCopied(true)
					addToast({
						id: 'board-link-copied',
						icon: 'clipboard-copy',
						severity: 'success',
						title: 'Board link copied',
					})
					if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
					timeoutRef.current = window.setTimeout(() => setCopied(false), 2200)
					openOrganizationMembers(openOrganizationProfile)
				} catch (error) {
					console.error(error)
					addToast({
						id: 'board-link-copy-failed',
						severity: 'error',
						title: 'Could not copy link',
						description: window.location.href,
					})
				}
			}}
		>
			<TldrawUiButtonIcon icon={copied ? 'check' : 'link'} small />
		</TldrawUiToolbarButton>
	)
}

function BoardMainMenu() {
	return (
		<DefaultMainMenu>
			<TldrawUiMenuGroup id="board">
				<NewBoardMenuItem />
				<BoardListSubmenu />
			</TldrawUiMenuGroup>
			<DefaultMainMenuContent />
			<TldrawUiMenuGroup id="board-integrations">
				<CreateIntegrationTokenMenuItem />
			</TldrawUiMenuGroup>
			<OrganizationMenuControls />
		</DefaultMainMenu>
	)
}

function BoardActionsMenu() {
	return (
		<>
			<CopyBoardLinkButton />
			<DefaultActionsMenu>
				<DefaultActionsMenuContent />
			</DefaultActionsMenu>
		</>
	)
}

const components: TLComponents = {
	MainMenu: BoardMainMenu,
	ActionsMenu: BoardActionsMenu,
	ZoomMenu: BoardZoomMenu,
}

function SyncedBoard({ roomId, syncUri }: { roomId: string; syncUri: string }) {
	const syncedStore = useSync({
		uri: syncUri,
		assets: multiplayerAssets,
	})

	if (syncedStore.status === 'loading') {
		return <AuthScreen title="Opening board" description="Connecting to the live board..." />
	}

	if (syncedStore.status === 'error') {
		return (
			<AuthScreen
				title="Board sync failed"
				description={syncedStore.error?.message ?? 'Could not connect to the live board.'}
			/>
		)
	}

	return (
		<main className="canvas-root">
			<Tldraw
				store={syncedStore.store}
				components={components}
				licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}
				autoFocus
				onMount={(editor) => {
					editor.registerExternalAssetHandler('url', unfurlBookmarkUrl)
				}}
			/>
		</main>
	)
}

function Board({ roomId, authToken, workspaceId }: { roomId: string; authToken: string; workspaceId: string }) {
	const [syncUri, setSyncUri] = React.useState<string | null>(null)
	const [error, setError] = React.useState<string | null>(null)

	React.useEffect(() => {
		let cancelled = false
		setSyncUri(null)
		setError(null)
		createSyncTicket(roomId, authToken)
			.then((ticket) => {
				if (!cancelled) setSyncUri(getSocketUri(roomId, ticket))
			})
			.catch((caught: unknown) => {
				if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not connect to board.')
			})

		return () => {
			cancelled = true
		}
	}, [roomId, authToken, workspaceId])

	if (error) {
		return <AuthScreen title="Board unavailable" description={error} />
	}
	if (!syncUri) {
		return <AuthScreen title="Opening board" description="Preparing a secure sync session..." />
	}

	return (
		<AuthTokenContext.Provider value={authToken}>
			<SyncedBoard roomId={roomId} syncUri={syncUri} />
		</AuthTokenContext.Provider>
	)
}

function BoardApp({ authToken, workspaceId }: { authToken: string; workspaceId: string }) {
	const roomId = getRoomIdFromPath()
	if (!roomId) {
		window.history.replaceState(null, '', makeBoardUrl('personal-sketchbook'))
		return (
			<Board
				key={`${workspaceId}:personal-sketchbook`}
				roomId="personal-sketchbook"
				authToken={authToken}
				workspaceId={workspaceId}
			/>
		)
	}
	return (
		<Board
			key={`${workspaceId}:${roomId}`}
			roomId={roomId}
			authToken={authToken}
			workspaceId={workspaceId}
		/>
	)
}

function AuthenticatedApp() {
	const { isLoaded, isSignedIn, orgId, getToken } = useAuth()
	const [authToken, setAuthToken] = React.useState<string | null>(null)
	const [error, setError] = React.useState<string | null>(null)

	React.useEffect(() => {
		if (!isLoaded || !isSignedIn || !orgId) {
			setAuthToken(null)
			return
		}

		let cancelled = false
		setAuthToken(null)
		setError(null)
		getToken({ organizationId: orgId, skipCache: true })
			.then((token) => {
				if (cancelled) return
				if (!token) {
					setError('Could not get a Clerk token for this workspace.')
					return
				}
				setAuthToken(token)
			})
			.catch((caught: unknown) => {
				if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not authenticate.')
			})

		return () => {
			cancelled = true
		}
	}, [getToken, isLoaded, isSignedIn, orgId])

	if (!isLoaded) return <AuthScreen title="Loading" description="Checking your session..." />
	if (!isSignedIn) {
		return (
			<main className="auth-root">
				<SignIn forceRedirectUrl={window.location.href} signUpForceRedirectUrl={window.location.href} />
			</main>
		)
	}
	if (!orgId) {
		return (
			<AuthScreen title="Choose a workspace" description="Select or create an organization to continue.">
				<OrganizationSwitcher
					hidePersonal
					defaultOpen
					afterCreateOrganizationUrl={window.location.href}
					afterSelectOrganizationUrl={window.location.href}
				/>
			</AuthScreen>
		)
	}
	if (error) return <AuthScreen title="Authentication failed" description={error} />
	if (!authToken) return <AuthScreen title="Loading workspace" description="Preparing your workspace..." />

	return <BoardApp key={orgId} authToken={authToken} workspaceId={orgId} />
}

function AuthScreen(props: { title: string; description: string; children?: React.ReactNode }) {
	return (
		<main className="auth-root">
			<section className="auth-panel">
				<h1>{props.title}</h1>
				<p>{props.description}</p>
				{props.children}
			</section>
		</main>
	)
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
	<React.StrictMode>
		<ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? ''}>
			<AuthenticatedApp />
		</ClerkProvider>
	</React.StrictMode>
)
