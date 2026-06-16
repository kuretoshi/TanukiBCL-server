import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import { Server } from 'http';
import { Server as HttpsServer } from 'https';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Server as SocketIOServer, Socket } from 'socket.io';
import Tracer from 'tracer';
import morgan from 'morgan';
import peerConfig from './peerConfig';
import { ICEServer } from './ICEServer';
import { PublicLobby } from './interfaces/publicLobby';
import { GameState } from './interfaces/gameState';
import { lobbyInfo } from './interfaces/lobbyInfo';
let TurnServer = require('node-turn');

const httpsEnabled = !!process.env.HTTPS;

const port = process.env.PORT || (httpsEnabled ? '443' : '9736');
const publicUrl = process.env.PUBLIC_URL;

const sslCertificatePath = process.env.SSLPATH || process.cwd();
const maxLobbyClients = readPositiveInteger(process.env.MAX_LOBBY_CLIENTS, 20);
const maxSignalEventsPerWindow = readPositiveInteger(process.env.MAX_SIGNAL_EVENTS_PER_WINDOW, 300);
const maxVadEventsPerWindow = readPositiveInteger(process.env.MAX_VAD_EVENTS_PER_WINDOW, 60);
const maxLobbyEventsPerWindow = readPositiveInteger(process.env.MAX_LOBBY_EVENTS_PER_WINDOW, 20);
const rateLimitWindowMs = readPositiveInteger(process.env.RATE_LIMIT_WINDOW_MS, 10000);

const logger = Tracer.colorConsole({
	format: '{{timestamp}} <{{title}}> {{message}}',
});

const turnLogger = Tracer.colorConsole({
	format: '{{timestamp}} <{{title}}> <ice> {{message}}',
	level: peerConfig.integratedRelay.debugLevel.toLowerCase(),
});

const app = express();
let server: HttpsServer | Server;
if (httpsEnabled) {
	server = new HttpsServer(
		{
			key: readFileSync(join(sslCertificatePath, 'privkey.pem')),
			cert: readFileSync(join(sslCertificatePath, 'fullchain.pem')),
		},
		app
	);
} else {
	server = new Server(app);
}

let turnServer: any | null = null;
if (peerConfig.integratedRelay.enabled) {
	turnServer = new TurnServer({
		listeningIps: peerConfig.integratedRelay.listeningIps,
		relayIps: peerConfig.integratedRelay.relayIps,
		externalIps: peerConfig.integratedRelay.externalIps,
		minPort: peerConfig.integratedRelay.minPort,
		maxPort: peerConfig.integratedRelay.maxPort,
		listeningPort: peerConfig.integratedRelay.listeningPort,
		authMech: 'long-term',
		debugLevel: peerConfig.integratedRelay.debugLevel,
		realm: 'crewlink',
		debug: (level: string, message: string) => {
			turnLogger[level.toLowerCase()](message);
		},
	});

	turnServer.addUser(peerConfig.integratedRelay.defaultUsername, peerConfig.integratedRelay.defaultPassword);

	turnServer.start();
}

const io = new SocketIOServer(server, {
	allowEIO3: true,
	transports: ['polling', 'websocket'],
	cors: {
		origin: true,
		credentials: true,
	},
});
const clients = new Map<string, Client>();
const publicLobbies = new Map<string, PublicLobby>();
const lobbyCodes = new Map<number, string>();
const allLobbies = new Map<string, lobbyInfo>();
let lobbyCount = 0;

function readPositiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function removePublicLobby(c: string) {
	if (publicLobbies.has(c)) {
		let pid = publicLobbies.get(c).id;
		io.in('lobbybrowser').emit('remove_lobby', pid);
		lobbyCodes.delete(pid);
		publicLobbies.delete(c);
	}
}
interface Client {
	playerId: number;
	clientId: number;
}

interface Signal {
	data: any;
	to: string;
}

