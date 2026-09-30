export function getDevNavConfig(options: {
  kind: "game" | "mapgen";
  host: string;
  localPort: number | undefined;
  peerPort: string | number | undefined;
  workspaceId: string;
}): Promise<{ mainUrl: string | null; mapgenUrl: string | null }>;
