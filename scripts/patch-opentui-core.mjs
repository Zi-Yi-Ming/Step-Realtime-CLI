import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const coreDir = path.join(repoRoot, "node_modules", "@opentui", "core");

const targets = [
  {
    file: "index-e89anq5x.js",
    replacements: [
      {
        pattern: /import\s+(\w+)\s+from\s+"(\.\/assets\/[^"]+\.scm)"\s+with\s+\{\s*type:\s*"file"\s*\};/g,
        replacement: (match, name, relPath) => {
          const resolved = path.resolve(coreDir, relPath);
          return `const ${name} = ${JSON.stringify(resolved)};`;
        },
      },
      {
        pattern: /import\s+(\w+)\s+from\s+"(\.\/assets\/[^"]+\.wasm)"\s+with\s+\{\s*type:\s*"file"\s*\};/g,
        replacement: (match, name, relPath) => {
          return `const ${name} = path.join(__dirname, "${path.basename(relPath)}");`;
        },
      },
    ],
  },
  {
    file: "index-k03avn41.js",
    replacements: [
      {
        pattern: /import\s+(\w+)\s+from\s+"(\.\/lib\/[^"]+\.wasm)"\s+with\s+\{\s*type:\s*"file"\s*\};/g,
        replacement: (match, name, relPath) => {
          return `const ${name} = path.join(__dirname, "${path.basename(relPath)}");`;
        },
      },
    ],
  },
];

let patched = false;

for (const target of targets) {
  const filePath = path.join(coreDir, target.file);
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    continue;
  }

  let original = content;
  for (const { pattern, replacement } of target.replacements) {
    content = content.replace(pattern, replacement);
  }

  if (content !== original) {
    await fs.writeFile(filePath, content, "utf8");
    patched = true;
  }
}

if (patched) {
  process.stdout.write("patched @opentui/core for Node.js file imports\n");
} else {
  process.stdout.write("@opentui/core already patched or no patch needed\n");
}