interface ClientPeerConfig {
	forceRelayOnly: boolean;
	iceServers: ICEServer[];
}

app.enable('trust proxy');
app.set('views', join(__dirname, '../views'));
app.use('/public', express.static(join(__dirname, '../public')));
app.set('view engine', 'pug');
app.use(morgan('combined'));

interface RateLimitBucket {
	windowStartedAt: number;
	count: number;
}

let connectionCount = 0;

let hostname = process.env.HOSTNAME;
if (!hostname && peerConfig.integratedRelay.enabled) {
	logger.error('You must set the HOSTNAME environment variable to use the TURN server.');
	process.exit(1);
}

app.get('/', (req, res) => {
	let address = publicUrl || req.protocol + '://' + req.hostname;
	res.render('index', { connectionCount, address, lobbiesCount: allLobbies.size });
});

app.get('/health', (req, res) => {
	let address = publicUrl || req.protocol + '://' + req.hostname;
	res.json({
		uptime: process.uptime(),
		connectionCount,
		lobbiesCount: allLobbies.size,
		address,
		name: process.env.NAME,
	});
});

app.get('/lobbies', (req, res) => {
	res.json(Array.from(publicLobbies.values()));
});

function getSocketsInRoom(room: string): string[] {
	const socketRoom = io.sockets.adapter.rooms.get(room);
	return socketRoom ? Array.from(socketRoom) : [];
}

function isSocketInRoom(socketId: string, room: string): boolean {
	return io.sockets.adapter.rooms.get(room)?.has(socketId) ?? false;
}

function isSocketId(value: string): boolean {
	return io.sockets.sockets.has(value);
}

function isValidLobbyCode(value: string): boolean {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{4,32}$/.test(value);
}

function enforceRateLimit(
	socket: Socket,
	buckets: Map<string, RateLimitBucket>,
	name: string,
	limit: number
): boolean {
	const now = Date.now();
	const bucket = buckets.get(name);
	if (!bucket || now - bucket.windowStartedAt >= rateLimitWindowMs) {
		buckets.set(name, { windowStartedAt: now, count: 1 });
		return true;
	}

	bucket.count++;
	if (bucket.count <= limit) {
		return true;
	}

	logger.warn('Socket %s exceeded %s rate limit: %d/%d', socket.id, name, bucket.count, limit);
	return false;
}

