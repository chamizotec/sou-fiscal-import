import { argumentos, config } from "./config.js";
import { aplicarSchema, executar, fecharDriver } from "./lib/neo4j.js";
import { COMANDOS_SCHEMA } from "./etapas/schema.js";
import { importarCandidatos } from "./etapas/candidatos.js";
import { importarFinanceiro } from "./etapas/financeiro.js";
import { importarProcessos } from "./etapas/processos.js";
import { importarCnpj } from "./etapas/cnpj.js";
import { importarReceita } from "./etapas/receita.js";

const { uf, only } = argumentos(process.argv.slice(2));
const quer = (nome) => !only || only.includes(nome);

if (only?.length === 1 && only[0] === "receita") {
  console.log(`Importando Receita Federal de ${config.receitaDir}`);
} else {
  console.log(`Importando TSE de ${config.tseDir} (uf=${uf})`);
}

try {
  await aplicarSchema(COMANDOS_SCHEMA);
  if (quer("candidatos")) await importarCandidatos(config.tseDir, uf);
  if (quer("financeiro")) await importarFinanceiro(config.tseDir, uf);
  if (quer("cnpj")) await importarCnpj(config.tseDir);
  if (quer("processos")) await importarProcessos(config.tseDir);
  if (quer("receita")) await importarReceita(config.receitaDir);
  const rodouTse = ["candidatos", "financeiro", "cnpj", "processos"].some(quer);
  if (rodouTse) {
    await executar(`
      MERGE (g:Carga {id: 'tse-2026'})
      SET g.importadoEm = datetime(), g.uf = $uf, g.fonte = 'arquivos-tse'
    `, { uf });
  }
  console.log("Importação concluída.");
} catch (erro) {
  console.error("Falha na importação:", erro.message);
  process.exitCode = 1;
} finally {
  await fecharDriver();
}
