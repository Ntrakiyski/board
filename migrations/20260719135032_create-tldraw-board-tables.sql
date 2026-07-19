create table if not exists public.tldraw_boards (
	id text not null,
	workspace_id text not null references public.workspaces(id) on delete cascade,
	name text not null default '',
	visibility text not null default 'workspace' check (visibility in ('workspace')),
	created_by text not null,
	created_at text not null,
	updated_at text not null,
	deleted_at text,
	primary key (workspace_id, id)
);

create index if not exists tldraw_boards_workspace_updated_idx
	on public.tldraw_boards (workspace_id, updated_at desc)
	where deleted_at is null;

create table if not exists public.tldraw_board_snapshots (
	workspace_id text not null,
	board_id text not null,
	snapshot jsonb not null,
	document_clock bigint not null default 0,
	updated_by text not null,
	updated_at text not null,
	primary key (workspace_id, board_id),
	foreign key (workspace_id, board_id)
		references public.tldraw_boards(workspace_id, id)
		on delete cascade
);

create table if not exists public.tldraw_integration_tokens (
	id text primary key,
	workspace_id text not null references public.workspaces(id) on delete cascade,
	name text not null,
	token_hash text not null unique,
	role text not null default 'editor' check (role in ('viewer', 'editor')),
	created_by text not null,
	created_at text not null,
	last_used_at text,
	revoked_at text
);

create index if not exists tldraw_integration_tokens_workspace_idx
	on public.tldraw_integration_tokens (workspace_id, created_at desc)
	where revoked_at is null;
