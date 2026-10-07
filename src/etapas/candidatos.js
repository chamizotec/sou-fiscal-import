import path from "node:path";
import { busca, dataIso, limpar, valor } from "../lib/texto.js";
import { classificarDocumento, idHash } from "../lib/documento.js";
import { aceitaUf, eachCsvFile } from "../lib/zipCsv.js";
import { executar } from "../lib/neo4j.js";
import { acumular } from "./lotes.js";

const CANDIDATO = `
UNWIND $rows AS row
MERGE (e:Eleicao {id: row.eleicaoId})
  ON CREATE SET e.ano = row.ano, e.turno = row.turno, e.descricao = row.eleicao,
    e.data = row.dataEleicao, e.tipo = row.tipoEleicao, e.abrangencia = row.abrangencia
MERGE (u:Uf {sigla: row.uf})
MERGE (cargo:Cargo {codigo: row.cdCargo})
  ON CREATE SET cargo.nome = row.cargo
MERGE (c:Candidatura {sq: row.sq})
SET c.numero = row.numero, c.nome = row.nome, c.nomeUrna = row.nomeUrna, c.nomeSocial = row.nomeSocial,
    c.nomeBusca = row.nomeBusca, c.nomeUrnaBusca = row.nomeUrnaBusca, c.genero = row.genero,
    c.grauInstrucao = row.grauInstrucao, c.estadoCivil = row.estadoCivil, c.corRaca = row.corRaca,
    c.ocupacao = row.ocupacao, c.ufNascimento = row.ufNascimento, c.dataNascimento = row.dataNascimento,
    c.uf = row.uf, c.ue = row.ue, c.abrangencia = row.abrangencia, c.agremiacao = row.agremiacao,
    c.ano = row.ano, c.turno = row.turno, c.geradoEm = row.geradoEm, c.fonte = 'tse:consulta_cand',
    c.arquivoFoto = row.arquivoFoto, c.arquivoProposta = row.arquivoProposta
MERGE (c)-[:NA_ELEICAO]->(e)
MERGE (c)-[:EM_UF]->(u)
MERGE (c)-[:CONCORRE_A]->(cargo)
FOREACH (_ IN CASE WHEN row.nrPartido IS NULL THEN [] ELSE [1] END |
  MERGE (p:Partido {numero: row.nrPartido})
    ON CREATE SET p.sigla = row.sgPartido, p.nome = row.nmPartido
  SET p.sigla = coalesce(p.sigla, row.sgPartido), p.nome = coalesce(p.nome, row.nmPartido)
  MERGE (c)-[:FILIADO]->(p)
)
FOREACH (_ IN CASE WHEN row.nrFederacao IS NULL THEN [] ELSE [1] END |
  MERGE (f:Federacao {numero: row.nrFederacao})
    ON CREATE SET f.sigla = row.sgFederacao, f.nome = row.nmFederacao, f.composicao = row.composicaoFederacao
  MERGE (c)-[:NA_FEDERACAO]->(f)
)
FOREACH (_ IN CASE WHEN row.sqColigacao IS NULL THEN [] ELSE [1] END |
  MERGE (col:Coligacao {id: row.coligacaoId})
    ON CREATE SET col.nome = row.nmColigacao, col.composicao = row.composicaoColigacao, col.uf = row.uf
  SET col.nome = coalesce(col.nome, row.nmColigacao),
      col.composicao = coalesce(col.composicao, row.composicaoColigacao)
  MERGE (c)-[:NA_COLIGACAO]->(col)
)
FOREACH (_ IN CASE WHEN row.pessoaChave IS NULL THEN [] ELSE [1] END |
  MERGE (pessoa:Pessoa {chave: row.pessoaChave})
    ON CREATE SET pessoa.documentoHash = row.documentoHash, pessoa.documentoTipo = 'CPF',
      pessoa.nome = row.nome, pessoa.fonte = 'tse:consulta_cand'
  SET pessoa.nome = row.nome
  MERGE (c)-[:E_PESSOA]->(pessoa)
)
`;

const COMPLEMENTAR = `
UNWIND $rows AS row
MATCH (c:Candidatura {sq: row.sq})
SET c.situacaoJulgamento = row.situacaoJulgamento, c.situacaoPleito = row.situacaoPleito,
    c.situacaoUrna = row.situacaoUrna, c.inseridoUrna = row.inseridoUrna, c.reeleicao = row.reeleicao,
    c.declararBens = row.declararBens, c.prestacaoContas = row.prestacaoContas, c.despesaMax = row.despesaMax,
    c.nrProcesso = row.nrProcesso, c.substituido = row.substituido, c.sqSubstituido = row.sqSubstituido,
    c.nacionalidade = row.nacionalidade, c.idadePosse = row.idadePosse, c.quilombola = row.quilombola,
    c.etniaIndigena = row.etniaIndigena, c.generoFefc = row.generoFefc, c.corRacaFefc = row.corRacaFefc,
    c.dataAceite = row.dataAceite
`;

