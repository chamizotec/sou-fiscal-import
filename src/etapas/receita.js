import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { busca, limpar, valor } from "../lib/texto.js";
import { registrosAninhados, registrosDiretos } from "../lib/zipAninhado.js";
import { executar, gravarLotes, ler } from "../lib/neo4j.js";

const PORTE = {
  "00": "Nao informado",
  "01": "Microempresa",
  "03": "Empresa de pequeno porte",
  "05": "Demais",
};

const SITUACAO = {
  "01": "Nula",
  "02": "Ativa",
  "03": "Suspensa",
  "04": "Inapta",
  "08": "Baixada",
};

const FAIXA_ETARIA = {
  0: "Nao se aplica",
  1: "0 a 12 anos",
  2: "13 a 20 anos",
  3: "21 a 30 anos",
  4: "31 a 40 anos",
  5: "41 a 50 anos",
  6: "51 a 60 anos",
  7: "61 a 70 anos",
  8: "71 a 80 anos",
  9: "Maiores de 80 anos",
};

function digitos(texto, tamanho) {
  const numeros = String(texto || "").replace(/\D/g, "");
  if (!numeros) return "";
  return tamanho ? numeros.padStart(tamanho, "0") : numeros;
}

function dataIso(bruto) {
  const numeros = digitos(bruto);
  if (numeros.length !== 8 || numeros === "00000000") return null;
  return `${numeros.slice(0, 4)}-${numeros.slice(4, 6)}-${numeros.slice(6, 8)}`;
}

function ativo(opcao, inicio, exclusao) {
  if (String(opcao || "").toUpperCase() !== "S") return false;
  if (!exclusao) return true;
  if (!inicio) return false;
  return exclusao < inicio;
}

function mesMaisRecente(diretorio) {
  const meses = fs.readdirSync(diretorio).filter((nome) => /^\d{4}-\d{2}\.zip$/.test(nome)).sort();
  if (!meses.length) throw new Error(`Nenhum zip mensal de CNPJ em ${diretorio}`);
  return path.join(diretorio, meses.at(-1));
}

function zipRegimes(diretorio) {
  const nome = fs.readdirSync(diretorio).find((item) => /^regimes/i.test(item) && item.endsWith(".zip"));
  return nome ? path.join(diretorio, nome) : null;
}

async function carregarAlvos() {
  const registros = await ler(`
    MATCH (o:Organizacao)
    WHERE o.cnpj IS NOT NULL
    RETURN o.cnpj AS cnpj
  `);
  const cnpjs = new Set();
  const basicos = new Set();
  for (const registro of registros) {
    const cnpj = digitos(registro.get("cnpj"), 14);
    if (cnpj.length !== 14) continue;
    cnpjs.add(cnpj);
    basicos.add(cnpj.slice(0, 8));
  }
  return { cnpjs, basicos };
}

async function mapaDominio(arquivoMes, filtro) {
  const mapa = new Map();
  for await (const colunas of registrosAninhados(arquivoMes, filtro)) {
    const codigo = limpar(colunas[0]);
    const descricao = limpar(colunas[1]);
    if (codigo && descricao) mapa.set(codigo, descricao);
  }
  return mapa;
}

async function gravarDominio(rotulo, cypher, mapa) {
  const linhas = [...mapa.entries()].map(([codigo, descricao]) => ({ codigo, descricao }));
  const total = await gravarLotes(cypher, linhas, 500);
  console.log(`  ${rotulo}: ${total}`);
}

async function varrer(nome, gerador, aceitar, cypher) {
  let lote = [];
  let lidas = 0;
  let gravadas = 0;
  for await (const colunas of gerador) {
    lidas += 1;
    if (lidas % 2_000_000 === 0) {
      console.log(`  ${nome}: ${lidas} linhas lidas, ${gravadas} gravadas`);
    }
    const item = aceitar(colunas);
    if (!item) continue;
    lote.push(item);
    if (lote.length >= 300) {
      gravadas += await gravarLotes(cypher, lote, 300);
      lote = [];
    }
  }
  if (lote.length) gravadas += await gravarLotes(cypher, lote, 300);
  console.log(`  ${nome}: ${lidas} linhas lidas, ${gravadas} gravadas`);
  return gravadas;
}

