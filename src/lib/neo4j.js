import neo4j from "neo4j-driver";
import { config } from "../config.js";

let driver;

export function obterDriver() {
  if (!driver) {
    driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password), {
      disableLosslessIntegers: true,
    });
  }
  return driver;
}

export async function fecharDriver() {
  if (driver) await driver.close();
  driver = null;
}

export async function executar(cypher, params = {}) {
  const session = obterDriver().session();
  try {
    return await session.executeWrite((tx) => tx.run(cypher, params));
  } finally {
    await session.close();
  }
}

export async function ler(cypher, params = {}) {
  const session = obterDriver().session();
  try {
    const resultado = await session.executeRead((tx) => tx.run(cypher, params));
    return resultado.records;
  } finally {
    await session.close();
  }
}

export async function gravarLotes(cypher, linhas, tamanho = 500) {
  if (!linhas.length) return 0;
  const session = obterDriver().session();
  try {
    for (let i = 0; i < linhas.length; i += tamanho) {
      const rows = linhas.slice(i, i + tamanho);
      await session.executeWrite((tx) => tx.run(cypher, { rows }));
    }
  } finally {
    await session.close();
  }
  return linhas.length;
}

export async function aplicarSchema(comandos) {
  for (const comando of comandos) {
    await executar(comando);
  }
}

export function propriedades(valor) {
  if (!valor || typeof valor !== "object") return null;
  const origem = valor.properties || valor;
  const saida = {};
  for (const [chave, item] of Object.entries(origem)) {
    if (["documentoHash", "chave", "pessoaChave", "fornecedorChave"].includes(chave)) continue;
    saida[chave] = item;
  }
  return saida;
}
