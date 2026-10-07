import { spawn } from "node:child_process";
import { createInflateRaw } from "node:zlib";
import { parse } from "csv-parse";

const ASSINATURA_LOCAL = 0x04034b50;
const ASSINATURA_CENTRAL = 0x02014b50;
const ASSINATURA_FIM = 0x06054b50;

function criarLeitor(stream) {
  const pedacos = [];
  let tamanho = 0;
  let acabou = false;
  let falha = null;
  let espera = null;

  const entregar = () => {
    if (!espera) return;
    if (falha) {
      const atual = espera;
      espera = null;
      atual.reject(falha);
      return;
    }
    if (tamanho >= espera.n || (acabou && tamanho > 0 && tamanho < espera.n) || (acabou && espera.n > 0 && tamanho === 0)) {
      const atual = espera;
      espera = null;
      const n = Math.min(atual.n, tamanho);
      atual.resolve(consumir(n));
    }
  };

  const consumir = (n) => {
    if (n === 0) return Buffer.alloc(0);
    const saida = Buffer.alloc(n);
    let offset = 0;
    while (offset < n) {
      const pedaco = pedacos[0];
      const falta = n - offset;
      if (pedaco.length <= falta) {
        pedaco.copy(saida, offset);
        offset += pedaco.length;
        tamanho -= pedaco.length;
        pedacos.shift();
      } else {
        pedaco.copy(saida, offset, 0, falta);
        pedacos[0] = pedaco.subarray(falta);
        tamanho -= falta;
        offset += falta;
      }
    }
    return saida;
  };

  stream.on("data", (chunk) => {
    pedacos.push(chunk);
    tamanho += chunk.length;
    stream.pause();
    if (espera && tamanho < espera.n) stream.resume();
    else entregar();
  });
  stream.on("end", () => {
    acabou = true;
    entregar();
  });
  stream.on("error", (erro) => {
    falha = erro;
    entregar();
  });

  return async (n) => {
    if (tamanho >= n) return consumir(n);
    if (acabou || falha) {
      if (falha) throw falha;
      return consumir(tamanho);
    }
    return new Promise((resolve, reject) => {
      espera = { n, resolve, reject };
      stream.resume();
    });
  };
}

async function* registrosDoArquivo(ler, tamanhoComprimido, metodo, opcoes) {
  const inflater = metodo === 8 ? createInflateRaw() : null;
  const parser = parse({
    delimiter: opcoes.delimiter || ";",
    encoding: opcoes.encoding || "latin1",
    columns: Boolean(opcoes.columns),
    bom: true,
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
  });

  const fila = [];
  let espera = null;
  let terminou = false;
  let falha = null;

  const acordar = (registro) => {
    if (espera) {
      const atual = espera;
      espera = null;
      atual(registro);
      return;
    }
    if (registro) fila.push(registro);
  };

  parser.on("readable", () => {
    let registro = parser.read();
    while (registro) {
      acordar(registro);
      registro = parser.read();
    }
  });
  parser.on("end", () => {
    terminou = true;
    acordar(null);
  });
  parser.on("error", (erro) => {
    falha = erro;
    terminou = true;
    acordar(null);
  });

  if (inflater) {
    inflater.on("data", (chunk) => {
      parser.write(chunk);
    });
    inflater.on("end", () => parser.end());
    inflater.on("error", (erro) => {
      falha = erro;
      parser.destroy();
    });
  }

  const escrever = (bloco) => {
    if (inflater) inflater.write(bloco);
    else parser.write(bloco);
  };

  let faltam = tamanhoComprimido;
  while (faltam > 0) {
    const bloco = await ler(Math.min(faltam, 256 * 1024));
    if (!bloco.length) break;
    faltam -= bloco.length;
    escrever(bloco);
    while (fila.length) yield fila.shift();
  }
  if (inflater) inflater.end();
  else parser.end();

  while (!terminou || fila.length) {
    if (falha) throw falha;
    if (fila.length) {
      yield fila.shift();
      continue;
    }
    const registro = await new Promise((resolve) => {
      espera = resolve;
    });
    if (!registro) break;
    yield registro;
  }
  if (falha) throw falha;
}