const CYPHER_EMPRESA = `
UNWIND $rows AS row
MERGE (e:Empresa {cnpjBasico: row.cnpjBasico})
SET e.razaoSocial = row.razaoSocial,
    e.naturezaCodigo = row.naturezaCodigo,
    e.natureza = row.natureza,
    e.qualificacaoResponsavel = row.qualificacaoResponsavel,
    e.capitalSocial = row.capitalSocial,
    e.porte = row.porte,
    e.enteFederativo = row.enteFederativo,
    e.fonte = 'receita-federal',
    e.referencia = row.referencia
`;

const CYPHER_ESTABELECIMENTO = `
UNWIND $rows AS row
MATCH (o:Organizacao {cnpj: row.cnpj})
MERGE (e:Empresa {cnpjBasico: row.cnpjBasico})
MERGE (o)-[:ESTABELECIMENTO_DE]->(e)
SET o.nomeFantasia = row.nomeFantasia,
    o.situacao = row.situacao,
    o.situacaoCodigo = row.situacaoCodigo,
    o.dataSituacao = row.dataSituacao,
    o.motivoSituacao = row.motivoSituacao,
    o.dataInicio = row.dataInicio,
    o.cnae = row.cnae,
    o.cnaeDescricao = row.cnaeDescricao,
    o.uf = row.uf,
    o.municipio = row.municipio,
    o.cep = row.cep,
    o.bairro = row.bairro,
    o.logradouro = row.logradouro,
    o.numero = row.numero,
    o.matriz = row.matriz,
    o.cnpjBasico = row.cnpjBasico,
    o.fonteReceita = 'receita-federal',
    o.referenciaReceita = row.referencia
`;

const CYPHER_SOCIO_PF = `
UNWIND $rows AS row
MATCH (e:Empresa {cnpjBasico: row.cnpjBasico})
MERGE (p:Pessoa {chave: row.chave})
ON CREATE SET p.nome = row.nome,
              p.documentoTipo = row.documentoTipo,
              p.fonte = 'receita-federal'
SET p.nome = coalesce(p.nome, row.nome),
    p.nomeBusca = coalesce(p.nomeBusca, row.nomeBusca)
MERGE (p)-[s:SOCIO_DE]->(e)
SET s.qualificacao = row.qualificacao,
    s.qualificacaoCodigo = row.qualificacaoCodigo,
    s.desde = row.desde,
    s.faixaEtaria = row.faixaEtaria,
    s.tipo = row.tipo,
    s.fonte = 'receita-federal',
    s.referencia = row.referencia
`;

const CYPHER_SOCIO_PJ = `
UNWIND $rows AS row
MATCH (e:Empresa {cnpjBasico: row.cnpjBasico})
MERGE (socia:Empresa {cnpjBasico: row.socioBasico})
ON CREATE SET socia.razaoSocial = row.nome, socia.fonte = 'receita-federal'
SET socia.razaoSocial = coalesce(socia.razaoSocial, row.nome)
MERGE (socia)-[s:SOCIO_DE]->(e)
SET s.qualificacao = row.qualificacao,
    s.qualificacaoCodigo = row.qualificacaoCodigo,
    s.desde = row.desde,
    s.tipo = 'PJ',
    s.fonte = 'receita-federal',
    s.referencia = row.referencia
`;

const CYPHER_SIMPLES = `
UNWIND $rows AS row
MATCH (e:Empresa {cnpjBasico: row.cnpjBasico})
SET e.simplesAtivo = row.simplesAtivo,
    e.simplesDesde = row.simplesDesde,
    e.simplesExclusao = row.simplesExclusao,
    e.meiAtivo = row.meiAtivo,
    e.meiDesde = row.meiDesde
`;

