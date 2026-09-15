import type { AddressInfo } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import piChatMultiuserDemoExtension from "../src/extension.js";
import { PROTOCOL_VERSION, serverMessageSchema, type ServerMessage } from "../../../../pi-chat/src/shared/protocol.js";
import { getPiChatExtensionRegistry, resetPiChatExtensionRegistryForTests } from "../src/pi-chat.js";
import { FakeRuntimeAdapter } from "../../../../pi-chat/src/server/runtime-adapter.js";
import { createPiChatServer, type PiChatServer } from "../../../../pi-chat/src/server/server.js";

function receiveOfType(socket: WebSocket, type: ServerMessage["type"]): Promise<ServerMessage> {
  return new Promise((resolve) => {
    const onMessage = (data: Buffer) => {
      const parsed = serverMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success || parsed.data.type !== type) return;
      socket.off("message", onMessage);
      resolve(parsed.data);
    };
    socket.on("message", onMessage);
  });
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

/**
 * Stands in for the Pi host: the extension picks up its dialog surface from
 * `session_start`, and the name typed into that dialog is what a guest ends up
 * being called.
 */
function loadExtension(guestName: string): void {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  piChatMultiuserDemoExtension({ on: (event: string, handler: never) => handlers.set(event, handler) } as unknown as ExtensionAPI);
  handlers.get("session_start")?.({}, { ui: { input: async () => guestName } } as unknown as ExtensionContext);
}

/** The exact sequence a user performs: enable, invite, then grant write access. */
describe("multi-user demo end to end", () => {
  let server: PiChatServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    if (server) await server.close();
    resetPiChatExtensionRegistryForTests();
  });

  it("lets the owner enable the demo, keep a guest read-only, then grant write access", async () => {
    const extensions = getPiChatExtensionRegistry();
    loadExtension("Anna");
    server = createPiChatServer(new FakeRuntimeAdapter(), undefined, undefined, undefined, extensions);
    await new Promise<void>((resolve) => server!.httpServer.listen(0, "127.0.0.1", resolve));
    const port = (server.httpServer.address() as AddressInfo).port;

    const owner = await connect(`ws://127.0.0.1:${port}/ws`);
    sockets.push(owner);

    // 1. Owner turns the demo on from Settings.
    const enabled = receiveOfType(owner, "notification");
    owner.send(JSON.stringify({
      version: PROTOCOL_VERSION, sessionId: "fake-session",
      type: "runExtensionAction", actionId: "multiuser-demo.toggleEnabled",
    }));
    expect(await enabled).toMatchObject({ message: expect.stringContaining("enabled") });
    expect(extensions.connectionMode()).toBe("multi-connection");

    // 2. Owner creates a named link. The name is typed into the dialog, so it
    //    never travels in the URL where the guest could edit it.
    const invited = receiveOfType(owner, "notification");
    owner.send(JSON.stringify({
      version: PROTOCOL_VERSION, sessionId: "fake-session",
      type: "runExtensionAction", actionId: "multiuser-demo.invite",
    }));
    const link = ((await invited) as { message: string }).message;
    expect(link).toContain("Invite link for Anna");
    const token = /invite=([\w-]+)/.exec(link)?.[1];
    expect(token).toBeTruthy();

    // 3. A link nobody handed out is refused rather than let in as an owner.
    //    The socket opens before the server authorizes, so the rejection
    //    arrives as a protocol error and then a close. The listener goes on
    //    before the open handshake is awaited, because that rejection can beat
    //    the `await` back.
    const stranger = new WebSocket(`ws://127.0.0.1:${port}/ws?invite=not-a-real-token`);
    sockets.push(stranger);
    const rejected = receiveOfType(stranger, "protocolError");
    expect(await rejected).toMatchObject({ error: expect.stringContaining("not valid") });

    // 4. The guest opens the real invite link and must not displace the owner.
    const ownerClosed = new Promise<number>((resolve) => owner.once("close", (code) => resolve(code)));
    const guest = await connect(`ws://127.0.0.1:${port}/ws?invite=${token}`);
    sockets.push(guest);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(owner.readyState).toBe(WebSocket.OPEN);
    void ownerClosed;

    // 5. A read-only guest is refused.
    const refused = receiveOfType(guest, "protocolError");
    guest.send(JSON.stringify({ version: PROTOCOL_VERSION, sessionId: "fake-session", type: "prompt", message: "Hi" }));
    expect(await refused).toMatchObject({ error: expect.stringContaining("read-only guest") });

    // 6. Owner grants guest write access. The owner's own control has to show
    //    what it did: a toast that scrolls away is not a state indicator.
    const granted = receiveOfType(owner, "notification");
    const ownerSnapshot = receiveOfType(owner, "snapshot");
    owner.send(JSON.stringify({
      version: PROTOCOL_VERSION, sessionId: "fake-session",
      type: "runExtensionAction", actionId: "multiuser-demo.toggleGuestWrite",
    }));
    expect(await granted).toMatchObject({ message: expect.stringContaining("send prompts") });
    const snapshot = (await ownerSnapshot) as {
      extensions: { buttons: { id: string; label: string }[]; state: Record<string, { participants?: Array<{ label: string; role: string }> }> };
    };
    const guestControl = snapshot.extensions.buttons.find((button) => button.id === "multiuser-demo.permission.header");
    expect(guestControl?.label).toBe("Block guest prompts");
    // The guest is called what the owner typed into the dialog, and the
    // stranger that was turned away is in nobody's participant list.
    expect(snapshot.extensions.state["multiuser-demo"]?.participants).toEqual([
      expect.objectContaining({ role: "owner" }),
      expect.objectContaining({ label: "Anna", role: "guest" }),
    ]);

    // 7. The same guest prompt now goes through.
    const answered = receiveOfType(guest, "messageFinal");
    guest.send(JSON.stringify({ version: PROTOCOL_VERSION, sessionId: "fake-session", type: "prompt", message: "Hi" }));
    expect(await answered).toMatchObject({ type: "messageFinal" });
  });
});
