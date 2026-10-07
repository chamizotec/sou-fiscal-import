import path from "node:path";
import { dataIso, limpar } from "../lib/texto.js";
import { eachCsvFile } from "../lib/zipCsv.js";
import { gravarLotes } from "../lib/neo4j.js";

const LIGACAO = `
UNWIND $rows AS row
MATCH (c:Candidatura {sq: row.sq})
MERGE (p:Processo {numero: row.numero})
SET p.classe = coalesce(p.classe, row.classe),
    p.assunto = coalesce(p.assunto, row.assunto),
    p.uf = coalesce(p.uf, row.uf),
    p.url = coalesce(p.url, row.url),
    p.relator = coalesce(p.relator, row.relator),
    p.autuadoEm = coalesce(p.autuadoEm, row.autuadoEm),
    p.fonte = 'tse:processo_eleitoral'
MERGE (c)-[r:FIGURA_EM]->(p)
SET r.polo = row.polo, r.tipoParte = row.tipoParte
`;

export async function importarProcessos(tseDir) {
  const processos = new Map();
  await eachCsvFile(path.join(tseDir, "processo_eleitoral_2026.zip"), () => true, async (_nome, parser) => {
    for await (const linha of parser) {
      const numero = limpar(linha.NR_PROCESSO);
      if (!numero) continue;
      processos.set(numero, {
        numero,
        classe: limpar(linha.DS_CLASSE),
        assunto: limpar(linha.DS_ASSUNTO_PRINCIPAL),
        uf: limpar(linha.SG_UF_TRIBUNAL),
        url: limpar(linha.DS_URL_PROCESSO),
        relator: limpar(linha.NM_RELATOR),
        autuadoEm: dataIso(linha.DT_AUTUACAO),
      });
    }
  });
  console.log(`  processos lidos: ${processos.size}`);

  let lote = [];
  let total = 0;
  await eachCsvFile(path.join(tseDir, "processos_eleitorais_partes_2026.zip"), () => true, async (_nome, parser) => {
    for await (const linha of parser) {
      if (limpar(linha.ST_CANDIDATO) !== "S") continue;
      const sq = limpar(linha.SQ_CANDIDATO);
      const numero = limpar(linha.NR_PROCESSO);
      if (!sq || !numero) continue;
      const base = processos.get(numero) || { numero };
      lote.push({
        ...base,
        sq,
        polo: limpar(linha.DS_POLO),
        tipoParte: limpar(linha.TP_PARTE),
      });
      if (lote.length >= 500) {
        total += await gravarLotes(LIGACAO, lote, 500);
        lote = [];
      }
    }
  });
  if (lote.length) total += await gravarLotes(LIGACAO, lote, 500);
  console.log(`  vínculos de candidato em processo: ${total}`);
}
