CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id VARCHAR(16) NOT NULL UNIQUE,
    host_key_hash CHAR(64) NOT NULL,
    player_join_code VARCHAR(10) NOT NULL UNIQUE,
    player_join_code_hash CHAR(64) NOT NULL,
    host_name VARCHAR(80) NOT NULL DEFAULT 'Host',
    starting_purse_lakh INTEGER NOT NULL DEFAULT 12000 CHECK (starting_purse_lakh > 0),
    status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rooms_player_join_code
    ON rooms(player_join_code);

CREATE TABLE IF NOT EXISTS franchises (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_db_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    device_token UUID NOT NULL,
    owner_name VARCHAR(80) NOT NULL,
    team_name VARCHAR(80) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(room_db_id, device_token),
    UNIQUE(room_db_id, team_name)
);

CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_db_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    franchise_id UUID REFERENCES franchises(id) ON DELETE CASCADE,
    role VARCHAR(10) NOT NULL CHECK (role IN ('host','player')),
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_room_role
    ON sessions(room_db_id, role);