function tamanhoZip64(extra, csize32, usize32) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const tam = extra.readUInt16LE(offset + 2);
    if (id === 1 && csize32 === 0xffffffff) {
      let cursor = 0;
      if (usize32 === 0xffffffff) cursor += 8;
      return Number(extra.readBigUInt64LE(offset + 4 + cursor));
    }
    offset += 4 + tam;
  }
  return csize32;
}

async function* csvsInternos(stream, opcoes) {
  const ler = criarLeitor(stream);
  while (true) {
    const assinatura = await ler(4);
    if (assinatura.length < 4) return;
    const marca = assinatura.readUInt32LE(0);
    if (marca === ASSINATURA_CENTRAL || marca === ASSINATURA_FIM) return;
    if (marca !== ASSINATURA_LOCAL) return;
    const cabecalho = await ler(26);
    if (cabecalho.length < 26) return;
    const metodo = cabecalho.readUInt16LE(4);
    const bandeira = cabecalho.readUInt16LE(2);
    let tamanho = cabecalho.readUInt32LE(14);
    const tamanhoOriginal = cabecalho.readUInt32LE(18);
    const nome = cabecalho.readUInt16LE(22);
    const extra = cabecalho.readUInt16LE(24);
    await ler(nome);
    const extraBuf = await ler(extra);
    if (tamanho === 0xffffffff) tamanho = tamanhoZip64(extraBuf, tamanho, tamanhoOriginal);
    if (bandeira & 0x08 || !tamanho || tamanho === 0xffffffff) {
      throw new Error("ZIP interno sem o tamanho do arquivo no cabecalho local");
    }
    if (metodo !== 0 && metodo !== 8) {
      throw new Error(`metodo de compressao ${metodo} nao suportado`);
    }
    yield* registrosDoArquivo(ler, tamanho, metodo, opcoes);
  }
}

function listarEntradas(arquivo) {
  return new Promise((resolve, reject) => {
    const proc = spawn("unzip", ["-Z1", arquivo]);
    const saida = [];
    const erros = [];
    proc.stdout.on("data", (chunk) => saida.push(chunk));
    proc.stderr.on("data", (chunk) => erros.push(chunk));
    proc.on("error", reject);
    proc.on("close", (codigo) => {
      if (codigo !== 0) {
        reject(new Error(Buffer.concat(erros).toString() || `unzip -Z1 saiu com ${codigo}`));
        return;
      }
      resolve(Buffer.concat(saida).toString("utf8").split(/\r?\n/).filter(Boolean));
    });
  });
}

export async function* registrosDiretos(arquivo, filtroNome, opcoes = {}) {
  const nomes = await listarEntradas(arquivo);
  for (const nome of nomes) {
    if (nome.endsWith("/")) continue;
    if (filtroNome && !filtroNome(nome)) continue;
    yield* linhasDoUnzip(arquivo, nome, opcoes);
  }
}

function linhasDoUnzip(arquivo, nome, opcoes) {
  const proc = spawn("unzip", ["-p", arquivo, nome], { stdio: ["ignore", "pipe", "pipe"] });
  const parser = proc.stdout.pipe(parse({
    delimiter: opcoes.delimiter || ";",
    encoding: opcoes.encoding || "latin1",
    columns: Boolean(opcoes.columns),
    bom: true,
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
  }));
  proc.stderr.on("data", () => {});
  proc.on("error", (erro) => parser.destroy(erro));
  return parser;
}

export async function* registrosAninhados(arquivo, filtroNome, opcoes = {}) {
  const nomes = await listarEntradas(arquivo);
  for (const nome of nomes) {
    if (nome.endsWith("/")) continue;
    if (filtroNome && !filtroNome(nome)) continue;
    const proc = spawn("unzip", ["-p", arquivo, nome], { stdio: ["ignore", "pipe", "pipe"] });
    const erros = [];
    let codigo = null;
    const encerrado = new Promise((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (saida) => {
        codigo = saida;
        resolve();
      });
    });
    proc.stderr.on("data", (chunk) => erros.push(chunk));
    let leu = false;
    try {
      for await (const registro of csvsInternos(proc.stdout, opcoes)) {
        leu = true;
        yield registro;
      }
    } finally {
      proc.stdout.destroy();
      if (codigo == null) proc.kill();
    }
    await encerrado;
    if (!leu && codigo !== 0 && codigo !== 141) {
      throw new Error(Buffer.concat(erros).toString() || `falha ao ler ${nome}`);
    }
  }
}
