// Builds src/ into the one-file plugin Buzz loads: plugin/plugin.js.
//   node build.mjs          production build into plugin/
//   node build.mjs --dev    unminified build into .dev/plugin.js
// React comes from Buzz as `ctx.react`: JSX compiles to React.createElement
// against src/react.ts, and nothing is imported at runtime.
import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const dev = process.argv.includes("--dev");

// The oMLX helper runs as `node -e <src/omlx-helper.cjs>`, declared in the
// manifest so Buzz shows exactly what it runs: keep the two the same.
const manifestPath = new URL("plugin/manifest.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const helper = readFileSync(new URL("src/omlx-helper.cjs", import.meta.url), "utf8");
manifest.host.processes = [
  ...manifest.host.processes.filter((p) => p.id !== "omlx"),
  { id: "omlx", program: "node", args: ["-e", helper] },
];
const json = `${JSON.stringify(manifest, null, 2)}\n`;
if (json !== readFileSync(manifestPath, "utf8")) writeFileSync(manifestPath, json);
const result = await build({
  entryPoints: ["src/index.tsx"],
  outfile: dev ? ".dev/plugin.js" : "plugin/plugin.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  splitting: false,
  minify: !dev,
  legalComments: "none",
  jsx: "transform",
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  metafile: true,
  plugins: [
    {
      name: "no-runtime-imports",
      setup(b) {
        b.onResolve({ filter: /^(react|react-dom|@buzz\/author|@deepseek-ai\/cordis)(\/|$)/ }, (args) =>
          args.kind === "import-statement" && !args.path.startsWith("@buzz/author")
            ? { errors: [{ text: `${args.path} is supplied by Buzz; import its types only` }] }
            : { path: args.path, external: true },
        );
      },
    },
  ],
});
const [file, out] = Object.entries(result.metafile.outputs)[0];
if (out.imports.length) throw new Error(`plugin.js imports at runtime: ${out.imports.map((i) => i.path).join(", ")}`);
if (!out.exports.includes("apply")) throw new Error("plugin.js must export apply");
console.log(file, out.bytes, "bytes");
