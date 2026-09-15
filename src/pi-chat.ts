/**
 * The one place that knows where the Pi Chat checkout is.
 *
 * Pi Chat's extension registry is a `globalThis` singleton, so this import is
 * about types and the accessor, not about bundling Pi Chat: the object returned
 * here is the same one the running Pi Chat server uses.
 *
 * Pi Chat is not published to npm, so it is reached by path rather than by
 * package name. The default assumes the layout this repository is developed in:
 *
 *   ~/.pi/agent/git/pi-chat
 *   ~/.pi/agent/git/github.com/ManuelSelch/pi-chat-multiuser   <- here
 *
 * If your checkout lives somewhere else, this relative path is the only line to
 * change.
 */
export * from "../../../../pi-chat/src/server/extension-registry.js";