const CYPHER_REGIME = `
UNWIND $rows AS row
MATCH (o:Organizacao {cnpj: row.cnpj})
SET o.regime = row.regime, o.regimeAno = row.ano
WITH o, row
OPTIONAL MATCH (o)-[:ESTABELECIMENTO_DE]->(e:Empresa)
FOREACH (_ IN CASE WHEN e IS NULL THEN [] ELSE [1] END |
  SET e.regime = row.regime, e.regimeAno = row.ano)
`;

export async function importarReceita(diretorio) {
  if (!fs.existsSync(diretorio)) throw new Error(`Pasta da Receita ausente: ${diretorio}`);
  const arquivoMes = mesMaisRecente(diretorio);
  const referencia = path.basename(arquivoMes, ".zip");
  console.log(`Receita Federal: usando o snapshot ${referencia}. Meses anteriores ficam so como arquivo.`);

  const alvos = await carregarAlvos();
  if (!alvos.cnpjs.size) {
    console.log("  nenhum CNPJ de organizacao no grafo; a Receita nao tem o que cruzar");
    return;
  }
  console.log(`  ${alvos.cnpjs.size} CNPJs no grafo, ${alvos.basicos.size} empresas (raiz de 8 digitos)`);

  const cnaes = await mapaDominio(arquivoMes, (nome) => /Cnaes\.zip$/i.test(nome));
  const naturezas = await mapaDominio(arquivoMes, (nome) => /Naturezas\.zip$/i.test(nome));
  const qualificacoes = await mapaDominio(arquivoMes, (nome) => /Qualificacoes\.zip$/i.test(nome));
  const municipios = await mapaDominio(arquivoMes, (nome) => /Municipios\.zip$/i.test(nome));
  const motivos = await mapaDominio(arquivoMes, (nome) => /Motivos\.zip$/i.test(nome));

  await gravarDominio("CNAE", `
    UNWIND $rows AS row
    MERGE (n:Cnae {codigo: row.codigo})
    SET n.descricao = row.descricao, n.fonte = 'receita-federal'
  `, cnaes);
  await gravarDominio("natureza juridica", `
    UNWIND $rows AS row
    MERGE (n:NaturezaJuridica {codigo: row.codigo})
    SET n.descricao = row.descricao, n.fonte = 'receita-federal'
  `, naturezas);
  await gravarDominio("qualificacao", `
    UNWIND $rows AS row
    MERGE (n:Qualificacao {codigo: row.codigo})
    SET n.descricao = row.descricao, n.fonte = 'receita-federal'
  `, qualificacoes);
  await gravarDominio("municipio", `
    UNWIND $rows AS row
    MERGE (n:Municipio {codigo: row.codigo})
    SET n.nome = row.descricao, n.fonte = 'receita-federal'
  `, municipios);
  await gravarDominio("motivo de situacao", `
    UNWIND $rows AS row
    MERGE (n:MotivoSituacao {codigo: row.codigo})
    SET n.descricao = row.descricao, n.fonte = 'receita-federal'
  `, motivos);

  await varrer(
    "empresas",
    registrosAninhados(arquivoMes, (nome) => /Empresas\d\.zip$/i.test(nome)),
    (colunas) => {
      const cnpjBasico = digitos(colunas[0], 8);
      if (!alvos.basicos.has(cnpjBasico)) return null;
      const naturezaCodigo = digitos(colunas[2]);
      const qualificacaoCodigo = digitos(colunas[3]);
      return {
        cnpjBasico,
        razaoSocial: limpar(colunas[1]),
        naturezaCodigo,
        natureza: naturezas.get(naturezaCodigo) || naturezaCodigo || null,
        qualificacaoResponsavel: qualificacoes.get(qualificacaoCodigo) || null,
        capitalSocial: valor(colunas[4]),
        porte: PORTE[digitos(colunas[5])] || limpar(colunas[5]),
        enteFederativo: limpar(colunas[6]),
        referencia,
      };
    },
    CYPHER_EMPRESA,
  );

  await varrer(
    "estabelecimentos",
    registrosAninhados(arquivoMes, (nome) => /Estabelecimentos\d\.zip$/i.test(nome)),
    (colunas) => {
      const cnpjBasico = digitos(colunas[0], 8);
      const cnpj = `${cnpjBasico}${digitos(colunas[1], 4)}${digitos(colunas[2], 2)}`;
      if (!alvos.cnpjs.has(cnpj)) return null;
      const cnae = digitos(colunas[11]);
      const motivo = digitos(colunas[7]);
      const municipioCodigo = digitos(colunas[20]);
      return {
        cnpj,
        cnpjBasico,
        nomeFantasia: limpar(colunas[4]),
        situacaoCodigo: digitos(colunas[5]),
        situacao: SITUACAO[digitos(colunas[5])] || digitos(colunas[5]),
        dataSituacao: dataIso(colunas[6]),
        motivoSituacao: motivos.get(motivo) || null,
        dataInicio: dataIso(colunas[10]),
        cnae,
        cnaeDescricao: cnaes.get(cnae) || null,
        uf: limpar(colunas[19]),
        municipio: municipios.get(municipioCodigo) || municipioCodigo || null,
        cep: digitos(colunas[18]) || null,
        bairro: limpar(colunas[17]),
        logradouro: [limpar(colunas[13]), limpar(colunas[14])].filter(Boolean).join(" ") || null,
        numero: limpar(colunas[15]),
        matriz: digitos(colunas[3]) === "1",
        referencia,
      };
    },
    CYPHER_ESTABELECIMENTO,
  );

  const sociosPf = [];
  const sociosPj = [];
  const guardarSocio = async (forcar = false) => {
    if (forcar || sociosPf.length >= 300) {
      if (sociosPf.length) await gravarLotes(CYPHER_SOCIO_PF, sociosPf.splice(0, sociosPf.length), 300);
    }
    if (forcar || sociosPj.length >= 300) {
      if (sociosPj.length) await gravarLotes(CYPHER_SOCIO_PJ, sociosPj.splice(0, sociosPj.length), 300);
    }
  };

  let sociosLidos = 0;
  let sociosGravados = 0;
  for await (const colunas of registrosAninhados(arquivoMes, (nome) => /Socios\d\.zip$/i.test(nome))) {
    sociosLidos += 1;
    if (sociosLidos % 2_000_000 === 0) console.log(`  socios: ${sociosLidos} linhas lidas`);
    const cnpjBasico = digitos(colunas[0], 8);
    if (!alvos.basicos.has(cnpjBasico)) continue;
    const tipo = String(colunas[1] || "");
    const nome = limpar(colunas[2]);
    if (!nome) continue;
    const qualificacaoCodigo = digitos(colunas[4]);
    const comum = {
      cnpjBasico,
      nome,
      nomeBusca: busca(nome),
      qualificacaoCodigo,
      qualificacao: qualificacoes.get(qualificacaoCodigo) || null,
      desde: dataIso(colunas[5]),
      referencia,
    };
    if (tipo === "1") {
      const socioBasico = digitos(colunas[3], 8);
      if (!socioBasico || socioBasico === cnpjBasico) continue;
      sociosPj.push({ ...comum, socioBasico });
    } else {
      const nomeBusca = busca(nome);
      if (!nomeBusca) continue;
      sociosPf.push({
        ...comum,
        tipo: tipo === "3" ? "Estrangeiro" : "PF",
        documentoTipo: tipo === "3" ? "ESTRANGEIRO" : "CPF_MASCARADO",
        chave: `qsa:${cnpjBasico}:${nomeBusca}`,
        faixaEtaria: FAIXA_ETARIA[Number(digitos(colunas[10]))] || null,
      });
    }
    sociosGravados += 1;
    await guardarSocio(false);
  }
  await guardarSocio(true);
  console.log(`  socios: ${sociosLidos} linhas lidas, ${sociosGravados} gravados`);

  await varrer(
    "simples",
    registrosAninhados(arquivoMes, (nome) => /Simples\.zip$/i.test(nome)),
    (colunas) => {
      const cnpjBasico = digitos(colunas[0], 8);
      if (!alvos.basicos.has(cnpjBasico)) return null;
      const simplesDesde = dataIso(colunas[2]);
      const simplesExclusao = dataIso(colunas[3]);
      const meiDesde = dataIso(colunas[5]);
      const meiExclusao = dataIso(colunas[6]);
      return {
        cnpjBasico,
        simplesAtivo: ativo(colunas[1], simplesDesde, simplesExclusao),
        simplesDesde,
        simplesExclusao,
        meiAtivo: ativo(colunas[4], meiDesde, meiExclusao),
        meiDesde,
      };
    },
    CYPHER_SIMPLES,
  );

  const regimes = zipRegimes(diretorio);
  if (regimes) {
    await importarRegimes(regimes, alvos.cnpjs);
    await importarHorarioEleitoral(regimes, alvos.cnpjs);
  }

  await executar(`
    MERGE (g:Carga {id: $id})
    SET g.importadoEm = datetime(), g.fonte = 'arquivos-receita', g.referencia = $referencia,
        g.cnpjs = $cnpjs
  `, { id: `receita-${referencia}`, referencia, cnpjs: alvos.cnpjs.size });
  console.log(`Receita Federal ${referencia} aplicada aos CNPJs do grafo.`);
}