const leaveroom = (socket: Socket, code: string | null) => {
	if (!code) {
		return;
	}
	socket.leave(code);

	const lobby = allLobbies.get(code);
	if (lobby) {
		lobby.connectedCount = Math.max(0, lobby.connectedCount - 1);
	}

	if (getSocketsInRoom(code).length <= 0) {
		if (allLobbies.has(code)) {
			allLobbies.delete(code);
		}
		removePublicLobby(code);
	}
};
io.on('connection', (socket: Socket) => {
	connectionCount++;
	logger.info('Total connected: %d in %d lobbies', connectionCount, allLobbies.size);
	let code: string | null = null;
	const rateLimitBuckets = new Map<string, RateLimitBucket>();

	const clientPeerConfig: ClientPeerConfig = {
		forceRelayOnly: peerConfig.forceRelayOnly,
		iceServers: peerConfig.iceServers ? [...peerConfig.iceServers] : [],
	};

	if (turnServer) {
		//	const turnCredential = crypto.randomBytes(32).toString('base64');
		//	turnServer.addUser(socket.id, turnCredential);
		// logger.info(`Adding socket "${socket.id}" as TURN user.`);
		clientPeerConfig.iceServers.push({
			urls: `turn:${hostname}:${peerConfig.integratedRelay.listeningPort}`,
			username: peerConfig.integratedRelay.defaultUsername,
			credential: peerConfig.integratedRelay.defaultPassword,
		});
	}

	socket.emit('clientPeerConfig', clientPeerConfig);

	socket.on('join', (c: string, id: number, clientId: number, isHost?: boolean) => {
		if (
			!isValidLobbyCode(c) ||
			typeof id !== 'number' ||
			typeof clientId !== 'number' 
		) {
			socket.disconnect();
			logger.error(`Socket %s sent invalid join command: %s %d %d`, socket.id, c, id, clientId);
			return;
		}

		const client = {
			playerId: id,
			clientId: clientId,
		};
		clients.set(socket.id, client);

		let otherClients: any = {};
		const socketsInLobby = getSocketsInRoom(c);
		if (socketsInLobby.length >= maxLobbyClients && !isSocketInRoom(socket.id, c)) {
			socket.emit('error', { message: 'Lobby is full.' });
			logger.warn('Socket %s tried to join full lobby %s', socket.id, c);
			return;
		}

		if (socketsInLobby.length > 0) {
			for (let s of socketsInLobby) {
				if (s !== socket.id) otherClients[s] = clients.get(s);
			}
		}

		if (!allLobbies.has(c)) {
			allLobbies.set(c, { code: c, hostId: isHost ? clientId : -1, publicLobbyId: -1, connectedCount: 1 });
		} else {
			const lobby = allLobbies.get(c);
			lobby.connectedCount = Math.max(lobby.connectedCount, socketsInLobby.length) + (isSocketInRoom(socket.id, c) ? 0 : 1);
			if (isHost) {
				lobby.hostId = clientId;
				socket.to(c).emit('setHost', clientId);
			}
			socket.emit('setHost', lobby.hostId);
		}

		if (code != c) leaveroom(socket, code);
		code = c;
		socket.join(code);
		socket.to(code).emit('join', socket.id, client);
		socket.emit('setClients', otherClients);
	});

	socket.on('setHost', (c: string, clientId: number) => {
		if (code === c) {
			if (allLobbies.has(c)) {
				allLobbies.get(c).hostId = clientId;
				socket.to(code).emit('setHost', clientId);
			}
		}
	});

	socket.on('id', (id: number, clientId: number) => {
		if (typeof id !== 'number' || typeof clientId !== 'number') {
			socket.disconnect();
			logger.error(`Socket %s sent invalid id command: %d %d`, socket.id, id, clientId);
			return;
		}
		let client = clients.get(socket.id);
		if (client != null && client.clientId != null && client.clientId !== clientId) {
			///			socket.disconnect();
			logger.error(
				`Socket ${socket.id}->${client.clientId}->${clientId}->${id} sent invalid id command, attempted spoofing another client`
			);
			//			return;
		}
		client = {
			playerId: id,
			clientId: clientId,
		};
		clients.set(socket.id, client);
		socket.to(code).emit('setClient', socket.id, client);
	});

	socket.on('leave', () => {
		if (code) {
			leaveroom(socket, code);
			clients.delete(socket.id); // @ts-ignore
		}
	});

	socket.on('VAD', (activity: boolean) => {
		if (!enforceRateLimit(socket, rateLimitBuckets, 'VAD', maxVadEventsPerWindow)) {
			return;
		}
		if (typeof activity !== 'boolean') {
			logger.warn('Socket %s sent invalid VAD command: %j', socket.id, activity);
			return;
		}
		let client = clients.get(socket.id);
		if (code && client) {
			socket.to(code).emit('VAD', {
				activity,
				client,
				socketId: socket.id,
			});
		}
	});

	socket.on('join_lobby', (id: number, callbackFn) => {
		//ban check etc...
		if (lobbyCodes.has(id) && publicLobbies.has(lobbyCodes.get(id))) {
			let lobbyCode = lobbyCodes.get(id);
			let publicLobby = publicLobbies.get(lobbyCode);
			if (publicLobby.isPublic && publicLobby.gameState === GameState.LOBBY) {
				callbackFn(0, lobbyCode, publicLobby.server, publicLobby);
				return;
			} else {
				callbackFn(1, 'Lobby is not public anymore');
			}
		}
		callbackFn(1, 'Lobby not found :C');
	});

	socket.on('lobby', (c: string, publicLobby: PublicLobby) => {
		if (!enforceRateLimit(socket, rateLimitBuckets, 'lobby', maxLobbyEventsPerWindow)) {
			return;
		}
		if (code != c) {
			logger.error(`Got request to host lobby while not in it %s`, c, code);
			return;
		}
		if (!publicLobby.isPublic && !publicLobby.isPublic2) {
			removePublicLobby(c);
		} else {
			const publobby = publicLobbies.has(c) ? publicLobbies.get(c) : undefined;
			const id = publobby ? publobby.id : lobbyCount++;
			const stateTime =
				publobby &&
				((publobby.gameState === GameState.LOBBY && publicLobby.gameState === GameState.LOBBY) ||
					(publobby.gameState !== GameState.LOBBY && publicLobby.gameState !== GameState.LOBBY))
					? publobby.stateTime
					: Date.now();
			let lobby: PublicLobby = {
				id,
				title: publicLobby.title?.substring(0, 20) ?? 'ERROR',
				host: publicLobby.host?.substring(0, 10) ?? '',
				current_players: publicLobby.current_players ?? 0,
				max_players: publicLobby.max_players ?? 0,
				language: publicLobby.language?.substring(0, 5) ?? '',
				mods: publicLobby.mods?.substring(0, 20)?.toUpperCase() ?? '',
				isPublic: publicLobby.isPublic || publicLobby.isPublic2,
				server: publicLobby.server,
				gameState: publicLobby.gameState,
				stateTime,
			};
			lobbyCodes.set(id, c);
			publicLobbies.set(c, lobby);
			io.in('lobbybrowser').emit('update_lobby', lobby);
		}
	});

	socket.on('remove_lobby', (c: string) => {
		if (code != c) {
			logger.error(`Got request to host lobby while not in it %s`, c, code);
			return;
		}
		removePublicLobby(c);
	});

	socket.on('signal', (signal: Signal) => {
		if (!enforceRateLimit(socket, rateLimitBuckets, 'signal', maxSignalEventsPerWindow)) {
			return;
		}
		if (typeof signal !== 'object' || !signal.data || !signal.to || typeof signal.to !== 'string') {
			socket.disconnect();
			logger.error(`Socket %s sent invalid signal command: %j`, socket.id, signal);
			return;
		}
		const { to, data } = signal;
		const targetIsSocketInLobby = !!code && isSocketId(to) && isSocketInRoom(to, code);
		const targetIsRoom = !!code && !isSocketId(to) && io.sockets.adapter.rooms.has(to);
		if (!targetIsSocketInLobby && !targetIsRoom) {
			logger.warn('Socket %s tried to signal unknown or unauthorized target %s outside lobby %s', socket.id, to, code);
			return;
		}
		io.to(to).emit('signal', {
			data,
			from: socket.id,
			client: clients.get(socket.id),
		});
	});

	socket.on('lobbybrowser', (open) => {
		if (!enforceRateLimit(socket, rateLimitBuckets, 'lobbybrowser', maxLobbyEventsPerWindow)) {
			return;
		}
		if (!open) {
			socket.leave('lobbybrowser');
		} else {
			socket.join('lobbybrowser');
			io.in('lobbybrowser').emit('new_lobbies', Array.from(publicLobbies.values()));
		}
	});

	socket.on('disconnect', () => {
		leaveroom(socket, code);
		clients.delete(socket.id);
		connectionCount--;
		logger.info('Total connected: %d in %d lobbies', connectionCount, allLobbies.size);

		// if (turnServer) {
		// 	logger.info(`Removing socket "${socket.id}" as TURN user.`);
		// 	turnServer.removeUser(socket.id);
		// }
	});
});

server.listen(port);
logger.info('BetterCrewLink Server started: 127.0.0.1:%s', port);
