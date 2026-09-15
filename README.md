# pi-chat-multiuser

A [Pi](https://github.com/earendil-works/pi) extension that turns [Pi Chat](https://github.com/ManuelSelch/pi-chat) into a shared session: the owner mints a named invite link per guest, guests watch read-only by default, and the owner can hand write access over and take it back at runtime.

It is built on Pi Chat's extension API — slots, actions, badges, extension state, and authorization middleware — so none of this lives in Pi Chat core.

## What it does

- **Off by default.** Loading the extension changes nothing. Pi Chat keeps behaving as a single-user app until the owner presses *Enable multi-user demo* in Settings. An extension that widens who can reach a session should not do so just by being installed.
- **Named invite links.** *Invite* asks the owner for a name and mints `http://host/?invite=<token>`. The name is kept server-side; the link carries only the token, so a guest cannot relabel itself by editing the URL.
- **Read-only guests.** Guests may watch the session live but cannot send prompts, stop a run, answer dialogs, or run actions other than *Users*. *Allow guest prompts* grants write access; pressing it again revokes it.
- **Roles are visible.** Every browser gets its own badge (`Owner`, `Guest`, `Guest (read-only)`), and *Users* lists who is connected.

Unknown tokens are rejected rather than downgraded, and an unknown connection resolves to the lesser role, so a typo in a link never grants more access than the link carried.

**Sharing is server-wide, not per session.** An invite link authorizes a WebSocket connection before any session is in play, and Pi Chat already sends the tab list and every open session to every authorized connection. A guest is therefore a guest of the server and keeps one role across all open sessions; opening another session does not change who may do what.

Pi loads extensions once per open session, so this extension keeps its state in `chat.store` and passes `{ owner }` with every hook and badge. Without that, opening a second session installed a second, empty copy of the extension whose stale handlers kept vetoing guest prompts.

## Requirements

- Pi Chat checked out locally, since Pi Chat is not published to npm.
- The extension talks to Pi Chat's extension registry, which is a `globalThis` singleton shared with the running Pi Chat server.

`src/pi-chat.ts` is the only file that knows where Pi Chat lives. It assumes this layout:

```txt
~/.pi/agent/git/pi-chat
~/.pi/agent/git/github.com/ManuelSelch/pi-chat-multiuser   <- this repo
```

If your Pi Chat checkout is somewhere else, change the relative path in that one file.

## Install

Install from the local path so edits to `src/extension.ts` take effect on the next Pi restart, without a publish or a git round trip:

```sh
pi install ~/.pi/agent/git/github.com/ManuelSelch/pi-chat-multiuser
```

This adds the path to `packages` in `~/.pi/agent/settings.json`; Pi loads `./src/extension.ts` from the working copy. Remove it again with:

```sh
pi remove ~/.pi/agent/git/github.com/ManuelSelch/pi-chat-multiuser
```

Then start Pi Chat (`/pi-chat-start`) and open the web UI.

## Usage

1. **Settings → Enable multi-user demo.** Pi Chat switches to multi-connection mode, so several browsers can watch and drive the same session.
2. **Invite.** Type the guest's name; the notification contains their link.
3. Send the link. The guest joins as a read-only watcher.
4. **Allow guest prompts / Block guest prompts** hands write access over and takes it back.
5. **Users** shows who is connected and what guests may currently do.

Disabling returns Pi Chat to single-controller mode, clears outstanding invites, and revokes guest write access, so a link handed out earlier does not come back to life when the demo is switched on again.

## Development

```sh
npm install
npm test        # unit tests plus an end-to-end run against a real Pi Chat server
npm run typecheck
```

The tests import Pi Chat's source through the same relative path as `src/pi-chat.ts`, so they need the Pi Chat checkout in place, with its dependencies installed.

## License

MIT
