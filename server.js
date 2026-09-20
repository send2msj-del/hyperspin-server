const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();

// Enable full cross-origin resource sharing for APK webview authorization
app.use(cors({
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
}));

const server = http.createServer(app);

// Configure Socket.IO with global CORS rules and explicit fallbacks
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

app.use(express.json());

// --- FIXED ROUTING RULES ---

// 1. Root Endpoint: Displays all game state data when hitting "/"
app.get('/', (req, res) => {
    const activePlayers = Object.values(players).filter(p => !p.dead);
    const activeBots = bots.filter(b => !b.dead);

    res.json({
        total_entities: activePlayers.length + activeBots.length,
        total_dots: dots.filter(d => d.active).length,
        total_boosters: boosters.length, // NEW: Total booster count
        player_and_bot_data: [
            ...activePlayers.map(p => ({ id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y), rpm: Math.floor(p.rpm), type: 'player' })),
            ...activeBots.map(b => ({ id: b.id, name: b.name, x: Math.round(b.x), y: Math.round(b.y), rpm: Math.floor(b.rpm), type: 'bot' }))
        ],
        boosters: boosters.map(b => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), radius: b.radius })), // NEW: Diagnostic mapping for pads
        dots: dots.filter(d => d.active).map(d => ({ x: Math.round(d.x), y: Math.round(d.y), value: d.value })), 
        personal_message: "Main arena diagnostics active with Whirlwind Boosters."
    });
});

// 2. Client Endpoint: Serves your actual client file if you navigate to "/play"
app.get('/play', (req, res) => {
    res.sendFile(path.join(__dirname + '/index.html'));
});


// --- GAME STATE VARIABLES & MECHANICS ---
const MAP_SIZE = 3000;
let players = {};
let bots = [];
let dots = []; 
let boosters = []; // NEW: Array to hold booster objects

// Initialize Spinz.io Boosters
const MAX_BOOSTERS = 18; 
for (let i = 0; i < MAX_BOOSTERS; i++) {
    boosters.push({
        id: 'boost_' + i,
        x: Math.random() * (MAP_SIZE - 400) + 200, // keep them slightly away from edge borders
        y: Math.random() * (MAP_SIZE - 400) + 200,
        radius: 45 // physical hit radius for the pad
    });
}
// How many server ticks (30ms each) to hold a spinner on a booster pad
const HOLD_TICKS = 6; // ~8 * 33ms ~= 264ms

// Initialize static food grid
for (let i = 0; i < 450; i++) {
    dots.push(createNewDot(Math.random() * MAP_SIZE, Math.random() * MAP_SIZE, 1, 0, Infinity));
}

// Initialize starting bots
const MAX_BOTS = 7;
for (let i = 0; i < MAX_BOTS; i++) {
    spawnBot();
}

function createNewDot(x, y, value, immuneTime = 0, maxLifespan = Infinity) {
    return {
        id: Math.random().toString(36).substr(2, 9),
        x: x, y: y,
        vx: 0, vy: 0,
        value: value,
        color: `hsl(${Math.floor(Math.random() * 360)}, 100%, 50%)`,
        targetId: null,
        immune: immuneTime,
        lifespan: maxLifespan, 
        active: true
    };
}

function spawnBot() {
    const botId = 'bot_' + Math.random().toString(36).substr(2, 9);
    let activePlayers = Object.values(players).filter(p => !p.dead);
    
    let targetSpawnRPM = 40;
    if (activePlayers.length > 0) {
        let maxHumanRPM = Math.max(...activePlayers.map(p => p.rpm || 0));
        targetSpawnRPM = maxHumanRPM / 3.0;
    }
 
    const newBot = {
        id: botId,
        name: botId, 
        x: Math.random() * MAP_SIZE,
        y: Math.random() * MAP_SIZE,
        rpm: Math.max(40, Math.floor(targetSpawnRPM)), 
        angle: Math.random() * Math.PI * 2,
        targetAngle: Math.random() * Math.PI * 2,
        vx: 0, vy: 0,
        holdTicks: 0,
        isBoosting: false,
        boostCooldown: 0, // NEW: Prevent instant re-triggering on pads
        dead: false,
        color: ('#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')),
        isBot: true
    };

    bots.push(newBot);
}