const COLIGACAO = `
UNWIND $rows AS row
MERGE (col:Coligacao {id: row.id})
  ON CREATE SET col.nome = row.nome, col.composicao = row.composicao, col.uf = row.uf, col.situacao = row.situacao
SET col.situacao = coalesce(row.situacao, col.situacao), col.composicao = coalesce(row.composicao, col.composicao)
WITH col, row
MERGE (cargo:Cargo {codigo: row.cdCargo})
MERGE (col)-[:PARA_CARGO]->(cargo)
FOREACH (_ IN CASE WHEN row.nrPartido IS NULL THEN [] ELSE [1] END |
  MERGE (p:Partido {numero: row.nrPartido})
    ON CREATE SET p.sigla = row.sgPartido, p.nome = row.nmPartido
  MERGE (p)-[r:INTEGRA]->(col)
  SET r.situacao = row.situacao, r.agremiacao = row.agremiacao
)
`;

const VAGA = `
UNWIND $rows AS row
MERGE (v:Vaga {id: row.id})
SET v.quantidade = row.quantidade, v.uf = row.uf, v.cargo = row.cargo, v.dataPosse = row.dataPosse
WITH v, row
MERGE (u:Uf {sigla: row.uf})
MERGE (cargo:Cargo {codigo: row.cdCargo})
  ON CREATE SET cargo.nome = row.cargo
MERGE (v)-[:NA_UF]->(u)
MERGE (v)-[:PARA_CARGO]->(cargo)
`;

const BEM = `
UNWIND $rows AS row
MATCH (c:Candidatura {sq: row.sq})
MERGE (b:Bem {id: row.id})
SET b.ordem = row.ordem, b.tipo = row.tipo, b.descricao = row.descricao, b.valor = row.valor, b.atualizadoEm = row.atualizadoEm
MERGE (c)-[:DECLAROU]->(b)
`;

const REDE = `
UNWIND $rows AS row
MATCH (c:Candidatura {sq: row.sq})
MERGE (r:RedeSocial {url: row.url})
MERGE (c)-[rel:INFORMA_REDE]->(r)
SET rel.ordem = row.ordem
`;

const HISTORICO = `
UNWIND $rows AS row
MATCH (c:Candidatura {sq: row.sqAtual})
MERGE (h:CandidaturaAnterior {id: row.id})
SET h.ano = row.ano, h.turno = row.turno, h.cargo = row.cargo, h.numero = row.numero, h.nome = row.nome,
    h.partido = row.partido, h.uf = row.uf, h.ue = row.ue, h.situacao = row.situacao,
    h.julgamento = row.julgamento, h.resultado = row.resultado, h.eleicao = row.eleicao
MERGE (c)-[:DISPUTOU]->(h)
`;

const MOTIVO = `
UNWIND $rows AS row
MATCH (c:Candidatura {sq: row.sq})
MERGE (m:Motivo {id: row.id})
SET m.tipo = row.tipo, m.descricao = row.descricao, m.processo = row.processo
MERGE (c)-[:TEM_MOTIVO]->(m)
`;

function eleicaoId(linha) {
  const ano = limpar(linha.ANO_ELEICAO) || limpar(linha.AA_ELEICAO) || "2026";
  const turno = limpar(linha.NR_TURNO) || limpar(linha.ST_TURNO) || "1";
  const codigo = limpar(linha.CD_ELEICAO) || "0";
  return `${ano}-${turno}-${codigo}`;
}

