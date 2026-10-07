import path from "node:path";
import { busca, dataIso, grupoDespesa, limpar, valor } from "../lib/texto.js";
import { classificarDocumento, idHash } from "../lib/documento.js";
import { aceitaUf, eachCsvFile } from "../lib/zipCsv.js";
import { acumular } from "./lotes.js";

const DESPESA_CANDIDATO = `
UNWIND $rows AS row
MERGE (d:Despesa {id: row.id})
SET d.sqTse = row.sqTse, d.valor = row.valor, d.data = row.data, d.origem = row.origem, d.grupo = row.grupo,
    d.descricao = row.descricao, d.tipoDocumento = row.tipoDocumento, d.nrDocumento = row.nrDocumento,
    d.tipoPrestacao = row.tipoPrestacao, d.fornecedorChave = row.agenteChave, d.prestador = 'candidato',
    d.fonte = 'tse:despesas_contratadas_candidatos'
WITH d, row
MATCH (c:Candidatura {sq: row.sq})
MERGE (c)-[:CONTRATOU]->(d)
FOREACH (_ IN CASE WHEN row.cnpjConta IS NULL THEN [] ELSE [1] END |
  MERGE (conta:ContaCampanha {cnpj: row.cnpjConta})
  MERGE (orgConta:Organizacao {cnpj: row.cnpjConta})
    ON CREATE SET orgConta.tipoPrestador = 'candidato', orgConta.fonte = 'tse:prestacao'
  MERGE (c)-[:USA_CONTA]->(conta)
  MERGE (conta)-[:PERTENCE_A]->(orgConta)
)
FOREACH (_ IN CASE WHEN row.agenteTipo = 'PJ' THEN [1] ELSE [] END |
  MERGE (o:Organizacao {cnpj: row.cnpj})
    ON CREATE SET o.nome = row.agenteNome, o.nomeRfb = row.nomeRfb, o.cnae = row.cnae, o.fonte = 'tse:fornecedor'
  SET o.nome = coalesce(o.nome, row.agenteNome), o.cnae = coalesce(o.cnae, row.cnae)
  MERGE (d)-[r:FORNECIDO_POR]->(o)
  SET r.nome = row.agenteNome, r.tipo = 'PJ'
)
FOREACH (_ IN CASE WHEN row.agenteTipo = 'PF' THEN [1] ELSE [] END |
  MERGE (p:Pessoa {chave: row.pessoaChave})
    ON CREATE SET p.documentoHash = row.documentoHash, p.documentoTipo = 'CPF', p.nome = row.agenteNome, p.fonte = 'tse:fornecedor'
  MERGE (d)-[r:FORNECIDO_POR]->(p)
  SET r.nome = row.agenteNome, r.tipo = 'PF'
)
FOREACH (_ IN CASE WHEN row.agenteTipo = 'NI' AND row.agenteNome IS NOT NULL THEN [1] ELSE [] END |
  MERGE (a:AgenteNaoIdentificado {id: row.id})
  SET a.nome = row.agenteNome
  MERGE (d)-[r:FORNECIDO_POR]->(a)
  SET r.nome = row.agenteNome, r.tipo = 'NI'
)
`;

const DESPESA_ORGAO = `
UNWIND $rows AS row
MERGE (d:Despesa {id: row.id})
SET d.sqTse = row.sqTse, d.valor = row.valor, d.data = row.data, d.origem = row.origem, d.grupo = row.grupo,
    d.descricao = row.descricao, d.tipoDocumento = row.tipoDocumento, d.nrDocumento = row.nrDocumento,
    d.tipoPrestacao = row.tipoPrestacao, d.fornecedorChave = row.agenteChave, d.prestador = 'orgao',
    d.fonte = 'tse:despesas_contratadas_orgaos'
WITH d, row
MERGE (u:Uf {sigla: row.uf})
MERGE (p:Partido {numero: row.nrPartido})
  ON CREATE SET p.sigla = row.sgPartido, p.nome = row.nmPartido
MERGE (o:OrgaoPartidario {id: row.orgaoId})
SET o.esfera = row.esfera, o.municipio = row.municipio, o.uf = row.uf
MERGE (o)-[:DO_PARTIDO]->(p)
MERGE (o)-[:EM_UF]->(u)
MERGE (o)-[:CONTRATOU]->(d)
FOREACH (_ IN CASE WHEN row.agenteTipo = 'PJ' THEN [1] ELSE [] END |
  MERGE (org:Organizacao {cnpj: row.cnpj})
    ON CREATE SET org.nome = row.agenteNome, org.cnae = row.cnae, org.fonte = 'tse:fornecedor'
  MERGE (d)-[r:FORNECIDO_POR]->(org)
  SET r.nome = row.agenteNome, r.tipo = 'PJ'
)
FOREACH (_ IN CASE WHEN row.agenteTipo = 'PF' THEN [1] ELSE [] END |
  MERGE (pessoa:Pessoa {chave: row.pessoaChave})
    ON CREATE SET pessoa.documentoHash = row.documentoHash, pessoa.documentoTipo = 'CPF', pessoa.nome = row.agenteNome, pessoa.fonte = 'tse:fornecedor'
  MERGE (d)-[r:FORNECIDO_POR]->(pessoa)
  SET r.nome = row.agenteNome, r.tipo = 'PF'
)
`;

