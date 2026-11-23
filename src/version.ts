declare const __PURGE_GIT_VERSION__: string | undefined;

export const CLI_VERSION =
  typeof __PURGE_GIT_VERSION__ === "string" ? __PURGE_GIT_VERSION__ : "0.0.0-dev";