function mapearCandidato(linha) {
  const sq = limpar(linha.SQ_CANDIDATO);
  const uf = limpar(linha.SG_UF);
  if (!sq || !uf) return null;
  const documento = classificarDocumento(linha.NR_CPF_CANDIDATO);
  const nome = limpar(linha.NM_CANDIDATO);
  return {
    sq,
    uf,
    numero: limpar(linha.NR_CANDIDATO),
    nome,
    nomeUrna: limpar(linha.NM_URNA_CANDIDATO),
    nomeSocial: limpar(linha.NM_SOCIAL_CANDIDATO),
    nomeBusca: busca(nome),
    nomeUrnaBusca: busca(linha.NM_URNA_CANDIDATO),
    genero: limpar(linha.DS_GENERO),
    grauInstrucao: limpar(linha.DS_GRAU_INSTRUCAO),
    estadoCivil: limpar(linha.DS_ESTADO_CIVIL),
    corRaca: limpar(linha.DS_COR_RACA),
    ocupacao: limpar(linha.DS_OCUPACAO),
    ufNascimento: limpar(linha.SG_UF_NASCIMENTO),
    dataNascimento: dataIso(linha.DT_NASCIMENTO),
    ue: limpar(linha.NM_UE) || limpar(linha.SG_UE),
    abrangencia: limpar(linha.TP_ABRANGENCIA),
    agremiacao: limpar(linha.TP_AGREMIACAO),
    ano: limpar(linha.ANO_ELEICAO),
    turno: limpar(linha.NR_TURNO),
    geradoEm: dataIso(linha.DT_GERACAO),
    eleicaoId: eleicaoId(linha),
    eleicao: limpar(linha.DS_ELEICAO),
    dataEleicao: dataIso(linha.DT_ELEICAO),
    tipoEleicao: limpar(linha.NM_TIPO_ELEICAO),
    cdCargo: limpar(linha.CD_CARGO),
    cargo: limpar(linha.DS_CARGO),
    nrPartido: limpar(linha.NR_PARTIDO),
    sgPartido: limpar(linha.SG_PARTIDO),
    nmPartido: limpar(linha.NM_PARTIDO),
    nrFederacao: limpar(linha.NR_FEDERACAO),
    sgFederacao: limpar(linha.SG_FEDERACAO),
    nmFederacao: limpar(linha.NM_FEDERACAO),
    composicaoFederacao: limpar(linha.DS_COMPOSICAO_FEDERACAO),
    sqColigacao: limpar(linha.SQ_COLIGACAO),
    coligacaoId: limpar(linha.SQ_COLIGACAO) ? `${uf}:${limpar(linha.SQ_COLIGACAO)}` : null,
    nmColigacao: limpar(linha.NM_COLIGACAO),
    composicaoColigacao: limpar(linha.DS_COMPOSICAO_COLIGACAO),
    pessoaChave: documento?.tipo === "CPF" ? documento.chave : null,
    documentoHash: documento?.tipo === "CPF" ? documento.hash : null,
    arquivoFoto: `foto_cand2026_${uf}_div.zip/F${uf}${sq}_div.jpg`,
    arquivoProposta: `proposta_governo_2026_${uf}/2026${uf}${sq}_01.pdf`,
  };
}

function mapearComplementar(linha) {
  const sq = limpar(linha.SQ_CANDIDATO);
  if (!sq) return null;
  return {
    sq,
    situacaoJulgamento: limpar(linha.DS_SITUACAO_JULGAMENTO),
    situacaoPleito: limpar(linha.DS_SITUACAO_CANDIDATO_PLEITO),
    situacaoUrna: limpar(linha.DS_SITUACAO_CANDIDATO_TOT) || limpar(linha.DS_SITUACAO_CANDIDATO_URNA),
    inseridoUrna: limpar(linha.ST_CANDIDATO_INSERIDO_URNA),
    reeleicao: limpar(linha.ST_REELEICAO),
    declararBens: limpar(linha.ST_DECLARAR_BENS),
    prestacaoContas: limpar(linha.ST_PREST_CONTAS),
    despesaMax: valor(linha.VR_DESPESA_MAX_CAMPANHA),
    nrProcesso: limpar(linha.NR_PROCESSO),
    substituido: limpar(linha.ST_SUBSTITUIDO),
    sqSubstituido: limpar(linha.SQ_SUBSTITUIDO),
    nacionalidade: limpar(linha.DS_NACIONALIDADE),
    idadePosse: limpar(linha.NR_IDADE_DATA_POSSE),
    quilombola: limpar(linha.ST_QUILOMBOLA),
    etniaIndigena: limpar(linha.DS_ETNIA_INDIGENA),
    generoFefc: limpar(linha.DS_GENERO_FEFC),
    corRacaFefc: limpar(linha.DS_COR_RACA_FEFC),
    dataAceite: dataIso(linha.DT_ACEITE_CANDIDATURA),
  };
}

