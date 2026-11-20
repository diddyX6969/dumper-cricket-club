use axum::{
    extract::{Path, State},
    http::{HeaderValue, Method, StatusCode},
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use rand::{rng, Rng};
use redis::{aio::ConnectionManager, AsyncCommands, Script};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, env, net::SocketAddr};
use tower_http::cors::{Any, CorsLayer};
use uuid::Uuid;

const SESSION_TTL_SECONDS: i64 = 60 * 60 * 24 * 30;

#[derive(Clone)]
struct AppState {
    redis: ConnectionManager,
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

#[derive(Deserialize)]
struct FranchiseRequest {
    session_token: String,
    owner_name: String,
    team_name: String,
}

#[derive(Serialize)]
struct LoginResponse {
    room_id: String,
    role: String,
    session_token: String,
    franchise_id: Option<Uuid>,
    needs_franchise_setup: bool,
}

#[derive(Serialize)]
struct RoomSummary {
    room_id: String,
    host_name: String,
    starting_purse_lakh: i32,
    status: String,
}

#[derive(Serialize, Deserialize)]
struct SessionRecord {
    room_id: String,
    role: String,
    franchise_id: Option<Uuid>,
    device_token: Option<Uuid>,
}

#[derive(Serialize, Deserialize)]
struct FranchiseRecord {
    id: Uuid,
    room_id: String,
    device_token: Uuid,
    owner_name: String,
    team_name: String,
    created_at: i64,
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

fn room_key(room_id: &str) -> String {
    format!("dcc:room:{}", room_id)
}
fn player_index_key(code: &str) -> String {
    format!("dcc:player-code:{}", code)
}
fn session_key(token_hash: &str) -> String {
    format!("dcc:session:{}", token_hash)
}
fn franchise_key(room_id: &str, device: Uuid) -> String {
    format!("dcc:franchise:{}:{}", room_id, device)
}
fn team_index_key(room_id: &str, team: &str) -> String {
    format!("dcc:team:{}:{}", room_id, hash(&team.trim().to_lowercase()))
}

async fn issue_session(
    redis: &mut ConnectionManager,
    room_id: &str,
    franchise_id: Option<Uuid>,
    device_token: Option<Uuid>,
    role: &str,
) -> anyhow::Result<String> {
    let token = new_session_token();
    let token_hash = hash(&token);
    let record = SessionRecord {
        room_id: room_id.to_owned(),
        role: role.to_owned(),
        franchise_id,
        device_token,
    };
    let payload = serde_json::to_string(&record)?;
    let _: () = redis
        .set_ex(session_key(&token_hash), payload, SESSION_TTL_SECONDS as u64)
        .await?;
    Ok(token)
}

async fn create_room(
    State(state): State<AppState>,
    Json(input): Json<CreateRoomRequest>,
) -> Result<Json<CreateRoomResponse>, (StatusCode, String)> {
    let host_name = input
        .host_name
        .unwrap_or_else(|| "Host".into())
        .trim()
        .chars()
        .take(80)
        .collect::<String>();
    let purse = input.starting_purse_lakh.unwrap_or(12_000).max(1);

    for _ in 0..64 {
        let room_id = new_room_id();
        let host_key = random_code(6);
        let player_join_code = random_code(10);
        let host_hash = hash(&format!("host|{}|{}", room_id, host_key));
        let player_hash = hash(&format!("player|{}", player_join_code));
        let created_at = Utc::now().timestamp();

        // Atomically reserve BOTH identifiers. No room can ever share a player code.
        let script = Script::new(
            r#"
            if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
            if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
            redis.call('HSET', KEYS[1],
              'room_id', ARGV[1],
              'host_key_hash', ARGV[2],
              'player_join_code', ARGV[3],
              'player_join_code_hash', ARGV[4],
              'host_name', ARGV[5],
              'starting_purse_lakh', ARGV[6],
              'status', 'open',
              'created_at', ARGV[7])
            redis.call('SET', KEYS[2], ARGV[1])
            return 1
            "#,
        );

        let mut conn = state.redis.clone();
        let created: i32 = script
            .key(room_key(&room_id))
            .key(player_index_key(&player_join_code))
            .arg(&room_id)
            .arg(&host_hash)
            .arg(&player_join_code)
            .arg(&player_hash)
            .arg(if host_name.is_empty() { "Host" } else { &host_name })
            .arg(purse)
            .arg(created_at)
            .invoke_async(&mut conn)
            .await
            .map_err(internal)?;

        if created != 1 {
            continue;
        }

        let host_session_token = issue_session(&mut conn, &room_id, None, None, "host")
            .await
            .map_err(internal)?;

        return Ok(Json(CreateRoomResponse {
            room_id,
            host_key,
            player_join_code,
            host_session_token,
        }));
    }

    Err((
        StatusCode::CONFLICT,
        "Could not allocate unique DCC credentials. Try again.".into(),
    ))
}

async fn host_login(
    State(state): State<AppState>,
    Json(input): Json<HostLoginRequest>,
) -> Result<Json<LoginResponse>, (StatusCode, String)> {
    let room_id = input.room_id.trim().to_uppercase();
    let host_key = input.host_key.trim().to_uppercase();

    let mut conn = state.redis.clone();
    let room: HashMap<String, String> = conn
        .hgetall(room_key(&room_id))
        .await
        .map_err(internal)?;

    if room.is_empty()
        || room.get("status").map(String::as_str) != Some("open")
        || room.get("host_key_hash")
            != Some(&hash(&format!("host|{}|{}", room_id, host_key)))
    {
        return Err((
            StatusCode::UNAUTHORIZED,
            "Invalid Room ID or Host Key".into(),
        ));
    }

    let session_token = issue_session(&mut conn, &room_id, None, None, "host")
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
    let mut conn = state.redis.clone();

    // Player code itself resolves to exactly ONE room.
    let room_id: Option<String> = conn
        .get(player_index_key(&player_code))
        .await
        .map_err(internal)?;
    let room_id = room_id.ok_or((
        StatusCode::UNAUTHORIZED,
        "Invalid Player Joining Code".into(),
    ))?;

    let room: HashMap<String, String> = conn
        .hgetall(room_key(&room_id))
        .await
        .map_err(internal)?;

    if room.is_empty()
        || room.get("status").map(String::as_str) != Some("open")
        || room.get("player_join_code_hash")
            != Some(&hash(&format!("player|{}", player_code)))
    {
        return Err((
            StatusCode::UNAUTHORIZED,
            "Invalid Player Joining Code".into(),
        ));
    }

    let existing: Option<String> = conn
        .get(franchise_key(&room_id, input.device_token))
        .await
        .map_err(internal)?;

    let franchise_id = existing
        .as_deref()
        .and_then(|json| serde_json::from_str::<FranchiseRecord>(json).ok())
        .map(|f| f.id);

    let session_token = issue_session(
        &mut conn,
        &room_id,
        franchise_id,
        Some(input.device_token),
        "player",
    )
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
    let mut conn = state.redis.clone();
    let token_hash = hash(&input.session_token);
    let session_json: Option<String> = conn
        .get(session_key(&token_hash))
        .await
        .map_err(internal)?;
    let session: SessionRecord = session_json
        .and_then(|v| serde_json::from_str(&v).ok())
        .filter(|s| s.role == "player")
        .ok_or((StatusCode::UNAUTHORIZED, "Invalid player session".into()))?;

    let device = session.device_token.ok_or((
        StatusCode::BAD_REQUEST,
        "Player session has no device identity".into(),
    ))?;

    if let Some(fid) = session.franchise_id {
        return Ok(Json(LoginResponse {
            room_id: session.room_id,
            role: "player".into(),
            session_token: input.session_token,
            franchise_id: Some(fid),
            needs_franchise_setup: false,
        }));
    }

    let owner_name = input.owner_name.trim().chars().take(80).collect::<String>();
    let team_name = input.team_name.trim().chars().take(80).collect::<String>();
    if owner_name.is_empty() || team_name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Owner and team name are required".into()));
    }