const PAGAMENTO = `
UNWIND $rows AS row
MATCH (c:Candidatura)-[:CONTRATOU]->(d:Despesa {sqTse: row.sqDespesa})
WITH row, head(collect(DISTINCT c)) AS c
WHERE c IS NOT NULL
MERGE (pg:Pagamento {id: row.id})
SET pg.valor = row.valor, pg.data = row.data, pg.fonteRecurso = row.fonteRecurso, pg.especie = row.especie,
    pg.origem = row.origem, pg.descricao = row.descricao, pg.sqDespesa = row.sqDespesa,
    pg.tipoPrestacao = row.tipoPrestacao, pg.fonte = 'tse:despesas_pagas'
MERGE (c)-[:PAGOU]->(pg)
`;

const RECEITA = `
UNWIND $rows AS row
MERGE (r:Receita {id: row.id})
SET r.sqTse = row.sqTse, r.valor = row.valor, r.data = row.data, r.origem = row.origem, r.fonteRecurso = row.fonteRecurso,
    r.natureza = row.natureza, r.especie = row.especie, r.descricao = row.descricao, r.tipoPrestacao = row.tipoPrestacao,
    r.doadorChave = row.agenteChave, r.fonte = 'tse:receitas_candidatos'
WITH r, row
MATCH (c:Candidatura {sq: row.sq})
MERGE (c)-[:RECEBEU]->(r)
FOREACH (_ IN CASE WHEN row.agenteTipo = 'PJ' THEN [1] ELSE [] END |
  MERGE (o:Organizacao {cnpj: row.cnpj})
    ON CREATE SET o.nome = row.agenteNome, o.cnae = row.cnae, o.fonte = 'tse:doador'
  MERGE (r)-[rel:DOADA_POR]->(o)
  SET rel.nome = row.agenteNome, rel.tipo = 'PJ'
)
FOREACH (_ IN CASE WHEN row.agenteTipo = 'PF' THEN [1] ELSE [] END |
  MERGE (p:Pessoa {chave: row.pessoaChave})
    ON CREATE SET p.documentoHash = row.documentoHash, p.documentoTipo = 'CPF', p.nome = row.agenteNome, p.fonte = 'tse:doador'
  MERGE (r)-[rel:DOADA_POR]->(p)
  SET rel.nome = row.agenteNome, rel.tipo = 'PF'
)
`;

const ORIGINARIO = `
UNWIND $rows AS row
MATCH (r:Receita {sqTse: row.sqReceita})
FOREACH (_ IN CASE WHEN row.agenteTipo = 'PJ' THEN [1] ELSE [] END |
  MERGE (o:Organizacao {cnpj: row.cnpj})
    ON CREATE SET o.nome = row.agenteNome, o.fonte = 'tse:doador_originario'
  MERGE (r)-[rel:ORIGEM_EM]->(o)
  SET rel.nome = row.agenteNome, rel.tipo = 'PJ'
)
FOREACH (_ IN CASE WHEN row.agenteTipo = 'PF' THEN [1] ELSE [] END |
  MERGE (p:Pessoa {chave: row.pessoaChave})
    ON CREATE SET p.documentoHash = row.documentoHash, p.documentoTipo = 'CPF', p.nome = row.agenteNome, p.fonte = 'tse:doador_originario'
  MERGE (r)-[rel:ORIGEM_EM]->(p)
  SET rel.nome = row.agenteNome, rel.tipo = 'PF'
)
`;

