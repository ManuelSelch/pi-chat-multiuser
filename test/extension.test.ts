import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import piChatMultiuserDemoExtension from "../src/extension.js";
import type { PiChatExtensionRegistry } from "../src/pi-chat.js";
import { getPiChatExtensionRegistry, resetPiChatExtensionRegistryForTests } from "../src/pi-chat.js";

afterEach(resetPiChatExtensionRegistryForTests);

/**
 * Dialogs reach the extension through the action context, so the host only has
 * to hand the factory an `ExtensionAPI`.
 */
function load(input: (title: string, placeholder?: string) => Promise<string | undefined> = async () => undefined) {
  const registry = getPiChatExtensionRegistry();
  answer = input;
  piChatMultiuserDemoExtension({ on: () => {} } as unknown as ExtensionAPI);
  return registry;
}

/** What the modal of the session an action ran from returns. */
let answer: (title: string, placeholder?: string) => Promise<string | undefined> = async () => undefined;

const actionContext = (connectionId?: string) => ({
  connectionId,
  sessionId: "s1",
  notify: vi.fn(),
  ui: { input: (title: string, placeholder?: string) => answer(title, placeholder) } as never,
});

const ownerRequest = { query: {}, headers: { host: "localhost:4000" } } as never;

/**
 * Every real browser passes through `connection.authorize` before it can act,
 * so the owner has to be a known connection here too.
 */
async function enable(registry: PiChatExtensionRegistry): Promise<void> {
  await registry.authorize("connection.authorize", { connectionId: "owner", request: ownerRequest });
  await registry.runAction("multiuser-demo.toggleEnabled", actionContext("owner"));
}
const inviteRequest = (token: string) => ({ query: { invite: token }, headers: {} }) as never;

/** Mints a link the way the owner does and returns the token from the notification. */
async function createInvite(registry: PiChatExtensionRegistry, name: string): Promise<string> {
  const ctx = actionContext("owner");
  await registry.runAction("multiuser-demo.invite", ctx);
  const message = String(ctx.notify.mock.calls[0]?.[0] ?? "");
  const token = /invite=([\w-]+)/.exec(message)?.[1];
  if (!token) throw new Error(`No invite token in: ${message}`);
  expect(message).toContain(name);
  return token;
}

