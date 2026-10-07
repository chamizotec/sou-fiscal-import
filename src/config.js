import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const config = {
  uri: process.env.NEO4J_URI || "bolt://localhost:7687",
  user: process.env.NEO4J_USER || "neo4j",
  password: process.env.NEO4J_PASSWORD || "soufiscal-local",
  tseDir: process.env.TSE_DIR || path.resolve(raiz, "../../arquivos-tse"),
  receitaDir: process.env.RECEITA_DIR || path.resolve(raiz, "../../arquivos-receita"),
  raiz,
};

export function argumentos(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const chave = item.slice(2);
    const valor = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    flags[chave] = valor;
  }
  const uf = String(flags.uf || "AC").toUpperCase();
  const only = flags.only ? String(flags.only).split(",").map((s) => s.trim()).filter(Boolean) : null;
  return { uf, only };
}
