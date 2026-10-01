function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function normalizeHost(host) {
  let value = String(host || "localhost");
  if (!value.startsWith("[") && (value.match(/:/g) || []).length > 1)
    value = `[${value}]`;
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return "localhost";
  }
}

/** Resolve local tool links and link only to a peer in the same workspace. */
export async function getDevNavConfig({ kind, host, localPort, peerPort, workspaceId }) {
  const ownPort = validPort(localPort);
  const otherPort = validPort(peerPort);
  const hostname = normalizeHost(host);
  const ownUrl = ownPort ? `http://${hostname}:${ownPort}` : null;
  let peerUrl = null;
  const localGameHost = ["localhost", "127.0.0.1"].includes(hostname.toLowerCase());

  if (ownUrl && otherPort && (kind !== "game" || localGameHost)) {
    try {
      const response = await fetch(`http://127.0.0.1:${otherPort}/dev-nav-peer.json`, {
        signal: AbortSignal.timeout(300),
      });
      const identity = response.ok ? await response.json() : null;
      const expectedKind = kind === "game" ? "mapgen" : "game";
      if (identity?.kind === expectedKind && identity.workspace === workspaceId)
        peerUrl = `http://${hostname}:${otherPort}`;
    } catch {
      // The configured peer is not running in this workspace.
    }
  }

  return kind === "game"
    ? { mainUrl: ownUrl, mapgenUrl: peerUrl }
    : { mainUrl: peerUrl, mapgenUrl: ownUrl };
}
