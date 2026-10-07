import path from "node:path";
import { limpar } from "../lib/texto.js";
import { classificarDocumento } from "../lib/documento.js";
import { eachZipLines } from "../lib/zipCsv.js";
import { gravarLotes } from "../lib/neo4j.js";

const GRAVAR = `
UNWIND $rows AS row
MERGE (o:Organizacao {cnpj: row.cnpj})
  ON CREATE SET o.nome = row.nome, o.fonte = 'tse:cnpj_campanha'
SET o.nomeReceita = row.nome,
    o.naturezaJuridica = row.natureza,
    o.cnaePrincipal = row.cnae,
    o.tipoPrestador = row.tipoPrestador
MERGE (conta:ContaCampanha {cnpj: row.cnpj})
SET conta.tipoPrestador = row.tipoPrestador
MERGE (conta)-[:PERTENCE_A]->(o)
`;

function detalhe(linha) {
  if (!linha || linha[0] !== "2" || linha.length < 178) return null;
  const documento = classificarDocumento(linha.slice(3, 17));
  if (!documento || documento.tipo !== "CNPJ") return null;
  const tipo = linha.slice(1, 3);
  return {
    cnpj: documento.digitos,
    nome: limpar(linha.slice(17, 167)),
    natureza: limpar(linha.slice(167, 171)),
    cnae: limpar(linha.slice(171, 178)),
    tipoPrestador: tipo === "01" ? "partido" : tipo === "02" ? "candidato" : tipo,
  };
}

export async function importarCnpj(tseDir) {
  const zip = path.join(tseDir, "CNPJ_campanha_2026.zip");
  for (const arquivo of ["cnpj_candidatos_2026.txt", "cnpj_partido_2026.txt"]) {
    let lote = [];
    let total = 0;
    await eachZipLines(zip, arquivo, async (_nome, linhas) => {
      for await (const linha of linhas) {
        const item = detalhe(linha);
        if (!item) continue;
        lote.push(item);
        if (lote.length >= 500) {
          total += await gravarLotes(GRAVAR, lote, 500);
          lote = [];
        }
      }
    });
    if (lote.length) total += await gravarLotes(GRAVAR, lote, 500);
    console.log(`  ${arquivo}: ${total}`);
  }
}