export async function importarCandidatos(tseDir, uf) {
  const filtro = (nome) => aceitaUf(nome, uf);
  const zip = (nome) => path.join(tseDir, nome);

  await eachCsvFile(zip("consulta_cand_2026.zip"), filtro, (nome, parser) =>
    acumular(nome, parser, mapearCandidato, CANDIDATO));
  await eachCsvFile(zip("consulta_cand_complementar_2026.zip"), filtro, (nome, parser) =>
    acumular(nome, parser, mapearComplementar, COMPLEMENTAR));
  await eachCsvFile(zip("consulta_coligacao_2026.zip"), filtro, (nome, parser) =>
    acumular(nome, parser, (linha) => {
      const sq = limpar(linha.SQ_COLIGACAO);
      const sigla = limpar(linha.SG_UF);
      const cdCargo = limpar(linha.CD_CARGO);
      if (!sq || !sigla || !cdCargo) return null;
      return {
        id: `${sigla}:${sq}`,
        nome: limpar(linha.NM_COLIGACAO),
        composicao: limpar(linha.DS_COMPOSICAO_COLIGACAO),
        uf: sigla,
        situacao: limpar(linha.DS_SITUACAO),
        cdCargo,
        nrPartido: limpar(linha.NR_PARTIDO),
        sgPartido: limpar(linha.SG_PARTIDO),
        nmPartido: limpar(linha.NM_PARTIDO),
        agremiacao: limpar(linha.TP_AGREMIACAO),
      };
    }, COLIGACAO));
  await eachCsvFile(zip("consulta_vagas_2026.zip"), filtro, (nome, parser) =>
    acumular(nome, parser, (linha) => {
      const sigla = limpar(linha.SG_UF);
      const cdCargo = limpar(linha.CD_CARGO);
      if (!sigla || !cdCargo) return null;
      return {
        id: `${sigla}:${cdCargo}`,
        uf: sigla,
        cdCargo,
        cargo: limpar(linha.DS_CARGO),
        quantidade: valor(linha.QT_VAGA) || valor(linha.QT_VAGAS),
        dataPosse: dataIso(linha.DT_POSSE),
      };
    }, VAGA));
  await eachCsvFile(zip("bem_candidato_2026.zip"), filtro, (nome, parser) =>
    acumular(nome, parser, (linha) => {
      const sq = limpar(linha.SQ_CANDIDATO);
      if (!sq) return null;
      const ordem = limpar(linha.NR_ORDEM_BEM_CANDIDATO) || "0";
      const descricao = limpar(linha.DS_BEM_CANDIDATO);
      const tipo = limpar(linha.DS_TIPO_BEM_CANDIDATO);
      return {
        sq,
        id: idHash(`${sq}|${ordem}|${tipo || ""}|${descricao || ""}|${limpar(linha.VR_BEM_CANDIDATO) || ""}`),
        ordem,
        tipo,
        descricao,
        valor: valor(linha.VR_BEM_CANDIDATO),
        atualizadoEm: dataIso(linha.DT_ULT_ATUAL_BEM_CANDIDATO),
      };
    }, BEM));
  await eachCsvFile(zip("rede_social_candidato_2026.zip"), filtro, (nome, parser) =>
    acumular(nome, parser, (linha) => {
      const sq = limpar(linha.SQ_CANDIDATO);
      const url = limpar(linha.DS_URL);
      if (!sq || !url) return null;
      return { sq, url, ordem: limpar(linha.NR_ORDEM_REDE_SOCIAL) };
    }, REDE));
  await eachCsvFile(zip("historico_candidatura_2026.zip"), filtro, (nome, parser) =>
    acumular(nome, parser, (linha) => {
      const sqAtual = limpar(linha.SQ_CANDIDATO_ATUAL);
      const sqAntigo = limpar(linha.SQ_CANDIDATO);
      const ano = limpar(linha.ANO_ELEICAO);
      if (!sqAtual || !ano) return null;
      return {
        sqAtual,
        id: idHash(`${sqAtual}|${ano}|${sqAntigo || ""}|${limpar(linha.CD_CARGO) || ""}|${limpar(linha.NR_TURNO) || ""}`),
        ano,
        turno: limpar(linha.NR_TURNO),
        cargo: limpar(linha.DS_CARGO),
        numero: limpar(linha.NR_CANDIDATO),
        nome: limpar(linha.NM_URNA_CANDIDATO) || limpar(linha.NM_CANDIDATO),
        partido: limpar(linha.SG_PARTIDO),
        uf: limpar(linha.SG_UF),
        ue: limpar(linha.NM_UE),
        situacao: limpar(linha.DS_SITUACAO_CANDIDATURA),
        julgamento: limpar(linha.DS_SITUACAO_JULGAMENTO),
        resultado: limpar(linha.DS_SIT_TOT_TURNO),
        eleicao: limpar(linha.DS_ELEICAO),
      };
    }, HISTORICO));
  await eachCsvFile(zip("motivo_cassacao_2026.zip"), filtro, (nome, parser) =>
    acumular(nome, parser, (linha) => {
      const sq = limpar(linha.SQ_CANDIDATO);
      const descricao = limpar(linha.DS_MOTIVO);
      if (!sq || !descricao) return null;
      const processo = limpar(linha.NR_PROCESSO);
      return {
        sq,
        id: idHash(`${sq}|${processo || ""}|${descricao}`),
        tipo: limpar(linha.DS_TP_MOTIVO),
        descricao,
        processo,
      };
    }, MOTIVO));

  await executar(`
    MATCH (c:Candidatura)
    WHERE c.sqSubstituido IS NOT NULL
    MATCH (outro:Candidatura {sq: c.sqSubstituido})
    MERGE (c)-[:SUBSTITUIDO_POR]->(outro)
  `);
}
