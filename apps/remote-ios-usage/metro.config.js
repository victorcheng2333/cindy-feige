const path = require("path");
const fs = require("fs");
const { getDefaultConfig } = require("expo/metro-config");
const config = getDefaultConfig(__dirname);
const root = path.resolve(__dirname, "../..");
config.watchFolders = [root];
config.resolver.nodeModulesPaths = [path.join(root, "node_modules")];
config.resolver.extraNodeModules = Object.fromEntries(
  ["auth-client", "device-link", "device-link-protocol"].map((name) => [
    "@cindy/" + name,
    path.join(root, "packages", name),
  ]),
);
config.resolver.resolveRequest = (context, name, platform) => {
  if (
    name.startsWith(".") &&
    name.endsWith(".js") &&
    context.originModulePath.includes("/packages/")
  ) {
    const ts = path.resolve(
      path.dirname(context.originModulePath),
      name.slice(0, -3) + ".ts",
    );
    if (fs.existsSync(ts)) return { type: "sourceFile", filePath: ts };
  }
  return context.resolveRequest(context, name, platform);
};
module.exports = config;
