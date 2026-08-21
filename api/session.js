// api/session.js — Persistance cloud sécurisée de l'état de partie.
//
// Sécurité : un code de salle 4 chiffres reste un identifiant humain, PAS un secret.
// Chaque salle possède une capacité de lecture/relais ET une capacité d'écriture host
// distincte, toutes deux aléatoires (32 octets), générées lors de la réservation. Aucun
// secret n'est stocké dans le snapshot ni dans le lien court. La capacité host reste sur
// l'appareil hôte ; les joueurs assis reçoivent seulement la capacité lecture/relais par
// P2P ciblé après enregistrement de leur preuve privée de reconnexion. `claim-legacy`
// est désactivée : un identifiant présent dans un snapshot n'est jamais une preuve d'accès.
//
// Variables d'environnement :
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   PUSHER_APP_ID / PUSHER_KEY / PUSHER_SECRET / PUSHER_CLUSTER
//   BRIDGE_ALLOWED_ORIGINS (optionnel, liste séparée par des virgules)
//
// Routes :
//   POST /api/session body { action:'reserve-code' }
//        -> { code, accessKey, hostWriteKey, reservationTtlSeconds }
//   GET  /api/session?code=XXXX + X-Bridge-Session-Key
//        -> { version, updatedAt, state } | 404
//   PUT  /api/session?code=XXXX + X-Bridge-Session-Key
//        + X-Bridge-Host-Write-Key : snapshot complet host
//        OU + identité/reconnect-secret participant : mutation serveur restreinte
//        body { state, expectedVersion } -> { version, updatedAt[, state] } | 409 { current }
//
// Le verrou expectedVersion reste atomique : authentification de la clé, comparaison de
// version, écriture de l'état, promotion de la réservation en clé durable et refresh des
// TTL sont exécutés dans UNE SEULE commande Redis EVAL.

const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const { advanceRobotAuction, isRobotSeat } = require('./pons-server');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PUSHER_APP_ID = process.env.PUSHER_APP_ID;
const PUSHER_KEY = process.env.PUSHER_KEY;
const PUSHER_SECRET = process.env.PUSHER_SECRET;
const PUSHER_CLUSTER = process.env.PUSHER_CLUSTER;

const TTL_SECONDS = 60 * 60 * 24 * 60;
const MAX_SESSION_STATE_BYTES = 512 * 1024;
const ROOM_CODE_RESERVATION_TTL_SECONDS = 120;
// Une fois PeerJS réellement ouvert, la réservation courte est promue en droit pré-partie
// pendant 6 h : assez pour rester longtemps au salon sans perdre la clé, mais sans bloquer
// un code pendant 60 jours si la partie est abandonnée avant le premier snapshot.
const PRESESSION_ACCESS_TTL_SECONDS = 6 * 60 * 60;
const ROOM_CODE_ALLOCATION_ATTEMPTS = 64;
const ACCESS_KEY_BYTES = 32;
const ACCESS_KEY_HEADER = 'x-bridge-session-key';
const HOST_WRITE_KEY_HEADER = 'x-bridge-host-write-key';
const PARTICIPANT_ID_HEADER = 'x-bridge-participant-id';
const RECONNECT_SECRET_HEADER = 'x-bridge-reconnect-secret';
const MODERN_GUEST_ID_RE = /^p_[A-Za-z0-9_-]{24,96}$/;
const RECONNECT_SECRET_RE = /^s_[A-Za-z0-9_-]{32,160}$/;
const SEATS = ['N', 'E', 'S', 'W'];
const SEAT_PENDING = 'PENDING';