const COMPROVANTE_DESPESA = `
UNWIND $rows AS row
MATCH (d:Despesa {sqTse: row.sq})
MERGE (comp:Comprovante {url: row.url})
MERGE (d)-[:TEM_COMPROVANTE]->(comp)
`;

const COMPROVANTE_RECEITA = `
UNWIND $rows AS row
MATCH (r:Receita {sqTse: row.sq})
MERGE (comp:Comprovante {url: row.url})
MERGE (r)-[:TEM_COMPROVANTE]->(comp)
`;

function agenteDe(documentoBruto, nome, cnae) {
  const documento = classificarDocumento(documentoBruto);
  const nomeLimpo = limpar(nome);
  if (documento?.tipo === "CNPJ") {
    return {
      agenteTipo: "PJ",
      agenteChave: documento.chave,
      cnpj: documento.digitos,
      pessoaChave: null,
      documentoHash: null,
      agenteNome: nomeLimpo,
      cnae: limpar(cnae),
    };
  }
  if (documento?.tipo === "CPF") {
    return {
      agenteTipo: "PF",
      agenteChave: documento.chave,
      cnpj: null,
      pessoaChave: documento.chave,
      documentoHash: documento.hash,
      agenteNome: nomeLimpo,
      cnae: null,
    };
  }
  return {
    agenteTipo: nomeLimpo ? "NI" : null,
    agenteChave: nomeLimpo ? `nome:${busca(nomeLimpo)}` : null,
    cnpj: null,
    pessoaChave: null,
    documentoHash: null,
    agenteNome: nomeLimpo,
    cnae: null,
  };
}

function mapearDespesaCandidato(linha) {
  const sq = limpar(linha.SQ_CANDIDATO);
  if (!sq) return null;
  const agente = agenteDe(linha.NR_CPF_CNPJ_FORNECEDOR, linha.NM_FORNECEDOR, linha.DS_CNAE_FORNECEDOR);
  const origem = limpar(linha.DS_ORIGEM_DESPESA);
  const descricao = limpar(linha.DS_DESPESA);
  const valorLinha = valor(linha.VR_DESPESA_CONTRATADA);
  const data = dataIso(linha.DT_DESPESA);
  const sqTse = limpar(linha.SQ_DESPESA);
  const conta = classificarDocumento(linha.NR_CNPJ_PRESTADOR_CONTA);
  return {
    sq,
    id: idHash([sq, sqTse, data, valorLinha, descricao, origem, agente.agenteChave, limpar(linha.NR_DOCUMENTO)].join("|")),
    sqTse,
    valor: valorLinha,
    data,
    origem,
    grupo: grupoDespesa(origem),
    descricao,
    tipoDocumento: limpar(linha.DS_TIPO_DOCUMENTO),
    nrDocumento: limpar(linha.NR_DOCUMENTO),
    tipoPrestacao: limpar(linha.TP_PRESTACAO_CONTAS),
    nome: limpar(linha.NM_CANDIDATO),
    nomeRfb: limpar(linha.NM_FORNECEDOR_RFB),
    cnpjConta: conta?.tipo === "CNPJ" ? conta.digitos : null,
    ...agente,
  };
}

function mapearDespesaOrgao(linha) {
  const uf = limpar(linha.SG_UF);
  const nrPartido = limpar(linha.NR_PARTIDO);
  if (!uf || !nrPartido) return null;
  const agente = agenteDe(linha.NR_CPF_CNPJ_FORNECEDOR, linha.NM_FORNECEDOR, linha.DS_CNAE_FORNECEDOR);
  const origem = limpar(linha.DS_ORIGEM_DESPESA);
  const descricao = limpar(linha.DS_DESPESA);
  const valorLinha = valor(linha.VR_DESPESA_CONTRATADA);
  const esfera = limpar(linha.DS_ESFERA_PARTIDARIA);
  const municipio = limpar(linha.NM_MUNICIPIO);
  return {
    id: idHash(["orgao", uf, nrPartido, limpar(linha.SQ_DESPESA), dataIso(linha.DT_DESPESA), valorLinha, descricao, agente.agenteChave].join("|")),
    sqTse: limpar(linha.SQ_DESPESA),
    valor: valorLinha,
    data: dataIso(linha.DT_DESPESA),
    origem,
    grupo: grupoDespesa(origem),
    descricao,
    tipoDocumento: limpar(linha.DS_TIPO_DOCUMENTO),
    nrDocumento: limpar(linha.NR_DOCUMENTO),
    tipoPrestacao: limpar(linha.TP_PRESTACAO_CONTAS),
    uf,
    nrPartido,
    sgPartido: limpar(linha.SG_PARTIDO),
    nmPartido: limpar(linha.NM_PARTIDO),
    esfera,
    municipio,
    orgaoId: [uf, esfera || "", nrPartido, municipio || ""].join("|"),
    ...agente,
  };
}