function spewRecycledDots(x, y, amount) {
    if (amount <= 0) return;
    let dotsToSpew = Math.min(25, Math.max(6, Math.floor(amount / 5)));
    let valuePerDot = amount / dotsToSpew;
    let spawned = 0;

    for (let i = 0; i < dots.length; i++) {
        if (!dots[i].active) {
            setupSpewedDot(dots[i], x, y, valuePerDot);
            dots[i].lifespan = 600; 
            spawned++;
            if (spawned >= dotsToSpew) return;
        }
    }

    while (spawned < dotsToSpew) {
        let newDot = createNewDot(x, y, valuePerDot, 25, 600); 
        setupSpewedDot(newDot, x, y, valuePerDot);
        dots.push(newDot);
        spawned++;
    }
}

function setupSpewedDot(dot, x, y, value) {
    let angle = Math.random() * Math.PI * 2;
    let speed = 7 + Math.random() * 12;
    dot.x = x;
    dot.y = y;
    dot.vx = Math.cos(angle) * speed;
    dot.vy = Math.sin(angle) * speed;
    dot.value = value;
    dot.targetId = null;
    dot.immune = 25; 
    dot.active = true;
}

// --- NETWORK CONTROLLERS ---
io.on('connection', (socket) => {
    console.log(`[Socket.IO] Handshaking connection: ${socket.id}`);

    socket.on('respawn', (data) => {
        let clientName = (data && data.name) ? data.name.trim().substring(0, 12) : "Spinner";
        
        players[socket.id] = {
            id: socket.id,     
            name: clientName,   
            x: Math.random() * MAP_SIZE,
            y: Math.random() * MAP_SIZE,
            rpm: 40,
            angle: 0,
            targetAngle: 0,
            vx: 0, vy: 0,
            holdTicks: 0,
            isBoosting: false,
            boostCooldown: 0, // NEW: Prevent instant re-triggering on pads
            dead: false,
            color: `hsl(${Math.random() * 360}, 90%, 50%)`
        };

        socket.emit('spawned', { assignedId: socket.id });
    });

    socket.on('input', (data) => {
        let p = players[socket.id];
        if (p && !p.dead) {
            p.targetAngle = typeof data.angle === 'number' ? data.angle : p.targetAngle;
            p.isBoosting = !!data.isBoosting;
        }
    });

    socket.on('disconnect', () => { 
        console.log(`[Socket.IO] Connection dropped: ${socket.id}`);
        delete players[socket.id]; 
    });
});