const DEFAULT_ALLOWED_ORIGINS = ['https://capgui13.github.io'];
const EXTRA_ALLOWED_ORIGINS = String(process.env.BRIDGE_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set([...DEFAULT_ALLOWED_ORIGINS, ...EXTRA_ALLOWED_ORIGINS]);

function keyFor(code) {
    return `bridge-session:${String(code || '').toUpperCase().trim()}`;
}
function reservationKeyFor(code) {
    return `bridge-room-reservation:${String(code || '').toUpperCase().trim()}`;
}
function accessKeyFor(code) {
    return `bridge-session-access:${String(code || '').toUpperCase().trim()}`;
}
function writeReservationKeyFor(code) {
    return `bridge-room-write-reservation:${String(code || '').toUpperCase().trim()}`;
}
function hostWriteKeyFor(code) {
    return `bridge-session-host-write:${String(code || '').toUpperCase().trim()}`;
}
function participantAuthKeyFor(code, participantId) {
    return `bridge-session-participant-auth:${String(code || '').toUpperCase().trim()}:${participantId}`;
}
function channelFor(code) {
    return `private-session-${String(code || '').toUpperCase().trim()}`;
}
function normalizeCode(code) {
    return String(code || '').toUpperCase().trim();
}
function validCode(code) {
    return /^[A-Za-z0-9]{3,12}$/.test(code);
}
function generateAccessKey() {
    return crypto.randomBytes(ACCESS_KEY_BYTES).toString('base64url');
}
function safeTextEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const aa = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function requestHeader(req, name) {
    const raw = req && req.headers && (req.headers[name] || req.headers[name.toLowerCase()]);
    return typeof raw === 'string' ? raw.trim() : '';
}
function requestAccessKey(req) { return requestHeader(req, ACCESS_KEY_HEADER); }
function requestHostWriteKey(req) { return requestHeader(req, HOST_WRITE_KEY_HEADER); }
function requestParticipantId(req) { return requestHeader(req, PARTICIPANT_ID_HEADER); }
function requestReconnectSecret(req) { return requestHeader(req, RECONNECT_SECRET_HEADER); }
function hashReconnectSecret(secret) {
    return crypto.createHash('sha256').update(String(secret || ''), 'utf8').digest('hex');
}

function isAllowedOrigin(origin) {
    if (!origin) return true; // curl / tests / serveur-à-serveur
    if (ALLOWED_ORIGINS.has(origin)) return true;
    if (process.env.VERCEL_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
    return false;
}
function applyCors(req, res) {
    const origin = req && req.headers && req.headers.origin;
    if (origin && isAllowedOrigin(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Session-Key, X-Bridge-Host-Write-Key, X-Bridge-Participant-Id, X-Bridge-Reconnect-Secret');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return isAllowedOrigin(origin);
}

async function redisCommand(command) {
    const resp = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${UPSTASH_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(command)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) throw new Error(data.error || `Upstash HTTP ${resp.status}`);
    return data.result;
}

async function readStoredAccessKey(code) {
    const durable = await redisCommand(['GET', accessKeyFor(code)]);
    if (durable) return String(durable);
    const reserved = await redisCommand(['GET', reservationKeyFor(code)]);
    return reserved ? String(reserved) : null;
}

async function readStoredHostWriteKey(code) {
    const durable = await redisCommand(['GET', hostWriteKeyFor(code)]);
    if (durable) return String(durable);
    const reserved = await redisCommand(['GET', writeReservationKeyFor(code)]);
    return reserved ? String(reserved) : null;
}

async function authorizeHostWriteRequest(req, res, code) {
    const accessKey = requestAccessKey(req);
    const writeKey = requestHostWriteKey(req);
    if (!accessKey || !writeKey) {
        res.status(401).json({ error: 'session-host-write-required' });
        return false;
    }
    const [storedAccess, storedWrite] = await Promise.all([
        readStoredAccessKey(code), readStoredHostWriteKey(code)
    ]);
    if (!storedAccess || !storedWrite || !safeTextEqual(storedAccess, accessKey) || !safeTextEqual(storedWrite, writeKey)) {
        res.status(403).json({ error: 'session-host-write-invalid' });
        return false;
    }
    return true;
}

async function authorizeParticipantWrite(req, res, code) {
    const accessKey = requestAccessKey(req);
    const participantId = requestParticipantId(req);
    const reconnectSecret = requestReconnectSecret(req);
    if (!accessKey) {
        res.status(401).json({ error: 'session-auth-required' });
        return null;
    }
    const storedAccess = await readStoredAccessKey(code);
    if (!storedAccess || !safeTextEqual(storedAccess, accessKey)) {
        res.status(403).json({ error: 'session-auth-invalid' });
        return null;
    }
    if (!MODERN_GUEST_ID_RE.test(participantId) || !RECONNECT_SECRET_RE.test(reconnectSecret)) {
        res.status(403).json({ error: 'participant-auth-invalid' });
        return null;
    }
    const storedHash = await redisCommand(['GET', participantAuthKeyFor(code, participantId)]);
    const presentedHash = hashReconnectSecret(reconnectSecret);
    if (!storedHash || !safeTextEqual(String(storedHash), presentedHash)) {
        res.status(403).json({ error: 'participant-auth-invalid' });
        return null;
    }
    return { participantId };
}

async function authorizeReadRequest(req, res, code) {
    const provided = requestAccessKey(req);
    if (!provided) {
        res.status(401).json({ error: 'session-auth-required' });
        return false;
    }
    const stored = await readStoredAccessKey(code);
    if (!stored || !safeTextEqual(stored, provided)) {
        res.status(403).json({ error: 'session-auth-invalid' });
        return false;
    }
    return true;
}

// Le PUT complet est réservé au host courant. Deux secrets distincts sont requis :
// la capacité de lecture de salle ET une capacité d'écriture host qui n'est jamais
// transmise aux invités. Les deux réservations sont promues atomiquement au premier PUT.
const SESSION_CAS_LUA = `
local raw = redis.call('GET', KEYS[1])
local durableAccess = redis.call('GET', KEYS[3])
local reservedAccess = redis.call('GET', KEYS[2])
local durableWrite = redis.call('GET', KEYS[5])
local reservedWrite = redis.call('GET', KEYS[4])
local providedAccess = ARGV[5]
local providedWrite = ARGV[6]

if raw then
  if not durableAccess or durableAccess ~= providedAccess then return {-2, ''} end
  if not durableWrite or durableWrite ~= providedWrite then return {-3, ''} end
else
  if durableAccess then
    if durableAccess ~= providedAccess then return {-2, ''} end
  else
    if not reservedAccess or reservedAccess ~= providedAccess then return {-2, ''} end
    redis.call('SET', KEYS[3], providedAccess, 'EX', ARGV[4])
  end
  if durableWrite then
    if durableWrite ~= providedWrite then return {-3, ''} end
  else
    if not reservedWrite or reservedWrite ~= providedWrite then return {-3, ''} end
    redis.call('SET', KEYS[5], providedWrite, 'EX', ARGV[4])
  end
end

local currentVersion = 0
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= 'table' or type(decoded.version) ~= 'number' then return {-1, raw} end
  currentVersion = decoded.version
end
local expectedVersion = tonumber(ARGV[1])
if expectedVersion ~= currentVersion then return {0, raw or ''} end

local newVersion = currentVersion + 1
local updatedAt = ARGV[2]
local stateJson = ARGV[3]
local ttl = ARGV[4]
local payload = '{"version":' .. tostring(newVersion)
  .. ',"updatedAt":' .. updatedAt .. ',"state":' .. stateJson .. '}'
redis.call('SET', KEYS[1], payload, 'EX', ttl)
redis.call('SET', KEYS[3], providedAccess, 'EX', ttl)
redis.call('SET', KEYS[5], providedWrite, 'EX', ttl)
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[4])
return {1, tostring(newVersion), updatedAt, payload}
`;

async function atomicWriteSession(code, state, expectedVersion, updatedAt, accessKey, hostWriteKey) {
    const stateJson = JSON.stringify(state);
    const result = await redisCommand([
        'EVAL', SESSION_CAS_LUA, '5', keyFor(code), reservationKeyFor(code), accessKeyFor(code),
        writeReservationKeyFor(code), hostWriteKeyFor(code),
        String(expectedVersion), String(updatedAt), stateJson, String(TTL_SECONDS), accessKey, hostWriteKey
    ]);
    if (!Array.isArray(result) || result.length === 0) throw new Error('Réponse Redis CAS invalide.');
    const status = Number(result[0]);
    if (status === -2) return { unauthorized: true };
    if (status === -3) return { hostUnauthorized: true };
    if (status === -1) throw new Error('État de session Redis corrompu : version illisible.');
    if (status === 0) {
        let current = null;
        if (result[1]) current = JSON.parse(result[1]);
        return { conflict: true, current };
    }
    if (status !== 1) throw new Error(`Statut Redis CAS inattendu: ${status}`);
    return { conflict: false, payload: JSON.parse(result[3]) };
}

// Écriture restreinte d'un participant authentifié. Le serveur construit lui-même le
// prochain snapshot ; ce script ne fait ensuite que le CAS version + capacité de salle.
const PARTICIPANT_CAS_LUA = `
local raw = redis.call('GET', KEYS[1])
local durableAccess = redis.call('GET', KEYS[2])
if not durableAccess or durableAccess ~= ARGV[5] then return {-2, raw or ''} end
if not raw then return {-4, ''} end
local ok, decoded = pcall(cjson.decode, raw)
if not ok or type(decoded) ~= 'table' or type(decoded.version) ~= 'number' then return {-1, raw} end
if tonumber(ARGV[1]) ~= decoded.version then return {0, raw} end
local newVersion = decoded.version + 1
local payload = '{"version":' .. tostring(newVersion)
  .. ',"updatedAt":' .. ARGV[2] .. ',"state":' .. ARGV[3] .. '}'
redis.call('SET', KEYS[1], payload, 'EX', ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[4])
if redis.call('EXISTS', KEYS[3]) == 1 then redis.call('EXPIRE', KEYS[3], ARGV[4]) end
return {1, tostring(newVersion), ARGV[2], payload}
`;

async function atomicParticipantWriteSession(code, state, expectedVersion, updatedAt, accessKey) {
    const result = await redisCommand([
        'EVAL', PARTICIPANT_CAS_LUA, '3', keyFor(code), accessKeyFor(code), hostWriteKeyFor(code),
        String(expectedVersion), String(updatedAt), JSON.stringify(state), String(TTL_SECONDS), accessKey
    ]);
    if (!Array.isArray(result) || result.length === 0) throw new Error('Réponse Redis participant CAS invalide.');
    const status = Number(result[0]);
    if (status === -2) return { unauthorized: true };
    if (status === -4) return { missing: true };
    if (status === -1) throw new Error('État de session Redis corrompu : version illisible.');
    if (status === 0) return { conflict: true, current: result[1] ? JSON.parse(result[1]) : null };
    if (status !== 1) throw new Error(`Statut Redis participant CAS inattendu: ${status}`);
    return { conflict: false, payload: JSON.parse(result[3]) };
}

function partnershipOf(seat) { return seat === 'N' || seat === 'S' ? 'NS' : 'EW'; }
function currentTurnSeatServer(dealer, history) {
    const start = SEATS.indexOf(String(dealer || '').toUpperCase());
    if (start < 0) return null;
    return SEATS[(start + (Array.isArray(history) ? history.length : 0)) % 4];
}
function parseContractCall(call) {
    const m = /^([1-7])(C|D|H|S|NT)$/.exec(String(call || '').toUpperCase());
    if (!m) return null;
    const order = { C: 0, D: 1, H: 2, S: 3, NT: 4 };
    return { level: Number(m[1]), strain: m[2], rank: (Number(m[1]) - 1) * 5 + order[m[2]] };
}
function isAuctionOverServer(history) {
    if (!Array.isArray(history) || history.length < 4) return false;
    const tail3 = history.slice(-3).every(e => String(e.call || '').toUpperCase() === 'PASS');
    if (!tail3) return false;
    const anyContract = history.some(e => !!parseContractCall(e.call));
    if (anyContract) return true;
    return history.length >= 4 && history.slice(-4).every(e => String(e.call || '').toUpperCase() === 'PASS');
}
function lastNonPass(history) {
    for (let i = history.length - 1; i >= 0; i--) if (String(history[i].call).toUpperCase() !== 'PASS') return { ...history[i], index: i };
    return null;
}
function lastContract(history) {
    for (let i = history.length - 1; i >= 0; i--) {
        const bid = parseContractCall(history[i].call);
        if (bid) return { ...history[i], bid, index: i };
    }
    return null;
}
function isServerCallLegal(history, call, seat) {
    call = String(call || '').toUpperCase();
    if (isAuctionOverServer(history)) return false;
    if (call === 'PASS') return true;
    const bid = parseContractCall(call);
    if (bid) {
        const prev = lastContract(history);
        return !prev || bid.rank > prev.bid.rank;
    }
    const nonPass = lastNonPass(history);
    if (call === 'X') {
        if (!nonPass || !parseContractCall(nonPass.call)) return false;
        return partnershipOf(nonPass.seat) !== partnershipOf(seat);
    }
    if (call === 'XX') {
        if (!nonPass || String(nonPass.call).toUpperCase() !== 'X') return false;
        const contract = lastContract(history);
        return !!contract && partnershipOf(contract.seat) === partnershipOf(seat);
    }
    return false;
}
function arrayPrefix(prefix, full) {
    return Array.isArray(prefix) && Array.isArray(full) && prefix.length <= full.length
        && prefix.every((v, i) => isDeepStrictEqual(v, full[i]));
}
function actorSeats(state, actorId) {
    return SEATS.filter(seat => state.seatAssignment && state.seatAssignment[seat] === actorId);
}
function findActorUndoTarget(state, actorId, history) {
    const seats = actorSeats(state, actorId);
    for (let i = history.length - 1; i >= 0; i--) if (seats.includes(history[i].seat)) return i;
    return -1;
}
function findPartnerLastCall(state, actorId, history) {
    const mine = actorSeats(state, actorId);
    if (!mine.length) return -1;
    const camps = new Set(mine.map(partnershipOf));
    const partners = SEATS.filter(s => camps.has(partnershipOf(s)) && !mine.includes(s));
    for (let i = history.length - 1; i >= 0; i--) if (partners.includes(history[i].seat)) return i;
    return -1;
}
function sanitizeName(v, fallback = 'Joueur') {
    const x = typeof v === 'string' ? v.trim().slice(0, 40) : '';
    return x || fallback;
}
function sanitizeAvatar(v) {
    return typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v) ? v.toUpperCase() : null;
}
function cloneJson(v) { return JSON.parse(JSON.stringify(v)); }

// Construit un état restreint à partir du snapshot SERVEUR. Toute tentative de modifier
// mains, identité de l'hôte, sièges d'autrui, historique humain d'autrui, etc. est ignorée
// ou rejetée. Les seules mutations permises sont : profil propre, claim d'un siège PENDING,
// chat propre, annonces de ses propres sièges, ainsi que son undo différé selon la règle
// déjà appliquée dans le client. Les appels robot ne sont PLUS acceptés depuis le snapshot
// participant : à la première frontière robot, le suffixe client est ignoré et PONS est
// exécuté côté serveur sur le snapshot autoritaire.
async function buildRestrictedParticipantState(current, proposed, actorId) {
    if (!current || !proposed || typeof current !== 'object' || typeof proposed !== 'object') throw new Error('participant-state-invalid');
    if (String(proposed.roomCode || '') !== String(current.roomCode || '')) throw new Error('participant-room-change-forbidden');
    if (!Array.isArray(current.deals) || !Array.isArray(proposed.deals) || current.deals.length !== proposed.deals.length) throw new Error('participant-deals-shape-forbidden');

    const next = cloneJson(current);
    const currentParticipants = Array.isArray(current.participants) ? current.participants : [];
    const proposedParticipants = Array.isArray(proposed.participants) ? proposed.participants : [];
    const proposedActor = proposedParticipants.find(p => p && p.id === actorId);
    let actor = next.participants.find(p => p && p.id === actorId);
    if (!actor) {
        actor = { id: actorId, name: sanitizeName(proposedActor && proposedActor.name) };
        const color = sanitizeAvatar(proposedActor && proposedActor.avatarColor);
        if (color) actor.avatarColor = color;
        actor.disconnected = false;
        actor.disconnectedAt = null;
        next.participants.push(actor);
    } else if (proposedActor) {
        actor.name = sanitizeName(proposedActor.name, actor.name || 'Joueur');
        const color = sanitizeAvatar(proposedActor.avatarColor);
        if (color) actor.avatarColor = color; else delete actor.avatarColor;
        actor.disconnected = false;
        actor.disconnectedAt = null;
    }

    // Claim : uniquement un siège explicitement PENDING, et uniquement si l'acteur n'a
    // encore aucun siège. Jamais de déplacement/remplacement d'un autre participant.
    const mineBefore = actorSeats(current, actorId);
    if (mineBefore.length === 0 && proposed.seatAssignment && typeof proposed.seatAssignment === 'object') {
        const requested = SEATS.filter(seat => proposed.seatAssignment[seat] === actorId && current.seatAssignment[seat] !== actorId);
        if (requested.length > 1) throw new Error('participant-seat-claim-too-wide');
        if (requested.length === 1) {
            const seat = requested[0];
            if (current.seatAssignment[seat] !== SEAT_PENDING) throw new Error('participant-seat-claim-forbidden');
            next.seatAssignment[seat] = actorId;
        }
    }

    // Chat : préfixe serveur immuable ; uniquement ajout de messages de l'acteur.
    const curChat = Array.isArray(current.chatMessages) ? current.chatMessages : [];
    const propChat = Array.isArray(proposed.chatMessages) ? proposed.chatMessages : [];
    if (!arrayPrefix(curChat, propChat)) throw new Error('participant-chat-rewrite-forbidden');
    const actorForName = next.participants.find(p => p.id === actorId);
    const extraChat = propChat.slice(curChat.length);
    if (extraChat.length > 8) throw new Error('participant-chat-batch-too-large');
    next.chatMessages = cloneJson(curChat);
    for (const m of extraChat) {
        if (!m || m.senderId !== actorId || typeof m.text !== 'string') throw new Error('participant-chat-impersonation');
        const text = m.text.trim().slice(0, 500);
        if (!text) continue;
        next.chatMessages.push({ senderId: actorId, senderName: actorForName ? actorForName.name : 'Joueur', text });
    }

    let actorChangedBoard = null;
    for (let i = 0; i < current.deals.length; i++) {
        const curDeal = current.deals[i];
        const propDeal = proposed.deals[i];
        if (!curDeal || !propDeal) throw new Error('participant-deal-missing');
        const curNoHist = { ...curDeal }; delete curNoHist.auctionHistory;
        const propNoHist = { ...propDeal }; delete propNoHist.auctionHistory;
        if (!isDeepStrictEqual(curNoHist, propNoHist)) throw new Error('participant-deal-content-forbidden');
        const curHist = Array.isArray(curDeal.auctionHistory) ? curDeal.auctionHistory : [];
        const propHist = Array.isArray(propDeal.auctionHistory) ? propDeal.auctionHistory : [];
        if (isDeepStrictEqual(curHist, propHist)) continue;
        if (actorSeats(current, actorId).length === 0 && !SEATS.some(seat => next.seatAssignment[seat] === actorId)) {
            throw new Error('participant-auction-kibbitz-forbidden');
        }

        if (arrayPrefix(curHist, propHist)) {
            const merged = cloneJson(curHist);
            for (const entry of propHist.slice(curHist.length)) {
                const expectedSeat = currentTurnSeatServer(curDeal.dealer, merged);
                const occupant = next.seatAssignment[expectedSeat];

                // Frontière P2 architecturale : un client participant n'a plus AUCUNE
                // autorité sur la valeur d'une annonce robot. Même si son suffixe contient
                // une annonce parfaitement légale, on cesse ici de consommer le suffixe.
                // Le bloc d'auto-avancement ci-dessous demandera à PONS SERVEUR de choisir
                // l'annonce à partir de l'historique serveur exact.
                if (isRobotSeat(next.seatAssignment, expectedSeat)) break;

                if (!entry || !SEATS.includes(entry.seat) || typeof entry.call !== 'string') throw new Error('participant-call-invalid');
                if (entry.seat !== expectedSeat || !isServerCallLegal(merged, entry.call, entry.seat)) throw new Error('participant-call-illegal');
                if (occupant !== actorId) throw new Error('participant-call-other-human-forbidden');
                if (actorChangedBoard != null && actorChangedBoard !== i) throw new Error('participant-call-multiple-boards');
                actorChangedBoard = i;
                merged.push({ seat: entry.seat, call: String(entry.call).toUpperCase(), ...(typeof entry.explanation === 'string' ? { explanation: entry.explanation.slice(0, 500) } : {}) });
            }
            next.deals[i].auctionHistory = merged;
            continue;
        }

        // Undo : le nouvel historique doit être un préfixe exact et couper juste AVANT
        // la dernière annonce de l'acteur, sans qu'un partenaire ait annoncé depuis.
        if (arrayPrefix(propHist, curHist)) {
            const target = findActorUndoTarget(current, actorId, curHist);
            const partner = findPartnerLastCall(current, actorId, curHist);
            if (target < 0 || target <= partner || propHist.length !== target) throw new Error('participant-undo-forbidden');
            if (actorChangedBoard != null && actorChangedBoard !== i) throw new Error('participant-undo-multiple-boards');
            actorChangedBoard = i;
            next.deals[i].auctionHistory = cloneJson(propHist);
            continue;
        }
        throw new Error('participant-auction-rewrite-forbidden');
    }

    // Si le tour autoritaire de la donne partagée appartient maintenant à un robot, PONS
    // est exécuté ICI, côté serveur. Cela couvre à la fois :
    // - l'annonce humaine relayée qui vient de donner la main à un robot ;
    // - un ancien client qui a inclus une annonce robot dans son suffixe (valeur ignorée) ;
    // - une reprise différée qui envoie un snapshot inchangé uniquement pour demander de
    //   faire progresser le tour robot.
    // Un participant doit être réellement assis, et on n'auto-avance pas une seconde donne
    // si ce même PUT a déjà modifié une autre donne.
    const sharedBoardIndex = Number.isInteger(current.boardIndex) ? current.boardIndex : -1;
    const actorIsSeated = actorSeats(next, actorId).length > 0;
    if (actorIsSeated && sharedBoardIndex >= 0 && next.deals[sharedBoardIndex]
        && (actorChangedBoard == null || actorChangedBoard === sharedBoardIndex)) {
        const sharedDeal = next.deals[sharedBoardIndex];
        const sharedHistory = Array.isArray(sharedDeal.auctionHistory) ? sharedDeal.auctionHistory : [];
        const expectedSeat = currentTurnSeatServer(sharedDeal.dealer, sharedHistory);
        if (expectedSeat && isRobotSeat(next.seatAssignment, expectedSeat) && !isAuctionOverServer(sharedHistory)) {
            const advanced = await advanceRobotAuction({
                deal: sharedDeal,
                history: sharedHistory,
                seatAssignment: next.seatAssignment,
                currentTurnSeat: currentTurnSeatServer,
                isCallLegal: isServerCallLegal,
                isAuctionOver: isAuctionOverServer,
                maxCalls: 64
            });
            next.deals[sharedBoardIndex].auctionHistory = advanced.history;
        }
    }

    // Navigation reste locale pour un participant : seul le host peut changer la donne
    // partagée qui sera reprise à froid. Ne touche savedAt que si une mutation autorisée
    // a réellement changé l'état ; un simple snapshot arbitraire rejeté devient un no-op.
    if (!isDeepStrictEqual(next, current)) next.savedAt = Date.now();
    return next;
}

// Allocation atomique : une salle neuve reçoit DEUX secrets distincts : capacité de
// lecture/relais (partagée avec les joueurs autorisés) et capacité d'écriture host (jamais
// partagée). Aucun ancien état/réservation ne doit exister pour le code.
const ROOM_CODE_RESERVE_LUA = `
for i=1,5 do if redis.call('EXISTS', KEYS[i]) == 1 then return 0 end end
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[4], ARGV[2], 'EX', ARGV[3])
return 1
`;
async function reserveFreshRoomCode() {
    for (let i = 0; i < ROOM_CODE_ALLOCATION_ATTEMPTS; i++) {
        const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
        const accessKey = generateAccessKey();
        const hostWriteKey = generateAccessKey();
        const result = await redisCommand([
            'EVAL', ROOM_CODE_RESERVE_LUA, '5', keyFor(code), reservationKeyFor(code), accessKeyFor(code),
            writeReservationKeyFor(code), hostWriteKeyFor(code),
            accessKey, hostWriteKey, String(ROOM_CODE_RESERVATION_TTL_SECONDS)
        ]);
        if (Number(result) === 1) return { code, accessKey, hostWriteKey };
    }
    throw new Error('Impossible de réserver un code de salle libre après plusieurs tentatives.');
}

const ACTIVATE_ROOM_LUA = `
local rawSession = redis.call('GET', KEYS[1])
local durableAccess = redis.call('GET', KEYS[3])
local reservedAccess = redis.call('GET', KEYS[2])
local durableWrite = redis.call('GET', KEYS[5])
local reservedWrite = redis.call('GET', KEYS[4])
local providedAccess = ARGV[1]
local providedWrite = ARGV[2]
if durableAccess then if durableAccess ~= providedAccess then return 0 end
else if not reservedAccess or reservedAccess ~= providedAccess then return 0 end end
if durableWrite then if durableWrite ~= providedWrite then return 0 end
else if not reservedWrite or reservedWrite ~= providedWrite then return 0 end end
local ttl = rawSession and ARGV[4] or ARGV[3]
redis.call('SET', KEYS[3], providedAccess, 'EX', ttl)
redis.call('SET', KEYS[5], providedWrite, 'EX', ttl)
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[4])
return 1
`;
async function activateRoomAccess(code, providedAccess, providedWrite) {
    const result = await redisCommand([
        'EVAL', ACTIVATE_ROOM_LUA, '5', keyFor(code), reservationKeyFor(code), accessKeyFor(code),
        writeReservationKeyFor(code), hostWriteKeyFor(code),
        providedAccess, providedWrite, String(PRESESSION_ACCESS_TTL_SECONDS), String(TTL_SECONDS)
    ]);
    return Number(result) === 1;
}

// `claim-legacy` supprimé pour raison de sécurité : aucune route non authentifiée ne
// peut convertir un identifiant de participant en capacité durable de salle.

// Trigger serveur vers un CANAL PRIVÉ. L'événement ne transporte volontairement plus le
// snapshot : seulement version/updatedAt. Le contenu de partie reste exclusivement dans
// Redis derrière l'authentification de capacité ; le client fait un GET authentifié à la
// réception (ou le polling de secours le fera plus tard).
function pusherRequestBody(channel, eventName, data) {
    return JSON.stringify({ name: eventName, channels: [channel], data: JSON.stringify(data) });
}
async function pusherTrigger(channel, eventName, data) {
    if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET || !PUSHER_CLUSTER) return;
    const body = pusherRequestBody(channel, eventName, data);
    const bodyMd5 = crypto.createHash('md5').update(body).digest('hex');
    const path = `/apps/${PUSHER_APP_ID}/events`;
    const params = {
        auth_key: PUSHER_KEY,
        auth_timestamp: String(Math.floor(Date.now() / 1000)),
        auth_version: '1.0',
        body_md5: bodyMd5
    };
    const sortedQuery = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
    const stringToSign = `POST\n${path}\n${sortedQuery}`;
    const authSignature = crypto.createHmac('sha256', PUSHER_SECRET).update(stringToSign).digest('hex');
    const url = `https://api-${PUSHER_CLUSTER}.pusher.com${path}?${sortedQuery}&auth_signature=${authSignature}`;
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`Pusher HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
}

module.exports = async (req, res) => {
    if (!applyCors(req, res)) {
        res.status(403).json({ error: 'origin-not-allowed' });
        return;
    }
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
        res.status(500).json({ error: 'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN manquantes côté serveur.' });
        return;
    }

    if (req.method === 'POST') {
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (e) { body = {}; }
        }
        if (body && body.action === 'reserve-code') {
            try {
                const reserved = await reserveFreshRoomCode();
                res.status(201).json({
                    code: reserved.code,
                    accessKey: reserved.accessKey,
                    hostWriteKey: reserved.hostWriteKey,
                    reservationTtlSeconds: ROOM_CODE_RESERVATION_TTL_SECONDS
                });
            } catch (e) {
                res.status(503).json({ error: String((e && e.message) || e) });
            }
            return;
        }
        if (body && body.action === 'activate-room') {
            const code = normalizeCode(body.code);
            const providedKey = requestAccessKey(req);
            const providedWriteKey = requestHostWriteKey(req);
            if (!validCode(code) || !providedKey || !providedWriteKey) {
                res.status(400).json({ error: 'Paramètres activation invalides.' });
                return;
            }
            try {
                const ok = await activateRoomAccess(code, providedKey, providedWriteKey);
                if (!ok) { res.status(403).json({ error: 'session-auth-invalid' }); return; }
                res.status(200).json({ ok: true });
            } catch (e) {
                res.status(500).json({ error: String((e && e.message) || e) });
            }
            return;
        }
        if (body && body.action === 'register-participant') {
            const code = normalizeCode(body.code);
            const participantId = typeof body.participantId === 'string' ? body.participantId.trim() : '';
            const reconnectSecret = typeof body.reconnectSecret === 'string' ? body.reconnectSecret.trim() : '';
            if (!validCode(code) || !MODERN_GUEST_ID_RE.test(participantId) || !RECONNECT_SECRET_RE.test(reconnectSecret)) {
                res.status(400).json({ error: 'participant-registration-invalid' });
                return;
            }
            try {
                if (!await authorizeHostWriteRequest(req, res, code)) return;
                await redisCommand(['SET', participantAuthKeyFor(code, participantId), hashReconnectSecret(reconnectSecret), 'EX', String(TTL_SECONDS)]);
                res.status(200).json({ ok: true });
            } catch (e) {
                res.status(500).json({ error: String((e && e.message) || e) });
            }
            return;
        }
        if (body && body.action === 'claim-legacy') {
            // Compatibilité fail-closed avec d'anciens clients : la route existe encore
            // nominalement mais ne rend JAMAIS de clé et ne consulte aucun token de snapshot.
            res.status(410).json({ error: 'legacy-claim-disabled' });
            return;
        }
        res.status(400).json({ error: 'Action POST inconnue.' });
        return;
    }

    const code = normalizeCode(req.query && req.query.code);
    if (!validCode(code)) {
        res.status(400).json({ error: 'Paramètre "code" manquant ou invalide.' });
        return;
    }

    if (req.method === 'GET') {
        try {
            if (!await authorizeReadRequest(req, res, code)) return;
            const raw = await redisCommand(['GET', keyFor(code)]);
            if (!raw) {
                res.status(404).json({ error: 'Aucune session trouvée pour ce code.' });
                return;
            }
            res.status(200).json(JSON.parse(raw));
        } catch (e) {
            res.status(500).json({ error: String((e && e.message) || e) });
        }
        return;
    }

    if (req.method === 'PUT') {
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (e) { body = {}; }
        }
        const { state, expectedVersion } = body || {};
        if (!state || typeof state !== 'object' || Array.isArray(state)) {
            res.status(400).json({ error: '"state" manquant ou invalide dans le corps de la requête.' });
            return;
        }
        if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
            res.status(400).json({ error: '"expectedVersion" est obligatoire et doit être un entier >= 0.' });
            return;
        }
        const stateBytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
        if (stateBytes > MAX_SESSION_STATE_BYTES) {
            res.status(413).json({ error: 'session-state-too-large', maxBytes: MAX_SESSION_STATE_BYTES, actualBytes: stateBytes });
            return;
        }
        const providedAccess = requestAccessKey(req);
        if (!providedAccess) {
            res.status(401).json({ error: 'session-auth-required' });
            return;
        }
        try {
            const providedHostWrite = requestHostWriteKey(req);
            let write;
            let restricted = false;
            if (providedHostWrite) {
                write = await atomicWriteSession(code, state, expectedVersion, Date.now(), providedAccess, providedHostWrite);
                if (write.hostUnauthorized) {
                    res.status(403).json({ error: 'session-host-write-invalid' });
                    return;
                }
            } else {
                const actor = await authorizeParticipantWrite(req, res, code);
                if (!actor) return;
                const raw = await redisCommand(['GET', keyFor(code)]);
                if (!raw) { res.status(404).json({ error: 'Aucune session trouvée pour ce code.' }); return; }
                const currentPayload = JSON.parse(raw);
                if (!Number.isInteger(currentPayload.version) || !currentPayload.state) throw new Error('État de session Redis corrompu.');
                if (currentPayload.version !== expectedVersion) {
                    res.status(409).json({ error: 'version-conflict', current: currentPayload });
                    return;
                }
                let restrictedState;
                try {
                    restrictedState = await buildRestrictedParticipantState(currentPayload.state, state, actor.participantId);
                } catch (e) {
                    if (e && e.serverPonsFault) {
                        console.error('[session] autorité PONS serveur indisponible :', e.code || e.message, e.cause || '');
                        res.status(503).json({ error: e.code || 'server-pons-unavailable' });
                        return;
                    }
                    res.status(403).json({ error: String((e && e.message) || 'participant-write-forbidden') });
                    return;
                }
                // Si toutes les différences proposées étaient hors autorité de l'acteur,
                // ne crée même pas une nouvelle version : renvoie l'état serveur exact.
                if (isDeepStrictEqual(restrictedState, currentPayload.state)) {
                    res.status(200).json({ version: currentPayload.version, updatedAt: currentPayload.updatedAt, state: currentPayload.state, restricted: true, noChange: true });
                    return;
                }
                write = await atomicParticipantWriteSession(code, restrictedState, expectedVersion, Date.now(), providedAccess);
                restricted = true;
            }
            if (write.unauthorized) {
                res.status(403).json({ error: 'session-auth-invalid' });
                return;
            }
            if (write.missing) {
                res.status(404).json({ error: 'Aucune session trouvée pour ce code.' });
                return;
            }
            if (write.conflict) {
                res.status(409).json({ error: 'version-conflict', current: write.current });
                return;
            }
            const payload = write.payload;
            try {
                await pusherTrigger(channelFor(code), 'update', { version: payload.version, updatedAt: payload.updatedAt });
            } catch (e) {
                console.warn('[session] notification Pusher échouée :', String((e && e.message) || e));
            }
            res.status(200).json({ version: payload.version, updatedAt: payload.updatedAt, ...(restricted ? { state: payload.state, restricted: true } : {}) });
        } catch (e) {
            res.status(500).json({ error: String((e && e.message) || e) });
        }
        return;
    }

    res.status(405).json({ error: 'Méthode non supportée.' });
};
