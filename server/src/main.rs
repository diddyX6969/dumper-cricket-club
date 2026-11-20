use axum::{
    extract::{Path, State},
    http::{HeaderValue, Method, StatusCode},
    routing::{get, post},
    Json, Router,
};
use chrono::{Duration, Utc};
use rand::{rng, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::{env, net::SocketAddr};
use tower_http::cors::{Any, CorsLayer};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    db: PgPool,
}

#[derive(Deserialize)]
struct CreateRoomRequest {
    host_name: Option<String>,
    starting_purse_lakh: Option<i32>,
}

#[derive(Serialize)]
struct CreateRoomResponse {
    room_id: String,
    host_key: String,
    player_join_code: String,
    host_session_token: String,
}

#[derive(Deserialize)]
struct HostLoginRequest {
    room_id: String,
    host_key: String,
}

#[derive(Deserialize)]
struct PlayerLoginRequest {
    player_join_code: String,
    device_token: Uuid,
}

#[derive(Serialize)]
struct LoginResponse {
    room_id: String,
    role: String,
    session_token: String,
    franchise_id: Option<Uuid>,
    needs_franchise_setup: bool,
}

#[derive(Deserialize)]
struct FranchiseRequest {
    session_token: String,
    owner_name: String,
    team_name: String,
}

#[derive(Serialize)]
struct RoomSummary {
    room_id: String,
    host_name: String,
    starting_purse_lakh: i32,
    status: String,
}

fn hash(input: &str) -> String {
    let mut h = Sha256::new();
    h.update(input.as_bytes());
    hex::encode(h.finalize())
}

fn random_code(len: usize) -> String {
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut r = rng();
    (0..len)
        .map(|_| CHARS[r.random_range(0..CHARS.len())] as char)
        .collect()
}

fn new_room_id() -> String {
    format!("DCC-{}", random_code(6))
}

fn new_session_token() -> String {
    format!("dcc_{}", Uuid::new_v4().simple())
}

async fn issue_session(
    db: &PgPool,
    room_db_id: Uuid,
    franchise_id: Option<Uuid>,
    device_token: Option<Uuid>,
    role: &str,
) -> anyhow::Result<String> {
    let token = new_session_token();
    let token_hash = hash(&token);
    let expires_at = Utc::now() + Duration::days(30);

    sqlx::query(
        "INSERT INTO sessions (room_db_id, franchise_id, device_token, role, token_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)"
    )
    .bind(room_db_id)
    .bind(franchise_id)
    .bind(device_token)
    .bind(role)
    .bind(token_hash)
    .bind(expires_at)
    .execute(db)
    .await?;

    Ok(token)
}

async fn create_room(
    State(state): State<AppState>,
    Json(input): Json<CreateRoomRequest>,
) -> Result<Json<CreateRoomResponse>, (StatusCode, String)> {
    for _ in 0..20 {
        let room_id = new_room_id();
        let host_key = random_code(6);
        let player_join_code = random_code(10);

        let result = sqlx::query(
            "INSERT INTO rooms
             (room_id, host_key_hash, player_join_code, player_join_code_hash, host_name, starting_purse_lakh)
             VALUES ($1,$2,$3,$4,$5,$6)
             RETURNING id"
        )
        .bind(&room_id)
        .bind(hash(&format!("host|{}|{}", room_id, host_key)))
        .bind(&player_join_code)
        .bind(hash(&format!("player|{}", player_join_code)))
        .bind(input.host_name.clone().unwrap_or_else(|| "Host".into()))
        .bind(input.starting_purse_lakh.unwrap_or(12_000).max(1))
        .fetch_one(&state.db)
        .await;

        match result {
            Ok(row) => {
                let room_db_id: Uuid = row.get("id");
                let host_session_token = issue_session(&state.db, room_db_id, None, None, "host")
                    .await
                    .map_err(internal)?;

                return Ok(Json(CreateRoomResponse {
                    room_id,
                    host_key,
                    player_join_code,
                    host_session_token,
                }));
            }
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => continue,
            Err(e) => return Err(internal(e)),
        }
    }

    Err((StatusCode::CONFLICT, "Could not allocate a unique room code".into()))
}

async fn host_login(
    State(state): State<AppState>,
    Json(input): Json<HostLoginRequest>,
) -> Result<Json<LoginResponse>, (StatusCode, String)> {
    let room_id = input.room_id.trim().to_uppercase();
    let host_key = input.host_key.trim().to_uppercase();
    let expected = hash(&format!("host|{}|{}", room_id, host_key));

    let row = sqlx::query(
        "SELECT id, room_id FROM rooms
         WHERE room_id=$1 AND host_key_hash=$2 AND status='open'"
    )
    .bind(&room_id)
    .bind(expected)
    .fetch_optional(&state.db)
    .await
    .map_err(internal)?
    .ok_or((StatusCode::UNAUTHORIZED, "Invalid Room ID or Host Key".into()))?;

    let room_db_id: Uuid = row.get("id");
    let session_token = issue_session(&state.db, room_db_id, None, "host")
        .await
        .map_err(internal)?;

    Ok(Json(LoginResponse {
        room_id,
        role: "host".into(),
        session_token,
        franchise_id: None,
        needs_franchise_setup: false,
    }))
}

