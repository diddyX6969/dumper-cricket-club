use js_sys::Math;
use serde::Serialize;
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

const LETTERS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS: &[u8] = b"23456789";
const ALPHANUM: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

#[derive(Serialize)]
struct RoomCredentials {
    room_id: String,
    host_key: String,
    player_code: String,
    host_key_hash: String,
    player_code_hash: String,
}

fn random_index(max: usize) -> usize {
    (Math::random() * max as f64).floor() as usize
}

fn mixed_code(len: usize) -> String {
    let mut bytes = Vec::with_capacity(len.max(2));
    bytes.push(LETTERS[random_index(LETTERS.len())]);
    bytes.push(DIGITS[random_index(DIGITS.len())]);
    while bytes.len() < len {
        bytes.push(ALPHANUM[random_index(ALPHANUM.len())]);
    }

    // Fisher-Yates shuffle so letter/digit positions are not predictable.
    for i in (1..bytes.len()).rev() {
        let j = random_index(i + 1);
        bytes.swap(i, j);
    }
    String::from_utf8(bytes).expect("ASCII only")
}

fn clean_code(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

fn digest(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[wasm_bindgen]
pub fn generate_room_credentials() -> Result<JsValue, JsValue> {
    let room_id = format!("DCC-{}", mixed_code(6));
    let host_key = mixed_code(6);
    let player_code = mixed_code(10);

    let creds = RoomCredentials {
        host_key_hash: digest(&format!("host|{}|{}", room_id, host_key)),
        player_code_hash: digest(&format!("player|{}", player_code)),
        room_id,
        host_key,
        player_code,
    };

    serde_wasm_bindgen::to_value(&creds).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn generate_player_code() -> String {
    mixed_code(10)
}

#[wasm_bindgen]
pub fn normalize_room_id(input: &str) -> String {
    let upper = input.trim().to_ascii_uppercase();
    if let Some(rest) = upper.strip_prefix("DCC-") {
        format!("DCC-{}", clean_code(rest))
    } else {
        format!("DCC-{}", clean_code(&upper))
    }
}

#[wasm_bindgen]
pub fn normalize_code(input: &str) -> String {
    clean_code(input)
}

#[wasm_bindgen]
pub fn valid_room_id(input: &str) -> bool {
    let normalized = normalize_room_id(input);
    let suffix = normalized.strip_prefix("DCC-").unwrap_or_default();
    suffix.len() == 6 && suffix.chars().any(|c| c.is_ascii_alphabetic()) && suffix.chars().any(|c| c.is_ascii_digit())
}

#[wasm_bindgen]
pub fn valid_host_key(input: &str) -> bool {
    let code = clean_code(input);
    code.len() == 6 && code.chars().any(|c| c.is_ascii_alphabetic()) && code.chars().any(|c| c.is_ascii_digit())
}

#[wasm_bindgen]
pub fn valid_player_code(input: &str) -> bool {
    let code = clean_code(input);
    code.len() == 10 && code.chars().any(|c| c.is_ascii_alphabetic()) && code.chars().any(|c| c.is_ascii_digit())
}

#[wasm_bindgen]
pub fn host_key_hash(room_id: &str, host_key: &str) -> String {
    let room = normalize_room_id(room_id);
    let key = clean_code(host_key);
    digest(&format!("host|{}|{}", room, key))
}

#[wasm_bindgen]
pub fn player_code_hash(player_code: &str) -> String {
    digest(&format!("player|{}", clean_code(player_code)))
}

#[wasm_bindgen]
pub fn verify_host(room_id: &str, host_key: &str, expected_hash: &str) -> bool {
    valid_room_id(room_id) && valid_host_key(host_key) && host_key_hash(room_id, host_key) == expected_hash
}

#[wasm_bindgen]
pub fn verify_player(player_code: &str, expected_hash: &str) -> bool {
    valid_player_code(player_code) && player_code_hash(player_code) == expected_hash
}

#[wasm_bindgen]
pub fn network_secret(role: &str, identifier: &str, key: &str) -> String {
    digest(&format!("dcc-v1|{}|{}|{}", role, clean_code(identifier), clean_code(key)))
}