describe("multi-user demo extension", () => {
  it("stays off until the settings button enables it", async () => {
    const registry = load();

    expect(registry.connectionMode()).toBe("single-controller");
    const snapshot = registry.snapshot({ connectionId: "guest" });
    expect(snapshot.buttons.map((button) => button.slot)).toEqual(["settings.section"]);
    expect(snapshot.buttons[0]).toMatchObject({ label: "Enable multi-user demo" });
    expect(snapshot.badges).toEqual([]);
    expect(snapshot.state["multiuser-demo"]).toMatchObject({ enabled: false });

    // While disabled an invited browser is not restricted at all.
    await registry.authorize("connection.authorize", { connectionId: "guest", request: inviteRequest("demo") });
    expect(await registry.authorize("prompt.authorize", { connectionId: "guest" })).toEqual({ allow: true });
  });

  it("switches to multi-connection mode and guards guests once enabled", async () => {
    const registry = load(async () => "Anna");
    await enable(registry);

    expect(registry.connectionMode()).toBe("multi-connection");
    expect(registry.snapshot().buttons.map((button) => button.id)).toEqual([
      "multiuser-demo.enable.settings",
      "multiuser-demo.invite.header",
      "multiuser-demo.status.header",
      "multiuser-demo.permission.header",
    ]);
    expect(registry.snapshot().buttons[0]).toMatchObject({ label: "Disable multi-user demo" });

    const token = await createInvite(registry, "Anna");
    await registry.authorize("connection.authorize", { connectionId: "guest", request: inviteRequest(token) });
    expect(await registry.authorize("prompt.authorize", { connectionId: "guest" })).toMatchObject({ allow: false });
    expect(registry.snapshot({ connectionId: "guest" }).badges).toEqual([
      { id: "multiuser-demo.role", slot: "session.status", label: "Guest (read-only)", tone: "red" },
    ]);
  });

  it("names the guest from the invite the owner created, not from the link", async () => {
    const registry = load(async () => "  Anna  ");
    await enable(registry);
    await registry.authorize("connection.authorize", { connectionId: "owner", request: ownerRequest });

    const ctx = actionContext("owner");
    await registry.runAction("multiuser-demo.invite", ctx);
    // The link points at the host the owner actually reached.
    expect(String(ctx.notify.mock.calls[0]?.[0])).toMatch(/^Invite link for Anna: http:\/\/localhost:4000\/\?invite=[\w-]+$/);

    const token = /invite=([\w-]+)/.exec(String(ctx.notify.mock.calls[0]?.[0]))?.[1] ?? "";
    // A guest cannot rename itself through the query string.
    await registry.authorize("connection.authorize", {
      connectionId: "guest",
      request: { query: { invite: token, name: "Owner" }, headers: {} } as never,
    });

    const state = registry.snapshot().state["multiuser-demo"] as { participants: Array<{ id: string; label: string; role: string }> };
    expect(state.participants).toContainEqual({ id: "guest", role: "guest", label: "Anna", invite: token });
  });

  it("rejects a link that was never handed out instead of granting owner access", async () => {
    const registry = load(async () => "Anna");
    await enable(registry);

    const result = await registry.authorize("connection.authorize", { connectionId: "stranger", request: inviteRequest("guessed") });
    expect(result).toMatchObject({ allow: false, reason: expect.stringContaining("not valid") });
    // The rejected browser joined nobody, and an unknown id is never an owner.
    expect(registry.snapshot().state["multiuser-demo"]).toMatchObject({ connectionCount: 1 });
    expect(await registry.authorize("action.authorize", { connectionId: "stranger", actionId: "multiuser-demo.invite" })).toMatchObject({ allow: false });
  });

  it("keeps a cancelled naming dialog from creating a link", async () => {
    const registry = load(async () => undefined);
    await enable(registry);

    const ctx = actionContext("owner");
    await registry.runAction("multiuser-demo.invite", ctx);
    expect(ctx.notify).not.toHaveBeenCalled();
    expect(registry.snapshot().state["multiuser-demo"]).toMatchObject({ invites: [] });
  });

  it("lets only the owner create invites and answer dialogs", async () => {
    const registry = load(async () => "Anna");
    await enable(registry);
    const token = await createInvite(registry, "Anna");
    await registry.authorize("connection.authorize", { connectionId: "guest", request: inviteRequest(token) });

    expect(await registry.authorize("action.authorize", { connectionId: "guest", actionId: "multiuser-demo.invite" })).toMatchObject({ allow: false });
    expect(await registry.authorize("dialog.authorize", { connectionId: "guest" })).toMatchObject({ allow: false });
    expect(await registry.authorize("dialog.authorize", { connectionId: "owner" })).toEqual({ allow: true });

    // A guest trusted with prompts can also answer the gate its own prompt opens.
    await registry.runAction("multiuser-demo.toggleGuestWrite", actionContext("owner"));
    expect(await registry.authorize("dialog.authorize", { connectionId: "guest" })).toEqual({ allow: true });
  });

  it("drops outstanding links when the demo is switched off", async () => {
    const registry = load(async () => "Anna");
    await enable(registry);
    const token = await createInvite(registry, "Anna");

    const off = actionContext("owner");
    await registry.runAction("multiuser-demo.toggleEnabled", off);
    await registry.runAction("multiuser-demo.toggleEnabled", off);

    expect(await registry.authorize("connection.authorize", { connectionId: "guest", request: inviteRequest(token) })).toMatchObject({ allow: false });
  });

  it("restores single-controller mode and hides its controls when disabled again", async () => {
    const registry = load(async () => "Anna");
    await enable(registry);
    await registry.authorize("connection.authorize", { connectionId: "guest", request: inviteRequest(await createInvite(registry, "Anna")) });
    await registry.runAction("multiuser-demo.toggleGuestWrite", actionContext("owner"));
    await registry.runAction("multiuser-demo.toggleEnabled", actionContext("owner"));

    expect(registry.connectionMode()).toBe("single-controller");
    expect(registry.snapshot().buttons.map((button) => button.id)).toEqual(["multiuser-demo.enable.settings"]);
    expect(registry.snapshot({ connectionId: "guest" }).state["multiuser-demo"]).toMatchObject({ enabled: false, guestsMayWrite: false });
    expect(await registry.authorize("prompt.authorize", { connectionId: "guest" })).toEqual({ allow: true });
  });

  it("keeps roles and owner numbers stable across repeated toggling", async () => {
    const registry = load(async () => "Anna");
    await enable(registry);
    await registry.authorize("connection.authorize", { connectionId: "guest", request: inviteRequest(await createInvite(registry, "Anna")) });
    const participants = () =>
      (registry.snapshot().state["multiuser-demo"] as { participants: Array<{ id: string; role: string; label: string }> }).participants;
    const before = participants();

    // Off and on again three times: the guest must not be promoted to an owner
    // on the way, and nobody gains a second owner number.
    for (let round = 0; round < 3; round += 1) {
      await registry.runAction("multiuser-demo.toggleEnabled", actionContext("owner"));
      await registry.runAction("multiuser-demo.toggleEnabled", actionContext("owner"));
    }

    expect(participants()).toEqual(before);
    expect(participants().filter((item) => item.role === "owner")).toHaveLength(1);
    expect(await registry.authorize("prompt.authorize", { connectionId: "guest" })).toMatchObject({ allow: false });
  });

  it("numbers owners by join order so a reconnect cannot duplicate a number", async () => {
    const registry = load();
    await enable(registry);
    await registry.authorize("connection.authorize", { connectionId: "second", request: ownerRequest });
    const labels = () =>
      (registry.snapshot().state["multiuser-demo"] as { participants: Array<{ label: string }> }).participants.map((item) => item.label);
    expect(labels()).toEqual(["Owner 1", "Owner 2"]);

    // The first owner leaves and a new browser arrives: the survivor keeps its
    // place in the list, and the newcomer does not reuse a number still on screen.
    await registry.emit("connection.close", { connectionId: "owner" });
    await registry.authorize("connection.authorize", { connectionId: "third", request: ownerRequest });

    expect(labels()).toEqual(["Owner 1", "Owner 2"]);
    expect(new Set(labels()).size).toBe(2);
  });

  // Pi loads extensions once per open session, so opening a second tab runs the
  // factory again. That used to hand out a fresh disabled closure while the
  // first load's authorization handlers stayed behind and kept vetoing against
  // it, which left the guest read-only whatever the owner pressed.
  describe("a second session loading the extension again", () => {
    it("keeps the roles, invites and policy the owner set up", async () => {
      const registry = load(async () => "Anna");
      await enable(registry);
      const token = await createInvite(registry, "Anna");
      await registry.authorize("connection.authorize", { connectionId: "guest", request: inviteRequest(token) });

      load(async () => "Anna");

      expect(registry.connectionMode()).toBe("multi-connection");
      expect(registry.snapshot({ connectionId: "guest" }).state["multiuser-demo"]).toMatchObject({ enabled: true, role: "guest" });
      // The guest keeps the link it joined with rather than being locked out.
      expect(await registry.authorize("connection.authorize", { connectionId: "late", request: inviteRequest(token) })).toEqual({ allow: true });
    });

    it("does not leave a stale handler vetoing guest prompts", async () => {
      const registry = load(async () => "Anna");
      await enable(registry);
      await registry.authorize("connection.authorize", { connectionId: "guest", request: inviteRequest(await createInvite(registry, "Anna")) });

      load(async () => "Anna");
      await registry.runAction("multiuser-demo.toggleGuestWrite", actionContext("owner"));

      expect(await registry.authorize("prompt.authorize", { connectionId: "guest" })).toEqual({ allow: true });
    });
  });

  it("refuses to let a guest turn the demo off", async () => {
    const registry = load(async () => "Anna");
    await enable(registry);
    await registry.authorize("connection.authorize", { connectionId: "guest", request: inviteRequest(await createInvite(registry, "Anna")) });

    await expect(registry.runAction("multiuser-demo.toggleEnabled", actionContext("guest"))).rejects.toThrow(/Only the owner/);
    expect(registry.connectionMode()).toBe("multi-connection");
  });
});