function mapearReceita(linha) {
  const sq = limpar(linha.SQ_CANDIDATO);
  if (!sq) return null;
  const agente = agenteDe(linha.NR_CPF_CNPJ_DOADOR, linha.NM_DOADOR, linha.DS_CNAE_DOADOR);
  const origem = limpar(linha.DS_ORIGEM_RECEITA);
  const valorLinha = valor(linha.VR_RECEITA);
  const data = dataIso(linha.DT_RECEITA);
  return {
    sq,
    id: idHash([sq, limpar(linha.SQ_RECEITA), data, valorLinha, origem, agente.agenteChave, limpar(linha.NR_DOCUMENTO_DOACAO)].join("|")),
    sqTse: limpar(linha.SQ_RECEITA),
    valor: valorLinha,
    data,
    origem,
    fonteRecurso: limpar(linha.DS_FONTE_RECEITA),
    natureza: limpar(linha.DS_NATUREZA_RECEITA),
    especie: limpar(linha.DS_ESPECIE_RECEITA),
    descricao: limpar(linha.DS_RECEITA),
    tipoPrestacao: limpar(linha.TP_PRESTACAO_CONTAS),
    ...agente,
  };
}

function fontePublica(fonte) {
  const texto = busca(fonte) || "";
  if (texto.includes("ESPECIAL") || texto.includes("FEFC")) return "eleitoral";
  if (texto.includes("PARTID")) return "partidario";
  return null;
}

function mapearReceitaPublicaOrgao(linha) {
  if (!fontePublica(linha.DS_FONTE_RECEITA)) return null;
  const uf = limpar(linha.SG_UF);
  const nrPartido = limpar(linha.NR_PARTIDO);
  if (!uf || !nrPartido) return null;
  const valorLinha = valor(linha.VR_RECEITA);
  const data = dataIso(linha.DT_RECEITA);
  const origem = limpar(linha.DS_ORIGEM_RECEITA);
  const esfera = limpar(linha.DS_ESFERA_PARTIDARIA);
  const municipio = limpar(linha.NM_MUNICIPIO);
  return {
    id: idHash(["orgao-receita", uf, nrPartido, limpar(linha.SQ_RECEITA), data, valorLinha, origem].join("|")),
    sqTse: limpar(linha.SQ_RECEITA),
    valor: valorLinha,
    data,
    origem,
    fonteRecurso: limpar(linha.DS_FONTE_RECEITA),
    natureza: limpar(linha.DS_NATUREZA_RECEITA),
    especie: limpar(linha.DS_ESPECIE_RECEITA),
    descricao: limpar(linha.DS_RECEITA),
    tipoPrestacao: limpar(linha.TP_PRESTACAO_CONTAS),
    uf,
    nrPartido,
    sgPartido: limpar(linha.SG_PARTIDO),
    nmPartido: limpar(linha.NM_PARTIDO),
    esfera,
    municipio,
    orgaoId: [uf, esfera || "", nrPartido, municipio || ""].join("|"),
  };
}

const RECEITA_ORGAO = `
UNWIND $rows AS row
MERGE (r:Receita {id: row.id})
SET r.sqTse = row.sqTse, r.valor = row.valor, r.data = row.data, r.origem = row.origem,
    r.fonteRecurso = row.fonteRecurso, r.natureza = row.natureza, r.especie = row.especie,
    r.descricao = row.descricao, r.tipoPrestacao = row.tipoPrestacao, r.prestador = 'orgao',
    r.fonte = 'tse:receitas_orgaos'
WITH r, row
MERGE (u:Uf {sigla: row.uf})
MERGE (p:Partido {numero: row.nrPartido})
  ON CREATE SET p.sigla = row.sgPartido, p.nome = row.nmPartido
MERGE (o:OrgaoPartidario {id: row.orgaoId})
SET o.esfera = row.esfera, o.municipio = row.municipio, o.uf = row.uf
MERGE (o)-[:DO_PARTIDO]->(p)
MERGE (o)-[:EM_UF]->(u)
MERGE (o)-[:RECEBEU]->(r)
`;

