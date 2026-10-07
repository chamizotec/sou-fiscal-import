import { gravarLotes } from "../lib/neo4j.js";

export async function acumular(nome, parser, mapear, cypher, tamanho = 400) {
  let lote = [];
  let total = 0;
  for await (const linha of parser) {
    const convertido = mapear(linha);
    const linhas = Array.isArray(convertido) ? convertido : [convertido];
    for (const item of linhas) {
      if (!item) continue;
      lote.push(item);
      if (lote.length >= tamanho) {
        total += await gravarLotes(cypher, lote, tamanho);
        lote = [];
      }
    }
  }
  if (lote.length) total += await gravarLotes(cypher, lote, tamanho);
  console.log(`  ${nome}: ${total}`);
  return total;
}
