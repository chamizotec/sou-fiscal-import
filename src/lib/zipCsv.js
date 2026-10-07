import fs from "node:fs";
import readline from "node:readline";
import yauzl from "yauzl";
import { parse } from "csv-parse";

export function abrirZip(arquivo) {
  return new Promise((resolve, reject) => {
    yauzl.open(arquivo, { lazyEntries: true }, (erro, zip) => (erro ? reject(erro) : resolve(zip)));
  });
}

export function abrirEntrada(zip, entrada) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entrada, (erro, stream) => (erro ? reject(erro) : resolve(stream)));
  });
}

export async function* entradas(zip) {
  const fila = [];
  let espera = null;
  let terminou = false;
  let falha = null;

  zip.on("entry", (entrada) => {
    if (espera) {
      const atual = espera;
      espera = null;
      atual.resolve(entrada);
    } else {
      fila.push(entrada);
    }
  });
  zip.on("end", () => {
    terminou = true;
    if (espera) {
      const atual = espera;
      espera = null;
      atual.resolve(null);
    }
  });
  zip.on("error", (erro) => {
    falha = erro;
    if (espera) {
      const atual = espera;
      espera = null;
      atual.reject(erro);
    }
  });

  zip.readEntry();
  while (true) {
    if (falha) throw falha;
    let entrada;
    if (fila.length) entrada = fila.shift();
    else if (terminou) return;
    else {
      entrada = await new Promise((resolve, reject) => {
        espera = { resolve, reject };
      });
    }
    if (!entrada) return;
    yield entrada;
    zip.readEntry();
  }
}

export function ufDoArquivo(nome) {
  const base = nome.split("/").pop();
  if (/_BRASIL\./i.test(base)) return "BRASIL";
  const encontrado = base.match(/_([A-Z]{2})\.(csv|txt)$/i);
  return encontrado ? encontrado[1].toUpperCase() : null;
}

export function aceitaUf(nome, uf) {
  const sigla = ufDoArquivo(nome);
  if (sigla === "BRASIL") return false;
  if (!uf || uf === "ALL") return true;
  if (!sigla) return false;
  return sigla === uf;
}

export async function eachCsvFile(zipPath, filter, visit) {
  if (!fs.existsSync(zipPath)) {
    console.warn("arquivo ausente:", zipPath);
    return;
  }
  const zip = await abrirZip(zipPath);
  try {
    for await (const entrada of entradas(zip)) {
      if (entrada.fileName.endsWith("/") || !/\.csv$/i.test(entrada.fileName)) continue;
      if (filter && !filter(entrada.fileName)) continue;
      console.log("  lendo", entrada.fileName);
      const stream = await abrirEntrada(zip, entrada);
      stream.setEncoding("latin1");
      const parser = stream.pipe(parse({
        delimiter: ";",
        columns: true,
        bom: true,
        relax_quotes: true,
        relax_column_count: true,
        skip_empty_lines: true,
      }));
      await visit(entrada.fileName, parser);
    }
  } finally {
    zip.close();
  }
}

export async function eachZipLines(zipPath, nomeInclui, visit) {
  if (!fs.existsSync(zipPath)) {
    console.warn("arquivo ausente:", zipPath);
    return;
  }
  const zip = await abrirZip(zipPath);
  try {
    for await (const entrada of entradas(zip)) {
      if (!entrada.fileName.includes(nomeInclui)) continue;
      console.log("  lendo", entrada.fileName);
      const stream = await abrirEntrada(zip, entrada);
      stream.setEncoding("latin1");
      const linhas = readline.createInterface({ input: stream, crlfDelay: Infinity });
      await visit(entrada.fileName, linhas);
    }
  } finally {
    zip.close();
  }
}