// --- ENGINE MATRIX TICK (30ms) ---
setInterval(() => {
    let activePlayers = Object.values(players).filter(p => !p.dead);
    let activeBots = bots.filter(b => !b.dead);
    let allSpinners = [...activePlayers, ...activeBots];

    // --- BOTS RUNTIME ---
    activeBots.forEach(b => {
        b.radius = 20 + Math.log10(Math.max(1, b.rpm)) * 5;
        b.targetAngle += (Math.random() - 0.5) * 1.0;
        b.isBoosting = Math.random() > 0.98;

        if (b.boostCooldown > 0) b.boostCooldown--;

        // If bot is being held by a booster pad, count down the hold ticks
        if (b.holdTicks > 0) {
            b.holdTicks--;
            if (b.holdTicks > 0) {
                // Smoothly move the bot toward the booster core using precomputed step
                if (typeof b.holdStepX === 'number' && typeof b.holdStepY === 'number') {
                    b.x += b.holdStepX;
                    b.y += b.holdStepY;
                } else {
                    // Fallback: small lerp toward target
                    let tx = (b.holdTargetX !== undefined) ? b.holdTargetX : b.x;
                    let ty = (b.holdTargetY !== undefined) ? b.holdTargetY : b.y;
                    let dx = tx - b.x; let dy = ty - b.y;
                    b.x += dx * 0.25; b.y += dy * 0.25;
                }
                b.vx = 0; b.vy = 0;
                b.angle += (b.rpm * 0.04);
                return; // skip normal steering while held
            } else {
                // hold ended — launch bot in the aimed direction
                let angle = b.targetAngle;
                b.vx = Math.cos(angle) * 26;
                b.vy = Math.sin(angle) * 26;
                b.boostCooldown = 30;
                delete b.holdStepX; delete b.holdStepY; delete b.holdTargetX; delete b.holdTargetY;
            }
        }

        // Calculate normal steering velocity
        let speed = b.isBoosting && b.rpm > 15 ? 8.5 : 4.0;
        if (b.isBoosting && b.rpm > 15) {
            b.rpm = Math.max(15, b.rpm * 0.99995); 
        }

        // Apply friction or steering weight
        let weight = b.boostCooldown > 15 ? 0.95 : 0.7; // Lower control when shot out of a booster
        b.vx = b.vx * weight + (Math.cos(b.targetAngle) * speed) * (1 - weight);
        b.vy = b.vy * weight + (Math.sin(b.targetAngle) * speed) * (1 - weight);
        b.x += b.vx; b.y += b.vy;
        
        if (b.x < b.radius || b.x > MAP_SIZE - b.radius) {
            b.targetAngle = Math.PI - b.targetAngle;
            b.x = Math.max(b.radius, Math.min(MAP_SIZE - b.radius, b.x));
            b.vx *= -0.5; // Bounce slightly off walls if boosted
        }
        if (b.y < b.radius || b.y > MAP_SIZE - b.radius) {
            b.targetAngle = -b.targetAngle;
            b.y = Math.max(b.radius, Math.min(MAP_SIZE - b.radius, b.y));
            b.vy *= -0.5;
        }

        b.angle += (b.rpm * 0.04);
    });

    // --- PLAYERS RUNTIME ---
    activePlayers.forEach(s => {
        s.radius = 20 + Math.log10(Math.max(1, s.rpm)) * 5;
        
        if (s.boostCooldown > 0) s.boostCooldown--;

        // If player is being held by a booster pad, count down the hold ticks
        if (s.holdTicks > 0) {
            s.holdTicks--;
            if (s.holdTicks > 0) {
                // Smoothly move the player toward the booster core using precomputed step
                if (typeof s.holdStepX === 'number' && typeof s.holdStepY === 'number') {
                    s.x += s.holdStepX;
                    s.y += s.holdStepY;
                } else {
                    // Fallback: small lerp toward target
                    let tx = (s.holdTargetX !== undefined) ? s.holdTargetX : s.x;
                    let ty = (s.holdTargetY !== undefined) ? s.holdTargetY : s.y;
                    let dx = tx - s.x; let dy = ty - s.y;
                    s.x += dx * 0.25; s.y += dy * 0.25;
                }
                s.vx = 0; s.vy = 0; // preserve zero velocity while held
                s.angle += (s.rpm * 0.04);
                return; // skip normal steering while held
            } else {
                // hold ended — launch player in the aimed direction (uses latest targetAngle from client)
                let angle = s.targetAngle;
                s.vx = Math.cos(angle) * 26;
                s.vy = Math.sin(angle) * 26;
                s.boostCooldown = 30;
                delete s.holdStepX; delete s.holdStepY; delete s.holdTargetX; delete s.holdTargetY;
            }
        }

        let speed = 4.0;
        if (s.isBoosting && s.rpm > 15) {
            speed = 8.5;
            s.rpm = Math.max(15, s.rpm * 0.99995); 
        }

        // Steer interpolator
        let weight = s.boostCooldown > 15 ? 0.95 : 0.7; // Drift setting if shot through booster
        s.vx = s.vx * weight + (Math.cos(s.targetAngle) * speed) * (1 - weight);
        s.vy = s.vy * weight + (Math.sin(s.targetAngle) * speed) * (1 - weight);
        
        s.x += s.vx; 
        s.y += s.vy;
        
        if (s.x < s.radius || s.x > MAP_SIZE - s.radius) {
            s.x = Math.max(s.radius, Math.min(MAP_SIZE - s.radius, s.x));
            s.vx *= -0.5;
        }
        if (s.y < s.radius || s.y > MAP_SIZE - s.radius) {
            s.y = Math.max(s.radius, Math.min(MAP_SIZE - s.radius, s.y));
            s.vy *= -0.5;
        }
        s.angle += (s.rpm * 0.04);
    });

    // --- NEW: BOOSTER PAD COLLISION DETECTOR ---
    allSpinners.forEach(s => {
        boosters.forEach(b => {
            // Only trigger if not already in cooldown or currently held
            if (s.boostCooldown === 0 && (!s.holdTicks || s.holdTicks === 0)) {
                let dist = Math.hypot(s.x - b.x, s.y - b.y);
                // Trigger when center overlaps the pad radius
                if (dist < b.radius + (s.radius / 3)) {
                    // Begin a short hold, allowing aim input to update on client
                    s.holdTicks = HOLD_TICKS;
                    // Precompute per-tick step so spinner is smoothly pulled to center over the hold duration
                    s.holdTargetX = b.x; s.holdTargetY = b.y;
                    s.holdStepX = (b.x - s.x) / HOLD_TICKS;
                    s.holdStepY = (b.y - s.y) / HOLD_TICKS;
                    s.vx = 0; s.vy = 0; // lock velocity while being pulled
                    // Set a combined cooldown to include the hold period + post-boost immunity
                    s.boostCooldown = HOLD_TICKS + 30; // hold + 30 ticks (~1s) immunity after launch
                }
            }
        });
    });

    // --- VECTOR ABSORPTION (DOTS) ---
    let activeMapDots = 0;
    for (let i = 0; i < dots.length; i++) {
        let dot = dots[i];
        if (!dot.active) continue;

        if (dot.lifespan !== Infinity) {
            dot.lifespan--;
            if (dot.lifespan <= 0) { dot.active = false; continue; }
        }

        activeMapDots++;
        if (dot.immune > 0) dot.immune--;

        dot.x += dot.vx; dot.y += dot.vy;
        dot.vx *= 0.9; dot.vy *= 0.9;

        let dotRadius = 4; 
        if (dot.x < dotRadius) { dot.x = dotRadius; dot.vx *= -1.2; dot.targetId = null; }
        if (dot.x > MAP_SIZE - dotRadius) { dot.x = MAP_SIZE - dotRadius; dot.vx *= -1.2; dot.targetId = null; }
        if (dot.y < dotRadius) { dot.y = dotRadius; dot.vy *= -1.2; dot.targetId = null; }
        if (dot.y > MAP_SIZE - dotRadius) { dot.y = MAP_SIZE - dotRadius; dot.vy *= -1.2; dot.targetId = null; }

        if (!dot.targetId && dot.immune <= 0) {
            let closestDist = Infinity;
            let closestSpinner = null;
            allSpinners.forEach(s => {
                let dist = Math.hypot(s.x - dot.x, s.y - dot.y);
                let suctionRange = s.radius + 40; 
                if (dist < suctionRange && dist < closestDist) {
                    closestDist = dist;
                    closestSpinner = s;
                }
            });
            if (closestSpinner) dot.targetId = closestSpinner.id;
        }

        if (dot.targetId) {
            let target = players[dot.targetId] || bots.find(b => b.id === dot.targetId);
            if (target && !target.dead) {
                let dx = target.x - dot.x;
                let dy = target.y - dot.y;
                let dist = Math.hypot(dx, dy);

                if (dist < target.radius) {
                    target.rpm += dot.value;
                    dot.active = false; 
                } else {
                    dot.vx = (dx / dist) * 14; 
                    dot.vy = (dy / dist) * 14;
                }
            } else {
                dot.targetId = null; 
            }
        }
    }

    if (activeMapDots < 350) {
        for (let i = 0; i < dots.length; i++) {
            if (!dots[i].active) {
                dots[i].x = Math.random() * MAP_SIZE;
                dots[i].y = Math.random() * MAP_SIZE;
                dots[i].vx = 0; dots[i].vy = 0;
                dots[i].value = 1;
                dots[i].targetId = null;
                dots[i].immune = 0;
                dots[i].lifespan = Infinity; 
                dots[i].active = true;
                break;
            }
        }
    }

    // --- SPINZ COLLISION COMBAT ---
    for (let i = 0; i < allSpinners.length; i++) {
        for (let j = i + 1; j < allSpinners.length; j++) {
            let s1 = allSpinners[i];
            let s2 = allSpinners[j];
            if (s1.dead || s2.dead) continue;

            let dx = s2.x - s1.x;
            let dy = s2.y - s1.y;
            let dist = Math.hypot(dx, dy);
            let minDist = s1.radius + s2.radius;

            if (dist < minDist && dist > 0) {
                let overlap = minDist - dist;
                let nx = dx / dist; let ny = dy / dist;
                
                s1.x -= nx * (overlap / 2); s2.x += nx * (overlap / 2);

                const kf = 35; 
                s1.vx -= nx * kf; s1.vy -= ny * kf;
                s2.vx += nx * kf; s2.vy += ny * kf;

                let loss1 = s2.rpm * 0.25; 
                let loss2 = s1.rpm * 0.25; 

                let s1Dies = (s1.rpm - loss1 < 15);
                let s2Dies = (s2.rpm - loss2 < 15);

                if (s1Dies && s2Dies) {
                    execute(s1, null); execute(s2, null);
                } else if (s1Dies) {
                    execute(s1, s2);
                } else if (s2Dies) {
                    execute(s2, s1);
                } else {
                    s1.rpm -= loss1; s2.rpm -= loss2;
                    spewRecycledDots(s1.x, s1.y, loss1);
                    spewRecycledDots(s2.x, s2.y, loss2);
                }
            }
        }
    }

    bots = bots.filter(b => !b.dead);
    while (bots.length < MAX_BOTS) { spawnBot(); }

    let leaderboardRankings = [...Object.values(players).filter(p => !p.dead), ...bots]
        .map(s => ({ id: s.id, name: s.name, rpm: Math.floor(s.rpm) }))
        .sort((a, b) => b.rpm - a.rpm);

    let top10 = leaderboardRankings.slice(0, 10);
    let minimapData = [...Object.values(players).filter(p => !p.dead), ...bots].map(s => [Math.round(s.x), Math.round(s.y), s.color]);

    // --- PACKET RADAR DISTRIBUTION ---
    io.sockets.sockets.forEach(socket => {
        let me = players[socket.id];
        if (!me) return;
        
        let cx = me.dead ? MAP_SIZE / 2 : me.x;
        let cy = me.dead ? MAP_SIZE / 2 : me.y;
        let cullDist = 1200; 

        let localPlayers = {};
        for (let idKey in players) {
            let p = players[idKey];
            if (!p.dead && Math.abs(p.x - cx) < cullDist && Math.abs(p.y - cy) < cullDist) {
                localPlayers[p.id] = { id: p.id, name: p.name, x: p.x, y: p.y, rpm: p.rpm, angle: p.angle, radius: p.radius, color: p.color };
            }
        }

        let localBots = bots
            .filter(b => Math.abs(b.x - cx) < cullDist && Math.abs(b.y - cy) < cullDist)
            .map(b => ({ id: b.id, name: b.name, x: b.x, y: b.y, rpm: b.rpm, angle: b.angle, radius: b.radius, color: b.color }));

        let localDots = [];
        for (let i = 0; i < dots.length; i++) {
            let d = dots[i];
            if (d.active && Math.abs(d.x - cx) < cullDist && Math.abs(d.y - cy) < cullDist) {
                localDots.push({ x: d.x, y: d.y, value: d.value, color: d.color });
            }
        }

        let myRank = leaderboardRankings.findIndex(rank => rank.id === me.id) + 1;

        socket.emit('gameUpdate', {
            players: localPlayers,
            bots: localBots,
            dots: localDots,
            boosters: boosters, // NEW: Ship booster coordinates down to client so Godot/Frontend can render them
            minimap: minimapData,
            MAP_SIZE: MAP_SIZE,
            leaderboard: top10,
            myRank: { rank: myRank, rpm: me.dead ? 0 : Math.floor(me.rpm) }
        });
    });

}, 1000 / 30);

function execute(victim, killer) {
    victim.dead = true; 
    spewRecycledDots(victim.x, victim.y, victim.rpm * 0.75); 
    if (killer && !killer.dead) killer.rpm += victim.rpm * 0.2; 
    io.to(victim.id).emit('died');
}

const porty = process.env.PORT || 3000;

server.listen(porty, '0.0.0.0', () => console.log('Authoritative Multi-Brain Vector Core on 3000'));
