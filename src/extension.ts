import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getPiChatExtensionRegistry } from "./pi-chat.js";

/**
 * Multi-user Pi Chat built on named invite links.
 *
 * Everything here rides on Pi Chat's extension API, so Pi Chat core stays
 * single-user and knows nothing about invites, roles, or guests.
 *
 * The demo is off by default: loading the extension must not silently open a
 * single-user session to every browser that can reach the port. Settings has a
 * button that switches it on, and until then Pi Chat behaves exactly as if the
 * extension were not loaded.
 *
 * Once enabled, Pi Chat is in multi-connection mode, so several browsers can
 * watch and drive the same session. The owner mints one link per guest and
 * names the guest while doing so; everyone who arrives without a link is an
 * owner.
 *
 * The name lives here rather than in the link. A query parameter is editable by
 * whoever holds the URL, so `?name=...` would be a claim rather than a fact,
 * and a participant list that anyone can rewrite does not help people tell each
 * other apart. The link therefore carries only the token.
 *
 * Guests are read-only by default: that is the safe default for a link someone
 * else opened. The owner can hand over write access at runtime, and revoking it
 * again takes effect on the guest's next attempt.
 */
type Role = "owner" | "guest";

/**
 * Only what the connection actually brought with it is stored. Role and label
 * are derived on read: a participant record that carries its own role drifts
 * out of step with the demo's on/off state, and a label handed out from a
 * running count repeats itself as soon as somebody disconnects.
 */
interface Participant {
  /** Join order, so derived owner numbers stay stable while others come and go. */
  joined: number;
  invite?: string;
  /** The name the owner gave this guest when minting its link. */
  name?: string;
}

interface Invite {
  name: string;
  createdBy: string;
}

const NAME_MAX = 32;