export async function importarReceitasPublicasOrgaos(tseDir, uf) {
  const orgaos = path.join(tseDir, "prestacao_de_contas_eleitorais_orgaos_partidarios_2026.zip");
  await eachCsvFile(orgaos, (nome) => aceitaUf(nome, uf) && /receitas_orgaos_partidarios_2026_/.test(nome), (nome, parser) =>
    acumular(nome, parser, mapearReceitaPublicaOrgao, RECEITA_ORGAO, 300));
}

export async function importarFinanceiro(tseDir, uf) {
  const filtro = (nome) => aceitaUf(nome, uf);
  const candidatos = path.join(tseDir, "prestacao_de_contas_eleitorais_candidatos_2026.zip");
  const orgaos = path.join(tseDir, "prestacao_de_contas_eleitorais_orgaos_partidarios_2026.zip");
  const docDespesa = path.join(tseDir, "despesa_documento_2026.zip");
  const docReceita = path.join(tseDir, "receita_documento_2026.zip");

  await eachCsvFile(candidatos, (nome) => filtro(nome) && nome.includes("despesas_contratadas_candidatos"), (nome, parser) =>
    acumular(nome, parser, mapearDespesaCandidato, DESPESA_CANDIDATO, 250));
  await eachCsvFile(candidatos, (nome) => filtro(nome) && nome.includes("despesas_pagas_candidatos"), (nome, parser) =>
    acumular(nome, parser, (linha) => {
      const sqDespesa = limpar(linha.SQ_DESPESA);
      if (!sqDespesa) return null;
      const valorLinha = valor(linha.VR_PAGTO_DESPESA);
      const data = dataIso(linha.DT_PAGTO_DESPESA);
      return {
        id: idHash([sqDespesa, data, valorLinha, limpar(linha.SQ_PARCELAMENTO_DESPESA), limpar(linha.DS_DESPESA)].join("|")),
        sqDespesa,
        valor: valorLinha,
        data,
        fonteRecurso: limpar(linha.DS_FONTE_DESPESA),
        especie: limpar(linha.DS_ESPECIE_RECURSO),
        origem: limpar(linha.DS_ORIGEM_DESPESA),
        descricao: limpar(linha.DS_DESPESA),
        tipoPrestacao: limpar(linha.TP_PRESTACAO_CONTAS),
      };
    }, PAGAMENTO, 400));
  await eachCsvFile(candidatos, (nome) => filtro(nome) && /receitas_candidatos_2026_/.test(nome), (nome, parser) =>
    acumular(nome, parser, mapearReceita, RECEITA, 250));
  await eachCsvFile(candidatos, (nome) => filtro(nome) && nome.includes("doador_originario"), (nome, parser) =>
    acumular(nome, parser, (linha) => {
      const sqReceita = limpar(linha.SQ_RECEITA);
      const agente = agenteDe(linha.NR_CPF_CNPJ_DOADOR_ORIGINARIO, linha.NM_DOADOR_ORIGINARIO, linha.DS_CNAE_DOADOR_ORIGINARIO);
      if (!sqReceita || !agente.agenteTipo || agente.agenteTipo === "NI") return null;
      return { sqReceita, ...agente };
    }, ORIGINARIO, 300));
  await eachCsvFile(orgaos, (nome) => filtro(nome) && nome.includes("despesas_contratadas_orgaos"), (nome, parser) =>
    acumular(nome, parser, mapearDespesaOrgao, DESPESA_ORGAO, 250));
  await importarReceitasPublicasOrgaos(tseDir, uf);

  await eachCsvFile(docDespesa, (nome) => filtro(nome) && nome.includes("despesa_candidato_documento"), (nome, parser) =>
    acumular(nome, parser, (linha) => {
      const sq = limpar(linha.SQ_DESPESA);
      const url = limpar(linha.DS_URL_DOCUMENTO);
      if (!sq || !url) return null;
      return { sq, url };
    }, COMPROVANTE_DESPESA, 300));
  await eachCsvFile(docReceita, (nome) => filtro(nome) && nome.includes("receita_candidato_documento"), (nome, parser) =>
    acumular(nome, parser, (linha) => {
      const sq = limpar(linha.SQ_RECEITA);
      const url = limpar(linha.DS_URL_DOCUMENTO);
      if (!sq || !url) return null;
      return { sq, url };
    }, COMPROVANTE_RECEITA, 300));
}