async fn player_login(
    State(state): State<AppState>,
    Json(input): Json<PlayerLoginRequest>,
) -> Result<Json<LoginResponse>, (StatusCode, String)> {
    let player_code = input.player_join_code.trim().to_uppercase();

    let room = sqlx::query(
        "SELECT id, room_id FROM rooms
         WHERE player_join_code=$1 AND player_join_code_hash=$2 AND status='open'"
    )
    .bind(&player_code)
    .bind(hash(&format!("player|{}", player_code)))
    .fetch_optional(&state.db)
    .await
    .map_err(internal)?
    .ok_or((StatusCode::UNAUTHORIZED, "Invalid Player Joining Code".into()))?;

    let room_db_id: Uuid = room.get("id");
    let room_id: String = room.get("room_id");

    let franchise = sqlx::query(
        "SELECT id FROM franchises WHERE room_db_id=$1 AND device_token=$2"
    )
    .bind(room_db_id)
    .bind(input.device_token)
    .fetch_optional(&state.db)
    .await
    .map_err(internal)?;

    let franchise_id = franchise.map(|r| r.get::<Uuid, _>("id"));
    let session_token = issue_session(&state.db, room_db_id, franchise_id, Some(input.device_token), "player")
        .await
        .map_err(internal)?;

    Ok(Json(LoginResponse {
        room_id,
        role: "player".into(),
        session_token,
        franchise_id,
        needs_franchise_setup: franchise_id.is_none(),
    }))
}

async fn create_franchise(
    State(state): State<AppState>,
    Json(input): Json<FranchiseRequest>,
) -> Result<Json<LoginResponse>, (StatusCode, String)> {
    let token_hash = hash(&input.session_token);

    let session = sqlx::query(
        "SELECT s.id, s.room_db_id, s.franchise_id, s.device_token, s.expires_at, r.room_id
         FROM sessions s
         JOIN rooms r ON r.id=s.room_db_id
         WHERE s.token_hash=$1 AND s.role='player' AND s.expires_at > NOW()"
    )
    .bind(token_hash)
    .fetch_optional(&state.db)
    .await
    .map_err(internal)?
    .ok_or((StatusCode::UNAUTHORIZED, "Invalid player session".into()))?;

    let session_id: Uuid = session.get("id");
    let room_db_id: Uuid = session.get("room_db_id");
    let room_id: String = session.get("room_id");
    let device_token: Uuid = session.get::<Option<Uuid>, _>("device_token")
        .ok_or((StatusCode::BAD_REQUEST, "Player session has no device identity".into()))?;

    if let Some(fid) = session.get::<Option<Uuid>, _>("franchise_id") {
        return Ok(Json(LoginResponse {
            room_id,
            role: "player".into(),
            session_token: input.session_token,
            franchise_id: Some(fid),
            needs_franchise_setup: false,
        }));
    }

    let inserted = sqlx::query(
        "INSERT INTO franchises (room_db_id, device_token, owner_name, team_name)
         VALUES ($1,$2,$3,$4)
         RETURNING id"
    )
    .bind(room_db_id)
    .bind(device_token)
    .bind(input.owner_name.trim())
    .bind(input.team_name.trim())
    .fetch_one(&state.db)
    .await;

    let row = match inserted {
        Ok(row) => row,
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err((StatusCode::CONFLICT, "That franchise name is already used in this room".into()));
        }
        Err(e) => return Err(internal(e)),
    };

    let franchise_id: Uuid = row.get("id");
    sqlx::query("UPDATE sessions SET franchise_id=$1 WHERE id=$2")
        .bind(franchise_id)
        .bind(session_id)
        .execute(&state.db)
        .await
        .map_err(internal)?;

    Ok(Json(LoginResponse {
        room_id,
        role: "player".into(),
        session_token: input.session_token,
        franchise_id: Some(franchise_id),
        needs_franchise_setup: false,
    }))
}

async fn room_summary(
    State(state): State<AppState>,
    Path(room_id): Path<String>,
) -> Result<Json<RoomSummary>, (StatusCode, String)> {
    let row = sqlx::query(
        "SELECT room_id, host_name, starting_purse_lakh, status
         FROM rooms WHERE room_id=$1"
    )
    .bind(room_id.to_uppercase())
    .fetch_optional(&state.db)
    .await
    .map_err(internal)?
    .ok_or((StatusCode::NOT_FOUND, "Room not found".into()))?;

    Ok(Json(RoomSummary {
        room_id: row.get("room_id"),
        host_name: row.get("host_name"),
        starting_purse_lakh: row.get("starting_purse_lakh"),
        status: row.get("status"),
    }))
}

fn internal<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    let database_url = env::var("DATABASE_URL")?;
    let db = PgPool::connect(&database_url).await?;
    sqlx::migrate!("./migrations").run(&db).await?;

    let frontend_origin = env::var("FRONTEND_ORIGIN")
        .unwrap_or_else(|_| "https://diddyx6969.github.io".into());
    let origin: HeaderValue = frontend_origin.parse()?;

    let cors = CorsLayer::new()
        .allow_origin(origin)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/api/rooms", post(create_room))
        .route("/api/login/host", post(host_login))
        .route("/api/login/player", post(player_login))
        .route("/api/franchises", post(create_franchise))
        .route("/api/rooms/{room_id}", get(room_summary))
        .layer(cors)
        .with_state(AppState { db });

    let port: u16 = env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8080);
    let addr = SocketAddr::from(([0,0,0,0], port));
    println!("DCC auth server listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