export default function piChatMultiuserDemoExtension(pi: ExtensionAPI): void {
  const chat = getPiChatExtensionRegistry();
  const participants = new Map<string, Participant>();
  const invites = new Map<string, Invite>();
  let joins = 0;
  let enabled = false;
  let guestsMayWrite = false;
  // Learned from the first browser that connects, so the invite link the owner
  // is shown points at the host they actually reached rather than a guess.
  let origin = "";

  /**
   * `ctx.ui` is only handed to event handlers, not to the extension factory, so
   * the dialog surface has to be captured from a session event and kept. Pi
   * rebinds it per session; the demo drives a single session, which is the
   * assumption behind holding on to one reference.
   */
  let ui: ExtensionUIContext | undefined;
  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
  });

  // While disabled every browser is an owner, so nothing is restricted and the
  // enable button below stays usable. Once enabled a connection the demo has
  // never seen falls back to the lesser role: every real browser passes through
  // `connection.authorize` before it can act, so an unknown id here is an
  // anomaly, and an anomaly should not be granted control of the session.
  const roleOf = (connectionId?: string): Role => {
    if (!enabled) return "owner";
    const participant = participants.get(connectionId ?? "");
    if (!participant) return "guest";
    return participant.invite ? "guest" : "owner";
  };

  /**
   * Owners are numbered by join order rather than by a counter that is bumped
   * per connection, so the second owner stays "Owner 2" and a reconnect after
   * someone left cannot produce a second "Owner 2".
   */
  function describe(): Array<{ id: string; role: Role; label: string; invite?: string }> {
    let owners = 0;
    return [...participants.entries()]
      .sort(([, a], [, b]) => a.joined - b.joined)
      .map(([id, participant]) => {
        const role = roleOf(id);
        if (role === "guest") return { id, role, label: participant.name ?? "Guest", invite: participant.invite };
        owners += 1;
        return { id, role, label: `Owner ${owners}`, ...(participant.invite ? { invite: participant.invite } : {}) };
      });
  }

  const guestCount = (): number => describe().filter((item) => item.role === "guest").length;

  function publishState(): void {
    chat.setExtensionState("multiuser-demo", ({ connectionId }) => ({
      enabled,
      role: roleOf(connectionId),
      guestsMayWrite,
      connectionCount: participants.size,
      participants: describe(),
      invites: [...invites.entries()].map(([token, invite]) => ({ token, name: invite.name })),
    }));
  }

  /**
   * Buttons are a flat registry keyed by id, so re-registering the same ids is
   * how the visible controls follow the on/off state.
   */
  function publishButtons(): void {
    chat.registerButton({
      id: "multiuser-demo.enable.settings",
      slot: "settings.section",
      label: enabled ? "Disable multi-user demo" : "Enable multi-user demo",
      actionId: "multiuser-demo.toggleEnabled",
    });
    if (!enabled) {
      chat.unregisterButton("multiuser-demo.status.header");
      chat.unregisterButton("multiuser-demo.permission.header");
      chat.unregisterButton("multiuser-demo.invite.header");
      return;
    }
    chat.registerButton({
      id: "multiuser-demo.invite.header",
      slot: "session.header.right",
      label: "Invite",
      actionId: "multiuser-demo.invite",
    });
    chat.registerButton({
      id: "multiuser-demo.status.header",
      slot: "session.header.right",
      label: "Users",
      actionId: "multiuser-demo.status",
    });
    // Named after what pressing it does, like the enable button above. A fixed
    // "Guest access" label left the owner with nothing but a toast to tell the
    // two states apart, so the toggle looked like it had done nothing.
    chat.registerButton({
      id: "multiuser-demo.permission.header",
      slot: "session.header.right",
      label: guestsMayWrite ? "Block guest prompts" : "Allow guest prompts",
      actionId: "multiuser-demo.toggleGuestWrite",
    });
  }

  publishState();
  publishButtons();

  // Each browser is told about its own role, not about everyone's, so the badge
  // has to be resolved per connection rather than registered once.
  chat.registerBadge(({ connectionId }) => {
    if (!enabled) return undefined;
    if (roleOf(connectionId) === "owner") return { id: "multiuser-demo.role", slot: "session.status", label: "Owner", tone: "green" };
    return {
      id: "multiuser-demo.role",
      slot: "session.status",
      label: guestsMayWrite ? "Guest" : "Guest (read-only)",
      tone: guestsMayWrite ? "yellow" : "red",
    };
  });

  chat.registerAction({
    id: "multiuser-demo.toggleEnabled",
    title: "Enable or disable the multi-user demo",
    run: (ctx) => {
      if (roleOf(ctx.connectionId) !== "owner") throw new Error("Only the owner can turn the multi-user demo off.");
      enabled = !enabled;
      if (enabled) {
        // Connections that were already open predate the demo and carry no
        // invite, so they come out as owners without touching their records.
        chat.setConnectionMode("multi-connection");
      } else {
        // Back to a single controller. Neither guest write access nor the
        // outstanding links survive a round trip through the off state: a link
        // handed out earlier must not quietly come back to life when the demo
        // is switched on again later.
        chat.setConnectionMode("single-controller");
        guestsMayWrite = false;
        invites.clear();
      }
      publishButtons();
      publishState();
      ctx.notify(enabled ? "Multi-user demo enabled: other browsers can join this session." : "Multi-user demo disabled.");
    },
  });

  chat.registerAction({
    id: "multiuser-demo.invite",
    title: "Create an invite link",
    run: async (ctx) => {
      if (roleOf(ctx.connectionId) !== "owner") throw new Error("Only the owner can create invite links.");
      if (!enabled) throw new Error("Enable the multi-user demo before inviting anyone.");
      if (!ui) throw new Error("No dialog surface is available to ask for a name.");
      const answer = await ui.input("Name for this guest", "e.g. Anna");
      const name = answer?.trim().slice(0, NAME_MAX);
      // An empty answer is a cancelled dialog, which is not an error.
      if (!name) return;
      const token = randomUUID();
      invites.set(token, { name, createdBy: ctx.connectionId ?? "owner" });
      publishState();
      ctx.notify(`Invite link for ${name}: ${origin}/?invite=${token}`);
    },
  });

  chat.registerAction({
    id: "multiuser-demo.status",
    title: "Show connected users",
    run: (ctx) => {
      const listed = describe().map((item) => `${item.label} (${item.role})`).join(", ") || "none";
      ctx.notify(
        `Multi-user demo: ${participants.size} connected, ${guestCount()} guest(s). ` +
          `Guests may ${guestsMayWrite ? "send prompts" : "only watch"}. Participants: ${listed}.`,
      );
    },
  });

  chat.registerAction({
    id: "multiuser-demo.toggleGuestWrite",
    title: "Allow or block guest prompts",
    run: (ctx) => {
      // Only the owner may change the policy, otherwise a guest could simply
      // grant itself write access with the same button.
      if (roleOf(ctx.connectionId) !== "owner") throw new Error("Only the owner can change guest access.");
      guestsMayWrite = !guestsMayWrite;
      publishButtons();
      publishState();
      ctx.notify(`Guests may now ${guestsMayWrite ? "send prompts" : "only watch"}.`);
    },
  });

  chat.use("connection.authorize", ({ connectionId, request }) => {
    const token = enabled ? request?.query.invite : undefined;
    if (token) {
      const invite = invites.get(token);
      // An unknown token is rejected rather than downgraded to a guest, and
      // above all it never falls through to the owner branch below: a typo in a
      // link must not hand out more access than the link itself carries.
      if (!invite) return { allow: false, reason: "This invite link is not valid." };
      joins += 1;
      participants.set(connectionId, { joined: joins, invite: token, name: invite.name });
      publishState();
      return;
    }
    const host = request?.headers.host;
    if (!origin && typeof host === "string") origin = `http://${host}`;
    joins += 1;
    participants.set(connectionId, { joined: joins });
    publishState();
  });

  chat.use("prompt.authorize", ({ connectionId }) => {
    if (roleOf(connectionId) === "owner" || guestsMayWrite) return { allow: true };
    return { allow: false, reason: "This browser joined as a read-only guest. Ask the owner to allow guest prompts." };
  });

  chat.use("abort.authorize", ({ connectionId }) => {
    if (roleOf(connectionId) === "owner" || guestsMayWrite) return { allow: true };
    return { allow: false, reason: "Read-only guests cannot stop a run." };
  });

  // Dialogs are session state, so every browser sees the owner's naming prompt
  // and a tool call's permission gate alike. A read-only guest must not answer
  // either. This deliberately follows the same rule as prompts: a guest allowed
  // to send prompts can also answer the permission gate its own prompt opened,
  // which would otherwise stall until the owner looked at the screen.
  chat.use("dialog.authorize", ({ connectionId }) => {
    if (roleOf(connectionId) === "owner" || guestsMayWrite) return { allow: true };
    return { allow: false, reason: "Read-only guests cannot answer dialogs." };
  });

  chat.use("action.authorize", ({ connectionId, actionId }) => {
    if (roleOf(connectionId) === "owner") return { allow: true };
    // Reading the participant list is harmless; everything else changes state
    // the guest does not own, including the app-level restart.
    if (actionId === "multiuser-demo.status") return { allow: true };
    return { allow: false, reason: "Read-only guests cannot change this session." };
  });

  chat.on("connection.close", ({ connectionId }) => {
    participants.delete(connectionId);
    publishState();
  });
}