async function importarRegimes(arquivo, cnpjs) {
  const escolhido = new Map();
  const entradas = [
    "entidades-lucro-real.zip",
    "entidades-lucro-presumido.zip",
    "entidades-lucro-arbitrado.zip",
    "entidades-imunes-e-isentas.zip",
  ];
  for (const entrada of entradas) {
    const destino = path.join(os.tmpdir(), `sou-fiscal-${entrada}`);
    await materializar(arquivo, entrada, destino);
    try {
      for await (const linha of registrosDiretos(destino, (nome) => /\.csv$/i.test(nome), {
        delimiter: ",",
        encoding: "utf8",
        columns: true,
      })) {
        const cnpj = digitos(linha.cnpj, 14);
        if (!cnpjs.has(cnpj)) continue;
        const ano = Number(linha.ano) || 0;
        const anterior = escolhido.get(cnpj);
        if (!anterior || ano >= anterior.ano) {
          escolhido.set(cnpj, { cnpj, ano, regime: limpar(linha.forma_de_tributacao) });
        }
      }
    } finally {
      fs.rmSync(destino, { force: true });
    }
  }
  const total = await gravarLotes(CYPHER_REGIME, [...escolhido.values()], 300);
  console.log(`  regimes tributarios: ${total}`);
}

async function importarHorarioEleitoral(arquivo, cnpjs) {
  const linhas = [];
  for await (const linha of registrosDiretos(arquivo, (nome) => /renuncia-irpj-csll-ecf\.csv$/i.test(nome), {
    delimiter: "|",
    encoding: "utf8",
    columns: true,
  })) {
    const cnpj = digitos(linha.cnpj, 14);
    if (!cnpjs.has(cnpj)) continue;
    const deducao = valor(linha.horario_eleitoral_deducao_lalur);
    if (!deducao) continue;
    linhas.push({ cnpj, deducao, ano: limpar(linha.dt_fin)?.slice(-4) || null });
  }
  const total = await gravarLotes(`
    UNWIND $rows AS row
    MATCH (o:Organizacao {cnpj: row.cnpj})
    SET o.deducaoHorarioEleitoral = row.deducao, o.deducaoHorarioEleitoralAno = row.ano
  `, linhas, 300);
  console.log(`  deducao de horario eleitoral: ${total}`);
}

function materializar(arquivo, nome, destino) {
  const proc = spawn("unzip", ["-p", arquivo, nome], { stdio: ["ignore", "pipe", "pipe"] });
  const gravacao = pipeline(proc.stdout, fs.createWriteStream(destino));
  const encerrado = new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (codigo) => (codigo === 0 ? resolve() : reject(new Error(`unzip ${nome} saiu com ${codigo}`))));
  });
  return Promise.all([gravacao, encerrado]);
}