    let team_key = team_index_key(&session.room_id, &team_name);
    let franchise_id = Uuid::new_v4();

    // Reserve team name atomically inside this room.
    let reserved: bool = conn
        .set_nx(&team_key, franchise_id.to_string())
        .await
        .map_err(internal)?;
    if !reserved {
        return Err((
            StatusCode::CONFLICT,
            "That franchise name is already used in this room".into(),
        ));
    }

    let record = FranchiseRecord {
        id: franchise_id,
        room_id: session.room_id.clone(),
        device_token: device,
        owner_name,
        team_name,
        created_at: Utc::now().timestamp(),
    };
    let payload = serde_json::to_string(&record).map_err(internal)?;

    if let Err(e) = conn
        .set::<_, _, ()>(franchise_key(&session.room_id, device), payload)
        .await
    {
        let _: redis::RedisResult<()> = conn.del(&team_key).await;
        return Err(internal(e));
    }

    let updated_session = SessionRecord {
        franchise_id: Some(franchise_id),
        ..session
    };
    let _: () = conn
        .set_ex(
            session_key(&token_hash),
            serde_json::to_string(&updated_session).map_err(internal)?,
            SESSION_TTL_SECONDS as u64,
        )
        .await
        .map_err(internal)?;

    Ok(Json(LoginResponse {
        room_id: updated_session.room_id,
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
    let room_id = room_id.trim().to_uppercase();
    let mut conn = state.redis.clone();
    let room: HashMap<String, String> = conn
        .hgetall(room_key(&room_id))
        .await
        .map_err(internal)?;

    if room.is_empty() {
        return Err((StatusCode::NOT_FOUND, "Room not found".into()));
    }

    Ok(Json(RoomSummary {
        room_id,
        host_name: room
            .get("host_name")
            .cloned()
            .unwrap_or_else(|| "Host".into()),
        starting_purse_lakh: room
            .get("starting_purse_lakh")
            .and_then(|v| v.parse().ok())
            .unwrap_or(12_000),
        status: room
            .get("status")
            .cloned()
            .unwrap_or_else(|| "open".into()),
    }))
}

fn internal<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    let redis_url = env::var("REDIS_URL")?;
    let client = redis::Client::open(redis_url)?;
    let manager = ConnectionManager::new(client).await?;

    // Verify Redis before accepting traffic.
    let mut probe = manager.clone();
    let pong: String = redis::cmd("PING").query_async(&mut probe).await?;
    if pong != "PONG" {
        anyhow::bail!("Redis health check failed");
    }

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
        .with_state(AppState { redis: manager });

    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("DCC Redis auth server listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
