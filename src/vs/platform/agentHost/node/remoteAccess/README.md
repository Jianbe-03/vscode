# Remote Access core (CreaEditor)

Serves the web Agents window and the Agent Host Protocol (AHP) WebSocket on one HTTP port, so a phone or another computer can use an agent host. Used by the desktop app's **Remote Access** (main process, relaying to the local agent host) and by **CreaEditor Server** (in the headless agent host process).

## Files

| File | What it does |
|---|---|
| `remoteAccessServer.ts` | `startRemoteAccessServer(options)`: the HTTP + WebSocket server. Connectors `RemoteAccessProtocolServer` and `createSocketRelayConnector`. |
| `remoteAccessAuth.ts` | `RemoteAccessAuth.create(dir, logService)`: device keys, pairing codes, password, rate limiting, devices list, sign-out. |
| `remoteAccessPage.ts` | The page at `/` (pairing form, then boots `sessions.web.main.internal` from `/static/`). |
| `tailscale.ts` | Tailscale address and status, Funnel on/off/status. |

## Using it in a process that runs the agent host (the server app)

```ts
const auth = disposables.add(await RemoteAccessAuth.create(join(userDataPath, 'remote-access'), logService));
const remoteClients = disposables.add(await RemoteAccessProtocolServer.create());
// Same sessions as every other client: give it its own ProtocolServerHandler.
disposables.add(instantiationService.createInstance(ProtocolServerHandler, agentService, stateManager, remoteClients, handlerConfig, clientFileSystemProvider));
const server = disposables.add(await startRemoteAccessServer({
	hosts: ['100.x.y.z'],          // or ['127.0.0.1'] behind Funnel/Caddy; several hosts share one port
	port: 8790,                   // 0 = pick a free port, read server.port
	webRoot: '<app>/out-sessions-web', // output of `build/next/index.ts bundle --nls --target web`
	auth,
	publicMode: false,            // true: pairing also needs the password (set with auth.setPassword)
	connector: remoteClients,
	logService,
	product: { name: 'CreaEditor Server', version, commit },
	hostName: os.hostname(),
}));
const pairing = auth.createPairingCode(); // show `http(s)://<address>:<port>/#pair=${pairing.code}` (as a QR code)
```

The desktop app runs the server in the main process and relays to the agent host's on-demand socket instead: `connector: createSocketRelayConnector(refresh => getSocketPath(refresh), logService)`.

## HTTP API

| Route | Auth | Answer |
|---|---|---|
| `GET /health` | none | `{ status: 'ok', product, version, commit, publicMode, webUi, uptimeSeconds }` (no secrets) |
| `GET /` | none | The pairing/boot page |
| `GET /static/<path>` | none | Files of `webRoot` (the open-source web build; no user data) |
| `GET /api/info` | none | `{ hostName, product, publicMode, passwordRequired, webUi }` |
| `POST /api/pair` `{ code, deviceName, password? }` | pairing code | `{ deviceId, deviceName, deviceKey }`, or 403 `{ error: invalidCode \| expiredCode \| passwordRequired \| wrongPassword \| noPasswordSet }`, 429 `{ error: 'lockedOut', retryAfterSeconds }` |
| `GET /api/device` | `Authorization: Bearer <deviceKey>` | `{ id, name }` or 401 |
| `POST /api/sign-out` | `Authorization: Bearer <deviceKey>` | Signs this device out |
| WebSocket `/ahp?tkn=<deviceKey>` (or `/`) | device key | AHP JSON-RPC text frames; 403 during the upgrade without a valid key; closed with code 4001 when the device is signed out |

## Security model

- Device keys are `<id>.<256-bit secret>`; only the SHA-256 of the secret is stored (`remote-access-auth.json`, mode 0600, directory 0700).
- Pairing codes: 10 characters (~49 bits), one at a time, single use, 10 minutes.
- Public mode: pairing also needs the password (scrypt, N=16384). Devices paired before keep working; sign them out to be strict.
- Rate limiting: 5 failed pairing/password attempts per client in 15 minutes lock that client for 15 minutes; 30 failures from all clients lock pairing for everyone. Wrong device keys only count for their own client. Behind a loopback proxy (Funnel), the first `X-Forwarded-For` address is the client.
- Bind to a private address (Tailscale) or loopback behind an HTTPS proxy; never `0.0.0.0` on a public network. Plain HTTP inside a tailnet is encrypted by WireGuard.
