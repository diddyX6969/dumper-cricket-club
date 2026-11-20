# Dumper Cricket Club (DCC)

A host-controlled cricket auction and match-simulation game designed to run from GitHub Pages.

## Current build
- Create Room / Join Room flow
- Host and franchise-owner roles
- 184-player IPL 2027 retained-player seed from the official IPL retention announcement
- Host-editable base prices
- Abhishek Sharma defaults to ₹2 Cr and Gurjapneet Singh defaults to ₹20 L as requested game values
- Timed auction with bid increments, purse validation, SOLD/UNSOLD host adjudication
- Custom player creation and removal
- Squad/purse board
- Random pitch generator and toss
- T20, ODI, T10, 5-over, Test-style session and custom-over simulation
- Host bias controls
- Playing XI paste boxes
- Ball-by-ball highlight simulation
- Brutal management roast + improvement advice
- IPL-style points table with NRR
- Best batter, bowler, MVP and team boards
- Browser persistence through localStorage
- Same-origin multi-tab synchronization via BroadcastChannel

## Networking
GitHub Pages is static hosting. The current build is a complete browser game and supports same-origin tab synchronization. Cross-device GitHub-only multiplayer requires peer-to-peer WebRTC signaling; that networking layer is the next pass.

## Player data
The seed follows the official TATA IPL 2027 retained-player list announced on 18 November 2026. DCC auction base prices are host-controlled game values, not official IPL salaries.

## Run
Enable GitHub Pages from the repository root, or open `index.html` locally.
