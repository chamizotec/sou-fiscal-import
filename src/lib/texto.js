const VAZIOS = new Set([
  "",
  "#NULO",
  "#NULO#",
  "#NE",
  "-1",
  "-3",
  "-4",
  "NÃO DIVULGÁVEL",
  "NAO DIVULGAVEL",
]);

export function limpar(valor) {
  if (valor == null) return null;
  const texto = String(valor).trim();
  if (!texto || VAZIOS.has(texto.toUpperCase())) return null;
  return texto;
}

export function busca(valor) {
  const texto = limpar(valor);
  if (!texto) return null;
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

export function valor(valorBruto) {
  const texto = limpar(valorBruto);
  if (!texto) return null;
  const normalizado = texto.includes(",")
    ? texto.replace(/\./g, "").replace(",", ".")
    : texto;
  const numero = Number(normalizado);
  return Number.isFinite(numero) ? numero : null;
}

export function dataIso(valorBruto) {
  const texto = limpar(valorBruto);
  if (!texto) return null;
  const partes = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!partes) return null;
  return `${partes[3]}-${partes[2]}-${partes[1]}`;
}

export function grupoDespesa(origem) {
  const texto = busca(origem) || "";
  if (texto.includes("IMPRESS")) return "impressos";
  if (texto.includes("IMPULSION")) return "impulsionamento";
  if (texto.includes("MILITANCIA") || texto.includes("MOBILIZACAO")) return "militancia";
  if (texto.includes("PESSOAL")) return "pessoal";
  if (texto.includes("VEICULO")) return "veiculos";
  if (texto.includes("COMBUSTIV")) return "combustivel";
  if (texto.includes("PUBLICIDADE")) return "publicidade";
  return "outros";
}

export function idEstavel(partes) {
  return partes.map((parte) => (parte == null ? "" : String(parte))).join("|");
}
