const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const repoRoot = path.resolve(__dirname, "..");
const corePackage = path.resolve(repoRoot, "../TeleBox-Core/package.json");
const projectRequire = createRequire(corePackage);
const esbuild = projectRequire("esbuild");
const pluginFiles = [
  "ai/ai.ts",
  "bgp/bgp.ts",
  "checkapi/checkapi.ts",
  "cy/cy.ts",
  "deepwiki/deepwiki.ts",
  "eat/eat.ts",
  "eatgif/eatgif.ts",
  "getstickers/getstickers.ts",
  "javdb/javdb.ts",
  "pic_to_sticker/pic_to_sticker.ts",
  "quote/quote.ts",
  "speedlink/speedlink.ts",
  "speedtest/speedtest.ts",
  "ssh/ssh.ts",
  "subinfo/subinfo.ts",
  "yvlu/yvlu.ts",
];
const sources = Object.fromEntries(
  pluginFiles.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), "utf8")]),
);

for (const [file, source] of Object.entries(sources)) {
  esbuild.transformSync(source, { loader: "ts", format: "cjs", target: "node20", sourcefile: file });
}

assert.doesNotMatch(sources["checkapi/checkapi.ts"], /httpAgent\s*:|new\s+\(require\(["']http["']\)\.Agent\)/);

const speedlinkSource = sources["speedlink/speedlink.ts"];
assert.doesNotMatch(speedlinkSource, /installDependencies|execFileAsync\(["'](?:npm|sudo)["']|\bexecSync\b/);
assert.match(speedlinkSource, /getServersDatabase\(\)/);
assert.match(speedlinkSource, /cleanup\(\): void[\s\S]*?db\.close\(\)/);

const cySource = sources["cy/cy.ts"];
assert.doesNotMatch(cySource, /setInterval\(/);
assert.doesNotMatch(cySource, /^import .* from ["']canvas["']/m);
assert.match(cySource, /function getCanvasModule\(\)/);
assert.match(cySource, /private scheduleConfig = readScheduleConfig\(\)/);
assert.match(cySource, /private runScheduledTick\(\): void[\s\S]*?\.catch\([\s\S]*?\.finally\(/);
assert.match(cySource, /private disposed = false[\s\S]*?cleanup\(\): void[\s\S]*?this\.disposed = true/);

for (const file of [
  "ai/ai.ts",
  "bgp/bgp.ts",
  "eat/eat.ts",
  "eatgif/eatgif.ts",
  "pic_to_sticker/pic_to_sticker.ts",
  "speedlink/speedlink.ts",
  "speedtest/speedtest.ts",
]) {
  assert.doesNotMatch(sources[file], /^import (?!type\b).* from ["']sharp["']/m, file);
  assert.match(sources[file], /function getSharp\(\)/, file);
}

for (const file of ["bgp/bgp.ts", "javdb/javdb.ts", "subinfo/subinfo.ts"]) {
  assert.doesNotMatch(sources[file], /^import .* from ["']cheerio["']/m, file);
  assert.match(sources[file], /function getCheerio\(\)/, file);
}

for (const file of ["getstickers/getstickers.ts", "ssh/ssh.ts"]) {
  assert.doesNotMatch(sources[file], /^import .* from ["']archiver["']/m, file);
  assert.match(sources[file], /function createZipArchive\(/, file);
}

const deepwikiSource = sources["deepwiki/deepwiki.ts"];
assert.doesNotMatch(deepwikiSource, /^import .*@modelcontextprotocol\/sdk/m);
assert.match(deepwikiSource, /await Promise\.all\(\[[\s\S]*?@modelcontextprotocol\/sdk/);

function loadTsModule(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const compiled = esbuild.transformSync(fs.readFileSync(sourcePath, "utf8"), {
    loader: "ts",
    format: "cjs",
    target: "node20",
    sourcefile: sourcePath,
  }).code;
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-resource-test-"));
  const mocks = {
    "@utils/authGuards": { safeGetMe: async () => undefined },
    "@utils/cronManager": { cronManager: {} },
    "@utils/htmlEscape": { htmlEscape: String },
    "@utils/npm_install": { npm_install: () => undefined },
    "@utils/pathHelpers": {
      createDirectoryInAssets: () => testRoot,
      createDirectoryInTemp: () => testRoot,
    },
    "@utils/pluginBase": { Plugin: class Plugin {} },
    "@utils/pluginManager": {
      dealCommandPluginWithMessage: async () => undefined,
      getCommandFromMessage: async () => undefined,
      getPrefixes: () => ["."],
    },
    "@utils/runtimeManager": { getGlobalClient: async () => undefined },
    "@utils/safeGetMessages": {
      safeGetMessages: async () => [],
      safeGetReplyMessage: async () => undefined,
    },
    "@utils/tlRevive": { reviveEntities: (value) => value },
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };

  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(corePackage));
  try {
    loaded._compile(compiled, sourcePath);
    return { exports: loaded.exports, testRoot };
  } finally {
    Module._load = originalLoad;
  }
}

async function main() {
  const quote = loadTsModule("quote/quote.ts");
  try {
    const countCache = new Map();
    quote.exports.setBoundedCache(countCache, "a", 1, 2);
    quote.exports.setBoundedCache(countCache, "b", 2, 2);
    quote.exports.setBoundedCache(countCache, "c", 3, 2);
    assert.deepEqual([...countCache.keys()], ["b", "c"]);

    const frameCache = new Map();
    for (const key of ["a", "b", "c", "d"]) {
      frameCache.set(key, { frames: [Buffer.alloc(1024)], fps: 10, duration: 1 });
    }
    quote.exports.trimAnimatedFrameCache(frameCache, 3, 2500);
    assert.deepEqual([...frameCache.keys()], ["c", "d"]);
  } finally {
    fs.rmSync(quote.testRoot, { recursive: true, force: true });
  }

  const yvlu = loadTsModule("yvlu/yvlu.ts");
  try {
    const firstPath = path.join(yvlu.testRoot, "first-media.bin");
    const first = await yvlu.exports.downloadMediaBuffer({
      downloadMedia: async () => {
        fs.writeFileSync(firstPath, "media-data");
        return firstPath;
      },
    }, {});
    assert.equal(first.toString(), "media-data");
    assert.equal(fs.existsSync(firstPath), false);

    const failedPath = path.join(yvlu.testRoot, "failed-media.bin");
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = function (filePath, ...args) {
      if (filePath === failedPath) throw new Error("simulated read failure");
      return originalReadFileSync.call(this, filePath, ...args);
    };
    try {
      const failed = await yvlu.exports.downloadMediaBuffer({
        downloadMedia: async () => {
          fs.writeFileSync(failedPath, "unreadable-media");
          return failedPath;
        },
      }, {});
      assert.equal(failed, undefined);
      assert.equal(fs.existsSync(failedPath), false);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
  } finally {
    fs.rmSync(yvlu.testRoot, { recursive: true, force: true });
  }

  console.log("resource regression tests: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
